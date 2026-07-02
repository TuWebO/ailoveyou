// One-time OAuth 1.0a handshake to mint a permanent SmugMug read-only access token.
// Usage:
//   node scripts/smugmug-auth.mjs request            -> prints an authorize URL
//   node scripts/smugmug-auth.mjs exchange <6-digit code>  -> saves access token to .env
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import OAuth from "oauth-1.0a";

const ENV_PATH = new URL("../.env", import.meta.url);
const REQUEST_TOKEN_PATH = new URL("../.smugmug-request-token.json", import.meta.url);

function loadEnv() {
  const env = {};
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  return env;
}

function saveEnvValues(updates) {
  const env = loadEnv();
  Object.assign(env, updates);
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
}

const env = loadEnv();
if (!env.SMUGMUG_API_KEY || !env.SMUGMUG_API_SECRET) {
  console.error("Missing SMUGMUG_API_KEY / SMUGMUG_API_SECRET in .env — fill those in first.");
  process.exit(1);
}

const oauth = OAuth({
  consumer: { key: env.SMUGMUG_API_KEY, secret: env.SMUGMUG_API_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function(baseString, key) {
    return createHmac("sha1", key).update(baseString).digest("base64");
  },
});

async function requestToken() {
  const requestData = {
    url: "https://api.smugmug.com/services/oauth/1.0a/getRequestToken",
    method: "GET",
    data: { oauth_callback: "oob" },
  };
  const res = await fetch(requestData.url + "?oauth_callback=oob", {
    headers: oauth.toHeader(oauth.authorize(requestData)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`getRequestToken failed: ${res.status} ${text}`);
  const params = new URLSearchParams(text);
  const token = params.get("oauth_token");
  const secret = params.get("oauth_token_secret");
  if (!token || !secret) throw new Error(`Unexpected response: ${text}`);

  writeFileSync(REQUEST_TOKEN_PATH, JSON.stringify({ token, secret }, null, 2));

  const authorizeUrl = `https://api.smugmug.com/services/oauth/1.0a/authorize?oauth_token=${token}&Access=Public&Permissions=Read`;
  console.log("\nOpen this URL, log in, and authorize (read-only, public access):\n");
  console.log(authorizeUrl);
  console.log("\nThen run: node scripts/smugmug-auth.mjs exchange <6-digit code>\n");
}

async function exchangeToken(verifier) {
  if (!existsSync(REQUEST_TOKEN_PATH)) {
    throw new Error("No request token found — run the 'request' step first.");
  }
  const { token, secret } = JSON.parse(readFileSync(REQUEST_TOKEN_PATH, "utf8"));

  const requestData = {
    url: "https://api.smugmug.com/services/oauth/1.0a/getAccessToken",
    method: "GET",
    data: { oauth_token: token, oauth_verifier: verifier },
  };
  const res = await fetch(
    `${requestData.url}?oauth_token=${token}&oauth_verifier=${verifier}`,
    { headers: oauth.toHeader(oauth.authorize(requestData, { key: token, secret })) }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`getAccessToken failed: ${res.status} ${text}`);
  const params = new URLSearchParams(text);
  const accessToken = params.get("oauth_token");
  const accessSecret = params.get("oauth_token_secret");
  if (!accessToken || !accessSecret) throw new Error(`Unexpected response: ${text}`);

  saveEnvValues({
    SMUGMUG_ACCESS_TOKEN: accessToken,
    SMUGMUG_ACCESS_TOKEN_SECRET: accessSecret,
  });
  console.log("\nSaved SMUGMUG_ACCESS_TOKEN and SMUGMUG_ACCESS_TOKEN_SECRET to .env (not printed here).");
}

const [, , cmd, arg] = process.argv;
if (cmd === "request") {
  await requestToken();
} else if (cmd === "exchange" && arg) {
  await exchangeToken(arg);
} else {
  console.error("Usage: node scripts/smugmug-auth.mjs request | exchange <code>");
  process.exit(1);
}
