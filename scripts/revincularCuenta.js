// Reconecta la fila de Postgres de un correo con su cuenta ACTUAL de Firebase.
//
// Para cuándo: la cuenta de Firebase se borró (desde la consola, por ejemplo)
// y la persona se registró de nuevo con el mismo correo. Firebase le dio un
// uid nuevo, la fila de aquí sigue apuntando al viejo, y entonces TODA ruta
// autenticada le contesta 409 (antes era un 500 sin explicación).
//
// Esto no se hace solo a propósito: Firebase no verifica el correo al
// registrarse, así que reconectar por correo sin que un humano confirme que
// es la misma persona sería regalarle a cualquiera los grupos y botones del
// dueño original. Corre esto solo cuando estés seguro.
//
// Uso:
//   npm run cuenta:revincular -- correo@ejemplo.com          (muestra qué haría)
//   npm run cuenta:revincular -- correo@ejemplo.com --si     (lo hace)
//   npm run cuenta:revincular -- correo@ejemplo.com --borrar (borra la fila vieja)

import "dotenv/config";
import prisma from "../src/prisma.js";
import { firebaseAuth } from "../src/firebaseAdmin.js";

const [, , email, modo] = process.argv;

if (!email) {
  console.error("Uso: npm run cuenta:revincular -- <correo> [--si | --borrar]");
  process.exit(1);
}

async function main() {
  const fila = await prisma.user.findUnique({
    where: { email },
    include: {
      memberships: { include: { group: { select: { name: true } } } },
      titularidades: { include: { device: { select: { deviceCode: true } } } },
    },
  });

  if (!fila) {
    console.log(`\n  En Postgres no hay ninguna fila con el correo ${email}. Nada que reconectar.\n`);
    return;
  }

  let actual = null;
  try {
    actual = await firebaseAuth.getUserByEmail(email);
  } catch {
    /* no existe en Firebase */
  }

  const uidVive = await firebaseAuth
    .getUser(fila.firebaseUid)
    .then(() => true)
    .catch(() => false);

  console.log(`\n  Correo            : ${email}`);
  console.log(`  Fila en Postgres  : ${fila.id}`);
  console.log(`  uid que tiene     : ${fila.firebaseUid} ${uidVive ? "(vive en Firebase)" : "(YA NO EXISTE en Firebase)"}`);
  console.log(`  uid actual        : ${actual ? actual.uid : "no hay cuenta de Firebase con ese correo"}`);
  console.log(`  Se llevaría consigo:`);
  console.log(`    - ${fila.memberships.length} grupo(s): ${fila.memberships.map((m) => m.group.name).join(", ") || "-"}`);
  console.log(`    - titular de ${fila.titularidades.length} botón(es): ${fila.titularidades.map((t) => t.device.deviceCode).join(", ") || "-"}`);

  if (uidVive) {
    console.log(`\n  La fila ya apunta a una cuenta viva. No hay nada que arreglar.\n`);
    return;
  }

  if (modo === "--borrar") {
    await prisma.user.delete({ where: { id: fila.id } });
    console.log(`\n  Fila borrada. Quien entre con ese correo empieza de cero (pierde lo de arriba).\n`);
    return;
  }

  if (!actual) {
    console.log(`\n  No hay cuenta de Firebase con ese correo. Regístrala en la app y vuelve a correr esto,`);
    console.log(`  o usa --borrar si prefieres tirar los datos viejos.\n`);
    return;
  }

  if (modo !== "--si") {
    console.log(`\n  Esto MOVERÍA todo lo de arriba a la cuenta de Firebase ${actual.uid}.`);
    console.log(`  Si es la misma persona, confirma con:`);
    console.log(`     npm run cuenta:revincular -- ${email} --si\n`);
    return;
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: fila.id }, data: { firebaseUid: actual.uid } }),
    prisma.auditLog.create({
      data: {
        userId: fila.id,
        action: "ACCOUNT_RELINKED",
        entity: "User",
        entityId: fila.id,
        metadata: { email, uidAnterior: fila.firebaseUid, uidNuevo: actual.uid },
      },
    }),
  ]);

  console.log(`\n  Listo: ${email} quedó reconectado al uid ${actual.uid}. Ya puede entrar normal.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
