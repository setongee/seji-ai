import { exchangeCodeForTokens, getUserEmail } from "../../lib/gmail.js";
import { consumeGmailConnectState, saveGmailAccount } from "../../lib/db.js";
import { sendMessage } from "../../lib/whatsapp.js";

function page(message) {
  return `<!doctype html><html><body style="font-family: sans-serif; text-align: center; padding: 60px 20px;">
    <h2>${message}</h2>
    <p>You can close this tab and go back to WhatsApp.</p>
  </body></html>`;
}

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    // User hit "Cancel" on Google's consent screen — nothing to clean up,
    // the state token just expires unused after 10 minutes.
    return res.status(200).send(page("No worries — Gmail wasn't connected."));
  }

  if (!code || !state) {
    return res.status(400).send(page("Something's missing from this link."));
  }

  const phone = await consumeGmailConnectState(state);
  if (!phone) {
    return res.status(400).send(page("This link has expired — ask Seji to connect Gmail again."));
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const email = await getUserEmail(tokens.access_token);

    await saveGmailAccount(phone, { refreshToken: tokens.refresh_token, email });
    await sendMessage(phone, `Gmail connected — ${email} ✅\n\nAsk me to check your inbox or send an email whenever.`);

    return res.status(200).send(page(`Connected ${email} 🎉`));
  } catch (err) {
    console.error("Gmail callback error:", err);
    try {
      await sendMessage(phone, "Hmm, connecting Gmail didn't work. Mind trying again?");
    } catch {}
    return res.status(500).send(page("Something went wrong connecting your account."));
  }
}
