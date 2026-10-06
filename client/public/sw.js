/* Vesper service worker — offline shell, online privacy.
 *
 * Caching rules, in order of importance:
 *  1. Never cache authenticated API responses. Messages, profiles and media
 *     are private data; a shared or stolen device must not find them in a
 *     cache partition. Only same-origin GETs for static assets and public
 *     pages are eligible.
 *  2. Navigations are network-first with a cached-shell fallback, so the app
 *     opens (and shows the signed-out or reconnecting state) with no signal.
 *  3. Hashed build assets are immutable, so they are cache-first forever.
 */
const CACHE = 'vesper-shell-v2';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/favicon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/og-image.png',
];
const IMMUTABLE = /^\/assets\//;
const PUBLIC_FILES = /^\/(robots\.txt|sitemap\.xml|og-image\.png|favicon\.svg|icon-|manifest\.webmanifest)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POSTs (messages, auth) always hit the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // no third-party caching

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  if (IMMUTABLE.test(url.pathname) || PUBLIC_FILES.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit ?? fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
  }
  // Everything else (API paths) falls through to the network, uncached.
});
