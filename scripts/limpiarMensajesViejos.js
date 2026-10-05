// Borra los mensajes de chat más viejos que la retención (90 días por
// default). La lógica vive en src/limpieza.js — ahí también está por qué no
// toca el historial de alertas.
//
// Uso: npm run mensajes:limpiar

import "dotenv/config";
import prisma from "../src/prisma.js";
import { borrarMensajesViejos } from "../src/limpieza.js";

const { borrados, limite } = await borrarMensajesViejos();

console.log(
  borrados === 0
    ? `No había mensajes anteriores a ${limite.toISOString()}.`
    : `Borrados ${borrados} mensaje(s) anteriores a ${limite.toISOString()}.`
);

await prisma.$disconnect();
