// Publishes today's already-generated photo/caption to Instagram.
// Must run after the image has been committed and pushed, since Instagram
// needs to fetch it from a public URL - this script waits for the deploy to
// actually go live before calling the Instagram API.
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const SITE_URL = "https://ailoveyou.ai";
const GRAPH_URL = "https://graph.instagram.com/v21.0";

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
const ACCESS_TOKEN = env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = env.INSTAGRAM_USER_ID;

if (!ACCESS_TOKEN || !IG_USER_ID) {
  console.error("Missing INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_USER_ID");
  process.exit(1);
}

function loadLog() {
  const logPath = new URL("daily-log.json", ROOT);
  return JSON.parse(readFileSync(logPath, "utf8"));
}

function saveLog(entries) {
  const logPath = new URL("daily-log.json", ROOT);
  writeFileSync(logPath, JSON.stringify(entries, null, 2) + "\n");
}

// A 200 response alone doesn't prove the *new* content is live - if a
// same-day rerun overwrote a filename that already existed, the URL already
// returned 200 before this run even started. Check the byte size actually
// matches what we just generated, not just that something responds.
async function waitUntilLive(url, expectedSize, { attempts = 20, delayMs = 15000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      const size = Number(res.headers.get("content-length"));
      if (res.ok && size === expectedSize) return true;
      console.log(`(${i}/${attempts}) ${url} -> ${res.status}, size ${size} (want ${expectedSize}), retrying in ${delayMs / 1000}s...`);
    } catch (err) {
      console.log(`(${i}/${attempts}) fetch failed (${err.message}), retrying in ${delayMs / 1000}s...`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function createContainer(imageUrl, caption) {
  const url = new URL(`${GRAPH_URL}/${IG_USER_ID}/media`);
  url.searchParams.set("image_url", imageUrl);
  url.searchParams.set("caption", caption);
  url.searchParams.set("access_token", ACCESS_TOKEN);
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(`Container creation failed: ${JSON.stringify(data)}`);
  return data.id;
}

async function waitUntilContainerReady(containerId, { attempts = 10, delayMs = 5000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const url = new URL(`${GRAPH_URL}/${containerId}`);
    url.searchParams.set("fields", "status_code");
    url.searchParams.set("access_token", ACCESS_TOKEN);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(`Container status check failed: ${JSON.stringify(data)}`);
    console.log(`(${i}/${attempts}) container status: ${data.status_code}`);
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR") throw new Error(`Container processing failed: ${JSON.stringify(data)}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("Container never finished processing");
}

async function publishContainer(containerId) {
  const url = new URL(`${GRAPH_URL}/${IG_USER_ID}/media_publish`);
  url.searchParams.set("creation_id", containerId);
  url.searchParams.set("access_token", ACCESS_TOKEN);
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(`Publish failed: ${JSON.stringify(data)}`);
  return data.id;
}

const date = new Date().toISOString().slice(0, 10);
const entries = loadLog();
const entryIndex = entries.findIndex((e) => e.date === date);
if (entryIndex === -1) {
  console.error(`No daily-log.json entry for ${date} - has generate-daily.mjs run yet today?`);
  process.exit(1);
}

const entry = entries[entryIndex];
if (entry.instagramMediaId) {
  console.log(`Already posted to Instagram today (media id ${entry.instagramMediaId}). Skipping.`);
  process.exit(0);
}

const imageUrl = `${SITE_URL}/${entry.image}${entry.version ? `?v=${entry.version}` : ""}`;
const expectedSize = statSync(new URL(entry.image, ROOT)).size;
console.log(`Waiting for ${imageUrl} to go live (expecting ${expectedSize} bytes)...`);
const live = await waitUntilLive(imageUrl, expectedSize);
if (!live) {
  console.error(`Gave up waiting for ${imageUrl} to go live. Skipping Instagram post for today.`);
  process.exit(1);
}
console.log("Image is live. Creating Instagram media container...");

const containerId = await createContainer(imageUrl, entry.caption);
console.log(`Container created: ${containerId}`);

await waitUntilContainerReady(containerId);

const mediaId = await publishContainer(containerId);
console.log(`Published to Instagram: media id ${mediaId}`);

entries[entryIndex] = { ...entry, instagramMediaId: mediaId };
saveLog(entries);
console.log("daily-log.json updated with instagramMediaId.");
