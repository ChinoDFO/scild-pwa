// Catálogo de tipos de alerta. Es la ÚNICA lista: la PWA la pide a
// GET /api/alerts/tipos para armar el menú, y cada alerta que devuelve el
// backend ya trae su etiqueta, emoji y teléfono. Para agregar, quitar o
// reordenar opciones basta con editar esto (no hay migración: Alert.type es
// String).
//
// GENERAL tiene que existir siempre: es el que usa el botón físico y el
// respaldo si en la base queda un tipo que ya se quitó del catálogo.
//
// `telefono`: a quién hay que marcar para esa emergencia, y sale en el aviso
// push (ver armarAviso en push.js). 911 es el número único nacional de
// emergencias en México desde 2017 (reemplazó al 066/089) y lo atiende todo
// — policía, bomberos, Cruz Roja, protección civil —, así que es el default
// para casi todo el catálogo. La única excepción es FALLA_ELECTRICA: ahí lo
// correcto es la línea de reportes de la CFE (071), con 911 aparte solo si
// hay peligro inmediato (un cable vivo, por ejemplo).
export const TELEFONO_DEFAULT = "911";

export const TIPOS_ALERTA = [
  { id: "GENERAL", etiqueta: "Emergencia", emoji: "🚨" },
  { id: "CARRO_SOSPECHOSO", etiqueta: "Carro sospechoso", emoji: "🚗" },
  { id: "PERSONA_SOSPECHOSA", etiqueta: "Personas sospechosas", emoji: "👤" },
  { id: "ROBO", etiqueta: "Robo o asalto", emoji: "🚔" },
  { id: "INCENDIO", etiqueta: "Incendio", emoji: "🔥" },
  { id: "EMERGENCIA_MEDICA", etiqueta: "Emergencia médica", emoji: "🚑" },
  { id: "ACCIDENTE_VIAL", etiqueta: "Accidente vial", emoji: "🚧" },
  { id: "FUGA_GAS", etiqueta: "Fuga de gas", emoji: "🧯" },
  { id: "INUNDACION", etiqueta: "Inundación", emoji: "🌊" },
  { id: "FALLA_ELECTRICA", etiqueta: "Falla eléctrica", emoji: "⚡", telefono: "071 (CFE) o 911 si hay peligro" },
  { id: "DISTURBIO", etiqueta: "Disturbio o pelea", emoji: "🥊" },
  { id: "VANDALISMO", etiqueta: "Vandalismo", emoji: "🔨" },
  { id: "ANIMAL_PELIGROSO", etiqueta: "Animal peligroso suelto", emoji: "🐕" },
  { id: "DESASTRE_NATURAL", etiqueta: "Desastre natural", emoji: "🌪️" },
].map((t) => ({ telefono: TELEFONO_DEFAULT, ...t }));

const PORID = new Map(TIPOS_ALERTA.map((t) => [t.id, t]));

export function esTipoValido(id) {
  return PORID.has(id);
}

export function tipoDeAlerta(id) {
  return PORID.get(id) ?? PORID.get("GENERAL");
}
