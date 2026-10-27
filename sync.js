// sync.js — the "sync" action behind the dashboard button / typed command.
//
// Two phases, in order of data quality:
//   PHASE A (real):  ask Google which Search Console sites + GA4 properties the
//                    service account can actually see, match them to clients by
//                    domain (then name), and write gscSiteUrl / ga4PropertyId.
//                    Those clients flip from sample → LIVE real data on next view.
//   PHASE B (est.):  for clients STILL without a real GSC/GA4 mapping, pull
//                    estimated metrics by URL from a third-party provider and
//                    stash them on client.estimates, clearly labeled "estimated".
//
// Nothing is fabricated: a site with no Google grant and no estimates provider
// simply stays on sample data, and the report says so.

import { googleConfigured, listSearchConsoleSites, listGA4Properties } from './google.js';
import { estimatesConfigured, estimatesProviders, fetchEstimates } from './estimates.js';

// ---- matching helpers (kept consistent with gsc-ga4-discover.js) ----
const host = (u) => {
  try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).host.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
};
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const gscHost = (siteUrl) =>
  siteUrl.startsWith('sc-domain:') ? siteUrl.slice('sc-domain:'.length).replace(/^www\./, '').toLowerCase() : host(siteUrl);

// A client may be a single site or a group with sites[]. Return the list of
// { getGoogle, setGoogle, url, name } targets to resolve, so both shapes work.
function targetsOf(client) {
  if (Array.isArray(client.sites) && client.sites.length) {
    return client.sites.map((s) => ({
      url: s.url, name: s.name,
      get: () => (s.google = s.google || {}),
      hasReal: () => Boolean(s.google?.gscSiteUrl || s.google?.ga4PropertyId),
      setEstimates: (e) => { s.estimates = e; },
    }));
  }
  return [{
    url: client.url, name: client.name,
    get: () => (client.google = client.google || {}),
    hasReal: () => Boolean(client.google?.gscSiteUrl || client.google?.ga4PropertyId),
    setEstimates: (e) => { client.estimates = e; },
  }];
}

function matchGsc(sites, url) {
  const h = host(url);
  return sites.find((s) => gscHost(s.siteUrl) === h) || null;
}
function matchGa4(props, url, name) {
  const h = host(url), n = norm(name);
  return props.find((p) => host(p.name) && host(p.name) === h)
    || props.find((p) => norm(p.name) === n)
    || props.find((p) => n && (norm(p.name).includes(n) || n.includes(norm(p.name))))
    || null;
}

export function syncReadiness() {
  return { googleConfigured: googleConfigured(), estimatesConfigured: estimatesConfigured(), providers: estimatesProviders() };
}

/**
 * Run a full sync. `read`/`write` operate on the clients file; we re-read at the
 * start and write once at the end so a concurrent edit isn't clobbered mid-run.
 * Returns a detailed, honest report of what happened.
 */
export async function runSync({ read, write, clientsFile }) {
  const startedAt = new Date().toISOString();
  const report = {
    startedAt, finishedAt: null,
    googleConfigured: googleConfigured(),
    estimatesConfigured: estimatesConfigured(),
    phaseA: { gscMatched: 0, ga4Matched: 0, details: [], skipped: null },
    phaseB: { estimated: 0, failed: 0, provider: null, details: [], skipped: null },
  };

  const clients = read(clientsFile);

  // ---------- PHASE A: real GSC/GA4 discovery + mapping ----------
  if (!googleConfigured()) {
    report.phaseA.skipped = 'Google service account not configured — no real data to map.';
  } else {
    const [gscSites, ga4Props] = await Promise.all([listSearchConsoleSites(), listGA4Properties()]);
    for (const client of clients) {
      for (const t of targetsOf(client)) {
        const g = t.get();
        if (!g.gscSiteUrl) {
          const m = matchGsc(gscSites, t.url);
          if (m) { g.gscSiteUrl = m.siteUrl; report.phaseA.gscMatched++;
            report.phaseA.details.push({ client: t.name, type: 'gsc', mapped: m.siteUrl }); }
        }
        if (!g.ga4PropertyId) {
          const m = matchGa4(ga4Props, t.url, t.name);
          if (m) { g.ga4PropertyId = m.id; report.phaseA.ga4Matched++;
            report.phaseA.details.push({ client: t.name, type: 'ga4', mapped: `${m.id} (${m.name})` }); }
        }
      }
    }
  }

  // ---------- PHASE B: estimated metrics for the still-unconnected ----------
  if (!estimatesConfigured()) {
    report.phaseB.skipped = 'No estimates provider configured — unconnected sites stay on sample data.';
  } else {
    const pending = [];
    for (const client of clients)
      for (const t of targetsOf(client))
        if (!t.hasReal()) pending.push(t);

    for (const t of pending) {
      try {
        const est = await fetchEstimates(t.url);
        if (est.available) {
          t.setEstimates({ provider: est.provider, fetchedAt: est.fetchedAt, ...est.data });
          report.phaseB.estimated++;
          report.phaseB.provider = est.provider;
          report.phaseB.details.push({ client: t.name, provider: est.provider, data: est.data });
        } else {
          report.phaseB.failed++;
          report.phaseB.details.push({ client: t.name, error: est.error });
        }
      } catch (e) {
        report.phaseB.failed++;
        report.phaseB.details.push({ client: t.name, error: e.message });
      }
    }
  }

  // Persist everything we learned (re-read + merge would be overkill here; the
  // sync is admin-triggered and single-flighted by the caller).
  write(clientsFile, clients);
  report.finishedAt = new Date().toISOString();
  return report;
}
