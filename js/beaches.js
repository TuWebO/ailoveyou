// Client for beaches.html: fetches data/beaches.json, renders beach cards
// with client-side filtering and incremental (lazy) rendering. Each card
// carries id="beach-{beachId}" and data-beach-id so other features (e.g.
// the future chat) can scroll to and highlight specific beaches.

// Card-page index (subset of data/beaches.json with truncated descriptions);
// the detail page fetches the full records instead.
const DATA_URL = "data/beaches-index.json";
const DAILY_LOG_URL = "daily-log.json";
const BATCH_SIZE = 40;

// Enum-ish fields hold " / " combos ("Arena / Grava"), so filters test by
// contains rather than equality.
function has(value, ...terms) {
  return typeof value === "string" && terms.some((t) => value.includes(t));
}

// One place defines all filters, grouped like the panel shows them.
// `card: true` marks the curated subset also shown as tags on beach cards
// (descriptive chips like "Sandy" would be noise there).
const FILTER_GROUPS = [
  { name: "Services", filters: [
    { key: "blueFlag", label: "Blue Flag", card: true, test: (b) => b.environment.blueFlag === true },
    { key: "lifeguard", label: "Lifeguard", card: true, test: (b) => b.safety.lifeguardService === true },
    { key: "wheelchair", label: "Wheelchair access", card: true, test: (b) => b.access.wheelchairAccessible === true },
    { key: "parking", label: "Parking", card: true, test: (b) => b.access.parking === true },
    { key: "restrooms", label: "Restrooms", card: true, test: (b) => b.services.restrooms === true },
    { key: "showers", label: "Showers / foot wash", card: true, test: (b) => b.services.showers === true || b.services.footShowers === true },
    { key: "food", label: "Food & drink", card: true, test: (b) => b.services.foodKiosk === true },
    { key: "rentals", label: "Umbrellas / loungers", test: (b) => b.services.rentalUmbrellas === true || b.services.rentalLoungers === true },
    { key: "playground", label: "Playground", test: (b) => b.services.playground === true },
  ] },
  { name: "Beach", filters: [
    { key: "sandy", label: "Sandy", test: (b) => has(b.physical.sandComposition, "Arena") },
    { key: "pebbles", label: "Pebbles / rocks", test: (b) => has(b.physical.sandComposition, "Bolos", "Grava", "Roca") },
    { key: "calm", label: "Calm water", test: (b) => has(b.physical.waterConditions, "Aguas tranquilas") },
    { key: "quiet", label: "Low occupancy", test: (b) => /bajo/i.test(b.physical.occupancyLevel ?? "") },
    { key: "long", label: "Long (>1 km)", test: (b) => b.physical.lengthM >= 1000 },
    { key: "natural", label: "Isolated / natural", test: (b) => has(b.physical.urbanizationLevel, "Aislada", "Playa natural") },
    { key: "cliffs", label: "Cliffs / mountains", test: (b) => has(b.physical.coastalLandscape, "Acantilado", "Montaña") },
    { key: "dunes", label: "Dunes", test: (b) => has(b.physical.coastalLandscape, "Dunas") },
    { key: "nudist", label: "Nudist", card: true, test: (b) => ["yes", "partial", "tolerated"].includes(b.physical.nudism) },
    { key: "dogs", label: "Dog friendly", card: true, test: (b) => b.custom?.dogFriendly === true },
  ] },
  { name: "Activities", filters: [
    { key: "surf", label: "Surf", card: true, test: (b) => b.services.surfZone === true },
    { key: "diving", label: "Diving", card: true, test: (b) => b.services.divingZone === true },
    { key: "nauticalRental", label: "Nautical rental", test: (b) => b.services.rentalOther === true },
    { key: "nauticalClub", label: "Nautical club", test: (b) => b.services.nauticalClub === true },
    { key: "anchorage", label: "Boat anchorage", test: (b) => b.safety.anchorageZone === true },
    { key: "sports", label: "Sports area", test: (b) => b.services.sportsArea === true },
  ] },
];

const ALL_FILTERS = FILTER_GROUPS.flatMap((g) => g.filters);
const FILTERS_BY_KEY = new Map(ALL_FILTERS.map((f) => [f.key, f]));
const CARD_TAG_FILTERS = ALL_FILTERS.filter((f) => f.card);

const state = {
  beaches: [],
  filtered: [],
  renderedCount: 0,
  query: "",
  community: "",
  activeServices: new Set(),
  photosByBeach: new Map(), // beachId -> daily-log entries tagged with it
};

const grid = document.getElementById("grid");
const statusEl = document.getElementById("status");
const resultCount = document.getElementById("result-count");
const searchInput = document.getElementById("search");
const communitySelect = document.getElementById("community");
const filtersSummary = document.getElementById("filters-summary");
const filterGroupsContainer = document.getElementById("filter-groups");
const sentinel = document.getElementById("sentinel");

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Accent-insensitive matching so "guimar" finds Güímar.
function fold(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function searchHaystack(b) {
  return fold(
    [b.name, ...b.alternateNames, b.location.municipality, b.location.province, b.location.island ?? ""].join(" ")
  );
}

function formatLength(lengthM) {
  if (lengthM === null) return null;
  return lengthM >= 1000 ? `${(lengthM / 1000).toFixed(1).replace(/\.0$/, "")} km` : `${lengthM} m`;
}

function cardHtml(b) {
  const loc = b.location;
  const locationLine = [loc.municipality, loc.island, `${loc.province} (${loc.autonomousCommunity})`]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" &middot; ");

  const meta = [formatLength(b.physical.lengthM), b.physical.sandType ? `${b.physical.sandType} sand` : null]
    .filter(Boolean)
    .join(" &middot; ");

  const tags = CARD_TAG_FILTERS.filter(({ test }) => test(b))
    .map(({ key, label }) => `<span class="beach-tag${key === "blueFlag" ? " blue-flag" : ""}">${label}</span>`)
    .join("");

  const mapUrl = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;

  const photos = (state.photosByBeach.get(b.id) ?? [])
    .map((e) => {
      const src = escapeHtml(`${e.image}${e.version ? `?v=${e.version}` : ""}`);
      return `<a href="${src}" target="_blank" rel="noopener"><img class="beach-photo-thumb" src="${src}" alt="${escapeHtml(e.caption)}" title="${escapeHtml(e.date)}" loading="lazy"></a>`;
    })
    .join("");

  const detailUrl = `beach.html?id=${encodeURIComponent(b.id)}`;

  return `<article class="beach-card" id="beach-${escapeHtml(b.id)}" data-beach-id="${escapeHtml(b.id)}">
    <h2 class="beach-name"><a href="${detailUrl}">${escapeHtml(b.name)}</a></h2>
    <div class="beach-location">${locationLine}</div>
    <p class="beach-desc">${escapeHtml(b.description)}</p>
    ${photos ? `<div class="beach-photos">${photos}</div>` : ""}
    ${meta ? `<div class="beach-meta">${meta}</div>` : ""}
    ${tags ? `<div class="beach-tags">${tags}</div>` : ""}
    <div class="beach-links">
      <a class="beach-details" href="${detailUrl}">Details &rarr;</a>
      <a class="beach-map" href="${mapUrl}" target="_blank" rel="noopener">View on map &#8599;</a>
    </div>
  </article>`;
}

function matches(b) {
  if (state.community && b.location.autonomousCommunity !== state.community) return false;
  for (const key of state.activeServices) {
    const filter = FILTERS_BY_KEY.get(key);
    if (filter && !filter.test(b)) return false;
  }
  if (state.query && !searchHaystack(b).includes(state.query)) return false;
  return true;
}

function renderMore() {
  const next = state.filtered.slice(state.renderedCount, state.renderedCount + BATCH_SIZE);
  if (next.length === 0) return;
  grid.insertAdjacentHTML("beforeend", next.map(cardHtml).join(""));
  state.renderedCount += next.length;
}

function applyFilters() {
  state.filtered = state.beaches.filter(matches);
  state.renderedCount = 0;
  grid.innerHTML = "";
  renderMore();
  resultCount.textContent =
    state.filtered.length === state.beaches.length
      ? `${state.beaches.length.toLocaleString("en")} beaches`
      : `${state.filtered.length.toLocaleString("en")} of ${state.beaches.length.toLocaleString("en")} beaches`;
  statusEl.textContent = state.filtered.length === 0 ? "No beaches match these filters." : "";
}

function populateCommunities() {
  const communities = [...new Set(state.beaches.map((b) => b.location.autonomousCommunity))].sort((a, b) =>
    a.localeCompare(b, "es")
  );
  for (const community of communities) {
    const option = document.createElement("option");
    option.value = community;
    option.textContent = community;
    communitySelect.append(option);
  }
}

function updateFilterSummary() {
  const n = state.activeServices.size;
  filtersSummary.textContent = n > 0 ? `Filters · ${n}` : "Filters";
}

function buildFilterPanel() {
  for (const group of FILTER_GROUPS) {
    const groupLabel = document.createElement("div");
    groupLabel.className = "chip-group-label";
    groupLabel.textContent = group.name;

    const chips = document.createElement("div");
    chips.className = "chips";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", `${group.name} filters`);
    for (const { key, label } of group.filters) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = label;
      chip.setAttribute("aria-pressed", "false");
      chip.addEventListener("click", () => {
        const active = state.activeServices.has(key);
        if (active) state.activeServices.delete(key);
        else state.activeServices.add(key);
        chip.setAttribute("aria-pressed", String(!active));
        updateFilterSummary();
        applyFilters();
      });
      chips.append(chip);
    }

    const wrap = document.createElement("div");
    wrap.className = "chip-group";
    wrap.append(groupLabel);
    wrap.append(chips);
    filterGroupsContainer.append(wrap);
  }
  updateFilterSummary();
}

// Renders a card for a beach that lazy loading hasn't reached yet, then
// scrolls to and highlights it. Used by the future chat feature.
export function focusBeach(beachId) {
  const index = state.filtered.findIndex((b) => b.id === beachId);
  if (index === -1) return false;
  while (state.renderedCount <= index) renderMore();
  const card = document.getElementById(`beach-${beachId}`);
  if (!card) return false;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("highlight");
  setTimeout(() => card.classList.remove("highlight"), 4000);
  return true;
}

async function init() {
  buildFilterPanel();

  let response;
  try {
    response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.beaches = await response.json();
  } catch (err) {
    statusEl.textContent = "Could not load the beach data. Please try again later.";
    console.error("Failed to load beaches:", err);
    return;
  }

  // Daily photos tagged with a beachId show up on that beach's card.
  // The page works fine without them, so failures here are non-fatal.
  try {
    const logResponse = await fetch(DAILY_LOG_URL);
    if (logResponse.ok) {
      for (const entry of await logResponse.json()) {
        if (!entry.beachId) continue;
        const list = state.photosByBeach.get(entry.beachId) ?? [];
        list.push(entry);
        state.photosByBeach.set(entry.beachId, list);
      }
    }
  } catch (err) {
    console.warn("Daily photo log unavailable:", err);
  }

  populateCommunities();
  applyFilters();

  let debounce;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = fold(searchInput.value.trim());
      applyFilters();
    }, 150);
  });

  communitySelect.addEventListener("change", () => {
    state.community = communitySelect.value;
    applyFilters();
  });

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) renderMore();
  }, { rootMargin: "600px" }).observe(sentinel);
}

init();
