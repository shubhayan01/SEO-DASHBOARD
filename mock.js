// mock.js — deterministic, realistic mock analytics per client.
// Swap these generators for real API calls (Google Search Console, GA4,
// Ahrefs, SEMrush) later — the shape returned here is what the UI expects.

/** Small seeded RNG (mulberry32) so each client gets stable, distinct numbers. */
function seedFrom(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const intBetween = (r, lo, hi) => Math.floor(lo + r() * (hi - lo));
const round = (n) => Math.round(n);
const pct = (r, lo, hi) => +(lo + r() * (hi - lo)).toFixed(1);

function monthsBack(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(d.toLocaleString('en-US', { month: 'short' }));
  }
  return out;
}
function daysBack(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    out.push(d.toLocaleString('en-US', { month: 'short', day: 'numeric' }));
  }
  return out;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'example.com';
  }
}

const KEYWORD_TEMPLATES = [
  '{b} pricing', 'best {b} alternative', '{b} reviews', 'how to use {b}',
  '{b} vs competitors', 'buy {b} online', '{b} discount code', '{b} login',
  'is {b} worth it', '{b} features', 'top {b} tools', '{b} for small business',
  'cheap {b} servicses', '{b} near me', '{b} tutorial', 'free {b} trial',
];

export function generateDashboard(client, connectors = {}) {
  const domain = domainOf(client.url);
  const brand = domain.split('.')[0];
  const r = rng(seedFrom(client.id || client.url || 'seed'));

  // ---- Overview KPIs ----
  const traffic = intBetween(r, 1200, 145000);
  const keywords = intBetween(r, 180, 7800);
  const backlinks = intBetween(r, 400, 210000);
  const refDomains = intBetween(r, 60, 4200);
  const da = intBetween(r, 18, 72);
  const avgPos = pct(r, 6, 34);
  const organicValue = round(traffic * (0.4 + r() * 1.8));

  const trend = (base, months, volatility, growth) => {
    const vals = [];
    let v = base * (1 - growth);
    for (let i = 0; i < months; i++) {
      v = v * (1 + growth / months) * (1 + (r() - 0.5) * volatility);
      vals.push(Math.max(0, round(v)));
    }
    return vals;
  };

  const trafficSeries = trend(traffic, 12, 0.18, 0.35);
  const prevTraffic = trafficSeries[trafficSeries.length - 2] || traffic;
  const lastTraffic = trafficSeries[trafficSeries.length - 1] || traffic;

  const overview = {
    organicTraffic: { value: lastTraffic, changePct: changePct(prevTraffic, lastTraffic), unit: 'visits/mo' },
    keywords: { value: keywords, changePct: pct(r, -6, 22), unit: 'ranking' },
    backlinks: { value: backlinks, changePct: pct(r, -4, 28), unit: 'total' },
    referringDomains: { value: refDomains, changePct: pct(r, -3, 18), unit: 'domains' },
    domainAuthority: { value: da, changePct: pct(r, -2, 9), unit: 'DA' },
    avgPosition: { value: avgPos, changePct: pct(r, -18, 6), unit: 'avg', invert: true },
    organicValue: { value: organicValue, changePct: pct(r, -5, 30), unit: 'USD/mo', prefix: '$' },
  };

  // ---- Traffic trend (by channel), 12 months ----
  const labels12 = monthsBack(12);
  const trafficTrend = labels12.map((m, i) => {
    const organic = trafficSeries[i];
    return {
      month: m,
      organic,
      direct: round(organic * (0.25 + r() * 0.15)),
      referral: round(organic * (0.08 + r() * 0.1)),
      social: round(organic * (0.05 + r() * 0.08)),
    };
  });

  // ---- Keyword rankings table ----
  const usedKw = new Set();
  const keywordRankings = [];
  for (let i = 0; i < 12; i++) {
    let tmpl = pick(r, KEYWORD_TEMPLATES);
    let kw = tmpl.replace('{b}', brand);
    while (usedKw.has(kw)) kw = pick(r, KEYWORD_TEMPLATES).replace('{b}', brand) + ' ' + i;
    usedKw.add(kw);
    const position = intBetween(r, 1, 60);
    const prev = Math.max(1, position + intBetween(r, -8, 8));
    keywordRankings.push({
      keyword: kw,
      position,
      prevPosition: prev,
      change: prev - position, // + = improved
      volume: intBetween(r, 90, 40000),
      difficulty: intBetween(r, 5, 85),
      intent: pick(r, ['Informational', 'Commercial', 'Transactional', 'Navigational']),
      url: '/' + kw.replace(/\s+/g, '-').replace(/[^a-z0-9-]/gi, '').toLowerCase(),
    });
  }

  // ---- Keyword position distribution ----
  const keywordDistribution = {
    top3: round(keywords * (0.04 + r() * 0.05)),
    p4_10: round(keywords * (0.09 + r() * 0.06)),
    p11_20: round(keywords * (0.14 + r() * 0.06)),
    p21_50: round(keywords * (0.26 + r() * 0.08)),
    p51_100: round(keywords * (0.3 + r() * 0.08)),
  };

  // ---- Search Console style (clicks / impressions), 30 days ----
  const labels30 = daysBack(30);
  const gscBaseClicks = round(lastTraffic / 30);
  const gscClicks = trend(gscBaseClicks, 30, 0.3, 0.2);
  const ctr = pct(r, 1.8, 7.5);
  const searchConsole = {
    clicks: gscClicks.reduce((a, b) => a + b, 0),
    impressions: round(gscClicks.reduce((a, b) => a + b, 0) / (ctr / 100)),
    ctr,
    avgPosition: avgPos,
    labels: labels30,
    clicksSeries: gscClicks,
    impressionsSeries: gscClicks.map((c) => round(c / (ctr / 100))),
  };

  // ---- Top pages ----
  const pagePaths = ['/', '/pricing', '/blog', '/features', '/about', '/contact', '/blog/guide', '/product'];
  const topPages = pagePaths.slice(0, 6).map((p) => ({
    path: p,
    traffic: round(lastTraffic * (0.05 + r() * 0.25)),
    keywords: intBetween(r, 5, 400),
    changePct: pct(r, -20, 40),
  })).sort((a, b) => b.traffic - a.traffic);

  // ---- Backlinks profile (Ahrefs) ----
  const dofollow = pct(r, 55, 88);
  const backlinksProfile = {
    total: backlinks,
    referringDomains: refDomains,
    dofollowPct: dofollow,
    nofollowPct: +(100 - dofollow).toFixed(1),
    newThisMonth: intBetween(r, 10, 900),
    lostThisMonth: intBetween(r, 5, 400),
    domainRating: da,
    topReferring: Array.from({ length: 6 }).map(() => {
      const dr = intBetween(r, 20, 92);
      return {
        domain: pick(r, ['forbes.com', 'medium.com', 'reddit.com', 'techcrunch.com', 'wikipedia.org',
          'g2.com', 'producthunt.com', 'quora.com', 'hubspot.com', 'wordpress.org']),
        dr,
        backlinks: intBetween(r, 1, 320),
      };
    }),
  };

  // ---- Competitors (SEMrush) ----
  const competitors = Array.from({ length: 4 }).map((_, i) => ({
    domain: `competitor${i + 1}.com`,
    domainAuthority: intBetween(r, da - 12, da + 15),
    commonKeywords: intBetween(r, 40, 2200),
    estTraffic: intBetween(r, 800, 180000),
    overlapPct: pct(r, 8, 62),
  })).sort((a, b) => b.estTraffic - a.estTraffic);

  // ---- Google Search Console: top queries (clicks/impr/ctr/position) ----
  const usedQ = new Set();
  const topQueries = [];
  for (let i = 0; i < 10; i++) {
    let q = pick(r, KEYWORD_TEMPLATES).replace('{b}', brand);
    while (usedQ.has(q)) q = pick(r, KEYWORD_TEMPLATES).replace('{b}', brand) + ' ' + i;
    usedQ.add(q);
    const impressions = intBetween(r, 200, 60000);
    const qctr = pct(r, 0.6, 12);
    topQueries.push({
      query: q,
      clicks: round(impressions * (qctr / 100)),
      impressions,
      ctr: qctr,
      position: pct(r, 1, 42),
    });
  }
  topQueries.sort((a, b) => b.clicks - a.clicks);

  // ---- Search Console: geography + device split ----
  const COUNTRIES = ['United States', 'United Kingdom', 'India', 'Germany', 'Canada', 'Australia', 'France', 'Brazil'];
  let geoRemaining = 100;
  const gscCountries = COUNTRIES.slice(0, 6).map((name, i, arr) => {
    const share = i === arr.length - 1 ? +geoRemaining.toFixed(1) : +(geoRemaining * (0.28 + r() * 0.3)).toFixed(1);
    geoRemaining = Math.max(0, geoRemaining - share);
    return { country: name, clicks: round(searchConsole.clicks * (share / 100)), share };
  });
  const dDesktop = pct(r, 38, 66);
  const dMobile = +(100 - dDesktop - 6).toFixed(1);
  const gscDevices = [
    { device: 'Mobile', share: dMobile, color: '#4f8cff' },
    { device: 'Desktop', share: dDesktop, color: '#2ecc71' },
    { device: 'Tablet', share: +(100 - dDesktop - dMobile).toFixed(1), color: '#f5b83d' },
  ];

  // ---- Google Analytics (GA4) engagement ----
  const sessions = round(lastTraffic * (1.1 + r() * 0.5));
  const users = round(sessions * (0.72 + r() * 0.15));
  const ga4 = {
    sessions,
    users,
    newUsers: round(users * (0.55 + r() * 0.25)),
    engagedSessions: round(sessions * (0.5 + r() * 0.25)),
    engagementRate: pct(r, 45, 78),
    avgEngagementSec: intBetween(r, 40, 210),
    bounceRate: pct(r, 22, 58),
    pagesPerSession: pct(r, 1.4, 4.8),
    conversions: intBetween(r, 20, 3200),
    conversionRate: pct(r, 0.8, 6.5),
    sessionsSeries: trend(round(sessions / 30), 30, 0.28, 0.22),
    topLandingPages: pagePaths.slice(0, 5).map((p) => ({
      path: p,
      sessions: round(sessions * (0.05 + r() * 0.22)),
      convRate: pct(r, 0.4, 7.2),
    })).sort((a, b) => b.sessions - a.sessions),
    channels: [
      { channel: 'Organic Search', value: pct(r, 38, 62), color: '#4f8cff' },
      { channel: 'Direct', value: pct(r, 12, 28), color: '#2ecc71' },
      { channel: 'Referral', value: pct(r, 6, 16), color: '#a56bff' },
      { channel: 'Social', value: pct(r, 4, 14), color: '#f5b83d' },
      { channel: 'Email', value: pct(r, 2, 9), color: '#ff5f5f' },
    ],
  };

  // ---- Ahrefs: anchor text + link types + DR history ----
  const anchorText = [
    { label: 'Branded', color: '#4f8cff' },
    { label: 'Exact match', color: '#2ecc71' },
    { label: 'URL', color: '#a56bff' },
    { label: 'Generic', color: '#f5b83d' },
    { label: 'Other', color: '#8b98a9' },
  ].map((a) => ({ ...a, value: intBetween(r, 40, 8000) }));

  const linkTypes = [
    { label: 'Text', color: '#4f8cff' },
    { label: 'Image', color: '#2ecc71' },
    { label: 'Nofollow', color: '#f5b83d' },
    { label: 'Redirect', color: '#a56bff' },
  ].map((a) => ({ ...a, value: intBetween(r, 20, 6000) }));

  const drHistory = trend(da, 12, 0.05, 0.12).map((v) => Math.min(100, v));

  // ---- SEMrush: SERP features + keyword movers ----
  const serpFeatures = [
    { feature: 'Featured Snippet', count: intBetween(r, 0, 60) },
    { feature: 'People Also Ask', count: intBetween(r, 5, 220) },
    { feature: 'Image Pack', count: intBetween(r, 0, 140) },
    { feature: 'Sitelinks', count: intBetween(r, 0, 90) },
    { feature: 'Reviews', count: intBetween(r, 0, 70) },
    { feature: 'Video', count: intBetween(r, 0, 110) },
  ];
  const movers = keywordRankings.slice(0, 8).map((k) => ({
    keyword: k.keyword,
    position: k.position,
    change: k.change,
    volume: k.volume,
  }));
  const keywordMovers = {
    gainers: movers.filter((m) => m.change > 0).sort((a, b) => b.change - a.change).slice(0, 5),
    losers: movers.filter((m) => m.change < 0).sort((a, b) => a.change - b.change).slice(0, 5),
  };

  // ---- Site health snapshot (mock; real via /api/audit) ----
  const siteHealth = {
    score: intBetween(r, 62, 96),
    errors: intBetween(r, 0, 24),
    warnings: intBetween(r, 3, 60),
    notices: intBetween(r, 5, 120),
    indexedPages: intBetween(r, 20, 4200),
    crawledPages: intBetween(r, 25, 4600),
  };

  // ---- Core Web Vitals — CrUX field data (real-user, 28-day) ----
  const rate = (good, ni) => {
    const rr = r();
    return rr < good ? 'good' : rr < good + ni ? 'needs-improvement' : 'poor';
  };
  const cruxHistorySeries = (base, months) =>
    trend(base, months, 0.08, -0.05).map((v) => Math.max(0, v));
  const lcpMs = intBetween(r, 1400, 4200);
  const inpMs = intBetween(r, 90, 380);
  const clsScore = pct(r, 0.01, 0.28) / 10; // 0.001–0.028 scaled → keep small
  const crux = {
    hasData: true,
    collectionPeriod: 'Last 28 days',
    metrics: {
      lcp: { label: 'LCP', value: (lcpMs / 1000).toFixed(2) + ' s', ms: lcpMs, rating: lcpMs < 2500 ? 'good' : lcpMs < 4000 ? 'needs-improvement' : 'poor', good: 2500, poor: 4000 },
      inp: { label: 'INP', value: inpMs + ' ms', ms: inpMs, rating: inpMs < 200 ? 'good' : inpMs < 500 ? 'needs-improvement' : 'poor', good: 200, poor: 500 },
      cls: { label: 'CLS', value: pct(r, 0.01, 0.25).toFixed(2), ms: null, rating: rate(0.55, 0.3), good: 0.1, poor: 0.25 },
      fcp: { label: 'FCP', value: (intBetween(r, 900, 3200) / 1000).toFixed(2) + ' s', rating: rate(0.5, 0.35) },
      ttfb: { label: 'TTFB', value: (intBetween(r, 200, 1600) / 1000).toFixed(2) + ' s', rating: rate(0.55, 0.3) },
    },
    // pass/fail split of the "Core Web Vitals assessment"
    passRate: pct(r, 42, 96),
    lcpHistory: cruxHistorySeries(lcpMs, 8).map((v) => round(v)),
    inpHistory: cruxHistorySeries(inpMs, 8).map((v) => round(v)),
    lcpLabels: monthsBack(8),
    formFactorSplit: (() => {
      const m = pct(r, 55, 82);
      return [
        { device: 'Phone', share: m, color: '#5b8def' },
        { device: 'Desktop', share: +(100 - m - 3).toFixed(1), color: '#41c789' },
        { device: 'Tablet', share: 3, color: '#e0a53d' },
      ];
    })(),
  };

  // ---- Google Business Profile (GBP) — local reach & actions ----
  const CATEGORIES = ['Marketing Agency', 'Dentist', 'Law Firm', 'Restaurant', 'Auto Repair',
    'Real Estate Agency', 'Plumber', 'Fitness Center', 'Coffee Shop', 'Accountant'];
  const gbpSearchDesktop = intBetween(r, 400, 22000);
  const gbpSearchMobile = round(gbpSearchDesktop * (1.4 + r() * 1.6));
  const gbpMapsDesktop = intBetween(r, 200, 12000);
  const gbpMapsMobile = round(gbpMapsDesktop * (1.6 + r() * 1.8));
  const gbpViewsTotal = gbpSearchDesktop + gbpSearchMobile + gbpMapsDesktop + gbpMapsMobile;
  const gbpViewsSeries = trend(round(gbpViewsTotal / 90), 90, 0.35, 0.24);
  const gbpCalls = intBetween(r, 8, 1400);
  const gbpDirections = intBetween(r, 12, 2600);
  const gbpWebsite = intBetween(r, 40, 5200);
  const gbpMessages = intBetween(r, 0, 620);
  const gbpBookings = intBetween(r, 0, 340);
  const reviewCount = intBetween(r, 6, 1800);
  const avgRating = pct(r, 3.6, 4.9);
  const REVIEW_SNIPPETS = [
    'Fantastic service from start to finish. Highly recommend to anyone in the area.',
    'Professional team, quick turnaround and great communication throughout.',
    'Good experience overall, though the wait was a little longer than expected.',
    'Absolutely the best in town. Will be coming back for sure.',
    'Helpful staff and fair pricing. Very happy with the result.',
    'Solid work, would use again. Booking was easy and hassle-free.',
  ];
  const gbp = {
    profile: {
      name: client.name,
      category: pick(r, CATEGORIES),
      verified: r() > 0.15,
      address: `${intBetween(r, 10, 990)} ${pick(r, ['Main', 'High', 'Market', 'Park', 'Oak', 'King'])} St`,
      phone: `+1 (${intBetween(r, 201, 989)}) ${intBetween(r, 200, 999)}-${String(intBetween(r, 0, 9999)).padStart(4, '0')}`,
      hours: pick(r, ['Open now · Closes 6 PM', 'Open now · Closes 9 PM', 'Closed · Opens 9 AM']),
    },
    reach: {
      total: gbpViewsTotal,
      changePct: pct(r, -8, 34),
      search: gbpSearchDesktop + gbpSearchMobile,
      maps: gbpMapsDesktop + gbpMapsMobile,
      desktop: gbpSearchDesktop + gbpMapsDesktop,
      mobile: gbpSearchMobile + gbpMapsMobile,
    },
    viewsBreakdown: [
      { label: 'Search · Mobile', value: gbpSearchMobile, color: '#5b8def' },
      { label: 'Search · Desktop', value: gbpSearchDesktop, color: '#8a6bf0' },
      { label: 'Maps · Mobile', value: gbpMapsMobile, color: '#41c789' },
      { label: 'Maps · Desktop', value: gbpMapsDesktop, color: '#e0a53d' },
    ],
    viewsSeries: gbpViewsSeries,
    viewsLabels: daysBack(90),
    searchTypes: [
      { label: 'Direct', value: pct(r, 22, 48), color: '#5b8def' },
      { label: 'Discovery', value: pct(r, 34, 62), color: '#41c789' },
      { label: 'Branded', value: pct(r, 4, 18), color: '#e0a53d' },
    ],
    actions: {
      total: gbpCalls + gbpDirections + gbpWebsite + gbpMessages + gbpBookings,
      calls: gbpCalls,
      directions: gbpDirections,
      website: gbpWebsite,
      messages: gbpMessages,
      bookings: gbpBookings,
    },
    actionsBreakdown: [
      { label: 'Website clicks', value: gbpWebsite, color: '#5b8def' },
      { label: 'Direction requests', value: gbpDirections, color: '#41c789' },
      { label: 'Calls', value: gbpCalls, color: '#e0a53d' },
      { label: 'Messages', value: gbpMessages, color: '#8a6bf0' },
      { label: 'Bookings', value: gbpBookings, color: '#e0607a' },
    ],
    reviews: {
      count: reviewCount,
      avgRating,
      newThisMonth: intBetween(r, 0, 60),
      responseRate: pct(r, 35, 100),
      distribution: [
        { stars: 5, value: round(reviewCount * (0.55 + r() * 0.25)) },
        { stars: 4, value: round(reviewCount * (0.12 + r() * 0.1)) },
        { stars: 3, value: round(reviewCount * (0.04 + r() * 0.05)) },
        { stars: 2, value: round(reviewCount * (0.02 + r() * 0.03)) },
        { stars: 1, value: round(reviewCount * (0.02 + r() * 0.05)) },
      ],
      recent: Array.from({ length: 4 }).map(() => ({
        author: pick(r, ['A. Sharma', 'J. Miller', 'S. Patel', 'M. Garcia', 'R. Chen', 'K. Brown', 'L. Rossi']),
        rating: intBetween(r, 3, 6) > 5 ? 5 : intBetween(r, 3, 6),
        text: pick(r, REVIEW_SNIPPETS),
        daysAgo: intBetween(r, 1, 40),
      })),
    },
    photos: {
      customerViews: intBetween(r, 500, 320000),
      merchantCount: intBetween(r, 5, 240),
      customerCount: intBetween(r, 0, 900),
    },
  };

  return {
    domain,
    generatedAt: new Date().toISOString(),
    mock: true,
    connectors: {
      googleSearchConsole: connectors.googleSearchConsole !== false, // default on
      googleAnalytics: connectors.googleAnalytics !== false, // default on
      googleBusinessProfile: connectors.googleBusinessProfile !== false, // default on
      pageSpeed: connectors.pageSpeed !== false, // default on (CrUX field data)
      ahrefs: Boolean(connectors.ahrefs),
      semrush: Boolean(connectors.semrush),
      brightlocal: Boolean(connectors.brightlocal),
      meta: Boolean(connectors.meta),
      moz: Boolean(connectors.moz),
      googleads: Boolean(connectors.googleads),
    },
    overview,
    trafficTrend,
    keywordRankings,
    keywordDistribution,
    searchConsole,
    topQueries,
    gscCountries,
    gscDevices,
    ga4,
    gbp,
    crux,
    topPages,
    backlinksProfile,
    anchorText,
    linkTypes,
    drHistory,
    competitors,
    serpFeatures,
    keywordMovers,
    siteHealth,
  };
}

function changePct(prev, cur) {
  if (!prev) return 0;
  return +(((cur - prev) / prev) * 100).toFixed(1);
}
