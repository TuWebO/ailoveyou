import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import OAuth from "oauth-1.0a";

function loadEnv() {
  const path = new URL("../.env", import.meta.url);
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
const oauth = OAuth({
  consumer: { key: env.SMUGMUG_API_KEY, secret: env.SMUGMUG_API_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function(baseString, key) {
    return createHmac("sha1", key).update(baseString).digest("base64");
  },
});
const token = { key: env.SMUGMUG_ACCESS_TOKEN, secret: env.SMUGMUG_ACCESS_TOKEN_SECRET };

export async function smugmugRequest(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.smugmug.com${pathOrUrl}`;
  const requestData = { url, method: "GET" };
  const res = await fetch(url, {
    headers: {
      ...oauth.toHeader(oauth.authorize(requestData, token)),
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SmugMug API ${res.status}: ${text}`);
  return JSON.parse(text);
}
