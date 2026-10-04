import "dotenv/config";
import nodemailer from "nodemailer";

// Envío de correos. Hay tres modos, en este orden de prioridad:
//
// 1. RELAY (CORREO_RELAY_URL + CORREO_RELAY_TOKEN): se le pide a un Google
//    Apps Script, por HTTPS, que mande el correo desde la cuenta de Gmail que
//    lo creó (ver scripts/correo-relay.gs). Es gratis y funciona en Render
//    gratis, que BLOQUEA los puertos SMTP (25, 465 y 587).
// 2. SMTP directo con Gmail (GMAIL_USER + GMAIL_APP_PASSWORD): lo más simple,
//    pero necesita salida por el puerto 465: sirve en tu computadora y en
//    hosting de pago, no en Render gratis.
// 3. Sin nada configurado no se manda nada: el correo se imprime en la
//    consola del servidor (para probar el flujo sin credenciales).

const relayUrl = process.env.CORREO_RELAY_URL;
const relayToken = process.env.CORREO_RELAY_TOKEN;
const usuario = process.env.GMAIL_USER;
const clave = process.env.GMAIL_APP_PASSWORD;

const transporte =
  usuario && clave
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: usuario, pass: clave },
      })
    : null;

export const modoCorreo = relayUrl && relayToken ? "relay" : transporte ? "smtp" : "simulado";

export const correoAdmin = process.env.CORREO_ADMIN || usuario || "";

async function enviarPorRelay({ para, asunto, texto, html }) {
  // Apps Script contesta con una redirección a donde está la respuesta
  // real; fetch la sigue sola.
  const respuesta = await fetch(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: relayToken, para, asunto, texto, html }),
    signal: AbortSignal.timeout(30_000),
  });

  const crudo = await respuesta.text();
  let datos = null;
  try {
    datos = JSON.parse(crudo);
  } catch {
    // no era JSON: casi seguro es una página de Google (login o error)
  }

  if (respuesta.ok && datos?.ok) return;
  if (datos?.error) throw new Error(`El relay de correo respondió: ${datos.error}`);

  let pista;
  if (respuesta.status === 401 || respuesta.status === 403) {
    pista =
      'Google está pidiendo iniciar sesión: en la implementación de Apps Script, "Quién tiene acceso" ' +
      'debe ser "Cualquier persona" y "Ejecutar como" debe ser "Yo".';
  } else if (/doPost/i.test(crudo)) {
    pista =
      "Al script de Apps Script le falta la función doPost: pega el código completo de " +
      "scripts/correo-relay.gs y publica una versión nueva de la implementación.";
  } else {
    pista =
      "Revisa que la URL sea la de la implementación (termina en /exec) y que hayas publicado " +
      "una versión nueva después de cambiar el código.";
  }
  throw new Error(`El relay de correo no contestó lo esperado (HTTP ${respuesta.status}). ${pista}`);
}

export async function enviarCorreo({ para, asunto, texto, html }) {
  if (modoCorreo === "relay") {
    await enviarPorRelay({ para, asunto, texto, html });
    return { enviado: true, simulado: false };
  }

  if (modoCorreo === "smtp") {
    await transporte.sendMail({
      from: `"SCILD" <${usuario}>`,
      to: para,
      subject: asunto,
      text: texto,
      html,
    });
    return { enviado: true, simulado: false };
  }

  console.warn(
    `[correo] Sin relay ni Gmail configurados: NO se envió a ${para}\n  Asunto: ${asunto}\n${texto}`
  );
  return { enviado: false, simulado: true };
}
