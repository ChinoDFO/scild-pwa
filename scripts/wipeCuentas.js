// Borra cuentas: Firebase Auth y su fila en Postgres, con todo lo que cuelga
// de ellas (membresías, mensajes, notificaciones, tokens push,
// titularidades). Es para reiniciar el entorno de pruebas desde cero.
//
// Por defecto son TODAS. Con --conservar se excluyen una o varias, separadas
// por coma — para el caso típico de guardar la cuenta admin y borrar el
// resto.
//
// Qué NO se borra, a propósito:
//   - Los DISPOSITIVOS (Device: BTN-001, BTN-PRUEBA-01, BTN-002...). Son
//     inventario físico real —BTN-002 ya tiene un ESP32 de verdad configurado
//     con su secreto— y borrar la fila lo dejaría inservible sin volver a
//     flashearlo. Los que queden sin ningún miembro en su grupo se
//     desvinculan (groupId null, status OFFLINE) en vez de arrastrarse con
//     un grupo fantasma, pero conservan deviceCode, secretHash y claimCode:
//     se pueden reclamar otra vez con su mismo código de caja.
//
// Qué SÍ se borra además de las cuentas:
//   - Los GRUPOS donde TODOS los miembros están en la lista a borrar (si
//     alguien que se conserva sigue en el grupo, el grupo se queda como
//     está, con quien se conserva adentro).
//
// Uso:
//   npm run cuentas:wipe                                  (todas, solo enseña)
//   npm run cuentas:wipe -- --si                           (todas, lo hace)
//   npm run cuentas:wipe -- --conservar admin@correo.com   (todas menos esa, enseña)
//   npm run cuentas:wipe -- --conservar admin@correo.com --si

import "dotenv/config";
import prisma from "../src/prisma.js";
import { firebaseAuth } from "../src/firebaseAdmin.js";

const ejecutar = process.argv.includes("--si");

const iConservar = process.argv.indexOf("--conservar");
const conservar = new Set(
  iConservar === -1
    ? []
    : (process.argv[iConservar + 1] ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
);

async function main() {
  const todos = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      firebaseUid: true,
      isPlatformAdmin: true,
      _count: { select: { memberships: true, titularidades: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const usuarios = todos.filter((u) => !conservar.has(u.email.toLowerCase()));
  const conservados = todos.filter((u) => conservar.has(u.email.toLowerCase()));

  // Un correo pasado a --conservar que no existe en la base es casi siempre
  // una errata (mayúsculas, dominio mal escrito): mejor avisar y parar que
  // borrar de más en silencio.
  const noEncontrados = [...conservar].filter((e) => !todos.some((u) => u.email.toLowerCase() === e));
  if (noEncontrados.length > 0) {
    console.error(`No encontré ninguna cuenta con: ${noEncontrados.join(", ")}. Nada se tocó.`);
    process.exitCode = 1;
    return;
  }

  if (usuarios.length === 0) {
    console.log("No hay cuentas que borrar (con lo que pediste conservar, no queda ninguna).");
    return;
  }

  const idsABorrar = new Set(usuarios.map((u) => u.id));

  // Un grupo se borra solo si CADA uno de sus miembros está en la lista a
  // borrar. Si alguien que se conserva sigue ahí, el grupo se queda intacto.
  const gruposConMiembros = await prisma.group.findMany({
    select: {
      id: true,
      name: true,
      members: { select: { userId: true } },
      _count: { select: { devices: true } },
    },
  });
  const gruposABorrar = gruposConMiembros.filter(
    (g) => g.members.length > 0 && g.members.every((m) => idsABorrar.has(m.userId))
  );

  console.log(`\n${ejecutar ? "Borrando" : "Se borrarían"} ${usuarios.length} cuenta(s):\n`);
  for (const u of usuarios) {
    console.log(
      `  - ${u.email}` +
        (u.isPlatformAdmin ? "  [admin de plataforma]" : "") +
        `  (${u._count.memberships} grupo/s, ${u._count.titularidades} botón/es)`
    );
  }

  if (conservados.length > 0) {
    console.log(`\nSe conservan ${conservados.length}:\n`);
    for (const u of conservados) {
      console.log(`  - ${u.email}` + (u.isPlatformAdmin ? "  [admin de plataforma]" : ""));
    }
  }

  console.log(`\nY los ${gruposABorrar.length} grupo(s) que se quedarían sin nadie:\n`);
  if (gruposABorrar.length === 0) console.log("  (ninguno)");
  for (const g of gruposABorrar) {
    console.log(`  - ${g.name}` + (g._count.devices > 0 ? `  (con ${g._count.devices} botón/es, se desvinculan)` : ""));
  }

  if (!ejecutar) {
    console.log("\nNada se tocó todavía. Repite con --si para ejecutarlo.\n");
    return;
  }

  // 1) Firebase Auth primero: si algo falla aquí, Postgres no se tocó y se
  // puede reintentar sin dejar cuentas a medio borrar.
  console.log("\nBorrando de Firebase Auth...");
  const resultado = await firebaseAuth.deleteUsers(usuarios.map((u) => u.firebaseUid));
  if (resultado.failureCount > 0) {
    console.error(`  ${resultado.failureCount} no se pudieron borrar de Firebase:`);
    for (const e of resultado.errors) console.error(`    - índice ${e.index}: ${e.error.message}`);
    console.error("  Postgres NO se tocó. Revisa el error y vuelve a correr el script.");
    process.exitCode = 1;
    return;
  }
  console.log(`  ${resultado.successCount} cuenta(s) borradas de Firebase.`);

  // 2) Postgres, en una sola transacción: desvincular los botones de los
  // grupos que van a desaparecer (mismo efecto que "Desvincular botón" en la
  // app), borrar esos grupos, y borrar los usuarios —el resto (membresías,
  // mensajes, notificaciones, tokens push, titularidades) cae en cascada por
  // el schema. Los grupos donde se quedó alguien no se tocan.
  console.log("Borrando de Postgres...");
  const idsGruposABorrar = gruposABorrar.map((g) => g.id);
  await prisma.$transaction([
    prisma.device.updateMany({
      where: { groupId: { in: idsGruposABorrar } },
      data: { groupId: null, ownerId: null, status: "OFFLINE" },
    }),
    prisma.group.deleteMany({ where: { id: { in: idsGruposABorrar } } }),
    prisma.user.deleteMany({ where: { id: { in: usuarios.map((u) => u.id) } } }),
  ]);

  // Los botones que se quedaron sin ningún titular vuelven a estar "en la
  // caja", igual que cuando una persona elimina su cuenta desde la app
  // (DELETE /auth/me): claimedAt en null. Con fecha y sin titulares es el
  // estado incoherente que ya nos mordió una vez.
  await prisma.device.updateMany({
    where: { holders: { none: {} }, claimedAt: { not: null } },
    data: { claimedAt: null, ownerId: null },
  });

  console.log("\nListo. Los dispositivos quedaron intactos y sin vincular donde hizo falta.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
