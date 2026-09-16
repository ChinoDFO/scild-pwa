import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import devicesRouter from "./routes/devices.js";
import authRouter from "./routes/auth.js";
import groupsRouter from "./routes/groups.js";

const app = express();

// El ESP32 no manda Origin, así que esto solo afecta a la PWA en el navegador.
const origenesPermitidos = (process.env.FRONTEND_ORIGIN || "http://localhost:5173").split(",");

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

app.get("/health", (_req, res) => res.json({ ok: true }));

export default app;
