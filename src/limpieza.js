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
