const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const api = async (name, params = {}) => {
  let res;
  try { res = await fetch(`/api/${name}?${new URLSearchParams(params)}`); }
  catch { throw new Error('Sin conexión. Revisá tu internet y probá de nuevo.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'El servicio no responde. Probá en unos minutos.');
  return data;
};

// Inline stroke icons (decorative; buttons carry their own aria-label).
const svg = (d, size = 20, extra = '') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const icon = {
  pin: s => svg('<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>', s),
  locate: s => svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>', s),
  search: s => svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', s),
  chevron: s => svg('<path d="m9 6 6 6-6 6"/>', s),
  back: s => svg('<path d="m15 6-6 6 6 6"/>', s, 'stroke-width="2.2"'),
  star: s => svg('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3z"/>', s, 'stroke-width="1.8"'),
  clock: s => svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', s, 'stroke-width="2.4"'),
  refresh: s => svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>', s, 'stroke-width="2.2"'),
  map: s => svg('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>', s),
  bus: s => svg('<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14M8 18v3M16 18v3"/>', s),
  street: s => svg('<path d="M8 3 5 21M16 3l3 18M12 4v3M12 11v3M12 18v2"/>', s),
  close: s => svg('<path d="M6 6l12 12M18 6 6 18"/>', s, 'stroke-width="2.2"'),
};

// Upstream formats: "LINEA 273" → "273"; ETA "6 min. aprox." (live), "17 min Hor. Prog." (timetable), "Arribando".
const lineLabel = s => String(s ?? '').replace(/^LINEA\s+/i, '');
const eta = a => {
  const t = a.tiempoRestanteArribo ?? '';
  const min = /(\d+)\s*min/i.exec(t)?.[1];
  return { min: min && +min, prog: /prog/i.test(t), arriving: /arrib/i.test(t), raw: t };
};
const clockIn = min => new Date(Date.now() + min * 60_000).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dest = a => a.descripcionCartelBandera || a.descripcionBandera;

const meters = (a, b) => { // haversine
  const r = x => x * Math.PI / 180, R = 6371e3;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const fmtDist = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;

const opts = (items, placeholder) =>
  `<option value="">${placeholder}</option>` + items.map(i => `<option value="${esc(i.codigo)}">${esc(i.descripcion)}</option>`).join('');
// Earlier builds saved " y " as the name when upstream sent empty streets; treat it as no name.
const cleanName = n => n?.trim() === 'y' ? '' : n;
const stopHash = (id, name) => `#${new URLSearchParams(name ? { parada: id, n: name } : { parada: id })}`;

// Stops come from upstream (`cercanas`, `paradas`) or from the catalog; render one shape:
// { id, name, lat, lng, lineas: ['273', 'SUR 10'] }.
const fromUpstream = p => ({
  id: p.identificador,
  name: [p.callePrincipal, p.calleInterseccion].filter(Boolean).join(' y '),
  lat: +p.latitud || null, lng: +p.longitud || null,
  lineas: String(p.lineas ?? '').replace(/^L[íi]neas:\s*/i, '').split(',').map(s => lineLabel(s.trim())).filter(Boolean),
});
const badges = lineas => (lineas ?? []).map(l => `<span class="badge sm">${esc(l)}</span>`).join('');
const stopRow = (s, opt = {}) => `<a class="row" href="${esc(stopHash(s.id, s.name))}">
  ${opt.here && s.lat ? `<span class="dist">${fmtDist(meters(opt.here, s))}</span>` : opt.pin ? `<span class="muted">${icon.pin(20)}</span>` : ''}
  <span class="main"><b>${esc(opt.title ?? (s.name || 'Parada'))} <span class="code">${esc(s.id)}</span></b>
    ${s.lineas?.length ? `<span class="badges">${badges(s.lineas)}</span>` : ''}</span>
  <span class="muted">${icon.chevron(18)}</span></a>`;

// Favorites: [{ id, name }] in localStorage (per-browser; may be unavailable in private mode).
const favs = {
  all() {
    try {
      const list = JSON.parse(localStorage.getItem('favs'));
      return (Array.isArray(list) ? list : []).filter(f => f && typeof f.id === 'string' && f.id)
        .map(f => ({ id: f.id, name: cleanName(typeof f.name === 'string' ? f.name : '') }));
    } catch { return []; }
  },
  save(list) { try { localStorage.setItem('favs', JSON.stringify(list)); return true; } catch { return false; } },
  has(id) { return this.all().some(f => f.id === id); },
  // false when the browser blocks storage (some private modes)
  toggle(id, name) {
    return this.save(this.has(id) ? this.all().filter(f => f.id !== id) : [...this.all(), { id, name }]);
  },
};
const fail = (el, err) => el.innerHTML = `<p class="hint err">${esc(err.message)}</p>`;

let timers = []; // cleared by route() so no poll or delayed call survives leaving a page
const every = (fn, ms) => timers.push(setInterval(fn, ms));
const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
let here = null; // last known position { lat, lng }, set by any geolocation lookup

const GEO_ERRORS = {
  1: 'Activá el permiso de ubicación para ver las paradas cerca tuyo.',
  2: 'No pudimos saber dónde estás. Probá de nuevo.',
  3: 'La ubicación tardó demasiado. Probá de nuevo.',
};
const locate = () => new Promise((ok, ko) => {
  if (!navigator.geolocation) return ko(new Error('Este navegador no comparte la ubicación.'));
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => ok(here = { lat: coords.latitude, lng: coords.longitude }),
    err => ko(new Error(GEO_ERRORS[err.code] ?? GEO_ERRORS[2])), { enableHighAccuracy: true, timeout: 10000 });
});
const geoGranted = async () => {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch { return false; }
};

const LA_PLATA = [-34.9214, -57.9545];
// Popups keep clear of the zoom control and map edges when they open.
if (window.L) L.Popup.mergeOptions({ autoPanPadding: L.point(60, 60) });
// Markers with a popup: reachable by Tab, named for screen readers, Enter/Space opens the popup.
const a11y = (marker, label) => marker.on('add', () => {
  const el = marker.getElement();
  if (!el) return;
  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', label);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); marker.openPopup(); }
  });
});
// Decorative markers stay out of the tab order.
const quiet = marker => marker.on('add', () => {
  const el = marker.getElement();
  el?.setAttribute('aria-hidden', 'true');
  el?.setAttribute('tabindex', '-1');
});
const tiles = map => (map.getContainer().setAttribute('aria-label', 'Mapa'), L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap',
}).addTo(map));
const stopDot = (ll, extra = {}) => L.circleMarker(ll, { radius: 6, color: '#15171C', weight: 2, fillColor: '#FFFFFF', fillOpacity: 1, ...extra });
// `history`: go back like the browser button when the previous entry is ours; href is the fallback.
const backBtn = (href = '#', useHistory = false) =>
  `<a class="icon-btn bare" href="${href}" aria-label="Volver"${useHistory ? ' data-back' : ''}>${icon.back(22)}</a>`;
let inAppNav = false; // true once the user navigated inside the app at least once
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-back]');
  if (a && inAppNav) { e.preventDefault(); history.back(); }
});

const FAV_LIVE_MAX = 6; // ponytail: one arribos call per favorite on each home render; raise only if upstream tolerates it

const miniEta = a => {
  const e = eta(a);
  const text = e.arriving ? 'Llega' : e.min != null ? `${e.min} min` : e.raw;
  return `<div><span class="badge">${esc(lineLabel(a.descripcionLinea))}</span>
    <span class="when${e.prog ? ' prog' : ''}">${e.prog ? icon.clock(13) : '<span class="dot"></span>'}${esc(text)}</span></div>`;
};

async function home() {
  const fav = favs.all();
  app.innerHTML = `<div class="home stack">
    <header class="top">
      <div><div class="where">${icon.pin(14)} La Plata</div><h1>Cuándo llega</h1></div>
      <button class="icon-btn" id="near" aria-label="Buscar paradas cerca mío">${icon.locate(20)}</button>
    </header>
    <a class="search" href="#buscar">${icon.search(20)}<span class="muted">Parada, calle o línea</span></a>
    <section>
      <h2>Tus paradas</h2>
      <div class="cards" id="favs">${fav.map(f => `<a class="card" href="${esc(stopHash(f.id, f.name))}" data-fav="${esc(f.id)}">
        <div class="card-head"><b>${esc(f.name || 'Parada')}</b><span class="code">${esc(f.id)}</span></div>
        <div class="mini"><div class="muted">Cargando…</div></div></a>`).join('')
        || `<div class="card add">${icon.star(18)} Abrí una parada y tocá la estrella para tenerla acá.</div>`}</div>
    </section>
    <section>
      <div class="h2row"><h2>Cerca tuyo</h2><a class="link" href="#mapa">Ver en mapa</a></div>
      <div class="list" id="nearList"><p class="hint">Tocá ${icon.locate(14)} arriba para ver las paradas cerca tuyo.</p></div>
    </section>
  </div>`;
  const $ = id => document.getElementById(id);
  const nearList = $('nearList');

  const findNear = async () => {
    nearList.innerHTML = '<p class="hint">Buscando ubicación…</p>';
    try {
      await locate();
      const stops = (await api('cercanas', here)).map(fromUpstream);
      nearList.innerHTML = stops.length ? stops.map(s => stopRow(s, { here })).join('') : '<p class="hint">No hay paradas cerca.</p>';
    } catch (err) { fail(nearList, err); }
  };
  $('near').onclick = findNear;

  // Live arrivals on favorite cards: fetched once per render, never polled from home.
  fav.forEach(async (f, i) => {
    const slot = $('favs').querySelector(`[data-fav="${CSS.escape(f.id)}"] .mini`);
    if (i >= FAV_LIVE_MAX) return slot.remove();
    try {
      const { arribos } = await api('arribos', { codLinea: 0, idParada: f.id });
      slot.innerHTML = arribos.length ? arribos.slice(0, 2).map(miniEta).join('') : '<div class="muted">Sin arribos próximos</div>';
    } catch { slot.innerHTML = '<div class="muted">Sin datos ahora</div>'; }
  });

  if (await geoGranted()) findNear();
}

// Fallback when the catalog lacks a street: the official line → street → corner flow.
function streetPicker(box) {
  box.innerHTML = `<div class="selects">
      <label class="sr" for="linea">Línea</label><select id="linea"><option>Cargando líneas…</option></select>
      <label class="sr" for="calle">Calle</label><select id="calle" hidden></select>
      <label class="sr" for="inter">Esquina</label><select id="inter" hidden></select>
    </div><div class="list" id="pickList"></div>`;
  const $ = id => box.querySelector(`#${id}`);
  const list = $('pickList'), linea = $('linea'), calle = $('calle'), inter = $('inter');
  linea.onchange = async () => {
    calle.hidden = inter.hidden = true; list.innerHTML = '';
    if (!linea.value) return;
    try {
      calle.innerHTML = opts(await api('calles', { codLinea: linea.value }), 'Calle…');
      calle.hidden = false;
    } catch (err) { fail(list, err); }
  };
  calle.onchange = async () => {
    inter.hidden = true; list.innerHTML = '';
    if (!calle.value) return;
    try {
      inter.innerHTML = opts(await api('intersecciones', { codLinea: linea.value, codCalle: calle.value }), 'Esquina…');
      inter.hidden = false;
    } catch (err) { fail(list, err); }
  };
  inter.onchange = async () => {
    if (!inter.value) return;
    try {
      const stops = await api('paradas', { codLinea: linea.value, codCalle: calle.value, codInterseccion: inter.value });
      // Upstream leaves the street names empty here; take them from the chosen options.
      list.innerHTML = stops.map(p => stopRow({
        ...fromUpstream(p),
        name: [p.callePrincipal || calle.selectedOptions[0].text, p.calleInterseccion || inter.selectedOptions[0].text].join(' y '),
      })).join('');
    } catch (err) { fail(list, err); }
  };
  api('lineas').then(lines => { linea.innerHTML = opts(lines.map(l => ({ ...l, descripcion: lineLabel(l.descripcion) })), 'Elegí una línea…'); })
    .catch(err => { linea.innerHTML = '<option value="">No se pudieron cargar las líneas</option>'; fail(list, err); });
}

const highlight = (text, q) => {
  const nums = new Set(String(q).match(/\d+/g) ?? []);
  return esc(text).replace(/\b\d+\b/g, n => nums.has(n) ? `<strong>${n}</strong>` : n);
};

function buscar(q0 = '') {
  app.innerHTML = `<div class="stack narrow">
    <h1 class="sr">Buscar</h1>
    <div class="search-bar">
      ${backBtn()}
      <label class="search">${icon.search(20)}
        <span class="sr">Buscar parada, calle o línea</span>
        <input type="search" id="q" value="${esc(q0)}" placeholder="Parada, calle o línea" autocomplete="off" enterkeyhint="search" maxlength="80">
      </label>
    </div>
    <div id="results"></div>
    <p class="muted tip">También podés escribir el código del cartel de la parada, por ejemplo <strong>LP10217</strong>.</p>
    <details class="fallback"><summary>¿No la encontrás? Buscar por línea y esquina</summary><div id="picker"></div></details>
  </div>`;
  const input = document.getElementById('q'), results = document.getElementById('results');
  let seq = 0, first = null;
  const run = async () => {
    const q = input.value.trim();
    history.replaceState(null, '', q ? `#buscar=${encodeURIComponent(q)}` : '#buscar');
    first = null;
    if (!q) { results.innerHTML = ''; return; }
    const mine = ++seq;
    // A stop code ("LP10217", "LP 10273") always gets a direct link, even if search fails.
    const code = /^[a-z]{2,3}\s?\d+$/i.test(q) ? q.toUpperCase() : null;
    const codeRow = () => stopRow({ id: code, name: '' }, { pin: true, title: 'Ver parada' });
    try {
      const r = await api('buscar', { q, ...(here ?? {}) });
      if (mine !== seq || !input.isConnected) return; // a newer keystroke answered, or we left
      const sections = [];
      if (r.lineas.length) sections.push(`<section><h2>Líneas</h2><div class="list">${r.lineas.map(l => `<a class="row" href="#linea=${esc(l.codigo)}">
        <span class="badge lg">${esc(l.label)}</span>
        <span class="main muted">${l.ramales ? `${l.ramales} ramales` : 'Ver recorrido'}</span>
        <span class="muted">${icon.chevron(18)}</span></a>`).join('')}</div></section>`);
      // Streets before stops: one street row stands for many stops on it.
      if (r.calles.length) sections.push(`<section><h2>Calles</h2><div class="list">${r.calles.map(c => `<a class="row" href="#calle=${encodeURIComponent(c.nombre)}">
        <span class="muted">${icon.street(20)}</span>
        <span class="main"><b>${highlight(c.nombre, q)}</b><span class="muted">${c.paradas} ${c.paradas === 1 ? 'parada' : 'paradas'} · elegí la esquina</span></span>
        <span class="muted">${icon.chevron(18)}</span></a>`).join('')}</div></section>`);
      if (r.paradas.length || code) sections.push(`<section><h2>Paradas</h2><div class="list">${
        r.paradas.map(s => stopRow(s, here ? { here } : { pin: true })).join('') || codeRow()}</div>${
        r.totalParadas > r.paradas.length ? `<p class="muted more">Mostrando ${r.paradas.length} de ${r.totalParadas}. Escribí más para afinar.</p>` : ''}</section>`);
      // A stop code goes first; otherwise lines, streets, stops.
      if (code && r.paradas.length) sections.unshift(sections.pop());
      results.innerHTML = sections.join('') || '<p class="hint">Sin resultados. Probá con el código del cartel o buscá por línea y esquina abajo.</p>';
      first = results.querySelector('a');
    } catch (err) {
      if (mine !== seq || !input.isConnected) return;
      fail(results, err);
      if (code) results.insertAdjacentHTML('afterbegin', `<section><h2>Paradas</h2><div class="list">${codeRow()}</div></section>`);
      first = results.querySelector('a');
    }
  };
  let debounce; // via later(): route() cancels it, so a late run can't rewrite another page's URL
  input.oninput = () => {
    first = null; // results on screen belong to the previous text
    clearTimeout(debounce);
    debounce = later(() => { debounce = null; run(); }, 250);
  };
  // Enter searches now if a keystroke is still pending, then opens the first result.
  input.onkeydown = async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!first || debounce) { clearTimeout(debounce); debounce = null; await run(); }
    if (input.isConnected) first?.click();
  };
  document.querySelector('.fallback').ontoggle = e => {
    const box = document.getElementById('picker');
    // First open, or a retry after the line list failed to load.
    if (e.target.open && !box.querySelector('#linea option[value]:not([value=""])')) streetPicker(box);
  };
  input.focus();
  if (q0) run();
  // Location already allowed: get it, so results show distances and sort nearest first.
  if (!here) geoGranted().then(ok => ok && locate().then(() => input.isConnected && input.value.trim() && run(), () => {}));
}

async function calle(nombre) {
  app.innerHTML = `<div class="stack narrow">
    <header class="stop-head">${backBtn(`#buscar=${encodeURIComponent(nombre)}`, true)}
      <div class="title"><h1>${esc(nombre)}</h1><span class="muted">Elegí la esquina</span></div></header>
    <div class="list" id="list"><p class="hint">Cargando…</p></div></div>`;
  const list = document.getElementById('list');
  try {
    const stops = await api('calle', { nombre });
    list.innerHTML = stops.length ? stops.map(s => stopRow(s, { title: s.esquina ? `y ${s.esquina}` : s.name })).join('')
      : '<p class="hint">No hay paradas guardadas para esta calle.</p>';
  } catch (err) { fail(list, err); }
}

async function lineas() {
  app.innerHTML = `<div class="stack narrow"><header class="top"><h1>Líneas</h1></header>
    <div class="line-grid" id="list"><p class="hint">Cargando…</p></div></div>`;
  const list = document.getElementById('list');
  try {
    const lines = await api('lineas');
    list.innerHTML = lines.map(l => `<a class="line-tile" href="#linea=${esc(l.codigo)}">
      <span class="badge lg">${esc(lineLabel(l.descripcion))}</span></a>`).join('');
  } catch (err) { fail(list, err); }
}

async function linea(codigo) {
  app.innerHTML = `<div class="line-page">
    <header class="stop-head">${backBtn('#lineas')}
      <div class="title"><h1 id="title">Línea</h1><span class="muted" id="sub">Cargando recorrido…</span></div></header>
    <div id="map" class="line-map"></div>
    <div class="body">
      <div class="line-tools" id="tools">
        <label class="field"><span>Ramal</span><select id="ramal"></select></label>
        <label class="search small">${icon.search(18)}<span class="sr">Filtrar paradas</span>
          <input type="search" id="filtro" placeholder="Filtrar por calle o código" autocomplete="off"></label>
      </div>
      <ol class="timeline" id="list"></ol>
    </div>
  </div>`;
  const $ = id => document.getElementById(id);
  const list = $('list'), ramal = $('ramal'), filtro = $('filtro');
  // No route to show: drop the controls and the map, leave one message.
  const bail = html => {
    $('sub').textContent = '';
    $('map').remove();
    $('tools').remove();
    list.outerHTML = html;
  };
  let data;
  try { data = await api('linea', { codLinea: codigo }); }
  catch (err) {
    if (!list.isConnected) return;
    return bail(`<p class="hint err">${esc(err.message)}</p>`);
  }
  if (!list.isConnected) return; // navigated away while loading

  $('title').innerHTML = `<span class="badge lg">${esc(data.label)}</span> Línea ${esc(data.label)}`;
  if (!data.ramales.length) return bail('<p class="hint">Todavía no tenemos el recorrido de esta línea.</p>');
  $('sub').textContent = `${data.ramales.length} ${data.ramales.length === 1 ? 'ramal' : 'ramales'}`;
  ramal.innerHTML = data.ramales.map((r, i) => `<option value="${i}">${esc(r.name)}</option>`).join('');

  let map, layer;
  if (window.L) {
    map = L.map($('map'));
    tiles(map);
    layer = L.layerGroup().addTo(map);
  }
  const show = () => {
    const r = data.ramales[+ramal.value];
    list.innerHTML = r.paradas.map((s, i) => `<li data-q="${esc(`${s.name ?? ''} ${s.id}`.toLowerCase())}">
      <span class="rail${i === 0 ? ' first' : ''}${i === r.paradas.length - 1 ? ' last' : ''}"><span class="node"></span></span>
      <a href="${esc(stopHash(s.id, s.name))}"><b>${esc(s.name || 'Parada')}</b><span class="code">${esc(s.id)}</span></a></li>`).join('');
    filtro.oninput();
    if (!map) return;
    layer.clearLayers();
    if (r.path.length) L.polyline(r.path, { color: '#15171C', weight: 4, opacity: .85 }).addTo(layer);
    r.paradas.forEach(s => a11y(stopDot([s.lat, s.lng], { radius: 5 }), `${s.name || 'Parada'} ${s.id}`)
      .bindPopup(`<b>${esc(s.name || 'Parada')}</b> · ${esc(s.id)}<br><a href="${esc(stopHash(s.id, s.name))}">Ver arribos</a>`).addTo(layer));
    const pts = r.path.length ? r.path : r.paradas.map(s => [s.lat, s.lng]);
    map.invalidateSize();
    if (pts.length) map.fitBounds(pts, { padding: [24, 24] });
  };
  filtro.oninput = () => {
    const q = filtro.value.trim().toLowerCase();
    list.querySelectorAll('li').forEach(li => { li.hidden = !!q && !li.dataset.q.includes(q); });
  };
  ramal.onchange = show;
  show();
}

function mapa() {
  app.innerHTML = `<div class="map-page">
    <h1 class="sr">Mapa de paradas</h1>
    <div id="map"></div>
    <button class="icon-btn map-locate" id="loc" aria-label="Ir a mi ubicación">${icon.locate(20)}</button>
    <p class="map-hint" id="hint" hidden>Acercá el mapa para ver las paradas</p>
  </div>`;
  if (!window.L) return fail(app, new Error('No se pudo cargar el mapa.'));
  const map = L.map('map', { zoomControl: false }).setView(here ? [here.lat, here.lng] : LA_PLATA, 16);
  L.control.zoom({ position: 'topright' }).addTo(map);
  tiles(map);
  const layer = L.layerGroup().addTo(map), hint = document.getElementById('hint');
  let me, seq = 0;
  const showMe = () => {
    if (!here) return;
    me?.remove();
    me = quiet(L.circleMarker([here.lat, here.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563EB', fillOpacity: 1 })).addTo(map);
  };
  const say = text => { hint.textContent = text; hint.hidden = !text; };
  const load = async () => {
    if (map.getZoom() < 15) { say('Acercá el mapa para ver las paradas'); return layer.clearLayers(); }
    say('');
    const b = map.getBounds(), mine = ++seq;
    // Seen in the wild: a zero-size box when the map measured its container before layout. Re-measure and retry.
    if (b.getNorth() === b.getSouth() || b.getEast() === b.getWest()) { map.invalidateSize(); return later(load, 300); }
    try {
      const stops = await api('zona', { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() });
      if (mine !== seq || !hint.isConnected) return;
      layer.clearLayers();
      stops.forEach(s => a11y(stopDot([s.lat, s.lng]), `${s.name || 'Parada'} ${s.id}`)
        .bindPopup(`<b>${esc(s.name || 'Parada')}</b> · ${esc(s.id)}${s.lineas?.length ? `<br>${esc(s.lineas.join(', '))}` : ''}
          <br><a href="${esc(stopHash(s.id, s.name))}">Ver arribos</a>`).addTo(layer));
    } catch (err) { if (mine === seq && hint.isConnected) say(err.message); }
  };
  let debounce;
  map.on('moveend', () => { clearTimeout(debounce); debounce = later(load, 400); });
  document.getElementById('loc').onclick = async () => {
    try { await locate(); if (!hint.isConnected) return; showMe(); map.setView([here.lat, here.lng], 17); }
    catch (err) { if (hint.isConnected) say(err.message); }
  };
  showMe();
  load();
  geoGranted().then(ok => ok && !here && document.getElementById('loc')?.click());
}

async function stop(id, name) {
  const title = cleanName(name) || `Parada ${id}`;
  app.innerHTML = `<div class="stop-page">
    <header class="stop-head">
      ${backBtn()}
      <div class="title"><h1>${esc(title)}</h1>${cleanName(name) ? `<span class="muted">Parada ${esc(id)}</span>` : ''}</div>
      <button class="icon-btn bare star" id="star">${icon.star(24)}</button>
    </header>
    <div id="map" hidden></div>
    <div class="body">
      <div class="chips" id="chips" role="group" aria-label="Filtrar por línea"></div>
      <div class="status"><span id="upd"></span>
        <button id="reload">${icon.refresh(15)}Actualizar</button></div>
      <div class="cards" id="list"><p class="hint">Cargando…</p></div>
    </div>
  </div>`;
  const $ = id => document.getElementById(id);
  const list = $('list'), star = $('star'), chips = $('chips'), upd = $('upd');
  const paintStar = () => {
    const on = favs.has(id);
    star.setAttribute('aria-pressed', on);
    star.ariaLabel = on ? 'Quitar de favoritas' : 'Agregar a favoritas';
  };
  star.onclick = () => {
    if (!favs.toggle(id, cleanName(name) || '')) {
      $('favmsg')?.remove();
      star.closest('header').insertAdjacentHTML('afterend',
        '<p class="hint err" id="favmsg" role="status">Este navegador no permite guardar favoritas (¿modo privado?).</p>');
    }
    paintStar();
  };
  paintStar();

  let map, layer, fitted = false;
  // `all` locates the stop; `shown` (the chip filter) decides which buses get a marker.
  const drawMap = (all, shown) => {
    const s = all.find(a => a.latitudParada);
    if (!s || !window.L) return; // no coordinates without arrivals, or Leaflet failed to load
    const stopLL = [parseFloat(s.latitudParada), parseFloat(s.longitudParada)];
    if (!map) {
      const el = $('map');
      el.hidden = false;
      map = L.map(el).setView(stopLL, 15);
      tiles(map);
      // The stop gets its own pane above the tooltip pane (650), so a bus label never hides it.
      map.createPane('stop').style.zIndex = 660;
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    quiet(L.circleMarker(stopLL, { pane: 'stop', radius: 9, color: '#fff', weight: 3, fillColor: '#15171C', fillOpacity: 1 })).addTo(layer);
    const buses = shown.filter(a => a.latitud && a.longitud)
      .map(a => [parseFloat(a.latitud), parseFloat(a.longitud), a]);
    buses.forEach(([lat, lng, a]) =>
      a11y(L.circleMarker([lat, lng], { radius: 6, color: '#15171C', weight: 2, fillColor: '#FFC529', fillOpacity: 1 }),
        `Colectivo ${lineLabel(a.descripcionLinea)}, ${a.tiempoRestanteArribo}`)
        .bindTooltip(esc(lineLabel(a.descripcionLinea)), { permanent: true, direction: 'top', className: 'bus-label' })
        .bindPopup(`<b>${esc(lineLabel(a.descripcionLinea))}</b> · ${esc(a.tiempoRestanteArribo)}<br>${esc(dest(a))}`)
        .addTo(layer));
    if (!fitted && buses.length) {
      map.invalidateSize(); // the wide layout can size the container after Leaflet measured it
      map.fitBounds([stopLL, ...buses.map(([lat, lng]) => [lat, lng])], { padding: [30, 30], maxZoom: 16 });
      fitted = true;
    }
  };

  let arribos = [], filter = '', updatedAt = 0;
  const paintChips = () => {
    const lines = [...new Set(arribos.map(a => lineLabel(a.descripcionLinea)))];
    if (filter && !lines.includes(filter)) filter = '';
    const focused = chips.contains(document.activeElement) ? document.activeElement.dataset.line : null;
    chips.innerHTML = lines.length < 2 ? '' : ['', ...lines].map(l =>
      `<button data-line="${esc(l)}" aria-pressed="${l === filter}">${l ? esc(l) : 'Todas'}</button>`).join('');
    // Rebuilding the chips would drop keyboard focus (also on every 30 s poll); put it back.
    if (focused != null) [...chips.children].find(b => b.dataset.line === focused)?.focus();
  };
  chips.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.line;
    paint();
  };
  const arrival = a => {
    const e = eta(a);
    const big = e.arriving ? '<b>Llega</b>' : e.min != null ? `<b>${e.min}</b><span>min</span>` : `<span>${esc(e.raw)}</span>`;
    const adapted = a.esAdaptado ? ' · Adaptado' : '';
    const kind = e.prog
      ? `<span class="kind prog">${icon.clock(12)}Programado${e.min != null ? ` · ${clockIn(e.min)}` : ''}${adapted}</span>`
      : `<span class="kind"><span class="dot"></span>En vivo${adapted}</span>`;
    return `<div class="arrival">
      <span class="badge lg">${esc(lineLabel(a.descripcionLinea))}</span>
      <span class="main"><b>${esc(dest(a))}</b>${kind}</span>
      <span class="big${e.prog ? ' prog' : ''}">${big}</span></div>`;
  };
  let failed = null; // last refresh error while older arrivals are still on screen
  const paint = () => {
    paintChips();
    const shown = arribos.filter(a => !filter || lineLabel(a.descripcionLinea) === filter);
    drawMap(arribos, shown);
    list.innerHTML = shown.length ? shown.map(arrival).join('') : '<p class="hint">Sin arribos próximos.</p>';
  };
  const tick = () => {
    if (!updatedAt) return;
    const s = Math.round((Date.now() - updatedAt) / 1000);
    const ago = s < 5 ? 'recién' : `hace ${s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`}`;
    upd.innerHTML = failed
      ? `<span class="err">No se pudo actualizar · última vez ${ago}</span>`
      : `<span class="dot"></span>Actualizado ${ago}`;
  };

  const load = async () => {
    try {
      const data = await api('arribos', { codLinea: 0, idParada: id });
      if (!list.isConnected) return; // answer for a page we already left
      arribos = data.arribos;
      updatedAt = Date.now();
      failed = null;
      paint();
    } catch (err) {
      if (!list.isConnected) return;
      // Keep the last good arrivals on screen; only show the error alone if there's nothing yet.
      if (updatedAt) failed = err; else fail(list, err);
    }
    tick();
  };
  $('reload').onclick = load;
  // Set timers before the first await so route() can clear them. Upstream rate-limits; don't poll faster than 30s.
  every(load, 30_000);
  every(tick, 5_000);
  load();
}

// Bottom bar on phones, top bar on wide screens.
const NAV = [['#', 'Paradas', icon.pin], ['#mapa', 'Mapa', icon.map], ['#lineas', 'Líneas', icon.bus]];
const tab = h => h.has('mapa') ? '#mapa' : h.has('lineas') || h.has('linea') ? '#lineas' : '#';
// Skip link: jumps past the nav without touching the hash router.
document.body.insertAdjacentHTML('afterbegin', '<a class="skip" href="#app">Saltar al contenido</a>');
document.querySelector('.skip').onclick = e => { e.preventDefault(); app.focus(); };
app.tabIndex = -1;
document.getElementById('nav').innerHTML = `<a class="brand" href="#"><span class="badge">${icon.bus(16)}</span>Cuándo llega</a>` + NAV.map(([href, label, ic]) =>
  `<a href="${href}" data-tab="${href}"><span class="tab-icon">${ic(20)}</span>${label}</a>`).join('');

function route() {
  timers.forEach(t => { clearInterval(t); clearTimeout(t); });
  timers = [];
  const h = new URLSearchParams(location.hash.slice(1));
  document.querySelectorAll('#nav a').forEach(a => {
    if (a.dataset.tab === tab(h)) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.body.dataset.page = h.has('mapa') ? 'mapa' : '';
  window.scrollTo(0, 0);
  if (h.get('parada')) return stop(h.get('parada'), h.get('n'));
  if (h.has('buscar')) return buscar(h.get('buscar') ?? '');
  if (h.get('calle')) return calle(h.get('calle'));
  if (h.get('linea')) return linea(h.get('linea'));
  if (h.has('lineas')) return lineas();
  if (h.has('mapa')) return mapa();
  home();
}
addEventListener('hashchange', () => { inAppNav = true; route(); });
route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
