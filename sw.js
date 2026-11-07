// Service worker: застосунок працює офлайн, логотипи монет кешуються.
// Запити до API цін не кешуються. Зашифровані дані сюди не потрапляють.
const VERSION = 'ct-1.3.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/crypto.js', 'js/store.js', 'js/calc.js', 'js/prices.js', 'js/format.js', 'js/charts.js', 'js/icons.js', 'js/sync.js',
  'vendor/argon2.umd.min.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/coins/dogecoin.svg',
];
const IMG_HOSTS = ['coin-images.coingecko.com', 'assets.coingecko.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== 'ct-logos') await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Логотипи монет: з кешу, щоб не робити повторних запитів
  if (IMG_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open('ct-logos');
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
      return res;
    })());
    return;
  }

  // Файли застосунку: віддаємо з кешу, оновлюємо у фоні
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await net) || new Response('Offline', { status: 503 });
    })());
  }
});
