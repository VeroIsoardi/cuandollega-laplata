import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRecorridos, search, onStreet, inBox, mergeNames, emptyCatalog, createCatalog } from '../catalog.js';

// A branch running north along one street; upstream lists stop C before B.
const recorridos = [{
  abreviaturaBanderaSMP: '[A1] CENTRO A NORTE',
  descripcion: '170;A1-IDA;[A1] CENTRO A NORTE',
  puntos: [0, 1, 2, 3].map(i => ({ latitud: -34.93 + i * 0.003, longitud: -57.95 })),
  paradas: [
    { identificador: 'LP1', latitudParada: '-34.93', longitudParada: '-57.95' },
    { identificador: 'LP3', latitudParada: '-34.921', longitudParada: '-57.95' },
    { identificador: 'LP2', latitudParada: '-34.927', longitudParada: '-57.95' },
  ],
}];

const row = (id, a, b, lat = -34.92, lng = -57.95, lineas = '') =>
  ({ identificador: id, callePrincipal: a, calleInterseccion: b, latitud: String(lat), longitud: String(lng), lineas });

function sample() {
  const cat = emptyCatalog();
  cat.lines = { 281: { label: '273', branches: [] }, 283: { label: '518', branches: [] }, 288: { label: 'SUR 10', branches: [] } };
  mergeNames(cat, [
    row('LP10', 'CALLE 18', 'AVENIDA 60', -34.93, -57.96, 'Líneas: LINEA SUR 10'),
    row('LP11', 'CALLE 18', 'DIAGONAL 74', -34.92, -57.95),
    row('LP12', 'CALLE 180', 'CALLE 7', -34.80, -57.90),
    row('LP13', 'AVENIDA 13', 'CALLE 54', -34.922, -57.953),
  ]);
  return cat;
}

test('orders branch stops along the route, not in upstream order', () => {
  const { branches, stops } = parseRecorridos(recorridos);
  assert.deepEqual(branches[0].stops, ['LP1', 'LP2', 'LP3']);
  assert.equal(branches[0].name, '[A1] CENTRO A NORTE');
  assert.equal(branches[0].short, 'A1-IDA');
  assert.deepEqual(stops.LP3, { lat: -34.921, lng: -57.95 });
});

test('search matches street numbers exactly and abbreviations', () => {
  const cat = sample();
  const r = search(cat, 'calle 18');
  assert.deepEqual(r.paradas.map(p => p.id).sort(), ['LP10', 'LP11']); // not "CALLE 180"
  assert.deepEqual(r.calles, [{ nombre: 'CALLE 18', paradas: 2 }]);
  assert.deepEqual(search(cat, 'av 13').paradas.map(p => p.id), ['LP13']);
  assert.deepEqual(search(cat, 'diag 74').paradas.map(p => p.id), ['LP11']);
});

test('search finds stops by code and lines by label, nearest first', () => {
  const cat = sample();
  assert.equal(search(cat, 'lp13').paradas[0].id, 'LP13');
  assert.deepEqual(search(cat, '27').lineas, [{ codigo: '281', label: '273', ramales: 0 }]);
  assert.deepEqual(search(cat, 'sur').lineas.map(l => l.label), ['SUR 10']);
  const near = search(cat, 'calle 18', [-34.93, -57.96]).paradas;
  assert.equal(near[0].id, 'LP10');
});

test('lists the corners of one street', () => {
  const corners = onStreet(sample(), 'Calle 18').map(s => [s.id, s.esquina]);
  assert.deepEqual(corners, [['LP10', 'AVENIDA 60'], ['LP11', 'DIAGONAL 74']]);
});

test('returns stops inside a map box', () => {
  const ids = inBox(sample(), { s: -34.925, w: -57.96, n: -34.91, e: -57.94 }).map(s => s.id).sort();
  assert.deepEqual(ids, ['LP11', 'LP13']);
});

test('the job fetches lines and names, saves to disk, and is not due afterwards', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cl-')), 'catalog.json');
  const calls = [];
  const call = async (name, params) => {
    calls.push(name);
    if (name === 'lineas') return [{ codigo: 281, descripcion: 'LINEA 273' }];
    if (name === 'recorridos') return recorridos;
    if (name === 'cercanas') return [row('LP1', 'CALLE 1', 'CALLE 50'), row('LP2', 'CALLE 1', 'CALLE 49'), row('LP3', 'CALLE 1', 'CALLE 48')];
  };
  const store = await createCatalog({ file, call, pace: 0 }).load();
  assert.equal(store.due(), true);
  await store.run();
  assert.deepEqual(calls, ['lineas', 'recorridos', 'cercanas']); // one cercanas named all three stops
  assert.equal(store.due(), false);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.stops.LP2.name, 'CALLE 1 y CALLE 49');
  assert.deepEqual(saved.lines[281].branches[0].stops, ['LP1', 'LP2', 'LP3']);
  // A restart reloads it and doesn't start over.
  const again = await createCatalog({ file, call, pace: 0 }).load();
  assert.equal(again.due(), false);
});

test('the job stops at the first upstream error and keeps what it got', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cl-')), 'catalog.json');
  const calls = [];
  const call = async name => {
    calls.push(name);
    if (name === 'lineas') return [{ codigo: 281, descripcion: 'LINEA 273' }, { codigo: 283, descripcion: 'LINEA 518' }];
    if (name === 'recorridos' && calls.filter(c => c === 'recorridos').length === 1) return recorridos;
    throw Object.assign(new Error('pausa'), { status: 503 });
  };
  const store = await createCatalog({ file, call, pace: 0 }).load();
  await store.run();
  assert.deepEqual(calls, ['lineas', 'recorridos', 'recorridos']);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(saved.lines[281].branches.length);
  assert.equal(saved.lines[283].branches, undefined);
  assert.equal(store.due(), true); // next scheduled check resumes
});

test('the job skips a line that fails for a non-pause reason and keeps going', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cl-')), 'catalog.json');
  const call = async (name, params) => {
    if (name === 'lineas') return [{ codigo: 1, descripcion: 'LINEA 1' }, { codigo: 281, descripcion: 'LINEA 273' }];
    if (name === 'recorridos') {
      if (String(params.codLinea) === '1') throw Object.assign(new Error('upstream returned non-JSON'), { status: 502 });
      return recorridos;
    }
    if (name === 'cercanas') return [row('LP1', 'CALLE 1', 'CALLE 50'), row('LP2', 'CALLE 1', 'CALLE 49'), row('LP3', 'CALLE 1', 'CALLE 48')];
  };
  const store = await createCatalog({ file, call, pace: 0 }).load();
  await store.run();
  assert.ok(store.data.lines[281].branches.length);
  assert.equal(store.data.lines[1].branches, undefined);
  assert.equal(store.data.stops.LP1.name, 'CALLE 1 y CALLE 50');
  assert.equal(store.due(), false); // the bad line waits for next week (or a lazy fill when someone opens it)
});

test('stop search matches within one street, codes ignore spaces, short numbers skip codes', () => {
  const cat = sample();
  mergeNames(cat, [row('LP 10273', 'CALLE 1', 'CALLE 60')]);
  assert.deepEqual(search(cat, 'calle 60').paradas.map(p => p.id), ['LP 10273']); // not "CALLE 18 y AVENIDA 60"
  assert.deepEqual(search(cat, 'calle 18 y avenida 60').paradas.map(p => p.id), ['LP10']);
  assert.equal(search(cat, 'lp10273').paradas[0].id, 'LP 10273');
  assert.equal(search(cat, 'LP 10273').paradas[0].id, 'LP 10273');
  assert.deepEqual(search(cat, '1').paradas.map(p => p.id), ['LP 10273']); // CALLE 1, not codes containing 1
});

test('search reports how many stops matched beyond the 20 it returns', () => {
  const cat = emptyCatalog();
  mergeNames(cat, Array.from({ length: 25 }, (_, i) => row(`LP${900 + i}`, 'CALLE 9', `AVENIDA ${50 + i}`)));
  const r = search(cat, 'calle 9');
  assert.equal(r.paradas.length, 20);
  assert.equal(r.totalParadas, 25);
});
