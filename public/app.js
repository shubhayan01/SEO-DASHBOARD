// app.js — Justwords Client Intelligence (SPA).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  token: localStorage.getItem('jw_token') || null,
  email: localStorage.getItem('jw_email') || null,
  role: localStorage.getItem('jw_role') || null,
  clientId: localStorage.getItem('jw_client') || null,
  portfolio: null,
  currentClientId: null,
  currentData: null,
  currentClient: null,
  currentRange: localStorage.getItem('jw_range') || '12m',
};
const isAdmin = () => state.role === 'admin';

// ---------- inline icon set (feather-ish) ----------
const ICONS = {
  overview: '<circle cx="12" cy="12" r="9"/><path d="M12 12l4-2"/><path d="M12 12v-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>',
  traffic: '<path d="M3 3v18h18"/><path d="M7 15l3-4 3 2 4-6"/>',
  business: '<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><rect x="9" y="12" width="6" height="9"/>',
  gauge: '<path d="M4 15a8 8 0 0 1 16 0"/><line x1="12" y1="15" x2="16" y2="11"/>',
  link: '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  health: '<path d="M21 8h-5l-2 5-3-9-2 5H3"/>',
  star: '<polygon points="12 3 15 9.5 22 10 17 15 18.5 22 12 18.5 5.5 22 7 15 2 10 9 9.5"/>',
  phone: '<path d="M5 4h4l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  map: '<polygon points="9 4 3 6 3 20 9 18 15 20 21 18 21 4 15 6 9 4"/><line x1="9" y1="4" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="20"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  bolt: '<polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2"/>',
  plug: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="16" y1="2.5" x2="16" y2="6.5"/>',
  brightlocal: '<path d="M12 21s-7-4.5-7-10a7 7 0 0 1 14 0c0 5.5-7 10-7 10z"/><circle cx="12" cy="11" r="2.5"/>',
  meta: '<path d="M4 16c1.5-8 5-8 8 0s6.5 8 8 0"/>',
  moz: '<path d="M4 18V8l4 6 4-6v10"/><path d="M15 18V8l3 6 3-6v10"/>',
  googleads: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15l3-6 3 4 4-7"/>',
};
const svg = (name, cls = 'ic') => `<svg viewBox="0 0 24 24" class="${cls}">${ICONS[name] || ''}</svg>`;

// ---------- master date range ----------
// One filter drives every time-series chart on the report. Each option maps to a
// trailing window in days; charts slice their own series (daily or monthly) to match.
const RANGE_DAYS = { '30d': 30, '60d': 60, '90d': 90, '3m': 90, '6m': 180, '12m': 365 };
const RANGE_LABEL = {
  '30d': 'Last 30 days', '60d': 'Last 60 days', '90d': 'Last 90 days',
  '3m': 'Last 3 months', '6m': 'Last 6 months', '12m': 'Last 12 months',
};
const rangeDays = () => RANGE_DAYS[state.currentRange] || 365;
const rangeLabel = () => RANGE_LABEL[state.currentRange] || 'Last 12 months';
// Trailing slice for day-granular series (e.g. 30- or 90-point daily series).
function sliceDaily(series = [], labels = []) {
  const n = Math.min(series.length, rangeDays());
  return { series: series.slice(-n), labels: labels.slice(-n) };
}
// Trailing slice for month-granular series (e.g. 12- or 8-point monthly series).
function sliceMonthly(series = [], labels = []) {
  const n = Math.min(series.length, Math.max(1, Math.ceil(rangeDays() / 30)));
  return { series: series.slice(-n), labels: labels.slice(-n) };
}

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('jw_theme', theme);
  const lbl = $('#theme-label');
  if (lbl) lbl.textContent = theme === 'light' ? 'Dark mode' : 'Light mode';
}
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(cur === 'light' ? 'dark' : 'light');
});
applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { logout(); throw new Error('Session expired — please sign in again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- auth ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error'); err.textContent = '';
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#login-email').value, password: $('#login-password').value }),
    });
    state.token = data.token; state.email = data.email;
    state.role = data.role; state.clientId = data.clientId;
    localStorage.setItem('jw_token', data.token);
    localStorage.setItem('jw_email', data.email);
    localStorage.setItem('jw_role', data.role || '');
    localStorage.setItem('jw_client', data.clientId || '');
    enterApp();
  } catch (e2) { err.textContent = e2.message; }
});
$('#logout-btn').addEventListener('click', logout);
function logout() {
  state.token = null; state.role = null; state.clientId = null;
  ['jw_token', 'jw_email', 'jw_role', 'jw_client'].forEach((k) => localStorage.removeItem(k));
  document.body.classList.remove('role-client', 'role-admin');
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}
async function enterApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#user-email').textContent = state.email || '';
  $('#user-avatar').textContent = (state.email || 'JW').slice(0, 2).toUpperCase();
  // Confirm role/scope from the server so a stale token can't over-grant.
  try {
    const me = await api('/api/me');
    state.role = me.role; state.clientId = me.clientId; state.email = me.email;
    localStorage.setItem('jw_role', me.role || '');
    localStorage.setItem('jw_client', me.clientId || '');
  } catch { return; }
  document.body.classList.toggle('role-client', !isAdmin());
  document.body.classList.toggle('role-admin', isAdmin());
  $('#user-role').textContent = isAdmin() ? 'Agency admin' : 'Client';
  if (isAdmin()) {
    navigate('portfolio');
    loadPortfolio();
  } else {
    // A client login skips the portfolio entirely and opens its one report.
    if (state.clientId) openReport(state.clientId);
    else $('#report-body').innerHTML = `<div class="empty">No client is linked to this login yet. Ask your agency to connect it.</div>`, navigate('report');
  }
}

// ---------- navigation ----------
function navigate(view) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $(`[data-view="${view}"]`);
  if (el) el.classList.remove('hidden');
  $$('.nav-item[data-nav]').forEach((n) => n.classList.toggle('active', n.dataset.nav === view));
}
document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) { if (nav.dataset.nav === 'team') loadTeam(); return navigate(nav.dataset.nav); }
  const go = e.target.closest('[data-go]');
  if (go) { if (go.dataset.go === 'portfolio') loadPortfolio(); return navigate(go.dataset.go); }
});

// =====================================================================
// PORTFOLIO
// =====================================================================
async function loadPortfolio() {
  try {
    state.portfolio = await api('/api/portfolio');
    const status = $('#google-status');
    if (state.portfolio.googleConfigured) { status.className = 'pill pill-live'; status.textContent = 'Google account connected'; }
    else { status.className = 'pill pill-mock'; status.textContent = 'Sample data · connect Google to go live'; }
    renderPortfolioKpis();
    renderPortfolioTable();
  } catch (e) { console.error(e); }
}

function renderPortfolioKpis() {
  const t = state.portfolio.totals;
  $('#portfolio-kpis').innerHTML = [
    kpiCard('Clients tracked', String(t.clients)),
    kpiCard('Organic traffic', fmtNum(t.organicTraffic), 'visits / mo'),
    kpiCard('Search clicks', fmtNum(t.clicks), 'last 30 days'),
    kpiCard('Local reach', fmtNum(t.gbpReach), 'Business Profile'),
    kpiCard('Conversions', fmtNum(t.conversions), 'last 30 days'),
    kpiCard('Avg. rating', t.avgRating.toFixed(2) + ' ★', `${fmtNum(t.reviews)} reviews`),
  ].join('');
}
function kpiCard(label, value, foot) {
  return `<div class="kpi"><div class="kpi-label">${esc(label)}</div>
    <div class="kpi-val">${value}</div>
    ${foot ? `<div class="kpi-foot muted">${esc(foot)}</div>` : ''}</div>`;
}

function renderPortfolioTable() {
  const filter = ($('#client-filter')?.value || '').toLowerCase();
  const sortKey = $('#client-sort')?.value || 'name';
  let rows = [...state.portfolio.clients];
  if (filter) rows = rows.filter((r) => (r.name + ' ' + r.url).toLowerCase().includes(filter));
  rows.sort((a, b) => sortKey === 'name'
    ? a.name.localeCompare(b.name)
    : (b.metrics[sortKey] || 0) - (a.metrics[sortKey] || 0));

  if (!rows.length) {
    $('#portfolio-table').innerHTML = `<div class="empty">No clients yet. Click <b>Add client</b> to register your first website.</div>`;
    return;
  }
  const body = rows.map((r) => {
    const m = r.metrics;
    const dc = r.metrics.trafficChange;
    return `<tr class="row-link" data-client="${r.id}">
      <td>
        <div class="client-cell">
          <span class="client-fav">${esc(initials(r.name))}</span>
          <div><div class="client-name">${esc(r.name)}</div><div class="client-url">${esc(hostOf(r.url))}</div></div>
        </div>
      </td>
      <td class="num">${fmtNum(m.organicTraffic)} <span class="delta ${dc >= 0 ? 'up' : 'down'}">${dc >= 0 ? '▲' : '▼'}${Math.abs(dc)}%</span></td>
      <td class="num">${sparkline(r.spark)}</td>
      <td class="num">${fmtNum(m.clicks)}</td>
      <td class="num">${fmtNum(m.gbpReach)}</td>
      <td class="num">${m.gbpRating.toFixed(1)} ★</td>
      <td class="num">${fmtNum(m.conversions)}</td>
      <td class="num"><span class="pos" style="color:${scoreColor(m.cwvPass)}">${Math.round(m.cwvPass)}%</span></td>
      <td><span class="conn-dots">
        <span class="conn-dot ${r.connected.gsc ? 'on' : ''}" title="Search Console"></span>
        <span class="conn-dot ${r.connected.ga4 ? 'on' : ''}" title="Analytics"></span>
        <span class="conn-dot ${r.connected.gbp ? 'on' : ''}" title="Business Profile"></span>
      </span></td>
    </tr>`;
  }).join('');

  $('#portfolio-table').innerHTML = `<table class="tbl">
    <thead><tr>
      <th>Client</th><th class="num">Organic / mo</th><th class="num">Trend</th>
      <th class="num">Clicks</th><th class="num">Local reach</th><th class="num">Rating</th>
      <th class="num">Conv.</th><th class="num">CWV</th><th>Google</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}
$('#client-filter')?.addEventListener('input', renderPortfolioTable);
$('#client-sort')?.addEventListener('change', renderPortfolioTable);
$('#portfolio-table').addEventListener('click', (e) => {
  const row = e.target.closest('[data-client]');
  if (row) openReport(row.dataset.client);
});

// =====================================================================
// ADD CLIENT
// =====================================================================
$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#add-error'), ok = $('#add-ok');
  err.textContent = ''; ok.textContent = '';
  try {
    await api('/api/clients', {
      method: 'POST',
      body: JSON.stringify({ name: $('#add-name').value, url: $('#add-url').value }),
    });
    ok.textContent = 'Client saved.';
    $('#add-name').value = ''; $('#add-url').value = '';
    await loadPortfolio();
    setTimeout(() => navigate('portfolio'), 500);
  } catch (e2) { err.textContent = e2.message; }
});

// =====================================================================
// CLIENT LOGINS (admin only)
// =====================================================================
async function loadTeam() {
  try {
    const [clients, users] = await Promise.all([api('/api/clients'), api('/api/users')]);
    // Build the "which client can this login see" dropdown.
    const sel = $('#user-client');
    sel.innerHTML = '<option value="" disabled selected>Select a client…</option>' +
      clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const byId = Object.fromEntries(clients.map((c) => [c.id, c.name]));
    renderUsers(users, byId);
  } catch (e) { console.error(e); }
}
function renderUsers(users, byId) {
  const rows = users.map((u) => {
    const scope = u.role === 'admin'
      ? '<span class="user-role-tag admin">All clients (admin)</span>'
      : esc(byId[u.clientId] || 'Unassigned');
    const actions = u.role === 'admin'
      ? '<span class="muted small">—</span>'
      : `<button class="linkish" data-reset-user="${esc(u.id)}">Reset password</button>
         <button class="linkish danger" data-del-user="${esc(u.id)}">Remove</button>`;
    return `<tr><td class="kw">${esc(u.email)}</td><td>${scope}</td><td class="num">${actions}</td></tr>`;
  }).join('');
  $('#users-table').innerHTML = `<table class="tbl">
    <thead><tr><th>Login email</th><th>Can see</th><th class="num">Actions</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#user-error'), ok = $('#user-ok');
  err.textContent = ''; ok.textContent = '';
  try {
    await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        email: $('#user-email-in').value,
        password: $('#user-pass').value,
        clientId: $('#user-client').value,
      }),
    });
    ok.textContent = 'Login created. Share the email + password with your client.';
    $('#user-email-in').value = ''; $('#user-pass').value = ''; $('#user-client').value = '';
    loadTeam();
  } catch (e2) { err.textContent = e2.message; }
});
$('#users-table').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-user]');
  const reset = e.target.closest('[data-reset-user]');
  if (del) {
    if (!confirm('Remove this login? The client will no longer be able to sign in.')) return;
    try { await api('/api/users/' + del.dataset.delUser, { method: 'DELETE' }); loadTeam(); }
    catch (err) { alert(err.message); }
  } else if (reset) {
    const pw = prompt('New password for this login (min 6 characters):');
    if (!pw) return;
    try { await api('/api/users/' + reset.dataset.resetUser + '/password', { method: 'PUT', body: JSON.stringify({ password: pw }) });
      alert('Password updated.'); }
    catch (err) { alert(err.message); }
  }
});

// =====================================================================
// REPORT (per client, tabbed)
// =====================================================================
async function openReport(id) {
  state.currentClientId = id;
  navigate('report');
  const body = $('#report-body');
  body.innerHTML = `<div class="loading-wrap"><div class="spinner"></div><p>Loading client report…</p></div>`;
  try {
    const { client, data } = await api('/api/dashboard/' + id);
    state.currentClient = client; state.currentData = data;
    renderReport();
  } catch (e) {
    body.innerHTML = `<div class="empty">Could not load report: ${esc(e.message)}</div>`;
  }
}

function sourceBadge(key) {
  const live = state.currentData?.sources?.[key] === 'live';
  return `<span class="pill ${live ? 'pill-live' : 'pill-mock'}" style="font-size:11px">${live ? 'Live' : 'Sample'}</span>`;
}

// Every report section, in scroll order. [key, nav label, icon].
const REPORT_SECTIONS = [
  ['overview', 'Overview', 'overview'],
  ['search', 'Search Console Data', 'search'],
  ['traffic', 'Traffic', 'traffic'],
  ['business', 'GMB data', 'business'],
  ['performance', 'Performance', 'gauge'],
  ['offpage', 'Off-page', 'link'],
];
function sectionBody(key, d) {
  switch (key) {
    case 'overview': return tabOverview(d);
    case 'search': return tabSearch(d);
    case 'traffic': return tabTraffic(d);
    case 'business': return tabBusiness(d);
    case 'performance': return tabPerformance(d);
    case 'offpage': return tabOffpage(d);
    default: return '';
  }
}

function renderReport() {
  const c = state.currentClient, d = state.currentData;
  const overallLive = !d.mock;
  const rangeOptions = Object.entries(RANGE_LABEL)
    .map(([k, label]) => `<option value="${k}" ${k === state.currentRange ? 'selected' : ''}>${label}</option>`).join('');
  $('#report-body').innerHTML = `
    ${isAdmin() ? `<div class="crumb" data-go="portfolio">${svg('back')} Portfolio</div>` : ''}
    <div class="report-top">
      <div class="report-id">
        <span class="report-fav">${esc(initials(c.name))}</span>
        <div>
          <h1>${esc(c.name)}</h1>
          <a class="client-url" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(hostOf(c.url))} ${svg('external', 'ic')}</a>
        </div>
      </div>
      <div class="report-actions">
        <span class="pill ${overallLive ? 'pill-live' : 'pill-mock'}">${overallLive ? 'Live data' : 'Sample data'}</span>
        ${isAdmin() ? `<button class="btn btn-sm" id="connect-google-btn">${svg('plug')} Connect Google</button>` : ''}
      </div>
    </div>
    <div class="section-nav" id="section-nav">
      <div class="section-nav-tabs">
        ${REPORT_SECTIONS.map(([k, label, ic], i) => `<button class="snav ${i === 0 ? 'active' : ''}" data-scroll="sec-${k}">${svg(ic, 'ic')} ${label}</button>`).join('')}
      </div>
      <label class="date-filter" title="Reporting period — filters every chart below">
        ${svg('calendar', 'ic')}
        <select id="date-range">${rangeOptions}</select>
      </label>
    </div>
    ${REPORT_SECTIONS.map(([k]) => `<section id="sec-${k}" class="report-section">${sectionBody(k, d)}</section>`).join('')}
  `;
  setupScrollSpy();
}

// Highlight the section-nav button for whichever section is in view.
let scrollObserver = null;
function setupScrollSpy() {
  if (scrollObserver) scrollObserver.disconnect();
  const nav = $('#section-nav');
  if (!nav) return;
  const btns = {};
  $$('.snav', nav).forEach((b) => { btns[b.dataset.scroll] = b; });
  scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      $$('.snav', nav).forEach((b) => b.classList.remove('active'));
      btns[en.target.id]?.classList.add('active');
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
  $$('.report-section').forEach((s) => scrollObserver.observe(s));
}

// report-level events: scroll to a section, or open the connect-Google modal.
$('#report-body').addEventListener('click', (e) => {
  const snav = e.target.closest('[data-scroll]');
  if (snav) {
    document.getElementById(snav.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (e.target.closest('#connect-google-btn')) return openGoogleModal();
});
// date filter + connector switches
$('#report-body').addEventListener('change', async (e) => {
  const dr = e.target.closest('#date-range');
  if (dr) {
    state.currentRange = dr.value;
    localStorage.setItem('jw_range', dr.value);
    renderReport();
    return;
  }
  const sw = e.target.closest('[data-connector]');
  if (!sw) return;
  const key = sw.dataset.connector;
  try {
    await api('/api/clients/' + state.currentClientId + '/connectors', {
      method: 'PUT', body: JSON.stringify({ [key]: sw.checked }),
    });
    const { client, data } = await api('/api/dashboard/' + state.currentClientId);
    state.currentClient = client; state.currentData = data;
    renderReport();
  } catch (err) { alert(err.message); }
});

// ---------- tab: Overview ----------
function tabOverview(d) {
  const o = d.overview;
  const kpis = [
    kpiDelta('Organic traffic', o.organicTraffic),
    kpiDelta('Keywords', o.keywords),
    kpiDelta('Local reach', { value: d.gbp.reach.total, changePct: d.gbp.reach.changePct, unit: 'GBP views' }),
    kpiDelta('Search clicks', { value: d.searchConsole.clicks, changePct: 0, unit: 'last 30d' }),
    kpiDelta('Conversions', { value: d.ga4.conversions, changePct: 0, unit: 'GA4' }),
    kpiDelta('CWV pass rate', { value: Math.round(d.crux.passRate || 0), changePct: 0, unit: '%', suffix: '%' }),
    kpiDelta('Avg. position', o.avgPosition),
  ].join('');

  const last = d.trafficTrend[d.trafficTrend.length - 1];
  const sources = [
    { label: 'Organic', value: last.organic, color: '#5b8def' },
    { label: 'Direct', value: last.direct, color: '#41c789' },
    { label: 'Referral', value: last.referral, color: '#e0a53d' },
    { label: 'Social', value: last.social, color: '#8a6bf0' },
  ];
  const tt = sliceMonthly(d.trafficTrend.map((x) => x.organic), d.trafficTrend.map((x) => x.month));
  return `
    <div class="kpi-strip">${kpis}</div>
    <div class="grid col-2-1 mb">
      <div class="widget">
        <div class="widget-head"><h3>Organic traffic</h3><span class="src-badge">${esc(rangeLabel())}</span></div>
        ${areaChart(tt.series, { labels: tt.labels, color: '#5b8def' })}
      </div>
      <div class="widget">
        <div class="widget-head"><h3>Traffic sources</h3></div>
        ${donut(sources)}
      </div>
    </div>
    ${connectorsPanel(d)}
  `;
}

function connectorsPanel(d) {
  const cn = d.connectors;
  // Clients see the source state read-only; only the agency admin can toggle sources.
  const control = (key) => isAdmin()
    ? `<label class="switch"><input type="checkbox" data-connector="${key}" ${cn[key] ? 'checked' : ''}><span class="track"></span><span class="knob"></span></label>`
    : `<span class="user-role-tag ${cn[key] ? 'admin' : ''}">${cn[key] ? 'On' : 'Off'}</span>`;
  const item = (key, name, iconName, sub) => `
    <div class="conn-card">
      <span class="conn-ic">${svg(iconName, 'ic')}</span>
      <div class="conn-info"><div class="conn-title">${esc(name)}</div><div class="conn-state">${esc(sub)}</div></div>
      ${control(key)}
    </div>`;
  return `<div class="widget">
    <div class="widget-head"><h3>Data connectors</h3><span class="muted small">${isAdmin() ? 'Toggle a source to include or hide it across this report.' : 'Which data sources are feeding this report.'}</span></div>
    <div class="conn-grid">
      ${item('googleSearchConsole', 'Search Console', 'search', d.sources.gsc === 'live' ? 'Live' : 'Sample data')}
      ${item('googleAnalytics', 'Google Analytics 4', 'traffic', d.sources.ga4 === 'live' ? 'Live' : 'Sample data')}
      ${item('googleBusinessProfile', 'GMB (Business Profile)', 'business', d.sources.gbp === 'live' ? 'Live' : 'Sample data')}
      ${item('pageSpeed', 'PageSpeed / CrUX', 'gauge', d.sources.crux === 'live' ? 'Live' : 'Sample data')}
      ${item('ahrefs', 'Ahrefs (backlinks)', 'link', cn.ahrefs ? 'Enabled' : 'Off')}
      ${item('semrush', 'SEMrush (competitors)', 'traffic', cn.semrush ? 'Enabled' : 'Off')}
      ${item('brightlocal', 'BrightLocal (local SEO)', 'brightlocal', cn.brightlocal ? 'Enabled' : 'Off')}
      ${item('meta', 'Meta (Facebook / Instagram)', 'meta', cn.meta ? 'Enabled' : 'Off')}
      ${item('moz', 'Moz (domain authority)', 'moz', cn.moz ? 'Enabled' : 'Off')}
      ${item('googleads', 'Google Ads (paid search)', 'googleads', cn.googleads ? 'Enabled' : 'Off')}
    </div>
  </div>`;
}

// ---------- tab: Search (GSC) ----------
function tabSearch(d) {
  if (!d.connectors.googleSearchConsole) return gatedTab('Search Console', 'googleSearchConsole');
  const s = d.searchConsole;
  const kd = d.keywordDistribution;
  const cs = sliceDaily(s.clicksSeries, s.labels);
  return `
    <div class="widget mb">
      <div class="widget-head"><h3>${svg('search')} Search Console ${sourceBadge('gsc')}</h3><span class="src-badge">${esc(rangeLabel())}</span></div>
      <div class="wstats">
        ${wstat('Clicks', fmtNum(s.clicks))}
        ${wstat('Impressions', fmtNum(s.impressions))}
        ${wstat('Avg. CTR', s.ctr + '%')}
        ${wstat('Avg. position', s.avgPosition)}
      </div>
      ${areaChart(cs.series, { color: '#41c789', labels: cs.labels })}
    </div>
    <div class="widget mb">
      <div class="widget-head"><h3>Top search queries ${sourceBadge('gsc')}</h3></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Query</th><th class="num">Clicks</th><th class="num">Impr.</th><th class="num">CTR</th><th class="num">Pos.</th></tr></thead>
        <tbody>${d.topQueries.map((q) => `<tr><td class="kw">${esc(q.query)}</td>
          <td class="num">${fmtNum(q.clicks)}</td><td class="num">${fmtNum(q.impressions)}</td>
          <td class="num">${q.ctr}%</td><td class="num"><span class="pos">${Math.round(q.position)}</span></td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="grid col-2-1 mb">
      <div class="widget"><div class="widget-head"><h3>Clicks by country</h3></div>
        ${hbars(d.gscCountries.map((c) => ({ label: c.country, value: c.clicks })))}</div>
      <div class="widget"><div class="widget-head"><h3>Devices</h3></div>
        ${donut(d.gscDevices.map((x) => ({ label: x.device, value: x.share, color: x.color })))}</div>
    </div>
    <div class="grid col-2-1">
      <div class="widget"><div class="widget-head"><h3>Keyword rankings</h3></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Keyword</th><th class="num">Pos</th><th class="num">Δ</th><th class="num">Volume</th><th class="num">KD</th><th>Intent</th></tr></thead>
          <tbody>${d.keywordRankings.map((k) => {
            const ch = k.change > 0 ? `<span class="up">▲ ${k.change}</span>` : k.change < 0 ? `<span class="down">▼ ${Math.abs(k.change)}</span>` : '—';
            return `<tr><td class="kw">${esc(k.keyword)}</td><td class="num"><span class="pos">${k.position}</span></td>
              <td class="num">${ch}</td><td class="num">${fmtNum(k.volume)}</td>
              <td class="num">${k.difficulty == null ? '—' : `<span class="kd" style="--kd:${k.difficulty}">${k.difficulty}</span>`}</td>
              <td><span class="tag">${esc(k.intent)}</span></td></tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>
      <div class="widget"><div class="widget-head"><h3>Position distribution</h3></div>
        ${hbars([
          { label: 'Pos 1–3', value: kd.top3, color: '#16a34a' },
          { label: 'Pos 4–10', value: kd.p4_10, color: '#5b8def' },
          { label: 'Pos 11–20', value: kd.p11_20, color: '#8a6bf0' },
          { label: 'Pos 21–50', value: kd.p21_50, color: '#e0a53d' },
          { label: 'Pos 51–100', value: kd.p51_100, color: '#e0607a' },
        ])}
      </div>
    </div>`;
}

// ---------- tab: Traffic (GA4) ----------
function tabTraffic(d) {
  if (!d.connectors.googleAnalytics) return gatedTab('Google Analytics', 'googleAnalytics');
  const g = d.ga4;
  const ss = sliceDaily(g.sessionsSeries);
  return `
    <div class="widget mb">
      <div class="widget-head"><h3>${svg('traffic')} Google Analytics 4 ${sourceBadge('ga4')}</h3><span class="src-badge">${esc(rangeLabel())}</span></div>
      <div class="wstats">
        ${wstat('Sessions', fmtNum(g.sessions))}
        ${wstat('Users', fmtNum(g.users))}
        ${wstat('New users', fmtNum(g.newUsers))}
        ${wstat('Engagement', g.engagementRate + '%')}
        ${wstat('Avg. engaged', g.avgEngagementSec + 's')}
        ${wstat('Bounce rate', g.bounceRate + '%')}
        ${wstat('Conversions', fmtNum(g.conversions))}
        ${wstat('Conv. rate', g.conversionRate + '%')}
      </div>
      ${areaChart(ss.series, { color: '#8a6bf0' })}
    </div>
    <div class="grid col-2-1">
      <div class="widget"><div class="widget-head"><h3>Top landing pages</h3></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Landing page</th><th class="num">Sessions</th><th class="num">Conv. rate</th></tr></thead>
          <tbody>${g.topLandingPages.map((p) => `<tr><td class="kw">${esc(p.path)}</td>
            <td class="num">${fmtNum(p.sessions)}</td><td class="num">${p.convRate}%</td></tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="widget"><div class="widget-head"><h3>Channels</h3></div>
        ${donut(g.channels.map((c) => ({ label: c.channel, value: c.value, color: c.color })))}</div>
    </div>`;
}

// ---------- tab: Business Profile (GBP) ----------
function tabBusiness(d) {
  if (!d.connectors.googleBusinessProfile) return gatedTab('GMB data', 'googleBusinessProfile');
  const b = d.gbp;
  const rv = b.reviews;
  const vs = sliceDaily(b.viewsSeries, b.viewsLabels || []);
  const profile = b.profile ? `
    <div class="widget mb">
      <div class="widget-head"><h3>${svg('business')} ${esc(b.profile.name)} ${sourceBadge('gbp')}</h3>
        ${b.profile.verified ? '<span class="tag">Verified</span>' : ''}</div>
      <div class="wstats" style="margin-bottom:0">
        ${wstat('Category', b.profile.category)}
        ${wstat('Phone', b.profile.phone)}
        ${wstat('Address', b.profile.address)}
        ${wstat('Status', b.profile.hours)}
      </div>
    </div>` : '';

  const reviewsBlock = rv ? `
    <div class="grid col-1-2">
      <div class="widget">
        <div class="widget-head"><h3>Rating</h3></div>
        <div class="rating-big"><b>${rv.avgRating.toFixed(1)}</b><span class="stars">${stars(rv.avgRating)}</span></div>
        <div class="muted small" style="margin:4px 0 14px">${fmtNum(rv.count)} reviews${rv.newThisMonth != null ? ` · ${rv.newThisMonth} new this month` : ''}</div>
        ${hbars(rv.distribution.map((x) => ({ label: x.stars + ' ★', value: x.value, color: ['#16a34a', '#6ba32e', '#e0a53d', '#e0762e', '#e0607a'][5 - x.stars] })))}
        ${rv.responseRate != null ? `<div class="muted small" style="margin-top:12px">Owner response rate: <b>${rv.responseRate}%</b></div>` : ''}
      </div>
      <div class="widget">
        <div class="widget-head"><h3>Recent reviews</h3></div>
        <div class="grid" style="gap:10px">
          ${rv.recent.map((r) => `<div class="review">
            <div class="review-head"><span class="review-author">${esc(r.author)}</span>
              <span><span class="stars">${stars(r.rating)}</span> <span class="muted small">${r.daysAgo}d ago</span></span></div>
            <div class="review-text">${esc(r.text)}</div></div>`).join('')}
        </div>
      </div>
    </div>` : '';

  return `
    ${profile}
    <div class="kpi-strip">
      ${kpiCard('Total reach', fmtNum(b.reach.total), 'search + maps views')}
      ${kpiCard('On Search', fmtNum(b.reach.search))}
      ${kpiCard('On Maps', fmtNum(b.reach.maps))}
      ${kpiCard('Mobile', fmtNum(b.reach.mobile))}
      ${kpiCard('Customer actions', fmtNum(b.actions.total), 'calls, directions, clicks')}
    </div>
    <div class="grid col-2-1 mb">
      <div class="widget"><div class="widget-head"><h3>Profile views</h3><span class="src-badge">${esc(rangeLabel())}</span></div>
        ${areaChart(vs.series, { color: '#41c789', labels: vs.labels })}</div>
      <div class="widget"><div class="widget-head"><h3>Views breakdown</h3></div>
        ${donut(b.viewsBreakdown)}</div>
    </div>
    <div class="grid col-2-1 mb">
      <div class="widget"><div class="widget-head"><h3>Customer actions</h3></div>
        ${hbars(b.actionsBreakdown)}</div>
      <div class="widget"><div class="widget-head"><h3>Action totals</h3></div>
        <div class="wstats" style="grid-template-columns:1fr 1fr">
          ${wstat('Website clicks', fmtNum(b.actions.website))}
          ${wstat('Directions', fmtNum(b.actions.directions))}
          ${wstat('Calls', fmtNum(b.actions.calls))}
          ${wstat('Messages', fmtNum(b.actions.messages))}
          ${wstat('Bookings', fmtNum(b.actions.bookings))}
          ${b.photos ? wstat('Photo views', fmtNum(b.photos.customerViews)) : ''}
        </div>
      </div>
    </div>
    ${reviewsBlock}`;
}

// ---------- tab: Performance (CrUX + Lighthouse) ----------
function tabPerformance(d) {
  const cx = d.crux;
  const m = cx.metrics;
  const lh = sliceMonthly(cx.lcpHistory || [], cx.lcpLabels || []);
  const cwvCard = (mm) => {
    if (!mm) return '';
    const pctPos = mm.ms != null && mm.poor ? Math.min(100, (mm.ms / (mm.poor * 1.25)) * 100) : 50;
    const color = mm.rating === 'good' ? 'var(--good)' : mm.rating === 'poor' ? 'var(--poor)' : mm.rating === 'needs-improvement' ? 'var(--ni)' : 'var(--muted)';
    return `<div class="cwv-card">
      <span class="rating-tag rating-${mm.rating}">${ratingLabel(mm.rating)}</span>
      <div class="cwv-name">${esc(mm.label)}</div>
      <div class="cwv-val">${esc(mm.value)}</div>
      <div class="cwv-bar"><i style="width:${pctPos.toFixed(0)}%;background:${color}"></i></div>
    </div>`;
  };
  return `
    <div class="widget mb">
      <div class="widget-head"><h3>${svg('gauge')} Core Web Vitals ${sourceBadge('crux')}</h3><span class="src-badge">${esc(cx.collectionPeriod)}</span></div>
      <div class="assess">
        ${gauge(cx.passRate || 0)}
        <div>
          <div style="font-size:15px;font-weight:600">${(cx.passRate || 0) >= 75 ? 'Passing' : 'Needs attention'}</div>
          <div class="muted small">${Math.round(cx.passRate || 0)}% of real-user visits meet the Core Web Vitals thresholds (LCP, INP, CLS).</div>
        </div>
      </div>
      <div class="cwv-grid">
        ${cwvCard(m.lcp)}${cwvCard(m.inp)}${cwvCard(m.cls)}${cwvCard(m.fcp)}${cwvCard(m.ttfb)}
      </div>
    </div>
    ${cx.formFactorSplit ? `<div class="grid col-2-1">
      <div class="widget"><div class="widget-head"><h3>LCP trend</h3><span class="src-badge">${esc(rangeLabel())}</span></div>
        ${lh.series.length ? areaChart(lh.series, { color: '#e0a53d', labels: lh.labels }) : '<p class="muted small">No historical field data.</p>'}</div>
      <div class="widget"><div class="widget-head"><h3>Visits by device</h3></div>
        ${donut(cx.formFactorSplit.map((x) => ({ label: x.device, value: x.share, color: x.color })))}</div>
    </div>` : ''}`;
}

// ---------- tab: Off-page (Ahrefs / SEMrush) ----------
function tabOffpage(d) {
  const bl = d.backlinksProfile;
  const backlinks = d.connectors.ahrefs ? `
    <div class="wstats">
      ${wstat('Backlinks', fmtNum(bl.total))}
      ${wstat('Ref. domains', fmtNum(bl.referringDomains))}
      ${wstat('Domain Rating', bl.domainRating)}
      ${wstat('New / Lost', `<span class="up">+${fmtNum(bl.newThisMonth)}</span> / <span class="down">−${fmtNum(bl.lostThisMonth)}</span>`)}
    </div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Referring domain</th><th class="num">DR</th><th class="num">Backlinks</th></tr></thead>
      <tbody>${bl.topReferring.map((t) => `<tr><td class="kw">${esc(t.domain)}</td><td class="num">${t.dr}</td><td class="num">${fmtNum(t.backlinks)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="grid grid-2" style="margin-top:14px">
      <div><div class="src-badge" style="margin-bottom:8px;display:inline-block">Anchor text</div>${hbars(d.anchorText)}</div>
      <div><div class="src-badge" style="margin-bottom:8px;display:inline-block">Link types</div>${hbars(d.linkTypes)}</div>
    </div>` : gatedInner('Ahrefs', 'ahrefs', 'link');

  const competitors = d.connectors.semrush ? `
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Competitor</th><th class="num">DA</th><th class="num">Common KW</th><th class="num">Est. traffic</th><th class="num">Overlap</th></tr></thead>
      <tbody>${d.competitors.map((c) => `<tr><td class="kw">${esc(c.domain)}</td><td class="num">${c.domainAuthority}</td>
        <td class="num">${fmtNum(c.commonKeywords)}</td><td class="num">${fmtNum(c.estTraffic)}</td><td class="num">${c.overlapPct}%</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="src-badge" style="margin:14px 0 8px;display:inline-block">SERP features owned</div>
    ${hbars(d.serpFeatures.map((f) => ({ label: f.feature, value: f.count })))}` : gatedInner('SEMrush', 'semrush', 'traffic');

  return `
    <div class="grid grid-2">
      <div class="widget"><div class="widget-head"><h3>${svg('link')} Backlink profile</h3><span class="src-badge">Ahrefs</span></div>${backlinks}</div>
      <div class="widget"><div class="widget-head"><h3>${svg('traffic')} Competitors</h3><span class="src-badge">SEMrush</span></div>${competitors}</div>
    </div>`;
}

// ---------- gated helpers ----------
function gatedTab(service, key) {
  const control = isAdmin()
    ? `<label class="switch" style="margin:12px auto 0"><input type="checkbox" data-connector="${key}"><span class="track"></span><span class="knob"></span></label>
       <p class="small" style="margin-top:10px">Enable it to load ${esc(service)} data.</p>`
    : `<p class="small" style="margin-top:10px">This section isn't enabled for your report yet.</p>`;
  return `<div class="widget"><div class="empty">
    <p><b>${esc(service)}</b> is turned off for this client.</p>
    ${control}
  </div></div>`;
}
function gatedInner(service, key, iconName) {
  return `<div class="empty">
    <span class="conn-ic" style="margin:0 auto 10px">${svg(iconName, 'ic')}</span>
    <p>${isAdmin() ? `Connect <b>${esc(service)}</b> to unlock this data.` : `<b>${esc(service)}</b> data isn't enabled for your report.`}</p>
    ${isAdmin() ? `<label class="switch" style="margin:12px auto 0"><input type="checkbox" data-connector="${key}"><span class="track"></span><span class="knob"></span></label>` : ''}
  </div>`;
}

// ---------- Google connect modal ----------
function openGoogleModal() {
  const g = state.currentClient.google || {};
  $('#g-gsc').value = g.gscSiteUrl || '';
  $('#g-ga4').value = g.ga4PropertyId || '';
  $('#g-gbp').value = g.gbpLocationId || '';
  $('#g-gbp-acct').value = g.gbpAccountId || '';
  $('#google-ok').textContent = '';
  $('#modal-root').classList.remove('hidden');
}
function closeModal() { $('#modal-root').classList.add('hidden'); }
$('#modal-root').addEventListener('click', (e) => { if (e.target.closest('[data-close-modal]')) closeModal(); });
$('#google-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/clients/' + state.currentClientId + '/google', {
      method: 'PUT',
      body: JSON.stringify({
        gscSiteUrl: $('#g-gsc').value, ga4PropertyId: $('#g-ga4').value,
        gbpLocationId: $('#g-gbp').value, gbpAccountId: $('#g-gbp-acct').value,
      }),
    });
    $('#google-ok').textContent = 'Saved. Reloading live data…';
    const { client, data } = await api('/api/dashboard/' + state.currentClientId);
    state.currentClient = client; state.currentData = data;
    setTimeout(() => { closeModal(); renderReport(); }, 500);
  } catch (err) { $('#google-ok').textContent = err.message; }
});

// =====================================================================
// chart primitives
// =====================================================================
function areaChart(series, { w = 720, h = 200, color = '#5b8def', labels = [] } = {}) {
  if (!series || !series.length) return '<p class="muted small">No data.</p>';
  const pad = 6;
  const max = Math.max(...series), min = Math.min(...series, 0);
  const stepX = (w - pad * 2) / Math.max(1, series.length - 1);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
  const pts = series.map((v, i) => [pad + i * stepX, y(v)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${line} L ${(pad + (series.length - 1) * stepX).toFixed(1)} ${h - pad} L ${pad} ${h - pad} Z`;
  const id = 'g' + Math.random().toString(36).slice(2, 7);
  // Thin a dense label set (e.g. 90 daily dates) down to ~8 evenly spaced,
  // keeping the first and last, so the axis row stays readable and never
  // overflows its container.
  let axisLabels = labels;
  if (labels.length > 8) {
    const step = (labels.length - 1) / 7;
    axisLabels = Array.from({ length: 8 }, (_, i) => labels[Math.round(i * step)]);
  }
  const lbls = axisLabels.length ? `<div class="chart-x">${axisLabels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>` : '';
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.25" vector-effect="non-scaling-stroke"/>
  </svg>${lbls}`;
}
function sparkline(series) {
  if (!series || !series.length) return '';
  const w = 84, h = 26, pad = 2;
  const max = Math.max(...series), min = Math.min(...series);
  const stepX = (w - pad * 2) / Math.max(1, series.length - 1);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
  const line = series.map((v, i) => (i ? 'L' : 'M') + (pad + i * stepX).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  const up = series[series.length - 1] >= series[0];
  const color = up ? 'var(--green)' : 'var(--red)';
  return `<svg viewBox="0 0 ${w} ${h}" style="width:${w}px;height:${h}px;vertical-align:middle"><path d="${line}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
}
function donut(segments) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const R = 54, C = 2 * Math.PI * R;
  let off = 0;
  const rings = segments.map((s) => {
    const len = (s.value / total) * C;
    const el = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${s.color}" stroke-width="16"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"/>`;
    off += len; return el;
  }).join('');
  const legend = segments.map((s) => `<div class="lg"><span class="dot" style="background:${s.color}"></span>${esc(s.label)}
    <b>${Math.round((s.value / total) * 100)}%</b></div>`).join('');
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" class="donut">${rings}</svg><div class="legend">${legend}</div></div>`;
}
function hbars(items) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<div class="hbars">${items.map((i) => `<div class="hbar-row">
    <span class="hbar-lbl">${esc(i.label)}</span>
    <div class="hbar-track"><div class="hbar-fill" style="width:${((i.value / max) * 100).toFixed(1)}%;background:${i.color || 'var(--brand)'}"></div></div>
    <span class="hbar-val">${fmtNum(i.value)}</span></div>`).join('')}</div>`;
}
function gauge(pct) {
  const R = 34, C = Math.PI * R; // half circle
  const val = Math.max(0, Math.min(100, pct));
  const color = val >= 75 ? 'var(--good)' : val >= 50 ? 'var(--ni)' : 'var(--poor)';
  const dash = (val / 100) * C;
  return `<svg viewBox="0 0 84 84" class="gauge">
    <circle cx="42" cy="42" r="${R}" fill="none" stroke="var(--surface-2)" stroke-width="8"
      stroke-dasharray="${C} ${C}" transform="rotate(-90 42 42)"/>
    <circle cx="42" cy="42" r="${R}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${(C - dash).toFixed(1)}" transform="rotate(-90 42 42)"/>
    <text x="42" y="47" text-anchor="middle" font-size="18" font-weight="700" fill="var(--text)">${Math.round(val)}%</text>
  </svg>`;
}

// ---------- KPI helper with delta ----------
function kpiDelta(label, o) {
  const dc = o.changePct || 0;
  const up = o.invert ? dc < 0 : dc > 0;
  const val = (o.prefix || '') + fmtNum(o.value) + (o.suffix || '');
  // Only render a change chip when there's an actual delta; otherwise just the unit label.
  const foot = dc === 0
    ? `<span class="muted">${esc(o.unit || '')}</span>`
    : `<span class="delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(dc)}%</span><span class="muted">${esc(o.unit || '')}</span>`;
  return `<div class="kpi"><div class="kpi-label">${esc(label)}</div>
    <div class="kpi-val">${val}</div>
    <div class="kpi-foot">${foot}</div>
  </div>`;
}
function wstat(label, val) { return `<div class="wstat"><div class="wstat-l">${esc(label)}</div><div class="wstat-v">${val}</div></div>`; }

// ---------- utils ----------
function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
function fmtScore(s) { if (s == null) return '—'; return `<span style="color:${scoreColor(s)}">${s}</span>`; }
function scoreColor(s) { if (s == null) return 'var(--muted)'; if (s >= 80) return 'var(--green)'; if (s >= 50) return 'var(--amber)'; return 'var(--red)'; }
function ratingLabel(r) { return r === 'needs-improvement' ? 'Improve' : r === 'no-data' ? 'No data' : r.charAt(0).toUpperCase() + r.slice(1); }
function stars(rating) {
  const full = Math.round(rating);
  return Array.from({ length: 5 }).map((_, i) => i < full ? '★' : '<span class="off">★</span>').join('');
}
function initials(name) { return String(name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join(''); }
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

// ---------- boot ----------
if (state.token) enterApp();
else $('#login-view').classList.remove('hidden');
