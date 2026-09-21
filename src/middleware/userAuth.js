import { Prisma } from "@prisma/client";
import { firebaseAuth } from "../firebaseAdmin.js";
import prisma from "../prisma.js";

// Cuando el correo ya está en la base pero con OTRA cuenta de Firebase.
// Tiene su clase para que el middleware lo pueda contestar como 409 y no se
// confunda con "se cayó la base".
export class CorreoYaRegistrado extends Error {
  constructor(email) {
    super(
      "Ese correo ya tiene datos en el sistema, creados con otra cuenta de acceso. " +
        "No se puede entrar así por seguridad: escríbenos para reconectarla."
    );
    this.status = 409;
    this.email = email;
  }
}

// Crea/actualiza la fila de Postgres del usuario de Firebase la primera vez
// que le habla al backend.
//
// El caso raro que hay que atrapar: la cuenta de Firebase se borró (desde la
// consola, por ejemplo) pero su fila de aquí se quedó, y la persona se
// registró otra vez con el mismo correo. Firebase le da un uid NUEVO, así que
// el upsert no encuentra la fila por firebaseUid, intenta crearla y choca con
// el @unique del correo. Sin atraparlo, ese P2002 sale como 500 en TODAS las
// rutas autenticadas —el middleware es el mismo para todas— y no hay manera
// de adivinar por qué.
//
// A propósito NO se reconecta sola la fila vieja al uid nuevo: el registro de
// Firebase no verifica el correo, así que cualquiera podría crear una cuenta
// con el correo de otro y heredar sus grupos, sus botones y sus alertas. Se
// reconecta a mano, con `npm run cuenta:revincular`, cuando se confirma que
// es la misma persona.
async function sincronizarUsuario(decoded) {
  try {
    return await prisma.user.upsert({
      where: { firebaseUid: decoded.uid },
      update: { email: decoded.email },
      create: { firebaseUid: decoded.uid, email: decoded.email },
    });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002" &&
      e.meta?.target?.includes("email")
    ) {
      console.error(
        `[cuenta] ${decoded.email} llegó con el uid ${decoded.uid}, pero ese correo ya existe en la base con otro uid. ` +
          `Revísalo con: npm run cuenta:revincular -- ${decoded.email}`
      );
      throw new CorreoYaRegistrado(decoded.email);
    }
    throw e;
  }
}

// Para la conexión de Socket.IO: verifica el token y devuelve el User. Lanza
// si el token no sirve.
export async function usuarioDesdeToken(idToken) {
  return sincronizarUsuario(await firebaseAuth.verifyIdToken(idToken));
}

// El registro y el login los maneja Firebase Auth en el cliente (propuesta,
// sección 5). Aquí solo se verifica el ID token que manda la PWA y se
// sincroniza/crea la fila correspondiente en Postgres la primera vez que
// ese usuario le habla al backend.
export async function userAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, idToken] = header.split(" ");

  if (scheme !== "Bearer" || !idToken) {
    return res.status(401).json({ error: "Falta el token de sesión" });
  }

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(idToken);
  } catch {
    return res.status(401).json({ error: "Sesión inválida o expirada" });
  }

  try {
    // Fuera del try de arriba: si falla la base, es un 500, no una sesión
    // inválida.
    req.user = await sincronizarUsuario(decoded);
  } catch (e) {
    if (e instanceof CorreoYaRegistrado) {
      return res.status(409).json({ error: e.message });
    }
    throw e;
  }
  next();
}
