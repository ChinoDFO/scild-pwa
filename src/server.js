import "dotenv/config";
import { createServer } from "node:http";
import app from "./app.js";
import { iniciarTiempoReal } from "./realtime.js";
import { iniciarLimpiezaPeriodica } from "./limpieza.js";

const PORT = process.env.PORT || 3000;

// Socket.IO se cuelga del mismo servidor HTTP (mismo puerto que la API).
const servidor = createServer(app);
iniciarTiempoReal(servidor);

// Suelta cada día las capturas de pago que ya cumplieron tres meses.
iniciarLimpiezaPeriodica();

servidor.listen(PORT, () => {
  console.log(`Backend escuchando en el puerto ${PORT}`);
});
