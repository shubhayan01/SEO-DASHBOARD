// check-google.js — Google connection "doctor" for the Justwords dashboard.
//
// Run this after each setup step to see exactly what's working and what isn't.
// It never changes anything — it only reads your .env and calls Google to test.
//
//   node check-google.js                 → overall status + the email to share properties with
//   node check-google.js gbp-list        → list your Business Profile accounts + LOCATION IDs
//   node check-google.js gsc  <siteUrl>  → test Search Console access to one property
//   node check-google.js ga4  <propId>   → test GA4 access to one property
//   node check-google.js gbp  <locId>    → test Business Profile access to one location
//   node check-google.js crux <url>      → test Core Web Vitals (CrUX) for a URL
//
// Examples:
//   node check-google.js gsc  sc-domain:acme.com
//   node check-google.js ga4  412345678
//   node check-google.js gbp  locations/1234567890
//   node check-google.js crux https://acme.com

import 'dotenv/config';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { fetchSearchConsole, fetchGA4, fetchGBP, fetchCrux } from './google.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const ok = (s) => console.log(`  ${c.green('✓')} ${s}`);
const bad = (s) => console.log(`  ${c.red('✗')} ${s}`);
const info = (s) => console.log(`  ${c.dim('·')} ${c.dim(s)}`);

// ---- load the same service-account creds the dashboard uses ----
function loadCreds() {
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const f = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.log(bad(`Could not parse service-account credentials: ${e.message}`));
  }
  return null;
}

async function getToken(scopeList) {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  const creds = loadCreds();
  if (!creds) throw new Error('No Google credentials configured');
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: creds.client_email, scope: scopeList.join(' '), aud: TOKEN_URL, iat: now, exp: now + 3600 };
  if (process.env.GOOGLE_IMPERSONATE_SUBJECT) claims.sub = process.env.GOOGLE_IMPERSONATE_SUBJECT;
  const assertion = jwt.sign(claims, creds.private_key, { algorithm: 'RS256' });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).access_token;
}

// =====================================================================
// Default: overall status
// =====================================================================
async function overview() {
  console.log(c.bold('\n  Google connection check\n  ────────────────────────'));

  // 1) PageSpeed / CrUX key
  if (process.env.GOOGLE_PSI_KEY) ok('GOOGLE_PSI_KEY is set (PageSpeed + Core Web Vitals)');
  else bad('GOOGLE_PSI_KEY is empty — Core Web Vitals will stay on sample data');

  // 2) Service account
  const creds = loadCreds();
  if (process.env.GOOGLE_ACCESS_TOKEN) {
    ok('Using GOOGLE_ACCESS_TOKEN (short-lived — fine for local testing)');
  } else if (creds) {
    ok('Service-account credentials loaded');
    console.log(`\n  ${c.bold('Share your client properties with THIS email:')}`);
    console.log(`  ${c.yellow(creds.client_email)}\n`);
    info(`project: ${creds.project_id || '(unknown)'}`);
    // Prove the key actually works by minting a token.
    try {
      await getToken(['https://www.googleapis.com/auth/webmasters.readonly']);
      ok('Service account can authenticate with Google (token minted)');
    } catch (e) {
      bad(`Service account failed to authenticate: ${e.message}`);
      info('Check that the private_key is intact and the clock is correct.');
    }
  } else {
    bad('No service account found.');
    info('Set GOOGLE_SERVICE_ACCOUNT_FILE=./service-account.json (or _JSON) in .env');
  }

  console.log(c.bold('\n  Next steps'));
  console.log(`  ${c.dim('1.')} Share each property with the email above (GSC user / GA4 Viewer / GBP manager)`);
  console.log(`  ${c.dim('2.')} Find location IDs:  ${c.bold('node check-google.js gbp-list')}`);
  console.log(`  ${c.dim('3.')} Test one property:  ${c.bold('node check-google.js gsc sc-domain:yourclient.com')}\n`);
}

// =====================================================================
// gbp-list — enumerate Business Profile accounts + location IDs
// Needs: My Business Account Management API + Business Information API enabled.
// =====================================================================
async function gbpList() {
  console.log(c.bold('\n  Business Profile — accounts & location IDs\n  ──────────────────────────────────────────'));
  let token;
  try {
    token = await getToken(['https://www.googleapis.com/auth/business.manage']);
  } catch (e) {
    return bad(`Auth failed: ${e.message}`);
  }
  const get = async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 250)}`);
    return r.json();
  };
  let accounts;
  try {
    accounts = (await get('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')).accounts || [];
  } catch (e) {
    bad(`Could not list accounts: ${e.message}`);
    info('Enable "My Business Account Management API" in Google Cloud, and make sure the');
    info('service account is a manager on the Business Profile (or use GOOGLE_IMPERSONATE_SUBJECT).');
    return;
  }
  if (!accounts.length) return bad('No Business Profile accounts visible to this service account.');

  for (const acc of accounts) {
    console.log(`\n  ${c.bold('Account:')} ${acc.accountName || acc.name}  ${c.dim('(' + acc.name + ')')}`);
    try {
      const url =
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations` +
        `?readMask=name,title,storefrontAddress&pageSize=100`;
      const locs = (await get(url)).locations || [];
      if (!locs.length) { info('  (no locations)'); continue; }
      for (const l of locs) {
        const addr = l.storefrontAddress?.locality || l.storefrontAddress?.addressLines?.[0] || '';
        console.log(`    ${c.green(l.name)}  ${c.bold(l.title || '')} ${c.dim(addr)}`);
      }
    } catch (e) {
      info(`  could not list locations: ${e.message}`);
    }
  }
  console.log(`\n  ${c.dim('Paste the "locations/…" value into a client\'s Connect Google → GBP field.')}`);
  console.log(`  ${c.dim('Use the account name above (accounts/…) as the optional account ID for reviews.')}\n`);
}

// =====================================================================
// per-property live tests — reuse the dashboard's own fetchers
// =====================================================================
async function testGsc(siteUrl) {
  console.log(`\n  Testing Search Console: ${c.bold(siteUrl)}`);
  const r = await fetchSearchConsole(siteUrl);
  if (r.available) {
    ok(`Live. ${r.searchConsole.clicks} clicks / ${r.searchConsole.impressions} impressions (last 30d)`);
    info(`top query: ${r.topQueries[0]?.query ?? '(none yet)'}`);
  } else {
    bad(r.error);
    hintFromError(r.error, 'gsc');
  }
}
async function testGa4(propId) {
  console.log(`\n  Testing GA4 property: ${c.bold(propId)}`);
  const r = await fetchGA4(propId);
  if (r.available) ok(`Live. ${r.ga4.sessions} sessions / ${r.ga4.users} users (last 30d)`);
  else { bad(r.error); hintFromError(r.error, 'ga4'); }
}
async function testGbp(locId) {
  console.log(`\n  Testing Business Profile: ${c.bold(locId)}`);
  const r = await fetchGBP(locId);
  if (r.available) ok(`Live. reach ${r.gbp.reach.total} · ${r.gbp.actions.total} customer actions (last 90d)`);
  else { bad(r.error); hintFromError(r.error, 'gbp'); }
}
async function testCrux(url) {
  console.log(`\n  Testing Core Web Vitals (CrUX): ${c.bold(url)}`);
  const r = await fetchCrux(url);
  if (r.available) ok(`Live. LCP ${r.crux.metrics.lcp.value} · INP ${r.crux.metrics.inp.value} · CLS ${r.crux.metrics.cls.value}`);
  else { bad(r.error); if (/No API key/.test(r.error)) info('Set GOOGLE_PSI_KEY in .env.'); }
}

function hintFromError(err = '', kind) {
  if (/403/.test(err)) {
    const who = { gsc: 'add the service-account email as a user in Search Console',
                  ga4: 'add the service-account email as a Viewer in GA4 Property Access',
                  gbp: 'add the service-account email as a manager of the Business Profile' }[kind];
    info(`403 = not shared yet → ${who}.`);
  } else if (/404/.test(err)) {
    info('404 = wrong ID/URL. Double-check the exact value (format matters).');
  } else if (/has not been used|disabled|SERVICE_DISABLED/.test(err)) {
    info('The API isn\'t enabled for this Cloud project — enable it in APIs & Services → Library.');
  }
}

// ---- dispatch ----
const [cmd, arg] = process.argv.slice(2);
try {
  if (!cmd) await overview();
  else if (cmd === 'gbp-list') await gbpList();
  else if (cmd === 'gsc' && arg) await testGsc(arg);
  else if (cmd === 'ga4' && arg) await testGa4(arg);
  else if (cmd === 'gbp' && arg) await testGbp(arg);
  else if (cmd === 'crux' && arg) await testCrux(arg);
  else { console.log('Usage: node check-google.js [gbp-list | gsc <url> | ga4 <id> | gbp <locId> | crux <url>]'); }
} catch (e) {
  console.log(`\n  ${c.red('Error:')} ${e.message}\n`);
}
