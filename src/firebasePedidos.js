import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// La tienda (scild-web) guarda sus pedidos en OTRO proyecto de Firebase, no en
// el de la app de emergencia que usa firebaseAdmin.js. Por eso aquí se abre una
// segunda app con su propia cuenta de servicio. Se inicia hasta la primera vez
// que se necesita: si falta la llave, solo falla el envío de correos y el
// resto del backend (alertas, botones) arranca igual.
let dbPedidos = null;

export function obtenerDbPedidos() {
  if (dbPedidos) return dbPedidos;

  const ruta = process.env.PEDIDOS_FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!ruta || !existsSync(ruta)) {
    const err = new Error(
      "Falta la llave del proyecto de pedidos (PEDIDOS_FIREBASE_SERVICE_ACCOUNT_PATH)"
    );
    err.status = 503;
    throw err;
  }

  const cuenta = JSON.parse(readFileSync(ruta, "utf-8"));
  const app = initializeApp({ credential: cert(cuenta) }, "pedidos");
  dbPedidos = getFirestore(app);
  return dbPedidos;
}
