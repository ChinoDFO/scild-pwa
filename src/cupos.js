import prisma from "./prisma.js";
import { LUGARES_POR_BOTON } from "./acceso.js";

// Cuánta gente cabe en un grupo.
//
// La regla del producto: cada botón vinculado al grupo da cupo para diez
// personas. Un grupo con un botón llega a diez; para meter más, alguien más
// con su propio botón tiene que unirse, y ese botón trae sus diez.
//
// Por eso cada membresía guarda de qué botón sale su lugar (seatDeviceId):
// sin eso no se podría saber cuántos le quedan a cada quien. El lugar se le
// carga al botón con espacio más antiguo del grupo — no a quien invitó,
// porque el código de invitación es uno solo para todo el grupo y no dice
// quién lo compartió. El cupo total sale igual; lo que cambia es a cuál de
// los botones se le apunta cada persona cuando hay varios.

// Radiografía del cupo de un grupo, botón por botón.
export async function cuposDelGrupo(groupId) {
  const [botones, porBoton, miembros] = await Promise.all([
    prisma.device.findMany({
      where: { groupId },
      select: { id: true, name: true, deviceCode: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.groupMember.groupBy({ by: ["seatDeviceId"], where: { groupId }, _count: true }),
    prisma.groupMember.count({ where: { groupId } }),
  ]);

  const usados = new Map(porBoton.map((f) => [f.seatDeviceId, f._count]));

  const detalle = botones.map((b) => {
    const ocupados = usados.get(b.id) ?? 0;
    return {
      deviceId: b.id,
      nombre: b.name || b.deviceCode,
      ocupados,
      libres: Math.max(0, LUGARES_POR_BOTON - ocupados),
    };
  });

  return {
    total: botones.length * LUGARES_POR_BOTON,
    ocupados: miembros,
    libres: detalle.reduce((n, b) => n + b.libres, 0),
    // Membresías que quedaron sin botón que las respalde: el grupo todavía no
    // tiene botón, o el suyo se desvinculó. No se saca a nadie por esto; solo
    // deja de haber lugares libres hasta que entre un botón.
    sinRespaldo: usados.get(null) ?? 0,
    porBoton: detalle,
  };
}

// Aparta un lugar para alguien que va a entrar al grupo. Devuelve el id del
// botón que lo paga, o null si ya no hay campo.
//
// Va dentro de la transacción que crea la membresía: si dos personas entran
// con el mismo código al mismo tiempo, las dos cuentan sobre el mismo estado.
export async function apartarLugar(tx, groupId) {
  const [botones, porBoton] = await Promise.all([
    tx.device.findMany({ where: { groupId }, select: { id: true }, orderBy: { createdAt: "asc" } }),
    tx.groupMember.groupBy({ by: ["seatDeviceId"], where: { groupId }, _count: true }),
  ]);

  const usados = new Map(porBoton.map((f) => [f.seatDeviceId, f._count]));
  const conEspacio = botones.find((b) => (usados.get(b.id) ?? 0) < LUGARES_POR_BOTON);

  return conEspacio?.id ?? null;
}

// Al vincular un botón a un grupo, sus lugares recogen a quienes estaban sin
// respaldo: quien creó el grupo antes de vincular el botón, y los miembros
// que se quedaron sueltos cuando otro botón se desvinculó.
export async function respaldarMiembrosSueltos(tx, groupId, deviceId) {
  const sueltos = await tx.groupMember.findMany({
    where: { groupId, seatDeviceId: null },
    select: { id: true },
    orderBy: { joinedAt: "asc" },
    take: LUGARES_POR_BOTON,
  });

  if (sueltos.length === 0) return 0;

  await tx.groupMember.updateMany({
    where: { id: { in: sueltos.map((m) => m.id) } },
    data: { seatDeviceId: deviceId },
  });

  return sueltos.length;
}
