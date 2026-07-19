// Service worker «Монеток»: кэшируем оболочку приложения, чтобы PWA открывалась мгновенно и офлайн.
const CACHE = 'monetki-v4';
const SHELL = [
  './',
  './index.html',
  './config.js',
  './css/style.css',
  './js/app.js',
  './js/store.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Запросы к бэкенду (Apps Script) всегда идут в сеть.
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // Сеть в приоритете, кэш — запасной вариант (чтобы обновления кода доезжали сразу).
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// Клик по системному уведомлению — открываем/фокусируем приложение.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const hash = (e.notification.data && e.notification.data.hash) || '#/tasks';
      for (const c of list) { if ('focus' in c) { c.navigate(c.url.split('#')[0] + hash); return c.focus(); } }
      return self.clients.openWindow('./' + hash);
    })
  );
});
