import "dotenv/config";
import nodemailer from "nodemailer";

// Envío de correos con una cuenta de Gmail (gratis, ~500 al día) usando una
// "contraseña de aplicación". Si GMAIL_USER / GMAIL_APP_PASSWORD no están
// puestas, no se manda nada: el correo se imprime en la consola del servidor
// para poder probar el flujo completo sin credenciales.

const usuario = process.env.GMAIL_USER;
const clave = process.env.GMAIL_APP_PASSWORD;
const configurado = Boolean(usuario && clave);

const transporte = configurado
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: usuario, pass: clave },
    })
  : null;

export const correoAdmin = process.env.CORREO_ADMIN || usuario || "";

export async function enviarCorreo({ para, asunto, texto, html }) {
  if (!transporte) {
    console.warn(
      `[correo] Gmail sin configurar: NO se envió a ${para}\n  Asunto: ${asunto}\n${texto}`
    );
    return { enviado: false, simulado: true };
  }

  await transporte.sendMail({
    from: `"SCILD" <${usuario}>`,
    to: para,
    subject: asunto,
    text: texto,
    html,
  });
  return { enviado: true, simulado: false };
}
