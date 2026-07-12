# Decisions

Records of project decisions that need to survive until the milestone that acts on them.

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
