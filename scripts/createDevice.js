// Da de alta un botón e imprime sus tres códigos. Esto es lo que se hace al
// preparar el aparato, antes de venderlo:
//
//   - deviceCode: el número de serie que le ponemos nosotros.
//   - deviceSecret: va en la configuración del ESP32. Se muestra UNA sola vez
//     (en la base solo queda su hash). Si se pierde, hay que dar de alta otro.
//   - código de vinculación: se imprime en la caja. Con él, quien compre el
//     botón lo liga a su grupo desde la app, sin que nosotros toquemos nada.
//
// Lo mismo se puede hacer desde el panel de administración de la app
// (/admin), que es lo práctico cuando no estás frente al proyecto. Los dos
// caminos usan src/fabrica.js: los códigos se generan en un solo lugar.
//
// Uso:
//   npm run device:create -- BTN-001
//   npm run device:create -- BTN-001 "Abarrotes Flores"   (ya vinculado, para pruebas)

import "dotenv/config";
import crypto from "node:crypto";
import prisma from "../src/prisma.js";
import { formatearClaimCode } from "../src/claimCode.js";
import { crearDispositivo, siguienteDeviceCode, validarDeviceCode } from "../src/fabrica.js";

function generateInviteCode() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

async function main() {
  const [, , deviceCode, groupName] = process.argv;

  if (!deviceCode) {
    console.error('Uso: npm run device:create -- <deviceCode> ["<grupo para pruebas>"]');
    console.error(`El siguiente libre de la serie sería: ${await siguienteDeviceCode()}`);
    process.exit(1);
  }

  const invalido = validarDeviceCode(deviceCode);
  if (invalido) {
    console.error(invalido);
    process.exit(1);
  }

  let group = null;
  if (groupName) {
    group = await prisma.group.findFirst({ where: { name: groupName } });
    if (!group) {
      group = await prisma.group.create({
        data: { name: groupName, inviteCode: generateInviteCode() },
      });
      console.log(`Grupo creado: ${group.name} (código de invitación: ${group.inviteCode})`);
    }
  }

  const { device, secret, claimCode } = await crearDispositivo({
    deviceCode,
    groupId: group?.id ?? null,
  });

  console.log("\nBotón dado de alta. El secreto NO se volverá a mostrar:");
  console.log(`  deviceCode:   ${device.deviceCode}`);
  console.log(`  deviceSecret: ${secret}   ← va en el ESP32`);
  console.log(`  vinculación:  ${formatearClaimCode(claimCode)}   ← se imprime en la caja`);
  if (group) {
    console.log(`\nYa quedó vinculado a "${group.name}" (sin dueño). Para el flujo real,`);
    console.log("no pases el nombre del grupo: que lo vincule su dueño desde la app.");
  }
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
