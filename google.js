// google.js — real Google API integration for the Justwords dashboard.
//
// All fetchers return data in the SAME shape the mock generator produces, so
// the UI never needs to know whether a widget is showing mock or live numbers.
// Each fetcher returns { available: true, ... } on success, or
// { available: false, error } so the server can fall back to mock cleanly.
//
// Auth: a single Google **service account** (recommended for an agency that
// owns all 25+ properties). Grant that service account:
//   • Search Console  — add the service-account email as a user on each property
//   • GA4             — add it as a Viewer on each GA4 property
//   • Business Profile— add it as a manager on the business/location
// Configure it via one of:
//   GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json      (path)
//   GOOGLE_SERVICE_ACCOUNT_JSON={...}                       (inline JSON)
//   GOOGLE_ACCESS_TOKEN=ya29....   (short-lived token, e.g. for local testing)
// PageSpeed / CrUX only need an API key: GOOGLE_PSI_KEY.

import fs from 'fs';
import jwt from 'jsonwebtoken';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = {
  gsc: 'https://www.googleapis.com/auth/webmasters.readonly',
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
  gbp: 'https://www.googleapis.com/auth/business.manage',
};

// ---------- service-account credentials ----------
let _creds = null;
function loadCreds() {
  if (_creds !== null) return _creds;
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      _creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE && fs.existsSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE)) {
      _creds = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
    } else {
      _creds = false;
    }
  } catch (e) {
    console.warn('[google] could not parse service account:', e.message);
    _creds = false;
  }
  return _creds;
}

/** True when we have *some* way to authenticate the Google user-data APIs. */
export function googleConfigured() {
  return Boolean(process.env.GOOGLE_ACCESS_TOKEN || loadCreds());
}

// ---------- OAuth2 access token (cached per scope-set) ----------
const _tokenCache = new Map(); // scopeKey -> { token, exp }

async function getAccessToken(scopeList) {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  const creds = loadCreds();
  if (!creds) throw new Error('No Google credentials configured');

  const scope = scopeList.join(' ');
  const cached = _tokenCache.get(scope);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const claims = {
    iss: creds.client_email,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  // Domain-wide delegation (optional) — impersonate a Workspace user.
  if (process.env.GOOGLE_IMPERSONATE_SUBJECT) claims.sub = process.env.GOOGLE_IMPERSONATE_SUBJECT;

  const assertion = jwt.sign(claims, creds.private_key, { algorithm: 'RS256' });
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Google token HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  _tokenCache.set(scope, { token: json.access_token, exp: now + (json.expires_in || 3600) });
  return json.access_token;
}

async function gapi(url, { scope, method = 'GET', body } = {}) {
  const token = await getAccessToken(scope);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// =====================================================================
// Discovery — what can this service account actually see?
// Used by the "sync" flow to auto-map clients to their real properties.
// Each returns [] (never throws) so a sync can degrade gracefully.
// =====================================================================

/** All Search Console sites the service account is verified on. */
export async function listSearchConsoleSites() {
  try {
    const j = await gapi('https://www.googleapis.com/webmasters/v3/sites', { scope: [SCOPES.gsc] });
    return (j.siteEntry || [])
      .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
      .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
  } catch (e) {
    console.warn('[google] list GSC sites failed:', e.message.split('\n')[0]);
    return [];
  }
}

/** All GA4 properties the service account can read (flattened across accounts). */
export async function listGA4Properties() {
  try {
    const out = [];
    let pageToken = '';
    do {
      const u = `https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const j = await gapi(u, { scope: [SCOPES.ga4] });
      for (const acc of j.accountSummaries || [])
        for (const p of acc.propertySummaries || [])
          out.push({ property: p.property, id: p.property.split('/')[1], name: p.displayName, account: acc.displayName });
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  } catch (e) {
    console.warn('[google] list GA4 properties failed:', e.message.split('\n')[0]);
    return [];
  }
}

// ---------- small helpers ----------
const round = (n) => Math.round(n);
const pct1 = (n) => +(+n).toFixed(1);
function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
function shortLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// =====================================================================
// Google Search Console — Search Analytics API
// =====================================================================
export async function fetchSearchConsole(siteUrl, days = 30) {
  try {
    const base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const range = { startDate: isoDaysAgo(days), endDate: isoDaysAgo(1) };
    const opts = { scope: [SCOPES.gsc], method: 'POST' };

    const [byDate, byQuery, byPage, byCountry, byDevice] = await Promise.all([
      gapi(base, { ...opts, body: { ...range, dimensions: ['date'], rowLimit: 400 } }),
      gapi(base, { ...opts, body: { ...range, dimensions: ['query'], rowLimit: 25 } }),
      gapi(base, { ...opts, body: { ...range, dimensions: ['page'], rowLimit: 10 } }),
      gapi(base, { ...opts, body: { ...range, dimensions: ['country'], rowLimit: 6 } }),
      gapi(base, { ...opts, body: { ...range, dimensions: ['device'], rowLimit: 3 } }),
    ]);

    const dateRows = byDate.rows || [];
    const clicksSeries = dateRows.map((r) => round(r.clicks));
    const impressionsSeries = dateRows.map((r) => round(r.impressions));
    const labels = dateRows.map((r) => shortLabel(r.keys[0]));
    const totalClicks = clicksSeries.reduce((a, b) => a + b, 0);
    const totalImpr = impressionsSeries.reduce((a, b) => a + b, 0);

    const searchConsole = {
      clicks: totalClicks,
      impressions: totalImpr,
      ctr: totalImpr ? pct1((totalClicks / totalImpr) * 100) : 0,
      avgPosition: pct1(
        (byQuery.rows || []).reduce((s, r) => s + r.position, 0) / Math.max(1, (byQuery.rows || []).length)
      ),
      labels,
      clicksSeries,
      impressionsSeries,
    };

    const topQueries = (byQuery.rows || []).map((r) => ({
      query: r.keys[0],
      clicks: round(r.clicks),
      impressions: round(r.impressions),
      ctr: pct1(r.ctr * 100),
      position: pct1(r.position),
    }));

    // Keyword rankings table derived from top queries.
    const keywordRankings = topQueries.slice(0, 12).map((q) => ({
      keyword: q.query,
      position: Math.round(q.position),
      prevPosition: Math.round(q.position),
      change: 0,
      volume: q.impressions,
      difficulty: null,
      intent: '—',
      url: '',
    }));

    const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
    const gscCountries = (byCountry.rows || []).map((r) => {
      let name = r.keys[0];
      try { name = COUNTRY_NAMES.of(name.toUpperCase()) || name; } catch { /* keep code */ }
      return { country: name, clicks: round(r.clicks), share: totalClicks ? pct1((r.clicks / totalClicks) * 100) : 0 };
    });

    const DEVICE_COLORS = { MOBILE: '#5b8def', DESKTOP: '#41c789', TABLET: '#e0a53d' };
    const gscDevices = (byDevice.rows || []).map((r) => ({
      device: r.keys[0].charAt(0) + r.keys[0].slice(1).toLowerCase(),
      share: totalClicks ? pct1((r.clicks / totalClicks) * 100) : 0,
      color: DEVICE_COLORS[r.keys[0]] || '#8a6bf0',
    }));

    return {
      available: true,
      searchConsole,
      topQueries,
      keywordRankings,
      gscCountries,
      gscDevices,
      topPagesGsc: (byPage.rows || []).map((r) => ({
        path: r.keys[0].replace(/^https?:\/\/[^/]+/, '') || '/',
        traffic: round(r.clicks),
        keywords: null,
        changePct: 0,
      })),
      overview: {
        organicClicks: totalClicks,
        avgPosition: searchConsole.avgPosition,
      },
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// =====================================================================
// Google Analytics 4 — Data API (runReport)
// =====================================================================
async function ga4RunReport(propertyId, body) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
  return gapi(url, { scope: [SCOPES.ga4], method: 'POST', body });
}

export async function fetchGA4(propertyId, days = 30) {
  try {
    const dateRanges = [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }];

    const [totals, series, channels, landing] = await Promise.all([
      ga4RunReport(propertyId, {
        dateRanges,
        metrics: ['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'engagementRate',
          'averageSessionDuration', 'bounceRate', 'screenPageViewsPerSession', 'conversions']
          .map((name) => ({ name })),
      }),
      ga4RunReport(propertyId, {
        dateRanges,
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      }),
      ga4RunReport(propertyId, {
        dateRanges,
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 6,
      }),
      ga4RunReport(propertyId, {
        dateRanges,
        dimensions: [{ name: 'landingPagePlusQueryString' }],
        metrics: [{ name: 'sessions' }, { name: 'sessionConversionRate' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 5,
      }),
    ]);

    const m = (row, i) => +(row?.metricValues?.[i]?.value || 0);
    const t = totals.rows?.[0];
    const CHANNEL_COLORS = ['#5b8def', '#41c789', '#8a6bf0', '#e0a53d', '#e0607a', '#8b98a9'];

    const ga4 = {
      sessions: round(m(t, 0)),
      users: round(m(t, 1)),
      newUsers: round(m(t, 2)),
      engagedSessions: round(m(t, 3)),
      engagementRate: pct1(m(t, 4) * 100),
      avgEngagementSec: round(m(t, 5)),
      bounceRate: pct1(m(t, 6) * 100),
      pagesPerSession: pct1(m(t, 7)),
      conversions: round(m(t, 8)),
      conversionRate: t && m(t, 0) ? pct1((m(t, 8) / m(t, 0)) * 100) : 0,
      sessionsSeries: (series.rows || []).map((r) => round(+r.metricValues[0].value)),
      channels: (channels.rows || []).map((r, i) => ({
        channel: r.dimensionValues[0].value,
        value: round(+r.metricValues[0].value),
        color: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
      })),
      topLandingPages: (landing.rows || []).map((r) => ({
        path: r.dimensionValues[0].value,
        sessions: round(+r.metricValues[0].value),
        convRate: pct1(+r.metricValues[1].value * 100),
      })),
    };

    return { available: true, ga4, overview: { organicTraffic: ga4.sessions } };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// =====================================================================
// Google Business Profile — Performance API + reviews
// locationId format: "locations/1234567890"
// =====================================================================
export async function fetchGBP(locationId, { accountId } = {}) {
  try {
    const loc = locationId.startsWith('locations/') ? locationId : `locations/${locationId}`;
    const base = `https://businessprofileperformance.googleapis.com/v1/${loc}:fetchMultiDailyMetricsTimeSeries`;
    const end = new Date(Date.now() - 2 * 86400000);
    const start = new Date(end.getTime() - 89 * 86400000);
    const dateParams = (prefix, d) =>
      `${prefix}.year=${d.getUTCFullYear()}&${prefix}.month=${d.getUTCMonth() + 1}&${prefix}.day=${d.getUTCDate()}`;
    const METRICS = [
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'CALL_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'WEBSITE_CLICKS',
      'BUSINESS_CONVERSATIONS', 'BUSINESS_BOOKINGS',
    ];
    const qs = METRICS.map((x) => `dailyMetrics=${x}`).join('&') +
      `&${dateParams('dailyRange.start_date', start)}&${dateParams('dailyRange.end_date', end)}`;

    const data = await gapi(`${base}?${qs}`, { scope: [SCOPES.gbp] });
    const byMetric = {};
    let dailySeries = [];
    for (const ts of data.multiDailyMetricTimeSeries || []) {
      for (const dm of ts.dailyMetricTimeSeries || []) {
        const values = (dm.timeSeries?.datedValues || []).map((v) => +(v.value || 0));
        byMetric[dm.dailyMetric] = values.reduce((a, b) => a + b, 0);
        if (dm.dailyMetric === 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH' && values.length) {
          dailySeries = values; // representative series for the reach chart
        }
      }
    }
    const g = (k) => round(byMetric[k] || 0);
    const searchImpr = g('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') + g('BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
    const mapsImpr = g('BUSINESS_IMPRESSIONS_DESKTOP_MAPS') + g('BUSINESS_IMPRESSIONS_MOBILE_MAPS');
    const desktop = g('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') + g('BUSINESS_IMPRESSIONS_DESKTOP_MAPS');
    const mobile = g('BUSINESS_IMPRESSIONS_MOBILE_SEARCH') + g('BUSINESS_IMPRESSIONS_MOBILE_MAPS');
    const calls = g('CALL_CLICKS'), directions = g('BUSINESS_DIRECTION_REQUESTS');
    const website = g('WEBSITE_CLICKS'), messages = g('BUSINESS_CONVERSATIONS'), bookings = g('BUSINESS_BOOKINGS');

    // Reviews (best-effort; needs accountId + Business Information / My Business v4).
    let reviews = null;
    if (accountId) {
      try {
        const rv = await gapi(
          `https://mybusiness.googleapis.com/v4/${accountId}/${loc}/reviews`,
          { scope: [SCOPES.gbp] }
        );
        const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
        const list = rv.reviews || [];
        reviews = {
          count: rv.totalReviewCount || list.length,
          avgRating: pct1(rv.averageRating || 0),
          newThisMonth: null,
          responseRate: null,
          distribution: [5, 4, 3, 2, 1].map((s) => ({
            stars: s, value: list.filter((r) => STAR[r.starRating] === s).length,
          })),
          recent: list.slice(0, 4).map((r) => ({
            author: r.reviewer?.displayName || 'Google user',
            rating: STAR[r.starRating] || 0,
            text: r.comment || '',
            daysAgo: Math.max(0, Math.round((Date.now() - new Date(r.createTime).getTime()) / 86400000)),
          })),
        };
      } catch { /* reviews optional */ }
    }

    const gbp = {
      profile: null, // populated from Business Information API if available
      reach: {
        total: searchImpr + mapsImpr,
        changePct: 0,
        search: searchImpr, maps: mapsImpr, desktop, mobile,
      },
      viewsBreakdown: [
        { label: 'Search · Mobile', value: g('BUSINESS_IMPRESSIONS_MOBILE_SEARCH'), color: '#5b8def' },
        { label: 'Search · Desktop', value: g('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'), color: '#8a6bf0' },
        { label: 'Maps · Mobile', value: g('BUSINESS_IMPRESSIONS_MOBILE_MAPS'), color: '#41c789' },
        { label: 'Maps · Desktop', value: g('BUSINESS_IMPRESSIONS_DESKTOP_MAPS'), color: '#e0a53d' },
      ],
      viewsSeries: dailySeries,
      viewsLabels: dailySeries.map((_, i) => shortLabel(isoDaysAgo(dailySeries.length - i + 1))),
      searchTypes: null, // deprecated in the new API
      actions: { total: calls + directions + website + messages + bookings, calls, directions, website, messages, bookings },
      actionsBreakdown: [
        { label: 'Website clicks', value: website, color: '#5b8def' },
        { label: 'Direction requests', value: directions, color: '#41c789' },
        { label: 'Calls', value: calls, color: '#e0a53d' },
        { label: 'Messages', value: messages, color: '#8a6bf0' },
        { label: 'Bookings', value: bookings, color: '#e0607a' },
      ],
      reviews,
      photos: null,
    };

    return { available: true, gbp, overview: { gbpReach: gbp.reach.total } };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

// =====================================================================
// CrUX — real-user Core Web Vitals (Chrome UX Report API, key only)
// =====================================================================
export async function fetchCrux(url, apiKey = process.env.GOOGLE_PSI_KEY) {
  if (!apiKey) return { available: false, error: 'No API key for CrUX' };
  try {
    const query = async (formFactor) => {
      const res = await fetch(
        `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, formFactor }),
        }
      );
      if (!res.ok) throw new Error(`CrUX HTTP ${res.status}`);
      return res.json();
    };
    const rec = (await query('PHONE')).record || (await query()).record;
    if (!rec) return { available: false, error: 'No CrUX field data for this URL' };
    const M = rec.metrics || {};

    const p75 = (k) => M[k]?.percentiles?.p75;
    const rateOf = (k, good, poor) => {
      const v = +p75(k);
      if (isNaN(v)) return 'no-data';
      return v <= good ? 'good' : v <= poor ? 'needs-improvement' : 'poor';
    };
    const lcpMs = +p75('largest_contentful_paint');
    const inpMs = +p75('interaction_to_next_paint');
    const clsVal = +p75('cumulative_layout_shift');
    const fcpMs = +p75('first_contentful_paint');
    const ttfbMs = +p75('experimental_time_to_first_byte');

    // Core Web Vitals assessment pass rate = avg of "good" fractions for LCP/INP/CLS.
    const goodFrac = (k) => {
      const bins = M[k]?.histogram || [];
      return bins.length ? +(bins[0].density || 0) : null;
    };
    const passParts = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift']
      .map(goodFrac).filter((x) => x != null);
    const passRate = passParts.length ? pct1((passParts.reduce((a, b) => a + b, 0) / passParts.length) * 100) : null;

    const crux = {
      hasData: true,
      collectionPeriod: 'Last 28 days · CrUX',
      metrics: {
        lcp: { label: 'LCP', value: isNaN(lcpMs) ? '—' : (lcpMs / 1000).toFixed(2) + ' s', ms: lcpMs, rating: rateOf('largest_contentful_paint', 2500, 4000), good: 2500, poor: 4000 },
        inp: { label: 'INP', value: isNaN(inpMs) ? '—' : inpMs + ' ms', ms: inpMs, rating: rateOf('interaction_to_next_paint', 200, 500), good: 200, poor: 500 },
        cls: { label: 'CLS', value: isNaN(clsVal) ? '—' : clsVal.toFixed(2), rating: rateOf('cumulative_layout_shift', 0.1, 0.25), good: 0.1, poor: 0.25 },
        fcp: { label: 'FCP', value: isNaN(fcpMs) ? '—' : (fcpMs / 1000).toFixed(2) + ' s', rating: rateOf('first_contentful_paint', 1800, 3000) },
        ttfb: { label: 'TTFB', value: isNaN(ttfbMs) ? '—' : (ttfbMs / 1000).toFixed(2) + ' s', rating: rateOf('experimental_time_to_first_byte', 800, 1800) },
      },
      passRate,
      lcpHistory: [], lcpLabels: [], inpHistory: [],
      formFactorSplit: null,
    };
    return { available: true, crux };
  } catch (e) {
    return { available: false, error: e.message };
  }
}
