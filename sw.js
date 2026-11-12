/* Kayline service worker: network-first for the app shell, with an offline fallback.
   Only same-origin GET requests are handled; calls to api.anthropic.com pass straight through. */
const CACHE = 'kayline-v18';
const SHELL = ['./', 'index.html', 'styles.css?v=18', 'app.js?v=18', 'ai.js?v=18', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch third-party / API traffic
  e.respondWith((async () => {
    try {
      // 'no-cache' bypasses GitHub Pages' 10-minute HTTP cache so updates appear on the next load.
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') { const shell = await caches.match('index.html'); if (shell) return shell; }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
