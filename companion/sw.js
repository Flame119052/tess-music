// Tess companion — offline shell.
// The app's own files are cached-first so the Home Screen open is instant; everything spoken to Spotify
// (the API, the internal endpoints, the dealer socket) is always the network and is never cached.
const VERSION = 'tess-companion-v2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/dial-pick.js',
  './src/auth.js',
  './src/api.js',
  './src/aurora.js',
  './src/sync.js',
  './src/remote.js',
  './src/dial.js',
  './src/views.js',
  './src/player.js',
  './src/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (!e.request.method.startsWith('GET')) return;
  if (/api\.spotify\.com|spclient\.wg\.spotify\.com|dealer\.spotify\.com|accounts\.spotify\.com|i\.scdn\.co|mosaic\.scdn\.co/.test(url)) return;
  // stale-while-revalidate: the cached shell answers at once, the fresh copy lands behind it
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      const net = fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
          return r;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
