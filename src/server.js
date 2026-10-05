import "dotenv/config";
import { createServer } from "node:http";
import app from "./app.js";
import { iniciarTiempoReal } from "./realtime.js";
import { revisarAlertasSinAtender } from "./push.js";

const PORT = process.env.PORT || 3000;

// Socket.IO se cuelga del mismo servidor HTTP (mismo puerto que la API).
const servidor = createServer(app);
iniciarTiempoReal(servidor);

servidor.listen(PORT, () => {
  console.log(`Backend escuchando en el puerto ${PORT}`);
});

// Insiste con las alertas GENERAL activas que nadie ha atendido (ver
// revisarAlertasSinAtender en push.js). Cada minuto es barato —la tabla de
// alertas activas es chica— y da precisión de sobra sobre el umbral real de
// 15 minutos.
const INTERVALO_REVISION_ALERTAS = 60 * 1000;
setInterval(() => {
  revisarAlertasSinAtender().catch((e) =>
    console.error("No se pudo revisar las alertas sin atender:", e)
  );
}, INTERVALO_REVISION_ALERTAS);
