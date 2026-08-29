import { initializeApp, getApps, getApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { toWATString } from "./time.js";

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

// ── Gmail connection ──
// One-time state tokens correlate the OAuth round-trip (which happens in a
// browser, no phone number in sight) back to the WhatsApp phone that
// requested it. Consuming deletes it — single use, and treated as expired
// after 10 minutes even if unused.
const GMAIL_STATE_TTL_MS = 10 * 60 * 1000;

export async function createGmailConnectState(phone) {
  const ref = db.collection("oauth_states").doc();
  await ref.set({ phone, created_at: new Date() });
  return ref.id;
}

export async function consumeGmailConnectState(token) {
  const ref = db.collection("oauth_states").doc(token);
  const doc = await ref.get();
  if (!doc.exists) return null;

  await ref.delete();

  const { phone, created_at } = doc.data();
  if (Date.now() - created_at.toDate().getTime() > GMAIL_STATE_TTL_MS) return null;
  return phone;
}

export async function saveGmailAccount(phone, { refreshToken, email }) {
  await saveUser(phone, { gmail_refresh_token: refreshToken, gmail_email: email });
}

// A drafted-but-unsent email, shown to the user before it actually goes —
// Seji never sends email silently. Cleared once sent, discarded, or
// superseded by a new draft.
export async function setPendingEmail(phone, { to, subject, body }) {
  await saveUser(phone, {
    pending_email: { to, subject, body, created_at: new Date() },
  });
}

export async function clearPendingEmail(phone) {
  await db.collection("users").doc(phone).update({ pending_email: FieldValue.delete() });
}

// ── PIN-gate for destructive bulk actions ──
// Store only a salted hash, never the PIN itself.
export async function setUserPin(phone, salt, hash) {
  await saveUser(phone, { pin_salt: salt, pin_hash: hash });
}

// A "pending action" tracks what a PIN submission is meant to confirm —
// set right before sending the Flow, read/cleared when the nfm_reply comes
// back. flow_token lets us ignore any stray/late reply that doesn't match
// the confirmation we're actually waiting on.
export async function setPendingAction(phone, { type, flowToken }) {
  await saveUser(phone, {
    pending_action: { type, flow_token: flowToken, created_at: new Date() },
  });
}

export async function clearPendingAction(phone) {
  await db.collection("users").doc(phone).update({ pending_action: FieldValue.delete() });
}

// ── Bulk task actions (the things the PIN gate protects) ──
export async function clearAllTasks(phone) {
  const snap = await db
    .collection("tasks")
    .where("phone", "==", phone)
    .where("status", "in", ["pending", "active", "awaiting_confirmation"])
    .get();

  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  return snap.size;
}

export async function markAllTasksDone(phone) {
  const snap = await db
    .collection("tasks")
    .where("phone", "==", phone)
    .where("status", "in", ["pending", "active", "awaiting_confirmation"])
    .get();

  const batch = db.batch();
  snap.docs.forEach((doc) => batch.update(doc.ref, { status: "done" }));
  await batch.commit();
  return snap.size;
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
      // WAT-labeled, not raw UTC — this gets fed straight into the AI's
      // context, and the prompt assumes everything it's handed is WAT.
      remind_at: d.remind_at ? toWATString(d.remind_at.toDate()) : null,
      starts_at: d.starts_at ? toWATString(d.starts_at.toDate()) : null,
      ends_at: d.ends_at ? toWATString(d.ends_at.toDate()) : null,
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
