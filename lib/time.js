// Everything the AI reasons about times in is WAT (UTC+1) — see the system
// prompt in lib/ai.js. Any Date handed to the model MUST be labeled with an
// explicit +01:00 offset, never raw .toISOString() (which is always UTC/"Z").
// Two past bugs came from skipping this: "now" in webhook.js, and pending
// task times in db.js. Route every AI-facing timestamp through here instead
// of calling .toISOString() directly.
export function toWATString(date) {
  return new Date(date.getTime() + 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "+01:00");
}

export function nowWAT() {
  return toWATString(new Date());
}

// Human-readable WAT clock time for displaying to users, e.g. "7:00 PM".
// Accepts a Date or an ISO string (any offset — Date parsing normalizes to
// the correct instant regardless, then this re-localizes it to Lagos time).
export function formatWATTime(dateOrIso) {
  const date = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  return date.toLocaleTimeString("en-NG", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Lagos",
  });
}
