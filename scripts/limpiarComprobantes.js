import "dotenv/config";
import prisma from "../src/prisma.js";
import { fechaDeCorte, limpiarComprobantesViejos } from "../src/limpieza.js";

// Corre la limpieza a mano: `npm run comprobantes:limpiar`.
//
// El backend ya la hace solo una vez al día mientras esté encendido; esto es
// para forzarla, para revisar qué haría, o para un servidor que se apaga.
const corte = fechaDeCorte();
console.log(`Soltando las capturas de trámites cerrados anteriores a ${corte.toLocaleDateString("es-MX")}…`);

const capturas = await limpiarComprobantesViejos();
console.log(capturas === 0 ? "No había ninguna que cumpliera el plazo." : `Listo: ${capturas} capturas soltadas.`);

await prisma.$disconnect();
