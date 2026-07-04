# AiLoveYou.ai

Static site on GitHub Pages (repo `TuWebO/ailoveyou`), custom domain **`ailoveyou.ai`** (bare domain — `www.ailoveyou.ai` 301-redirects to it, so all absolute URLs in the repo must use the bare domain).

## Git: pull before you commit, and pushes/pulls need a passphrase

`.github/workflows/daily-love.yml` runs daily at 08:00 UTC (and on manual `workflow_dispatch`) as `github-actions[bot]`, and **pushes directly to `main`** if the generated content changed. That means `origin/main` can move at any time without anyone touching a local clone — local history silently falls behind.

- **Always fetch/pull before committing new work.** If local and remote have both moved, rebase (`git fetch ... && git rebase origin/main`) rather than force-pushing.
- Pushing (and pulling over SSH) requires the user's SSH key passphrase, entered interactively — this can't be done non-interactively from an agent's sandboxed shell. Read-only fetches work fine anonymously over HTTPS even without the passphrase, e.g.:
  ```
  git fetch https://github.com/TuWebO/ailoveyou.git main:refs/remotes/tmp-origin/main
  ```
  Use that to inspect/rebase onto the true remote state, then hand off `git push` (and `git pull`) to the user to run themselves in their own terminal.
- Before any push, double check `git status`/`git diff --cached` — don't stage `.env` or other files that aren't meant to be committed.

## Daily pipeline

`scripts/generate-daily.mjs` (invoked by the workflow above):
1. Picks a day-indexed photo from SmugMug album key `6v3DvK` ("Stock", owner-accessible, password-protected but readable via OAuth 1.0a owner token in `scripts/smugmug-client.mjs`).
2. Downloads the unwatermarked `Original` size, resizes/compresses locally with `sharp` (SmugMug has no reliable API-level "smaller but unwatermarked" size).
3. Sends it to Claude for a one-sentence caption.
4. Writes `images/daily/YYYY-MM-DD.jpg`, rewrites `index.html` between `<!-- DAILY:START/END -->` (photo + caption) and `<!-- SEO:START/END -->` (og/twitter description + og:description use that day's caption; `og:image`/`twitter:image` point at the fixed `images/ailoveyou-share.jpg`, not the rotating photo — cached link previews would otherwise get stuck on a stale photo).
5. Appends to `daily-log.json` (date, image path, caption, width, height) and fully regenerates `archive.html` from that log.

`images/ailoveyou-share.jpg` (1200x630, "Hey, I love you." + site name baked in) is the fixed social-share image — not touched by the pipeline, edit it manually if it ever needs to change.

## Known platform limitation

GitHub Pages serves every asset (HTML or image) with a fixed `Cache-Control: max-age=600` — there's no supported way to set longer cache lifetimes per file type from the repo (no custom headers file like Netlify/Vercel). Fronting with a CDN like Cloudflare would be the only fix, and that's an infra decision, not a code change.
