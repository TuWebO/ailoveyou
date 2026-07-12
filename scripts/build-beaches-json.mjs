// Builds data/beaches.json from the raw MITECO "Guía de Playas" export:
// data/raw/playas_espanolas.csv (authoritative for most fields) joined
// positionally with data/raw/beaches_clean.parquet (canonical beach_id,
// coordinates, description). The positional join is re-verified per row
// (name + coordinates + description must match) and any mismatch aborts
// the build - the two files must describe the same beach at the same index.
//
// The parquet's own length_m/width_m are NOT used: they are garbled for
// every thousands-dot value in the source ("1.100 metros" -> 50), so
// lengths, widths and distances are parsed from the CSV strings here.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

const ROOT = new URL("..", import.meta.url);
const CSV_PATH = new URL("data/raw/playas_espanolas.csv", ROOT);
const PARQUET_PATH = new URL("data/raw/beaches_clean.parquet", ROOT);
// Full build artifact: everything, including embeddingText (for the RAG
// indexer) and the *Raw audit fields for the two still-unconfirmed columns
// (Establec_1/otherEstablishments, Servicio_l/cleaningService). Alquiler_n
// (nautical rental) and Establecim (chiringuito/food) were confirmed against
// RTVE's filter UI built on this same dataset, so their Raw siblings are gone.
const OUT_FULL_PATH = new URL("data/beaches-full.json", ROOT);
// Slim public version fetched by beach.html (per-beach detail page).
const OUT_SLIM_PATH = new URL("data/beaches.json", ROOT);
// Card-page index fetched by beaches.html: only the fields its cards,
// filters and search use, with descriptions truncated - half the transfer
// size of the slim file, which is what mobile Lighthouse LCP hinges on.
const OUT_INDEX_PATH = new URL("data/beaches-index.json", ROOT);
// Hand-maintained corrections applied on top of the parsed CSV data as the
// final build step - never edit the raw MITECO CSV for one-off fixes.
// Format: { "ES-000123": { "services.surfZone": true, ... }, ... }
const OVERRIDES_PATH = new URL("data/beach-overrides.json", ROOT);
const EXPECTED_ROWS = 3551;

// Fields that do not exist in the MITECO dataset, stamped into a "custom"
// section on every beach with these defaults (null = unknown, never false).
// Declaring a field here is what makes it settable via beach-overrides.json
// ("custom.dogFriendly": true) - the overrides typo-check requires paths to
// exist. Add new community-knowledge fields here, one line each.
const CUSTOM_FIELD_DEFAULTS = {
  dogFriendly: null,
};

// ---------- CSV parsing (RFC 4180: quoted fields, "" escapes, BOM) ----------

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvToObjects(text) {
  const [header, ...rows] = parseCsv(text);
  return rows
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// ---------- Field normalization ----------

// Collected while building, printed in the validation report.
const warnings = { unexpectedValues: {}, unparseable: {} };

function warnUnexpected(field, value) {
  (warnings.unexpectedValues[field] ??= new Map()).set(
    value,
    (warnings.unexpectedValues[field]?.get(value) ?? 0) + 1
  );
}

function warnUnparseable(field, value) {
  (warnings.unparseable[field] ??= []).push(value);
}

function trimOrNull(v) {
  const s = (v ?? "").trim();
  return s === "" || s === "-" ? null : s;
}

function toBool(field, v) {
  const s = trimOrNull(v);
  if (s === null) return null;
  const l = s.toLowerCase();
  if (l === "sí" || l === "si") return true;
  if (l === "no") return false;
  warnUnexpected(field, s);
  return null;
}

// Known enum vocabulary: fixes casing slop ("bajo", "SemiUrbana", "banderas")
// without touching free-ish text like "Interurbano, Línea 115".
const ENUM_CANON = new Map(
  [
    "Alto", "Medio", "Bajo", "Muy bajo", "Nulo",
    "Urbana", "Semiurbana", "Aislada", "Playa natural",
    "Poca", "Mucha", "Media", "Estable", "Variable", "Regresión",
    "Dorada", "Blanca", "Oscura", "Grisácea",
    "Arena", "Grava", "Roca", "Bolos",
    "Aguas tranquilas", "Oleaje moderado", "Oleaje fuerte", "Ventosa",
    "Montaña", "Acantilado", "Dunas", "Humedal",
    "Urbano", "Interurbano",
    "Completo", "Parcial",
    "Banderas", "Temporada estival",
    "A pie fácil", "A pie difícil", "A pie", "Coche", "Barco",
  ].map((v) => [v.toLowerCase(), v])
);

function normalizeEnum(v) {
  const s = trimOrNull(v);
  if (s === null) return null;
  return s
    .split("/")
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => ENUM_CANON.get(seg.toLowerCase()) ?? seg)
    .join(" / ");
}

const NUDISM_MAP = new Map([
  ["no", "no"],
  ["sí", "yes"],
  ["si", "yes"],
  ["parcial", "partial"],
  ["tolerado", "tolerated"],
]);

function normalizeNudism(v) {
  const s = trimOrNull(v);
  if (s === null) return null;
  const mapped = NUDISM_MAP.get(s.toLowerCase());
  if (mapped === undefined) {
    warnUnexpected("Nudismo", s);
    return null;
  }
  return mapped;
}

// ---------- Numeric parsing ----------

// Matches "650", "1.100" (dot = thousands), "7,1" (comma = decimal).
const NUM = "\\d{1,3}(?:\\.\\d{3})+|\\d+(?:,\\d+)?";

function parseNumberToken(tok) {
  const t = tok.trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ""));
  return Number(t.replace(",", "."));
}

function parseLengthM(raw) {
  const s = trimOrNull(raw);
  if (s === null) return null;
  // Leading number, optionally followed by a unit; trailing commentary
  // ("(sólo 222 de playa)") is ignored - the headline figure wins.
  const m = s.match(new RegExp(`^(${NUM})(?:\\s*(?:metros?|m)\\.?(?:\\s|$|\\()|$)`, "i"));
  if (m) return parseNumberToken(m[1]);
  // Rare range form "70-80 metros": use the midpoint (raw kept in lengthRaw).
  const range = s.match(new RegExp(`^(${NUM})\\s*-\\s*(${NUM})\\s*(?:metros?|m)\\.?`, "i"));
  if (range) return Math.round((parseNumberToken(range[1]) + parseNumberToken(range[2])) / 2);
  warnUnparseable("Longitud", s);
  return null;
}

function parseWidth(raw) {
  const out = { widthM: null, widthMinM: null, widthMaxM: null };
  const s = trimOrNull(raw);
  if (s === null) return out;
  const lower = s.toLowerCase();

  // Tidal pair: "100 bajamar 30 pleamar (metros)". Low tide (bajamar)
  // exposes the widest beach, high tide (pleamar) the narrowest.
  if (lower.includes("bajamar") && lower.includes("pleamar")) {
    const baj = lower.match(new RegExp(`(${NUM})[^\\d]*bajamar`));
    const ple = lower.match(new RegExp(`(${NUM})[^\\d]*pleamar`));
    if (baj && ple) {
      const a = parseNumberToken(baj[1]);
      const b = parseNumberToken(ple[1]);
      out.widthMinM = Math.min(a, b);
      out.widthMaxM = Math.max(a, b);
      return out;
    }
  }

  // "De 5 a 30 metros", "Entre 180 y 200 metros" (order is inconsistent)
  let m = s.match(
    new RegExp(`^(?:de\\s+(${NUM})\\s+a|entre\\s+(${NUM})\\s+y)\\s+(${NUM})`, "i")
  );
  if (m) {
    const a = parseNumberToken(m[1] ?? m[2]);
    const b = parseNumberToken(m[3]);
    out.widthMinM = Math.min(a, b);
    out.widthMaxM = Math.max(a, b);
    return out;
  }

  // "20 ± 5 metros"
  m = s.match(new RegExp(`^(${NUM})\\s*±\\s*(${NUM})`));
  if (m) {
    const mid = parseNumberToken(m[1]);
    const delta = parseNumberToken(m[2]);
    out.widthMinM = mid - delta;
    out.widthMaxM = mid + delta;
    return out;
  }

  // "15 - 7 metros", "20/50 metros" (order in the source is inconsistent)
  m = s.match(new RegExp(`^(${NUM})\\s*[-/]\\s*(${NUM})`));
  if (m) {
    const a = parseNumberToken(m[1]);
    const b = parseNumberToken(m[2]);
    out.widthMinM = Math.min(a, b);
    out.widthMaxM = Math.max(a, b);
    return out;
  }

  // Single value: "35 metros", bare "20", "10 metros variables", ...
  m = s.match(new RegExp(`^(${NUM})(?:\\s|$|\\s*(?:metros?|m)\\.?)`, "i"));
  if (m) {
    out.widthM = parseNumberToken(m[1]);
    return out;
  }

  warnUnparseable("Anchura", s);
  return out;
}

function parseDistanceKm(field, raw) {
  const s = trimOrNull(raw);
  if (s === null) return null;
  if (/al lado/i.test(s)) return 0;
  // First "N km" figure; in "12 mn + 55 km." the nautical-mile leg is
  // skipped because "12" is not followed by km.
  let m = s.match(new RegExp(`(${NUM})\\s*km`, "i"));
  if (m) return parseNumberToken(m[1]);
  m = s.match(new RegExp(`(${NUM})\\s*(?:metros?|m)\\.?(?:\\s|$)`, "i"));
  if (m) return Math.round(parseNumberToken(m[1])) / 1000;
  warnUnparseable(field, s);
  return null;
}

// ---------- Per-beach assembly ----------

function parseAlternateNames(...fields) {
  const seen = new Set();
  const names = [];
  for (const field of fields) {
    for (const part of (field ?? "").split(",")) {
      const name = part.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

function parseParkingSupervised(v) {
  const s = trimOrNull(v);
  if (s === null) return null;
  const l = s.toLowerCase();
  if (l === "vigilado") return true;
  if (l === "no vigilado") return false;
  warnUnexpected("Aparcami_1", s);
  return null;
}

const SERVICE_LABELS = [
  [(b) => b.services.restrooms, "restrooms"],
  [(b) => b.services.showers, "showers"],
  [(b) => b.services.footShowers, "foot showers"],
  [(b) => b.services.trashBins, "trash bins"],
  [(b) => b.services.publicPhones, "public phones"],
  [(b) => b.services.rentalUmbrellas, "umbrella rental"],
  [(b) => b.services.rentalLoungers, "lounger rental"],
  [(b) => b.services.rentalOther, "nautical rental"],
  [(b) => b.services.foodKiosk, "food establishments"],
  [(b) => b.services.touristOffice, "tourist office"],
  [(b) => b.services.playground, "playground"],
  [(b) => b.services.sportsArea, "sports area"],
  [(b) => b.services.nauticalClub, "nautical club"],
  [(b) => b.services.divingZone, "diving"],
  [(b) => b.services.surfZone, "surfing"],
  [(b) => b.services.cleaningService, "beach cleaning"],
  [(b) => b.access.parking, "parking"],
  [(b) => b.access.busAccess, "bus access"],
  [(b) => b.access.boardwalk, "boardwalk"],
  [(b) => b.safety.lifeguardService, "lifeguard"],
];

function buildEmbeddingText(b) {
  const parts = [
    `${b.name}, in ${b.location.municipality}, ${b.location.province} (${b.location.autonomousCommunity}).`,
  ];
  if (b.description) parts.push(/[.!?]$/.test(b.description) ? b.description : `${b.description}.`);
  if (b.physical.lengthM !== null) {
    let sentence = `${b.physical.lengthM}m long`;
    if (b.physical.sandType) sentence += `, ${b.physical.sandType.toLowerCase()} sand`;
    parts.push(`${sentence}.`);
  } else if (b.physical.sandType) {
    parts.push(`${b.physical.sandType} sand.`);
  }
  if (b.physical.occupancyLevel) parts.push(`Occupancy: ${b.physical.occupancyLevel}.`);
  if (b.physical.urbanizationLevel) parts.push(`${b.physical.urbanizationLevel} beach.`);
  const services = SERVICE_LABELS.filter(([get]) => get(b) === true).map(([, label]) => label);
  if (services.length > 0) parts.push(`Services: ${services.join(", ")}.`);
  if (b.environment.blueFlag) parts.push("Blue Flag certified.");
  if (b.access.wheelchairAccessible) parts.push("Wheelchair accessible.");
  if (["yes", "partial", "tolerated"].includes(b.physical.nudism)) parts.push("Nudist beach.");
  if (b.custom.dogFriendly === true) parts.push("Dog friendly.");
  if (b.environment.inProtectedArea && b.environment.protectedAreaName) {
    parts.push(`In protected area: ${b.environment.protectedAreaName}.`);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function buildBeach(csv, pq) {
  const beach = {
    id: pq.beach_id,
    name: pq.name_local,
    alternateNames: parseAlternateNames(csv["Nombre_alt"], csv["Nombre_a_1"]),
    location: {
      municipality: csv["Término_M"].trim(),
      province: csv["Provincia"].trim(),
      autonomousCommunity: csv["Comunidad_"].trim(),
      island: trimOrNull(csv["Isla"]),
      municipalityIneCode: csv["Código_IN"].trim(),
      municipalityWebsite: trimOrNull(csv["Web_munici"]),
      latitude: pq.latitude,
      longitude: pq.longitude,
    },
    description: pq.description_local.trim(),
    notes: trimOrNull(csv["Observacio"]),
    physical: {
      lengthM: parseLengthM(csv["Longitud"]),
      lengthRaw: trimOrNull(csv["Longitud"]),
      ...parseWidth(csv["Anchura"]),
      widthRaw: trimOrNull(csv["Anchura"]),
      widthVariation: normalizeEnum(csv["Variación"]),
      sandType: normalizeEnum(csv["Tipo_de_ar"]),
      sandComposition: normalizeEnum(csv["Composici"]),
      waterConditions: normalizeEnum(csv["Condicione"]),
      occupancyLevel: normalizeEnum(csv["Grado_ocup"]),
      urbanizationLevel: normalizeEnum(csv["Grado_urba"]),
      coastalLandscape: normalizeEnum(csv["Fachada_Li"]),
      nudism: normalizeNudism(csv["Nudismo"]),
    },
    access: {
      mode: normalizeEnum(csv["Forma_de_a"]),
      road: trimOrNull(csv["Carretera_"]),
      signposted: toBool("Señaliza1", csv["Señaliza1"]),
      busAccess: toBool("Autobús", csv["Autobús"]),
      busType: normalizeEnum(csv["Autobús_t"]),
      wheelchairAccessible: toBool("Acceso_dis", csv["Acceso_dis"]),
      boardwalk: toBool("Paseo_mar", csv["Paseo_mar"]),
      boardwalkType: normalizeEnum(csv["Tipo_paseo"]),
      parking: toBool("Aparcamien", csv["Aparcamien"]),
      parkingSupervised: parseParkingSupervised(csv["Aparcami_1"]),
      parkingCapacity: trimOrNull(csv["Aparcami_2"]),
    },
    services: {
      restrooms: toBool("Aseos", csv["Aseos"]),
      showers: toBool("Duchas", csv["Duchas"]),
      footShowers: toBool("Lavapies", csv["Lavapies"]),
      trashBins: toBool("Papelera", csv["Papelera"]),
      publicPhones: toBool("Teléfonos", csv["Teléfonos"]),
      rentalUmbrellas: toBool("Alquiler_s", csv["Alquiler_s"]),
      rentalLoungers: toBool("Alquiler_h", csv["Alquiler_h"]),
      rentalOther: toBool("Alquiler_n", csv["Alquiler_n"]),
      foodKiosk: toBool("Establecim", csv["Establecim"]),
      otherEstablishments: toBool("Establec_1", csv["Establec_1"]),
      otherEstablishmentsRaw: trimOrNull(csv["Establec_1"]),
      touristOffice: toBool("Oficina_tu", csv["Oficina_tu"]),
      playground: toBool("Zona_infan", csv["Zona_infan"]),
      sportsArea: toBool("Zona_depor", csv["Zona_depor"]),
      nauticalClub: toBool("Club_naút", csv["Club_naút"]),
      divingZone: toBool("Submarinis", csv["Submarinis"]),
      surfZone: toBool("Zona_Surf", csv["Zona_Surf"]),
      cleaningService: toBool("Servicio_l", csv["Servicio_l"]),
      cleaningServiceRaw: trimOrNull(csv["Servicio_l"]),
    },
    safety: {
      lifeguardService: toBool("Auxilio_y_", csv["Auxilio_y_"]),
      lifeguardHours: trimOrNull(csv["Auxilio_y1"]),
      signage: toBool("Señalizac", csv["Señalizac"]),
      signageType: normalizeEnum(csv["Señaliza_"]),
      anchorageZone: toBool("Zona_fonde", csv["Zona_fonde"]),
    },
    environment: {
      blueFlag: toBool("Bandera_az", csv["Bandera_az"]),
      vegetation: toBool("Vegetació", csv["Vegetació"]),
      vegetationLocation: trimOrNull(csv["Vegetaci_1"]),
      environmentalActions: toBool("Actuacione", csv["Actuacione"]),
      environmentalActionsDescription: trimOrNull(csv["Actuacio_1"]),
      inProtectedArea: toBool("Espacio_pr", csv["Espacio_pr"]),
      protectedAreaName: trimOrNull(csv["Espacio__1"]),
    },
    nearby: {
      marina: trimOrNull(csv["Puerto_dep"]),
      marinaWebsite: trimOrNull(csv["Web_puerto"]),
      distanceToMarinaKm: parseDistanceKm("Distancia_", csv["Distancia_"]),
      hospital: trimOrNull(csv["Hospital"]),
      hospitalAddress: trimOrNull(csv["Dirección"]),
      hospitalPhone: trimOrNull(csv["Teléfono_"]),
      distanceToHospitalKm: parseDistanceKm("Distancia1", csv["Distancia1"]),
    },
    custom: { ...CUSTOM_FIELD_DEFAULTS },
    officialSourceUrl: csv["URL_MAGRAM"].trim(),
    embeddingText: "",
  };
  beach.embeddingText = buildEmbeddingText(beach);
  return beach;
}

// ---------- Positional join verification ----------

function verifyJoin(csvRows, pqRows) {
  const errors = [];
  for (let i = 0; i < csvRows.length; i++) {
    const csv = csvRows[i];
    const pq = pqRows[i];
    const expectedId = `ES-${String(i + 1).padStart(6, "0")}`;
    if (pq.beach_id !== expectedId) errors.push(`row ${i + 1}: beach_id ${pq.beach_id} != ${expectedId}`);
    if (pq.name_local.trim() !== csv["Nombre"].trim()) {
      errors.push(`row ${i + 1}: name "${pq.name_local}" != "${csv["Nombre"]}"`);
    }
    if (Math.abs(pq.longitude - Number(csv["X"])) > 1e-9 || Math.abs(pq.latitude - Number(csv["Y"])) > 1e-9) {
      errors.push(`row ${i + 1}: coordinates diverge (${pq.longitude},${pq.latitude}) vs (${csv["X"]},${csv["Y"]})`);
    }
    if (pq.description_local.trim() !== csv["Descripci"].trim()) {
      errors.push(`row ${i + 1}: description diverges`);
    }
    if (errors.length >= 10) break;
  }
  if (errors.length > 0) {
    console.error("Positional join verification FAILED:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
}

// ---------- Manual overrides ----------

// Sets a dot-path field ("services.surfZone") on a beach object. Every path
// segment, including the final key, must already exist in the schema - a
// typo in the hand-edited overrides file must fail the build, not silently
// add a new field.
function setByPath(beach, id, path, value) {
  const segments = path.split(".");
  let target = beach;
  for (const seg of segments.slice(0, -1)) {
    if (target === null || typeof target !== "object" || !Object.hasOwn(target, seg)) {
      console.error(`FATAL: override for ${id}: path "${path}" does not exist in the beach schema (at "${seg}").`);
      process.exit(1);
    }
    target = target[seg];
  }
  const last = segments.at(-1);
  if (target === null || typeof target !== "object" || !Object.hasOwn(target, last)) {
    console.error(`FATAL: override for ${id}: path "${path}" does not exist in the beach schema (at "${last}").`);
    process.exit(1);
  }
  target[last] = value;
}

// Returns [{ id, fieldCount }] for the build report.
function applyOverrides(beaches) {
  const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8"));
  const byId = new Map(beaches.map((b) => [b.id, b]));
  const applied = [];
  for (const [id, fields] of Object.entries(overrides)) {
    const beach = byId.get(id);
    if (!beach) {
      console.error(`FATAL: data/beach-overrides.json references unknown beach id "${id}" - check for typos.`);
      process.exit(1);
    }
    for (const [path, value] of Object.entries(fields)) setByPath(beach, id, path, value);
    // Overridden fields feed embeddingText, so regenerate it - unless the
    // override set embeddingText itself, in which case the explicit value wins.
    if (!Object.hasOwn(fields, "embeddingText")) beach.embeddingText = buildEmbeddingText(beach);
    applied.push({ id, fieldCount: Object.keys(fields).length });
  }
  return applied;
}

// ---------- Validation report ----------

function countNulls(beaches) {
  const counts = new Map();
  const walk = (obj, prefix) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        walk(value, path);
      } else if (value === null) {
        counts.set(path, (counts.get(path) ?? 0) + 1);
      } else if (!counts.has(path)) {
        counts.set(path, counts.get(path) ?? 0);
      }
    }
  };
  for (const b of beaches) walk(b, "");
  return counts;
}

function printReport(beaches) {
  console.log(`\nRows processed: ${beaches.length} (expected ${EXPECTED_ROWS})`);

  const missingCritical = beaches.filter(
    (b) => !b.name || !Number.isFinite(b.location.latitude) || !Number.isFinite(b.location.longitude)
  );
  if (missingCritical.length > 0) {
    console.error(`FATAL: ${missingCritical.length} rows missing name/lat/lng:`);
    for (const b of missingCritical.slice(0, 10)) console.error(`  ${b.id}`);
    process.exit(1);
  }
  console.log("Critical fields (name, latitude, longitude): none missing.");

  console.log("\nNull counts per field (out of " + beaches.length + "):");
  const counts = countNulls(beaches);
  for (const [path, count] of counts) {
    if (count > 0) console.log(`  ${path.padEnd(48)} ${count}`);
  }

  for (const [field, values] of Object.entries(warnings.unparseable)) {
    console.log(`\nUnparseable ${field} values (${values.length}, kept as null):`);
    for (const v of values.slice(0, 20)) console.log(`  "${v}"`);
  }
  for (const [field, values] of Object.entries(warnings.unexpectedValues)) {
    console.log(`\nUnexpected ${field} values (mapped to null):`);
    for (const [v, n] of values) console.log(`  "${v}" x${n}`);
  }

  // Deterministic sanity samples: a mainland Mediterranean beach, an island
  // beach, and one whose width came from a range.
  const samples = [
    beaches[0],
    beaches.find((b) => b.location.island !== null),
    beaches.find((b) => b.physical.widthMinM !== null),
  ];
  console.log("\n--- Sample beaches ---");
  for (const s of samples) console.log(JSON.stringify(s, null, 2));
}

// ---------- Main ----------

const csvRows = csvToObjects(readFileSync(CSV_PATH, "utf8"));
const pqRows = await parquetReadObjects({
  file: await asyncBufferFromFile(PARQUET_PATH.pathname),
  columns: ["beach_id", "name_local", "latitude", "longitude", "description_local"],
});

if (csvRows.length !== pqRows.length || csvRows.length !== EXPECTED_ROWS) {
  console.error(`Row count mismatch: CSV ${csvRows.length}, parquet ${pqRows.length}, expected ${EXPECTED_ROWS}`);
  process.exit(1);
}
verifyJoin(csvRows, pqRows);
console.log(`Positional join verified across ${csvRows.length} rows.`);

const beaches = csvRows.map((csv, i) => buildBeach(csv, pqRows[i]));

const ids = new Set(beaches.map((b) => b.id));
if (ids.size !== beaches.length) {
  console.error("FATAL: duplicate beach ids in output.");
  process.exit(1);
}

const appliedOverrides = applyOverrides(beaches);
if (appliedOverrides.length === 0) {
  console.log("Manual overrides: none (data/beach-overrides.json is empty).");
} else {
  console.log(`Manual overrides applied to ${appliedOverrides.length} beach(es):`);
  for (const { id, fieldCount } of appliedOverrides) {
    console.log(`  ${id}: ${fieldCount} field(s)`);
  }
}

function slimBeach(b) {
  const { embeddingText, ...rest } = b;
  const { otherEstablishmentsRaw, cleaningServiceRaw, ...services } = b.services;
  return { ...rest, services };
}

// Cards clamp descriptions to three lines, so the index carries ~220 chars.
function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return text.slice(0, cut > 0 ? cut : max) + "…";
}

function indexBeach(b) {
  return {
    id: b.id,
    name: b.name,
    alternateNames: b.alternateNames,
    location: {
      municipality: b.location.municipality,
      province: b.location.province,
      autonomousCommunity: b.location.autonomousCommunity,
      island: b.location.island,
      latitude: b.location.latitude,
      longitude: b.location.longitude,
    },
    description: truncate(b.description, 220),
    physical: {
      lengthM: b.physical.lengthM,
      sandType: b.physical.sandType,
      sandComposition: b.physical.sandComposition,
      waterConditions: b.physical.waterConditions,
      occupancyLevel: b.physical.occupancyLevel,
      urbanizationLevel: b.physical.urbanizationLevel,
      coastalLandscape: b.physical.coastalLandscape,
      nudism: b.physical.nudism,
    },
    access: {
      wheelchairAccessible: b.access.wheelchairAccessible,
      parking: b.access.parking,
    },
    services: {
      restrooms: b.services.restrooms,
      showers: b.services.showers,
      footShowers: b.services.footShowers,
      rentalUmbrellas: b.services.rentalUmbrellas,
      rentalLoungers: b.services.rentalLoungers,
      rentalOther: b.services.rentalOther,
      foodKiosk: b.services.foodKiosk,
      playground: b.services.playground,
      sportsArea: b.services.sportsArea,
      nauticalClub: b.services.nauticalClub,
      divingZone: b.services.divingZone,
      surfZone: b.services.surfZone,
    },
    safety: {
      lifeguardService: b.safety.lifeguardService,
      anchorageZone: b.safety.anchorageZone,
    },
    environment: { blueFlag: b.environment.blueFlag },
    custom: b.custom,
  };
}

function writeJson(path, data) {
  const json = JSON.stringify(data) + "\n";
  writeFileSync(path, json);
  const gzipKb = Math.round(gzipSync(json).length / 1024);
  console.log(`Wrote ${path.pathname} (${(json.length / 1024 / 1024).toFixed(1)} MB raw, ${gzipKb} KB gzipped).`);
}

writeJson(OUT_FULL_PATH, beaches);
writeJson(OUT_SLIM_PATH, beaches.map(slimBeach));
writeJson(OUT_INDEX_PATH, beaches.map(indexBeach));

printReport(beaches);
