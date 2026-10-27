// estimates.js — third-party ESTIMATED SEO metrics by URL alone.
//
// IMPORTANT: these are modeled estimates, NOT a site's real Search Console /
// GA4 numbers. Real GSC/GA4 data is private to the property owner and can only
// come through the authenticated Google service account (see google.js). This
// module exists for the "sync" fallback: sites the service account has NOT been
// granted access to get a clearly-labeled estimate instead of blank widgets.
//
// Providers (used in priority order, whichever is configured):
//   • DataForSEO       — paid, pay-as-you-go. Gives estimated organic traffic
//                        and ranking-keyword counts by domain. Set:
//                        DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD
//   • OpenPageRank     — FREE (register for a key at openpagerank.com). Gives a
//                        0–10 page-rank / domain-authority proxy by domain. Set:
//                        OPENPAGERANK_API_KEY
//
// There is deliberately NO "free traffic + keyword data by URL" provider here,
// because a genuinely free one that returns real numbers does not exist. Free
// gets you domain authority; traffic/keyword estimates need a paid key.

const DF_LOGIN = () => process.env.DATAFORSEO_LOGIN || '';
const DF_PASS = () => process.env.DATAFORSEO_PASSWORD || '';
const OPR_KEY = () => process.env.OPENPAGERANK_API_KEY || '';

/** True when at least one estimates provider has credentials. */
export function estimatesConfigured() {
  return Boolean((DF_LOGIN() && DF_PASS()) || OPR_KEY());
}

/** Which providers are wired up — surfaced to the UI so expectations are honest. */
export function estimatesProviders() {
  return {
    dataforseo: Boolean(DF_LOGIN() && DF_PASS()),
    openpagerank: Boolean(OPR_KEY()),
  };
}

function hostOf(u) {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// ---------- DataForSEO: estimated organic traffic + keyword count ----------
async function fromDataForSEO(domain) {
  const auth = Buffer.from(`${DF_LOGIN()}:${DF_PASS()}`).toString('base64');
  const res = await fetch(
    'https://api.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live',
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ target: domain, location_code: 2840, language_code: 'en' }]),
    }
  );
  if (!res.ok) throw new Error(`DataForSEO HTTP ${res.status}`);
  const json = await res.json();
  const item = json?.tasks?.[0]?.result?.[0]?.items?.[0];
  const metrics = item?.metrics?.organic;
  if (!metrics) throw new Error('DataForSEO returned no organic metrics');
  return {
    organicTrafficEst: Math.round(metrics.etv || 0),      // estimated traffic value (visits/mo)
    keywordsEst: Math.round(metrics.count || 0),          // ranking keyword count
    organicValueEst: Math.round(metrics.estimated_paid_traffic_cost || 0),
  };
}

// ---------- OpenPageRank: free domain-authority proxy (0–10 + global rank) ----------
async function fromOpenPageRank(domain) {
  const res = await fetch(
    `https://openpagerank.com/api/v1.0/getPageRank?domains%5B%5D=${encodeURIComponent(domain)}`,
    { headers: { 'API-OPR': OPR_KEY() } }
  );
  if (!res.ok) throw new Error(`OpenPageRank HTTP ${res.status}`);
  const json = await res.json();
  const row = json?.response?.[0];
  if (!row || row.status_code !== 200) throw new Error('OpenPageRank has no data for this domain');
  const pr = +row.page_rank_decimal || 0; // 0–10
  return {
    pageRank: pr,
    domainAuthorityEst: Math.round(pr * 10), // crude 0–100 DA-style scale for display parity
    globalRank: row.rank ? Number(row.rank) : null,
  };
}

/**
 * Fetch whatever estimates the configured providers can give for a URL.
 * Returns { available, provider, fetchedAt, data } or { available:false, error }.
 * Merges DataForSEO (traffic/keywords) + OpenPageRank (authority) when both exist.
 */
export async function fetchEstimates(url) {
  const domain = hostOf(url);
  if (!domain) return { available: false, error: 'Invalid URL' };
  if (!estimatesConfigured()) {
    return { available: false, error: 'No estimates provider configured (set OPENPAGERANK_API_KEY and/or DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD)' };
  }

  const data = {};
  const used = [];
  const errors = [];

  if (DF_LOGIN() && DF_PASS()) {
    try { Object.assign(data, await fromDataForSEO(domain)); used.push('DataForSEO'); }
    catch (e) { errors.push(e.message); }
  }
  if (OPR_KEY()) {
    try { Object.assign(data, await fromOpenPageRank(domain)); used.push('OpenPageRank'); }
    catch (e) { errors.push(e.message); }
  }

  if (!used.length) return { available: false, error: errors.join('; ') || 'All estimate providers failed' };
  return { available: true, provider: used.join(' + '), fetchedAt: new Date().toISOString(), data, warnings: errors };
}
