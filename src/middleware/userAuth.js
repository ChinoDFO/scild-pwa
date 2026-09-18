import { firebaseAuth } from "../firebaseAdmin.js";
import prisma from "../prisma.js";

// Crea/actualiza la fila de Postgres del usuario de Firebase la primera vez
// que le habla al backend.
function sincronizarUsuario(decoded) {
  return prisma.user.upsert({
    where: { firebaseUid: decoded.uid },
    update: { email: decoded.email },
    create: { firebaseUid: decoded.uid, email: decoded.email },
  });
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

  // Fuera del try: si falla la base, es un 500, no una sesión inválida.
  req.user = await sincronizarUsuario(decoded);
  next();
}
