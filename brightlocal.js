// brightlocal.js — live BrightLocal integration for the dashboard.
//
// Pulls from your EXISTING BrightLocal reports (no extra per-request credit
// cost). BrightLocal's Google Business Profile report (/v4/gpw) already bundles
// everything we surface: local rankings, citation count + NAP consistency,
// review totals, domain authority, backlinks and GBP audit signals.
//
// Every fetcher returns data in the SAME shape mock.js produces
// (`data.brightlocal`), so the UI never needs to know whether a widget is live
// or sample. On ANY error it returns { available:false, error } and the server
// falls back to mock cleanly — a bad key or missing report can never break the
// dashboard.
//
// Config — one API key for the whole agency, set once in .env:
//   BRIGHTLOCAL_API_KEY=...
// Then map each client to its BrightLocal location (admin UI → "Connect data"):
//   client.brightlocal = { locationId, gbpReportId? }
// When no gbpReportId is stored we auto-pick the location's first GBP report.

const BASE = 'https://tools.brightlocal.com/seo-tools/api';

/** True when we have an API key to talk to BrightLocal at all. */
export function brightlocalConfigured() {
  return Boolean(process.env.BRIGHTLOCAL_API_KEY);
}

const round = (n) => Math.round(+n || 0);
const pct1 = (n) => +(+n || 0).toFixed(1);

// BrightLocal's current REST methods authenticate with the api-key alone (no
// sig/expires signature). Reading an already-run report costs no credits.
async function blGet(path, params = {}) {
  const key = process.env.BRIGHTLOCAL_API_KEY;
  if (!key) throw new Error('No BrightLocal API key configured');
  const qs = new URLSearchParams({ 'api-key': key, ...params }).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`BrightLocal ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }
  if (!res.ok || json.success === false) {
    const msg = json?.errors ? JSON.stringify(json.errors) : `HTTP ${res.status}`;
    throw new Error(`BrightLocal ${path}: ${msg}`);
  }
  return json;
}

// Different BrightLocal responses wrap the payload differently and mix
// snake_case / kebab-case keys; these readers tolerate both.
const pickKey = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return undefined;
};
const unwrap = (j) => j.results || j.response?.results || j.response || j;

// Find the first GBP report id for a location when none is stored.
async function firstGbpReportId(locationId) {
  const j = await blGet('/v4/gpw', { 'location-id': locationId });
  const list = unwrap(j);
  const arr = Array.isArray(list) ? list : list.results || [];
  const first = arr.find((r) => pickKey(r, 'report_id', 'report-id'));
  return first ? pickKey(first, 'report_id', 'report-id') : null;
}

// List EVERY Google Business Profile report in the account (no location filter).
// Used by Sync to discover which BrightLocal reports exist and auto-map them to
// the agency's clients. The report_name is usually "Business Name, CODE", so we
// split off the business-name part for matching. Reading the list is free.
export async function listGbpReports() {
  try {
    const j = await blGet('/v4/gpw');
    const list = unwrap(j);
    const arr = Array.isArray(list) ? list : list.results || [];
    const reports = arr
      .map((r) => {
        const reportId = pickKey(r, 'report_id', 'report-id');
        const locationId = pickKey(r, 'location_id', 'location-id');
        const rawName = pickKey(r, 'report_name', 'report-name') || '';
        // "Brooklyn Blvd Dental, BROOKLYNBLVD-55429" -> "Brooklyn Blvd Dental"
        const bizName = String(rawName).split(',')[0].trim() || rawName;
        return reportId ? { reportId, locationId, name: bizName, rawName } : null;
      })
      .filter(Boolean);
    return { available: true, reports };
  } catch (e) {
    return { available: false, error: e.message, reports: [] };
  }
}

export async function fetchBrightLocal(locationId, { gbpReportId } = {}) {
  try {
    if (!locationId && !gbpReportId) return { available: false, error: 'No BrightLocal location configured' };
    const reportId = gbpReportId || (await firstGbpReportId(locationId));
    if (!reportId) return { available: false, error: 'No BrightLocal GBP report found for this location' };

    const j = await blGet(`/v4/gpw/${reportId}/results`);
    const root = unwrap(j);
    const summary = root.summary || {};
    const keywords = Array.isArray(root.keywords) ? root.keywords : [];
    const urls = j.urls || root.urls || {};

    const localRankings = keywords.slice(0, 12).map((k) => {
      const raw = pickKey(k, 'client_rank', 'client-rank');
      const rank = raw == null ? null : +raw;
      const t10 = pickKey(k, 'top_10', 'top-10');
      return {
        keyword: pickKey(k, 'keyword', 'search_term', 'term') || '—',
        rank,
        inTop3: rank != null && rank <= 3,
        inTop10: t10 != null ? Boolean(t10) : rank != null && rank <= 10,
      };
    });

    // NAP consistency: derive a % from the nap_comparison match flags if present.
    let napConsistency = null;
    const naps = keywords.flatMap((k) => pickKey(k, 'nap_comparison', 'nap-comparison') || []);
    if (naps.length) {
      const matches = naps.filter((n) => n && (n.match === true || n.matches === true || n.status === 'match')).length;
      napConsistency = pct1((matches / naps.length) * 100);
    }

    const num = (v) => (v != null ? round(v) : null);
    const brightlocal = {
      hasData: true,
      businessName: pickKey(summary, 'business_name', 'business-name') || null,
      website: pickKey(summary, 'website_address', 'website-address', 'website') || null,
      claimed: Boolean(summary.claimed),
      domainAuthority: num(pickKey(summary, 'domain_authority', 'domain-authority')),
      backlinks: num(summary.backlinks),
      citations: {
        count: num(pickKey(summary, 'citations_count', 'citations-count')),
        possible: null,
        napConsistency,
      },
      reviews: {
        count: num(pickKey(summary, 'num_reviews', 'num-reviews')),
        avgRating: (() => {
          const s = pickKey(summary, 'star_rating', 'star-rating');
          return s != null ? pct1(s) : null;
        })(),
      },
      photos: num(pickKey(summary, 'num_photos', 'num-photos')),
      localRankings,
      reportUrl: pickKey(urls, 'report_url', 'report-url') || null,
      collectedAt: new Date().toISOString(),
    };

    return { available: true, brightlocal };
  } catch (e) {
    return { available: false, error: e.message };
  }
}
