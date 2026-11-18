// Stop catalog: every line's branches (route + ordered stops) and stop names, kept server-side
// in data/catalog.json (gitignored, never served). Powers search, the line page and the map
// without per-view upstream calls. Filled three ways:
//   - the background job (paced, weekly),
//   - lazily, when someone opens a line not in the catalog yet,
//   - passively, from street names in every `cercanas` answer the proxy relays.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const WEEK = 7 * 24 * 3600_000;
const DAY = 24 * 3600_000;

export const lineLabel = s => String(s ?? '').replace(/^LINEA\s+/i, '').trim();
const round = n => Math.round(n * 1e5) / 1e5;

export function meters(a, b) { // haversine; points are [lat, lng]
  const r = x => x * Math.PI / 180, R = 6371e3;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Upstream lists a branch's stops mostly in order, with a few out of place.
// Sort them by the closest point of the branch's route path instead.
// ponytail: nearest-vertex, O(stops × points); project onto segments if vertices get sparse.
export function orderAlong(path, stops) {
  if (!path.length) return stops;
  const at = s => {
    let best = 0, bestD = Infinity;
    path.forEach((p, i) => { const d = meters(p, [s.lat, s.lng]); if (d < bestD) { bestD = d; best = i; } });
    return best;
  };
  return stops.map(s => [at(s), s]).sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}

// Raw `recorridos` (≈2 MB per line) → slim branches + stop coordinates.
export function parseRecorridos(raw) {
  const stops = {};
  const branches = raw.map(b => {
    const path = (b.puntos ?? []).map(p => [round(+p.latitud), round(+p.longitud)]).filter(p => p[0] && p[1]);
    const own = (b.paradas ?? []).filter(p => p.identificador && p.latitudParada).map(p => ({
      id: p.identificador, lat: round(+p.latitudParada), lng: round(+p.longitudParada),
    }));
    own.forEach(s => { stops[s.id] = { lat: s.lat, lng: s.lng }; });
    return {
      name: b.abreviaturaBanderaSMP, // equals an arrival's `descripcionBandera`
      short: String(b.descripcion ?? '').split(';')[1]?.trim() || b.abreviaturaBanderaSMP,
      path,
      stops: [...new Set(orderAlong(path, own).map(s => s.id))],
    };
  }).filter(b => b.stops.length);
  return { branches, stops };
}

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\bav(da)?\b\.?/g, 'avenida').replace(/\bdiag\b\.?/g, 'diagonal').replace(/[^a-z0-9ñ ]+/g, ' ').trim();
const tokens = s => norm(s).split(/\s+/).filter(Boolean);
// Every query token must match a name token: numbers exactly ("18" ≠ "180"), words by prefix.
const matches = (qt, name) => {
  const nt = tokens(name);
  return qt.every(q => nt.some(t => /^\d+$/.test(q) ? t === q : t.startsWith(q)));
};
const streetsOf = name => String(name ?? '').split(/\s+y\s+/i).map(s => s.trim()).filter(Boolean);
// "calle 54" must match a stop on CALLE 54, not "CALLE 10 y AVENIDA 54".
// A query with "y" ("calle 5 y avenida 54") may match across both streets of the corner.
const stopMatches = (qt, name) => streetsOf(name).some(st => matches(qt, st))
  || (qt.includes('y') && qt.length > 1 && matches(qt.filter(t => t !== 'y'), name));
const compact = s => String(s ?? '').replace(/\s+/g, '').toUpperCase(); // "LP 10273" == "LP10273"
// Only letters+digits ("LP10", "lp 102") or a long number look like a stop code; "5" shouldn't match LP10350.
const looksLikeCode = c => /^[A-Z]{2,3}\d*$/.test(c) || /^\d{4,}$/.test(c);

export function emptyCatalog() {
  return { v: 1, lines: {}, stops: {}, builtAt: 0, namesAt: 0 };
}

// cercanas rows → names (and line lists) on the stops we know; adds stops we don't.
export function mergeNames(cat, rows) {
  let added = 0;
  for (const p of rows ?? []) {
    if (!p.identificador) continue;
    const name = [p.callePrincipal, p.calleInterseccion].filter(Boolean).join(' y ');
    const s = cat.stops[p.identificador] ??= { lat: round(+p.latitud), lng: round(+p.longitud) };
    if (name && s.name !== name) { s.name = name; added++; }
    if (p.lineas) s.lineas = String(p.lineas).replace(/^L[íi]neas:\s*/i, '').split(',').map(x => lineLabel(x)).filter(Boolean);
  }
  return added;
}

const stopOut = (cat, id) => ({ id, ...cat.stops[id] });

export function search(cat, q, here) {
  const qt = tokens(q);
  if (!qt.length) return { paradas: [], totalParadas: 0, lineas: [], calles: [] };
  const code = compact(q);
  const byCode = looksLikeCode(code);
  const dist = s => here && s.lat ? meters(here, [s.lat, s.lng]) : Infinity;
  const exact = s => compact(s.id) === code;

  const all = Object.keys(cat.stops)
    .filter(id => (byCode && compact(id).includes(code)) || (cat.stops[id].name && stopMatches(qt, cat.stops[id].name)))
    .map(id => stopOut(cat, id))
    .sort((a, b) => exact(b) - exact(a) || dist(a) - dist(b) || String(a.name).localeCompare(b.name));
  const paradas = all.slice(0, 20);

  const lineas = Object.entries(cat.lines)
    .filter(([, l]) => norm(l.label).startsWith(norm(q)) || matches(qt, l.label))
    .map(([codigo, l]) => ({ codigo, label: l.label, ramales: l.branches?.length ?? 0 }))
    .slice(0, 10);

  const streets = new Map(); // street name → stop count
  for (const s of Object.values(cat.stops)) {
    for (const st of streetsOf(s.name)) if (matches(qt, st)) streets.set(st, (streets.get(st) ?? 0) + 1);
  }
  const calles = [...streets].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([nombre, paradas]) => ({ nombre, paradas }));
  return { paradas, totalParadas: all.length, lineas, calles };
}

// Stops on one street; `esquina` is the other street of each corner.
export function onStreet(cat, nombre) {
  const key = norm(nombre);
  return Object.keys(cat.stops)
    .filter(id => streetsOf(cat.stops[id].name).some(st => norm(st) === key))
    .map(id => ({ ...stopOut(cat, id), esquina: streetsOf(cat.stops[id].name).find(st => norm(st) !== key) ?? '' }))
    .sort((a, b) => a.esquina.localeCompare(b.esquina, 'es', { numeric: true }));
}

export function inBox(cat, { s, w, n, e }, limit = 400) {
  const out = [];
  for (const [id, p] of Object.entries(cat.stops)) {
    if (p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e) out.push({ id, ...p });
    if (out.length >= limit) break;
  }
  return out;
}

export function lineView(cat, codigo) {
  const l = cat.lines[codigo];
  if (!l?.branches) return null;
  return {
    codigo, label: l.label,
    ramales: l.branches.map(b => ({ name: b.name, short: b.short, path: b.path, paradas: b.stops.map(id => stopOut(cat, id)) })),
  };
}

// Stateful store + paced job. `call(name, params)` goes through the proxy's cache and breaker.
export function createCatalog({ file, call, pace = 30_000, log = () => {} }) {
  let cat = emptyCatalog(), running = false, dirty = false;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const store = {
    get data() { return cat; },
    async load() {
      try { cat = { ...emptyCatalog(), ...JSON.parse(await readFile(file, 'utf8')) }; } catch {}
      return store;
    },
    async save() {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(cat));
      await rename(`${file}.tmp`, file); // atomic: a crash never leaves half a file
      dirty = false;
    },
    harvest(rows) { if (mergeNames(cat, rows)) dirty = true; },
    async flush() { if (dirty) await store.save(); },
    setLines(lineas) {
      for (const l of lineas) (cat.lines[l.codigo] ??= {}).label = lineLabel(l.descripcion);
    },
    async fetchLine(codigo) {
      const { branches, stops } = parseRecorridos(await call('recorridos', { codLinea: codigo }));
      for (const [id, s] of Object.entries(stops)) cat.stops[id] = { ...cat.stops[id], ...s };
      Object.assign(cat.lines[codigo] ??= {}, { branches, at: Date.now() });
      dirty = true;
    },
    due(now = Date.now()) {
      const lines = Object.values(cat.lines);
      if (!lines.length || lines.some(l => !l.at || now - l.at > WEEK)) return true;
      // Some stops never get a name upstream; retry those at most daily.
      return now - cat.namesAt > DAY && Object.values(cat.stops).some(s => !s.name);
    },
    // One paced pass: refresh lines older than a week, then name stops that still lack one.
    // Stops when upstream pauses us (503: rate limit, block); the next scheduled pass resumes.
    // Any other error skips that one item, so a single bad line or stop can't stall the catalog.
    async run() {
      if (running) return;
      running = true;
      const skip = (err, what) => { if (err.status === 503) throw err; log(`catalog: skipped ${what} (${err.message})`); };
      try {
        store.setLines(await call('lineas'));
        for (const [codigo, l] of Object.entries(cat.lines)) {
          if (l.at && Date.now() - l.at < WEEK) continue;
          await sleep(pace);
          try {
            await store.fetchLine(codigo);
            log(`catalog: line ${l.label} ok`);
          } catch (err) { skip(err, `line ${l.label}`); l.at = Date.now(); } // retried next week, or lazily on view
          await store.save();
        }
        cat.builtAt = Date.now();
        for (;;) {
          const id = Object.keys(cat.stops).find(k => !cat.stops[k].name && !cat.stops[k].tried);
          if (!id) break;
          await sleep(pace);
          const s = cat.stops[id];
          try { store.harvest(await call('cercanas', { lat: s.lat, lng: s.lng })); }
          catch (err) { skip(err, `stop ${id}`); }
          if (!s.name) s.tried = true; // upstream has no name for it; don't ask again this pass
          await store.flush();
        }
        cat.namesAt = Date.now();
        Object.values(cat.stops).forEach(s => delete s.tried);
        await store.save();
        log('catalog: pass complete');
      } catch (err) {
        log(`catalog: paused (${err.message})`);
        await store.flush();
      } finally { running = false; }
    },
    // Check hourly; run when something is due. Restarts don't rebuild a fresh catalog.
    schedule(every = 3600_000) {
      const tick = () => { if (store.due()) store.run(); };
      setTimeout(tick, 60_000);
      return setInterval(tick, every);
    },
  };
  return store;
}
