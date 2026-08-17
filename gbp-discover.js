// gbp-discover.js — probe Business Profile access and, if available, list
// every account+location the service account can see, then match locations to
// clients in data/clients.json (by website host, then by name) and write the
// resolved "locations/NNN" IDs into each client's google.gbpLocationId.
//
// Run:  node gbp-discover.js          (dry run — prints matches, writes nothing)
//       node gbp-discover.js --write  (persist gbpLocationId + gbpAccountId)
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENTS_FILE = path.join(__dirname, 'data', 'clients.json');
const WRITE = process.argv.includes('--write');
const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

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
  const claims = { iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  if (process.env.GOOGLE_IMPERSONATE_SUBJECT) claims.sub = process.env.GOOGLE_IMPERSONATE_SUBJECT;
  const assertion = jwt.sign(claims, creds.private_key, { algorithm: 'RS256' });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`token HTTP ${res.status}: ${txt.slice(0, 300)}`);
  return JSON.parse(txt).access_token;
}

async function api(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).hostname}: ${txt.slice(0, 400)}`);
  return JSON.parse(txt);
}

const host = (u) => { try { return new URL(u).host.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

(async () => {
  const token = await getToken();
  console.log('✓ Got access token for business.manage scope\n');

  // 1) list accounts
  let accounts = [];
  try {
    let pageToken = '';
    do {
      const u = `https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const j = await api(u, token);
      accounts.push(...(j.accounts || []));
      pageToken = j.nextPageToken || '';
    } while (pageToken);
  } catch (e) {
    console.error('✗ Could not list Business Profile accounts:\n  ' + e.message);
    console.error('\nThis almost always means one of:');
    console.error('  • The Business Profile APIs are not enabled on project spatial-tempo-505110-n4');
    console.error('  • The service account has not been added as a manager of the business, OR');
    console.error('  • GBP needs domain-wide delegation — set GOOGLE_IMPERSONATE_SUBJECT to the');
    console.error('    Workspace user that manages the locations (service accounts alone often cannot');
    console.error('    read GBP; they must impersonate a human manager).');
    process.exit(1);
  }
  console.log(`Accounts visible: ${accounts.length}`);
  accounts.forEach((a) => console.log(`  - ${a.name}  ${a.accountName || ''} (${a.type || '?'})`));
  if (!accounts.length) { console.log('No accounts — nothing to match.'); process.exit(0); }

  // 2) list locations under each account
  const readMask = 'name,title,websiteUri,storefrontAddress,metadata';
  const locations = [];
  for (const acc of accounts) {
    let pageToken = '';
    do {
      const u = `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations?pageSize=100&readMask=${encodeURIComponent(readMask)}${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const j = await api(u, token);
      for (const loc of j.locations || []) locations.push({ account: acc.name, ...loc });
      pageToken = j.nextPageToken || '';
    } while (pageToken);
  }
  console.log(`\nLocations visible: ${locations.length}`);

  // 3) match to clients
  const clients = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
  let matched = 0;
  const report = [];
  for (const c of clients) {
    const chost = host(c.url);
    const cname = norm(c.name);
    let hit = locations.find((l) => host(l.websiteUri) && host(l.websiteUri) === chost);
    if (!hit) hit = locations.find((l) => norm(l.title) === cname);
    if (!hit) hit = locations.find((l) => cname && norm(l.title).includes(cname));
    if (hit) {
      matched++;
      const locId = hit.name; // "locations/NNN"
      report.push({ client: c.name, matchedTitle: hit.title, locationId: locId });
      if (WRITE) {
        c.google = c.google || {};
        c.google.gbpLocationId = locId;
        c.google.gbpAccountId = hit.account;
      }
    } else {
      report.push({ client: c.name, matchedTitle: '— no match —', locationId: '' });
    }
  }

  console.table(report);
  console.log(`\nMatched ${matched}/${clients.length} clients.`);
  if (WRITE) {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
    console.log('✓ Wrote gbpLocationId + gbpAccountId into data/clients.json');
  } else {
    console.log('(dry run — re-run with --write to persist)');
  }
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
