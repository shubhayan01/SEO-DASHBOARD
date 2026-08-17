// gsc-ga4-discover.js — discover which Search Console sites and GA4 properties
// the service account can actually see, match them to clients in
// data/clients.json (by website host, then by name), and optionally write the
// resolved gscSiteUrl / ga4PropertyId into each client.
//
// Run:  node gsc-ga4-discover.js          (dry run — prints matches, writes nothing)
//       node gsc-ga4-discover.js --write   (persist gscSiteUrl + ga4PropertyId)
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS_FILE = path.join(__dirname, 'data', 'clients.json');
const WRITE = process.argv.includes('--write');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

function loadCreds() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const f = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (f && fs.existsSync(path.resolve(__dirname, f))) return JSON.parse(fs.readFileSync(path.resolve(__dirname, f), 'utf8'));
  throw new Error('No service account configured');
}
async function getToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  const creds = loadCreds();
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: creds.client_email, scope: SCOPES.join(' '), aud: TOKEN_URL, iat: now, exp: now + 3600 };
  if (process.env.GOOGLE_IMPERSONATE_SUBJECT) claims.sub = process.env.GOOGLE_IMPERSONATE_SUBJECT;
  const assertion = jwt.sign(claims, creds.private_key, { algorithm: 'RS256' });
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`token HTTP ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt).access_token;
}
async function api(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await res.text();
  if (!res.ok) { const e = new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`); e.status = res.status; throw e; }
  return JSON.parse(txt);
}

const host = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// Host implied by a GSC siteUrl, whether "sc-domain:example.com" or "https://example.com/".
const gscHost = (siteUrl) => siteUrl.startsWith('sc-domain:') ? siteUrl.slice('sc-domain:'.length).replace(/^www\./, '').toLowerCase() : host(siteUrl);

(async () => {
  const token = await getToken();
  console.log('✓ Got access token (webmasters.readonly + analytics.readonly)\n');
  const clients = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));

  // ---------- Search Console: list sites ----------
  let gscSites = [];
  try {
    const j = await api('https://www.googleapis.com/webmasters/v3/sites', token);
    gscSites = (j.siteEntry || []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
    console.log(`Search Console sites the service account can see: ${gscSites.length}`);
    gscSites.forEach((s) => console.log(`  - ${s.siteUrl}  [${s.permissionLevel}]`));
  } catch (e) {
    console.log(`✗ Search Console list failed (${e.status || '?'}): ${e.message.split('\n')[0]}`);
    console.log('  → Enable "Search Console API" on the project AND add the service account');
    console.log('    email as a user on each property in Search Console.');
  }

  // ---------- GA4: list account summaries (accounts + properties) ----------
  let ga4Props = [];
  try {
    let pageToken = '';
    do {
      const u = `https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const j = await api(u, token);
      for (const acc of j.accountSummaries || [])
        for (const p of acc.propertySummaries || [])
          ga4Props.push({ property: p.property, id: p.property.split('/')[1], name: p.displayName, account: acc.displayName });
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    console.log(`\nGA4 properties the service account can see: ${ga4Props.length}`);
    ga4Props.forEach((p) => console.log(`  - ${p.id}  "${p.name}"  (account: ${p.account})`));
  } catch (e) {
    console.log(`\n✗ GA4 list failed (${e.status || '?'}): ${e.message.split('\n')[0]}`);
    console.log('  → Enable "Google Analytics Admin API" on the project AND add the service');
    console.log('    account email as a Viewer on each GA4 property.');
  }

  // ---------- match to clients ----------
  console.log('\n================  MATCHING  ================');
  let mGsc = 0, mGa4 = 0;
  const report = [];
  for (const c of clients) {
    const chost = host(c.url), cname = norm(c.name);
    const gsc = gscSites.find((s) => gscHost(s.siteUrl) === chost);
    let ga = ga4Props.find((p) => host(p.name) && host(p.name) === chost);
    if (!ga) ga = ga4Props.find((p) => norm(p.name) === cname);
    if (!ga) ga = ga4Props.find((p) => cname && (norm(p.name).includes(cname) || cname.includes(norm(p.name))));
    if (gsc) { mGsc++; if (WRITE) { c.google = c.google || {}; c.google.gscSiteUrl = gsc.siteUrl; } }
    if (ga)  { mGa4++; if (WRITE) { c.google = c.google || {}; c.google.ga4PropertyId = ga.id; } }
    report.push({ client: c.name, gsc: gsc ? gsc.siteUrl : '—', ga4: ga ? `${ga.id} (${ga.name})` : '—' });
  }
  console.table(report);
  console.log(`Matched GSC: ${mGsc}/${clients.length}   |   GA4: ${mGa4}/${clients.length}`);

  if (WRITE) {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
    console.log('✓ Wrote gscSiteUrl / ga4PropertyId into data/clients.json');
  } else {
    console.log('(dry run — re-run with --write to persist)');
  }
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
