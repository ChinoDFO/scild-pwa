import prisma from "./prisma.js";
import { MAX_MIEMBROS_POR_GRUPO, ErrorDeAcceso } from "./acceso.js";

// Cuánta gente cabe en un grupo.
//
// El cupo es del GRUPO y lo edita su administrador (Group.maxMembers), con
// tope de 50. Antes salía de los botones: cada uno vinculado daba diez
// lugares y cada membresía apuntaba al botón que pagaba el suyo. Eso ataba el
// tamaño del grupo a cuántos aparatos había dentro, que son dos cosas sin
// relación — un coto con un solo botón puede necesitar veinte vecinos
// enterados, y un negocio con tres botones no necesita treinta empleados.

export function cupoValido(valor, miembrosActuales) {
  if (!Number.isInteger(valor)) return "El cupo tiene que ser un número entero";
  if (valor < 1) return "El cupo no puede ser menor que 1";
  if (valor > MAX_MIEMBROS_POR_GRUPO) {
    return `El cupo no puede pasar de ${MAX_MIEMBROS_POR_GRUPO} personas`;
  }
  // Bajarlo por debajo de los que ya están dentro dejaría al grupo en un
  // estado imposible; a nadie se le saca por editar un número.
  if (valor < miembrosActuales) {
    return `Ya hay ${miembrosActuales} personas en el grupo: el cupo no puede quedar por debajo`;
  }
  return null;
}

// Radiografía del cupo, para pintarla en la información del grupo.
export async function cuposDelGrupo(groupId) {
  const grupo = await prisma.group.findUnique({
    where: { id: groupId },
    select: { maxMembers: true, _count: { select: { members: true } } },
  });
  if (!grupo) return { total: 0, ocupados: 0, libres: 0 };

  const ocupados = grupo._count.members;
  return {
    total: grupo.maxMembers,
    ocupados,
    libres: Math.max(0, grupo.maxMembers - ocupados),
    tope: MAX_MIEMBROS_POR_GRUPO,
  };
}

// Aparta un lugar para alguien que va a entrar. Va DENTRO de la transacción
// que crea la membresía: si dos personas entran con el mismo código al mismo
// tiempo, las dos cuentan sobre el mismo estado y no se pasan del cupo.
export async function exigirLugar(tx, groupId) {
  const grupo = await tx.group.findUnique({
    where: { id: groupId },
    select: { maxMembers: true },
  });
  const dentro = await tx.groupMember.count({ where: { groupId } });

  if (dentro >= grupo.maxMembers) {
    throw new ErrorDeAcceso(
      409,
      `Este grupo ya está lleno (${dentro} de ${grupo.maxMembers}). Su administrador puede subir el cupo desde la información del grupo, hasta ${MAX_MIEMBROS_POR_GRUPO} personas.`
    );
  }
}
