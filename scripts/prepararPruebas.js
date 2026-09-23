// Deja la base lista para probar el sistema de acceso y cupos, y
// escupe todos los datos que hacen falta para hacerlo.
//
// Es IDEMPOTENTE: correrlo dos veces no duplica nada ni revoca nada. Lo que
// no se puede repetir es el deviceSecret — en la base solo queda su hash, así
// que se imprime la única vez que se crea el botón. Si lo pierdes, borra el
// botón de prueba y vuelve a correr esto.
//
// Uso:
//   npm run pruebas:preparar
//
// NO usar en producción: da de alta botones de mentiras y reparte permisos.

import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import prisma from "../src/prisma.js";
import { generarClaimCode, formatearClaimCode } from "../src/claimCode.js";
import { LUGARES_POR_BOTON, TITULARES_POR_BOTON } from "../src/acceso.js";

const ADMIN = "scild2154@gmail.com";

// Los botones de prueba. El de la cuenta administradora se vincula solo, para
// que no quede sin funciones; los otros dos se dejan libres a propósito,
// porque vincularlos DESDE LA APP es justo lo que se quiere probar.
const BOTONES = [
  { deviceCode: "BTN-PRUEBA-ADMIN", nombre: "Botón de la cuenta administradora", paraElAdmin: true },
  { deviceCode: "BTN-PRUEBA-01", nombre: "Casa 1 (para vincular desde la app)", paraElAdmin: false },
  { deviceCode: "BTN-PRUEBA-02", nombre: "Casa 2 (segundo titular del coto)", paraElAdmin: false },
];

function nuevoSecreto() {
  return crypto.randomBytes(24).toString("base64url");
}

async function claimCodeLibre() {
  for (let i = 0; i < 5; i++) {
    const codigo = generarClaimCode();
    if (!(await prisma.device.findUnique({ where: { claimCode: codigo } }))) return codigo;
  }
  throw new Error("No se pudo generar un código de caja único");
}

async function main() {
  const lineas = [];
  const secretos = new Map();

  // --- 1. La cuenta administradora ---------------------------------------
  const admin = await prisma.user.findUnique({ where: { email: ADMIN } });
  if (!admin) {
    console.error(`\n  ${ADMIN} todavía no ha entrado a la app.`);
    console.error("  Regístrate una vez con esa cuenta y vuelve a correr esto.\n");
    process.exit(1);
  }
  if (!admin.isPlatformAdmin) {
    await prisma.user.update({ where: { id: admin.id }, data: { isPlatformAdmin: true } });
    lineas.push(`administrador de plataforma: ${ADMIN} (recién activado)`);
  } else {
    lineas.push(`administrador de plataforma: ${ADMIN} (ya lo era)`);
  }

  // --- 2. Botones de prueba ----------------------------------------------
  for (const b of BOTONES) {
    let device = await prisma.device.findUnique({
      where: { deviceCode: b.deviceCode },
      include: { holders: true },
    });

    if (!device) {
      const secreto = nuevoSecreto();
      device = await prisma.device.create({
        data: {
          deviceCode: b.deviceCode,
          name: b.nombre,
          claimCode: await claimCodeLibre(),
          secretHash: await bcrypt.hash(secreto, 10),
        },
        include: { holders: true },
      });
      secretos.set(b.deviceCode, secreto);
    }

    // El botón del admin se vincula aquí mismo: esa cuenta tiene que poder
    // alertar sin depender de que alguien teclee un código.
    if (b.paraElAdmin && device.holders.length === 0) {
      await prisma.$transaction([
        prisma.deviceHolder.create({ data: { deviceId: device.id, userId: admin.id } }),
        prisma.device.update({
          where: { id: device.id },
          data: { claimedAt: new Date(), ownerId: admin.id },
        }),
      ]);
    }
  }

  // --- 3. El botón viejo, de antes de que existieran los códigos ----------
  // BTN-001 se dio de alta cuando el código de caja no existía: quedó pegado
  // a un grupo pero sin titular, así que NADIE de ese grupo puede alertar. Se
  // le pone código para que se pueda vincular desde la app como cualquiera.
  const viejo = await prisma.device.findUnique({
    where: { deviceCode: "BTN-001" },
    include: { holders: true },
  });
  if (viejo && !viejo.claimCode && viejo.holders.length === 0) {
    await prisma.device.update({
      where: { id: viejo.id },
      data: { claimCode: await claimCodeLibre(), claimedAt: null },
    });
    lineas.push("BTN-001 (el viejo, sin titular) ahora tiene código de caja");
  }

  // --- 4. Reporte ---------------------------------------------------------
  const devices = await prisma.device.findMany({
    where: { deviceCode: { in: [...BOTONES.map((b) => b.deviceCode), "BTN-001"] } },
    include: { holders: { include: { user: { select: { email: true } } } }, group: { select: { name: true } } },
    orderBy: { deviceCode: "asc" },
  });

  console.log("\n===============  LISTO  ===============\n");
  for (const l of lineas) console.log("  - " + l);

  console.log("\n--- BOTONES ---");
  for (const d of devices) {
    console.log(`\n  ${d.deviceCode}  (${d.name ?? "sin nombre"})`);
    console.log(`    código de la caja : ${d.claimCode ? formatearClaimCode(d.claimCode) : "(sin código)"}`);
    console.log(`    titulares         : ${d.holders.length}/${TITULARES_POR_BOTON} ${d.holders.length ? "-> " + d.holders.map((h) => h.user.email).join(", ") : "(libre)"}`);
    console.log(`    grupo             : ${d.group?.name ?? "sin vincular a un grupo"}`);
    const s = secretos.get(d.deviceCode);
    if (s) {
      console.log(`    deviceSecret      : ${s}`);
      console.log("                        ^ SOLO SE MUESTRA AHORA. Es para simular el ESP32.");
    }
  }

  console.log("\n--- REGLAS VIGENTES EN EL CÓDIGO ---");
  console.log(`  titulares por botón        : ${TITULARES_POR_BOTON}`);
  console.log(`  lugares por botón en grupo : ${LUGARES_POR_BOTON}`);
  console.log(`  => un grupo con 1 botón tiene ${TITULARES_POR_BOTON} cuentas completas`);
  console.log(`     y ${LUGARES_POR_BOTON - TITULARES_POR_BOTON} invitados. Sin pagos no hay forma de mover ese reparto.
`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
