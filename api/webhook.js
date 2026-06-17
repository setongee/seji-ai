import { extractTasks } from "../lib/ai.js";
import { sendMessage } from "../lib/whatsapp.js";
import { db } from "../lib/db.js";

export default async function handler(req, res) {
  // Meta webhook verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  // Incoming messages (POST)
  if (req.method === "POST") {
    res.status(200).end();

    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      if (!value?.messages) return;

      const message = value.messages[0];
      if (message.type !== "text") {
        await sendMessage(
          message.from,
          "Hey! I can only process text messages for now.",
        );
        return;
      }

      const userText = message.text.body;
      const userPhone = message.from;
      const now = new Date().toISOString();

      const upper = userText.trim().toUpperCase();
      if (upper === "YES" || upper === "DONE") {
        await handleConfirmation(userPhone, "done");
        await sendMessage(userPhone, "Nice one! Task marked as done. ✅");
        return;
      }
      if (upper === "SNOOZE") {
        await handleConfirmation(userPhone, "snoozed");
        return;
      }

      const { reply, tasks } = await extractTasks(userText, now);

      if (tasks && tasks.length > 0) {
        const batch = db.batch();
        tasks.forEach((t) => {
          const ref = db.collection("tasks").doc();
          batch.set(ref, {
            phone: userPhone,
            title: t.title,
            remind_at: t.remind_at ? new Date(t.remind_at) : null,
            check_in: t.check_in ?? true,
            status: "pending",
            created_at: new Date(),
          });
        });
        await batch.commit();
      }

      await sendMessage(userPhone, reply);
    } catch (err) {
      console.error("Webhook handler error:", err);
    }

    return;
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}

async function handleConfirmation(phone, newStatus) {
  const snap = await db
    .collection("tasks")
    .where("phone", "==", phone)
    .where("status", "==", "awaiting_confirmation")
    .orderBy("created_at", "desc")
    .limit(1)
    .get();

  if (snap.empty) return;

  const doc = snap.docs[0];

  if (newStatus === "snoozed") {
    const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000);
    await doc.ref.update({ status: "pending", remind_at: snoozeUntil });
    await sendMessage(phone, `Got it, I'll remind you again in 1 hour. ⏰`);
  } else {
    await doc.ref.update({ status: "done" });
  }
}
