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
import { origenesPermitidos } from "./origenes.js";

const app = express();

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

app.use("/api/devices", deviceLimiter, devicesRouter);
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
