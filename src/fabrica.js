import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import prisma from "./prisma.js";
import { generarClaimCode } from "./claimCode.js";

// Dar de alta un botón: lo que se hace al fabricarlo, antes de venderlo.
//
// Vive aquí y no dentro del script ni de la ruta porque se hace desde los dos
// lados —la terminal (`npm run device:create`) y el panel de administración—
// y son códigos de seguridad: si un día cambia cómo se generan, tiene que
// cambiar en un solo lugar.
//
// Cada botón nace con TRES códigos y es importante no confundirlos:
//
//   - deviceCode: el número de serie que le ponemos nosotros (BTN-003). Es
//     público, no abre nada por sí solo.
//   - deviceSecret: la contraseña del aparato. Va grabada en el ESP32 y en la
//     base queda SOLO su hash, así que se muestra una vez y nunca más.
//   - claimCode: el código impreso en la caja, con el que su dueño lo liga a
//     su cuenta desde la app.

export function generarDeviceSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

// El código de la caja es único; si por casualidad se repite, se reintenta.
export async function claimCodeLibre() {
  for (let intento = 0; intento < 5; intento++) {
    const codigo = generarClaimCode();
    if (!(await prisma.device.findUnique({ where: { claimCode: codigo } }))) return codigo;
  }
  throw new Error("No se pudo generar un código de vinculación único");
}

// Formato del número de serie. Se deja estrecho a propósito: es lo que se va a
// leer de una etiqueta y a teclear en un portal, así que nada de espacios,
// acentos ni minúsculas que se presten a dudas.
const FORMATO_DEVICE_CODE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

export function validarDeviceCode(deviceCode) {
  if (typeof deviceCode !== "string") return "Falta el código del botón";
  const limpio = deviceCode.trim().toUpperCase();
  if (!FORMATO_DEVICE_CODE.test(limpio)) {
    return "El código del botón lleva solo letras, números y guiones, de 3 a 40 caracteres (BTN-003). Se guarda en mayúsculas.";
  }
  return null;
}

// Da de alta el botón y devuelve sus códigos. El secreto sale de aquí en
// claro UNA vez —quien llame decide cómo mostrarlo— y en la base solo queda
// su hash.
export async function crearDispositivo({ deviceCode, nombre = null, groupId = null }) {
  const limpio = deviceCode.trim().toUpperCase();

  const yaExiste = await prisma.device.findUnique({ where: { deviceCode: limpio } });
  if (yaExiste) {
    const error = new Error(`Ya existe un botón con el código ${limpio}`);
    error.status = 409;
    throw error;
  }

  const secret = generarDeviceSecret();
  const [secretHash, claimCode] = await Promise.all([bcrypt.hash(secret, 12), claimCodeLibre()]);

  const device = await prisma.device.create({
    data: {
      deviceCode: limpio,
      name: nombre?.trim() || null,
      secretHash,
      claimCode,
      groupId,
      ownerId: null,
      claimedAt: groupId ? new Date() : null,
    },
  });

  return { device, secret, claimCode };
}

// Siguiente número libre de la serie, para no tener que ir a buscar en qué se
// quedó la producción. Solo mira los que siguen el patrón BTN-###.
export async function siguienteDeviceCode(prefijo = "BTN") {
  const devices = await prisma.device.findMany({
    where: { deviceCode: { startsWith: `${prefijo}-` } },
    select: { deviceCode: true },
  });

  const numeros = devices
    .map((d) => Number(d.deviceCode.slice(prefijo.length + 1)))
    .filter((n) => Number.isInteger(n));

  const siguiente = numeros.length > 0 ? Math.max(...numeros) + 1 : 1;
  return `${prefijo}-${String(siguiente).padStart(3, "0")}`;
}
