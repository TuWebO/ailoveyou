// Helper for tagging daily photos with beaches.
//
//   node scripts/find-beach.mjs <query>                search beaches by name/town
//   node scripts/find-beach.mjs --set <date> <beachId> tag a daily-log.json entry
//
// Search is accent-insensitive ("oyambre" finds Playa de Oyambre). --set
// validates both the date (must exist in daily-log.json) and the beach id
// (must exist in data/beaches.json) before writing.
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);
const MAX_RESULTS = 15;

function fold(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function loadBeaches() {
  return JSON.parse(readFileSync(new URL("data/beaches.json", ROOT), "utf8"));
}

function search(query) {
  const needle = fold(query);
  const results = loadBeaches().filter((b) =>
    fold([b.name, ...b.alternateNames, b.location.municipality, b.location.province].join(" ")).includes(needle)
  );

  if (results.length === 0) {
    console.log(`No beaches match "${query}".`);
    return;
  }
  for (const b of results.slice(0, MAX_RESULTS)) {
    const loc = b.location;
    console.log(
      `${b.id}  ${b.name}` +
        (b.alternateNames.length ? ` (${b.alternateNames.join(", ")})` : "") +
        `  —  ${loc.municipality}, ${loc.province} (${loc.autonomousCommunity})` +
        `  https://maps.google.com/?q=${loc.latitude},${loc.longitude}`
    );
  }
  if (results.length > MAX_RESULTS) {
    console.log(`…and ${results.length - MAX_RESULTS} more. Narrow the query to see them.`);
  }
}

function setBeachId(date, beachId) {
  const beach = loadBeaches().find((b) => b.id === beachId);
  if (!beach) {
    console.error(`Beach id "${beachId}" does not exist in data/beaches.json.`);
    process.exit(1);
  }

  const logPath = new URL("daily-log.json", ROOT);
  const entries = JSON.parse(readFileSync(logPath, "utf8"));
  const entry = entries.find((e) => e.date === date);
  if (!entry) {
    console.error(`No daily-log.json entry for date "${date}". Existing dates: ${entries.map((e) => e.date).join(", ")}`);
    process.exit(1);
  }

  entry.beachId = beachId;
  writeFileSync(logPath, JSON.stringify(entries, null, 2) + "\n");
  console.log(`Tagged ${date} -> ${beachId} (${beach.name}, ${beach.location.municipality}).`);
}

const args = process.argv.slice(2);
if (args[0] === "--set") {
  if (args.length !== 3) {
    console.error("Usage: node scripts/find-beach.mjs --set <YYYY-MM-DD> <ES-xxxxxx>");
    process.exit(1);
  }
  setBeachId(args[1], args[2]);
} else if (args.length > 0) {
  search(args.join(" "));
} else {
  console.error("Usage: node scripts/find-beach.mjs <query> | --set <YYYY-MM-DD> <ES-xxxxxx>");
  process.exit(1);
}
