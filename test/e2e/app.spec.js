// Browser specs: the real app and server in headless Chromium, against the fake upstream.
// Run: npm run test:e2e   (CHROMIUM_PATH=/path/to/chrome if Playwright's own browser isn't installed)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApp, fake } from './fake-upstream.js';

let browser, app, empty;
const GEO = { permissions: ['geolocation'], geolocation: { latitude: -34.944, longitude: -57.95 } };
const PHONE = { viewport: { width: 390, height: 844 } };
const DESKTOP = { viewport: { width: 1360, height: 820 } };

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  app = await startApp({ catalog: true });
  empty = await startApp({ catalog: false }); // production today: catalog job off
});
after(async () => { await browser?.close(); app?.close(); empty?.close(); });

// New context per spec; fails the spec on any uncaught page error.
async function open(t, { base = app.url, path = '', init, ...opts } = {}) {
  const context = await browser.newContext({ ...PHONE, serviceWorkers: 'block', ...opts });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'page errors'); });
  if (path !== null) await page.goto(base + path);
  return page;
}
const text = (page, sel) => page.locator(sel).innerText();

describe('home and favorites', () => {
  test('nearby stops load with distances when location is allowed', async t => {
    const page = await open(t, GEO);
    await page.waitForSelector('#nearList .row');
    assert.match(await text(page, '#nearList .row >> nth=0'), /\d+ m/);
    assert.equal(await page.getAttribute('#nav [aria-current]', 'data-tab'), '#');
  });

  test('denied location shows a Spanish message', async t => {
    const page = await open(t);
    await page.click('#near');
    await page.waitForSelector('#nearList .err');
    assert.match(await text(page, '#nearList'), /Activá el permiso de ubicación/);
  });

  test('a starred stop shows on home with its next arrivals, and unstarring removes it', async t => {
    const page = await open(t, { path: '#parada=LP105&n=CALLE%207%20y%20AVENIDA%2045' });
    await page.waitForSelector('.arrival');
    await page.click('#star');
    assert.equal(await page.getAttribute('#star', 'aria-pressed'), 'true');
    await page.goto(app.url);
    await page.waitForSelector('#favs .mini .badge');
    assert.match(await text(page, '#favs .card'), /CALLE 7 y AVENIDA 45[\s\S]*273[\s\S]*4 min[\s\S]*Llega/);
    await page.click('#favs .card');
    await page.waitForSelector('.arrival');
    await page.click('#star');
    await page.goto(app.url);
    await page.waitForSelector('#favs .add');
  });

  test('legacy and malformed favorites do not break home', async t => {
    const page = await open(t, { init: () => localStorage.setItem('favs',
      JSON.stringify([{ id: 'LP101', name: ' y ' }, { name: 'sin id' }, null, { id: 'LP102', name: 5 }])) });
    await page.waitForSelector('#favs .card[data-fav]');
    assert.deepEqual(await page.$$eval('#favs .card-head b', e => e.map(x => x.textContent)), ['Parada', 'Parada']);
  });

  test('blocked storage explains why the star does nothing', async t => {
    const page = await open(t, { path: '#parada=LP101', init: () => { Storage.prototype.setItem = () => { throw new Error('blocked'); }; } });
    await page.click('#star');
    assert.match(await text(page, '#favmsg'), /no permite guardar favoritas/);
    assert.equal(await page.getAttribute('#star', 'aria-pressed'), 'false');
  });
});

describe('stop page', () => {
  test('arrivals: live, arriving and scheduled in 24-hour time', async t => {
    const page = await open(t, { path: '#parada=LP105&n=X' });
    await page.waitForSelector('.arrival');
    const cards = await page.$$eval('.arrival', e => e.map(x => x.innerText.replace(/\s+/g, ' ')));
    assert.match(cards[0], /273 A CENTRO En vivo · Adaptado 4 min/);
    assert.match(cards[1], /506 A ESTACION En vivo Llega/);
    assert.match(cards[2], /Programado · \d{2}:\d{2} 27 min/);
    assert.match(await text(page, '#upd'), /Actualizado recién/);
  });

  test('a nameless stop says "Parada <code>" once and saves no fake name', async t => {
    const page = await open(t, { path: '#parada=LP101' });
    assert.equal(await text(page, '.stop-head h1'), 'Parada LP101');
    assert.equal(await page.locator('.stop-head .title .muted').count(), 0);
    await page.click('#star');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.favs)[0].name), '');
  });

  test('line chips filter the list and the bus markers, and keep keyboard focus', async t => {
    const page = await open(t, { path: '#parada=LP105&n=X' });
    await page.waitForSelector('.bus-label');
    assert.equal(await page.locator('.bus-label').count(), 2);
    await page.focus('#chips button[data-line="506"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.arrival').length === 1);
    // Leaflet fades removed tooltips out for ~200 ms before dropping them.
    await page.waitForFunction(() => document.querySelectorAll('.bus-label').length === 1);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.line), '506');
  });

  test('the stop marker sits above bus labels and bus markers are named', async t => {
    const page = await open(t, { path: '#parada=LP105&n=X' });
    await page.waitForSelector('.leaflet-stop-pane path');
    const [stopZ, tooltipZ] = await page.evaluate(() => ['.leaflet-stop-pane', '.leaflet-tooltip-pane']
      .map(s => +getComputedStyle(document.querySelector(s)).zIndex));
    assert.ok(stopZ > tooltipZ);
    assert.match(await page.getAttribute('.leaflet-overlay-pane path[role=button]', 'aria-label'), /^Colectivo 273/);
  });

  test('a failed refresh keeps the last arrivals and says so', async t => {
    const page = await open(t, { path: '#parada=LP105&n=X' });
    await page.waitForSelector('.arrival');
    await page.route('**/api/arribos*', r => r.abort());
    await page.click('#reload');
    await page.waitForSelector('#upd .err');
    assert.equal(await page.locator('.arrival').count(), 3);
    assert.match(await text(page, '#upd'), /No se pudo actualizar/);
  });

  test('a late answer for a stop you left does not break the next page', async t => {
    const page = await open(t, { path: null });
    let first = true;
    await page.route('**/api/arribos*', async r => {
      if (first) { first = false; await new Promise(x => setTimeout(x, 1200)); }
      await r.continue();
    });
    await page.goto(app.url + '#parada=LP101&n=A');
    await page.waitForTimeout(200);
    await page.evaluate(() => { location.hash = '#parada=LP110&n=B'; });
    await page.waitForTimeout(1800);
    assert.equal(await page.locator('.arrival').count(), 3);
    assert.equal(await text(page, '.stop-head h1'), 'B');
  });

  test('polling stops after leaving the stop page', async t => {
    const page = await open(t, { path: null });
    await page.clock.install();
    let calls = 0;
    page.on('request', r => { if (r.url().includes('/api/arribos')) calls++; });
    await page.goto(app.url + '#parada=LP105&n=X');
    await page.waitForSelector('.arrival');
    await page.clock.runFor(31_000);
    await page.waitForTimeout(200);
    assert.equal(calls, 2); // first load + one 30 s poll
    await page.evaluate(() => { location.hash = '#lineas'; });
    await page.clock.runFor(95_000);
    await page.waitForTimeout(200);
    assert.equal(calls, 2);
  });
});

describe('search', () => {
  test('a line query lists lines first; Enter after editing opens the new result', async t => {
    const page = await open(t, { path: '#buscar=273' });
    await page.waitForSelector('#results a');
    assert.equal(await page.textContent('#results h2'), 'Líneas');
    await page.fill('#q', 'sur');
    await page.press('#q', 'Enter');
    await page.waitForURL(/#linea=288/);
  });

  test('Enter right after typing a stop code opens that stop', async t => {
    const page = await open(t, { path: '#buscar' });
    await page.fill('#q', 'lp105');
    await page.press('#q', 'Enter');
    await page.waitForURL(/#parada=LP105/);
  });

  test('typing does not add history entries', async t => {
    const page = await open(t, { path: '' });
    await page.click('a.search');
    await page.waitForSelector('#q');
    await page.type('#q', 'calle 7', { delay: 30 });
    await page.waitForSelector('#results a');
    await page.goBack();
    await page.waitForSelector('#favs');
  });

  test('streets: matches stay within one street, list corners, and say when results are capped', async t => {
    const page = await open(t, { path: '#buscar=calle 7' });
    await page.waitForSelector('#results .more');
    assert.equal(await page.textContent('#results h2'), 'Calles');
    assert.match(await text(page, '#results .more'), /Mostrando 20 de 26/);
    await page.click('#results a[href^="#calle="]');
    await page.waitForSelector('#list .row');
    assert.equal(await page.locator('#list .row').count(), 26);
    assert.match(await text(page, '#list .row >> nth=0'), /^y AVENIDA 40/);

    await page.goto(app.url + '#buscar=calle 45'); // only exists as AVENIDA 45
    await page.waitForSelector('#results .hint');
    assert.equal(await page.locator('#results a').count(), 0);
  });

  test('stop codes with a space are found either way', async t => {
    const page = await open(t, { path: '#buscar=lp300' });
    await page.waitForSelector('#results a');
    assert.match(await text(page, '#results a >> nth=0'), /DIAGONAL 74 y CALLE 54/);
  });

  test('with an empty catalog, a stop code still gets a direct link', async t => {
    const page = await open(t, { base: empty.url, path: '#buscar=LP105' });
    await page.waitForSelector('#results a');
    assert.match(await text(page, '#results a'), /Ver parada/);
  });

  test('a script in the query renders as text', async t => {
    const page = await open(t, { path: '' });
    let dialog = false;
    page.on('dialog', d => { dialog = true; d.dismiss(); });
    await page.goto(app.url + '#buscar=' + encodeURIComponent('<img src=x onerror=alert(1)>'));
    await page.waitForSelector('#results .hint');
    assert.equal(dialog, false);
  });

  test('the line → corner fallback retries after a failed load', async t => {
    const page = await open(t, { path: null });
    let fail = true;
    await page.route('**/api/lineas*', r => (fail ? r.abort() : r.continue()));
    await page.goto(app.url + '#buscar');
    await page.click('.fallback summary');
    await page.waitForSelector('#pickList .err');
    fail = false;
    await page.click('.fallback summary');
    await page.click('.fallback summary');
    await page.waitForFunction(() => document.querySelectorAll('#linea option').length > 2);
  });
});

describe('lines and map', () => {
  test('line page: route, ramal switch and stop filter', async t => {
    const page = await open(t, { path: '#lineas' });
    await page.click('.line-tile >> text=273');
    await page.waitForSelector('.timeline li');
    assert.match(await text(page, '#title'), /Línea 273/);
    assert.equal(await page.locator('.timeline li').count(), 26);
    assert.equal(await page.locator('.leaflet-overlay-pane path[role=button]').count(), 26);
    await page.fill('#filtro', 'avenida 45');
    assert.equal(await page.locator('.timeline li:visible').count(), 1);
    await page.fill('#filtro', '');
    await page.selectOption('#ramal', '1');
    assert.equal(await page.locator('.timeline li').count(), 5);
  });

  test('a line without route data, or an unknown line, shows only a message', async t => {
    const page = await open(t, { path: '#linea=95' });
    await page.waitForSelector('.hint');
    assert.match(await text(page, '.line-page'), /Todavía no tenemos el recorrido/);
    assert.equal(await page.locator('#map, #tools').count(), 0);
    await page.goto(app.url + '#linea=99999');
    await page.waitForSelector('.hint.err');
    assert.equal(await page.locator('#map, #tools').count(), 0);
  });

  test('map: zoom hint, then keyboard-usable stop markers', async t => {
    const page = await open(t, { path: '#mapa' });
    await page.waitForSelector('.leaflet-overlay-pane path[role=button]');
    const marker = page.locator('.leaflet-overlay-pane path[role=button]').first();
    await marker.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.leaflet-popup a');
    assert.match(await text(page, '.leaflet-popup'), /Ver arribos/);
    // Leaflet ignores a zoom click while the previous zoom is still animating.
    for (let i = 0; i < 2; i++) {
      await page.click('.leaflet-control-zoom-out');
      await page.waitForTimeout(400);
    }
    await page.waitForSelector('#hint:not([hidden])');
    assert.match(await text(page, '#hint'), /Acercá el mapa/);
  });

  test('map with an empty catalog still shows stops around the center', async t => {
    const page = await open(t, { base: empty.url, path: '#mapa' });
    await page.waitForSelector('.leaflet-overlay-pane path[role=button]');
  });
});

describe('across pages', () => {
  test('the active tab follows the route; desktop dark icon stays visible', async t => {
    const page = await open(t, { ...DESKTOP, colorScheme: 'dark', path: '' });
    for (const [hash, tab] of [['#lineas', '#lineas'], ['#linea=281', '#lineas'], ['#mapa', '#mapa'], ['#buscar', '#'], ['#parada=LP101', '#']]) {
      await page.evaluate(h => { location.hash = h; }, hash);
      assert.equal(await page.getAttribute('#nav [aria-current]', 'data-tab'), tab, hash);
    }
    const color = await page.$eval('#nav [aria-current] .tab-icon', e => getComputedStyle(e).color);
    assert.notEqual(color, 'rgb(21, 23, 28)');
  });

  test('skip link focuses the content without changing the page', async t => {
    const page = await open(t, { path: '#lineas' });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'skip');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'app');
    assert.ok(page.url().endsWith('#lineas'));
  });

  test('no sideways scrolling at 320 px on any page', async t => {
    const page = await open(t, { viewport: { width: 320, height: 640 }, path: '' });
    for (const hash of ['', '#buscar=calle 7', '#calle=CALLE 7', '#lineas', '#linea=281', '#mapa', '#parada=LP105&n=CALLE 7 y AVENIDA 45']) {
      await page.evaluate(h => { location.hash = h; }, hash);
      await page.waitForTimeout(400);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), hash || 'home');
    }
  });

  test('no network shows a Spanish message', async t => {
    const page = await open(t, { path: null });
    await page.route('**/api/**', r => r.abort());
    await page.goto(app.url + '#parada=LP105&n=X');
    await page.waitForSelector('#list .err');
    assert.match(await text(page, '#list'), /Sin conexión/);
  });

  test('blocked upstream: readable messages everywhere, the stop code link survives', async t => {
    const blocked = await startApp({ catalog: false });
    fake.block = true;
    t.after(() => { fake.block = false; blocked.close(); });
    const page = await open(t, { base: blocked.url, path: '#parada=LP105&n=X' });
    await page.waitForSelector('#list .err');
    assert.match(await text(page, '#list'), /Servicio en pausa/);
    await page.goto(blocked.url + '#buscar=LP105');
    await page.waitForSelector('#results a');
    assert.match(await text(page, '#results'), /Ver parada/);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(blocked.url + '#mapa');
    await page.waitForSelector('#hint:not([hidden])');
    await page.waitForFunction(() => /pausa/.test(document.getElementById('hint').textContent));
    const box = await page.$eval('#hint', e => e.getBoundingClientRect().toJSON());
    assert.ok(box.left >= 0 && box.right <= 320, JSON.stringify(box));
  });

  test('installable: service worker caches the shell, never the API', async t => {
    const page = await open(t, { serviceWorkers: 'allow', path: '' });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.evaluate(() => fetch('/api/lineas'));
    const keys = await page.evaluate(async () => {
      const c = await caches.open('shell-v1');
      return (await c.keys()).map(r => new URL(r.url).pathname);
    });
    assert.ok(keys.includes('/app.js') && keys.includes('/'), keys.join(','));
    assert.ok(!keys.some(k => k.startsWith('/api/')), keys.join(','));
  });
});
