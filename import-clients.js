// import-clients.js — one-off importer.
// Reads "eMod Projects - Sheet1.csv", loads all clients into data/clients.json,
// and creates one client-scoped login per client in data/users.json.
// Writes the plaintext credentials to data/client-logins.csv so the agency
// owner can distribute them (this file is the ONLY place the passwords appear).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_FILE = path.join(__dirname, 'eMod Projects - Sheet1.csv');
const DATA_DIR = path.join(__dirname, 'data');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CREDS_FILE = path.join(DATA_DIR, 'client-logins.csv');

const LOGIN_DOMAIN = 'emod.clients'; // used only as the login handle, not a real mailbox

// ---- tiny CSV parser (handles simple quoted fields) ----
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const slugify = (s) =>
  s.toLowerCase().trim()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeUrl = (u) => {
  let clean = String(u || '').trim();
  if (!clean) return '';
  if (!/^https?:\/\//i.test(clean)) clean = 'https://' + clean;
  try { new URL(clean); return clean; } catch { return ''; }
};

// Extract the numeric cid from a Google Maps ?cid=... URL, if present.
const gbpCid = (u) => {
  const m = String(u || '').match(/[?&]cid=(\d+)/);
  return m ? m[1] : '';
};

// Readable-but-strong password: 3 words-ish blocks + digits, no ambiguous chars.
function genPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz';
  const num = '23456789';
  const pick = (set, n) => Array.from({ length: n }, () =>
    set[crypto.randomInt(set.length)]).join('');
  return `${pick(abc, 4)}-${pick(abc, 4)}-${pick(num, 4)}`;
}

// ---- read + parse the CSV ----
const rows = parseCsv(fs.readFileSync(CSV_FILE, 'utf8'));
const header = rows.shift(); // Project Name, Website, GBP URLs
console.log('CSV header:', header.join(' | '));

const now = new Date().toISOString();
const clients = [];
const usedSlugs = new Set();

for (const [name, website, gbpUrl] of rows) {
  const url = normalizeUrl(website);
  let slug = slugify(name);
  while (usedSlugs.has(slug)) slug += '-x';
  usedSlugs.add(slug);

  clients.push({
    id: crypto.randomUUID(),
    slug,
    name: name.trim(),
    url,
    createdAt: now,
    lastScore: null,
    lastAuditedAt: null,
    connectors: {},
    google: {
      gscSiteUrl: '',
      ga4PropertyId: '',
      gbpLocationId: '',
      gbpAccountId: '',
      gbpMapUrl: (gbpUrl || '').trim(), // reference only; cid is not a live location id
      gbpCid: gbpCid(gbpUrl),
    },
  });
}

// ---- build users.json: keep existing admin(s), replace old client logins ----
let users = [];
if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const admins = users.filter((u) => (u.role || 'admin') === 'admin');

const creds = [];
const clientUsers = clients.map((c) => {
  const email = `${c.slug}@${LOGIN_DOMAIN}`;
  const password = genPassword();
  creds.push({ client: c.name, url: c.url, email, password });
  return {
    id: crypto.randomUUID(),
    email,
    role: 'client',
    clientId: c.id,
    passwordHash: bcrypt.hashSync(password, 10),
  };
});

users = [...admins, ...clientUsers];

// ---- write everything ----
fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2));
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

const csvOut = [
  'Client,Website,Login (email),Password',
  ...creds.map((c) => `"${c.client}","${c.url}","${c.email}","${c.password}"`),
].join('\n');
fs.writeFileSync(CREDS_FILE, csvOut);

console.log(`\nImported ${clients.length} clients -> data/clients.json`);
console.log(`Created ${clientUsers.length} client logins (+${admins.length} admin) -> data/users.json`);
console.log(`Credentials written -> data/client-logins.csv\n`);
console.table(creds.map((c) => ({ Client: c.client, Login: c.email, Password: c.password })));
