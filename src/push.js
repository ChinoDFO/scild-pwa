import { firebaseMessaging } from "./firebaseAdmin.js";
import prisma from "./prisma.js";
import { estaViendoGrupo } from "./realtime.js";
import { tipoDeAlerta } from "./tiposAlerta.js";

// Códigos con los que FCM avisa que un token ya no sirve: la PWA se
// desinstaló, el usuario revocó el permiso, o el token rotó. Esos se borran
// para no reintentar contra ellos en cada alerta.
const CODIGOS_TOKEN_MUERTO = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

// A dónde manda la notificación al tocarla. FRONTEND_ORIGIN puede traer
// varios orígenes separados por coma; el primero es el de producción.
const frontend = () => process.env.FRONTEND_ORIGIN?.split(",")[0] || "http://localhost:5173";

// --- Insistencia de las alertas ---------------------------------------------
// Una PWA no puede crear su propio canal de notificaciones en Android: el
// sonido, la vibración y el "No molestar" los decide el canal que Chrome usa
// para TODOS los sitios, y no hay manera de ponerle una sirena. Lo único que
// sí está en nuestras manos es repetir el aviso, igual que el botón físico
// cuando manda la alerta varias veces: con el mismo tag y renotify, cada
// repetición vuelve a sonar y a vibrar en lugar de apilarse en silencio.
//
// Se corta en cuanto alguien toca "Ya voy" o "Resuelta": si el grupo ya
// reaccionó, seguir insistiendo solo entrena a la gente a silenciar la app.
const RONDAS_DE_ALERTA = 3;
const ESPERA_ENTRE_RONDAS_MS = 4_000;
const VIBRACION_ALERTA = [300, 150, 300, 150, 300];

// Cada cuánto se insiste con una alerta activa que nadie ha atendido. 15 min:
// ni tan seguido que se vuelva ruido, ni tan espaciado que una emergencia real
// se sienta abandonada. La usan tanto el heartbeat del botón físico (devices.js,
// mientras siga atorado) como la revisión periódica de abajo (cualquier alerta
// GENERAL activa, tenga botón o no).
export const RECORDATORIO_SOSTENIDO_MS = 15 * 60 * 1000;

const esperar = (ms) => new Promise((seguir) => setTimeout(seguir, ms));

// El mensaje que se manda a FCM, idéntico en todas las rondas.
function mensajeDeAlerta(alerta, aviso, tokens) {
  return {
    tokens,
    notification: aviso,
    // Los valores de data tienen que ser strings; la PWA los usa para saber
    // a qué alerta corresponde el aviso que le llegó.
    data: {
      kind: "alerta",
      alertId: alerta.id,
      groupId: alerta.groupId,
      source: alerta.source,
      // Qué tipo de alerta es. La PWA lo usa para decidir si hace sonar la
      // sirena: solo el SOS y el botón físico (GENERAL) la merecen; un
      // "carro sospechoso" se avisa, pero sin ruido.
      type: alerta.type,
      createdAt: alerta.createdAt.toISOString(),
    },
    webpush: {
      notification: {
        // Un solo aviso visible por alerta: si llegan duplicados por varios
        // canales, el tag hace que se reemplacen en vez de apilarse.
        tag: `alerta-${alerta.id}`,
        // Y con renotify ese reemplazo vuelve a sonar. Es lo que convierte
        // las repeticiones en insistencia y no en un aviso mudo que cambia.
        renotify: true,
        // Una emergencia no se auto-descarta a los segundos.
        requireInteraction: true,
        // Android decide si la respeta (manda su canal), pero donde pega se
        // siente distinta de un mensaje del chat.
        vibrate: VIBRACION_ALERTA,
        // PNG: Android no muestra SVG en notificaciones.
        icon: "/pwa-192x192.png",
        // El ícono chiquito monocromo que Android pone en la barra de estado
        // ANTES de desplegar la notificación: se nota sin ni siquiera abrir
        // el centro de notificaciones.
        badge: "/pwa-192x192.png",
        // Atender desde la notificación: abre la app ya con la alerta
        // marcada como "voy en camino" (lo resuelve la pantalla del grupo).
        actions: [{ action: "atender", title: "Ya voy" }],
      },
      // Al tocar el aviso se abre el grupo de la alerta, no la pantalla de
      // inicio: en una emergencia nadie debería tener que buscar el grupo.
      fcmOptions: { link: `${frontend()}/grupos/${alerta.groupId}` },
      headers: { Urgency: "high" },
    },
  };
}

// El mensaje para los tokens nativos de la app de Android (ver
// android/.../AlertaMessagingService.java): puro "data", nunca
// "notification". Así Android siempre entrega el mensaje al código de la
// app en vez de dibujarlo solo — es lo que permite que el SOS suene con su
// propio canal (alarma + pantalla completa) en vez de compartir el canal
// único que Chrome usa para todo el sitio.
function mensajeAndroidNativo(alerta, aviso, tokens) {
  return {
    tokens,
    android: { priority: "high" },
    data: {
      kind: "alerta",
      alertId: alerta.id,
      groupId: alerta.groupId,
      source: alerta.source,
      type: alerta.type,
      createdAt: alerta.createdAt.toISOString(),
      titulo: aviso.title,
      cuerpo: aviso.body,
    },
  };
}

// Manda la alerta a TODOS los tokens (web y nativos de Android a la vez, con
// el formato que le toca a cada uno) y devuelve la lista de tokens y una
// respuesta combinada con la MISMA forma que da sendEachForMulticast — y en
// el MISMO ORDEN que `tokensConPlataforma`, aunque por dentro sean dos
// llamadas a FCM separadas: así el resto del código (marcar Notification
// como SENT/FAILED emparejando por índice, borrar tokens muertos) seguro
// sigue apuntando al token correcto sin tener que saber que se partió en dos.
async function mandarAlerta(alerta, aviso, tokensConPlataforma) {
  const indicesWeb = [];
  const indicesAndroid = [];
  tokensConPlataforma.forEach((t, i) => (t.platform === "ANDROID" ? indicesAndroid : indicesWeb).push(i));

  const tokensWeb = indicesWeb.map((i) => tokensConPlataforma[i].token);
  const tokensAndroid = indicesAndroid.map((i) => tokensConPlataforma[i].token);

  const [respWeb, respAndroid] = await Promise.all([
    tokensWeb.length > 0
      ? firebaseMessaging.sendEachForMulticast(mensajeDeAlerta(alerta, aviso, tokensWeb))
      : null,
    tokensAndroid.length > 0
      ? firebaseMessaging.sendEachForMulticast(mensajeAndroidNativo(alerta, aviso, tokensAndroid))
      : null,
  ]);

  const responses = new Array(tokensConPlataforma.length);
  indicesWeb.forEach((indiceOriginal, j) => (responses[indiceOriginal] = respWeb.responses[j]));
  indicesAndroid.forEach((indiceOriginal, j) => (responses[indiceOriginal] = respAndroid.responses[j]));

  return {
    tokens: tokensConPlataforma.map((t) => t.token),
    respuesta: {
      responses,
      successCount: (respWeb?.successCount ?? 0) + (respAndroid?.successCount ?? 0),
    },
  };
}

// Rondas 2 en adelante. Corre por su cuenta (nadie la espera) y revisa el
// estado de la alerta antes de cada una.
async function repetirAlerta(alerta, aviso, tokensConPlataforma) {
  for (let ronda = 2; ronda <= RONDAS_DE_ALERTA; ronda++) {
    await esperar(ESPERA_ENTRE_RONDAS_MS);

    const actual = await prisma.alert.findUnique({
      where: { id: alerta.id },
      select: { status: true },
    });
    if (actual?.status !== "ACTIVE") return ronda - 1;

    const { tokens, respuesta } = await mandarAlerta(alerta, aviso, tokensConPlataforma);
    await limpiarTokensMuertos(respuesta, tokens);
  }
  return RONDAS_DE_ALERTA;
}

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
// excluirUserIds: personas que ya reciben el aviso de esta misma emergencia por
// otro grupo. Cuando el botón físico avisa a varios grupos crea una alerta en
// cada uno; quien está en dos de ellos vería el mismo aviso y sonaría dos
// veces, así que a esa persona solo se le avisa por el primero (la alerta
// sigue apareciendo en el chat de los dos).
export async function crearNotificacionesPendientes(
  tx,
  { alertId, groupId, excluirUserId, excluirUserIds = [] }
) {
  const excluidos = [...excluirUserIds, ...(excluirUserId ? [excluirUserId] : [])];
  const miembros = await tx.groupMember.findMany({
    where: { groupId, ...(excluidos.length > 0 ? { userId: { notIn: excluidos } } : {}) },
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
  const tokensConPlataforma = [];
  const notificacionDeToken = [];
  for (const notificacion of alerta.notifications) {
    for (const push of notificacion.user.pushTokens) {
      tokensConPlataforma.push({ token: push.token, platform: push.platform });
      notificacionDeToken.push(notificacion.id);
    }
  }

  // Miembros sin ningún token (nunca activaron notificaciones, o entraron al
  // grupo desde una compu sin permiso) se quedan en PENDING: la alerta les
  // sigue apareciendo dentro de la app, no es un fallo de envío.
  if (tokensConPlataforma.length === 0) {
    return { tokens: 0, enviadas: 0, fallidas: 0, tokensBorrados: 0 };
  }

  const aviso = armarAviso(alerta);

  const { tokens, respuesta } = await mandarAlerta(alerta, aviso, tokensConPlataforma);

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

  // Las repeticiones van por su cuenta: quien llamó (el ESP32, la PWA) ya
  // tiene su resumen y no se queda esperando a que terminen las tres rondas.
  // Solo insiste el SOS/botón físico (GENERAL): un "carro sospechoso" avisa
  // una vez y ya, insistir en algo que no es una emergencia real solo enseña
  // a la gente a silenciar la app.
  const vivos = tokensConPlataforma.filter((t) => !tokensMuertos.includes(t.token));
  if (vivos.length > 0 && alerta.type === "GENERAL") {
    repetirAlerta(alerta, aviso, vivos).catch((e) =>
      console.error(`Fallaron las repeticiones de la alerta ${alertId}:`, e)
    );
  }

  return {
    tokens: tokens.length,
    enviadas: idsEntregadas.size,
    fallidas: idsFallidas.length,
    tokensBorrados: tokensMuertos.length,
  };
}

// El botón sigue presionado (es de los que hay que girar para destrabarlos)
// y nadie la ha atendido: se le vuelve a avisar a TODOS los que ya se le
// habían avisado, no solo a los que se quedaron en PENDING —a diferencia de
// enviarPushDeAlerta, aquí no importa si su aviso anterior ya se marcó
// SENT, este es un aviso nuevo—. Mismo tag+renotify de siempre, así que
// vuelve a sonar/vibrar sin que la PWA tenga que hacer nada distinto. No
// toca Notification: esa tabla es "se le avisó de esta alerta sí o no", y
// eso ya quedó resuelto la primera vez; esto es solo una repetición.
// Quien llama (el heartbeat del botón) no debe fallar porque esto falle.
export async function enviarRecordatorioDeAlertaSostenida(alertId) {
  const alerta = await prisma.alert.findUnique({
    where: { id: alertId },
    include: {
      group: { select: { name: true } },
      device: { select: { name: true, deviceCode: true } },
      createdBy: { select: { email: true, displayName: true } },
      notifications: { include: { user: { select: { pushTokens: true } } } },
    },
  });

  // Ya se atendió/resolvió entre heartbeats, o se borró: nada que insistir.
  if (!alerta || alerta.status !== "ACTIVE") {
    return { tokens: 0, enviados: 0 };
  }

  const tokensConPlataforma = alerta.notifications.flatMap((n) =>
    n.user.pushTokens.map((t) => ({ token: t.token, platform: t.platform }))
  );
  if (tokensConPlataforma.length === 0) {
    return { tokens: 0, enviados: 0 };
  }

  const aviso = armarAviso(alerta);
  const { tokens, respuesta } = await mandarAlerta(alerta, aviso, tokensConPlataforma);
  await limpiarTokensMuertos(respuesta, tokens);

  return { tokens: tokens.length, enviados: respuesta.successCount };
}

// Insiste con TODA alerta GENERAL activa que lleve 15+ min sin atenderse, sin
// importar si tiene botón físico o no.
//
// avisarSiSigueSostenido (devices.js) solo revisa, en cada heartbeat, las
// alertas de SU botón mientras siga físicamente atorado — un SOS mandado a
// mano desde la app no tiene aparato ni heartbeat que lo revise, así que sin
// esto se quedaba mudo para siempre después de las 3 rondas iniciales (~8s)
// aunque nadie lo hubiera atendido. Se llama sola cada minuto desde
// server.js; un botón que ya fue revisado por su propio heartbeat hace unos
// segundos simplemente se salta aquí (lastReminderAt todavía está reciente).
export async function revisarAlertasSinAtender() {
  const activas = await prisma.alert.findMany({
    where: { status: "ACTIVE", type: "GENERAL" },
    select: { id: true, createdAt: true, lastReminderAt: true },
  });

  for (const alerta of activas) {
    const ultimoAviso = (alerta.lastReminderAt ?? alerta.createdAt).getTime();
    if (Date.now() - ultimoAviso < RECORDATORIO_SOSTENIDO_MS) continue;

    await prisma.alert.update({ where: { id: alerta.id }, data: { lastReminderAt: new Date() } });

    enviarRecordatorioDeAlertaSostenida(alerta.id)
      .then((r) => console.log(`Recordatorio periódico de ${alerta.id}: ${r.enviados}/${r.tokens} entregados`))
      .catch((e) => console.error(`No se pudo mandar el recordatorio periódico de ${alerta.id}:`, e));
  }
}

// --- Avisos del chat ---------------------------------------------------------

const MAX_VISTA_PREVIA = 120;
// Más de esto y ya no tiene caso dar el número exacto.
const TOPE_SIN_LEER = 50;

// Borra de la base los tokens que FCM reportó como muertos.
async function limpiarTokensMuertos(respuesta, tokens) {
  const muertos = respuesta.responses
    .map((r, i) => (!r.success && CODIGOS_TOKEN_MUERTO.has(r.error?.code) ? tokens[i] : null))
    .filter(Boolean);
  if (muertos.length) await prisma.pushToken.deleteMany({ where: { token: { in: muertos } } });
  return muertos.length;
}

// El texto del aviso: con un solo mensaje sin leer se muestra el mensaje;
// con varios, cuántos son. El nombre de quien escribe va en el cuerpo porque
// el título lo ocupa el grupo.
export function cuerpoDeAvisoDeChat(sinLeer, mensaje) {
  if (sinLeer > 1) {
    return `${sinLeer >= TOPE_SIN_LEER ? `${TOPE_SIN_LEER}+` : sinLeer} mensajes nuevos`;
  }
  const recorte = mensaje.content.slice(0, MAX_VISTA_PREVIA);
  return `${mensaje.autor.nombre}: ${recorte}${mensaje.content.length > MAX_VISTA_PREVIA ? "…" : ""}`;
}

// Aviso de un mensaje nuevo del chat. A diferencia de una alerta:
//   - no despierta a quien ya trae el grupo abierto en pantalla;
//   - se agrupa por grupo (tag), así que varios mensajes seguidos no llenan
//     la pantalla de avisos: el último reemplaza al anterior;
//   - no lleva requireInteraction, para que se pueda descartar solo. Una
//     emergencia se tiene que ver distinta de un "ya voy para allá".
// Si la persona trae un solo mensaje sin leer se muestra el texto; si trae
// varios, "N mensajes nuevos".
export async function enviarPushDeMensaje(mensaje) {
  const { groupId } = mensaje;

  const [grupo, miembros, recientes] = await Promise.all([
    prisma.group.findUnique({ where: { id: groupId }, select: { name: true } }),
    prisma.groupMember.findMany({
      where: { groupId, userId: { not: mensaje.autor.id } },
      select: {
        userId: true,
        lastReadAt: true,
        user: { select: { pushTokens: { select: { token: true, platform: true } } } },
      },
    }),
    // Una sola consulta para calcular los no leídos de todos: los últimos
    // mensajes del grupo, y para cada quien se cuentan los posteriores a su
    // última lectura.
    prisma.message.findMany({
      where: { groupId },
      select: { userId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: TOPE_SIN_LEER,
    }),
  ]);

  // Se manda un solo multicast por cada texto distinto (normalmente dos: el
  // de quienes traen un mensaje sin leer y el de quienes traen varios).
  const porTexto = new Map();

  for (const miembro of miembros) {
    const tokensConPlataforma = miembro.user.pushTokens;
    if (tokensConPlataforma.length === 0) continue;
    if (estaViendoGrupo(miembro.userId, groupId)) continue;

    const sinLeer = recientes.filter(
      (m) => m.userId !== miembro.userId && m.createdAt > miembro.lastReadAt
    ).length;

    const body = cuerpoDeAvisoDeChat(sinLeer, mensaje);
    porTexto.set(body, [...(porTexto.get(body) ?? []), ...tokensConPlataforma]);
  }

  const titulo = grupo?.name ?? "Mensaje nuevo";
  const personas = [...porTexto.values()].reduce((n, t) => n + t.length, 0);
  let enviados = 0;
  for (const [body, tokensConPlataforma] of porTexto) {
    const web = tokensConPlataforma.filter((t) => t.platform !== "ANDROID").map((t) => t.token);
    const android = tokensConPlataforma.filter((t) => t.platform === "ANDROID").map((t) => t.token);

    const [respWeb, respAndroid] = await Promise.all([
      web.length > 0
        ? firebaseMessaging.sendEachForMulticast({
            tokens: web,
            notification: { title: titulo, body },
            data: { kind: "chat", groupId, messageId: mensaje.id },
            webpush: {
              notification: { tag: `chat-${groupId}`, icon: "/pwa-192x192.png" },
              fcmOptions: { link: `${frontend()}/grupos/${groupId}` },
              // Normal y no high: lo urgente es la alerta. Marcar todo como
              // urgente gasta batería y, peor, le quita significado a la palabra.
              headers: { Urgency: "normal" },
            },
          })
        : null,
      android.length > 0
        ? firebaseMessaging.sendEachForMulticast({
            tokens: android,
            android: { priority: "normal" },
            data: { kind: "chat", groupId, messageId: mensaje.id, titulo, cuerpo: body },
          })
        : null,
    ]);

    enviados += (respWeb?.successCount ?? 0) + (respAndroid?.successCount ?? 0);
    if (respWeb) await limpiarTokensMuertos(respWeb, web);
    if (respAndroid) await limpiarTokensMuertos(respAndroid, android);
  }

  return { textos: porTexto.size, tokens: personas, enviados };
}
