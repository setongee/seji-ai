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
    .where("status", "in", ["pending", "active", "awaiting_confirmation"])
    .orderBy("created_at", "asc")
    .get();

  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      title: d.title,
      remind_at: d.remind_at ? d.remind_at.toDate().toISOString() : null,
      starts_at: d.starts_at ? d.starts_at.toDate().toISOString() : null,
      ends_at: d.ends_at ? d.ends_at.toDate().toISOString() : null,
      status: d.status,
    };
  });
}

// Get all active timed tasks for a user (tasks with starts_at/ends_at)
export async function getActiveTimedTasks(phone) {
  const snap = await db
    .collection("tasks")
    .where("phone", "==", phone)
    .where("status", "in", ["pending", "active"])
    .get();

  const now = new Date();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((t) => t.starts_at || t.ends_at);
}

// Reschedule all future tasks for a user after a task extension
// Pushes any tasks that now overlap with the extended task
export async function cascadeReschedule(phone, fromTime, pushByMs) {
  const snap = await db
    .collection("tasks")
    .where("phone", "==", phone)
    .where("status", "in", ["pending", "active"])
    .get();

  const affected = [];
  const batch = db.batch();

  snap.docs.forEach((doc) => {
    const t = doc.data();
    const taskStart = t.starts_at ? t.starts_at.toDate() : null;

    // Only push tasks that start at or after the conflict time
    if (taskStart && taskStart >= fromTime) {
      const newStart = new Date(taskStart.getTime() + pushByMs);
      const newEnd = t.ends_at
        ? new Date(t.ends_at.toDate().getTime() + pushByMs)
        : null;

      batch.update(doc.ref, {
        starts_at: newStart,
        ends_at: newEnd,
        // Reset checkin flags so cron fires fresh
        checkin_30_sent: false,
        checkin_60_sent: false,
        checkin_5min_sent: false,
        start_notified: false,
      });

      affected.push({
        title: t.title,
        newStart: newStart.toISOString(),
        newEnd: newEnd ? newEnd.toISOString() : null,
      });
    }
  });

  if (affected.length > 0) await batch.commit();
  return affected;
}
