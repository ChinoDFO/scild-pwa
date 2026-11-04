// Mismo criterio en toda la app (push.js, routes/alerts.js, y su espejo del
// lado de la PWA en InfoGrupo.tsx): coordenadas si ya se capturaron, si no la
// dirección de texto, y null si no hay ninguna de las dos (grupo recién
// creado, todavía sin ubicación).
export function enlaceDeMapa(grupo) {
  if (grupo.latitude != null && grupo.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${grupo.latitude},${grupo.longitude}`;
  }
  if (grupo.address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(grupo.address)}`;
  }
  return null;
}
