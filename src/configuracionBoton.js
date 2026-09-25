import prisma from "./prisma.js";

// Configuración del botón físico QUE SE MANDA DESDE LA APP.
//
// Hasta ahora esto se hacía levantando el portal WiFi del aparato
// ("ALARMA-CONFIG" en 192.168.4.1): había que ir a donde está el botón,
// conectarse a su red y llenar un formulario. Ahora el ESP32 baja sus
// ajustes en la respuesta del heartbeat y los guarda en su memoria, así que
// se configuran desde el celular, desde donde sea.
//
// Lo que NO se puede mandar por aquí es la red WiFi PRINCIPAL: para recibir
// esto el aparato ya tiene que estar conectado. Esa sigue siendo la primera
// configuración en el portal, y es la única. La red de RESPALDO sí, porque se
// aplica cuando la principal se cae.
//
// Llave/valor (DeviceConfiguration) en vez de columnas: el firmware va a
// ganar ajustes y ninguno debería costar una migración.

// Tope del intervalo de heartbeat. Menos de 30s inunda al servidor con
// aparatos de batería; más de una hora hace que "sin señal" tarde demasiado
// en notarse (OFFLINE se deduce con 3 intervalos sin reportar).
export const HEARTBEAT_MIN = 30;
export const HEARTBEAT_MAX = 3600;

// Segundos que el botón ignora pulsaciones después de una alerta. Sirve
// contra el rebote y contra el "por si no llegó" de quien lo presiona diez
// veces; pasado el tope deja de ser cooldown y es un botón que no responde.
export const COOLDOWN_MIN = 5;
export const COOLDOWN_MAX = 300;

// Lo que entiende el firmware v8. Cada llave dice cómo se valida y si se le
// puede devolver a la app (la contraseña del WiFi no: entra y no sale).
const LLAVES = {
  cooldownSegundos: {
    tipo: "entero",
    min: COOLDOWN_MIN,
    max: COOLDOWN_MAX,
    error: `El cooldown va de ${COOLDOWN_MIN} a ${COOLDOWN_MAX} segundos`,
  },
  ssidRespaldo: {
    tipo: "texto",
    // 32 caracteres es el máximo de un SSID (802.11).
    max: 32,
    error: "El nombre de la red de respaldo puede tener máximo 32 caracteres",
  },
  passRespaldo: {
    tipo: "texto",
    // 63 es el máximo de una contraseña WPA2-PSK.
    max: 63,
    error: "La contraseña de la red de respaldo puede tener máximo 63 caracteres",
    // La app nunca la vuelve a ver: solo se sabe si está puesta o no. Viaja
    // al aparato por HTTPS y se guarda en la base para poder reenviársela
    // cuando se reinicie.
    secreta: true,
  },
};

export const LLAVES_VALIDAS = Object.keys(LLAVES);

// Valida un conjunto de ajustes que viene de la app. Devuelve
// { error } o { cambios: [{ key, value }] }; un valor vacío borra la llave
// (se representa con value "" y así se manda al aparato).
export function validarConfiguracion(body) {
  const cambios = [];

  for (const [key, valor] of Object.entries(body ?? {})) {
    const regla = LLAVES[key];
    if (!regla) continue; // llaves desconocidas se ignoran, no se rechazan

    if (valor === null || valor === "") {
      cambios.push({ key, value: "" });
      continue;
    }

    if (regla.tipo === "entero") {
      const n = Number(valor);
      if (!Number.isInteger(n) || n < regla.min || n > regla.max) {
        return { error: regla.error };
      }
      cambios.push({ key, value: String(n) });
      continue;
    }

    if (typeof valor !== "string" || valor.length > regla.max) {
      return { error: regla.error };
    }
    cambios.push({ key, value: valor });
  }

  return { cambios };
}

// Lo que la APP puede leer: los valores actuales, con las llaves secretas
// reducidas a "está puesta o no".
export function paraLaApp(filas) {
  const config = {};
  for (const key of LLAVES_VALIDAS) {
    const fila = filas.find((f) => f.key === key);
    if (LLAVES[key].secreta) {
      config[key] = null;
      config[`${key}Puesta`] = Boolean(fila?.value);
    } else if (LLAVES[key].tipo === "entero") {
      // Se guarda como texto (la tabla es llave/valor) pero a la app le sirve
      // como número: es lo que va en un <input type="number">.
      config[key] = fila ? Number(fila.value) : null;
    } else {
      config[key] = fila?.value ?? null;
    }
  }
  return config;
}

// Huella del contenido de la configuración (FNV-1a de 31 bits).
//
// Es la "versión" que el aparato guarda para saber si lo que le llega es algo
// nuevo o lo mismo de siempre. Se calcula del CONTENIDO y no de una fecha a
// propósito: Device.updatedAt cambia en cada heartbeat —porque se guarda
// lastSeenAt— así que con fechas la configuración se vería nueva cada vez y
// el ESP32 reescribiría su memoria flash cada pocos minutos, sin que nadie
// hubiera cambiado nada.
//
// 31 bits y no 32 para que quepa en el `long` con signo del firmware.
function huella(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h & 0x7fffffff;
}

// Lo que el BOTÓN baja en el heartbeat. Va todo junto —incluida la
// contraseña de la red de respaldo— porque el aparato lo guarda en su
// memoria y tiene que poder reconstruirlo completo tras un reinicio.
export async function configuracionParaElBoton(deviceId) {
  const [device, filas] = await Promise.all([
    prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        name: true,
        deviceCode: true,
        heartbeatInterval: true,
        group: { select: { name: true, address: true } },
      },
    }),
    prisma.deviceConfiguration.findMany({ where: { deviceId } }),
  ]);

  if (!device) return null;

  const valor = (key) => filas.find((f) => f.key === key)?.value ?? "";

  const config = {
    // El aparato lo enseña por el puerto serie y lo usa como título de su
    // portal; el nombre del establecimiento es el del grupo donde está
    // vinculado, igual que en la app.
    nombre: device.group?.name || device.name || device.deviceCode,
    direccion: device.group?.address ?? "",
    heartbeatSegundos: device.heartbeatInterval,
    cooldownSegundos: Number(valor("cooldownSegundos")) || 10,
    ssidRespaldo: valor("ssidRespaldo"),
    passRespaldo: valor("passRespaldo"),
  };

  return { version: huella(JSON.stringify(config)), ...config };
}
