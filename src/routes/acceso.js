import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import { estadoEfectivo } from "../membership.js";
import { accesoDeCuenta, volverseTitular } from "../acceso.js";

const router = Router();

// Lo que pinta el apartado de "Códigos": si la cuenta tiene las funciones
// completas, de qué botones es titular, cuántos accesos comprados le quedan
// por repartir y a quién se los dio.
router.get("/", userAuth, async (req, res) => {
  const acceso = await accesoDeCuenta(req.user.id);

  const botones = await Promise.all(
    acceso.botones.map(async (deviceId) => {
      const [device, titulares] = await Promise.all([
        prisma.device.findUnique({
          where: { id: deviceId },
          select: {
            id: true,
            name: true,
            deviceCode: true,
            // Lo que la pantalla del botón necesita para el monitoreo. La IP,
            // la red y la señal WiFi NO están: las tendría que reportar el
            // ESP32 y todavía no existe (la PWA las muestra como "Sin datos").
            status: true,
            lastSeenAt: true,
            batteryLevel: true,
            firmwareVersion: true,
            group: { select: { id: true, name: true, address: true } },
          },
        }),
        prisma.deviceHolder.findMany({
          where: { deviceId },
          orderBy: { createdAt: "asc" },
          select: { user: { select: { id: true, displayName: true, email: true } } },
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

// Vincula esta cuenta a un botón con el código impreso en su caja. El mismo
// código sirve para dos personas: la casa, no una persona.
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
    // 1 = eres el primero; 2 = ya estaban los dos lugares de este botón.
    titulares,
    // El botón todavía tiene que vincularse a un grupo para que avise.
    groupId: device.groupId,
  });
});

export default router;
