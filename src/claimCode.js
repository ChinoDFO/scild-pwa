import crypto from "node:crypto";

// Código de vinculación: el que va impreso en la caja del botón y que su
// dueño captura en la app para ligarlo a su grupo. Se escribe a mano desde un
// papel, así que el alfabeto no trae caracteres que se confundan (sin I, L,
// O, 0 ni 1) y se muestra en bloques de tres.
//
// NO cambia al desvincular el botón: el papel de la caja tiene que seguir
// sirviendo. Lo que dice si está libre u ocupado es Device.claimedAt.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LARGO = 9;

export function generarClaimCode() {
  const bytes = crypto.randomBytes(LARGO);
  let codigo = "";
  for (const b of bytes) codigo += ALFABETO[b % ALFABETO.length];
  return codigo;
}

// Lo que teclea la persona ("scild 7f3k 2m9", "7F3K-2M9…") se limpia antes de
// buscarlo: sin espacios ni guiones, en mayúsculas y sin el prefijo de marca.
export function normalizarClaimCode(entrada) {
  if (typeof entrada !== "string") return null;
  const limpio = entrada
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^SCILD/, "");
  return limpio.length === LARGO ? limpio : null;
}

// Como se imprime en la caja: SCILD-7F3K-2M9 → aquí 7F3 K2M 9XX en bloques.
export function formatearClaimCode(codigo) {
  return codigo ? codigo.replace(/(.{3})(?=.)/g, "$1-") : codigo;
}
