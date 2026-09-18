import { Router } from "express";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { buscarMembresia, estadoEfectivo } from "../membership.js";
import { emitirAGrupo } from "../realtime.js";

const router = Router();

function generateInviteCode() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

const esTexto = (v) => typeof v === "string" && v.trim().length > 0;

// Valida los datos de un grupo. En "parcial" (edición) solo se revisa lo que
// venga; al crear, nombre y dirección son obligatorios. La dirección es
// obligatoria porque es lo que alguien necesita para llegar en una
// emergencia. latitude/longitude aceptan null para borrarlas.
function validarGrupo(body, { parcial }) {
  const { name, address, latitude, longitude } = body ?? {};
  const data = {};

  if (name !== undefined || !parcial) {
    if (!esTexto(name) || name.trim().length > 80) {
      return { error: "El grupo necesita un nombre (máximo 80 caracteres)" };
    }
    data.name = name.trim();
  }

  if (address !== undefined || !parcial) {
    if (!esTexto(address) || address.trim().length > 200) {
      return { error: "La dirección del establecimiento es obligatoria (máximo 200 caracteres)" };
    }
    data.address = address.trim();
  }

  for (const [campo, valor, limite] of [
    ["latitude", latitude, 90],
    ["longitude", longitude, 180],
  ]) {
    if (valor === undefined) continue;
    if (valor !== null && (typeof valor !== "number" || Math.abs(valor) > limite)) {
      return { error: `Coordenada inválida: ${campo}` };
    }
    data[campo] = valor;
  }

  return { data };
}

// Solo el ADMIN del grupo pasa. Responde 404 si ni siquiera es miembro (no se
// revela que el grupo existe) y 403 si es miembro pero no ADMIN.
async function exigirAdmin(req, res) {
  const membresia = await buscarMembresia(req.user.id, req.params.id);
  if (!membresia) {
    res.status(404).json({ error: "Grupo no encontrado" });
    return null;
  }
  if (membresia.role !== "ADMIN") {
    res.status(403).json({ error: "Solo el administrador del grupo puede hacer esto" });
    return null;
  }
  return membresia;
}

// Crea un grupo/establecimiento y hace ADMIN a quien lo crea.
router.post("/", userAuth, async (req, res) => {
  const { data, error } = validarGrupo(req.body, { parcial: false });
  if (error) {
    return res.status(400).json({ error });
  }

  const group = await prisma.group.create({
    data: {
      ...data,
      inviteCode: generateInviteCode(),
      members: {
        create: { userId: req.user.id, role: "ADMIN" },
      },
    },
  });

  res.status(201).json(group);
});

// Un usuario se une a un grupo existente con el código de invitación
// (propuesta, sección 5: controla quién pertenece a cada grupo).
router.post("/join", userAuth, async (req, res) => {
  const { inviteCode } = req.body ?? {};

  if (typeof inviteCode !== "string" || inviteCode.trim().length === 0) {
    return res.status(400).json({ error: "Falta el código de invitación" });
  }

  const group = await prisma.group.findUnique({
    where: { inviteCode: inviteCode.trim().toUpperCase() },
  });

  if (!group) {
    return res.status(404).json({ error: "Código de invitación inválido" });
  }

  try {
    const membership = await prisma.groupMember.create({
      data: { userId: req.user.id, groupId: group.id, role: "MEMBER" },
    });
    emitirAGrupo(group.id, "grupo:actualizado", { groupId: group.id });
    res.status(201).json({ groupId: group.id, groupName: group.name, role: membership.role });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "Ya perteneces a este grupo" });
    }
    throw e;
  }
});

// Detalle de un grupo para la PWA: miembros y botones con su estado real. El
// código de invitación solo lo ve el ADMIN, que es quien decide a quién meter.
router.get("/:id", userAuth, async (req, res) => {
  const membresia = await buscarMembresia(req.user.id, req.params.id);
  if (!membresia) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  const group = await prisma.group.findUnique({
    where: { id: req.params.id },
    include: {
      members: {
        include: { user: { select: { email: true, displayName: true } } },
        orderBy: { joinedAt: "asc" },
      },
      devices: { orderBy: { createdAt: "asc" } },
    },
  });

  const ahora = Date.now();

  res.json({
    id: group.id,
    name: group.name,
    address: group.address,
    latitude: group.latitude,
    longitude: group.longitude,
    role: membresia.role,
    // Para que la PWA distinga sus propios mensajes en el chat.
    myUserId: req.user.id,
    inviteCode: membresia.role === "ADMIN" ? group.inviteCode : null,
    members: group.members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      displayName: m.user.displayName,
      role: m.role,
    })),
    // Nunca se manda secretHash al cliente.
    devices: group.devices.map((d) => ({
      id: d.id,
      deviceCode: d.deviceCode,
      name: d.name,
      status: estadoEfectivo(d, ahora),
      batteryLevel: d.batteryLevel,
      firmwareVersion: d.firmwareVersion,
      lastSeenAt: d.lastSeenAt,
    })),
  });
});

// El ADMIN edita nombre, dirección y coordenadas del establecimiento.
router.patch("/:id", userAuth, async (req, res) => {
  if (!(await exigirAdmin(req, res))) return;

  const { data, error } = validarGrupo(req.body, { parcial: true });
  if (error) {
    return res.status(400).json({ error });
  }

  const group = await prisma.$transaction(async (tx) => {
    const actualizado = await tx.group.update({ where: { id: req.params.id }, data });
    await tx.auditLog.create({
      data: {
        userId: req.user.id,
        action: "GROUP_UPDATED",
        entity: "Group",
        entityId: req.params.id,
        metadata: data,
      },
    });
    return actualizado;
  });

  emitirAGrupo(group.id, "grupo:actualizado", { groupId: group.id });
  res.json(group);
});

// El ADMIN genera un código de invitación nuevo; el anterior deja de servir.
// Para cuando el código se compartió de más.
router.post("/:id/invite-code", userAuth, async (req, res) => {
  if (!(await exigirAdmin(req, res))) return;

  const group = await prisma.group.update({
    where: { id: req.params.id },
    data: { inviteCode: generateInviteCode() },
  });

  await prisma.auditLog.create({
    data: { userId: req.user.id, action: "INVITE_CODE_ROTATED", entity: "Group", entityId: group.id },
  });

  res.json({ inviteCode: group.inviteCode });
});

// --- Chat del grupo ---------------------------------------------------------

const MAX_MENSAJE = 1000;
const POR_PAGINA = 50;

function formatoMensaje(m) {
  return {
    id: m.id,
    groupId: m.groupId,
    content: m.content,
    createdAt: m.createdAt,
    autor: {
      id: m.user.id,
      nombre: m.user.displayName || m.user.email,
    },
  };
}

const SELECCION_AUTOR = { user: { select: { id: true, displayName: true, email: true } } };

// Historial, del más viejo al más nuevo. ?antesDe=<fecha ISO> trae la página
// anterior (para "cargar mensajes anteriores").
router.get("/:id/messages", userAuth, async (req, res) => {
  if (!(await buscarMembresia(req.user.id, req.params.id))) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  const antesDe = req.query.antesDe ? new Date(req.query.antesDe) : null;
  if (antesDe && Number.isNaN(antesDe.getTime())) {
    return res.status(400).json({ error: "Fecha inválida en antesDe" });
  }

  const mensajes = await prisma.message.findMany({
    where: { groupId: req.params.id, ...(antesDe ? { createdAt: { lt: antesDe } } : {}) },
    include: SELECCION_AUTOR,
    orderBy: { createdAt: "desc" },
    take: POR_PAGINA,
  });

  res.json({
    mensajes: mensajes.reverse().map(formatoMensaje),
    hayMas: mensajes.length === POR_PAGINA,
  });
});

// Se guarda y se reparte por Socket.IO a todos los del grupo (incluido quien
// lo mandó, que lo reconoce por id y no lo duplica). A propósito NO manda
// push: si el chat hiciera sonar el celular, la gente silenciaría la app y se
// perdería las alertas de verdad.
router.post("/:id/messages", userAuth, async (req, res) => {
  if (!(await buscarMembresia(req.user.id, req.params.id))) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  const { content } = req.body ?? {};
  if (!esTexto(content)) {
    return res.status(400).json({ error: "El mensaje está vacío" });
  }
  if (content.trim().length > MAX_MENSAJE) {
    return res.status(400).json({ error: `El mensaje pasa de ${MAX_MENSAJE} caracteres` });
  }

  const mensaje = formatoMensaje(
    await prisma.message.create({
      data: { groupId: req.params.id, userId: req.user.id, content: content.trim() },
      include: SELECCION_AUTOR,
    })
  );

  emitirAGrupo(req.params.id, "mensaje:nuevo", mensaje);
  res.status(201).json(mensaje);
});

export default router;
