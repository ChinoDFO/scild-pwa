import { Router } from "express";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { buscarMembresia, estadoEfectivo } from "../membership.js";
import { accesoDeCuenta, cuentasCompletas, volverseTitular, ErrorDeAcceso } from "../acceso.js";
import { apartarLugar, cuposDelGrupo, respaldarMiembrosSueltos } from "../cupos.js";
import { emitirAGrupo } from "../realtime.js";
import { enviarPushDeMensaje } from "../push.js";

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
        // Sin botón todavía: su lugar queda sin respaldo hasta que vincule
        // uno (ver respaldarMiembrosSueltos en src/cupos.js).
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
    // Cada botón del grupo da cupo para diez personas. Si no hay lugar, la
    // forma de crecer es que entre alguien más con su propio botón.
    const membership = await prisma.$transaction(async (tx) => {
      const seatDeviceId = await apartarLugar(tx, group.id);
      if (!seatDeviceId) {
        throw new ErrorDeAcceso(
          409,
          "Este grupo ya no tiene lugares libres. Para meter a más personas, alguien más con botón tiene que unirse al grupo."
        );
      }
      return tx.groupMember.create({
        data: { userId: req.user.id, groupId: group.id, role: "MEMBER", seatDeviceId },
      });
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
      devices: {
        orderBy: { createdAt: "asc" },
        include: { owner: { select: { id: true, displayName: true, email: true } } },
      },
    },
  });

  const ahora = Date.now();

  // Quién de los que están en el grupo tiene las funciones completas, y el
  // estado del cupo. Las dos cosas se resuelven en bloque, no por miembro.
  const [completas, cupos, titularidades] = await Promise.all([
    cuentasCompletas(group.members.map((m) => m.userId)),
    cuposDelGrupo(group.id),
    prisma.deviceHolder.findMany({
      where: { deviceId: { in: group.devices.map((d) => d.id) } },
      select: { deviceId: true, userId: true, user: { select: { displayName: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const titularesDe = new Map();
  for (const t of titularidades) {
    const lista = titularesDe.get(t.deviceId) ?? [];
    lista.push({ userId: t.userId, nombre: t.user.displayName || t.user.email });
    titularesDe.set(t.deviceId, lista);
  }

  res.json({
    id: group.id,
    name: group.name,
    address: group.address,
    latitude: group.latitude,
    longitude: group.longitude,
    role: membresia.role,
    // Para que la PWA distinga sus propios mensajes en el chat.
    myUserId: req.user.id,
    // Si esta persona puede disparar alertas. Es propiedad de su cuenta, no
    // de este grupo: la PWA esconde el botón SOS y el menú de tipos si no.
    puedoAlertar: completas.has(req.user.id),
    // Cupo del establecimiento: diez lugares por cada botón vinculado.
    cupos,
    inviteCode: membresia.role === "ADMIN" ? group.inviteCode : null,
    members: group.members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      displayName: m.user.displayName,
      role: m.role,
      // Titular de un botón o con un acceso regalado; si no, es invitado.
      accesoCompleto: completas.has(m.userId),
      // De qué botón sale su lugar en el grupo.
      seatDeviceId: m.seatDeviceId,
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
      // Quién lo vinculó: en un coto, de qué casa es el botón.
      owner: d.owner ? { userId: d.owner.id, nombre: d.owner.displayName || d.owner.email } : null,
      // Las dos personas que comparten el botón (el código vale dos veces).
      titulares: titularesDe.get(d.id) ?? [],
      // Su dueño y el administrador del grupo pueden desvincularlo.
      puedoDesvincular: membresia.role === "ADMIN" || d.ownerId === req.user.id,
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

  // Quien escribe obviamente ya leyó lo suyo.
  marcarLeido(req.user.id, req.params.id).catch((e) =>
    console.error("No se pudo marcar como leído:", e)
  );

  // Igual que el push de alertas: después de responder y sin tumbar nada.
  enviarPushDeMensaje(mensaje)
    .then((r) => console.log(`Mensaje ${mensaje.id}: push a ${r.tokens} tokens, ${r.enviados} entregados`))
    .catch((e) => console.error(`No se pudo enviar el push del mensaje ${mensaje.id}:`, e));
});

function marcarLeido(userId, groupId) {
  return prisma.groupMember.updateMany({
    where: { userId, groupId },
    data: { lastReadAt: new Date() },
  });
}

// La PWA lo llama al abrir el chat y al recibir mensajes con él abierto: es
// lo que hace que el contador de no leídos vuelva a cero y que el próximo
// aviso push traiga el mensaje y no "N mensajes nuevos".
router.post("/:id/read", userAuth, async (req, res) => {
  const { count } = await marcarLeido(req.user.id, req.params.id);
  if (count === 0) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }
  res.json({ ok: true });
});

// --- Salir del grupo, eliminarlo y nombrar administrador --------------------

// Cualquiera puede salirse. Dos casos que hay que cuidar:
//   - si es el último ADMIN y quedan más personas, el grupo se quedaría sin
//     nadie que lo administre: primero tiene que nombrar a otro;
//   - si es el último miembro, el grupo quedaría huérfano (nadie podría
//     volver a entrar ni atender sus alertas), así que se borra con él. Si
//     tiene botones vinculados no se borra solo: eso se hace a propósito
//     desde "Eliminar grupo".
router.delete("/:id/members/me", userAuth, async (req, res) => {
  const membresia = await buscarMembresia(req.user.id, req.params.id);
  if (!membresia) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  const [totalMiembros, totalAdmins, totalBotones] = await Promise.all([
    prisma.groupMember.count({ where: { groupId: req.params.id } }),
    prisma.groupMember.count({ where: { groupId: req.params.id, role: "ADMIN" } }),
    prisma.device.count({ where: { groupId: req.params.id } }),
  ]);

  if (membresia.role === "ADMIN" && totalAdmins === 1 && totalMiembros > 1) {
    return res.status(409).json({
      error: "Eres el único administrador. Nombra a otro miembro administrador antes de salir.",
    });
  }

  if (totalMiembros === 1 && totalBotones > 0) {
    return res.status(409).json({
      error: "Eres el único miembro y el grupo tiene botones vinculados. Elimina el grupo desde la información del grupo.",
    });
  }

  const grupoBorrado = totalMiembros === 1;

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: { userId: req.user.id, action: "GROUP_LEFT", entity: "Group", entityId: req.params.id },
    });
    if (grupoBorrado) {
      await tx.group.delete({ where: { id: req.params.id } });
    } else {
      await tx.groupMember.delete({ where: { id: membresia.id } });
    }
  });

  if (grupoBorrado) {
    emitirAGrupo(req.params.id, "grupo:eliminado", { groupId: req.params.id });
  } else {
    emitirAGrupo(req.params.id, "grupo:actualizado", { groupId: req.params.id });
  }

  res.json({ ok: true, grupoBorrado });
});

// Solo el ADMIN, y se pide el nombre del grupo escrito igual: borra el chat,
// las alertas y saca a todos, y no se puede deshacer.
router.delete("/:id", userAuth, async (req, res) => {
  if (!(await exigirAdmin(req, res))) return;

  const grupo = await prisma.group.findUnique({
    where: { id: req.params.id },
    select: { name: true, _count: { select: { devices: true } } },
  });

  if (req.body?.confirmarNombre?.trim() !== grupo.name) {
    return res.status(400).json({ error: `Para confirmar, escribe el nombre del grupo: ${grupo.name}` });
  }

  // Los botones físicos quedarían sin grupo al que avisar, y su secreto no se
  // puede recuperar: primero hay que desvincularlos (pendiente en el
  // roadmap), así que por ahora se bloquea.
  if (grupo._count.devices > 0) {
    return res.status(409).json({
      error: "El grupo tiene botones vinculados. Desvincúlalos primero desde la información del grupo.",
    });
  }

  emitirAGrupo(req.params.id, "grupo:eliminado", { groupId: req.params.id });

  await prisma.$transaction([
    prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: "GROUP_DELETED",
        entity: "Group",
        entityId: req.params.id,
        metadata: { name: grupo.name },
      },
    }),
    prisma.group.delete({ where: { id: req.params.id } }),
  ]);

  res.json({ ok: true });
});

// El ADMIN nombra administrador a otro miembro (o le quita el cargo). Es lo
// que permite que un administrador pueda salirse del grupo.
//
// El cargo de ADMIN no tiene nada que ver con poder alertar: eso es de la
// cuenta (ver src/acceso.js) y lo reparte el titular del botón desde el
// apartado de Códigos, no el administrador del grupo.
router.patch("/:id/members/:userId", userAuth, async (req, res) => {
  if (!(await exigirAdmin(req, res))) return;

  const { role } = req.body ?? {};
  if (role !== "ADMIN" && role !== "MEMBER") {
    return res.status(400).json({ error: "Rol inválido" });
  }

  const membresia = await buscarMembresia(req.params.userId, req.params.id);
  if (!membresia) {
    return res.status(404).json({ error: "Esa persona no es del grupo" });
  }

  // Nadie puede dejar al grupo sin administrador.
  if (role === "MEMBER" && membresia.role === "ADMIN") {
    const admins = await prisma.groupMember.count({ where: { groupId: req.params.id, role: "ADMIN" } });
    if (admins === 1) {
      return res.status(409).json({ error: "El grupo necesita al menos un administrador" });
    }
  }

  await prisma.$transaction([
    prisma.groupMember.update({ where: { id: membresia.id }, data: { role } }),
    prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: "MEMBER_ROLE_CHANGED",
        entity: "GroupMember",
        entityId: membresia.id,
        metadata: { role, userId: req.params.userId },
      },
    }),
  ]);

  emitirAGrupo(req.params.id, "grupo:actualizado", { groupId: req.params.id });
  res.json({ ok: true, role });
});

// --- Botones del grupo ------------------------------------------------------

// Vincula un botón a este grupo: es lo que hace que el botón le avise a esta
// gente y lo que le suma al grupo sus diez lugares.
//
// Acepta dos caminos, porque son dos momentos distintos:
//   - claimCode: el código impreso en la caja. Además de vincular el botón al
//     grupo, deja a quien lo captura como titular (el código vale para dos
//     personas). Es el camino desde la info del grupo, para quien compró el
//     botón y lo está estrenando.
//   - deviceId: un botón del que ya eres titular, p. ej. porque capturaste el
//     código al crear tu cuenta. Solo lo trae a este grupo.
router.post("/:id/devices/claim", userAuth, async (req, res) => {
  const membresia = await buscarMembresia(req.user.id, req.params.id);
  if (!membresia) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  const { name, claimCode, deviceId } = req.body ?? {};
  if (name !== undefined && (!esTexto(name) || name.trim().length > 60)) {
    return res.status(400).json({ error: "El nombre del botón puede tener máximo 60 caracteres" });
  }

  let device;
  if (esTexto(claimCode)) {
    // Lanza ErrorDeAcceso si el código no sirve o ya se usó dos veces.
    ({ device } = await volverseTitular({ userId: req.user.id, claimCode }));
  } else if (esTexto(deviceId)) {
    device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      return res.status(404).json({ error: "Ese botón no existe" });
    }
  } else {
    return res.status(400).json({ error: "Falta el código de la caja del botón" });
  }

  // Vincular un botón a un grupo es decidir a quién le avisa: solo quien lo
  // compró. Con claimCode esto siempre pasa (acaba de volverse titular); con
  // deviceId es lo que impide traerse el botón de alguien más.
  const esTitular = await prisma.deviceHolder.findUnique({
    where: { deviceId_userId: { deviceId: device.id, userId: req.user.id } },
  });
  if (!esTitular) {
    return res.status(403).json({ error: "Solo los titulares de ese botón pueden vincularlo a un grupo" });
  }

  if (device.groupId === req.params.id) {
    return res.status(409).json({ error: "Ese botón ya está en este grupo" });
  }
  if (device.groupId) {
    return res.status(409).json({
      error: "Ese botón está vinculado a otro grupo. Desvincúlalo de allá para traerlo aquí.",
    });
  }

  const nombre = esTexto(name) ? name.trim() : device.name;

  await prisma.$transaction(async (tx) => {
    await tx.device.update({
      where: { id: device.id },
      data: { groupId: req.params.id, name: nombre, status: "OFFLINE" },
    });

    // Sus diez lugares recogen a quien estaba sin respaldo: quien creó el
    // grupo antes de tener botón, y los que quedaron sueltos si otro botón
    // se desvinculó.
    await respaldarMiembrosSueltos(tx, req.params.id, device.id);

    await tx.auditLog.create({
      data: {
        userId: req.user.id,
        action: "DEVICE_CLAIMED",
        entity: "Device",
        entityId: device.id,
        metadata: { groupId: req.params.id, deviceCode: device.deviceCode },
      },
    });
  });

  emitirAGrupo(req.params.id, "grupo:actualizado", { groupId: req.params.id });
  res.status(201).json({ id: device.id, deviceCode: device.deviceCode, name: nombre });
});

// Desvincular: lo puede hacer su dueño o el ADMIN del grupo. El botón vuelve
// a quedar libre para vincularse con el mismo código de su caja, y deja de
// pertenecer al grupo (por eso hay que hacerlo antes de eliminarlo).
router.delete("/:id/devices/:deviceId", userAuth, async (req, res) => {
  const membresia = await buscarMembresia(req.user.id, req.params.id);
  if (!membresia) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  const device = await prisma.device.findFirst({
    where: { id: req.params.deviceId, groupId: req.params.id },
  });
  if (!device) {
    return res.status(404).json({ error: "Ese botón no es de este grupo" });
  }

  if (membresia.role !== "ADMIN" && device.ownerId !== req.user.id) {
    return res.status(403).json({ error: "Solo su dueño o el administrador del grupo pueden desvincularlo" });
  }

  await prisma.$transaction([
    // Sale del grupo, pero NO deja de ser suyo: sus titulares siguen siendo
    // titulares (el acceso completo es de la cuenta) y el botón se puede
    // volver a vincular a otro grupo. Lo que sí se pierde son sus diez
    // lugares: quien los ocupaba se queda en el grupo, pero sin respaldo.
    prisma.device.update({
      where: { id: device.id },
      data: { groupId: null, status: "OFFLINE" },
    }),
    prisma.groupMember.updateMany({
      where: { groupId: req.params.id, seatDeviceId: device.id },
      data: { seatDeviceId: null },
    }),
    prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: "DEVICE_UNLINKED",
        entity: "Device",
        entityId: device.id,
        metadata: { groupId: req.params.id, deviceCode: device.deviceCode },
      },
    }),
  ]);

  emitirAGrupo(req.params.id, "grupo:actualizado", { groupId: req.params.id });
  res.json({ ok: true });
});

export default router;
