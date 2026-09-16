import { firebaseAuth } from "../firebaseAdmin.js";
import prisma from "../prisma.js";

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

  const user = await prisma.user.upsert({
    where: { firebaseUid: decoded.uid },
    update: { email: decoded.email },
    create: { firebaseUid: decoded.uid, email: decoded.email },
  });

  req.user = user;
  next();
}
