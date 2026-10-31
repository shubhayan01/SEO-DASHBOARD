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
//   PHASE C (synth): opt-in per owner. For clients STILL without real Google
//                    data, generate a full, realistic, self-consistent dataset
//                    (seeded per site) and mark it to render as "live". No
//                    external calls. Used for the Justwords workspace, whose
//                    own sites have no service-account grant — the owner asked
//                    for realistic live-style figures instead of "Sample".
//                    When Phase C runs it replaces Phase B for that owner.
//
// Outside Phase C nothing is fabricated: a site with no Google grant and no
// estimates provider simply stays on sample data, and the report says so.

import { googleConfigured, listSearchConsoleSites, listGA4Properties } from './google.js';
import { estimatesConfigured, estimatesProviders, fetchEstimates } from './estimates.js';
import { brightlocalConfigured, listGbpReports, fetchBrightLocal } from './brightlocal.js';

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
      hasSynthetic: () => Boolean(s.synthetic),
      setSynthetic: (v) => { s.synthetic = v; },
      getBl: () => (s.brightlocal = s.brightlocal || {}),
      hasBl: () => Boolean(s.brightlocal?.locationId || s.brightlocal?.gbpReportId),
      setBl: (bl) => { s.brightlocal = { ...(s.brightlocal || {}), ...bl }; },
    }));
  }
  return [{
    url: client.url, name: client.name,
    get: () => (client.google = client.google || {}),
    hasReal: () => Boolean(client.google?.gscSiteUrl || client.google?.ga4PropertyId),
    setEstimates: (e) => { client.estimates = e; },
    hasSynthetic: () => Boolean(client.synthetic),
    setSynthetic: (v) => { client.synthetic = v; },
    getBl: () => (client.brightlocal = client.brightlocal || {}),
    hasBl: () => Boolean(client.brightlocal?.locationId || client.brightlocal?.gbpReportId),
    setBl: (bl) => { client.brightlocal = { ...(client.brightlocal || {}), ...bl }; },
  }];
}

// A stable-ish random seed string for a freshly synthesized site.
function newSynthSeed() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
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

// Candidate BrightLocal reports for a client: same (normalized) business name,
// or one name contained in the other. Returns all candidates so the caller can
// break ties by website host when a brand has several GBP locations.
function matchBlReports(reports, name) {
  const n = norm(name);
  if (!n) return [];
  const exact = reports.filter((r) => norm(r.name) === n);
  if (exact.length) return exact;
  return reports.filter((r) => {
    const rn = norm(r.name);
    return rn && (rn.includes(n) || n.includes(rn));
  });
}

export function syncReadiness() {
  return {
    googleConfigured: googleConfigured(),
    estimatesConfigured: estimatesConfigured(),
    providers: estimatesProviders(),
    brightlocalConfigured: brightlocalConfigured(),
  };
}

/**
 * Run a full sync. `read`/`write` operate on the clients file; we re-read at the
 * start and write once at the end so a concurrent edit isn't clobbered mid-run.
 * Returns a detailed, honest report of what happened.
 */
export async function runSync({ read, write, clientsFile, owner = null, synthetic = false }) {
  const startedAt = new Date().toISOString();
  const report = {
    startedAt, finishedAt: null,
    googleConfigured: googleConfigured(),
    estimatesConfigured: estimatesConfigured(),
    brightlocalConfigured: brightlocalConfigured(),
    phaseA: { gscMatched: 0, ga4Matched: 0, details: [], skipped: null },
    phaseBL: { mapped: 0, fetched: 0, unmatched: 0, failed: 0, details: [], skipped: null },
    phaseB: { estimated: 0, failed: 0, provider: null, details: [], skipped: null },
    phaseC: { synthesized: 0, details: [], skipped: null },
  };

  const clients = read(clientsFile);
  // When an owner is given, only that tenant's clients are touched (the whole
  // file is still written back, so other tenants are left exactly as they were).
  const scoped = owner ? clients.filter((c) => (c.owner || 'agency') === owner) : clients;

  // ---------- PHASE A: real GSC/GA4 discovery + mapping ----------
  if (!googleConfigured()) {
    report.phaseA.skipped = 'Google service account not configured — no real data to map.';
  } else {
    const [gscSites, ga4Props] = await Promise.all([listSearchConsoleSites(), listGA4Properties()]);
    for (const client of scoped) {
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

  // ---------- PHASE BL: BrightLocal — map every client to its GBP report ----------
  // One agency API key sees every client's BrightLocal report. We list them all,
  // auto-map each to a client by business name (website host breaks ties when a
  // brand has several locations), store the mapping so report views pull live
  // local-SEO data, and cache a snapshot so the portfolio shows live numbers too.
  if (!brightlocalConfigured()) {
    report.phaseBL.skipped = 'BrightLocal API key not configured.';
  } else {
    const listed = await listGbpReports();
    if (!listed.available) {
      report.phaseBL.skipped = 'Could not list BrightLocal reports: ' + listed.error;
    } else {
      const reports = listed.reports;
      const resultsCache = new Map(); // reportId -> fetchBrightLocal result
      const getResults = async (locationId, reportId) => {
        if (!resultsCache.has(reportId)) resultsCache.set(reportId, await fetchBrightLocal(locationId, { gbpReportId: reportId }));
        return resultsCache.get(reportId);
      };
      const snapshotFrom = (b) => ({
        reviews: b.reviews?.count ?? null,
        avgRating: b.reviews?.avgRating ?? null,
        citations: b.citations?.count ?? null,
        napConsistency: b.citations?.napConsistency ?? null,
        domainAuthority: b.domainAuthority ?? null,
        backlinks: b.backlinks ?? null,
        top3: Array.isArray(b.localRankings) ? b.localRankings.filter((k) => k.inTop3).length : null,
        top10: Array.isArray(b.localRankings) ? b.localRankings.filter((k) => k.inTop10).length : null,
        reportUrl: b.reportUrl ?? null,
        collectedAt: new Date().toISOString(),
      });
      // Commit a chosen report onto a target: store the mapping, enable the
      // BrightLocal connector on its client so the Local SEO card renders, and
      // cache the live snapshot when its results came back.
      const applyMapping = async (client, t, chosen) => {
        t.setBl({ locationId: String(chosen.locationId || ''), gbpReportId: String(chosen.reportId || '') });
        client.connectors = client.connectors || {};
        client.connectors.brightlocal = true;
        report.phaseBL.mapped++;
        const r = await getResults(chosen.locationId, chosen.reportId);
        if (r.available) {
          t.setBl({ snapshot: snapshotFrom(r.brightlocal) });
          report.phaseBL.fetched++;
          report.phaseBL.details.push({ client: t.name, report: chosen.rawName, reportId: chosen.reportId, reviews: r.brightlocal.reviews?.count, rating: r.brightlocal.reviews?.avgRating });
        } else {
          report.phaseBL.failed++;
          report.phaseBL.details.push({ client: t.name, report: chosen.rawName, reportId: chosen.reportId, error: r.error });
        }
      };

      // Pass 1 — match by business name (website host breaks ties among a brand's
      // multiple locations). Collect anything still unmatched for pass 2.
      const unresolved = [];
      for (const client of scoped) {
        for (const t of targetsOf(client)) {
          if (t.hasBl()) continue; // keep an existing mapping stable on re-sync
          const candidates = matchBlReports(reports, t.name);
          if (!candidates.length) { unresolved.push({ client, t }); continue; }
          let chosen = candidates[0];
          if (candidates.length > 1) {
            const h = host(t.url);
            for (const c of candidates) {
              const r = await getResults(c.locationId, c.reportId);
              if (r.available && host(r.brightlocal.website) === h) { chosen = c; break; }
            }
          }
          await applyMapping(client, t, chosen);
        }
      }

      // Pass 2 — website-host fallback for clients whose name didn't match any
      // report (e.g. "IMIT" vs report "Imagine IT", or a typo'd client name).
      // We read each remaining report's results (free) to learn its website and
      // match on host. Only runs when something is still unresolved.
      if (unresolved.length) {
        const chosenIds = new Set(scoped.flatMap((c) => targetsOf(c)).map((t) => t.getBl().gbpReportId).filter(Boolean));
        const remaining = reports.filter((r) => !chosenIds.has(String(r.reportId)));
        const byHost = new Map();
        await Promise.all(remaining.map(async (rep) => {
          const r = await getResults(rep.locationId, rep.reportId);
          if (r.available) { const h = host(r.brightlocal.website); if (h && !byHost.has(h)) byHost.set(h, rep); }
        }));
        for (const { client, t } of unresolved) {
          const rep = byHost.get(host(t.url));
          if (rep) { await applyMapping(client, t, rep); }
          else { report.phaseBL.unmatched++; report.phaseBL.details.push({ client: t.name, status: 'no BrightLocal report' }); }
        }
      }
    }
  }

  // ---------- PHASE C: synthetic "live" data (opt-in per owner) ----------
  // For an owner that opted in (Justwords), every site still lacking real
  // Google data gets a realistic, self-consistent dataset rendered as "live".
  // This replaces Phase B for that owner and makes no external calls.
  if (synthetic) {
    report.phaseB.skipped = 'Synthetic mode on for this workspace — Phase B (estimates) skipped.';
    for (const client of scoped) {
      for (const t of targetsOf(client)) {
        if (t.hasReal() || t.hasSynthetic()) continue; // keep existing numbers stable on re-sync
        t.setSynthetic({ seed: newSynthSeed(), generatedAt: new Date().toISOString() });
        report.phaseC.synthesized++;
        report.phaseC.details.push({ client: t.name });
      }
    }
    write(clientsFile, clients);
    report.finishedAt = new Date().toISOString();
    return report;
  }
  report.phaseC.skipped = 'Synthetic mode off for this workspace.';

  // ---------- PHASE B: estimated metrics for the still-unconnected ----------
  if (!estimatesConfigured()) {
    report.phaseB.skipped = 'No estimates provider configured — unconnected sites stay on sample data.';
  } else {
    const pending = [];
    for (const client of scoped)
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
