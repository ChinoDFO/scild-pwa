import { Router } from "express";
import express from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { guardarComprobante } from "../comprobantes.js";
import {
  ESTADOS_ABIERTOS,
  MAX_COMPROBANTE,
  MENSAJES_CLIENTE,
  TIPOS_DE_COMPROBANTE,
  datosDePago,
  mensajeDeBienvenida,
  mensajeDelCatalogo,
  respuestaAutomatica,
} from "../pagos.js";

const router = Router();

// El chat con los administradores para ampliar el límite de accesos.
//
// El cliente solo manda mensajes de un catálogo cerrado y UNA captura por
// solicitud. Todo lo que mueve dinero o permisos (aprobar el pago, sumar los
// accesos) vive en /api/admin: aquí no hay nada que un cliente pueda tocar
// para darse permisos a sí mismo.

const SELECCION = {
  id: true,
  deviceId: true,
  status: true,
  proofAt: true,
  note: true,
  createdAt: true,
  reviewedAt: true,
  device: { select: { name: true, deviceCode: true } },
  messages: {
    orderBy: { createdAt: "asc" },
    select: { id: true, from: true, kind: true, body: true, createdAt: true },
  },
};

function formato(solicitud) {
  return {
    ...solicitud,
    boton: solicitud.device.name || solicitud.device.deviceCode,
    // Qué le toca hacer al cliente ahora mismo, para que la pantalla no
    // tenga que deducirlo del estado y de si ya mandó captura.
    esperaComprobante: solicitud.status === "ABIERTA" && solicitud.proofAt === null,
    device: undefined,
  };
}

// Lo que pinta la pantalla de pago: los datos bancarios, qué puede responder
// el cliente y sus solicitudes.
router.get("/", userAuth, async (req, res) => {
  const solicitudes = await prisma.paymentRequest.findMany({
    where: { userId: req.user.id },
    select: SELECCION,
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  res.json({
    datos: datosDePago(),
    respuestas: MENSAJES_CLIENTE,
    solicitudes: solicitudes.map(formato),
  });
});

// Abre una solicitud para uno de los botones de los que eres titular.
router.post("/", userAuth, async (req, res) => {
  const { deviceId } = req.body ?? {};
  if (typeof deviceId !== "string") {
    return res.status(400).json({ error: "Falta el botón que quieres ampliar" });
  }

  const esTitular = await prisma.deviceHolder.findUnique({
    where: { deviceId_userId: { deviceId, userId: req.user.id } },
  });
  if (!esTitular) {
    return res.status(403).json({ error: "Solo los titulares del botón pueden ampliar su límite" });
  }

  // Una a la vez por botón: si no, el mismo depósito podría reclamarse dos
  // veces y el administrador no sabría cuál aprobar.
  const abierta = await prisma.paymentRequest.findFirst({
    where: { deviceId, status: { in: ESTADOS_ABIERTOS } },
    select: SELECCION,
  });
  if (abierta) {
    return res.status(200).json(formato(abierta));
  }

  const solicitud = await prisma.paymentRequest.create({
    data: {
      userId: req.user.id,
      deviceId,
      messages: {
        create: { from: "SOPORTE", kind: "BIENVENIDA", body: mensajeDeBienvenida() },
      },
    },
    select: SELECCION,
  });

  res.status(201).json(formato(solicitud));
});

// Busca una solicitud del usuario, o responde 404 sin revelar si existe.
async function miSolicitud(req, res) {
  const solicitud = await prisma.paymentRequest.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    // proofType y no proofImage: basta para saber si ya mandó captura, sin
    // cargarse la imagen entera a memoria.
    select: { ...SELECCION, proofType: true },
  });
  if (!solicitud) {
    res.status(404).json({ error: "Solicitud no encontrada" });
    return null;
  }
  return solicitud;
}

router.get("/:id", userAuth, async (req, res) => {
  const solicitud = await miSolicitud(req, res);
  if (!solicitud) return;
  res.json(formato(solicitud));
});

// Un mensaje del catálogo, con su respuesta automática cuando la tiene.
router.post("/:id/mensajes", userAuth, async (req, res) => {
  const solicitud = await miSolicitud(req, res);
  if (!solicitud) return;

  if (!ESTADOS_ABIERTOS.includes(solicitud.status)) {
    return res.status(409).json({ error: "Esta solicitud ya se cerró" });
  }

  const plantilla = mensajeDelCatalogo(req.body?.kind);
  if (!plantilla) {
    return res.status(400).json({ error: "Ese mensaje no está en el catálogo" });
  }

  const respuesta = respuestaAutomatica(plantilla.id);

  await prisma.$transaction(async (tx) => {
    await tx.paymentMessage.create({
      data: {
        requestId: solicitud.id,
        from: "CLIENTE",
        kind: plantilla.id,
        body: plantilla.texto,
        userId: req.user.id,
      },
    });

    if (respuesta) {
      await tx.paymentMessage.create({
        data: { requestId: solicitud.id, from: "SOPORTE", kind: "AUTOMATICO", body: respuesta },
      });
    }

    // Cancelar cierra el trámite: el cliente se arrepintió antes de pagar.
    if (plantilla.id === "CANCELAR") {
      await tx.paymentRequest.update({
        where: { id: solicitud.id },
        data: { status: "CANCELADA", note: "Cancelada por el cliente" },
      });
    }
  });

  const actualizada = await prisma.paymentRequest.findUnique({
    where: { id: solicitud.id },
    select: SELECCION,
  });
  res.status(201).json(formato(actualizada));
});

// La captura del pago. Llega como imagen cruda (no JSON ni multipart): son
// unos cientos de kilobytes y así no hace falta otra dependencia ni inflar
// el límite del body de toda la API.
router.post(
  "/:id/comprobante",
  userAuth,
  express.raw({ type: Object.keys(TIPOS_DE_COMPROBANTE), limit: MAX_COMPROBANTE }),
  async (req, res) => {
    const solicitud = await miSolicitud(req, res);
    if (!solicitud) return;

    if (!ESTADOS_ABIERTOS.includes(solicitud.status)) {
      return res.status(409).json({ error: "Esta solicitud ya se cerró" });
    }

    // Una por solicitud. Si la rechazan, el cliente abre otra y manda una
    // nueva: así un error de foto no deja a alguien que ya pagó sin poder
    // comprobarlo.
    if (solicitud.proofType) {
      return res.status(409).json({
        error: "Ya mandaste una captura para esta solicitud. Espera a que la revisemos.",
      });
    }

    const contentType = req.get("content-type")?.split(";")[0]?.trim();
    if (!TIPOS_DE_COMPROBANTE[contentType]) {
      return res.status(415).json({ error: "Manda la captura como imagen JPG, PNG o WebP" });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "La captura llegó vacía" });
    }

    // Guarda la imagen y deja la solicitud EN_REVISION.
    await guardarComprobante({
      requestId: solicitud.id,
      contenido: req.body,
      contentType,
    });

    await prisma.paymentMessage.create({
      data: {
        requestId: solicitud.id,
        from: "SOPORTE",
        kind: "AUTOMATICO",
        body: "Recibimos tu captura. En cuanto confirmemos el depósito se activan tus accesos.",
      },
    });

    const actualizada = await prisma.paymentRequest.findUnique({
      where: { id: solicitud.id },
      select: SELECCION,
    });
    res.status(201).json(formato(actualizada));
  }
);

export default router;
