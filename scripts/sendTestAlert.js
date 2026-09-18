// Manda una alerta REAL de prueba a todos los miembros de un grupo, por el
// mismo camino que /panic (crea la Alert, las Notification PENDING y envía el
// push por FCM). Sirve para probar que el aviso llega sin tener el ESP32.
//
// Uso: npm run alert:test -- "Abarrotes Flores" [TIPO]
//   TIPO es uno de src/tiposAlerta.js (INCENDIO, CARRO_SOSPECHOSO, ...);
//   si no se pone, GENERAL.
//
// La alerta queda ACTIVE a propósito, para probar "Ya voy" / "Marcar
// resuelta" desde la app. Ojo: le llega a TODOS los miembros del grupo.

import "dotenv/config";
import prisma from "../src/prisma.js";
import { crearNotificacionesPendientes, enviarPushDeAlerta } from "../src/push.js";
import { TIPOS_ALERTA, esTipoValido } from "../src/tiposAlerta.js";

async function main() {
  const [, , groupName, type = "GENERAL"] = process.argv;

  if (!groupName) {
    console.error('Uso: npm run alert:test -- "<nombre del grupo>" [TIPO]');
    process.exit(1);
  }

  if (!esTipoValido(type)) {
    console.error(`Tipo desconocido. Opciones: ${TIPOS_ALERTA.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }

  const grupo = await prisma.group.findFirst({
    where: { name: groupName },
    include: { members: { include: { user: { select: { email: true } } } } },
  });

  if (!grupo) {
    const nombres = await prisma.group.findMany({ select: { name: true } });
    console.error(`No existe el grupo "${groupName}". Grupos: ${nombres.map((g) => g.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`Avisando a: ${grupo.members.map((m) => m.user.email).join(", ")}`);

  const alerta = await prisma.$transaction(async (tx) => {
    const creada = await tx.alert.create({
      data: { groupId: grupo.id, source: "APP", type, status: "ACTIVE" },
    });
    await crearNotificacionesPendientes(tx, { alertId: creada.id, groupId: grupo.id });
    return creada;
  });

  const resumen = await enviarPushDeAlerta(alerta.id);
  console.log(`Alerta ${alerta.id}:`, resumen);

  if (resumen.tokens === 0) {
    console.log("Nadie del grupo tiene notificaciones activadas: la alerta solo se verá dentro de la app.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
