// Catálogo de tipos de alerta. Es la ÚNICA lista: la PWA la pide a
// GET /api/alerts/tipos para armar el menú, y cada alerta que devuelve el
// backend ya trae su etiqueta y emoji. Para agregar, quitar o reordenar
// opciones basta con editar esto (no hay migración: Alert.type es String).
//
// GENERAL tiene que existir siempre: es el que usa el botón físico y el
// respaldo si en la base queda un tipo que ya se quitó del catálogo.
export const TIPOS_ALERTA = [
  { id: "GENERAL", etiqueta: "Emergencia", emoji: "🚨" },
  { id: "CARRO_SOSPECHOSO", etiqueta: "Carro sospechoso", emoji: "🚗" },
  { id: "PERSONA_SOSPECHOSA", etiqueta: "Personas sospechosas", emoji: "👤" },
  { id: "ROBO", etiqueta: "Robo o asalto", emoji: "🚔" },
  { id: "INCENDIO", etiqueta: "Incendio", emoji: "🔥" },
  { id: "EMERGENCIA_MEDICA", etiqueta: "Emergencia médica", emoji: "🚑" },
];

const PORID = new Map(TIPOS_ALERTA.map((t) => [t.id, t]));

export function esTipoValido(id) {
  return PORID.has(id);
}

export function tipoDeAlerta(id) {
  return PORID.get(id) ?? PORID.get("GENERAL");
}
