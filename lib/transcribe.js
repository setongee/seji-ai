const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3-turbo";

// Pick a sensible filename/extension for the audio blob based on the mime
// type WhatsApp reports — Groq mostly infers from content, but a matching
// extension avoids edge-case rejections.
function filenameFor(mimeType = "") {
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "audio.m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "audio.mp3";
  if (mimeType.includes("amr")) return "audio.amr";
  if (mimeType.includes("wav")) return "audio.wav";
  return "audio.ogg"; // WhatsApp voice notes are ogg/opus by default
}

// Transcribe a WhatsApp voice note (raw audio bytes) to plain text via Groq's
// hosted Whisper endpoint.
export async function transcribeAudio(buffer, mimeType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filenameFor(mimeType));
  form.append("model", MODEL);

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq transcription failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.text?.trim();
}
