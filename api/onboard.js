import { sendMessage } from "../lib/whatsapp.js";
import { db } from "../lib/db.js";

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).end();

  const { phone, name } = req.body;

  if (!phone || !name) {
    return res.status(400).json({ error: "phone and name are required" });
  }

  // Format phone — strip non-digits, handle local Nigerian format
  let cleanPhone = phone.replace(/\D/g, "");

  // If starts with 0, replace with 234 (Nigeria country code)
  if (cleanPhone.startsWith("0")) {
    cleanPhone = "234" + cleanPhone.slice(1);
  }

  // If starts with +234 or 234 already, strip the + if present
  if (cleanPhone.startsWith("+")) {
    cleanPhone = cleanPhone.slice(1);
  }

  const onboardingMessage = `Hey ${name}! 👋

Welcome to *Seji* — your personal AI chief of staff on WhatsApp. You've been verified and you're all set!

Here's what I can do for you:

*📋 Create tasks & reminders*
Just tell me what you need to do. Text a brain dump, voice note your chaos, or snap a photo of your notes — I'll turn it into a structured plan.

_"remind me at 3pm to call Kemi"_
_"I have a presentation at 4, a client email to send, and I haven't eaten"_

*⏰ Smart reminders*
I'll ping you before your deadlines and check in after. Reply *YES* to mark a task done or *SNOOZE* to push it an hour.

*💪 Motivator check-ins*
I don't just track tasks — I'll cheer you on when you're grinding and nudge you when you've gone quiet.

*🏆 Daily badges*
Complete all your tasks in a day and earn a badge. Build your streak.

*Getting started:*
Just send me a message — anything on your mind today. I'll take it from there.

Let's get it. 🔥`;

  try {
    await sendMessage(cleanPhone, onboardingMessage);

    // Save user to Firestore users collection
    await db.collection("users").doc(cleanPhone).set(
      {
        name,
        phone: cleanPhone,
        onboarded_at: new Date(),
        status: "active",
      },
      { merge: true },
    );

    return res
      .status(200)
      .json({ success: true, message: `Onboarding sent to ${name}` });
  } catch (err) {
    console.error("Onboard error:", err);
    return res.status(500).json({ error: err.message });
  }
}
