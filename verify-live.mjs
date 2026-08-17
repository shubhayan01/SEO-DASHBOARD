// Quick live-data check against a running server on PORT (default 5063).
const base = `http://localhost:${process.env.PORT || 5063}`;
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0, 120) }; } };

const login = await j(await fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@agency.com', password: 'admin123' }),
}));
const auth = { Authorization: `Bearer ${login.token}` };
const clients = await j(await fetch(`${base}/api/clients`, { headers: auth }));

const liveGscNames = ['Bravo Protection', 'Alpha Floral', 'Anoka Dental', 'Brooklyn Blvd Dental', 'Dental on First', 'Diesel Components'];
for (const name of liveGscNames) {
  const c = clients.find((x) => x.name === name);
  if (!c) { console.log(`${name}: not found`); continue; }
  const d = await j(await fetch(`${base}/api/dashboard/${c.id}`, { headers: auth }));
  const s = d.data.sources;
  console.log(
    `${name.padEnd(22)} gsc=${s.gsc.padEnd(4)} | clicks30d=${String(d.data.searchConsole.clicks).padStart(6)} ` +
    `impr=${String(d.data.searchConsole.impressions).padStart(7)} | topQuery="${d.data.topQueries[0]?.query || '—'}"` +
    (d.data.sourceErrors.gsc ? ` | ERR: ${d.data.sourceErrors.gsc.slice(0, 60)}` : '')
  );
}
