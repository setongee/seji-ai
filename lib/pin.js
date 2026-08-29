import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// PIN hashing via Node's built-in scrypt — no external dependency needed.
// Each PIN gets its own random salt; we store salt+hash, never the PIN.
export function hashPin(pin) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPin(pin, salt, hash) {
  if (!salt || !hash) return false;
  const attempt = scryptSync(pin, salt, 64);
  const stored = Buffer.from(hash, "hex");
  // timingSafeEqual requires equal-length buffers, or throws
  if (attempt.length !== stored.length) return false;
  return timingSafeEqual(attempt, stored);
}
