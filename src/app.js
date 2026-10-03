import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import devicesRouter from "./routes/devices.js";
import authRouter from "./routes/auth.js";
import groupsRouter from "./routes/groups.js";
import notificationsRouter from "./routes/notifications.js";
import alertsRouter from "./routes/alerts.js";
import accesoRouter from "./routes/acceso.js";
import adminRouter from "./routes/admin.js";
import correosRouter from "./routes/correos.js";
import { origenesPermitidos } from "./origenes.js";

const app = express();

// Detrás de un proxy (Render, Cloudflare...) sin esto req.ip sería la IP del
// proxy para TODOS, y los límites de peticiones de abajo se compartirían entre
// todos los usuarios y todos los botones. TRUST_PROXY = cuántos saltos de
// proxy hay delante de la app; en Render son 3 (Cloudflare + balanceadores) y
// Render pone RENDER=true solo, así que ahí no hay que configurar nada. Con
// más saltos de los reales, cualquiera podría falsear su IP; con menos, el
// límite se mezcla entre usuarios. En local no hay proxy: 0.
const saltosProxy = Number(process.env.TRUST_PROXY ?? (process.env.RENDER ? 3 : 0));
if (Number.isInteger(saltosProxy) && saltosProxy > 0) {
  app.set("trust proxy", saltosProxy);
}

// El ESP32 no manda Origin, así que esto solo afecta a la PWA en el navegador.
app.use(helmet());
app.use(cors({ origin: origenesPermitidos }));
app.use(express.json({ limit: "10kb" }));

// Límite generoso frente al heartbeat esperado (cada 60s por defecto);
// ajusta si heartbeatInterval cambia mucho entre dispositivos.
const deviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Límite más laxo para tráfico humano desde la PWA.
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Los correos de la tienda los dispara cualquier visitante al hacer o cancelar
// un pedido, sin sesión: límite bajo para que no se use para inundar a nadie.
const correosLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/devices", deviceLimiter, devicesRouter);
app.use("/api/correos", correosLimiter, correosRouter);
app.use("/api/auth", userLimiter, authRouter);
app.use("/api/groups", userLimiter, groupsRouter);
app.use("/api/notifications", userLimiter, notificationsRouter);
app.use("/api/alerts", userLimiter, alertsRouter);
app.use("/api/acceso", userLimiter, accesoRouter);
app.use("/api/admin", userLimiter, adminRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Express 5 manda aquí cualquier promesa rechazada en una ruta. Con Express 4
// ese mismo error (p. ej. Neon tardando en despertar) tumbaba el proceso
// completo, y con él el /panic de todos los botones.
app.use((err, req, res, _next) => {
  console.error(`Error en ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return;
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status < 500 ? err.message : "Error interno del servidor",
  });
});

export default app;
