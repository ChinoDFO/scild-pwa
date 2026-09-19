import { Server } from "socket.io";
import prisma from "./prisma.js";
import { buscarMembresia } from "./membership.js";
import { usuarioDesdeToken } from "./middleware/userAuth.js";
import { origenesPermitidos } from "./origenes.js";

// Canal en tiempo real con la PWA (Socket.IO). Solo EMPUJA avisos del
// servidor a los clientes: mensajes nuevos del chat y cambios en las alertas.
// Todo lo que el cliente quiere HACER (mandar un mensaje, disparar o resolver
// una alerta) sigue pasando por la API HTTP, que es donde viven la
// validación, los permisos y el rate limiting. Así no hay dos caminos que
// mantener en paralelo.

let io = null;

const sala = (groupId) => `grupo:${groupId}`;

export function iniciarTiempoReal(servidorHttp) {
  io = new Server(servidorHttp, { cors: { origin: origenesPermitidos } });

  // Mismo ID token de Firebase que la API. Se verifica al conectar (y en
  // cada reconexión, porque el cliente manda uno fresco).
  io.use(async (socket, next) => {
    try {
      socket.data.user = await usuarioDesdeToken(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error("Sesión inválida o expirada"));
    }
  });

  // Ojo: Socket.IO, como Express 4, NO atrapa promesas rechazadas en sus
  // handlers. Un error de la base aquí sin try/catch tumbaría el proceso
  // completo (con todo y /panic), así que cada handler async atrapa lo suyo.
  io.on("connection", async (socket) => {
    // Los handlers se registran ANTES de cualquier await: el cliente puede
    // emitir en cuanto se conecta, y un evento que llega sin handler se
    // pierde sin aviso.

    // Qué grupo trae abierto en pantalla. Sirve para no mandarle push de
    // chat a quien ya está leyendo esa conversación.
    socket.on("grupo:viendo", (groupId) => {
      socket.data.viendo = typeof groupId === "string" ? groupId : null;
    });

    // Para grupos a los que se unió DESPUÉS de conectarse. Se revisa la
    // membresía: nadie escucha la sala de un grupo ajeno.
    socket.on("grupo:entrar", async (groupId, responder) => {
      let esMiembro = null;
      try {
        esMiembro = await buscarMembresia(socket.data.user.id, groupId);
        if (esMiembro) socket.join(sala(groupId));
      } catch (e) {
        console.error("Error en grupo:entrar:", e);
      }
      if (typeof responder === "function") responder({ ok: Boolean(esMiembro) });
    });

    try {
      // Entra de una vez a las salas de todos sus grupos: así la lista de
      // alertas de Inicio se entera de cualquier grupo sin pedirlo.
      const membresias = await prisma.groupMember.findMany({
        where: { userId: socket.data.user.id },
        select: { groupId: true },
      });
      socket.join(membresias.map((m) => sala(m.groupId)));
    } catch (e) {
      console.error("No se pudieron cargar las salas del socket:", e);
      // La PWA reconecta sola al ver "io server disconnect".
      socket.disconnect();
    }
  });

  return io;
}

// Nunca lanza: si el tiempo real falla, la acción HTTP que lo provocó ya se
// hizo y los clientes se enteran con su refresco de respaldo.
export function emitirAGrupo(groupId, evento, datos) {
  try {
    io?.to(sala(groupId)).emit(evento, datos);
  } catch (e) {
    console.error(`No se pudo emitir ${evento} al grupo ${groupId}:`, e);
  }
}

// ¿Esta persona tiene ese grupo abierto en alguna de sus pantallas?
export function estaViendoGrupo(userId, groupId) {
  if (!io) return false;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user?.id === userId && socket.data.viendo === groupId) return true;
  }
  return false;
}
