import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { estadoEfectivo } from "../membership.js";
import { accesoDeCuenta, volverseTitular } from "../acceso.js";
import {
  configuracionParaElBoton,
  paraLaApp,
  validarConfiguracion,
  HEARTBEAT_MIN,
  HEARTBEAT_MAX,
} from "../configuracionBoton.js";

const router = Router();

// Lo que pinta el apartado de "Códigos": si la cuenta tiene las funciones
// completas y de qué botones es titular, con lo que la pantalla del botón
// necesita para el monitoreo.
router.get("/", userAuth, async (req, res) => {
  const acceso = await accesoDeCuenta(req.user.id);

  const botones = await Promise.all(
    acceso.botones.map(async (deviceId) => {
      const [device, titulares, ultimaAlerta] = await Promise.all([
        prisma.device.findUnique({
          where: { id: deviceId },
          select: {
            id: true,
            name: true,
            deviceCode: true,
            // Todo lo que la pantalla del botón enseña en su cuadrícula de
            // monitoreo. La IP, la red y la señal las reporta el ESP32 en su
            // heartbeat; mientras no haya reportado van en null y la app
            // dibuja "Sin datos".
            status: true,
            lastSeenAt: true,
            batteryLevel: true,
            firmwareVersion: true,
            ipAddress: true,
            ssid: true,
            rssi: true,
            internetFailures: true,
            heartbeatInterval: true,
            group: { select: { id: true, name: true, address: true } },
          },
        }),
        prisma.deviceHolder.findMany({
          where: { deviceId },
          orderBy: { createdAt: "asc" },
          select: { user: { select: { id: true, displayName: true, email: true } } },
        }),
        // Cuándo fue la última vez que ESTE botón disparó una alerta. Sale de
        // Alert y no de una columna en Device: la alerta ya se guarda ahí y
        // duplicar el dato es garantizar que un día no coincidan.
        prisma.alert.findFirst({
          where: { deviceId },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
      ]);

      const comoSeLlama = (u) => u.displayName || u.email;

      return {
        id: device.id,
        nombre: device.name || device.deviceCode,
        deviceCode: device.deviceCode,
        grupo: device.group && { id: device.group.id, name: device.group.name },
        // La dirección del botón es la del establecimiento donde está
        // vinculado: el aparato no tiene una propia.
        direccion: device.group?.address ?? null,
        estado: estadoEfectivo(device, Date.now()),
        ultimaSenal: device.lastSeenAt,
        bateria: device.batteryLevel,
        firmware: device.firmwareVersion,
        // Telemetría del último heartbeat.
        ip: device.ipAddress,
        redActiva: device.ssid,
        rssi: device.rssi,
        fallosInternet: device.internetFailures,
        // Cada cuánto promete reportarse: con eso la app sabe si "hace 10
        // minutos" es normal o ya es raro.
        intervaloSenal: device.heartbeatInterval,
        ultimaAlerta: ultimaAlerta?.createdAt ?? null,
        titulares: titulares.map((t) => ({ userId: t.user.id, nombre: comoSeLlama(t.user) })),
      };
    })
  );

  res.json({
    completo: acceso.completo,
    esTitular: acceso.esTitular,
    botones,
  });
});

// --- Configuración del botón desde la app ----------------------------------

// Solo un TITULAR del botón lo configura: es quien tiene el aparato en su
// casa o su negocio. Ser admin del grupo no alcanza —en un coto, el vecino
// que administra el chat no tiene por qué cambiarle la red a nadie— y el 404
// es el mismo exista o no el botón, para no ir revelando ids ajenos.
async function exigirTitular(req, res) {
  const acceso = await accesoDeCuenta(req.user.id);
  if (!acceso.botones.includes(req.params.id)) {
    res.status(404).json({ error: "Ese botón no está vinculado a tu cuenta" });
    return null;
  }
  return req.params.id;
}

// Lo que la pantalla "Configura tu botón" necesita para llenarse. La
// contraseña de la red de respaldo NO se devuelve nunca: solo si está puesta.
router.get("/botones/:id/config", userAuth, async (req, res) => {
  const deviceId = await exigirTitular(req, res);
  if (!deviceId) return;

  const [filas, device] = await Promise.all([
    prisma.deviceConfiguration.findMany({ where: { deviceId } }),
    prisma.device.findUnique({
      where: { id: deviceId },
      select: { name: true, heartbeatInterval: true },
    }),
  ]);

  res.json({
    nombre: device.name,
    heartbeatSegundos: device.heartbeatInterval,
    ...paraLaApp(filas),
    // Cuándo se aplicará: el aparato baja los ajustes en su siguiente
    // heartbeat, así que la app puede decir "en los próximos N minutos" en
    // vez de dejar a la persona sin saber si ya quedó.
    seAplicaEnSegundos: device.heartbeatInterval,
  });
});

// Guarda los ajustes. NO se le mandan al aparato desde aquí: el ESP32 está
// detrás del router del cliente y no recibe conexiones de fuera. Se quedan
// esperando a que él pregunte en su siguiente heartbeat, que es el único
// momento en que se le puede hablar.
router.patch("/botones/:id/config", userAuth, async (req, res) => {
  const deviceId = await exigirTitular(req, res);
  if (!deviceId) return;

  const { nombre, heartbeatSegundos } = req.body ?? {};
  const { cambios, error } = validarConfiguracion(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  // Estos dos no son llave/valor: viven en Device porque el servidor mismo
  // los usa (el nombre en las listas, el intervalo para deducir si un botón
  // se quedó sin señal).
  const datosDelAparato = {};
  if (nombre !== undefined) {
    if (typeof nombre !== "string" || nombre.trim().length === 0 || nombre.trim().length > 40) {
      return res.status(400).json({ error: "El nombre del botón va de 1 a 40 caracteres" });
    }
    datosDelAparato.name = nombre.trim();
  }
  if (heartbeatSegundos !== undefined) {
    const n = Number(heartbeatSegundos);
    if (!Number.isInteger(n) || n < HEARTBEAT_MIN || n > HEARTBEAT_MAX) {
      return res.status(400).json({
        error: `El aviso de vida va de ${HEARTBEAT_MIN} a ${HEARTBEAT_MAX} segundos`,
      });
    }
    datosDelAparato.heartbeatInterval = n;
  }

  await prisma.$transaction(async (tx) => {
    if (Object.keys(datosDelAparato).length > 0) {
      await tx.device.update({ where: { id: deviceId }, data: datosDelAparato });
    }

    for (const { key, value } of cambios) {
      // Valor vacío = borrar el ajuste (quitar la red de respaldo, por
      // ejemplo). Se borra la fila en vez de guardar "" para que el aparato
      // reciba el campo vacío y la olvide.
      if (value === "") {
        await tx.deviceConfiguration.deleteMany({ where: { deviceId, key } });
        // Sin red de respaldo, su contraseña no sirve para nada: se va con
        // ella en vez de quedarse guardada de más.
        if (key === "ssidRespaldo") {
          await tx.deviceConfiguration.deleteMany({ where: { deviceId, key: "passRespaldo" } });
        }
        continue;
      }
      await tx.deviceConfiguration.upsert({
        where: { deviceId_key: { deviceId, key } },
        create: { deviceId, key, value, updatedBy: req.user.id },
        update: { value, updatedBy: req.user.id },
      });
    }

    await tx.deviceEvent.create({
      data: {
        deviceId,
        type: "CONFIG_UPDATE",
        // Qué se tocó, nunca con qué valor: aquí va la contraseña del WiFi.
        payload: {
          llaves: [...cambios.map((c) => c.key), ...Object.keys(datosDelAparato)],
          por: req.user.id,
        },
      },
    });

    await tx.auditLog.create({
      data: {
        userId: req.user.id,
        action: "DEVICE_CONFIG_UPDATED",
        entity: "Device",
        entityId: deviceId,
        metadata: { llaves: cambios.map((c) => c.key) },
      },
    });
  });

  const config = await configuracionParaElBoton(deviceId);
  const filas = await prisma.deviceConfiguration.findMany({ where: { deviceId } });

  res.json({
    ok: true,
    nombre: config.nombre,
    heartbeatSegundos: config.heartbeatSegundos,
    ...paraLaApp(filas),
    seAplicaEnSegundos: config.heartbeatSegundos,
  });
});

// Vincula esta cuenta a un botón con el código impreso en su caja. El mismo
// código sirve para tres personas: la casa, no una persona.
//
// Se llama desde el registro (el campo opcional de código) y desde el
// apartado de Códigos, para quien creó su cuenta antes de comprar el botón.
router.post("/vincular", userAuth, async (req, res) => {
  // volverseTitular lanza ErrorDeAcceso con su status; lo traduce a JSON el
  // manejador de errores de app.js.
  const { device, titulares } = await volverseTitular({
    userId: req.user.id,
    claimCode: req.body?.claimCode,
  });

  res.status(201).json({
    id: device.id,
    deviceCode: device.deviceCode,
    nombre: device.name || device.deviceCode,
    // Qué número de titular te tocó (1 = eres el primero, 3 = el último).
    titulares,
    // El botón todavía tiene que vincularse a un grupo para que avise.
    groupId: device.groupId,
  });
});

export default router;
