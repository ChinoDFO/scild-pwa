import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { ACCESOS_POR_COMPRA } from "../acceso.js";
import { leerComprobante } from "../comprobantes.js";

const router = Router();

// Panel de los administradores de la PLATAFORMA (nosotros), no de un grupo.
// Es lo único que puede subir Device.extraAccesses: el cliente nunca se da
// accesos a sí mismo, los pide y aquí se confirman contra el depósito.
//
// isPlatformAdmin se prende a mano en la base de datos. No hay endpoint para
// otorgarlo a propósito: si lo hubiera, sería el camino más corto para que
// una cuenta comprometida se regale todo.
router.use(userAuth, (req, res, next) => {
  if (!req.user.isPlatformAdmin) {
    return res.status(403).json({ error: "No tienes acceso al panel de administración" });
  }
  next();
});

const nombreDe = (u) => u?.displayName || u?.email || "—";

// --- Solicitudes de pago ----------------------------------------------------

const SELECCION_SOLICITUD = {
  id: true,
  status: true,
  // proofType y no proofImage: dice si ya hay captura sin traerse los bytes.
  // La imagen se pide aparte, en /solicitudes/:id/comprobante.
  proofType: true,
  proofAt: true,
  note: true,
  createdAt: true,
  reviewedAt: true,
  user: { select: { id: true, displayName: true, email: true, createdAt: true } },
  reviewedBy: { select: { displayName: true, email: true } },
  device: {
    select: {
      id: true,
      name: true,
      deviceCode: true,
      extraAccesses: true,
      group: { select: { name: true } },
      _count: { select: { grants: true } },
    },
  },
  messages: {
    orderBy: { createdAt: "asc" },
    select: { id: true, from: true, kind: true, body: true, createdAt: true },
  },
};

function formatoSolicitud(s) {
  return {
    id: s.id,
    status: s.status,
    createdAt: s.createdAt,
    proofAt: s.proofAt,
    reviewedAt: s.reviewedAt,
    revisadaPor: s.reviewedBy ? nombreDe(s.reviewedBy) : null,
    note: s.note,
    cliente: {
      userId: s.user.id,
      nombre: nombreDe(s.user),
      email: s.user.email,
      cuentaDesde: s.user.createdAt,
    },
    boton: {
      deviceId: s.device.id,
      nombre: s.device.name || s.device.deviceCode,
      deviceCode: s.device.deviceCode,
      grupo: s.device.group?.name ?? null,
      accesosComprados: s.device.extraAccesses,
      accesosRepartidos: s.device._count.grants,
    },
    // La imagen no viaja en el JSON: el panel la pide aparte, con su sesión.
    hayComprobante: Boolean(s.proofType),
    messages: s.messages,
  };
}

// Lista con filtros. Por defecto, lo que está esperando revisión.
router.get("/solicitudes", async (req, res) => {
  const { estado, q } = req.query;

  const solicitudes = await prisma.paymentRequest.findMany({
    where: {
      ...(estado && estado !== "TODAS" ? { status: estado } : {}),
      ...(q
        ? {
            OR: [
              { user: { email: { contains: q, mode: "insensitive" } } },
              { user: { displayName: { contains: q, mode: "insensitive" } } },
              { device: { deviceCode: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    select: SELECCION_SOLICITUD,
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  res.json(solicitudes.map(formatoSolicitud));
});

router.get("/solicitudes/:id", async (req, res) => {
  const solicitud = await prisma.paymentRequest.findUnique({
    where: { id: req.params.id },
    select: SELECCION_SOLICITUD,
  });
  if (!solicitud) {
    return res.status(404).json({ error: "Solicitud no encontrada" });
  }
  res.json(formatoSolicitud(solicitud));
});

// La captura del pago. Va por su propia ruta, y no dentro del JSON de la
// lista, por dos razones: son cientos de kilobytes que no tienen por qué
// viajar en cada consulta, y así la imagen solo sale con una sesión de
// administrador — un comprobante trae nombre, banco y monto de una persona,
// no puede quedar en una URL que cualquiera abra.
router.get("/solicitudes/:id/comprobante", async (req, res) => {
  const comprobante = await leerComprobante(req.params.id);
  if (!comprobante) {
    return res.status(404).json({ error: "Esa solicitud no tiene comprobante" });
  }

  res.set("Content-Type", comprobante.contentType);
  // Que no se quede en caché de nadie más que de quien la está viendo.
  res.set("Cache-Control", "private, no-store");
  res.send(comprobante.contenido);
});

// Confirma el depósito: le suma al botón sus accesos y cierra el trámite.
router.post("/solicitudes/:id/aprobar", async (req, res) => {
  const solicitud = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
  if (!solicitud) {
    return res.status(404).json({ error: "Solicitud no encontrada" });
  }
  if (solicitud.status === "APROBADA") {
    return res.status(409).json({ error: "Esa solicitud ya estaba aprobada" });
  }

  // updateMany con el estado esperado: si dos administradores aprueban la
  // misma solicitud al mismo tiempo, los accesos se suman una sola vez.
  const resultado = await prisma.$transaction(async (tx) => {
    const { count } = await tx.paymentRequest.updateMany({
      where: { id: solicitud.id, status: { not: "APROBADA" } },
      data: {
        status: "APROBADA",
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        note: null,
      },
    });
    if (count === 0) return null;

    const device = await tx.device.update({
      where: { id: solicitud.deviceId },
      data: { extraAccesses: { increment: ACCESOS_POR_COMPRA } },
      select: { extraAccesses: true },
    });

    await tx.paymentMessage.create({
      data: {
        requestId: solicitud.id,
        from: "SOPORTE",
        kind: "AUTOMATICO",
        body: `Listo: confirmamos tu pago. Ya puedes dar acceso completo a ${ACCESOS_POR_COMPRA} personas más desde la información de tu grupo.`,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: req.user.id,
        action: "PAYMENT_APPROVED",
        entity: "PaymentRequest",
        entityId: solicitud.id,
        metadata: { deviceId: solicitud.deviceId, accesos: ACCESOS_POR_COMPRA },
      },
    });

    return device.extraAccesses;
  });

  if (resultado === null) {
    return res.status(409).json({ error: "Otra persona acaba de aprobar esa solicitud" });
  }

  res.json({ ok: true, accesosComprados: resultado });
});

// Rechaza con un motivo. El cliente puede abrir otra solicitud y mandar una
// captura nueva: por eso la captura es una por solicitud y no una por cuenta.
router.post("/solicitudes/:id/rechazar", async (req, res) => {
  const { note } = req.body ?? {};
  if (typeof note !== "string" || note.trim().length === 0) {
    return res.status(400).json({ error: "Escribe el motivo del rechazo" });
  }

  const solicitud = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
  if (!solicitud) {
    return res.status(404).json({ error: "Solicitud no encontrada" });
  }
  if (solicitud.status === "APROBADA") {
    return res.status(409).json({ error: "Esa solicitud ya se aprobó" });
  }

  await prisma.$transaction([
    prisma.paymentRequest.update({
      where: { id: solicitud.id },
      data: {
        status: "RECHAZADA",
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        note: note.trim(),
      },
    }),
    prisma.paymentMessage.create({
      data: {
        requestId: solicitud.id,
        from: "SOPORTE",
        kind: "AUTOMATICO",
        body: `No pudimos confirmar el pago: ${note.trim()} Puedes abrir otra solicitud y mandarnos una captura nueva.`,
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: "PAYMENT_REJECTED",
        entity: "PaymentRequest",
        entityId: solicitud.id,
        metadata: { note: note.trim() },
      },
    }),
  ]);

  res.json({ ok: true });
});

// Soporte sí escribe texto libre: del otro lado estamos nosotros.
router.post("/solicitudes/:id/mensajes", async (req, res) => {
  const { body } = req.body ?? {};
  if (typeof body !== "string" || body.trim().length === 0) {
    return res.status(400).json({ error: "El mensaje está vacío" });
  }
  if (body.trim().length > 1000) {
    return res.status(400).json({ error: "El mensaje pasa de 1000 caracteres" });
  }

  const existe = await prisma.paymentRequest.count({ where: { id: req.params.id } });
  if (existe === 0) {
    return res.status(404).json({ error: "Solicitud no encontrada" });
  }

  const mensaje = await prisma.paymentMessage.create({
    data: {
      requestId: req.params.id,
      from: "SOPORTE",
      kind: "TEXTO",
      body: body.trim(),
      userId: req.user.id,
    },
    select: { id: true, from: true, kind: true, body: true, createdAt: true },
  });

  res.status(201).json(mensaje);
});

// --- Clientes ---------------------------------------------------------------

// La lista de clientes: un renglón por botón vendido, con quien lo registró
// primero (el cliente de verdad), si ya tiene el límite ampliado y cuántos
// de esos accesos ya repartió.
router.get("/clientes", async (req, res) => {
  const { ampliados, q } = req.query;

  const devices = await prisma.device.findMany({
    where: {
      // Solo botones que alguien ya registró: los que siguen en el almacén
      // no son clientes todavía.
      holders: { some: {} },
      ...(ampliados === "si" ? { extraAccesses: { gt: 0 } } : {}),
      ...(ampliados === "no" ? { extraAccesses: 0 } : {}),
      ...(q
        ? {
            OR: [
              { deviceCode: { contains: q, mode: "insensitive" } },
              { name: { contains: q, mode: "insensitive" } },
              { holders: { some: { user: { email: { contains: q, mode: "insensitive" } } } } },
              { holders: { some: { user: { displayName: { contains: q, mode: "insensitive" } } } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      deviceCode: true,
      extraAccesses: true,
      createdAt: true,
      group: { select: { name: true } },
      _count: { select: { grants: true, seats: true } },
      holders: {
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          user: { select: { id: true, displayName: true, email: true, createdAt: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json(
    devices.map((d) => {
      const [primero, ...resto] = d.holders;
      return {
        deviceId: d.id,
        nombre: d.name || d.deviceCode,
        deviceCode: d.deviceCode,
        grupo: d.group?.name ?? null,
        // El titular que lo registró primero: el cliente.
        cliente: {
          userId: primero.user.id,
          nombre: nombreDe(primero.user),
          email: primero.user.email,
          registradoEl: primero.createdAt,
        },
        // El segundo, si ya usaron las dos validaciones del código.
        acompanante: resto[0] ? nombreDe(resto[0].user) : null,
        ampliado: d.extraAccesses > 0,
        accesosComprados: d.extraAccesses,
        accesosRepartidos: d._count.grants,
        lugaresOcupados: d._count.seats,
      };
    })
  );
});

// Ampliar el límite a mano, sin pasar por una solicitud: para pagos que
// llegaron por otro lado o para arreglar un caso raro. Queda en AuditLog.
router.post("/clientes/:deviceId/accesos", async (req, res) => {
  const { accesos = ACCESOS_POR_COMPRA } = req.body ?? {};
  if (!Number.isInteger(accesos) || accesos === 0 || Math.abs(accesos) > 50) {
    return res.status(400).json({ error: "Cantidad de accesos inválida" });
  }

  const device = await prisma.device.findUnique({
    where: { id: req.params.deviceId },
    select: { extraAccesses: true, _count: { select: { grants: true } } },
  });
  if (!device) {
    return res.status(404).json({ error: "Ese botón no existe" });
  }

  const nuevo = device.extraAccesses + accesos;
  if (nuevo < 0) {
    return res.status(400).json({ error: "No puede quedar en negativo" });
  }
  // Bajar el límite por debajo de lo ya repartido dejaría a gente con acceso
  // que la cuenta ya no respalda: primero hay que quitar esos accesos.
  if (nuevo < device._count.grants) {
    return res.status(409).json({
      error: `Ese botón ya repartió ${device._count.grants} accesos. Quítalos antes de bajar el límite.`,
    });
  }

  await prisma.$transaction([
    prisma.device.update({ where: { id: req.params.deviceId }, data: { extraAccesses: nuevo } }),
    prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: "ACCESS_LIMIT_CHANGED",
        entity: "Device",
        entityId: req.params.deviceId,
        metadata: { accesos, total: nuevo },
      },
    }),
  ]);

  res.json({ ok: true, accesosComprados: nuevo });
});

export default router;
