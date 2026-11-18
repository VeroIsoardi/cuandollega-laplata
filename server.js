// Proxy for SmartMove "Cuando Llega" (Unión Platense) + static frontend.
// Zero dependencies: node server.js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const BASE = 'https://cuandollega.smartmovepro.net/unionplatense';
const PORT = process.env.PORT || 3000;
const STALE_MAX = 30 * 60_000; // serve last good answer up to 30 min on upstream errors
const SESSION_TTL = 10 * 60_000;

// Allowed routes: upstream page, query params passed through, optional JSON body builder, freshness.
const ROUTES = {
  lineas:          { page: 'lineas', params: [], ttl: 24 * 3600_000 },
  calles:          { page: 'calles/', params: ['codLinea'], ttl: 24 * 3600_000 },
  intersecciones:  { page: 'intersecciones/', params: ['codLinea', 'codCalle'], ttl: 24 * 3600_000 },
  paradas:         { page: 'paradas/', params: ['codLinea', 'codCalle', 'codInterseccion'], ttl: 24 * 3600_000 },
  arribos:         { page: 'arribos/', params: ['codLinea', 'idParada'], ttl: 15_000 },
  cercanas:        { page: 'paradascercanas', params: [], ttl: 5 * 60_000,
                     body: q => ({ latitud: parseFloat(q.get('lat')), longitud: parseFloat(q.get('lng')) }) },
  recorridos:      { page: 'recorridos', params: [], query: '?handler=RecuperarRecorridos', ttl: 24 * 3600_000,
                     body: q => ({ codigoLinea: String(q.get('codLinea')) }) },
};

let session = null; // { cookie, token, at }

async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < SESSION_TTL) return session;
  const res = await fetch(`${BASE}/lineas`, { signal: AbortSignal.timeout(10_000) });
  const html = await res.text();
  const token = html.match(/name="CSRF-TOKEN-CL-FORM"[^>]*value="([^"]+)"/)?.[1];
  if (!token) throw new Error('no CSRF token in upstream HTML');
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return (session = { cookie, token, at: Date.now() });
}

async function upstream(url, body, retry = true) {
  const s = await getSession();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Cookie: s.cookie, RequestVerificationToken: s.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : '', // empty body required, else 411
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (res.status === 400 && retry && !text.includes('inexistente')) { // likely expired token
    await getSession(true);
    return upstream(url, body, false);
  }
  if (!res.ok) throw Object.assign(new Error(text.slice(0, 200)), { status: res.status });
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('upstream returned non-JSON'), { status: 502 }); }
}

// ponytail: in-memory cache, unbounded keys; fine for one city, add LRU/eviction if memory grows.
const cache = new Map(); // key -> { at, data }

async function cached(key, ttl, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  try {
    const data = await fetcher();
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    if (hit && Date.now() - hit.at < Math.max(ttl, STALE_MAX) && err.status !== 400) return hit.data;
    throw err;
  }
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = url.pathname.match(/^\/api\/(\w+)$/)?.[1];

  if (!name) {
    if (url.pathname !== '/') return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, await readFile(new URL('./index.html', import.meta.url)), 'text/html; charset=utf-8');
  }

  const route = ROUTES[name];
  if (!route) return send(res, 404, { error: 'unknown endpoint' });

  const q = url.searchParams;
  const qs = new URLSearchParams(route.params.map(p => [p, q.get(p) ?? '']));
  const target = `${BASE}/${route.page}${route.query ?? (route.params.length ? `?${qs}` : '')}`;
  const body = route.body?.(q);
  if (body && Object.values(body).some(v => v === '' || Number.isNaN(v))) {
    return send(res, 400, { error: 'missing params' });
  }

  try {
    send(res, 200, await cached(target + JSON.stringify(body ?? ''), route.ttl, () => upstream(target, body)));
  } catch (err) {
    send(res, err.status === 400 ? 400 : 502, { error: err.message });
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
