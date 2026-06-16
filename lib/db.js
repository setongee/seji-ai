import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) {
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";

  privateKey = privateKey.split("\\n").join("\n");
  privateKey = privateKey.replace(/^"|"$/g, "");

  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
  });
}

export const db = getFirestore();
