import { Router } from "express";
import prisma from "../prisma.js";
import { deviceAuth } from "../middleware/deviceAuth.js";
import { crearNotificacionesPendientes, enviarPushDeAlerta } from "../push.js";

const router = Router();

// El ESP32 solo puede reportarse a sí mismo como ONLINE o MAINTENANCE.
// EMERGENCY se activa exclusivamente vía /panic y OFFLINE se infiere por
// ausencia de heartbeat, nunca porque el propio dispositivo lo declare.
const AUTO_REPORTABLE_STATUSES = new Set(["ONLINE", "MAINTENANCE"]);

router.post("/heartbeat", deviceAuth, async (req, res) => {
  const device = req.device;
  const { batteryLevel, firmwareVersion } = req.body ?? {};

  await prisma.$transaction([
    prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: new Date(),
        status: device.status === "EMERGENCY" ? "EMERGENCY" : "ONLINE",
        ...(typeof batteryLevel === "number" ? { batteryLevel } : {}),
        ...(typeof firmwareVersion === "string" ? { firmwareVersion } : {}),
      },
    }),
    prisma.deviceEvent.create({
      data: {
        deviceId: device.id,
        type: "HEARTBEAT",
        payload: { batteryLevel, firmwareVersion },
      },
    }),
  ]);

  res.status(200).json({ ok: true });
});

router.post("/panic", deviceAuth, async (req, res) => {
  const device = req.device;

  const alert = await prisma.$transaction(async (tx) => {
    const createdAlert = await tx.alert.create({
      data: {
        groupId: device.groupId,
        deviceId: device.id,
        source: "DEVICE",
        status: "ACTIVE",
      },
    });

    await tx.deviceEvent.create({
      data: { deviceId: device.id, type: "PANIC" },
    });

    await tx.device.update({
      where: { id: device.id },
      data: { status: "EMERGENCY", lastSeenAt: new Date() },
    });

    await crearNotificacionesPendientes(tx, {
      alertId: createdAlert.id,
      groupId: device.groupId,
    });

    return createdAlert;
  });

  // El backend confirma la recepción y devuelve el id único de la alerta,
  // tal como pide la propuesta (sección 17).
  res.status(201).json({ alertId: alert.id, createdAt: alert.createdAt });

  // El push se manda DESPUÉS de responder: el ESP32 corre con batería y un
  // timeout corto, no puede quedarse esperando a que FCM conteste. Si esto
  // falla, las Notification quedan en PENDING y se pueden reintentar.
  enviarPushDeAlerta(alert.id)
    .then((resumen) => {
      console.log(
        `Alerta ${alert.id}: push a ${resumen.tokens} tokens, ` +
          `${resumen.enviadas} entregadas, ${resumen.fallidas} fallidas`
      );
    })
    .catch((e) => {
      console.error(`No se pudo enviar el push de la alerta ${alert.id}:`, e);
    });
});

router.post("/status", deviceAuth, async (req, res) => {
  const device = req.device;
  const { batteryLevel, firmwareVersion, status } = req.body ?? {};

  const data = { lastSeenAt: new Date() };
  if (typeof batteryLevel === "number") data.batteryLevel = batteryLevel;
  if (typeof firmwareVersion === "string") data.firmwareVersion = firmwareVersion;
  if (typeof status === "string" && AUTO_REPORTABLE_STATUSES.has(status)) {
    data.status = status;
  }

  await prisma.$transaction([
    prisma.device.update({ where: { id: device.id }, data }),
    prisma.deviceEvent.create({
      data: {
        deviceId: device.id,
        type: "STATUS_CHANGE",
        payload: { batteryLevel, firmwareVersion, status },
      },
    }),
  ]);

  res.status(200).json({ ok: true });
});

export default router;
