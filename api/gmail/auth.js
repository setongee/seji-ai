import { getAuthUrl } from "../../lib/gmail.js";

// Redirects into Google's consent screen. `state` is the one-time token
// Seji generated and sent as a link in WhatsApp — it's what lets the
// callback (which only sees a browser, not a phone number) know who to
// attach the resulting tokens to.
export default function handler(req, res) {
  const { state } = req.query;

  if (!state) {
    return res.status(400).send("Missing state — use the link Seji sent you, don't visit this directly.");
  }

  res.redirect(302, getAuthUrl(state));
}
