// Daily PoC pipeline: pick a photo from the SmugMug "Stock" album,
// ask Claude to write a short love-themed caption for it, and update index.html.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import sharp from "sharp";
import { smugmugRequest } from "./smugmug-client.mjs";

const ALBUM_KEY = "6v3DvK"; // "Stock" album (password-protected, owner-accessible)
const MAX_WIDTH = 1600;
const JPEG_QUALITY = 82;
const ROOT = new URL("..", import.meta.url);

function loadEnv() {
  const path = new URL(".env", ROOT);
  const env = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY in .env");
  process.exit(1);
}

async function pickTodaysImage() {
  const album = await smugmugRequest(`/api/v2/album/${ALBUM_KEY}`);
  const imagesUri = album.Response.Album.Uris.AlbumImages.Uri;
  const images = await smugmugRequest(`${imagesUri}?count=100`);
  const list = (images.Response.AlbumImage ?? []).slice().sort((a, b) => a.FileName.localeCompare(b.FileName));
  if (list.length === 0) throw new Error(`Album "${album.Name}" has no images`);

  const dayIndex = Math.floor(Date.now() / 86400000) % list.length;
  const chosen = list[dayIndex];

  const sizes = await smugmugRequest(chosen.Uris.ImageSizeDetails.Uri);
  const originalUrl = sizes.Response.ImageSizeDetails.ImageSizeOriginal.Url;
  return { fileName: chosen.FileName, originalUrl };
}

async function downloadImage(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === attempts) throw err;
      console.warn(`Download attempt ${attempt} failed (${err.message}), retrying...`);
    }
  }
}

async function generateCaption(buffer, mediaType) {
  const base64 = buffer.toString("base64");
  const prompt =
    "You are writing a short caption for a photo on a website called AiLoveYou.ai, which explores " +
    "themes of love and connection in everyday moments. Look at this photo and write one warm, evocative " +
    "sentence (max 30 words) capturing a feeling of love, tenderness, or connection inspired by it. " +
    "Write in English. Do not mention AI, the website, or that this is generated. Return only the sentence.";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${text}`);
  const data = JSON.parse(text);
  return data.content.map((block) => block.text ?? "").join("").trim();
}

function updateIndexHtml({ imagePath, caption }) {
  const indexPath = new URL("index.html", ROOT);
  const html = readFileSync(indexPath, "utf8");
  const version = new Date().toISOString().slice(0, 10);
  const block =
    `<!-- DAILY:START -->\n` +
    `  <img src="${imagePath}?v=${version}" alt="Today's photo" class="daily-photo">\n` +
    `  <div class="daily-caption">${caption}</div>\n` +
    `  <!-- DAILY:END -->`;
  const updated = html.replace(/<!-- DAILY:START -->[\s\S]*?<!-- DAILY:END -->/, block);
  writeFileSync(indexPath, updated);
}

const { fileName, originalUrl } = await pickTodaysImage();
console.log(`Today's photo: ${fileName}`);

const original = await downloadImage(originalUrl);
console.log(`Downloaded original: ${(original.length / 1024 / 1024).toFixed(1)} MB`);

const resized = await sharp(original)
  .resize({ width: MAX_WIDTH, withoutEnlargement: true })
  .jpeg({ quality: JPEG_QUALITY })
  .toBuffer();
console.log(`Resized for publishing: ${(resized.length / 1024).toFixed(0)} KB`);

const imageDir = new URL("images/daily/", ROOT);
mkdirSync(imageDir, { recursive: true });
const imagePath = "images/daily/today.jpg";
writeFileSync(new URL(imagePath, ROOT), resized);

const caption = await generateCaption(resized, "image/jpeg");
console.log(`Caption: ${caption}`);

updateIndexHtml({ imagePath, caption });
console.log("index.html updated.");
