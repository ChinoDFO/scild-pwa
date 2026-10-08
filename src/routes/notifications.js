import { Router } from "express";
import prisma from "../prisma.js";
import { userAuth } from "../middleware/userAuth.js";

const router = Router();

// La PWA registra aquí el token de FCM del navegador en el que está corriendo,
// justo después de que el usuario concede el permiso de notificaciones.
//
// `platform`: "WEB" (default, el navegador) o "ANDROID" (el token nativo de
// la app empaquetada, que manda LauncherActivity vía ?tokenNativo= — ver
// services/notificaciones.ts). Separados porque se les manda un mensaje de
// FCM distinto: a ANDROID le llega "data" puro, directo al
// AlertaMessagingService nativo, sin pasar por la delegación de Chrome.
const PLATAFORMAS_VALIDAS = new Set(["WEB", "ANDROID"]);

router.post("/token", userAuth, async (req, res) => {
  const { token, platform } = req.body ?? {};

  if (typeof token !== "string" || token.trim().length === 0) {
    return res.status(400).json({ error: "Falta el token de notificaciones" });
  }
  if (platform !== undefined && !PLATAFORMAS_VALIDAS.has(platform)) {
    return res.status(400).json({ error: "platform debe ser WEB o ANDROID" });
  }

  const userAgent = req.get("user-agent")?.slice(0, 255);

  // El token identifica al navegador, no a la persona. Si el mismo celular ya
  // había registrado token con otra cuenta (equipo compartido en el comercio),
  // se reasigna al usuario actual para que las alertas no se le sigan yendo
  // al dueño anterior de la sesión.
  const guardado = await prisma.pushToken.upsert({
    where: { token: token.trim() },
    update: { userId: req.user.id, userAgent, lastUsedAt: new Date(), ...(platform ? { platform } : {}) },
    create: { token: token.trim(), userId: req.user.id, userAgent, platform: platform ?? "WEB" },
  });

  res.status(201).json({ ok: true, registradoEn: guardado.lastUsedAt });
});

// Al cerrar sesión la PWA borra su token, para que el siguiente usuario de
// ese navegador no reciba las alertas de los grupos del anterior.
router.delete("/token", userAuth, async (req, res) => {
  const { token } = req.body ?? {};

  if (typeof token !== "string" || token.trim().length === 0) {
    return res.status(400).json({ error: "Falta el token de notificaciones" });
  }

  // Se acota al usuario de la sesión: nadie puede desregistrar el token de
  // otra persona mandando un token ajeno.
  const { count } = await prisma.pushToken.deleteMany({
    where: { token: token.trim(), userId: req.user.id },
  });

  res.json({ ok: true, borrados: count });
});

export default router;
