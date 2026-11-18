// Fake SmartMove for browser specs: runs the real server against invented data, never the real upstream.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'https://cuandollega.smartmovepro.net/unionplatense';

// Stops run north-south through the map page's starting view (La Plata center, -57.9545).
// Line 273 (codigo 281): branch A runs north along CALLE 7 (26 stops, more than search's 20-row cap);
// branch B comes back along CALLE 8 and includes a code with a space, as upstream has some.
const stopsA = Array.from({ length: 26 }, (_, i) =>
  ({ id: `LP${100 + i}`, lat: -34.95 + i * 0.002, lng: -57.9545, a: 'CALLE 7', b: `AVENIDA ${40 + i}` }));
const stopsB = [
  ...Array.from({ length: 4 }, (_, i) => ({ id: `LP${200 + i}`, lat: -34.9 - i * 0.004, lng: -57.9555, a: 'CALLE 8', b: `AVENIDA ${65 - i * 2}` })),
  { id: 'LP 300', lat: -34.93, lng: -57.955, a: 'DIAGONAL 74', b: 'CALLE 54' },
];
export const STOPS = [...stopsA, ...stopsB];
const branch = (name, short, stops) => ({
  abreviaturaBanderaSMP: name,
  descripcion: `1;${short};${name}`,
  puntos: stops.map(s => ({ latitud: s.lat, longitud: s.lng })),
  paradas: stops.map(s => ({ identificador: s.id, latitudParada: String(s.lat), longitudParada: String(s.lng) })),
});
const RECORRIDOS = { 281: [branch('[A] CEMENTERIO A CENTRO', 'A-IDA', stopsA), branch('[B] CENTRO A CEMENTERIO', 'B-VUELTA', stopsB)] };
const LINEAS = [[95, 'LINEA 202'], [281, 'LINEA 273'], [290, 'LINEA 273 S/R TOP-4'], [288, 'LINEA SUR 10']]
  .map(([codigo, descripcion]) => ({ codigo, descripcion }));

export const fake = { block: false, calls: [] };

const json = data => new Response(JSON.stringify(data));
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (!url.startsWith(BASE)) return realFetch(url, init);
  if (init.method !== 'POST') return new Response('<input name="CSRF-TOKEN-CL-FORM" value="t">', { headers: { 'set-cookie': 'a=1' } });
  fake.calls.push(url);
  if (fake.block) return new Response('{"error":"Acceso denegado."}', { status: 403 });
  if (url.includes('/lineas')) return json(LINEAS);
  if (url.includes('recorridos')) return json(RECORRIDOS[JSON.parse(init.body).codigoLinea] ?? []);
  if (url.includes('paradascercanas')) {
    const { latitud, longitud } = JSON.parse(init.body);
    return json(STOPS.map(s => [Math.hypot(s.lat - latitud, s.lng - longitud), s]).sort((x, y) => x[0] - y[0]).slice(0, 8)
      .map(([, s]) => ({ identificador: s.id, callePrincipal: s.a, calleInterseccion: s.b,
        latitud: String(s.lat), longitud: String(s.lng), lineas: 'Líneas: LINEA 273, 506' })));
  }
  if (url.includes('arribos')) {
    const s = STOPS.find(x => x.id === new URL(url).searchParams.get('idParada')) ?? STOPS[0];
    const at = { latitudParada: String(s.lat), longitudParada: String(s.lng) };
    return json({ arribos: [
      { descripcionLinea: 'LINEA 273', tiempoRestanteArribo: '4 min. aprox.', descripcionCartelBandera: 'A CENTRO', esAdaptado: true,
        latitud: String(s.lat - 0.004), longitud: String(s.lng + 0.003), ...at },
      { descripcionLinea: '506', tiempoRestanteArribo: 'Arribando', descripcionCartelBandera: 'A ESTACION',
        latitud: String(s.lat - 0.001), longitud: String(s.lng), ...at },
      { descripcionLinea: 'LINEA 273', tiempoRestanteArribo: '27 min Hor. Prog.', descripcionCartelBandera: 'A CENTRO',
        latitud: '', longitud: '', ...at },
    ] });
  }
  return new Response('not faked', { status: 404 });
};

let n = 0;
// A fresh server (own cache, breaker and catalog file). `catalog: true` builds the catalog first.
export async function startApp({ catalog = true } = {}) {
  process.env.CATALOG_FILE = join(mkdtempSync(join(tmpdir(), 'cl-e2e-')), 'catalog.json');
  process.env.UPSTREAM_GAP = '0';
  process.env.CATALOG_PACE = '0';
  const mod = await import(`../../server.js?e2e=${n++}`);
  if (catalog) await mod.catalog.run();
  const server = createServer(mod.handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}
