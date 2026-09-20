import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";
import {
  accesoDeCuenta,
  accesosDelBoton,
  otorgarAcceso,
  retirarAcceso,
  volverseTitular,
} from "../acceso.js";

const router = Router();

// Lo que pinta el apartado de "Códigos": si la cuenta tiene las funciones
// completas, de qué botones es titular, cuántos accesos comprados le quedan
// por repartir y a quién se los dio.
router.get("/", userAuth, async (req, res) => {
  const acceso = await accesoDeCuenta(req.user.id);

  const botones = await Promise.all(
    acceso.botones.map(async (deviceId) => {
      const [device, accesos, repartidos, titulares] = await Promise.all([
        prisma.device.findUnique({
          where: { id: deviceId },
          select: {
            id: true,
            name: true,
            deviceCode: true,
            group: { select: { id: true, name: true } },
          },
        }),
        accesosDelBoton(deviceId),
        prisma.accessGrant.findMany({
          where: { deviceId },
          select: { user: { select: { id: true, displayName: true, email: true } } },
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
        grupo: device.group,
        titulares: titulares.map((t) => ({ userId: t.user.id, nombre: comoSeLlama(t.user) })),
        accesos,
        repartidosA: repartidos.map((g) => ({
          userId: g.user.id,
          nombre: comoSeLlama(g.user),
          email: g.user.email,
        })),
      };
    })
  );

  res.json({
    completo: acceso.completo,
    esTitular: acceso.esTitular,
    // Quien no es titular pero sí tiene acceso: de qué botón se lo dieron.
    accesoDe: acceso.accesoDe,
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

// El titular reparte uno de los accesos que compró: esa persona pasa de
// invitada a tener las funciones completas.
router.post("/otorgar", userAuth, async (req, res) => {
  const { deviceId, userId } = req.body ?? {};
  if (typeof deviceId !== "string" || typeof userId !== "string") {
    return res.status(400).json({ error: "Falta el botón o la persona" });
  }

  await otorgarAcceso({ deviceId, titularId: req.user.id, userId });
  res.status(201).json({ ok: true, accesos: await accesosDelBoton(deviceId) });
});

// Le quita el acceso a alguien y libera el lugar.
router.delete("/otorgar", userAuth, async (req, res) => {
  const { deviceId, userId } = req.body ?? {};
  if (typeof deviceId !== "string" || typeof userId !== "string") {
    return res.status(400).json({ error: "Falta el botón o la persona" });
  }

  await retirarAcceso({ deviceId, titularId: req.user.id, userId });
  res.json({ ok: true, accesos: await accesosDelBoton(deviceId) });
});

export default router;
