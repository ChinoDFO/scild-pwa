// Borra los grupos que se quedaron sin nadie adentro.
//
// En el uso normal de la app esto no hace falta —salir del grupo y eliminar
// la cuenta ya se encargan— pero sirve como red de seguridad después de un
// ajuste manual en la base (un wipe de cuentas, un script de pruebas viejo,
// etc.). La lógica vive en src/limpieza.js.
//
// Uso: npm run grupos:limpiar

import "dotenv/config";
import prisma from "../src/prisma.js";
import { borrarGruposVacios } from "../src/limpieza.js";

const { borrados, conservados } = await borrarGruposVacios();

if (borrados.length === 0) {
  console.log("No había grupos vacíos que borrar.");
} else {
  console.log(`Borrados ${borrados.length} grupo(s) vacío(s):`);
  for (const g of borrados) console.log(`  - ${g.name}`);
}

if (conservados.length > 0) {
  console.log(
    `\n${conservados.length} grupo(s) están vacíos pero tienen botones vinculados, así que NO se tocaron:`
  );
  for (const g of conservados) console.log(`  - ${g.name} (${g._count.devices} botón/es)`);
  console.log("Desvincula sus botones primero si de verdad quieres borrarlos.");
}

await prisma.$disconnect();
