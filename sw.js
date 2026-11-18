// Service worker: makes the app installable and opens the shell offline.
// Network-first for everything same-origin, so a deploy is picked up on the next load.
// API calls are never cached here: stale arrivals would look live, and per-coordinate
// map queries would grow storage without bound. The server already caches upstream.
const CACHE = 'shell-v1';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icon-192.png'];
const NEVER_CACHE = /^\/api\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only our own GETs. CDN assets and OSM tiles go straight to the network.
  if (e.request.method !== 'GET' || url.origin !== location.origin || NEVER_CACHE.test(url.pathname)) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request).then(hit => hit || Response.error())));
});
