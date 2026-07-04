# AiLoveYou.ai

A small, love-themed static site: every day, an AI picks a photo and writes a one-sentence caption for it, and the homepage updates automatically.

**Live site:** https://ailoveyou.ai
**Archive of past days:** https://ailoveyou.ai/archive.html

## How it works

- A GitHub Actions workflow (`.github/workflows/daily-love.yml`) runs once a day.
- It picks a photo from a [SmugMug](https://www.smugmug.com/) photo library (the author's existing photography business), using the SmugMug API.
- It sends the photo to [Claude](https://www.anthropic.com/claude) to write a short caption.
- It updates `index.html` with the new photo/caption, appends the entry to `daily-log.json`, and regenerates `archive.html` so past days stay browsable.
- If anything changed, the workflow commits and pushes the update itself.
- It then posts the same photo/caption to [Instagram](https://www.instagram.com/ailoveyou_ai/) via the Instagram Graph API.

## Running it locally

```
npm install
cp .env.example .env   # fill in the values below
npm run daily:generate
```

Required environment variables (in `.env` locally, or repo secrets in CI):

| Variable | Purpose |
|---|---|
| `SMUGMUG_API_KEY` / `SMUGMUG_API_SECRET` | SmugMug API app credentials |
| `SMUGMUG_ACCESS_TOKEN` / `SMUGMUG_ACCESS_TOKEN_SECRET` | OAuth 1.0a token for the SmugMug account (see `npm run smugmug:auth` to generate one) |
| `ANTHROPIC_API_KEY` | Used to generate the daily caption via the Claude API |
| `INSTAGRAM_ACCESS_TOKEN` / `INSTAGRAM_USER_ID` | Used to post the daily photo/caption to Instagram (long-lived token, expires every 60 days and needs refreshing) |

## Project structure

- `index.html` / `archive.html` — the site itself (static, no build step)
- `scripts/generate-daily.mjs` — the daily pipeline described above
- `scripts/post-instagram.mjs` — posts the day's photo/caption to Instagram, run after the site update is live
- `scripts/smugmug-*.mjs` — SmugMug API auth and helper scripts
- `daily-log.json` — history of past photos/captions, source of truth for the archive page
- `rotation-state.json` — tracks which SmugMug photos have been used, so the rotation doesn't repeat until every photo has had a turn
- `images/daily/` — one resized JPEG per day
