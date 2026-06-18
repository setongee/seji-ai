import { extractTasks } from "../lib/ai.js";
import { sendMessage, sendTyping, sendButtons } from "../lib/whatsapp.js";
import {
  db,
  getConversationHistory,
  saveConversationTurn,
  getUser,
  saveUser,
  getPendingTasks,
  cascadeReschedule,
} from "../lib/db.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      if (!value?.messages) return res.status(200).end();

      const message = value.messages[0];
      const messageId = message.id;
      const userPhone = message.from;
      const now = new Date().toISOString();

      await sendTyping(userPhone, messageId);

      // ── Interactive button reply ──
      if (message.type === "interactive") {
        const buttonId = message.interactive?.button_reply?.id
        if (buttonId) {
          await handleButtonReply(userPhone, buttonId)
        }
        return res.status(200).end()
      }

      if (message.type !== "text") {
        await sendMessage(userPhone, "Hey! I can only process text messages for now.");
        return res.status(200).end();
      }

      const userText = message.text.body;
      const upper = userText.trim().toUpperCase();

      // ── Text shortcut: YES / DONE ──
      if (upper === "YES" || upper === "DONE") {
        await handleConfirmation(userPhone, "done");
        await sendMessage(userPhone, "Nice one! Task marked as done. ✅");
        return res.status(200).end();
      }

      // ── Text shortcut: SNOOZE ──
      if (upper === "SNOOZE") {
        await handleConfirmation(userPhone, "snoozed");
        return res.status(200).end();
      }

      // ── Text shortcut: EXTEND N ──
      const extendMatch = upper.match(/^EXTEND\s+(\d+)$/);
      if (extendMatch) {
        await handleExtension(userPhone, parseInt(extendMatch[1]));
        return res.status(200).end();
      }

      // ── Normal AI flow ──
      const [history, user, pendingTasks] = await Promise.all([
        getConversationHistory(userPhone),
        getUser(userPhone),
        getPendingTasks(userPhone),
      ]);

      const { reply, tasks, user_name, _raw, _prompt } = await extractTasks(
        userText,
        now,
        { history, userName: user?.name, pendingTasks }
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
            starts_at: t.starts_at ? new Date(t.starts_at) : null,
            ends_at: t.ends_at ? new Date(t.ends_at) : null,
            check_in: t.check_in ?? true,
            status: "pending",
            start_notified: false,
            checkin_30_sent: false,
            checkin_60_sent: false,
            checkin_5min_sent: false,
            end_notified: false,
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

// ── Route button reply IDs to the right action ──
async function handleButtonReply(phone, buttonId) {
  switch (buttonId) {
    case "done":
      await handleConfirmation(phone, "done");
      await sendMessage(phone, "Nailed it! ✅ Task marked as done. Keep that momentum going 🔥");
      break;

    case "snooze":
      await handleConfirmation(phone, "snoozed");
      break;

    case "extend_15":
      await handleExtension(phone, 15);
      break;

    case "extend_30":
      await handleExtension(phone, 30);
      break;

    case "extend_60":
      await handleExtension(phone, 60);
      break;

    case "started":
      await sendMessage(phone, "That's the spirit! 🚀 Head down, get it done. I'll check in with you soon.");
      break;

    case "snooze_start":
      // Push the active task start by 5 minutes
      await handleExtension(phone, 5, true);
      break;

    case "going_well":
      await sendMessage(phone, "Love to hear it! 💪 Keep going — you're doing great.");
      break;

    case "need_help":
      await sendMessage(phone, "No worries at all. Sometimes things take longer than expected.\n\nWhat's the blocker? Tell me and we can figure it out together. Or just reply *EXTEND 30* if you need more time.");
      break;

    case "on_track":
      await sendMessage(phone, "That's what I like to hear! 🎯 Finish strong — you're almost there.");
      break;

    case "almost_done":
      await sendMessage(phone, "Go go go! 🏁 Finish line is right there. I'm watching for your DONE!");
      break;

    case "ready":
      await sendMessage(phone, "Let's get it! 🔥 I'll check in with you as your tasks come up.");
      break;

    case "show_tasks": {
      // Re-fetch and show detailed task list
      const tasks = await getPendingTasks(phone);
      if (tasks.length === 0) {
        await sendMessage(phone, "You're all clear — no pending tasks! Enjoy the breathing room 😌");
      } else {
        const list = tasks.map((t, i) => {
          let time = "";
          if (t.starts_at && t.ends_at) time = `\n   🕐 ${t.starts_at} → ${t.ends_at}`;
          else if (t.remind_at) time = `\n   ⏰ ${t.remind_at}`;
          return `${i + 1}. *${t.title}*${time}`;
        }).join("\n\n");
        await sendMessage(phone, `Here's everything on your plate:\n\n${list}`);
      }
      break;
    }

    default:
      // Unknown button — ignore gracefully
      console.log(`Unknown button reply: ${buttonId} from ${phone}`);
  }
}

// ── Mark awaiting_confirmation task as done or snoozed ──
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
    await sendButtons(
      phone,
      `Got it — I'll remind you again in 1 hour. ⏰\n\nUse the time well!`,
      [{ id: 'done', title: '✅ Actually done' }]
    );
  } else {
    await doc.ref.update({ status: "done" });
  }
}

// ── Extend the currently active timed task by N minutes ──
async function handleExtension(phone, extraMins, isSnoozeStart = false) {
  const snap = await db
    .collection("tasks")
    .where("phone", "==", phone)
    .where("status", "in", ["active", "awaiting_confirmation"])
    .orderBy("created_at", "desc")
    .limit(1)
    .get();

  if (snap.empty) {
    await sendMessage(phone, "Hmm, I couldn't find an active task to extend. Which task would you like more time on?");
    return;
  }

  const doc = snap.docs[0];
  const task = doc.data();
  const pushMs = extraMins * 60 * 1000;
  const currentEnd = task.ends_at ? task.ends_at.toDate() : new Date();
  const newEnd = new Date(currentEnd.getTime() + pushMs);

  await doc.ref.update({
    ends_at: newEnd,
    status: "active",
    end_notified: false,
    checkin_5min_sent: false,
  });

  const affected = await cascadeReschedule(phone, currentEnd, pushMs);

  const newEndStr = newEnd.toLocaleTimeString("en-NG", {
    hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos",
  });

  if (isSnoozeStart) {
    await sendMessage(phone, `No rush — I've pushed the start by ${extraMins} minutes. Come back when you're ready 👊`);
    return;
  }

  let msg = `Done! +${extraMins} minutes added to *${task.title}*.\nNew finish: *${newEndStr}* 💪`;

  if (affected.length > 0) {
    const shifted = affected.map((a) => {
      const t = new Date(a.newStart).toLocaleTimeString("en-NG", {
        hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos",
      });
      return `• ${a.title} → ${t}`;
    }).join("\n");
    msg += `\n\nI've adjusted your other tasks:\n${shifted}`;
  }

  await sendMessage(phone, msg);
}
