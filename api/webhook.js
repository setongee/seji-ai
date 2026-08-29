import { extractTasks } from "../lib/ai.js";
import { sendMessage, sendTyping, sendButtons, getMediaBuffer } from "../lib/whatsapp.js";
import { transcribeAudio } from "../lib/transcribe.js";
import { compressImage } from "../lib/image.js";
import { nowWAT, formatWATTime } from "../lib/time.js";
import { hashPin, verifyPin } from "../lib/pin.js";
import { listRecentEmails, sendEmail } from "../lib/gmail.js";
import {
  db,
  getConversationHistory,
  saveConversationTurn,
  getUser,
  saveUser,
  getPendingTasks,
  cascadeReschedule,
  setUserPin,
  setPendingAction,
  clearPendingAction,
  clearAllTasks,
  markAllTasksDone,
  createGmailConnectState,
  setPendingEmail,
  clearPendingEmail,
} from "../lib/db.js";

// PIN_FLOW_ID (4339270906334590, "seji_pin_confirm") still exists in Meta —
// swap the text-based trigger below for sendFlow() from lib/whatsapp.js once
// the WABA is business-verified and Flows actually deliver.
const BULK_ACTION_LABELS = {
  clear_all: "clear all your tasks",
  mark_all_done: "mark all your tasks done",
};

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

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
      const now = nowWAT();

      await sendTyping(userPhone, messageId);

      // ── Interactive button reply ──
      if (message.type === "interactive") {
        const buttonId = message.interactive?.button_reply?.id
        if (buttonId) {
          await handleButtonReply(userPhone, buttonId)
        }

        // ── PIN Flow submission (dormant until the WABA is business-verified —
        // see the text-based fallback below for what's actually live today) ──
        if (message.interactive?.type === "nfm_reply") {
          let response;
          try { response = JSON.parse(message.interactive.nfm_reply.response_json); } catch { response = null; }
          if (response?.pin) await handlePinSubmission(userPhone, response.pin);
        }

        return res.status(200).end()
      }

      const user = await getUser(userPhone);

      // ── Text-based PIN confirmation reply ──
      // Flows need the WABA to be business-verified (not the case yet — see
      // sendFlow in lib/whatsapp.js, kept ready for when it is). Until then,
      // a pending bulk action is confirmed by just replying with digits.
      // Anything else while one's pending is treated as "never mind" —
      // clears it rather than trapping the user into only accepting a PIN.
      if (message.type === "text" && user?.pending_action) {
        const attempt = message.text.body.trim();
        if (/^\d{4,}$/.test(attempt)) {
          await handlePinSubmission(userPhone, attempt);
          return res.status(200).end();
        }
        await clearPendingAction(userPhone);
      }

      // ── Drafted-email send confirmation ──
      // Seji never sends an email without this — a plain "SEND" reply is
      // the only thing that triggers it. Anything else clears the draft
      // rather than trapping the user (they can just re-ask to redraft).
      if (message.type === "text" && user?.pending_email) {
        const attempt = message.text.body.trim().toUpperCase();
        if (attempt === "SEND") {
          try {
            await sendEmail(user.gmail_refresh_token, user.pending_email);
            await clearPendingEmail(userPhone);
            await sendMessage(userPhone, `Sent! ✅ To: ${user.pending_email.to}`);
          } catch (err) {
            console.error("Gmail send error:", err);
            await clearPendingEmail(userPhone);
            await sendMessage(userPhone, "Hmm, that email didn't send. Mind trying again?");
          }
          return res.status(200).end();
        }
        await clearPendingEmail(userPhone);
      }

      // ── Resolve the incoming message down to plain text (+ optional image) ──
      // Text messages pass through as-is; voice notes get downloaded from
      // WhatsApp and transcribed first; photos get downloaded and handed to
      // the AI directly as vision input. Everything past this point treats
      // all three the same way.
      let userText;
      let imageData = null;

      if (message.type === "text") {
        userText = message.text.body;
      } else if (message.type === "audio") {
        const greeting = user?.name ? `Hi ${user.name}` : "Hey";
        await sendMessage(userPhone, `${greeting}, listening to your voice note... I'll reply soon 🎧`);
        await sendTyping(userPhone, messageId); // sending that message just dismissed the bubble — bring it back

        try {
          const { buffer, mimeType } = await getMediaBuffer(message.audio.id);
          userText = await transcribeAudio(buffer, mimeType);
        } catch (err) {
          console.error("Transcription error:", err);
          await sendMessage(userPhone, "Sorry, I couldn't quite make that out. Mind trying again, or typing it instead?");
          return res.status(200).end();
        }

        if (!userText) {
          await sendMessage(userPhone, "Hmm, that voice note came through empty. Could you try again?");
          return res.status(200).end();
        }
      } else if (message.type === "image") {
        const greeting = user?.name ? `Hi ${user.name}` : "Hey";
        await sendMessage(userPhone, `${greeting}, taking a look at your photo... I'll reply soon 👀`);
        await sendTyping(userPhone, messageId); // bring the bubble back after that message dismissed it

        try {
          const { buffer } = await getMediaBuffer(message.image.id);
          const compressed = await compressImage(buffer);
          imageData = { base64: compressed.buffer.toString("base64"), mimeType: compressed.mimeType };
        } catch (err) {
          console.error("Image download error:", err);
          await sendMessage(userPhone, "Sorry, I couldn't load that photo. Mind trying again?");
          return res.status(200).end();
        }

        userText = message.image.caption || "[Photo attached, no caption — read the image for tasks/to-dos.]";
      } else {
        await sendMessage(userPhone, "Hey! I can only process text, voice notes, or photos for now.");
        return res.status(200).end();
      }

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

      // ── Normal AI flow ── (user was already fetched above)
      const [history, pendingTasks] = await Promise.all([
        getConversationHistory(userPhone),
        getPendingTasks(userPhone),
      ]);

      const { reply, tasks, task_update, bulk_action, email_action, user_name, _raw, _prompt } = await extractTasks(
        userText,
        now,
        { history, userName: user?.name, pendingTasks, image: imageData, gmailConnected: Boolean(user?.gmail_refresh_token) }
      );

      await saveConversationTurn(userPhone, _prompt, _raw);

      if (user_name && !user?.name) {
        await saveUser(userPhone, { name: user_name, created_at: new Date() });
      }

      if (task_update?.task_id) {
        await applyTaskUpdate(userPhone, task_update);
      }

      // ── Bulk action requested — hold off executing, gate behind a PIN ──
      // Text-based for now (see note above on Flows needing verification).
      if (bulk_action && BULK_ACTION_LABELS[bulk_action]) {
        await sendMessage(userPhone, reply);

        const flowToken = crypto.randomUUID(); // still useful as an internal correlation id
        await setPendingAction(userPhone, { type: bulk_action, flowToken });

        const hasPin = Boolean(user?.pin_hash);
        await sendMessage(
          userPhone,
          hasPin
            ? `🔒 To confirm: ${BULK_ACTION_LABELS[bulk_action]}. Reply with your PIN.`
            : `🔒 Let's set a PIN to protect actions like this — reply with 4+ digits. This will also confirm the action above.`
        );

        return res.status(200).end();
      }

      // ── Email action requested ──
      // Defensive check on "draft": only act on it if there's a real-looking
      // address — the model is instructed never to set draft without one,
      // but this is cheap insurance against sending to `undefined`.
      const validEmailAction = email_action?.type && (email_action.type !== "draft" || email_action.to?.includes("@"));

      if (validEmailAction) {
        await sendMessage(userPhone, reply);

        if (email_action.type === "connect") {
          const state = await createGmailConnectState(userPhone);
          await sendMessage(userPhone, `Tap to connect: ${PUBLIC_BASE_URL}/api/gmail/auth?state=${state}`);
        } else if (email_action.type === "check") {
          try {
            const emails = await listRecentEmails(user.gmail_refresh_token, { maxResults: 8, query: email_action.query || "" });
            if (emails.length === 0) {
              await sendMessage(userPhone, "Nothing there — inbox is clear 📭");
            } else {
              const list = emails
                .map((e, i) => `${i + 1}. *${e.subject}*\n   ${e.from}\n   ${e.snippet}`)
                .join("\n\n");
              await sendMessage(userPhone, `📬 Here's what's there:\n\n${list}`);
            }
          } catch (err) {
            console.error("Gmail check error:", err);
            await sendMessage(userPhone, "Couldn't reach your inbox just now — mind trying again?");
          }
        } else if (email_action.type === "draft") {
          await setPendingEmail(userPhone, { to: email_action.to, subject: email_action.subject, body: email_action.body });
          await sendMessage(
            userPhone,
            `📧 *To:* ${email_action.to}\n*Subject:* ${email_action.subject}\n\n${email_action.body}\n\nReply *SEND* to send this, or tell me what to change.`
          );
        }

        return res.status(200).end();
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
      try {
        const userPhone = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
        if (userPhone) {
          await sendMessage(userPhone, "Sorry, I hit a snag processing that. Mind trying again in a moment?");
        }
      } catch (notifyErr) {
        console.error("Failed to notify user of error:", notifyErr);
      }
    }

    return res.status(200).end();
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end();
}

// ── Handle a PIN submission (text reply today; Flow nfm_reply once the WABA
// is business-verified — both funnel into this same function) ──
// Two cases, distinguished by whether the user already has a PIN set:
// no PIN yet → this submission IS the new PIN (set it, then run the action
// that prompted it, since entering a fresh PIN here is itself the consent).
// PIN already set → verify it before running the action; wrong PIN cancels
// the action entirely rather than looping back into the form.
async function handlePinSubmission(phone, pin) {
  const user = await getUser(phone);
  const pending = user?.pending_action;

  if (!pin || !pending) {
    await sendMessage(phone, "That confirmation seems to have expired — go ahead and ask again if you still want to.");
    return;
  }

  const label = BULK_ACTION_LABELS[pending.type];

  const runAction = async () => {
    if (pending.type === "clear_all") {
      const count = await clearAllTasks(phone);
      await sendMessage(phone, count > 0 ? `Done — cleared ${count} task${count === 1 ? "" : "s"}. Clean slate ✨` : "You were already all clear!");
    } else if (pending.type === "mark_all_done") {
      const count = await markAllTasksDone(phone);
      await sendMessage(phone, count > 0 ? `Done — marked ${count} task${count === 1 ? "" : "s"} complete. 🎉` : "Nothing pending to mark done!");
    }
  };

  if (!user.pin_hash) {
    // First-time setup — this PIN entry is the new PIN, and also doubles as
    // consent to go ahead with whatever prompted it.
    const { salt, hash } = hashPin(pin);
    await setUserPin(phone, salt, hash);
    await clearPendingAction(phone);
    await sendMessage(phone, "PIN set! I'll ask for it before anything like this from now on.");
    await runAction();
    return;
  }

  await clearPendingAction(phone);

  if (!verifyPin(pin, user.pin_salt, user.pin_hash)) {
    await sendMessage(phone, `That PIN didn't match — I haven't touched anything. Ask again to ${label} if you still want to.`);
    return;
  }

  await runAction();
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
          if (t.starts_at && t.ends_at) time = `\n   🕐 ${formatWATTime(t.starts_at)} → ${formatWATTime(t.ends_at)}`;
          else if (t.remind_at) time = `\n   ⏰ ${formatWATTime(t.remind_at)}`;
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

// ── Apply an AI-decided edit/cancel to an EXISTING pending task ──
// This is what lets natural language ("extend this by 30 mins", "push my
// 3pm call to 4") modify a task in place instead of the AI's only option
// being to create a brand new one — which used to leave the original
// untouched and fire twice.
async function applyTaskUpdate(phone, update) {
  const ref = db.collection("tasks").doc(update.task_id);
  const snap = await ref.get();

  // Ignore silently if the id is stale/invalid or (defensively) belongs to
  // someone else — the AI only ever sees this user's own pending tasks, so
  // this should never trip, but it's a cheap safety net.
  if (!snap.exists || snap.data().phone !== phone) return;

  if (update.cancel) {
    await ref.update({ status: "done" });
    return;
  }

  const prevStatus = snap.data().status;
  const fieldUpdates = {
    start_notified: false,
    checkin_30_sent: false,
    checkin_60_sent: false,
    checkin_5min_sent: false,
    end_notified: false,
  };

  if (update.new_remind_at) {
    fieldUpdates.remind_at = new Date(update.new_remind_at);
    fieldUpdates.status = "pending"; // ready for cron to fire again at the new time
  }
  if (update.new_starts_at) fieldUpdates.starts_at = new Date(update.new_starts_at);
  if (update.new_ends_at) fieldUpdates.ends_at = new Date(update.new_ends_at);

  if ((update.new_starts_at || update.new_ends_at) && !update.new_remind_at) {
    // Timed-task edit: if it was already underway/awaiting confirmation, put
    // it back into "active" so cron re-processes the new end time. If it
    // hasn't started yet, leave it "pending" so the normal start flow fires.
    fieldUpdates.status = prevStatus === "pending" ? "pending" : "active";
  }

  await ref.update(fieldUpdates);
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
