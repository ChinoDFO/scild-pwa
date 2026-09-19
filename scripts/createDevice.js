// Da de alta un botón e imprime sus dos códigos. Esto es lo que se hace al
// preparar el aparato, antes de venderlo:
//
//   - deviceSecret: va en la configuración del ESP32. Se muestra UNA sola vez
//     (en la base solo queda su hash). Si se pierde, hay que dar de alta otro.
//   - código de vinculación: se imprime en la caja. Con él, quien compre el
//     botón lo liga a su grupo desde la app, sin que nosotros toquemos nada.
//
// Uso:
//   npm run device:create -- BTN-001
//   npm run device:create -- BTN-001 "Abarrotes Flores"   (ya vinculado, para pruebas)

import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import prisma from "../src/prisma.js";
import { formatearClaimCode, generarClaimCode } from "../src/claimCode.js";

function generateSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

function generateInviteCode() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

// El código de la caja es único; si por casualidad se repite, se reintenta.
async function claimCodeLibre() {
  for (let intento = 0; intento < 5; intento++) {
    const codigo = generarClaimCode();
    if (!(await prisma.device.findUnique({ where: { claimCode: codigo } }))) return codigo;
  }
  throw new Error("No se pudo generar un código de vinculación único");
}

async function main() {
  const [, , deviceCode, groupName] = process.argv;

  if (!deviceCode) {
    console.error('Uso: npm run device:create -- <deviceCode> ["<grupo para pruebas>"]');
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

  const secret = generateSecret();
  const secretHash = await bcrypt.hash(secret, 12);
  const claimCode = await claimCodeLibre();

  const device = await prisma.device.create({
    data: {
      deviceCode,
      secretHash,
      claimCode,
      groupId: group?.id ?? null,
      ownerId: null,
      claimedAt: group ? new Date() : null,
    },
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
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
