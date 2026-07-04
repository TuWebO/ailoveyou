// Daily PoC pipeline: pick a photo from the SmugMug "Stock" album,
// ask Claude to write a short love-themed caption for it, and update index.html.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import sharp from "sharp";
import { smugmugRequest } from "./smugmug-client.mjs";

const ALBUM_KEY = "6v3DvK"; // "Stock" album (password-protected, owner-accessible)
const MAX_WIDTH = 1600;
const JPEG_QUALITY = 82;
const PAGE_SIZE = 100;
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

async function fetchAllAlbumImages() {
  const album = await smugmugRequest(`/api/v2/album/${ALBUM_KEY}`);
  const imagesUri = album.Response.Album.Uris.AlbumImages.Uri;

  const all = [];
  let start = 1;
  for (;;) {
    const page = await smugmugRequest(`${imagesUri}?count=${PAGE_SIZE}&start=${start}`);
    const items = page.Response.AlbumImage ?? [];
    all.push(...items);
    const total = page.Response.Pages?.Total ?? all.length;
    if (items.length === 0 || all.length >= total) break;
    start += PAGE_SIZE;
  }

  all.sort((a, b) => a.FileName.localeCompare(b.FileName));
  return all;
}

function loadRotationState(path) {
  if (!existsSync(path)) return { usedImageKeys: [] };
  return JSON.parse(readFileSync(path, "utf8"));
}

// Picks the day's photo without ever re-deriving position from the album's
// current size: reruns on the same date reuse whatever was already picked,
// and new picks always draw from images not yet used in the current cycle.
// This way adding/removing photos from the album can't reshuffle picks that
// were already made, and the same photo can't repeat until every photo in
// the album has had a turn.
function pickImageForToday({ images, existingEntry, rotationState }) {
  if (images.length === 0) throw new Error("Album has no images");

  if (existingEntry?.imageKey) {
    const alreadyChosen = images.find((img) => img.ImageKey === existingEntry.imageKey);
    if (alreadyChosen) return { chosen: alreadyChosen, usedImageKeys: rotationState.usedImageKeys };
  }

  const usedKeys = new Set(rotationState.usedImageKeys);
  let unused = images.filter((img) => !usedKeys.has(img.ImageKey));
  if (unused.length === 0) {
    usedKeys.clear();
    unused = images;
  }

  const chosen = unused[0];
  usedKeys.add(chosen.ImageKey);
  return { chosen, usedImageKeys: [...usedKeys] };
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

const SITE_URL = "https://ailoveyou.ai";
const SHARE_IMAGE = "images/ailoveyou-share.jpg";

function updateIndexHtml({ imagePath, caption, width, height }) {
  const indexPath = new URL("index.html", ROOT);
  const html = readFileSync(indexPath, "utf8");
  const escapedCaption = escapeHtml(caption);

  const dailyBlock =
    `<!-- DAILY:START -->\n` +
    `  <img src="${imagePath}" alt="${escapedCaption}" class="daily-photo" width="${width}" height="${height}" fetchpriority="high">\n` +
    `  <div class="daily-caption">${caption}</div>\n` +
    `  <!-- DAILY:END -->`;

  const seoBlock =
    `<!-- SEO:START -->\n` +
    `<meta property="og:type" content="website">\n` +
    `<meta property="og:url" content="${SITE_URL}/">\n` +
    `<meta property="og:site_name" content="AiLoveYou.ai">\n` +
    `<meta property="og:title" content="AiLoveYou &mdash; Hey, I love you.">\n` +
    `<meta property="og:description" content="${escapedCaption}">\n` +
    `<meta property="og:image" content="${SITE_URL}/${SHARE_IMAGE}">\n` +
    `<meta name="twitter:card" content="summary_large_image">\n` +
    `<meta name="twitter:title" content="AiLoveYou &mdash; Hey, I love you.">\n` +
    `<meta name="twitter:description" content="${escapedCaption}">\n` +
    `<meta name="twitter:image" content="${SITE_URL}/${SHARE_IMAGE}">\n` +
    `<!-- SEO:END -->`;

  const updated = html
    .replace(/<!-- DAILY:START -->[\s\S]*?<!-- DAILY:END -->/, dailyBlock)
    .replace(/<!-- SEO:START -->[\s\S]*?<!-- SEO:END -->/, seoBlock);
  writeFileSync(indexPath, updated);
}

function loadLog(logPath) {
  if (!existsSync(logPath)) return [];
  return JSON.parse(readFileSync(logPath, "utf8"));
}

function updateLog({ date, imagePath, imageKey, caption, width, height }) {
  const logPath = new URL("daily-log.json", ROOT);
  const entries = loadLog(logPath).filter((e) => e.date !== date);
  entries.push({ date, image: imagePath, imageKey, caption, width, height });
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
        <img src="${e.image}" alt="${escapeHtml(e.caption)}" class="archive-photo" width="${e.width}" height="${e.height}" loading="lazy">
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
<link rel="canonical" href="${SITE_URL}/archive.html">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE_URL}/archive.html">
<meta property="og:site_name" content="AiLoveYou.ai">
<meta property="og:title" content="AiLoveYou &mdash; Archive">
<meta property="og:description" content="Past daily photos and captions from AiLoveYou.ai.">
<meta property="og:image" content="${SITE_URL}/images/ailoveyou-logo.png">
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
  .archive-photo { width: 100%; height: auto; display: block; }
  .archive-caption { margin: 12px 16px 4px; font-size: 0.95em; font-style: italic; color: #555; }
  .archive-date { font-size: 0.8em; color: #707070; margin: 0 16px; }
  footer { padding: 20px 16px 32px; color: #707070; font-size: 0.85em; border-top: 1px solid #e5e5e5; }
  footer a { color: #707070; }
  footer p { margin: 6px 0; }
  .nav-link { margin: 10px 0 0; font-size: 0.95em; }
  .nav-link a { color: #707070; }
</style>
</head>
<body>
<header>
  <img src="images/ailoveyou-logo.png" alt="AiLoveYou.ai Logo" class="header-logo" width="32" height="32">
  <div class="header-title"><a href="/">AiLoveYou</a></div>
</header>
<main class="container">
  <h1>Past days</h1>
  <p class="nav-link"><a href="/">&larr; Home</a></p>
  <div class="archive-grid">
${items}
  </div>
</main>
<footer>
  <p>AiLoveYou.ai &mdash; a little love, every day.</p>
  <p>Photos &copy; 2026 tusesiondesurf.com. All rights reserved.</p>
</footer>
</body>
</html>
`;

  writeFileSync(new URL("archive.html", ROOT), html);
}

const date = new Date().toISOString().slice(0, 10);
const rotationStatePath = new URL("rotation-state.json", ROOT);
const rotationState = loadRotationState(rotationStatePath);
const existingEntry = loadLog(new URL("daily-log.json", ROOT)).find((e) => e.date === date);

const images = await fetchAllAlbumImages();
const { chosen, usedImageKeys } = pickImageForToday({ images, existingEntry, rotationState });
console.log(`Today's photo: ${chosen.FileName} (${chosen.ImageKey})`);
writeFileSync(rotationStatePath, JSON.stringify({ usedImageKeys }, null, 2) + "\n");

const sizes = await smugmugRequest(chosen.Uris.ImageSizeDetails.Uri);
const originalUrl = sizes.Response.ImageSizeDetails.ImageSizeOriginal.Url;

const original = await downloadImage(originalUrl);
console.log(`Downloaded original: ${(original.length / 1024 / 1024).toFixed(1)} MB`);

const { data: resizedRaw, info } = await sharp(original)
  .resize({ width: MAX_WIDTH, withoutEnlargement: true })
  .jpeg({ quality: JPEG_QUALITY })
  .toBuffer({ resolveWithObject: true });

// Embed copyright metadata into the already-stripped buffer (not the camera
// original), so this only ever adds our own notice - never the original
// photo's GPS/lens/serial EXIF, which we deliberately strip above.
const resized = await sharp(resizedRaw)
  .withMetadata({
    exif: {
      IFD0: {
        Copyright: "Copyright tusesiondesurf.com. All rights reserved.",
        Artist: "tusesiondesurf.com",
      },
    },
  })
  .jpeg({ quality: JPEG_QUALITY })
  .toBuffer();
console.log(`Resized for publishing: ${(resized.length / 1024).toFixed(0)} KB (${info.width}x${info.height})`);

const imageDir = new URL("images/daily/", ROOT);
mkdirSync(imageDir, { recursive: true });
const imagePath = `images/daily/${date}.jpg`;
writeFileSync(new URL(imagePath, ROOT), resized);

const caption = await generateCaption(resized, "image/jpeg");
console.log(`Caption: ${caption}`);

const width = info.width;
const height = info.height;

updateIndexHtml({ imagePath, caption, width, height });
console.log("index.html updated.");

const entries = updateLog({ date, imagePath, imageKey: chosen.ImageKey, caption, width, height });
updateArchiveHtml(entries);
console.log(`Archive updated (${entries.length} entries).`);
