// Proxy for SmartMove "Cuando Llega" (Unión Platense) + stop catalog + static frontend.
// Zero dependencies: node server.js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCatalog, search, onStreet, inBox, lineView } from './catalog.js';

const BASE = 'https://cuandollega.smartmovepro.net/unionplatense';
const PORT = process.env.PORT || 3000;
const STALE_MAX = 30 * 60_000; // serve last good answer up to 30 min on upstream errors
const SESSION_TTL = 10 * 60_000;
const BLOCK_PAUSE = 10 * 60_000; // after a rate limit or block, make no upstream calls for this long
// Upstream blocked this IP after ~5 back-to-back calls. One call at a time, with a gap.
// ponytail: fixed gap; the real limit is unknown, tune UPSTREAM_GAP if users wait or blocks recur.
const UPSTREAM_GAP = Number(process.env.UPSTREAM_GAP ?? 1000);
const PAUSED = 'Servicio en pausa por límite de consultas. Probá en unos minutos.';

// ~100 m grid, so nearby map pans and GPS jitter share one cache entry.
const coord = v => Math.round(parseFloat(v) * 1000) / 1000;

// Allowed routes: upstream page, query params passed through, optional JSON body builder, freshness.
const ROUTES = {
  lineas:          { page: 'lineas', params: [], ttl: 24 * 3600_000 },
  calles:          { page: 'calles/', params: ['codLinea'], ttl: 24 * 3600_000 },
  intersecciones:  { page: 'intersecciones/', params: ['codLinea', 'codCalle'], ttl: 24 * 3600_000 },
  paradas:         { page: 'paradas/', params: ['codLinea', 'codCalle', 'codInterseccion'], ttl: 24 * 3600_000 },
  arribos:         { page: 'arribos/', params: ['codLinea', 'idParada'], ttl: 15_000 },
  cercanas:        { page: 'paradascercanas', params: [], ttl: 30 * 60_000,
                     body: q => ({ latitud: coord(q.get('lat')), longitud: coord(q.get('lng')) }) },
  recorridos:      { page: 'recorridos', params: [], query: '?handler=RecuperarRecorridos', ttl: 24 * 3600_000,
                     body: q => ({ codigoLinea: String(q.get('codLinea')) }) },
};

let session = null; // { cookie, token, at }
let blockedUntil = 0;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const pause = () => { blockedUntil = Date.now() + BLOCK_PAUSE; };
const looksBlocked = (status, text) => status === 429 || status === 403 || /l[ií]mite de consultas|acceso denegado/i.test(text);

async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return session;
  const res = await fetch(`${BASE}/lineas`, { signal: AbortSignal.timeout(10_000) });
  const html = await res.text();
  const token = html.match(/name="CSRF-TOKEN-CL-FORM"[^>]*value="([^"]+)"/)?.[1];
  if (!token) { // a block page has no form either
    if (looksBlocked(res.status, html)) { pause(); throw httpError(503, PAUSED); }
    throw httpError(502, 'no CSRF token in upstream HTML');
  }
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return (session = { cookie, token, at: Date.now() });
}

async function upstream(url, body, retry = true) {
  // Circuit breaker: one rate limit pauses every route, so cache misses don't keep hitting a blocked upstream.
  if (Date.now() < blockedUntil) throw httpError(503, PAUSED);
  const s = await getSession();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Cookie: s.cookie, RequestVerificationToken: s.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : '', // empty body required, else 411
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (looksBlocked(res.status, text)) {
    pause();
    throw httpError(503, PAUSED);
  }
  // An expired token gets a bare 400 (empty or HTML). A 400 with a message ("Parada inexistente") is a real answer.
  if (res.status === 400 && retry && (!text.trim() || text.trimStart().startsWith('<'))) {
    await getSession(true);
    return upstream(url, body, false);
  }
  // Only a 400 carries a message meant for people ("Parada inexistente"); anything else stays generic.
  if (res.status === 400 && text.trim() && !text.trimStart().startsWith('<')) {
    let msg = text.trim();
    try { msg = JSON.parse(msg).error ?? msg; } catch {}
    throw httpError(400, String(msg).slice(0, 200));
  }
  if (!res.ok) throw httpError(502, 'El servicio de colectivos no responde. Probá en unos minutos.');
  try { return JSON.parse(text); }
  catch { throw httpError(502, 'upstream returned non-JSON'); }
}

let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, UPSTREAM_GAP)));
  return run;
}

// ponytail: in-memory cache, unbounded keys; fine for one city, add LRU/eviction if memory grows.
const cache = new Map(); // key -> { at, data }
const pending = new Map(); // key -> in-flight promise, so concurrent identical requests share one call

async function cached(key, ttl, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if (!pending.has(key)) pending.set(key, fetcher().finally(() => pending.delete(key)));
  try {
    const data = await pending.get(key);
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (hit && Date.now() - hit.at < Math.max(ttl, STALE_MAX) && err.status !== 400) return hit.data;
    throw err;
  }
}

// One upstream route through the cache and breaker. Used by the HTTP handler and the catalog job.
async function fetchRoute(name, params = {}) {
  const route = ROUTES[name];
  const q = new URLSearchParams(params);
  const qs = new URLSearchParams(route.params.map(p => [p, q.get(p) ?? '']));
  const target = `${BASE}/${route.page}${route.query ?? (route.params.length ? `?${qs}` : '')}`;
  const body = route.body?.(q);
  if (body && Object.values(body).some(v => v === '' || v === 'null' || Number.isNaN(v))) throw httpError(400, 'missing params');
  const data = await cached(target + JSON.stringify(body ?? ''), route.ttl, () => serial(() => upstream(target, body)));
  if (name === 'cercanas') catalog.harvest(data); // free street names for the catalog
  return data;
}

const catalog = await createCatalog({
  file: process.env.CATALOG_FILE || fileURLToPath(new URL('./data/catalog.json', import.meta.url)),
  call: fetchRoute,
  pace: Number(process.env.CATALOG_PACE ?? 30_000), // one upstream call per 30 s during the job
  log: m => console.log(m),
}).load();

const ensureLines = async () => {
  if (!Object.keys(catalog.data.lines).length) catalog.setLines(await fetchRoute('lineas'));
};
const num = v => (v === null || v === '' ? NaN : Number(v));

// Endpoints answered from the catalog (plus a lazy upstream fill where noted).
const LOCAL = {
  async buscar(q) {
    try { await ensureLines(); } catch {} // stops and streets still answer while upstream is paused
    const here = [num(q.get('lat')), num(q.get('lng'))];
    return search(catalog.data, q.get('q') ?? '', here.every(Number.isFinite) ? here : null);
  },
  async calle(q) { return onStreet(catalog.data, q.get('nombre') ?? ''); },
  async zona(q) {
    const box = { s: num(q.get('s')), w: num(q.get('w')), n: num(q.get('n')), e: num(q.get('e')) };
    if (!Object.values(box).every(Number.isFinite)) throw httpError(400, 'missing params');
    // Stops harvested from a few nearby searches aren't a map; wait for the first full line pass.
    if (catalog.data.builtAt) return inBox(catalog.data, box);
    // No catalog yet: nearby stops around the box center.
    const rows = await fetchRoute('cercanas', { lat: (box.s + box.n) / 2, lng: (box.w + box.e) / 2 });
    return rows.map(p => ({ id: p.identificador, lat: +p.latitud, lng: +p.longitud,
      name: [p.callePrincipal, p.calleInterseccion].filter(Boolean).join(' y ') }));
  },
  async linea(q) {
    const codigo = q.get('codLinea');
    await ensureLines();
    if (!catalog.data.lines[codigo]) throw httpError(404, 'Línea inexistente');
    if (!lineView(catalog.data, codigo)) { await catalog.fetchLine(codigo); await catalog.flush(); }
    return lineView(catalog.data, codigo);
  },
};

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

// Whitelist: never serve arbitrary files from the repo (server.js, .git, data/, …).
const STATIC = {
  '/':                     ['index.html', 'text/html; charset=utf-8'],
  '/app.js':               ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css':            ['style.css', 'text/css; charset=utf-8'],
  '/sw.js':                ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg':             ['icon.svg', 'image/svg+xml'],
  '/icon-180.png':         ['icon-180.png', 'image/png'],
  '/icon-192.png':         ['icon-192.png', 'image/png'],
  '/icon-512.png':         ['icon-512.png', 'image/png'],
};

export { catalog };

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const name = url.pathname.match(/^\/api\/(\w+)$/)?.[1];

  if (!name) {
    const file = STATIC[url.pathname];
    if (!file) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, await readFile(new URL(`./${file[0]}`, import.meta.url)), file[1]);
  }
  if (!ROUTES[name] && !LOCAL[name]) return send(res, 404, { error: 'unknown endpoint' });

  try {
    send(res, 200, LOCAL[name] ? await LOCAL[name](url.searchParams) : await fetchRoute(name, url.searchParams));
  } catch (err) {
    send(res, [400, 404, 503].includes(err.status) ? err.status : 502, { error: err.message });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer(handler).listen(PORT, () => console.log(`http://localhost:${PORT}`));
  // Off by default while the upstream block is unresolved; CATALOG_JOB=1 turns the background build on.
  if (process.env.CATALOG_JOB === '1') catalog.schedule();
  else console.log('catalog job off (set CATALOG_JOB=1 to enable)');
}
