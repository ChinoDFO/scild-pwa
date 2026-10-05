import "dotenv/config";
import { createServer } from "node:http";
import app from "./app.js";
import { iniciarTiempoReal } from "./realtime.js";
import { revisarAlertasSinAtender } from "./push.js";
import { borrarMensajesViejos } from "./limpieza.js";

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

// Limpieza de mensajes viejos (ver limpieza.js): una vez al arrancar —el
// plan gratis de Render no siempre llega a vivir 24h seguidas— y luego cada
// 24h mientras el proceso siga vivo.
const INTERVALO_LIMPIEZA_MENSAJES = 24 * 60 * 60 * 1000;
function limpiarMensajes() {
  borrarMensajesViejos()
    .then(({ borrados }) => {
      if (borrados > 0) console.log(`Limpieza: ${borrados} mensaje(s) viejo(s) borrados.`);
    })
    .catch((e) => console.error("No se pudo limpiar mensajes viejos:", e));
}
limpiarMensajes();
setInterval(limpiarMensajes, INTERVALO_LIMPIEZA_MENSAJES);
