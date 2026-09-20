import "dotenv/config";
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";
import { getStorage } from "firebase-admin/storage";

const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./firebase-service-account.json";

const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));

// Dónde se guardan los comprobantes de pago. Es el mismo valor que la PWA
// trae en VITE_FIREBASE_STORAGE_BUCKET (Firebase Console → Storage). Si no
// se configura, se intenta el nombre por defecto del proyecto, que en
// proyectos nuevos es <id>.firebasestorage.app y en los viejos
// <id>.appspot.com: por eso conviene ponerlo explícito en el .env.
const storageBucket =
  process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.firebasestorage.app`;

const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  storageBucket,
});

export const firebaseAuth = getAuth(firebaseApp);
export const firebaseMessaging = getMessaging(firebaseApp);
export const firebaseStorage = getStorage(firebaseApp);
