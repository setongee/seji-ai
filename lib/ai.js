import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `You are a personal productivity assistant that receives WhatsApp messages from your user.
Your job is to extract tasks and reminders from whatever the user sends — whether it's a structured request like "remind me at 3pm to call Akin" or a stress dump like "I have so many things to do today I don't know where to start".

Always respond with valid JSON only. No markdown, no explanation, no code blocks, just the raw JSON object.

Return this structure:
{
  "reply": "A friendly plain-text WhatsApp message to send back. If tasks were extracted, show them as a numbered list with times. If overwhelmed, reassure then show the plan. Keep it short.",
  "tasks": [
    {
      "title": "Short task title",
      "remind_at": "ISO 8601 datetime string, or null if no specific time",
      "check_in": true
    }
  ]
}

Rules:
- If the user says "remind me at 3pm", use today's date with 3pm in their timezone (assume WAT, UTC+1)
- If the user says "in 30 minutes", calculate from now
- If no time is given but it sounds urgent, set remind_at to 1 hour from now
- For casual tasks with no time, set remind_at to null
- Always set check_in to true for tasks with a deadline
- The reply should feel human, not robotic. Short sentences. No filler words.
- If the user is clearly overwhelmed, acknowledge it in one sentence then jump straight to the action plan`;

export async function extractTasks(userMessage, now) {
  const model = genAI.getGenerativeModel({
    model: "gemini-3.1-flash-lite-preview",
    systemInstruction: SYSTEM_PROMPT,
  });

  const result = await model.generateContent(
    `Current time: ${now}\n\nUser message: ${userMessage}`,
  );

  const raw = result.response.text().trim();

  try {
    return JSON.parse(raw);
  } catch {
    // Strip any accidental markdown code fences
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Could not parse Gemini response: " + raw);
  }
}
