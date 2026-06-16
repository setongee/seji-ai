export default async function handler(req, res) {
  const raw = process.env.FIREBASE_PRIVATE_KEY || "";
  const processed = raw.split("\\n").join("\n").replace(/^"|"$/g, "");

  res.status(200).json({
    rawLength: raw.length,
    processedLength: processed.length,
    hasRealNewline: processed.includes("\n"),
    processedStart: processed.substring(0, 40),
  });
}
