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
  const block =
    `<!-- DAILY:START -->\n` +
    `  <img src="${imagePath}" alt="Today's photo" class="daily-photo">\n` +
    `  <div class="daily-caption">${caption}</div>\n` +
    `  <!-- DAILY:END -->`;
  const updated = html.replace(/<!-- DAILY:START -->[\s\S]*?<!-- DAILY:END -->/, block);
  writeFileSync(indexPath, updated);
}

function loadLog(logPath) {
  if (!existsSync(logPath)) return [];
  return JSON.parse(readFileSync(logPath, "utf8"));
}

function updateLog({ date, imagePath, caption }) {
  const logPath = new URL("daily-log.json", ROOT);
  const entries = loadLog(logPath).filter((e) => e.date !== date);
  entries.push({ date, image: imagePath, caption });
  entries.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(logPath, JSON.stringify(entries, null, 2) + "\n");
  return entries;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateArchiveHtml(entries) {
  const items = entries
    .slice()
    .reverse()
    .map(
      (e) => `      <div class="archive-item">
        <img src="${e.image}" alt="${escapeHtml(e.date)}" class="archive-photo">
        <div class="archive-caption">${escapeHtml(e.caption)}</div>
        <div class="archive-date">${escapeHtml(e.date)}</div>
      </div>`
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AiLoveYou &mdash; Archive</title>
<meta name="description" content="Past daily photos and captions from AiLoveYou.ai.">
<link rel="icon" href="favicon.ico" type="image/x-icon">
<style>
  body, html { margin: 0; font-family: Arial, sans-serif; text-align: center; background-color: #f8f8f8; }
  body { display: flex; flex-direction: column; min-height: 100vh; }
  header { width: 100%; box-sizing: border-box; padding: 10px 20px; background-color: #fff; box-shadow: 0 2px 4px rgba(0,0,0,0.1); position: fixed; top: 0; left: 0; z-index: 1000; display: flex; align-items: center; justify-content: flex-start; gap: 10px; }
  .header-logo { width: 32px; height: 32px; border-radius: 50%; }
  .header-title { font-size: 1.5em; color: #333; }
  .header-title a { color: inherit; text-decoration: none; }
  .container { flex: 1; max-width: 900px; margin: 70px auto 0; padding: 0 20px 60px; }
  h1 { font-size: 1.3em; color: #333; }
  .archive-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 24px; margin-top: 20px; }
  .archive-item { background: #fff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.1); overflow: hidden; padding-bottom: 12px; }
  .archive-photo { width: 100%; display: block; }
  .archive-caption { margin: 12px 16px 4px; font-size: 0.95em; font-style: italic; color: #555; }
  .archive-date { font-size: 0.8em; color: #999; margin: 0 16px; }
  footer { padding: 20px 16px 32px; color: #999; font-size: 0.85em; border-top: 1px solid #e5e5e5; }
</style>
</head>
<body>
<header>
  <img src="images/ailoveyou-logo.png" alt="AiLoveYou.ai Logo" class="header-logo">
  <div class="header-title"><a href="index.html">AiLoveYou</a></div>
</header>
<div class="container">
  <h1>Past days</h1>
  <div class="archive-grid">
${items}
  </div>
</div>
<footer>
  <p>AiLoveYou.ai &mdash; a little love, every day.</p>
</footer>
</body>
</html>
`;

  writeFileSync(new URL("archive.html", ROOT), html);
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

const date = new Date().toISOString().slice(0, 10);
const imageDir = new URL("images/daily/", ROOT);
mkdirSync(imageDir, { recursive: true });
const imagePath = `images/daily/${date}.jpg`;
writeFileSync(new URL(imagePath, ROOT), resized);

const caption = await generateCaption(resized, "image/jpeg");
console.log(`Caption: ${caption}`);

updateIndexHtml({ imagePath, caption });
console.log("index.html updated.");

const entries = updateLog({ date, imagePath, caption });
updateArchiveHtml(entries);
console.log(`Archive updated (${entries.length} entries).`);
