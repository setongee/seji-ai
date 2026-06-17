import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const raw = process.env.FIREBASE_PRIVATE_KEY || "";
const privateKey = raw.split("\\n").join("\n").replace(/^"|"$/g, "");

console.log("Key length:", privateKey.length);
console.log("Has newline:", privateKey.includes("\n"));

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
});

const db = getFirestore();
await db.collection("test").add({ ping: true });
console.log("SUCCESS - Firebase connected!");
