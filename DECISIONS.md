# Decisions

Records of project decisions that need to survive until the milestone that acts on them.

## Beach data corrections

Manual corrections go in `data/beach-overrides.json`, applied on top of parsed CSV
data at build time — never edit `data/raw/playas_espanolas.csv` directly for one-off
fixes. Overrides are keyed by beach id with dot-path fields
(`{ "ES-000123": { "services.surfZone": true } }`); the build fails loudly on unknown
ids or paths, and regenerates the affected beach's embeddingText.

## Custom fields (properties the MITECO dataset lacks)

Fields like `custom.dogFriendly` are declared once in `CUSTOM_FIELD_DEFAULTS` in
`scripts/build-beaches-json.mjs`, stamped into every beach's `custom` section with a
`null` default (null = unknown, never false), and given values per beach through
`data/beach-overrides.json` — same flow as data corrections, so the overrides
typo-check keeps working. Overrides regenerate embeddingText, so custom fields reach
the RAG index automatically; the M4 indexer must treat full reindexing as cheap and
routine, since any schema growth changes embeddingText.

## Unconfirmed column meanings — two confirmed (2026-07-12)

RTVE's beach finder is built on this same MITECO dataset, and its filter labels
double as an official translation of the cryptic CSV columns. That confirmed
`Alquiler_n` = nautical equipment rental ("Alquiler náutico") and `Establecim` =
chiringuito/food establishments ("Chiringuito"), so their `*Raw` audit siblings
were dropped from the build. `Establec_1` (otherEstablishments) and `Servicio_l`
(cleaningService) remain unconfirmed and keep their raw siblings. RTVE also
exposes "Playa canina", which our CSV export lacks — that's exactly what
`custom.dogFriendly` covers.

## No embedded map (decided 2026-07-12)

Beach pages link out to Google Maps instead of embedding a Leaflet/OSM map. Reason:
the site's policy is no third-party requests on page view (why fonts are
self-hosted — Lighthouse + GDPR/visitor-IP exposure). Vendoring Leaflet's JS/CSS
would keep the code first-party, but map *tiles* must stream from a third-party
server at view time, which breaks the policy; fully self-hosted tiles for Spain
don't fit under GitHub Pages' 100 MB file limit. Revisit only if the policy changes
or the site moves off Pages.

## Embedding language strategy (decided before M4)

- embeddingText fields are written in each beach's local/source language — Spanish
  for the current dataset. This will NOT change as English-speaking users are added;
  Claude's generation step handles responding in the user's language regardless of
  what language the retrieved context is in.
- If/when other countries are added later, their embeddingText should also be in
  their local source language — never translate embeddingText between languages.
- Because of the above, Milestone 4 MUST use a genuinely multilingual embedding model
  (e.g. OpenAI text-embedding-3-small/large, Voyage multilingual, or Cohere
  embed-multilingual-v3) — not an English-only model — so English queries and future
  non-Spanish beaches still retrieve correctly in the same vector space.

Current implementation note (M1): `scripts/build-beaches-json.mjs` emits embeddingText
as an English scaffold around untranslated Spanish source values ("La Venus, in
Marbella… Occupancy: Alto. Services: restrooms, showers…"). The Spanish description
and all enum values are kept verbatim per the decision above; whether the English
scaffold words ("in", "Occupancy:", "Services:") should also become Spanish is left
to review at M4 kickoff.
