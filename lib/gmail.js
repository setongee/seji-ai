import axios from "axios";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

// ── Step 1: build the Google consent screen URL ──
// access_type=offline + prompt=consent guarantees a refresh_token back even
// on a repeat authorization (Google only returns one on the very first
// consent otherwise). `state` carries our own one-time token so the
// callback knows which WhatsApp phone number this belongs to.
export function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── Step 2: exchange the one-time code from the callback for tokens ──
export async function exchangeCodeForTokens(code) {
  const { data } = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    })
  );
  return data; // { access_token, refresh_token, expires_in, scope, token_type }
}

// Access tokens expire hourly — refresh_token doesn't expire (unless
// revoked), so every real API call refreshes fresh right before use rather
// than tracking access-token expiry ourselves.
async function refreshAccessToken(refreshToken) {
  const { data } = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    })
  );
  return data.access_token;
}

export async function getUserEmail(accessToken) {
  const { data } = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data.email;
}

// List recent emails — metadata only (subject/from/date/snippet), never the
// full body, to keep this cheap and fast for a "what's in my inbox" summary.
export async function listRecentEmails(refreshToken, { maxResults = 10, query = "" } = {}) {
  const accessToken = await refreshAccessToken(refreshToken);

  const { data: listData } = await axios.get(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    { headers: { Authorization: `Bearer ${accessToken}` }, params: { maxResults, q: query } }
  );

  if (!listData.messages) return [];

  const emails = await Promise.all(
    listData.messages.map(async (m) => {
      // Built manually (not via axios `params`) so metadataHeaders is
      // repeated as the API expects — axios's array param serialization
      // isn't reliable enough to lean on here.
      const qs = new URLSearchParams();
      qs.append("format", "metadata");
      qs.append("metadataHeaders", "Subject");
      qs.append("metadataHeaders", "From");
      qs.append("metadataHeaders", "Date");

      const { data } = await axios.get(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?${qs}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const headers = Object.fromEntries((data.payload?.headers || []).map((h) => [h.name, h.value]));
      return {
        id: m.id,
        subject: headers.Subject || "(no subject)",
        from: headers.From || "",
        date: headers.Date || "",
        snippet: data.snippet || "",
      };
    })
  );

  return emails;
}

// Send a plain-text email. Gmail's API wants a full RFC 2822 message,
// base64url-encoded (standard base64 with +/ swapped for -_ and no padding).
export async function sendEmail(refreshToken, { to, subject, body }) {
  const accessToken = await refreshAccessToken(refreshToken);

  const rawMessage = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");

  const encoded = Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await axios.post(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    { raw: encoded },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
}
