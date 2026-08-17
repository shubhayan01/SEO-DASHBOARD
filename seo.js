// seo.js — real-time SEO audit engine using free data sources.
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Persistent Chrome profile dir we own, so chrome-launcher never tries to
// auto-create/delete an OS temp profile (avoids Windows EPERM on cleanup).
const CHROME_PROFILE = path.join(__dirname, 'data', '.chrome-profile');

const UA =
  'Mozilla/5.0 (compatible; WhiteLabelSEOBot/1.0; +https://localhost) SEO-Dashboard';

/** Fetch with a timeout so a slow site can't hang the request. */
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) throw new Error('No URL provided');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const parsed = new URL(u); // throws if invalid
  return parsed.toString();
}

/** Download the page and capture transport-level facts. */
async function fetchPage(url) {
  const start = Date.now();
  const res = await fetchWithTimeout(
    url,
    { redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html' } },
    20000
  );
  const responseTimeMs = Date.now() - start;
  const html = await res.text();
  const headers = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return {
    status: res.status,
    ok: res.ok,
    finalUrl: res.url || url,
    redirected: res.redirected,
    responseTimeMs,
    html,
    headers,
    https: (res.url || url).startsWith('https://'),
    sizeBytes: Buffer.byteLength(html, 'utf8'),
  };
}

/** Parse on-page SEO signals out of the HTML. */
function analyzeHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const host = new URL(baseUrl).hostname;

  const title = ($('title').first().text() || '').trim();
  const metaDesc = ($('meta[name="description"]').attr('content') || '').trim();
  const canonical = ($('link[rel="canonical"]').attr('href') || '').trim();
  const viewport = ($('meta[name="viewport"]').attr('content') || '').trim();
  const charset =
    $('meta[charset]').attr('charset') ||
    ($('meta[http-equiv="Content-Type"]').attr('content') || '');
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').trim();
  const lang = ($('html').attr('lang') || '').trim();
  const favicon = $('link[rel~="icon"]').attr('href') || '';

  const h1 = $('h1').map((_, e) => $(e).text().trim()).get().filter(Boolean);
  const h2 = $('h2').map((_, e) => $(e).text().trim()).get().filter(Boolean);
  const h3 = $('h3').length;

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').length : 0;

  const imgs = $('img');
  const imgTotal = imgs.length;
  let imgNoAlt = 0;
  imgs.each((_, e) => {
    const alt = $(e).attr('alt');
    if (alt === undefined || alt.trim() === '') imgNoAlt++;
  });

  let internal = 0;
  let external = 0;
  const anchors = $('a[href]');
  anchors.each((_, e) => {
    const href = $(e).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:'))
      return;
    try {
      const abs = new URL(href, origin);
      if (abs.hostname === host) internal++;
      else external++;
    } catch {
      /* ignore malformed */
    }
  });

  // Social + structured data
  const og = {};
  $('meta[property^="og:"]').each((_, e) => {
    og[$(e).attr('property')] = $(e).attr('content');
  });
  const twitter = {};
  $('meta[name^="twitter:"]').each((_, e) => {
    twitter[$(e).attr('name')] = $(e).attr('content');
  });
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, e) => {
    const raw = $(e).contents().text();
    try {
      jsonLd.push(JSON.parse(raw));
    } catch {
      jsonLd.push({ _unparseable: true });
    }
  });
  const schemaTypes = [];
  const collectType = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) return obj.forEach(collectType);
    if (obj['@type']) schemaTypes.push(...[].concat(obj['@type']));
    Object.values(obj).forEach((v) => typeof v === 'object' && collectType(v));
  };
  jsonLd.forEach(collectType);

  return {
    title,
    titleLength: title.length,
    metaDesc,
    metaDescLength: metaDesc.length,
    canonical,
    viewport,
    charset: String(charset),
    robotsMeta,
    lang,
    favicon: Boolean(favicon),
    h1Count: h1.length,
    h1: h1.slice(0, 5),
    h2Count: h2.length,
    h2: h2.slice(0, 10),
    h3Count: h3,
    wordCount,
    imgTotal,
    imgNoAlt,
    linksInternal: internal,
    linksExternal: external,
    openGraph: og,
    hasOpenGraph: Object.keys(og).length > 0,
    twitterCard: twitter,
    hasTwitterCard: Object.keys(twitter).length > 0,
    schemaTypes: [...new Set(schemaTypes)],
    hasStructuredData: schemaTypes.length > 0,
  };
}

/** Check robots.txt and sitemap.xml existence. */
async function checkRobotsSitemap(origin) {
  const out = { robotsTxt: false, sitemapXml: false, sitemapUrl: null };
  try {
    const r = await fetchWithTimeout(origin + '/robots.txt', { headers: { 'User-Agent': UA } }, 8000);
    if (r.ok) {
      out.robotsTxt = true;
      const txt = await r.text();
      const m = txt.match(/Sitemap:\s*(\S+)/i);
      if (m) out.sitemapUrl = m[1];
    }
  } catch {/* ignore */}
  try {
    const sUrl = out.sitemapUrl || origin + '/sitemap.xml';
    const s = await fetchWithTimeout(sUrl, { headers: { 'User-Agent': UA }, method: 'GET' }, 8000);
    if (s.ok) {
      out.sitemapXml = true;
      out.sitemapUrl = sUrl;
    }
  } catch {/* ignore */}
  return out;
}

/** Shared extractor: turn a Lighthouse result (lhr) into our report shape. */
function extractFromLhr(lh, strategy, source) {
  const cats = lh.categories || {};
  const audits = lh.audits || {};
  const metric = (id) =>
    audits[id] ? { value: audits[id].displayValue, score: audits[id].score } : null;
  const scoreOf = (c) => (cats[c] && cats[c].score != null ? Math.round(cats[c].score * 100) : null);

  return {
    available: true,
    source, // 'pagespeed-api' | 'local-lighthouse'
    strategy,
    scores: {
      performance: scoreOf('performance'),
      seo: scoreOf('seo'),
      accessibility: scoreOf('accessibility'),
      bestPractices: scoreOf('best-practices'),
    },
    coreWebVitals: {
      lcp: metric('largest-contentful-paint'),
      fcp: metric('first-contentful-paint'),
      cls: metric('cumulative-layout-shift'),
      tbt: metric('total-blocking-time'),
      speedIndex: metric('speed-index'),
      interactive: metric('interactive'),
    },
  };
}

/** Google PageSpeed Insights API (used when a PSI key is configured). */
async function runPageSpeed(url, apiKey, strategy = 'mobile') {
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', strategy);
  ['performance', 'seo', 'accessibility', 'best-practices'].forEach((c) =>
    api.searchParams.append('category', c)
  );
  if (apiKey) api.searchParams.set('key', apiKey);

  const res = await fetchWithTimeout(api.toString(), {}, 60000);
  if (!res.ok) return { available: false, error: `PSI HTTP ${res.status}` };
  const data = await res.json();
  return extractFromLhr(data.lighthouseResult || {}, strategy, 'pagespeed-api');
}

/** Run Lighthouse locally against installed Chrome. Free, no quota, no key. */
async function runLighthouseLocal(url, strategy = 'mobile') {
  // Dynamic import so the heavy modules only load when actually used.
  const [{ default: lighthouse }, chromeLauncher] = await Promise.all([
    import('lighthouse'),
    import('chrome-launcher'),
  ]);
  let chrome;
  try {
    fs.mkdirSync(CHROME_PROFILE, { recursive: true });
    chrome = await chromeLauncher.launch({
      userDataDir: CHROME_PROFILE,
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const flags = {
      port: chrome.port,
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'],
      formFactor: strategy === 'desktop' ? 'desktop' : 'mobile',
      screenEmulation:
        strategy === 'desktop'
          ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
          : undefined,
    };
    const result = await lighthouse(url, flags);
    if (!result || !result.lhr) return { available: false, error: 'Lighthouse produced no result' };
    return extractFromLhr(result.lhr, strategy, 'local-lighthouse');
  } finally {
    if (chrome) {
      try {
        await Promise.resolve(chrome.kill());
      } catch {
        /* ignore cleanup errors */
      }
    }
  }
}

/**
 * Get performance data with the best free method available:
 *  1. PSI API if a key is configured (fast, reliable).
 *  2. Otherwise local Lighthouse via installed Chrome (free, no quota).
 *  3. Fall back to keyless PSI as a last resort.
 */
async function getPerformance(url, psiKey, strategy = 'mobile') {
  if (psiKey) {
    const psi = await runPageSpeed(url, psiKey, strategy).catch((e) => ({
      available: false,
      error: e.message,
    }));
    if (psi.available) return psi;
  }
  const local = await runLighthouseLocal(url, strategy).catch((e) => ({
    available: false,
    error: 'local-lighthouse: ' + e.message,
  }));
  if (local.available) return local;

  // last resort — shared keyless quota (often 429)
  const psi = await runPageSpeed(url, null, strategy).catch((e) => ({
    available: false,
    error: e.message,
  }));
  if (psi.available) return psi;
  return { available: false, error: local.error || psi.error || 'No performance source available' };
}

/** Rule-based scoring so the headline number is deterministic and real. */
function computeChecks(page, onpage, tech) {
  const checks = [];
  const add = (label, ok, weight, detail, severity = 'medium') =>
    checks.push({ label, ok, weight, detail, severity });

  add('HTTPS enabled', page.https, 8, page.https ? 'Served over HTTPS' : 'Not secure', 'high');
  add('Page responds 200', page.status === 200, 6, `HTTP ${page.status}`, 'high');
  add(
    'Fast response',
    page.responseTimeMs < 1500,
    4,
    `${page.responseTimeMs} ms server response`,
    'medium'
  );
  add(
    'Title tag present',
    onpage.titleLength > 0,
    8,
    onpage.title || 'Missing',
    'high'
  );
  add(
    'Title length 30–60',
    onpage.titleLength >= 30 && onpage.titleLength <= 60,
    4,
    `${onpage.titleLength} chars`,
    'medium'
  );
  add(
    'Meta description present',
    onpage.metaDescLength > 0,
    7,
    onpage.metaDesc || 'Missing',
    'high'
  );
  add(
    'Meta description 70–160',
    onpage.metaDescLength >= 70 && onpage.metaDescLength <= 160,
    3,
    `${onpage.metaDescLength} chars`,
    'medium'
  );
  add('Exactly one H1', onpage.h1Count === 1, 5, `${onpage.h1Count} H1 tags`, 'high');
  add('Uses H2 subheadings', onpage.h2Count > 0, 3, `${onpage.h2Count} H2 tags`, 'low');
  add(
    'Sufficient content',
    onpage.wordCount >= 300,
    4,
    `${onpage.wordCount} words`,
    'medium'
  );
  add(
    'Images have alt text',
    onpage.imgTotal === 0 || onpage.imgNoAlt === 0,
    4,
    `${onpage.imgNoAlt}/${onpage.imgTotal} missing alt`,
    'medium'
  );
  add('Canonical tag', Boolean(onpage.canonical), 3, onpage.canonical || 'Missing', 'medium');
  add('Mobile viewport', Boolean(onpage.viewport), 5, onpage.viewport || 'Missing', 'high');
  add('Lang attribute', Boolean(onpage.lang), 2, onpage.lang || 'Missing', 'low');
  add('Open Graph tags', onpage.hasOpenGraph, 3, onpage.hasOpenGraph ? 'Present' : 'Missing', 'low');
  add(
    'Structured data',
    onpage.hasStructuredData,
    4,
    onpage.schemaTypes.join(', ') || 'None',
    'medium'
  );
  add('robots.txt', tech.robotsTxt, 3, tech.robotsTxt ? 'Found' : 'Missing', 'medium');
  add('XML sitemap', tech.sitemapXml, 4, tech.sitemapXml ? 'Found' : 'Missing', 'medium');
  add(
    'Not blocked by robots meta',
    !/noindex/i.test(onpage.robotsMeta),
    6,
    onpage.robotsMeta || 'index,follow (default)',
    'high'
  );

  const totalW = checks.reduce((s, c) => s + c.weight, 0);
  const gotW = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
  const score = Math.round((gotW / totalW) * 100);
  return { checks, score };
}

/** Ask Groq to interpret the collected (real) data. Never invents metrics. */
async function groqAnalyze({ apiKey, model, url, onpage, checks, psi, score }) {
  if (!apiKey) return { available: false, summary: 'Groq API key not configured.' };
  const failing = checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`);
  const payload = {
    url,
    seoScore: score,
    title: onpage.title,
    metaDescription: onpage.metaDesc,
    wordCount: onpage.wordCount,
    h1Count: onpage.h1Count,
    imagesMissingAlt: `${onpage.imgNoAlt}/${onpage.imgTotal}`,
    structuredData: onpage.schemaTypes,
    pageSpeed: psi.available ? psi.scores : 'unavailable',
    coreWebVitals: psi.available ? psi.coreWebVitals : 'unavailable',
    failingChecks: failing,
  };

  const body = {
    model: model || 'llama-3.3-70b-versatile',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are a senior technical SEO consultant. Analyze ONLY the audit data provided. ' +
          'Do NOT invent metrics you were not given (no backlinks, domain authority, traffic, or rankings). ' +
          'Return strict JSON: {"summary": string (2-3 sentences), ' +
          '"priorityActions": [{"title": string, "impact": "high"|"medium"|"low", "why": string}], ' +
          '"quickWins": [string]}. Base everything on the data.',
      },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  };

  try {
    const res = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      30000
    );
    if (!res.ok) {
      const t = await res.text();
      return { available: false, summary: `Groq HTTP ${res.status}`, detail: t.slice(0, 200) };
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return { available: true, ...parsed };
  } catch (e) {
    return { available: false, summary: 'Groq analysis failed: ' + e.message };
  }
}

/** Orchestrates a full audit. */
export async function auditSite(rawUrl, { groqApiKey, groqModel, psiKey } = {}) {
  const url = normalizeUrl(rawUrl);
  const page = await fetchPage(url);
  const origin = new URL(page.finalUrl).origin;
  const onpage = analyzeHtml(page.html, page.finalUrl);

  // Run independent slow tasks in parallel.
  const [tech, psi] = await Promise.all([
    checkRobotsSitemap(origin),
    getPerformance(url, psiKey).catch((e) => ({ available: false, error: e.message })),
  ]);

  const { checks, score } = computeChecks(page, onpage, tech);
  const ai = await groqAnalyze({
    apiKey: groqApiKey,
    model: groqModel,
    url: page.finalUrl,
    onpage,
    checks,
    psi,
    score,
  });

  return {
    url: page.finalUrl,
    requestedUrl: url,
    fetchedAt: new Date().toISOString(),
    score,
    transport: {
      status: page.status,
      https: page.https,
      redirected: page.redirected,
      responseTimeMs: page.responseTimeMs,
      sizeKb: Math.round(page.sizeBytes / 1024),
      server: page.headers['server'] || null,
    },
    onpage,
    tech,
    pageSpeed: psi,
    checks,
    ai,
    unavailable: {
      note:
        'Backlinks, domain authority, keyword rankings and organic traffic require paid APIs ' +
        '(Ahrefs / SEMrush / Moz) and are intentionally not estimated to keep this report accurate.',
    },
  };
}
