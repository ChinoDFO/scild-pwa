import "dotenv/config";
import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./firebase-service-account.json";

const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));

const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
});

export const firebaseAuth = getAuth(firebaseApp);
