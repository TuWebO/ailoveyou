// Renders beach.html?id=ES-000123 from data/beaches.json: the full record
// for one beach, plus any daily photos tagged with its id.

const DATA_URL = "data/beaches.json";
const DAILY_LOG_URL = "daily-log.json";

const detailEl = document.getElementById("detail");
const statusEl = document.getElementById("status");

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function yesNo(v) {
  return v === true ? "Yes" : v === false ? "No" : null;
}

// "Yes (extra)" when the boolean is true and a companion detail exists.
function yesNoWith(v, extra) {
  const base = yesNo(v);
  return base === "Yes" && extra ? `Yes (${extra})` : base;
}

function formatLength(lengthM) {
  if (lengthM === null) return null;
  return lengthM >= 1000 ? `${(lengthM / 1000).toFixed(1).replace(/\.0$/, "")} km` : `${lengthM} m`;
}

function formatWidth(p) {
  if (p.widthM !== null) return `${p.widthM} m`;
  if (p.widthMinM !== null) return `${p.widthMinM}–${p.widthMaxM} m`;
  return null;
}

const NUDISM_LABELS = { no: "No", yes: "Yes", partial: "Partial", tolerated: "Tolerated" };

// Labels for build-time custom fields (community knowledge not in the
// MITECO dataset). Unlabelled keys fall back to the raw key name.
const CUSTOM_LABELS = { dogFriendly: "Dog friendly" };

const SERVICE_LABELS = [
  ["restrooms", "Restrooms"],
  ["showers", "Showers"],
  ["footShowers", "Foot showers"],
  ["trashBins", "Trash bins"],
  ["publicPhones", "Public phones"],
  ["rentalUmbrellas", "Umbrella rental"],
  ["rentalLoungers", "Lounger rental"],
  ["rentalOther", "Nautical rental"],
  ["foodKiosk", "Food & drink"],
  ["otherEstablishments", "Other establishments"],
  ["touristOffice", "Tourist office"],
  ["playground", "Playground"],
  ["sportsArea", "Sports area"],
  ["nauticalClub", "Nautical club"],
  ["divingZone", "Diving"],
  ["surfZone", "Surf"],
  ["cleaningService", "Beach cleaning"],
];

function factsSection(title, rows) {
  const present = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (present.length === 0) return "";
  const dl = present
    .map(([label, value, isHtml]) => `<dt>${escapeHtml(label)}</dt><dd>${isHtml ? value : escapeHtml(value)}</dd>`)
    .join("");
  return `<section class="facts"><h2>${escapeHtml(title)}</h2><dl class="fact-grid">${dl}</dl></section>`;
}

function externalLink(url, label) {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label ?? url)}</a>`;
}

function render(beach, photoEntries) {
  const loc = beach.location;
  const p = beach.physical;
  const mapUrl = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;

  const locationLine = [loc.municipality, loc.island, `${loc.province} (${loc.autonomousCommunity})`]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" &middot; ");

  const photos = photoEntries
    .map((e) => {
      const src = escapeHtml(`${e.image}${e.version ? `?v=${e.version}` : ""}`);
      return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${escapeHtml(e.caption)}" title="${escapeHtml(e.date)}" loading="lazy"></a>`;
    })
    .join("");

  const serviceTags = [
    ...(beach.environment.blueFlag ? [`<span class="service-tag blue-flag">Blue Flag</span>`] : []),
    ...SERVICE_LABELS.filter(([key]) => beach.services[key] === true).map(
      ([, label]) => `<span class="service-tag">${escapeHtml(label)}</span>`
    ),
  ].join("");

  const sections = [
    factsSection("Beach", [
      ["Length", formatLength(p.lengthM)],
      ["Width", formatWidth(p)],
      ["Width variation", p.widthVariation],
      ["Sand", p.sandType],
      ["Composition", p.sandComposition],
      ["Water", p.waterConditions],
      ["Occupancy", p.occupancyLevel],
      ["Surroundings", p.urbanizationLevel],
      ["Coastal landscape", p.coastalLandscape],
      ["Nudism", NUDISM_LABELS[p.nudism] ?? null],
    ]),
    factsSection("Access", [
      ["Getting there", beach.access.mode],
      ["Road", beach.access.road],
      ["Signposted", yesNo(beach.access.signposted)],
      ["Bus", yesNoWith(beach.access.busAccess, beach.access.busType)],
      ["Wheelchair access", yesNo(beach.access.wheelchairAccessible)],
      ["Boardwalk", yesNoWith(beach.access.boardwalk, beach.access.boardwalkType)],
      ["Parking", yesNoWith(beach.access.parking, [beach.access.parkingCapacity, beach.access.parkingSupervised === true ? "supervised" : beach.access.parkingSupervised === false ? "unsupervised" : null].filter(Boolean).join(", ") || null)],
    ]),
    factsSection("Safety", [
      ["Lifeguard", yesNoWith(beach.safety.lifeguardService, beach.safety.lifeguardHours)],
      ["Danger signage", yesNoWith(beach.safety.signage, beach.safety.signageType)],
      ["Anchorage zone", yesNo(beach.safety.anchorageZone)],
    ]),
    factsSection("Environment", [
      ["Blue Flag", yesNo(beach.environment.blueFlag)],
      ["Vegetation", yesNoWith(beach.environment.vegetation, beach.environment.vegetationLocation)],
      ["Environmental actions", yesNoWith(beach.environment.environmentalActions, beach.environment.environmentalActionsDescription)],
      ["Protected area", beach.environment.inProtectedArea ? (beach.environment.protectedAreaName ?? "Yes") : yesNo(beach.environment.inProtectedArea)],
    ]),
    factsSection("More", Object.entries(beach.custom ?? {}).map(([key, value]) => [
      CUSTOM_LABELS[key] ?? key,
      typeof value === "boolean" ? yesNo(value) : value,
    ])),
    factsSection("Nearby", [
      ["Marina", beach.nearby.marina],
      ["Marina website", beach.nearby.marinaWebsite ? externalLink(beach.nearby.marinaWebsite) : null, true],
      ["Distance to marina", beach.nearby.distanceToMarinaKm !== null ? `${beach.nearby.distanceToMarinaKm} km` : null],
      ["Hospital", beach.nearby.hospital],
      ["Hospital address", beach.nearby.hospitalAddress],
      ["Hospital phone", beach.nearby.hospitalPhone],
      ["Distance to hospital", beach.nearby.distanceToHospitalKm !== null ? `${beach.nearby.distanceToHospitalKm} km` : null],
    ]),
  ].join("");

  detailEl.innerHTML = `
    <div class="beach-header">
      <h1>${escapeHtml(beach.name)}</h1>
      ${beach.alternateNames.length ? `<p class="alt-names">Also known as: ${beach.alternateNames.map(escapeHtml).join(", ")}</p>` : ""}
      <p class="beach-location">${locationLine}</p>
      <div class="beach-actions">
        ${externalLink(mapUrl, "View on map ↗")}
        ${loc.municipalityWebsite ? externalLink(loc.municipalityWebsite, "Municipality website ↗") : ""}
      </div>
    </div>
    ${photos ? `<div class="beach-photos">${photos}</div>` : ""}
    <p class="beach-description">${escapeHtml(beach.description)}</p>
    ${beach.notes ? `<p class="beach-notes">${escapeHtml(beach.notes)}</p>` : ""}
    ${serviceTags ? `<section class="facts"><h2>Services</h2><div class="service-tags">${serviceTags}</div></section>` : ""}
    ${sections}
    <p class="source-note">Data: MITECO Guía de Playas (id ${escapeHtml(beach.id)}). Some details may be out of date.</p>
  `;
  document.title = `ailoveyou.ai — ${beach.name}`;
  statusEl.textContent = "";
}

async function init() {
  const id = new URLSearchParams(window.location.search).get("id") ?? "";
  if (!/^ES-\d{6}$/.test(id)) {
    statusEl.innerHTML = `No beach selected. <a href="beaches.html">Browse all beaches</a>.`;
    return;
  }

  let beaches;
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    beaches = await response.json();
  } catch (err) {
    statusEl.textContent = "Could not load the beach data. Please try again later.";
    console.error("Failed to load beaches:", err);
    return;
  }

  const beach = beaches.find((b) => b.id === id);
  if (!beach) {
    statusEl.innerHTML = `Beach "${escapeHtml(id)}" not found. <a href="beaches.html">Browse all beaches</a>.`;
    return;
  }

  let photoEntries = [];
  try {
    const logResponse = await fetch(DAILY_LOG_URL);
    if (logResponse.ok) photoEntries = (await logResponse.json()).filter((e) => e.beachId === id);
  } catch (err) {
    console.warn("Daily photo log unavailable:", err);
  }

  render(beach, photoEntries);
}

init();
