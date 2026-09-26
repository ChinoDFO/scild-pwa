import { Router } from "express";
import prisma from "../prisma.js";
import { deviceAuth } from "../middleware/deviceAuth.js";
import { crearNotificacionesPendientes, enviarPushDeAlerta } from "../push.js";
import { emitirAGrupo } from "../realtime.js";
import { configuracionParaElBoton } from "../configuracionBoton.js";

const router = Router();

// El ESP32 solo puede reportarse a sí mismo como ONLINE o MAINTENANCE.
// EMERGENCY se activa exclusivamente vía /panic y OFFLINE se infiere por
// ausencia de heartbeat, nunca porque el propio dispositivo lo declare.
const AUTO_REPORTABLE_STATUSES = new Set(["ONLINE", "MAINTENANCE"]);

// Lo que el ESP32 reporta de sí mismo en cada heartbeat. Se filtra campo por
// campo: lo que manda el aparato entra directo a la base y un valor raro
// (una IP de 10 KB, un RSSI de texto) no debe poder guardarse.
//
// Los nombres de fuera son los que ya usaba el firmware —redActiva,
// fallosInternet— para no tener que cambiar el aparato y el servidor a la vez.
function telemetriaDe(body) {
  const { batteryLevel, firmwareVersion, ip, redActiva, rssi, fallosInternet } = body ?? {};
  const data = {};

  if (typeof batteryLevel === "number") data.batteryLevel = batteryLevel;
  if (typeof firmwareVersion === "string") data.firmwareVersion = firmwareVersion.slice(0, 20);
  if (typeof ip === "string") data.ipAddress = ip.slice(0, 45);
  if (typeof redActiva === "string") data.ssid = redActiva.slice(0, 32);
  if (typeof rssi === "number" && Number.isFinite(rssi)) data.rssi = Math.trunc(rssi);
  if (typeof fallosInternet === "number" && fallosInternet >= 0) {
    data.internetFailures = Math.trunc(fallosInternet);
  }

  return data;
}

// El aparato manda la versión de configuración que ya tiene aplicada. Si es
// la misma que hay en el servidor se le contesta `config: null` y se ahorra
// el JSON entero (que incluye la contraseña de la red de respaldo); si
// cambió, se le manda completa para que la guarde en su memoria.
async function configuracionPendiente(deviceId, configVersion) {
  const config = await configuracionParaElBoton(deviceId);
  if (!config) return null;
  return config.version === Number(configVersion) ? null : config;
}

router.post("/heartbeat", deviceAuth, async (req, res) => {
  const device = req.device;
  const telemetria = telemetriaDe(req.body);

  await prisma.$transaction([
    prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: new Date(),
        status: device.status === "EMERGENCY" ? "EMERGENCY" : "ONLINE",
        ...telemetria,
      },
    }),
    prisma.deviceEvent.create({
      data: {
        deviceId: device.id,
        type: "HEARTBEAT",
        payload: telemetria,
      },
    }),
  ]);

  // La respuesta del heartbeat es el canal por el que la app configura el
  // botón: el aparato no puede recibir conexiones de fuera (está detrás del
  // router del cliente), así que los ajustes viajan de vuelta en el mismo
  // viaje que ya hace cada pocos minutos.
  res.status(200).json({
    ok: true,
    config: await configuracionPendiente(device.id, req.body?.configVersion),
  });
});

// Cuántos segundos después de una alerta se considera que lo que llega es el
// reintento de la misma y no un botonazo nuevo. Es el cooldown del propio
// aparato (el que configura la app), con un mínimo de 15s: por debajo de eso
// el reintento del firmware todavía anda en camino.
async function ventanaDeReintento(deviceId) {
  const config = await configuracionParaElBoton(deviceId);
  return Math.max(config?.cooldownSegundos ?? 10, 15);
}

router.post("/panic", deviceAuth, async (req, res) => {
  const device = req.device;

  // A qué grupos les avisa, del más antiguo al más nuevo. Un botón recién
  // salido de fábrica, o desvinculado de todos, no tiene a quién avisarle. Se
  // responde claro para que el firmware lo pueda mostrar.
  const vinculos = await prisma.deviceGroup.findMany({
    where: { deviceId: device.id },
    orderBy: { createdAt: "asc" },
    select: { groupId: true },
  });
  if (vinculos.length === 0) {
    return res.status(409).json({ error: "Dispositivo sin vincular a un grupo" });
  }

  // Reintento, no segunda emergencia.
  //
  // El ESP32 reintenta cuando no obtiene respuesta, y desde el aparato no se
  // distingue "no llegó" de "llegó y se perdió el acuse": sin esto, un
  // apagón de dos segundos en medio de una alerta manda tres avisos push del
  // mismo botonazo. Dentro de la ventana de cooldown se le devuelve la
  // alerta que ya se creó, con el mismo alertId.
  const ventana = await ventanaDeReintento(device.id);
  const recientes = await prisma.alert.findMany({
    where: {
      deviceId: device.id,
      source: "DEVICE",
      status: "ACTIVE",
      createdAt: { gt: new Date(Date.now() - ventana * 1000) },
    },
    orderBy: { createdAt: "asc" },
  });

  if (recientes.length > 0) {
    return res.status(200).json({
      alertId: recientes[0].id,
      alertIds: recientes.map((a) => a.id),
      createdAt: recientes[0].createdAt,
      repetida: true,
    });
  }

  // Una alerta por cada grupo: cada uno tiene su chat, su historial y su
  // propio "ya voy" / "resuelta", y no se puede resolver una emergencia en un
  // grupo sin que los demás lo sepan.
  const alertas = await prisma.$transaction(async (tx) => {
    const creadas = [];
    // Quien está en varios de estos grupos recibe UN solo aviso, por el más
    // antiguo; en el chat de los demás la alerta aparece igual.
    const yaAvisados = new Set();

    for (const { groupId } of vinculos) {
      const alerta = await tx.alert.create({
        data: {
          groupId,
          deviceId: device.id,
          source: "DEVICE",
          status: "ACTIVE",
        },
      });

      await crearNotificacionesPendientes(tx, {
        alertId: alerta.id,
        groupId,
        excluirUserIds: [...yaAvisados],
      });

      const miembros = await tx.groupMember.findMany({ where: { groupId }, select: { userId: true } });
      for (const m of miembros) yaAvisados.add(m.userId);

      creadas.push(alerta);
    }

    await tx.deviceEvent.create({
      data: { deviceId: device.id, type: "PANIC", payload: { grupos: vinculos.map((v) => v.groupId) } },
    });

    await tx.device.update({
      where: { id: device.id },
      data: { status: "EMERGENCY", lastSeenAt: new Date() },
    });

    return creadas;
  });

  // El backend confirma la recepción y devuelve el id único de la alerta,
  // tal como pide la propuesta (sección 17). alertId es el del grupo más
  // antiguo; alertIds trae todos.
  res.status(201).json({
    alertId: alertas[0].id,
    alertIds: alertas.map((a) => a.id),
    createdAt: alertas[0].createdAt,
  });

  for (const alerta of alertas) {
    emitirAGrupo(alerta.groupId, "alertas:cambio", { groupId: alerta.groupId, alertId: alerta.id });

    // El push se manda DESPUÉS de responder: el ESP32 corre con batería y un
    // timeout corto, no puede quedarse esperando a que FCM conteste. Si esto
    // falla, las Notification quedan en PENDING y se pueden reintentar.
    enviarPushDeAlerta(alerta.id)
      .then((resumen) => {
        console.log(
          `Alerta ${alerta.id}: push a ${resumen.tokens} tokens, ` +
            `${resumen.enviadas} entregadas, ${resumen.fallidas} fallidas`
        );
      })
      .catch((e) => {
        console.error(`No se pudo enviar el push de la alerta ${alerta.id}:`, e);
      });
  }
});

router.post("/status", deviceAuth, async (req, res) => {
  const device = req.device;
  const { status } = req.body ?? {};
  const telemetria = telemetriaDe(req.body);

  const data = { lastSeenAt: new Date(), ...telemetria };
  if (typeof status === "string" && AUTO_REPORTABLE_STATUSES.has(status)) {
    data.status = status;
  }

  await prisma.$transaction([
    prisma.device.update({ where: { id: device.id }, data }),
    prisma.deviceEvent.create({
      data: {
        deviceId: device.id,
        type: "STATUS_CHANGE",
        payload: { ...telemetria, status },
      },
    }),
  ]);

  res.status(200).json({
    ok: true,
    config: await configuracionPendiente(device.id, req.body?.configVersion),
  });
});

export default router;
