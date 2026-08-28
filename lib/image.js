import sharp from "sharp";

// GPT-4o-family vision pricing is based on how many 512x512 tiles an image
// gets split into after the model's own internal downscaling — a full-res
// phone photo (often 3000-4000px) costs meaningfully more in tokens than
// something already sized for reading text off it, with no real accuracy
// gain past that point. Resize + recompress before it ever leaves Seji.
//
// 1280px on the long edge keeps handwriting/small text legible while
// noticeably cutting the resulting tile count on typical camera photos.
export async function compressImage(buffer) {
  const compressed = await sharp(buffer)
    .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  return { buffer: compressed, mimeType: "image/jpeg" };
}
