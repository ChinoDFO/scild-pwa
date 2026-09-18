// Orígenes a los que se les permite hablar con el backend desde el navegador.
// Lo usan tanto el CORS de Express como Socket.IO, que tiene el suyo aparte.
//
// En producción se fija FRONTEND_ORIGIN y solo esos orígenes pasan. Sin él
// (desarrollo) se acepta localhost en CUALQUIER puerto: Vite se brinca solo a
// 5174 si el 5173 está ocupado, y `vite preview` usa 4173; fijar un único
// puerto hacía que la app fallara con CORS sin que fuera obvio por qué.
export const origenesPermitidos = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(",")
  : [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/];
