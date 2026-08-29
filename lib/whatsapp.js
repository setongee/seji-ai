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

// ── Read receipt (blue ticks) + typing indicator ──
// The Cloud API bundles both into one request: marking a message "read" also
// lets you request the "…typing" bubble in the chat. It shows for up to ~25s,
// or until the next message you send — call this again any time you want to
// resume it after sending an interim message.
export async function sendTyping(to, messageId) {
  await axios.post(
    BASE,
    {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
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

// ── Download a media attachment (e.g. a voice note) as raw bytes ──
// WhatsApp only gives you a media ID in the webhook payload — this does the
// two-step Graph API dance: resolve the ID to a short-lived CDN URL, then
// download the actual bytes from it (both steps need the same auth header).
export async function getMediaBuffer(mediaId) {
  const { data: meta } = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: headers() }
  );

  const { data } = await axios.get(meta.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
  });

  return { buffer: Buffer.from(data), mimeType: meta.mime_type };
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

// ── Send a WhatsApp Flow (native in-chat form popup) ──
// Used for the PIN screen — flowToken is our own correlation id, returned
// unchanged in the nfm_reply webhook payload so we know which pending
// action a given PIN submission belongs to. promptText fills the flow's
// single dynamic field (see its screen's data schema).
export async function sendFlow(to, { flowId, flowToken, bodyText, ctaText, promptText, screenId }) {
  await axios.post(
    BASE,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "flow",
        body: { text: bodyText },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: flowToken,
            flow_id: flowId,
            flow_cta: ctaText,
            flow_action: "navigate",
            flow_action_payload: {
              screen: screenId,
              data: { prompt_text: promptText },
            },
          },
        },
      },
    },
    { headers: headers() }
  );
}
