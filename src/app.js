import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import devicesRouter from "./routes/devices.js";

const app = express();

app.use(helmet());
app.use(express.json({ limit: "10kb" }));

// Límite generoso frente al heartbeat esperado (cada 60s por defecto);
// ajusta si heartbeatInterval cambia mucho entre dispositivos.
const deviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/devices", deviceLimiter, devicesRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

export default app;
