// Офлайн-кэш Обводилки. При изменении файлов — увеличить версию.
const CACHE = 'trace-draw-v8';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png', 'lib/mp4-muxer.js', 'lib/aruco.js', 'markers.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'td-share').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Сначала сеть (чтобы обновления приходили сразу), без сети — из кэша
self.addEventListener('fetch', (e) => {
  // картинка из «Поделиться» другого приложения
  if (e.request.method === 'POST' && new URL(e.request.url).pathname.endsWith('/share')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const f = fd.getAll('image').find((x) => x && x.type && x.type.startsWith('image/'));
        if (f) {
          const c = await caches.open('td-share');
          await c.put('shared-image', new Response(f, { headers: { 'Content-Type': f.type } }));
        }
      } catch (err) {}
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }) // всегда сверяться с сервером, не брать устаревшее из HTTP-кэша
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
