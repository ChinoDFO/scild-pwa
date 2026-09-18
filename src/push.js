import { firebaseMessaging } from "./firebaseAdmin.js";
import prisma from "./prisma.js";
import { tipoDeAlerta } from "./tiposAlerta.js";

// Códigos con los que FCM avisa que un token ya no sirve: la PWA se
// desinstaló, el usuario revocó el permiso, o el token rotó. Esos se borran
// para no reintentar contra ellos en cada alerta.
const CODIGOS_TOKEN_MUERTO = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

// Al enviar, una alerta se ve así en la pantalla del celular. El título dice
// QUÉ pasa (tipo) y el cuerpo quién/dónde, para entenderla sin abrir la app.
function armarAviso(alerta) {
  const tipo = tipoDeAlerta(alerta.type);
  const nombreGrupo = alerta.group.name;
  const title = `${tipo.emoji} ${tipo.etiqueta}`;

  if (alerta.source === "DEVICE") {
    const boton = alerta.device?.name || alerta.device?.deviceCode || "el botón";
    return { title, body: `Se presionó ${boton} en ${nombreGrupo}` };
  }

  const quien = alerta.createdBy?.displayName || alerta.createdBy?.email;
  const que = tipo.id === "GENERAL" ? "una emergencia" : tipo.etiqueta.toLowerCase();
  return {
    title,
    body: quien ? `${quien} reportó ${que} en ${nombreGrupo}` : `Alerta en ${nombreGrupo}: ${que}`,
  };
}

// Crea una Notification PENDING por cada miembro del grupo. Se llama DENTRO
// de la misma transacción que crea la Alert, a propósito: así queda registro
// durable de a quién había que avisar incluso si FCM falla después, y el
// envío puede reintentarse leyendo las que quedaron en PENDING.
// excluirUserId: en una alerta manual, quien la generó no necesita aviso.
export async function crearNotificacionesPendientes(tx, { alertId, groupId, excluirUserId }) {
  const miembros = await tx.groupMember.findMany({
    where: { groupId, ...(excluirUserId ? { userId: { not: excluirUserId } } : {}) },
    select: { userId: true },
  });

  if (miembros.length === 0) return 0;

  await tx.notification.createMany({
    data: miembros.map((m) => ({ alertId, userId: m.userId })),
  });

  return miembros.length;
}

// Manda el push a todos los tokens de los miembros que tengan la alerta
// PENDING y actualiza el estado de cada Notification según el resultado.
// No lanza: el llamador (el ESP32 vía /panic) ya recibió su confirmación y
// no debe fallar porque FCM esté caído. Devuelve un resumen para el log.
export async function enviarPushDeAlerta(alertId) {
  const alerta = await prisma.alert.findUnique({
    where: { id: alertId },
    include: {
      group: { select: { name: true } },
      device: { select: { name: true, deviceCode: true } },
      createdBy: { select: { email: true, displayName: true } },
      notifications: {
        where: { status: "PENDING" },
        include: { user: { select: { id: true, pushTokens: true } } },
      },
    },
  });

  if (!alerta) {
    return { tokens: 0, enviadas: 0, fallidas: 0, tokensBorrados: 0 };
  }

  // Un usuario puede tener varios navegadores, así que se manda a todos sus
  // tokens y se recuerda a qué Notification corresponde cada uno para poder
  // marcar el estado después.
  const tokens = [];
  const notificacionDeToken = [];
  for (const notificacion of alerta.notifications) {
    for (const push of notificacion.user.pushTokens) {
      tokens.push(push.token);
      notificacionDeToken.push(notificacion.id);
    }
  }

  // Miembros sin ningún token (nunca activaron notificaciones, o entraron al
  // grupo desde una compu sin permiso) se quedan en PENDING: la alerta les
  // sigue apareciendo dentro de la app, no es un fallo de envío.
  if (tokens.length === 0) {
    return { tokens: 0, enviadas: 0, fallidas: 0, tokensBorrados: 0 };
  }

  const aviso = armarAviso(alerta);

  const respuesta = await firebaseMessaging.sendEachForMulticast({
    tokens,
    notification: aviso,
    // Los valores de data tienen que ser strings; la PWA los usa para saber
    // a qué alerta corresponde el aviso que le llegó.
    data: {
      alertId: alerta.id,
      groupId: alerta.groupId,
      source: alerta.source,
      createdAt: alerta.createdAt.toISOString(),
    },
    webpush: {
      notification: {
        // Un solo aviso visible por alerta: si llegan duplicados por varios
        // canales, el tag hace que se reemplacen en vez de apilarse.
        tag: `alerta-${alerta.id}`,
        // Una emergencia no se auto-descarta a los segundos.
        requireInteraction: true,
        // PNG: Android no muestra SVG en notificaciones.
        icon: "/pwa-192x192.png",
      },
      // Al tocar el aviso se abre la PWA en vez de una pestaña en blanco.
      fcmOptions: { link: process.env.FRONTEND_ORIGIN?.split(",")[0] || "http://localhost:5173" },
      headers: { Urgency: "high" },
    },
  });

  const idsEntregadas = new Set();
  const idsConFallo = new Set();
  const tokensMuertos = [];

  respuesta.responses.forEach((resultado, i) => {
    if (resultado.success) {
      idsEntregadas.add(notificacionDeToken[i]);
      return;
    }

    idsConFallo.add(notificacionDeToken[i]);
    if (CODIGOS_TOKEN_MUERTO.has(resultado.error?.code)) {
      tokensMuertos.push(tokens[i]);
    } else {
      console.error(
        `FCM falló para un token de la alerta ${alertId}:`,
        resultado.error?.code ?? resultado.error
      );
    }
  });

  // Si al menos un dispositivo del usuario recibió el aviso, cuenta como
  // enviada. FAILED se reserva para cuando ninguno de sus tokens funcionó.
  const idsFallidas = [...idsConFallo].filter((id) => !idsEntregadas.has(id));

  await prisma.$transaction([
    prisma.notification.updateMany({
      where: { id: { in: [...idsEntregadas] } },
      data: { status: "SENT", sentAt: new Date() },
    }),
    prisma.notification.updateMany({
      where: { id: { in: idsFallidas } },
      data: { status: "FAILED" },
    }),
    prisma.pushToken.deleteMany({ where: { token: { in: tokensMuertos } } }),
  ]);

  return {
    tokens: tokens.length,
    enviadas: idsEntregadas.size,
    fallidas: idsFallidas.length,
    tokensBorrados: tokensMuertos.length,
  };
}
