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

export async function getConversationHistory(phone, limit = 20) {
  const snap = await db
    .collection("conversations")
    .doc(phone)
    .collection("messages")
    .orderBy("created_at", "asc")
    .limitToLast(limit)
    .get();

  return snap.docs.map((doc) => ({
    role: doc.data().role,
    parts: [{ text: doc.data().text }],
  }));
}

export async function saveConversationTurn(phone, userText, modelText) {
  const ref = db
    .collection("conversations")
    .doc(phone)
    .collection("messages");
  const now = new Date();

  await Promise.all([
    ref.add({ role: "user", text: userText, created_at: now }),
    ref.add({
      role: "model",
      text: modelText,
      created_at: new Date(now.getTime() + 1),
    }),
  ]);
}

export async function getUser(phone) {
  const doc = await db.collection("users").doc(phone).get();
  return doc.exists ? doc.data() : null;
}

export async function saveUser(phone, fields) {
  await db
    .collection("users")
    .doc(phone)
    .set({ phone, ...fields, updated_at: new Date() }, { merge: true });
}

export async function getPendingTasks(phone) {
  const snap = await db
    .collection("tasks")
    .where("phone", "==", phone)
    .where("status", "in", ["pending", "awaiting_confirmation"])
    .orderBy("created_at", "asc")
    .get();

  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      title: d.title,
      remind_at: d.remind_at ? d.remind_at.toDate().toISOString() : null,
      status: d.status,
    };
  });
}
