import axios from "axios";

const BASE = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

export async function sendMessage(to, text) {
  await axios.post(
    BASE,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  );
}

export async function sendTyping(to, messageId) {
  // Step 1 — mark as read (shows blue ticks)
  await axios.post(
    BASE,
    {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  );
}
