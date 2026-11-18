// Proxy tests. SmartMove is faked by replacing global fetch; nothing hits the real upstream.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realFetch = globalThis.fetch;
const BASE = 'https://cuandollega.smartmovepro.net/unionplatense';
let n = 0;

// Starts a fresh copy of the server (empty cache and session) against a fake upstream.
// `post(url, init, calls)` answers upstream POSTs; GET /lineas always returns a token page.
async function setup(t, post) {
  const calls = { get: 0, posts: [] };
  let token = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith(BASE)) return realFetch(url, init);
    if (init.method !== 'POST') {
      calls.get++;
      token++;
      return new Response(`<input name="CSRF-TOKEN-CL-FORM" type="hidden" value="tok${token}">`,
        { headers: { 'set-cookie': `sess=c${token}; path=/; httponly` } });
    }
    calls.posts.push({ url: String(url), ...init });
    return post(String(url), init, calls);
  };
  process.env.CATALOG_FILE = join(mkdtempSync(join(tmpdir(), 'cl-')), 'catalog.json');
  process.env.UPSTREAM_GAP = '0';
  const { handler } = await import(`../server.js?fresh=${n++}`);
  const server = createServer(handler).listen(0);
  await new Promise(r => server.once('listening', r));
  t.after(() => { server.close(); globalThis.fetch = realFetch; mock.timers.reset(); });
  const get = path => realFetch(`http://127.0.0.1:${server.address().port}${path}`);
  return { get, calls };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('does the token handshake and proxies arrivals as JSON', async t => {
  const { get, calls } = await setup(t, () => json({ arribos: [{ descripcionLinea: '202' }] }));
  const res = await get('/api/arribos?codLinea=0&idParada=LP10217');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { arribos: [{ descripcionLinea: '202' }] });
  const [p] = calls.posts;
  assert.equal(p.url, `${BASE}/arribos/?codLinea=0&idParada=LP10217`);
  assert.equal(p.headers.Cookie, 'sess=c1');
  assert.equal(p.headers.RequestVerificationToken, 'tok1');
  assert.equal(p.body, ''); // upstream answers 411 without a body
});

test('reuses session and caches arrivals for 15s', async t => {
  mock.timers.enable({ apis: ['Date'] });
  const { get, calls } = await setup(t, () => json({ arribos: [] }));
  await get('/api/arribos?codLinea=0&idParada=LP1');
  await get('/api/arribos?codLinea=0&idParada=LP1');
  assert.equal(calls.posts.length, 1);
  mock.timers.tick(16_000);
  await get('/api/arribos?codLinea=0&idParada=LP1');
  assert.equal(calls.posts.length, 2);
  assert.equal(calls.get, 1);
});

test('serves the last good answer when upstream rate-limits', async t => {
  mock.timers.enable({ apis: ['Date'] });
  let limited = false;
  const { get } = await setup(t, () => limited ? new Response('Too many', { status: 429 }) : json({ arribos: [1] }));
  await get('/api/arribos?codLinea=0&idParada=LP1');
  limited = true;
  mock.timers.tick(60_000);
  const stale = await get('/api/arribos?codLinea=0&idParada=LP1');
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), { arribos: [1] });
  mock.timers.tick(31 * 60_000);
  assert.equal((await get('/api/arribos?codLinea=0&idParada=LP1')).status, 503);
});

test('pauses every route after a rate limit or block, then resumes', async t => {
  mock.timers.enable({ apis: ['Date'] });
  let blocked = true;
  const { get, calls } = await setup(t, () => blocked
    ? new Response('{"error":"Acceso denegado."}', { status: 400 }) : json([]));
  assert.equal((await get('/api/arribos?codLinea=0&idParada=LP1')).status, 503);
  assert.equal(calls.posts.length, 1); // a block is not mistaken for an expired token
  for (const path of ['/api/arribos?codLinea=0&idParada=LP2', '/api/lineas', '/api/calles?codLinea=95']) {
    assert.equal((await get(path)).status, 503, path);
  }
  assert.equal(calls.posts.length, 1); // nothing reached upstream while paused
  blocked = false;
  mock.timers.tick(11 * 60_000);
  assert.equal((await get('/api/lineas')).status, 200);
});

test('renews the token once on a bare 400 and retries', async t => {
  const { get, calls } = await setup(t, (url, init) =>
    init.headers.RequestVerificationToken === 'tok1' ? new Response('', { status: 400 }) : json([]));
  const res = await get('/api/lineas');
  assert.equal(res.status, 200);
  assert.equal(calls.get, 2);
  assert.equal(calls.posts.length, 2);
});

test('passes "Parada inexistente" through as 400 without retrying', async t => {
  const { get, calls } = await setup(t, () => new Response('Parada inexistente', { status: 400 }));
  const res = await get('/api/arribos?codLinea=0&idParada=NOPE');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Parada inexistente' });
  assert.equal(calls.posts.length, 1);
});

test('sends nearby-stops coordinates as a JSON body and rejects missing ones', async t => {
  const { get, calls } = await setup(t, () => json([]));
  assert.equal((await get('/api/cercanas?lat=-34.92')).status, 400);
  assert.equal(calls.posts.length, 0);
  await get('/api/cercanas?lat=-34.92&lng=-57.95');
  assert.deepEqual(JSON.parse(calls.posts[0].body), { latitud: -34.92, longitud: -57.95 });
});

test('rounds nearby-stops coordinates so close positions share one upstream call', async t => {
  const { get, calls } = await setup(t, () => json([]));
  await get('/api/cercanas?lat=-34.92141&lng=-57.95441');
  await get('/api/cercanas?lat=-34.92138&lng=-57.95436');
  assert.equal(calls.posts.length, 1);
  assert.deepEqual(JSON.parse(calls.posts[0].body), { latitud: -34.921, longitud: -57.954 });
});

test('serves only whitelisted static files', async t => {
  const { get } = await setup(t, () => json([]));
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css'],
    ['/sw.js', 'text/javascript'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icon-192.png', 'image/png']]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-type').startsWith(type), path);
  }
  for (const path of ['/server.js', '/catalog.js', '/package.json', '/data/catalog.json', '/api/nope']) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test('a line page fills the catalog once, then searches find its stops without upstream calls', async t => {
  const rec = [{ abreviaturaBanderaSMP: '[A] IDA', descripcion: '1;A IDA;[A] IDA',
    puntos: [{ latitud: -34.92, longitud: -57.95 }, { latitud: -34.91, longitud: -57.95 }],
    paradas: [{ identificador: 'LP7', latitudParada: '-34.915', longitudParada: '-57.95' }] }];
  const { get, calls } = await setup(t, url =>
    url.includes('/lineas') ? json([{ codigo: 281, descripcion: 'LINEA 273' }]) : url.includes('recorridos') ? json(rec) : json([]));
  const first = await (await get('/api/linea?codLinea=281')).json();
  assert.equal(first.label, '273');
  assert.deepEqual(first.ramales[0].paradas.map(p => p.id), ['LP7']);
  const before = calls.posts.length;
  await get('/api/linea?codLinea=281');
  const found = await (await get('/api/buscar?q=lp7')).json();
  assert.equal(found.paradas[0].id, 'LP7');
  assert.equal(calls.posts.length, before);
  assert.equal((await get('/api/linea?codLinea=999')).status, 404);
});

test('the map keeps asking upstream until the catalog is built, even after nearby searches', async t => {
  const { get, calls } = await setup(t, url => url.includes('paradascercanas')
    ? json([{ identificador: 'LP1', callePrincipal: 'CALLE 1', calleInterseccion: 'CALLE 50', latitud: '-34.92', longitud: '-57.95' }])
    : json([]));
  await get('/api/cercanas?lat=-34.92&lng=-57.95');
  const far = await (await get('/api/zona?s=-34.95&w=-57.99&n=-34.94&e=-57.98')).json();
  assert.equal(calls.posts.length, 2); // the box was answered by upstream, not by the one harvested stop
  assert.equal(far[0].id, 'LP1');
});

test('identical concurrent requests share one upstream call', async t => {
  const { get, calls } = await setup(t, () => json({ arribos: [] }));
  await Promise.all([1, 2, 3].map(() => get('/api/arribos?codLinea=0&idParada=LP9')));
  assert.equal(calls.posts.length, 1);
});

test('upstream failures reach users as a generic Spanish message, not raw upstream text', async t => {
  const { get } = await setup(t, () => new Response('<html>Server Error stack trace</html>', { status: 500 }));
  const res = await get('/api/arribos?codLinea=0&idParada=LP1');
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'El servicio de colectivos no responde. Probá en unos minutos.' });
});

test('search still answers from the catalog while upstream is paused', async t => {
  const { get } = await setup(t, () => new Response('{"error":"Acceso denegado."}', { status: 403 }));
  const res = await get('/api/buscar?q=lp10325');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { paradas: [], totalParadas: 0, lineas: [], calles: [] });
});
