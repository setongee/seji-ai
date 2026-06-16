import { initializeApp, getApps, getApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function getDb() {
  if (!getApps().length) {
    const rawKey = process.env.FIREBASE_PRIVATE_KEY || "";
    const privateKey = rawKey.split("\\n").join("\n").replace(/^"|"$/g, "");

    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });
  }

  return getFirestore(getApp());
}

export const db = getDb();
