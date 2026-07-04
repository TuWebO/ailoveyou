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
1. Picks the next not-yet-used photo from SmugMug album key `6v3DvK` ("Stock", owner-accessible, password-protected but readable via OAuth 1.0a owner token in `scripts/smugmug-client.mjs`), tracked by SmugMug `ImageKey` in `rotation-state.json` (resets once every photo has had a turn). Reruns on the same date reuse whatever was already picked that day rather than drawing again — deliberately *not* a `day % albumSize` index, since that reshuffles every future pick whenever the album's photo count changes.
2. Downloads the unwatermarked `Original` size, resizes/compresses locally with `sharp` (SmugMug has no reliable API-level "smaller but unwatermarked" size), then embeds a `Copyright`/`Artist` EXIF tag (tusesiondesurf.com) into the already-stripped buffer — verified empirically this never leaks the original photo's GPS/lens/serial EXIF.
3. Sends it to Claude for a one-sentence caption.
4. Writes `images/daily/YYYY-MM-DD.jpg`, rewrites `index.html` between `<!-- DAILY:START/END -->` (photo + caption) and `<!-- SEO:START/END -->` (og/twitter description + og:description use that day's caption; `og:image`/`twitter:image` point at the fixed `images/ailoveyou-share.jpg`, not the rotating photo — cached link previews would otherwise get stuck on a stale photo).
5. Appends to `daily-log.json` (date, image path, SmugMug `imageKey`, caption, width, height) and fully regenerates `archive.html` from that log.

`images/ailoveyou-share.jpg` (1200x630, "Hey, I love you." + site name baked in) is the fixed social-share image — not touched by the pipeline, edit it manually if it ever needs to change.

## Instagram publishing

`scripts/post-instagram.mjs` runs as a separate workflow step *after* the commit+push, posting that day's photo/caption to `@ailoveyou_ai` via the Instagram Graph API (`graph.instagram.com`, "Instagram API with Instagram Login" method — no linked Facebook Page needed). Needs `INSTAGRAM_ACCESS_TOKEN` (long-lived, expires every 60 days — must be refreshed manually or via `graph.instagram.com/refresh_access_token` before then, or posting silently stops working) and `INSTAGRAM_USER_ID` as repo secrets.

Why it's a separate step, not folded into `generate-daily.mjs`: Instagram's `image_url` param must be a URL it can fetch *right when the API is called*, but the image isn't actually live on `ailoveyou.ai` until after the push and the (occasionally flaky, see below) Pages redeploy finish. So this script polls the live URL with a bounded retry/timeout before calling Instagram's API, and the workflow step has `continue-on-error: true` — a failure here (expired token, transient API error) must never block the site's own daily update, since Instagram is a side-channel, not the core thing.

Duplicate-post guard: the script checks `daily-log.json`'s `instagramMediaId` field for today's entry before posting, and skips if already set — necessary because reruns on the same date (e.g. manual `workflow_dispatch` retries while testing) would otherwise post the same photo to Instagram twice. After a successful post, it writes `instagramMediaId` back and a second, separate commit step records it.

**Filenames are date-only** (`images/daily/YYYY-MM-DD.jpg`), so two runs on the same calendar day (e.g. the scheduled cron plus a manual test) overwrite the same path/URL. This broke the "wait until live" check the first time we tested Instagram posting: a HEAD request against a URL that *already existed* from an earlier run that day returns 200 immediately, without proving the *new* content is what's actually being served (GitHub Pages' CDN can still serve a stale cached copy of the old file at that URL for a while). Caption text isn't affected (sent as a literal API string, not fetched from a URL) — only the photo can end up stale, which is exactly what happened: Instagram showed an old photo with the new caption. Fixed by stamping every generation with a fresh `version` (epoch ms) used as a cache-busting query string (`?v=...`) on the image URL, and by having `post-instagram.mjs` verify the live URL's `Content-Length` actually matches the local file it just wrote, not just that the URL returns 200.

## Known platform limitation

GitHub Pages serves every asset (HTML or image) with a fixed `Cache-Control: max-age=600` — there's no supported way to set longer cache lifetimes per file type from the repo (no custom headers file like Netlify/Vercel). Fronting with a CDN like Cloudflare would be the only fix, and that's an infra decision, not a code change.
