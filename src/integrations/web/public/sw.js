const CACHE = 'hive-v1';
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css',
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js',
  'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/', ...CDN_ASSETS]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // CDN assets: cache-first
  if (url.hostname.includes('cdn.jsdelivr.net')) {
    e.respondWith(
      caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      }))
    );
    return;
  }

  // Static assets: network-first with cache fallback
  if (e.request.method === 'GET' && url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
});
