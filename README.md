# Justwords — Client Intelligence Dashboard

A self-hosted, multi-client SEO & business dashboard for agencies. Sign in, manage
your whole client roster, and see every Google channel — Search, Analytics, Business
Profile and Core Web Vitals — in one place. Ships with realistic **sample data** for
every widget and switches to **live Google data** per source the moment a client's
properties are connected.

## What it shows

**Portfolio view** — all client sites at a glance
- Aggregate KPIs across the roster: organic traffic, search clicks, local reach, conversions, average rating
- Sortable/filterable table with per-client trend sparklines, ratings, Core Web Vitals pass %, site health, and Google-connection status dots

**Per-client report** (tabbed)
- **Overview** — headline KPIs, organic-traffic trend, traffic sources, data-connector toggles
- **Search** *(Search Console)* — clicks/impressions/CTR/position, clicks trend, top queries, clicks by country, devices, keyword rankings, position distribution
- **Traffic** *(GA4)* — sessions, users, engagement, bounce, conversions, sessions trend, channels, top landing pages
- **Business Profile** *(GBP)* — **reach/views** (Search vs Maps, mobile vs desktop), profile-view trend, customer actions (calls, directions, website clicks, messages, bookings), reviews (avg rating, distribution, recent), photo views
- **Performance** *(PageSpeed / CrUX)* — real-user Core Web Vitals (LCP, INP, CLS, FCP, TTFB) with pass/fail ratings, assessment gauge, plus an on-demand **Lighthouse** lab audit
- **Off-page** — backlinks (Ahrefs-style) and competitors (SEMrush-style)
- **Site Health** — crawl snapshot + live technical audit

Each widget carries a **Live / Sample** badge so you always know whether a number is real.

## Sample data → live data

Every widget renders from the deterministic mock generator (`mock.js`) until you
connect the matching Google property. Connection is per client, per source:

1. Configure the agency **service account** once (see below).
2. Open a client → **Connect Google** → paste its property IDs:
   - Search Console **site URL** (e.g. `sc-domain:acme.com`)
   - GA4 **property ID** (e.g. `412345678`)
   - Business Profile **location ID** (e.g. `locations/123…`) and optional account ID for reviews
3. That source flips from **Sample** to **Live** automatically. Anything not yet
   connected keeps showing sample data, so the report is never blank.

## Setup

```bash
npm install
npm start
```

Open **http://localhost:5000** · default login (from `.env`): `admin@agency.com` / `admin123`

## Connecting the Google APIs

One service account serves the whole agency. Create it in Google Cloud, enable the
**Search Console API**, **Google Analytics Data API**, **Business Profile Performance API**
and **PageSpeed Insights / CrUX API**, then grant the service-account email access to
each client property (Search Console user, GA4 Viewer, Business Profile manager).

Point the server at the credentials in `.env`:

```env
GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json   # or GOOGLE_SERVICE_ACCOUNT_JSON={...}
GOOGLE_PSI_KEY=your-api-key                           # PageSpeed + CrUX
```

The dashboard shows **"Google account connected"** on the Portfolio page once the
credentials load. For quick local testing you can instead paste a short-lived
`GOOGLE_ACCESS_TOKEN`.

## Configuration (`.env`)
| Key | Purpose |
|-----|---------|
| `PORT` | Server port (default 5000) |
| `JWT_SECRET` | Change to a long random string |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Default login (created on first run) |
| `GROQ_API_KEY` / `GROQ_MODEL` | Groq key + model for the Lighthouse-audit AI summary |
| `GOOGLE_PSI_KEY` | PageSpeed + CrUX (real-user Core Web Vitals) |
| `GOOGLE_SERVICE_ACCOUNT_FILE` / `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account credentials for Search Console + GA4 + Business Profile |
| `GOOGLE_ACCESS_TOKEN` | Optional short-lived token for local testing |
| `GOOGLE_IMPERSONATE_SUBJECT` | Optional Workspace user to impersonate (domain-wide delegation) |

## Architecture
| File | Role |
|------|------|
| `server.js` | Express API + static host; portfolio aggregation; per-source real/mock resolution |
| `google.js` | Live Google fetchers (Search Console, GA4, Business Profile, CrUX) with service-account auth |
| `mock.js` | Deterministic per-client sample data — same shape as the live fetchers |
| `seo.js` | On-page + Lighthouse technical audit engine |
| `public/` | Single-page UI (`index.html`, `styles.css`, `app.js`) |

## Security notes
- **Rotate the Groq key** in `.env` — it was committed in plain text.
- Change `JWT_SECRET` and the admin password before deploying.
- Never commit `service-account.json`; it grants read access to all connected properties.
- Data is stored as JSON files in `data/` (`users.json`, `clients.json`).

## White-labeling
The brand mark and name live in `public/index.html` (`.logo-mark` / `.logo-text`);
the palette is the `:root` block in `public/styles.css` (`--brand`, etc.).
