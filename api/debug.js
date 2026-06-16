export default async function handler(req, res) {
  const key = process.env.FIREBASE_PRIVATE_KEY || "";

  res.status(200).json({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    keyLength: key.length,
    keyStart: key.substring(0, 40),
    keyEnd: key.substring(key.length - 40),
    hasBeginMarker: key.includes("BEGIN PRIVATE KEY"),
    hasEndMarker: key.includes("END PRIVATE KEY"),
    hasLiteralBackslashN: key.includes("\\n"),
    hasRealNewline: key.includes("\n"),
  });
}
