# Deploying to Render

This app is a stateful Node/Express server. It needs a **persistent process** and a
**persistent disk** — so a container/VM host (Render, Railway, Fly.io) is the right fit,
**not** a serverless platform like Vercel.

## Before you deploy — security cleanup (required)

1. **Rotate the Groq key.** The old key in `.env` was shared in plaintext — revoke it in
   the Groq console and issue a new one.
2. **Rotate / remove the Google service-account file.** `spatial-tempo-*.json` was in the
   repo. Delete it from the working tree and, if it was ever pushed, disable that key in
   Google Cloud and create a new one. In production you'll paste the JSON as an env var.
3. Confirm `.gitignore` now excludes `.env`, `data/*.json`, and the service-account JSON
   (it does). Never commit real secrets.

## Deploy steps (Render, using the Blueprint)

1. Push this repo to GitHub/GitLab.
2. In Render: **New → Blueprint** and select the repo. It reads `render.yaml`, which
   provisions a web service + a 1 GB persistent disk mounted at `/data`.
3. Set the `sync: false` env vars in the Render dashboard:
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` — your login (created on first boot).
   - `GOOGLE_PSI_KEY` — **recommended.** Enables the SEO audit + Core Web Vitals via
     Google's HTTP API. (Local Lighthouse/Chrome is not available on Render's default
     runtime, so without this key the audit feature is limited.)
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — paste the full service-account JSON on one line, to
     enable live Search Console / GA4 / Business Profile data.
   - `GROQ_API_KEY` — optional, for the AI audit summary.
   - `JWT_SECRET` is generated automatically by the blueprint.
4. Deploy. Health check: `https://<your-app>.onrender.com/api/health`.
5. Log in with your `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

> **Free tier note:** persistent disks require a paid (Starter+) plan. On the free plan
> the filesystem resets on every deploy, so your users/clients would not persist.

## About the SEO audit on a server host

`seo.js` prefers Google's PageSpeed Insights API (`GOOGLE_PSI_KEY`) and only falls back to
running Chrome locally. Render/Railway's default Node runtime has no Chrome, so **set
`GOOGLE_PSI_KEY`** to keep audits working. If you need the local-Lighthouse path, deploy
via a Docker image that bundles Chromium (Fly.io or Render's Docker runtime) instead.

## Connecting real (live) data

Service account: `dashboard@spatial-tempo-505110-n4.iam.gserviceaccount.com`
(project `spatial-tempo-505110-n4`). Grant *this email* access to each property.

**Search Console — ✅ connected (6 clients).** Bravo Protection, Alpha Floral, Anoka
Dental, Brooklyn Blvd Dental, Dental on First, Diesel Components pull live clicks /
impressions / queries. To connect more, add the service-account email as a user on
the property in Search Console, then run `node gsc-ga4-discover.js --write`.

**GA4 — ❌ blocked (403).** To turn on live traffic data:
1. In Google Cloud console for project `spatial-tempo-505110-n4`, enable
   **Google Analytics Admin API** *and* **Google Analytics Data API**.
2. In each GA4 property: Admin → Property Access Management → add the service-account
   email as **Viewer**.
3. Run `node gsc-ga4-discover.js --write` to auto-fill each client's `ga4PropertyId`.

**Business Profile — ❌ not connected.** Clients have map CIDs but no location IDs.
The GBP Performance API requires Google to allowlist your project, then run
`node gbp-discover.js` to resolve `locations/{id}`. Until then GBP shows sample data.

**PageSpeed / CrUX + audits — ✅ working** (keyless). Set `GOOGLE_PSI_KEY` to raise
rate limits, which matters for the daily batch across 26 clients.

## Daily auto-refresh

The server re-audits every client once a day (default 03:00, `AUTO_REFRESH_HOUR`) and
persists each score. Live GSC/GA4/CrUX numbers are always fetched fresh on page view,
so the daily job keeps the *audit* scores current. Controls:

- `AUTO_REFRESH=false` disables it. `AUTO_REFRESH_HOUR` sets the hour (0-23).
- `POST /api/refresh` (admin) triggers a run on demand; `GET /api/refresh/status`
  reports last-run results.

> The scheduler is in-process, so run a **single** instance (scale = 1). Multiple
> instances would each run the batch. On Render's free tier the service also sleeps
> when idle and would miss the 03:00 run — a paid always-on instance is needed.

## Railway (alternative)

Same idea: create a service from the repo, add a **Volume** mounted at `/data`, set
`DATA_DIR=/data` plus the env vars above. Railway auto-detects `npm start`.
