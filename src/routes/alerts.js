import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { buscarMembresia } from "../membership.js";
import { accesoDeCuenta } from "../acceso.js";
import { crearNotificacionesPendientes, enviarPushDeAlerta } from "../push.js";
import { emitirAGrupo } from "../realtime.js";
import { catalogoDelGrupo, esTipoValidoParaGrupo, tipoDeAlertaParaGrupo } from "../tiposAlertaGrupo.js";
import { TIPOS_ALERTA } from "../tiposAlerta.js";
import { protocoloDeAlerta } from "../protocolosAlerta.js";
import { enlaceDeMapa } from "../mapas.js";

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
  // address/latitude/longitude son para armar `ubicacion` de abajo; no se
  // vuelven a mandar sueltos, se arma `group` de nuevo solo con name.
  group: { select: { name: true, address: true, latitude: true, longitude: true } },
  device: { select: { name: true, deviceCode: true } },
  createdBy: { select: { email: true, displayName: true } },
};

// Cada alerta sale con su etiqueta, emoji, teléfono y protocolo ya resueltos
// (catálogo fijo o personalizado del grupo), y con el link de "Ver
// ubicación" ya armado, para que la PWA no tenga que conocer ningún
// catálogo ni repetir la lógica de coordenadas-o-dirección para dibujarla.
async function formatoAlerta(alerta) {
  const tipo = await tipoDeAlertaParaGrupo(alerta.groupId, alerta.type);
  return {
    ...alerta,
    group: { name: alerta.group.name },
    tipo: {
      id: tipo.id,
      etiqueta: tipo.etiqueta,
      emoji: tipo.emoji,
      telefono: tipo.telefono,
      protocolo: tipo.protocolo,
    },
    ubicacion: enlaceDeMapa(alerta.group),
  };
}

// Catálogo para armar el menú de "¿Qué está pasando?" en la PWA: el fijo más
// los personalizados del grupo, con los favoritos del grupo primero.
router.get("/tipos", userAuth, async (req, res) => {
  const { groupId } = req.query;
  if (groupId !== undefined && !(await buscarMembresia(req.user.id, groupId))) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  // Sin groupId (versión vieja de la PWA en lo que se actualiza en todos
  // lados) se queda con el catálogo fijo, igual que antes.
  res.json(
    groupId !== undefined
      ? await catalogoDelGrupo(groupId)
      : TIPOS_ALERTA.map((t) => ({ ...t, personalizado: false, protocolo: protocoloDeAlerta(t.id) }))
  );
});

// Cuántas trae como máximo esta ruta. ?take= puede pedir MENOS (el perfil
// pide 10, para no enseñar un historial larguísimo), nunca más.
const TOPE_ALERTAS = 30;

// Alertas recientes de los grupos del usuario (o de uno solo con ?groupId=).
// Es la fuente de verdad dentro de la app: a quien no tiene push activado la
// alerta le tiene que aparecer aquí igual.
router.get("/", userAuth, async (req, res) => {
  const { groupId, soloAbiertas, take } = req.query;

  if (groupId !== undefined && !(await buscarMembresia(req.user.id, groupId))) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  const pedido = Number(take);
  const limite = Number.isInteger(pedido) && pedido > 0 ? Math.min(pedido, TOPE_ALERTAS) : TOPE_ALERTAS;

  const alertas = await prisma.alert.findMany({
    where: {
      group: { members: { some: { userId: req.user.id } } },
      ...(groupId !== undefined ? { groupId } : {}),
      ...(soloAbiertas === "true" ? { status: { not: "RESOLVED" } } : {}),
    },
    select: SELECCION_ALERTA,
    orderBy: { createdAt: "desc" },
    take: limite,
  });

  res.json(await Promise.all(alertas.map(formatoAlerta)));
});

// Alerta manual desde la PWA (propuesta: "generar una alerta manualmente").
// type: uno del catálogo (GENERAL si no viene).
router.post("/", userAuth, async (req, res) => {
  const { groupId, type = "GENERAL" } = req.body ?? {};

  if (!(await buscarMembresia(req.user.id, groupId))) {
    return res.status(404).json({ error: "Grupo no encontrado" });
  }

  if (!(await esTipoValidoParaGrupo(groupId, type))) {
    return res.status(400).json({ error: "Tipo de alerta desconocido" });
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

  res.status(201).json(await formatoAlerta(alerta));
  emitirAGrupo(groupId, "alertas:cambio", {
    groupId,
    alertId: alerta.id,
    accion: "creada",
    createdAt: alerta.createdAt,
    createdById: alerta.createdById,
  });

  // Igual que en /panic: el push va después de responder y no puede tumbar
  // la petición. Si falla, las Notification quedan en PENDING.
  enviarPushDeAlerta(alerta.id)
    .then((r) =>
      console.log(`Alerta manual ${alerta.id}: push a ${r.tokens} tokens, ${r.enviadas} entregadas`)
    )
    .catch((e) => console.error(`No se pudo enviar el push de la alerta ${alerta.id}:`, e));
});

// El SOS "sostenido de más" (ver BotonPanico.tsx, segunda fase del gesto):
// para cuando no hay tiempo de elegir UN grupo y hay que avisarles a todos
// los de la cuenta a la vez. Siempre GENERAL, igual que el botón físico y el
// SOS normal — esto no es para elegir tipo, es para no tener que elegir nada.
//
// Mismo patrón que /panic en devices.js: una Alert por grupo, y quien está
// en varios recibe un solo push (por el más antiguo), aunque la alerta
// aparezca en el chat de todos.
router.post("/difundir", userAuth, async (req, res) => {
  const acceso = await accesoDeCuenta(req.user.id);
  if (!acceso.completo) {
    return res.status(403).json({
      error:
        "Tu cuenta no puede enviar alertas. Vincula el código de tu botón desde Códigos, o pídele a un titular que te dé uno de sus accesos.",
    });
  }

  const membresias = await prisma.groupMember.findMany({
    where: { userId: req.user.id },
    select: { groupId: true },
    orderBy: { joinedAt: "asc" },
  });
  if (membresias.length === 0) {
    return res.status(409).json({ error: "Todavía no estás en ningún grupo" });
  }

  const alertas = await prisma.$transaction(async (tx) => {
    const creadas = [];
    // Quien dispara ya sabe que hay una emergencia (no se le avisa a él), y
    // quien está en varios de estos grupos recibe un solo aviso, por el más
    // antiguo; en el chat de los demás la alerta aparece igual.
    const yaAvisados = new Set([req.user.id]);

    for (const { groupId } of membresias) {
      const creada = await tx.alert.create({
        data: { groupId, source: "APP", type: "GENERAL", status: "ACTIVE", createdById: req.user.id },
        select: SELECCION_ALERTA,
      });

      await crearNotificacionesPendientes(tx, {
        alertId: creada.id,
        groupId,
        excluirUserIds: [...yaAvisados],
      });

      const miembros = await tx.groupMember.findMany({ where: { groupId }, select: { userId: true } });
      for (const m of miembros) yaAvisados.add(m.userId);

      await tx.auditLog.create({
        data: {
          userId: req.user.id,
          action: "ALERT_BROADCAST",
          entity: "Alert",
          entityId: creada.id,
          metadata: { groupId },
        },
      });

      creadas.push(creada);
    }

    return creadas;
  });

  res.status(201).json({
    alertas: await Promise.all(alertas.map(formatoAlerta)),
    gruposAvisados: alertas.length,
  });

  for (const alerta of alertas) {
    emitirAGrupo(alerta.groupId, "alertas:cambio", {
      groupId: alerta.groupId,
      alertId: alerta.id,
      accion: "creada",
      createdAt: alerta.createdAt,
      createdById: alerta.createdById,
    });

    enviarPushDeAlerta(alerta.id)
      .then((r) =>
        console.log(`Difusión ${alerta.id}: push a ${r.tokens} tokens, ${r.enviadas} entregadas`)
      )
      .catch((e) => console.error(`No se pudo enviar el push de la difusión ${alerta.id}:`, e));
  }
});

// ACTIVE → ACKNOWLEDGED ("ya voy / ya lo vi") → RESOLVED. Cualquier miembro
// del grupo puede hacerlo; queda en AuditLog quién fue.
const TRANSICIONES = {
  atender: {
    desde: ["ACTIVE"],
    a: "ACKNOWLEDGED",
    campo: "acknowledgedAt",
    accion: "ALERT_ACKNOWLEDGED",
    accionSocket: "atendida",
  },
  resolver: {
    desde: ["ACTIVE", "ACKNOWLEDGED"],
    a: "RESOLVED",
    campo: "resolvedAt",
    accion: "ALERT_RESOLVED",
    accionSocket: "resuelta",
  },
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

  res.json(await formatoAlerta(actualizada));
  emitirAGrupo(alerta.groupId, "alertas:cambio", {
    groupId: alerta.groupId,
    alertId: alerta.id,
    accion: transicion.accionSocket,
    createdAt: actualizada.createdAt,
    createdById: actualizada.createdById,
  });
});

export default router;
