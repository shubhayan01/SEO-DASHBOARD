// server.js — Express API + static host for the white-label SEO dashboard.
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { auditSite } from './seo.js';
import { generateDashboard } from './mock.js';
import {
  googleConfigured,
  fetchSearchConsole,
  fetchGA4,
  fetchGBP,
  fetchCrux,
} from './google.js';
import { brightlocalConfigured, fetchBrightLocal } from './brightlocal.js';
import { runSync, syncReadiness } from './sync.js';
import { profileFor } from './profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR must point at persistent storage in production. On Render/Railway the
// default filesystem is wiped on every deploy, so mount a disk and set DATA_DIR
// to its mount path (e.g. /data). Falls back to ./data for local development.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
// In production a weak/default JWT secret lets anyone forge login tokens.
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || JWT_SECRET === 'dev-secret' || JWT_SECRET.length < 32)) {
  console.error('FATAL: set a strong JWT_SECRET (32+ random chars) before running in production.');
  process.exit(1);
}
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const PSI_KEY = process.env.GOOGLE_PSI_KEY || '';

// ---------- tiny JSON "database" ----------
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CLIENTS_FILE)) fs.writeFileSync(CLIENTS_FILE, '[]');
  if (!fs.existsSync(USERS_FILE)) {
    const email = (process.env.ADMIN_EMAIL || 'admin@agency.com').toLowerCase();
    const pass = process.env.ADMIN_PASSWORD || 'admin123';
    const users = [{ id: 'u1', email, role: 'admin', clientId: null, passwordHash: bcrypt.hashSync(pass, 10) }];
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    console.log(`Created default login -> ${email} / ${pass}`);
  }
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

ensureData();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- auth ----------
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
// Agency-owner-only routes (add/delete clients, edit connections, manage logins).
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}
// Every client and account belongs to an "owner" tenant (defaults to 'agency'
// for records created before tenants existed). An admin only ever sees and
// manages clients in its OWN owner, so two admin profiles (e.g. the agency and
// Justwords) run the same software over completely separate client rosters.
const ownerOf = (x) => (x && x.owner) || 'agency';

// Owners whose "Sync" synthesizes realistic live-style data for sites that have
// no Google service-account grant (their own request), instead of leaving them
// on sample data. See sync.js Phase C.
const SYNTHETIC_OWNERS = new Set(['justwords']);
const ownerIsSynthetic = (owner) => SYNTHETIC_OWNERS.has(owner);
// A client marked synthetic by a prior sync reseeds its whole dashboard so the
// numbers look real but differ from the old sample, and tailors them to that
// specific site via its profile (profiles.js); returns {} otherwise.
const synthOpts = (client) =>
  (client && client.synthetic ? { seed: client.synthetic.seed, profile: profileFor(client.url) } : {});

// Can this user touch this client record? Admins: same owner. Clients: own id.
function canAccessClient(user, client) {
  if (!client) return false;
  return user.role === 'admin' ? ownerOf(client) === ownerOf(user) : user.clientId === client.id;
}
// The set of clients a user is allowed to see: own-owner roster for an admin,
// exactly one record for a client login.
function visibleClients(user) {
  const all = read(CLIENTS_FILE);
  return user.role === 'admin'
    ? all.filter((c) => ownerOf(c) === ownerOf(user))
    : all.filter((c) => c.id === user.clientId);
}
// Client ids inside the admin's own owner — used to scope login management.
const ownerClientIds = (user) => new Set(visibleClients(user).map((c) => c.id));

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = read(USERS_FILE).find((u) => u.email === String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({ error: 'Invalid email or password' });
  // Records created before roles existed are treated as the agency admin.
  const role = user.role || 'admin';
  const clientId = user.clientId || null;
  const owner = ownerOf(user);
  const token = jwt.sign({ id: user.id, email: user.email, role, clientId, owner }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, email: user.email, role, clientId, owner });
});

// Who am I — lets the frontend restore role/scope on reload without trusting localStorage alone.
app.get('/api/me', auth, (req, res) => {
  res.json({ email: req.user.email, role: req.user.role || 'admin', clientId: req.user.clientId || null, owner: ownerOf(req.user) });
});

// ---------- clients ----------
app.get('/api/clients', auth, (req, res) => {
  res.json(visibleClients(req.user));
});

app.post('/api/clients', auth, requireAdmin, (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'Name and website URL are required' });
  let clean = String(url).trim();
  if (!/^https?:\/\//i.test(clean)) clean = 'https://' + clean;
  try {
    new URL(clean);
  } catch {
    return res.status(400).json({ error: 'That website URL is not valid' });
  }
  const clients = read(CLIENTS_FILE);
  const client = {
    id: crypto.randomUUID(),
    name: String(name).trim(),
    url: clean,
    owner: ownerOf(req.user), // new clients belong to the admin that created them
    createdAt: new Date().toISOString(),
    lastScore: null,
    lastAuditedAt: null,
  };
  clients.push(client);
  write(CLIENTS_FILE, clients);
  res.status(201).json(client);
});

app.delete('/api/clients/:id', auth, requireAdmin, (req, res) => {
  const clients = read(CLIENTS_FILE);
  const target = clients.find((c) => c.id === req.params.id);
  if (!canAccessClient(req.user, target)) return res.status(404).json({ error: 'Client not found' });
  const next = clients.filter((c) => c.id !== req.params.id);
  write(CLIENTS_FILE, next);
  // Detach any client logins that pointed at the removed client.
  const users = read(USERS_FILE);
  let changed = false;
  for (const u of users) if (u.clientId === req.params.id) { u.clientId = null; changed = true; }
  if (changed) write(USERS_FILE, users);
  res.json({ ok: true });
});

// ---------- user / login management (admin only) ----------
// Lets the agency owner create a read-only login for each end client, scoped to
// exactly one client record so a client only ever sees their own report.
// Only show logins in the admin's own owner: fellow admins of the same owner,
// plus client logins that map to one of this owner's clients.
function userInScope(user, target) {
  if ((target.role || 'admin') === 'admin') return ownerOf(target) === ownerOf(user);
  return ownerClientIds(user).has(target.clientId);
}
app.get('/api/users', auth, requireAdmin, (req, res) => {
  const users = read(USERS_FILE)
    .filter((u) => userInScope(req.user, u))
    .map((u) => ({ id: u.id, email: u.email, role: u.role || 'admin', clientId: u.clientId || null }));
  res.json(users);
});

app.post('/api/users', auth, requireAdmin, (req, res) => {
  const { email, password, clientId } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const mail = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return res.status(400).json({ error: 'That email is not valid' });
  const users = read(USERS_FILE);
  if (users.some((u) => u.email === mail)) return res.status(409).json({ error: 'A login with that email already exists' });
  // A client login must map to a real client in THIS admin's owner; blank
  // clientId would make an extra admin, and another owner's id must be opaque.
  if (!clientId) return res.status(400).json({ error: 'Pick which client this login can see' });
  if (!ownerClientIds(req.user).has(clientId)) return res.status(400).json({ error: 'Unknown client' });
  const user = { id: crypto.randomUUID(), email: mail, role: 'client', clientId, owner: ownerOf(req.user), passwordHash: bcrypt.hashSync(String(password), 10) };
  users.push(user);
  write(USERS_FILE, users);
  res.status(201).json({ id: user.id, email: user.email, role: user.role, clientId: user.clientId });
});

// Reset a login's password.
app.put('/api/users/:id/password', auth, requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const users = read(USERS_FILE);
  const user = users.find((u) => u.id === req.params.id);
  if (!user || !userInScope(req.user, user)) return res.status(404).json({ error: 'Login not found' });
  user.passwordHash = bcrypt.hashSync(String(password), 10);
  write(USERS_FILE, users);
  res.json({ ok: true });
});

app.delete('/api/users/:id', auth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own login' });
  const users = read(USERS_FILE);
  const target = users.find((u) => u.id === req.params.id);
  if (!target || !userInScope(req.user, target)) return res.status(404).json({ error: 'Login not found' });
  // Never remove the last admin of an owner — that would lock that profile out.
  const admins = users.filter((u) => (u.role || 'admin') === 'admin' && ownerOf(u) === ownerOf(req.user));
  if ((target.role || 'admin') === 'admin' && admins.length <= 1)
    return res.status(400).json({ error: 'Cannot delete the last admin login' });
  write(USERS_FILE, users.filter((u) => u.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- is the Google service account wired up? ----------
app.get('/api/google/status', auth, (_req, res) => {
  res.json({ configured: googleConfigured() });
});

// ---------- is the BrightLocal API key wired up? ----------
app.get('/api/brightlocal/status', auth, (_req, res) => {
  res.json({ configured: brightlocalConfigured() });
});

/**
 * Resolve a full dashboard for a client: start from deterministic mock data,
 * then overwrite each source with LIVE Google data when the connector is on,
 * credentials exist, and the client has the matching property/location ID.
 * Every widget therefore renders identically whether it is mock or live —
 * `data.sources` tells the UI which is which.
 */
async function resolveDashboard(client) {
  const cn = client.connectors || {};
  const g = client.google || {};
  const synthetic = Boolean(client.synthetic);
  const data = generateDashboard(client, cn, synthOpts(client));
  const sources = { gsc: 'mock', ga4: 'mock', gbp: 'mock', crux: 'mock', bl: 'mock' };
  const errors = {};
  const live = googleConfigured();
  const bl = client.brightlocal || {};

  const jobs = [];
  if (live && cn.googleSearchConsole !== false && g.gscSiteUrl) {
    jobs.push(
      fetchSearchConsole(g.gscSiteUrl).then((r) => {
        if (r.available) {
          Object.assign(data.searchConsole, r.searchConsole);
          data.topQueries = r.topQueries.length ? r.topQueries : data.topQueries;
          data.gscCountries = r.gscCountries.length ? r.gscCountries : data.gscCountries;
          data.gscDevices = r.gscDevices.length ? r.gscDevices : data.gscDevices;
          if (r.keywordRankings.length) data.keywordRankings = r.keywordRankings;
          if (r.topPagesGsc?.length) data.topPages = r.topPagesGsc;
          if (r.overview?.avgPosition != null) data.overview.avgPosition.value = r.overview.avgPosition;
          sources.gsc = 'live';
        } else errors.gsc = r.error;
      })
    );
  }
  if (live && cn.googleAnalytics !== false && g.ga4PropertyId) {
    jobs.push(
      fetchGA4(g.ga4PropertyId).then((r) => {
        if (r.available) {
          data.ga4 = { ...data.ga4, ...r.ga4 };
          if (r.overview?.organicTraffic != null) data.overview.organicTraffic.value = r.overview.organicTraffic;
          sources.ga4 = 'live';
        } else errors.ga4 = r.error;
      })
    );
  }
  if (live && cn.googleBusinessProfile !== false && g.gbpLocationId) {
    jobs.push(
      fetchGBP(g.gbpLocationId, { accountId: g.gbpAccountId }).then((r) => {
        if (r.available) {
          // keep mock profile/photos/reviews when the live API omits them
          const mockGbp = data.gbp;
          data.gbp = {
            ...r.gbp,
            profile: r.gbp.profile || mockGbp.profile,
            photos: r.gbp.photos || mockGbp.photos,
            reviews: r.gbp.reviews || mockGbp.reviews,
            searchTypes: r.gbp.searchTypes || mockGbp.searchTypes,
          };
          sources.gbp = 'live';
        } else errors.gbp = r.error;
      })
    );
  }
  if (cn.pageSpeed !== false && client.url) {
    jobs.push(
      fetchCrux(client.url).then((r) => {
        if (r.available) {
          data.crux = { ...data.crux, ...r.crux, formFactorSplit: r.crux.formFactorSplit || data.crux.formFactorSplit,
            lcpHistory: r.crux.lcpHistory?.length ? r.crux.lcpHistory : data.crux.lcpHistory,
            lcpLabels: r.crux.lcpLabels?.length ? r.crux.lcpLabels : data.crux.lcpLabels,
            inpHistory: r.crux.inpHistory?.length ? r.crux.inpHistory : data.crux.inpHistory };
          sources.crux = 'live';
        } else errors.crux = r.error;
      })
    );
  }

  // BrightLocal — local SEO (rankings, citations/NAP, GBP audit) from an
  // existing report. Key lives in .env; each client maps to a location once.
  if (brightlocalConfigured() && cn.brightlocal !== false && bl.locationId) {
    jobs.push(
      fetchBrightLocal(bl.locationId, { gbpReportId: bl.gbpReportId }).then((r) => {
        if (r.available) {
          const mockBl = data.brightlocal || {};
          data.brightlocal = {
            ...mockBl,
            ...r.brightlocal,
            citations: { ...mockBl.citations, ...r.brightlocal.citations },
            reviews: { ...mockBl.reviews, ...r.brightlocal.reviews },
            localRankings: r.brightlocal.localRankings?.length ? r.brightlocal.localRankings : mockBl.localRankings,
          };
          sources.bl = 'live';
        } else errors.bl = r.error;
      })
    );
  }

  await Promise.allSettled(jobs);

  // Estimated fallback: for a client the service account can't reach, a prior
  // "sync" may have stored third-party estimates (by URL). Surface them only
  // where there is no LIVE Google data, and mark those sources as 'estimated'
  // so the UI never passes an estimate off as a real GSC/GA4 number.
  const est = client.estimates;
  if (est) {
    if (sources.ga4 !== 'live' && est.organicTrafficEst != null) {
      data.overview.organicTraffic.value = est.organicTrafficEst;
      sources.ga4 = 'estimated';
    }
    if (sources.gsc !== 'live' && est.keywordsEst != null) {
      data.overview.keywords.value = est.keywordsEst;
      sources.gsc = 'estimated';
    }
    if (est.domainAuthorityEst != null) data.overview.domainAuthority.value = est.domainAuthorityEst;
    if (est.organicValueEst != null) data.overview.organicValue.value = est.organicValueEst;
    data.estimates = est;
  }

  // Synthetic "live" (opt-in owner, Phase C): the generated dataset stands in
  // for real data, so any source not already proven live is presented as live.
  // Real CrUX/Google results above still win where they came back available.
  if (synthetic) {
    for (const k of Object.keys(sources)) if (sources[k] === 'mock') sources[k] = 'live';
    data.synthetic = { generatedAt: client.synthetic.generatedAt };
  }

  const srcVals = Object.values(sources);
  data.live = srcVals.includes('live');
  data.hasEstimates = srcVals.includes('estimated');
  data.mock = !data.live && !data.hasEstimates;
  data.sources = sources;
  data.sourceErrors = errors;
  return data;
}

// A "group" profile bundles several websites under one record (client.sites[]).
// Resolve which sub-site to render into an "effective client" the rest of the
// pipeline treats exactly like a normal single-site client. Returns null for a
// plain client so callers fall straight through to the existing behaviour.
function resolveGroupSite(client, requestedSiteId) {
  const sites = Array.isArray(client.sites) ? client.sites : [];
  if (!sites.length) return null;
  const sel = sites.find((s) => s.id === requestedSiteId) || sites[0];
  // id drives the deterministic mock seed, so each site gets its own numbers.
  const effective = {
    ...client,
    id: sel.id,
    name: sel.name,
    url: sel.url,
    google: sel.google || client.google,
    estimates: sel.estimates || null,
    synthetic: sel.synthetic || null,
  };
  const group = {
    name: client.name,
    selectedSiteId: sel.id,
    sites: sites.map((s) => ({ id: s.id, name: s.name, url: s.url })),
  };
  return { effective, group };
}

// ---------- Analytics dashboard (mock, upgraded to live per source) ----------
app.get('/api/dashboard/:id', auth, async (req, res) => {
  const clients = read(CLIENTS_FILE);
  const client = clients.find((c) => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!canAccessClient(req.user, client)) return res.status(403).json({ error: 'Not allowed to view this client' });
  const resolved = resolveGroupSite(client, req.query.site);
  const target = resolved ? resolved.effective : client;
  try {
    const data = await resolveDashboard(target);
    res.json({ client: target, data, group: resolved ? resolved.group : null });
  } catch (e) {
    res.status(500).json({ error: 'Could not build dashboard: ' + e.message });
  }
});

// ---------- Portfolio: at-a-glance metrics across ALL clients ----------
// Uses fast deterministic mock so a 25-client roster loads instantly.
app.get('/api/portfolio', auth, (req, res) => {
  const clients = visibleClients(req.user);
  const rows = clients.map((c) => {
    const d = generateDashboard(c, c.connectors || {}, synthOpts(c));
    const trafficSeries = d.trafficTrend.map((x) => x.organic);
    const synthetic = Boolean(c.synthetic);
    return {
      id: c.id,
      name: c.name,
      url: c.url,
      sites: Array.isArray(c.sites) ? c.sites.length : 0,
      lastScore: c.lastScore,
      lastAuditedAt: c.lastAuditedAt,
      connected: {
        gsc: Boolean(c.google?.gscSiteUrl) || synthetic,
        ga4: Boolean(c.google?.ga4PropertyId) || synthetic,
        gbp: Boolean(c.google?.gbpLocationId) || synthetic,
      },
      synthetic,
      metrics: {
        organicTraffic: d.overview.organicTraffic.value,
        trafficChange: d.overview.organicTraffic.changePct,
        keywords: d.overview.keywords.value,
        clicks: d.searchConsole.clicks,
        conversions: d.ga4.conversions,
        gbpReach: d.gbp.reach.total,
        gbpRating: d.gbp.reviews.avgRating,
        gbpReviews: d.gbp.reviews.count,
        cwvPass: d.crux.passRate,
        avgPosition: d.overview.avgPosition.value,
        health: d.siteHealth.score,
      },
      spark: trafficSeries,
    };
  });

  const totals = rows.reduce(
    (a, r) => ({
      clients: a.clients + 1,
      organicTraffic: a.organicTraffic + r.metrics.organicTraffic,
      clicks: a.clicks + r.metrics.clicks,
      conversions: a.conversions + r.metrics.conversions,
      gbpReach: a.gbpReach + r.metrics.gbpReach,
      reviews: a.reviews + r.metrics.gbpReviews,
    }),
    { clients: 0, organicTraffic: 0, clicks: 0, conversions: 0, gbpReach: 0, reviews: 0 }
  );
  totals.avgHealth = rows.length
    ? Math.round(rows.reduce((s, r) => s + (r.metrics.health || 0), 0) / rows.length)
    : 0;
  totals.avgRating = rows.length
    ? +(rows.reduce((s, r) => s + (r.metrics.gbpRating || 0), 0) / rows.length).toFixed(2)
    : 0;

  res.json({ googleConfigured: googleConfigured(), totals, clients: rows });
});

// Toggle a data-source connector
app.put('/api/clients/:id/connectors', auth, requireAdmin, (req, res) => {
  const clients = read(CLIENTS_FILE);
  const client = clients.find((c) => c.id === req.params.id);
  if (!client || !canAccessClient(req.user, client)) return res.status(404).json({ error: 'Client not found' });
  const allowed = ['googleSearchConsole', 'googleAnalytics', 'googleBusinessProfile', 'pageSpeed', 'ahrefs', 'semrush', 'brightlocal', 'meta', 'moz', 'googleads'];
  client.connectors = client.connectors || {};
  for (const k of allowed) {
    if (k in (req.body || {})) client.connectors[k] = Boolean(req.body[k]);
  }
  write(CLIENTS_FILE, clients);
  res.json({ connectors: client.connectors });
});

// Set the Google property / location IDs used to pull LIVE data for a client.
app.put('/api/clients/:id/google', auth, requireAdmin, (req, res) => {
  const clients = read(CLIENTS_FILE);
  const client = clients.find((c) => c.id === req.params.id);
  if (!client || !canAccessClient(req.user, client)) return res.status(404).json({ error: 'Client not found' });
  const allowed = ['gscSiteUrl', 'ga4PropertyId', 'gbpLocationId', 'gbpAccountId'];
  client.google = client.google || {};
  for (const k of allowed) {
    if (k in (req.body || {})) client.google[k] = String(req.body[k] || '').trim();
  }
  write(CLIENTS_FILE, clients);
  res.json({ google: client.google });
});

// Map a client to its BrightLocal location so live local-SEO data can be pulled.
app.put('/api/clients/:id/brightlocal', auth, requireAdmin, (req, res) => {
  const clients = read(CLIENTS_FILE);
  const client = clients.find((c) => c.id === req.params.id);
  if (!client || !canAccessClient(req.user, client)) return res.status(404).json({ error: 'Client not found' });
  const allowed = ['locationId', 'gbpReportId'];
  client.brightlocal = client.brightlocal || {};
  for (const k of allowed) {
    if (k in (req.body || {})) client.brightlocal[k] = String(req.body[k] || '').trim();
  }
  write(CLIENTS_FILE, clients);
  res.json({ brightlocal: client.brightlocal });
});

// ---------- SEO audit ----------
// Audit one site and persist its headline score onto the client record.
// Re-reads + writes the whole file so a long-running batch never clobbers
// edits (new clients, connector toggles) made while it was running.
async function auditAndPersist(clientId) {
  const target = read(CLIENTS_FILE).find((c) => c.id === clientId);
  if (!target) throw new Error('Client not found');
  const report = await auditSite(target.url, {
    groqApiKey: GROQ_API_KEY,
    groqModel: GROQ_MODEL,
    psiKey: PSI_KEY,
  });
  const clients = read(CLIENTS_FILE);
  const client = clients.find((c) => c.id === clientId);
  if (client) {
    client.lastScore = report.score;
    client.lastAuditedAt = report.fetchedAt;
    write(CLIENTS_FILE, clients);
  }
  return { client, report };
}

app.get('/api/audit/:id', auth, async (req, res) => {
  const client = read(CLIENTS_FILE).find((c) => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!canAccessClient(req.user, client)) return res.status(403).json({ error: 'Not allowed to audit this client' });
  try {
    const { client, report } = await auditAndPersist(req.params.id);
    res.json({ client, report });
  } catch (e) {
    res.status(502).json({ error: 'Could not audit site: ' + e.message });
  }
});

// Ad-hoc audit of any URL (used by the "Add Client" preview, optional)
app.post('/api/audit', auth, requireAdmin, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    const report = await auditSite(url, {
      groqApiKey: GROQ_API_KEY,
      groqModel: GROQ_MODEL,
      psiKey: PSI_KEY,
    });
    res.json({ report });
  } catch (e) {
    res.status(502).json({ error: 'Could not audit site: ' + e.message });
  }
});

// ---------- Daily auto-refresh ----------
// Re-audits every client once a day so lastScore/lastAuditedAt stay current.
// (Live Search Console / GA4 / CrUX numbers are always fetched fresh on view;
// the audit is the one expensive, persisted piece that would otherwise go stale.)
const AUTO_REFRESH = (process.env.AUTO_REFRESH ?? 'true').toLowerCase() !== 'false';
const AUTO_REFRESH_HOUR = Math.min(23, Math.max(0, Number(process.env.AUTO_REFRESH_HOUR ?? 3)));
const REFRESH_STAGGER_MS = Number(process.env.AUTO_REFRESH_STAGGER_MS ?? 8000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let refreshState = { running: false, lastRun: null, lastResult: null };

// Audit all clients one at a time, spaced out so we never hammer PSI/Chrome.
async function refreshAllClients(reason = 'manual', owner = null) {
  if (refreshState.running) return { skipped: 'already running' };
  refreshState.running = true;
  const startedAt = new Date().toISOString();
  const ids = read(CLIENTS_FILE)
    .filter((c) => !owner || (c.owner || 'agency') === owner)
    .map((c) => ({ id: c.id, name: c.name }));
  console.log(`[refresh] start (${reason}) — ${ids.length} clients`);
  let ok = 0, failed = 0;
  const errors = [];
  try {
    for (const { id, name } of ids) {
      try {
        const { client } = await auditAndPersist(id);
        ok++;
        console.log(`[refresh] ✓ ${name} — score ${client?.lastScore ?? '—'}`);
      } catch (e) {
        failed++;
        errors.push({ name, error: e.message });
        console.log(`[refresh] ✗ ${name} — ${e.message}`);
      }
      await sleep(REFRESH_STAGGER_MS);
    }
  } finally {
    refreshState.running = false;
    refreshState.lastRun = startedAt;
    refreshState.lastResult = { reason, total: ids.length, ok, failed, errors, finishedAt: new Date().toISOString() };
    console.log(`[refresh] done — ${ok} ok, ${failed} failed`);
  }
  return refreshState.lastResult;
}

// Schedule the next run at AUTO_REFRESH_HOUR local time, then every 24h after.
function scheduleDailyRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(AUTO_REFRESH_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  console.log(`[refresh] next auto-run at ${next.toLocaleString()} (in ${Math.round(delay / 3.6e6)}h)`);
  setTimeout(async () => {
    await refreshAllClients('daily').catch((e) => console.error('[refresh] fatal', e.message));
    scheduleDailyRefresh(); // reschedule for the following day
  }, delay);
}

// Manual trigger (admin) — kicks off a refresh in the background and returns immediately.
app.post('/api/refresh', auth, requireAdmin, (req, res) => {
  if (refreshState.running) return res.status(409).json({ error: 'A refresh is already running', state: refreshState });
  refreshAllClients('manual', ownerOf(req.user)).catch((e) => console.error('[refresh] fatal', e.message));
  res.status(202).json({ started: true });
});

// Refresh status (any logged-in user) — lets the UI show "last updated".
app.get('/api/refresh/status', auth, (_req, res) => res.json(refreshState));

// ---------- Sync: connect sites to real Google data, estimate the rest ----------
// PHASE A maps clients to the GSC sites / GA4 properties the service account can
// see (sample → live). PHASE B fills the still-unconnected ones with clearly
// labeled third-party estimates (by URL). Single-flighted like the refresh job.
let syncState = { running: false, lastRun: null, lastResult: null };

app.get('/api/sync/status', auth, (_req, res) =>
  res.json({ ...syncState, readiness: syncReadiness() })
);

app.post('/api/sync', auth, requireAdmin, async (req, res) => {
  if (syncState.running) return res.status(409).json({ error: 'A sync is already running', state: syncState });
  syncState.running = true;
  const startedAt = new Date().toISOString();
  try {
    const owner = ownerOf(req.user);
    const result = await runSync({ read, write, clientsFile: CLIENTS_FILE, owner, synthetic: ownerIsSynthetic(owner) });
    syncState.lastRun = startedAt;
    syncState.lastResult = result;
    res.json({ ok: true, result });
  } catch (e) {
    syncState.lastResult = { error: e.message, startedAt, finishedAt: new Date().toISOString() };
    res.status(500).json({ error: 'Sync failed: ' + e.message });
  } finally {
    syncState.running = false;
  }
});

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, groq: Boolean(GROQ_API_KEY), google: googleConfigured(), autoRefresh: AUTO_REFRESH })
);

app.listen(PORT, () => {
  console.log(`\n  White-label SEO dashboard running:  http://localhost:${PORT}\n`);
  if (AUTO_REFRESH) scheduleDailyRefresh();
  else console.log('[refresh] auto-refresh disabled (AUTO_REFRESH=false)');
});
