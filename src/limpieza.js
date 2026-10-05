import prisma from "./prisma.js";

// Borra los grupos sin nadie adentro.
//
// En el uso normal de la app esto NUNCA hace falta: salir del grupo y
// eliminar la cuenta ya borran el grupo en el mismo momento en que se
// quedaría sin su último miembro (ver DELETE /groups/:id/members/me y
// DELETE /auth/me). Un grupo con 0 miembros no debería poder existir.
//
// Donde SÍ puede aparecer uno es fuera de esos caminos: un ajuste manual en
// la base, un script de pruebas, o —el caso real— borrar cuentas
// directamente en vez de una por una desde la app (ver scripts/wipeCuentas.js).
// Esta función es la red de seguridad para esos casos.
//
// La misma regla que ya tienen esos dos endpoints: un grupo con botones
// vinculados NO se borra solo, aunque esté vacío. El aparato es físico y
// sigue existiendo; desvincularlo es una decisión aparte, no un efecto
// secundario de una limpieza.
export async function borrarGruposVacios() {
  const vacios = await prisma.group.findMany({
    where: { members: { none: {} } },
    select: { id: true, name: true, _count: { select: { devices: true } } },
  });

  const borrables = vacios.filter((g) => g._count.devices === 0);
  const conBotones = vacios.filter((g) => g._count.devices > 0);

  if (borrables.length > 0) {
    await prisma.group.deleteMany({ where: { id: { in: borrables.map((g) => g.id) } } });
  }

  return { borrados: borrables, conservados: conBotones };
}

// Borra los mensajes de chat más viejos que RETENCION_MENSAJES_DIAS.
//
// Esto NO toca el historial de alertas: Alert y AuditLog son tablas aparte
// (ver schema.prisma) y se quedan para siempre a propósito —es lo que
// permite reconstruir qué pasó en una emergencia—. Lo que se borra es
// plática común y corriente que ya nadie va a leer.
//
// Lo que de verdad ahorra esto es espacio en la base (Neon, plan gratis, con
// tope de almacenamiento), no RAM del servidor: el backend nunca carga el
// historial completo de un grupo a memoria, solo pide páginas chicas cuando
// alguien abre el chat.
const RETENCION_MENSAJES_DIAS = 90;

export async function borrarMensajesViejos() {
  const limite = new Date(Date.now() - RETENCION_MENSAJES_DIAS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.message.deleteMany({ where: { createdAt: { lt: limite } } });
  return { borrados: count, limite };
}
