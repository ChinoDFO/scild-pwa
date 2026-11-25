import prisma from "./prisma.js";

// Mismo criterio en toda la app (push.js, routes/alerts.js, y su espejo del
// lado de la PWA en InfoGrupo.tsx): coordenadas si ya se capturaron, si no la
// dirección de texto, y null si no hay ninguna de las dos (botón recién dado
// de alta, todavía sin ubicación capturada en "Configura tu botón").
export function enlaceDeMapa(boton) {
  if (!boton) return null;
  if (boton.latitude != null && boton.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${boton.latitude},${boton.longitude}`;
  }
  if (boton.address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(boton.address)}`;
  }
  return null;
}

// A qué ubicación apunta el "Ver ubicación" de una alerta: la del botón
// físico que la disparó, o si se mandó desde la app (sin aparato de por
// medio) la del botón más antiguo del que sea titular quien la generó — es
// su cuenta la que avisó, así que es su casa/negocio el que importa, no
// cualquier botón del grupo (que puede tener varios, cada uno en un lugar
// distinto). Sin ningún botón propio (invitado que nunca debería poder
// alertar, o cuenta ya borrada), no hay ubicación que mostrar.
export async function ubicacionDeAlerta(alerta) {
  if (alerta.device) return enlaceDeMapa(alerta.device);
  if (!alerta.createdById) return null;

  const titularidad = await prisma.deviceHolder.findFirst({
    where: { userId: alerta.createdById },
    orderBy: { createdAt: "asc" },
    select: { device: { select: { address: true, latitude: true, longitude: true } } },
  });
  return titularidad ? enlaceDeMapa(titularidad.device) : null;
}
