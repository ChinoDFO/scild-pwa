import prisma from "./prisma.js";
import {
  TELEFONO_DEFAULT,
  TIPOS_ALERTA,
  esTipoValido as esDelCatalogo,
  tipoDeAlerta as tipoDelCatalogo,
} from "./tiposAlerta.js";
import { PROTOCOLO_DEFAULT, protocoloDeAlerta } from "./protocolosAlerta.js";

// Cuántos tipos personalizados puede tener un grupo como máximo.
export const TOPE_PERSONALIZADOS = 3;
// Cuántos favoritos puede elegir el admin para que salgan primero en el menú.
export const TOPE_FAVORITOS = 6;

export function tiposPersonalizados(groupId) {
  return prisma.tipoAlertaPersonalizado.findMany({
    where: { groupId },
    orderBy: { createdAt: "asc" },
  });
}

// Catálogo fijo + personalizados del grupo, en ese orden y ya reordenados
// según los favoritos del grupo (favoritos primero, en el orden en que el
// admin los eligió; el resto detrás en su orden de catálogo).
export async function catalogoDelGrupo(groupId) {
  const [personalizados, grupo] = await Promise.all([
    tiposPersonalizados(groupId),
    prisma.group.findUnique({ where: { id: groupId }, select: { tiposFavoritos: true } }),
  ]);

  const todos = [
    ...TIPOS_ALERTA.map((t) => ({ ...t, personalizado: false, protocolo: protocoloDeAlerta(t.id) })),
    ...personalizados.map((t) => ({
      id: t.id,
      etiqueta: t.etiqueta,
      emoji: t.emoji,
      personalizado: true,
      // No hay forma de saber qué número o protocolo corresponde a una
      // alarma que inventó el admin: el default es la respuesta correcta
      // sin importar qué sea.
      telefono: TELEFONO_DEFAULT,
      protocolo: PROTOCOLO_DEFAULT,
    })),
  ];

  const favoritos = grupo?.tiposFavoritos ?? [];
  if (favoritos.length === 0) return todos;

  const porId = new Map(todos.map((t) => [t.id, t]));
  const favoritosResueltos = favoritos.map((id) => porId.get(id)).filter(Boolean);
  const idsFavoritos = new Set(favoritosResueltos.map((t) => t.id));
  const resto = todos.filter((t) => !idsFavoritos.has(t.id));

  return [...favoritosResueltos, ...resto];
}

export async function esTipoValidoParaGrupo(groupId, id) {
  if (esDelCatalogo(id)) return true;
  const existe = await prisma.tipoAlertaPersonalizado.findFirst({ where: { id, groupId } });
  return existe != null;
}

// Como tipoDeAlerta() del catálogo fijo, pero también busca entre los
// personalizados del grupo. Si no encuentra nada (el personalizado se borró
// después de usarse en una alerta vieja) cae en GENERAL, igual que el fijo.
export async function tipoDeAlertaParaGrupo(groupId, id) {
  const delCatalogo = tipoDelCatalogo(id);
  if (delCatalogo.id === id) {
    return { ...delCatalogo, personalizado: false, protocolo: protocoloDeAlerta(delCatalogo.id) };
  }

  const personalizado = await prisma.tipoAlertaPersonalizado.findFirst({ where: { id, groupId } });
  if (personalizado) {
    return {
      id: personalizado.id,
      etiqueta: personalizado.etiqueta,
      emoji: personalizado.emoji,
      personalizado: true,
      telefono: TELEFONO_DEFAULT,
      protocolo: PROTOCOLO_DEFAULT,
    };
  }

  const general = tipoDelCatalogo("GENERAL");
  return { ...general, personalizado: false, protocolo: protocoloDeAlerta(general.id) };
}

// Valida los datos de un tipo personalizado nuevo.
export function validarPersonalizado(body) {
  const { etiqueta, emoji } = body ?? {};
  if (typeof etiqueta !== "string" || etiqueta.trim().length === 0 || etiqueta.trim().length > 40) {
    return { error: "La alarma necesita un nombre (máximo 40 caracteres)" };
  }
  if (typeof emoji !== "string" || emoji.trim().length === 0 || emoji.trim().length > 8) {
    return { error: "Falta elegir un emoji para la alarma" };
  }
  return { data: { etiqueta: etiqueta.trim(), emoji: emoji.trim() } };
}
