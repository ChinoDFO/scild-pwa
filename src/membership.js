import prisma from "./prisma.js";

// Devuelve la membresía del usuario en el grupo, o null si no pertenece.
// Todo lo que un usuario ve o dispara de un grupo pasa por aquí primero: el
// id del grupo viene del cliente y no se puede confiar en él.
export function buscarMembresia(userId, groupId) {
  if (typeof groupId !== "string" || groupId.length === 0) return null;

  return prisma.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId } },
  });
}

// OFFLINE e IRREGULAR no los reporta el ESP32 (no puede avisar que se
// apagó): se deducen de cuánto tiempo lleva sin mandar heartbeat. Se calcula
// al leer en vez de guardarse, para no necesitar un proceso que lo revise.
export function estadoEfectivo(device, ahora = Date.now()) {
  if (device.status === "EMERGENCY" || device.status === "MAINTENANCE") {
    return device.status;
  }
  if (!device.lastSeenAt) return "OFFLINE";

  const segundosSinSenal = (ahora - device.lastSeenAt.getTime()) / 1000;
  const intervalo = device.heartbeatInterval || 60;

  if (segundosSinSenal > intervalo * 3) return "OFFLINE";
  if (segundosSinSenal > intervalo * 1.5) return "IRREGULAR";
  return "ONLINE";
}
