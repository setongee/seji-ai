import axios from "axios";

const BASE = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

const headers = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  "Content-Type": "application/json",
});

// ── Plain text message ──
export async function sendMessage(to, text) {
  await axios.post(
    BASE,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: headers() }
  );
}

// ── Read receipt (blue ticks) ──
export async function sendTyping(to, messageId) {
  await axios.post(
    BASE,
    {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    },
    { headers: headers() }
  );
}

// ── Interactive reply buttons (max 3 buttons, title max 20 chars) ──
// buttons = [{ id: 'done', title: '✅ Done' }, ...]
export async function sendButtons(to, bodyText, buttons, headerText = null, footerText = null) {
  const interactive = {
    type: "button",
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: "reply",
        reply: {
          id: b.id,
          title: b.title.slice(0, 20), // enforce 20 char limit
        },
      })),
    },
  };

  if (headerText) {
    interactive.header = { type: "text", text: headerText };
  }

  if (footerText) {
    interactive.footer = { text: footerText };
  }

  await axios.post(
    BASE,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive,
    },
    { headers: headers() }
  );
}

// ── Interactive list message (max 10 items, for longer option sets) ──
// sections = [{ title: 'Section', rows: [{ id, title, description }] }]
export async function sendList(to, bodyText, buttonLabel, sections, headerText = null, footerText = null) {
  const interactive = {
    type: "list",
    body: { text: bodyText },
    action: {
      button: buttonLabel.slice(0, 20),
      sections,
    },
  };

  if (headerText) {
    interactive.header = { type: "text", text: headerText };
  }

  if (footerText) {
    interactive.footer = { text: footerText };
  }

  await axios.post(
    BASE,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive,
    },
    { headers: headers() }
  );
}
