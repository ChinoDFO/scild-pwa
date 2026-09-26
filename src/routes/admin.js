import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { GRUPOS_POR_BOTON, TITULARES_POR_BOTON } from "../acceso.js";
import { formatearClaimCode } from "../claimCode.js";
import { crearDispositivo, siguienteDeviceCode, validarDeviceCode } from "../fabrica.js";

const router = Router();

// Panel de los administradores de la PLATAFORMA (nosotros), no de un grupo.
//
// isPlatformAdmin se prende a mano en la base de datos. No hay endpoint para
// otorgarlo a propósito: si lo hubiera, sería el camino más corto para que
// una cuenta comprometida se regale todo.
//
// Trae la lista de botones en uso y el alta de botones (lo que se hace al
// fabricarlos). Antes tenía las solicitudes de pago, pero se quitó el sistema
// de pagos: ya no hay accesos que comprar ni comprobantes que revisar. Lo que
// falta aquí (está en el roadmap) es el estado de los botones, las alertas
// recientes con cuánto tardaron en atenderse, y las entregas de push
// fallidas.
router.use(userAuth, (req, res, next) => {
  if (!req.user.isPlatformAdmin) {
    return res.status(403).json({ error: "No tienes acceso al panel de administración" });
  }
  next();
});

const nombreDe = (u) => u?.displayName || u?.email || "—";

// Un renglón por botón que ya tiene dueño, con DOS listas que son cosas
// distintas y no se deben mezclar:
//   - personas: quiénes comparten el botón (los titulares, hasta tres). Es
//     quien capturó el código de su caja.
//   - grupos: a quiénes les avisa cuando se presiona (hasta tres). Es a donde
//     llega la alerta.
// Una persona puede compartir un botón sin estar en ninguno de sus grupos, y un
// grupo puede recibir un botón cuyos titulares ni conoce.
//
// Antes esto se llamaba "clientes" y titulaba cada renglón con la primera
// persona: con varios botones por persona (o una persona en varios botones)
// parecía que el botón era de ella y que "compartía" con los demás.
router.get("/botones", async (req, res) => {
  const { q } = req.query;

  const contiene = { contains: q, mode: "insensitive" };
  const devices = await prisma.device.findMany({
    where: {
      // Solo botones que alguien ya registró: los que siguen en el almacén
      // no tienen dueño todavía (esos van en el inventario).
      holders: { some: {} },
      ...(q
        ? {
            OR: [
              { deviceCode: contiene },
              { name: contiene },
              { holders: { some: { user: { email: contiene } } } },
              { holders: { some: { user: { displayName: contiene } } } },
              { groups: { some: { group: { name: contiene } } } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      deviceCode: true,
      createdAt: true,
      groups: { orderBy: { createdAt: "asc" }, select: { group: { select: { name: true } } } },
      holders: {
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          user: { select: { id: true, displayName: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json(
    devices.map((d) => ({
      deviceId: d.id,
      deviceCode: d.deviceCode,
      // El nombre que le puso su dueño, si lo hay; el código ya va aparte.
      nombre: d.name,
      personas: d.holders.map((h) => ({
        userId: h.user.id,
        nombre: nombreDe(h.user),
        email: h.user.email,
        desde: h.createdAt,
      })),
      personasTotales: TITULARES_POR_BOTON,
      grupos: d.groups.map((v) => v.group.name),
      gruposTotales: GRUPOS_POR_BOTON,
    }))
  );
});

// --- Fábrica: dar de alta botones ------------------------------------------

// Los botones que todavía no tienen dueño: el inventario. Es lo que hay
// armado y sin vender, con el código que lleva impreso cada caja por si hay
// que reimprimir una etiqueta.
//
// El deviceSecret NO sale aquí ni en ninguna consulta: en la base solo está
// su hash. Se ve una sola vez, al momento de dar de alta el botón.
router.get("/dispositivos", async (req, res) => {
  const devices = await prisma.device.findMany({
    where: { holders: { none: {} } },
    select: {
      id: true,
      deviceCode: true,
      name: true,
      claimCode: true,
      createdAt: true,
      lastSeenAt: true,
      firmwareVersion: true,
      groups: { orderBy: { createdAt: "asc" }, select: { group: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.json({
    // Para no tener que ir a buscar en qué número se quedó la producción.
    siguienteCodigo: await siguienteDeviceCode(),
    dispositivos: devices.map((d) => ({
      id: d.id,
      deviceCode: d.deviceCode,
      nombre: d.name,
      codigoDeLaCaja: formatearClaimCode(d.claimCode),
      creadoEl: d.createdAt,
      // Si ya se conectó alguna vez, el aparato está armado y funcionando;
      // si no, es un registro en la base y nada más.
      probado: Boolean(d.lastSeenAt),
      firmware: d.firmwareVersion,
      grupos: d.groups.map((v) => v.group.name),
    })),
  });
});

// Da de alta un botón nuevo y devuelve sus tres códigos.
//
// El deviceSecret viaja al navegador UNA vez, en esta respuesta, y no se
// puede volver a consultar: quien lo da de alta tiene que copiarlo al ESP32
// en ese momento. Es a propósito —guardarlo para poder enseñarlo después
// significaría guardarlo en claro— y por eso la pantalla insiste tanto.
router.post("/dispositivos", async (req, res) => {
  const { deviceCode, nombre } = req.body ?? {};

  const error = validarDeviceCode(deviceCode);
  if (error) {
    return res.status(400).json({ error });
  }
  if (nombre !== undefined && nombre !== null && typeof nombre !== "string") {
    return res.status(400).json({ error: "El nombre del botón no es válido" });
  }
  if (typeof nombre === "string" && nombre.trim().length > 40) {
    return res.status(400).json({ error: "El nombre del botón puede tener máximo 40 caracteres" });
  }

  const { device, secret, claimCode } = await crearDispositivo({ deviceCode, nombre });

  await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      action: "DEVICE_CREATED",
      entity: "Device",
      entityId: device.id,
      metadata: { deviceCode: device.deviceCode },
    },
  });

  res.status(201).json({
    id: device.id,
    deviceCode: device.deviceCode,
    // Va en el ESP32. No se vuelve a mostrar.
    deviceSecret: secret,
    // Se imprime en la caja.
    codigoDeLaCaja: formatearClaimCode(claimCode),
  });
});

export default router;
