import { extractTasks } from "../lib/ai.js";
import { sendMessage, sendTyping } from "../lib/whatsapp.js";
import {
  db,
  getConversationHistory,
  saveConversationTurn,
  getUser,
  saveUser,
  getPendingTasks,
} from "../lib/db.js";

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
    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      if (!value?.messages) {
        return res.status(200).end();
      }

      const message = value.messages[0];
      const messageId = message.id;
      const userPhone = message.from;
      const now = new Date().toISOString();

      if (message.type !== "text") {
        await sendMessage(
          userPhone,
          "Hey! I can only process text messages for now.",
        );
        return res.status(200).end();
      }

      // Send typing indicator immediately
      await sendTyping(userPhone, messageId);

      const userText = message.text.body;

      const upper = userText.trim().toUpperCase();
      if (upper === "YES" || upper === "DONE") {
        await handleConfirmation(userPhone, "done");
        await sendMessage(userPhone, "Nice one! Task marked as done. ✅");
        return res.status(200).end();
      }
      if (upper === "SNOOZE") {
        await handleConfirmation(userPhone, "snoozed");
        return res.status(200).end();
      }

      const [history, user, pendingTasks] = await Promise.all([
        getConversationHistory(userPhone),
        getUser(userPhone),
        getPendingTasks(userPhone),
      ]);

      const { reply, tasks, user_name, _raw, _prompt } = await extractTasks(
        userText,
        now,
        { history, userName: user?.name, pendingTasks },
      );

      await saveConversationTurn(userPhone, _prompt, _raw);

      if (user_name && !user?.name) {
        await saveUser(userPhone, { name: user_name, created_at: new Date() });
      }

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

    return res.status(200).end();
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
