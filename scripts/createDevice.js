// Da de alta un dispositivo (creando su grupo si no existe) e imprime el
// deviceSecret en claro UNA sola vez — es la única vez que existirá fuera
// del hash guardado en la base. Cópialo a la config del ESP32 y no lo pierdas.
//
// Uso: node scripts/createDevice.js BTN-001 "Abarrotes Flores"

import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import prisma from "../src/prisma.js";

function generateSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

function generateInviteCode() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

async function main() {
  const [, , deviceCode, groupName] = process.argv;

  if (!deviceCode || !groupName) {
    console.error('Uso: node scripts/createDevice.js <deviceCode> "<nombre del grupo>"');
    process.exit(1);
  }

  let group = await prisma.group.findFirst({ where: { name: groupName } });
  if (!group) {
    group = await prisma.group.create({
      data: { name: groupName, inviteCode: generateInviteCode() },
    });
    console.log(`Grupo creado: ${group.name} (código de invitación: ${group.inviteCode})`);
  }

  const secret = generateSecret();
  const secretHash = await bcrypt.hash(secret, 12);

  const device = await prisma.device.create({
    data: { deviceCode, groupId: group.id, secretHash },
  });

  console.log("\nDispositivo creado. Este secreto NO se volverá a mostrar:");
  console.log(`  deviceCode:   ${device.deviceCode}`);
  console.log(`  deviceSecret: ${secret}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
