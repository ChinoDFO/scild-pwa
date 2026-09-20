import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { buscarMembresia } from "../membership.js";
import { accesoDeCuenta } from "../acceso.js";
import { crearNotificacionesPendientes, enviarPushDeAlerta } from "../push.js";
import { emitirAGrupo } from "../realtime.js";
import { TIPOS_ALERTA, esTipoValido, tipoDeAlerta } from "../tiposAlerta.js";

const router = Router();

const SELECCION_ALERTA = {
  id: true,
  groupId: true,
  source: true,
  type: true,
  status: true,
  createdAt: true,
  acknowledgedAt: true,
  resolvedAt: true,
  group: { select: { name: true } },
  device: { select: { name: true, deviceCode: true } },
  createdBy: { select: { email: true, displayName: true } },
};

// Cada alerta sale con su etiqueta y emoji ya resueltos, para que la PWA no
// tenga que conocer el catálogo para dibujarla.
function formatoAlerta(alerta) {
  const tipo = tipoDeAlerta(alerta.type);
  return { ...alerta, tipo: { id: tipo.id, etiqueta: tipo.etiqueta, emoji: tipo.emoji } };
}

// Catálogo para armar el menú de "¿Qué está pasando?" en la PWA.
router.get("/tipos", userAuth, (_req, res) => {
  res.json(TIPOS_ALERTA);
});

// Alertas recientes de los grupos del usuario (o de uno solo con ?groupId=).
// Es la fuente de verdad dentro de la app: a quien no tiene push activado la
// alerta le tiene que aparecer aquí igual.
router.get("/", userAuth, async (req, res) => {
  const { groupId, soloAbiertas } = req.query;

  if (groupId !== undefined && !(await buscarMembresia(req.user.id, groupId))) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  const alertas = await prisma.alert.findMany({
    where: {
      group: { members: { some: { userId: req.user.id } } },
      ...(groupId !== undefined ? { groupId } : {}),
      ...(soloAbiertas === "true" ? { status: { not: "RESOLVED" } } : {}),
    },
    select: SELECCION_ALERTA,
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  res.json(alertas.map(formatoAlerta));
});

// Alerta manual desde la PWA (propuesta: "generar una alerta manualmente").
// type: uno del catálogo (GENERAL si no viene).
router.post("/", userAuth, async (req, res) => {
  const { groupId, type = "GENERAL" } = req.body ?? {};

  if (!esTipoValido(type)) {
    return res.status(400).json({ error: "Tipo de alerta desconocido" });
  }

  if (!(await buscarMembresia(req.user.id, groupId))) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  // La comprobación de verdad va aquí, no en la PWA: esconder el botón SOS
  // evita el error de dedo, pero cualquiera puede llamar a la API a mano.
  // El permiso es de la cuenta: se tiene en todos los grupos o en ninguno.
  const acceso = await accesoDeCuenta(req.user.id);
  if (!acceso.completo) {
    return res.status(403).json({
      error:
        "Tu cuenta no puede enviar alertas. Vincula el código de tu botón desde Códigos, o pídele a un titular que te dé uno de sus accesos.",
    });
  }

  const alerta = await prisma.$transaction(async (tx) => {
    const creada = await tx.alert.create({
      data: { groupId, source: "APP", type, status: "ACTIVE", createdById: req.user.id },
      select: SELECCION_ALERTA,
    });

    // Quien la disparó ya sabe que hay una emergencia: no se le avisa a él.
    await crearNotificacionesPendientes(tx, {
      alertId: creada.id,
      groupId,
      excluirUserId: req.user.id,
    });

    await tx.auditLog.create({
      data: {
        userId: req.user.id,
        action: "ALERT_CREATED",
        entity: "Alert",
        entityId: creada.id,
        metadata: { type },
      },
    });

    return creada;
  });

  res.status(201).json(formatoAlerta(alerta));
  emitirAGrupo(groupId, "alertas:cambio", { groupId, alertId: alerta.id });

  // Igual que en /panic: el push va después de responder y no puede tumbar
  // la petición. Si falla, las Notification quedan en PENDING.
  enviarPushDeAlerta(alerta.id)
    .then((r) =>
      console.log(`Alerta manual ${alerta.id}: push a ${r.tokens} tokens, ${r.enviadas} entregadas`)
    )
    .catch((e) => console.error(`No se pudo enviar el push de la alerta ${alerta.id}:`, e));
});

// ACTIVE → ACKNOWLEDGED ("ya voy / ya lo vi") → RESOLVED. Cualquier miembro
// del grupo puede hacerlo; queda en AuditLog quién fue.
const TRANSICIONES = {
  atender: { desde: ["ACTIVE"], a: "ACKNOWLEDGED", campo: "acknowledgedAt", accion: "ALERT_ACKNOWLEDGED" },
  resolver: { desde: ["ACTIVE", "ACKNOWLEDGED"], a: "RESOLVED", campo: "resolvedAt", accion: "ALERT_RESOLVED" },
};

router.post("/:id/:accion", userAuth, async (req, res) => {
  const transicion = TRANSICIONES[req.params.accion];
  if (!transicion) {
    return res.status(404).json({ error: "Acción no válida" });
  }

  const alerta = await prisma.alert.findUnique({ where: { id: req.params.id } });
  if (!alerta || !(await buscarMembresia(req.user.id, alerta.groupId))) {
    return res.status(404).json({ error: "Alerta no encontrada" });
  }

  if (!transicion.desde.includes(alerta.status)) {
    return res.status(409).json({ error: "La alerta ya cambió de estado", status: alerta.status });
  }

  const actualizada = await prisma.$transaction(async (tx) => {
    // updateMany con el estado esperado en el where: si dos personas tocan
    // "resolver" al mismo tiempo, solo una transición gana.
    const { count } = await tx.alert.updateMany({
      where: { id: alerta.id, status: { in: transicion.desde } },
      data: { status: transicion.a, [transicion.campo]: new Date() },
    });
    if (count === 0) return null;

    // El heartbeat conserva EMERGENCY a propósito, así que la única forma de
    // que el botón vuelva a la normalidad es resolver su última alerta abierta.
    if (transicion.a === "RESOLVED" && alerta.deviceId) {
      const otrasAbiertas = await tx.alert.count({
        where: { deviceId: alerta.deviceId, status: { not: "RESOLVED" } },
      });
      if (otrasAbiertas === 0) {
        await tx.device.updateMany({
          where: { id: alerta.deviceId, status: "EMERGENCY" },
          data: { status: "ONLINE" },
        });
      }
    }

    await tx.auditLog.create({
      data: { userId: req.user.id, action: transicion.accion, entity: "Alert", entityId: alerta.id },
    });

    return tx.alert.findUnique({ where: { id: alerta.id }, select: SELECCION_ALERTA });
  });

  if (!actualizada) {
    return res.status(409).json({ error: "La alerta ya cambió de estado" });
  }

  res.json(formatoAlerta(actualizada));
  emitirAGrupo(alerta.groupId, "alertas:cambio", { groupId: alerta.groupId, alertId: alerta.id });
});

export default router;
