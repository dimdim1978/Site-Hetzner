/* Мінімальний service worker уроків (docs/kabinet-uroky.md §9).
   Кешує ЛИШЕ записи звуків і іконки: їх багато, вони не змінюються, а інтернет
   у Покрові буває слабкий. Оболонку уроків, API і стан НЕ кешує — вони мають бути
   свіжі й видаватися лише після входу та з активованого пристрою.
   Без мережі сторінка не відкриється — замість порожнього екрана браузера
   показуємо коротке пояснення. */
'use strict';
const CACHE = 'mudryk-v1';
const OFFLINE = '<!doctype html><html lang="uk"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
  '<title>Немає інтернету · Мудрик</title></head>' +
  '<body style="margin:0;background:#F6F4EE;color:#101828;font-family:Segoe UI,Roboto,Arial,sans-serif;text-align:center;padding:48px 20px">' +
  '<div style="font-size:64px">🦉</div><h1 style="font-size:24px">Немає інтернету</h1>' +
  '<p style="font-size:18px;max-width:420px;margin:0 auto 20px">Уроки відкриваються лише з інтернетом. ' +
  'Заняття, які вже пройдені, не загубляться — вони відправляться, щойно зʼявиться звʼязок.</p>' +
  '<button onclick="location.reload()" style="font-size:18px;padding:14px 26px;border-radius:12px;border:0;background:#C77D2E;color:#fff">Спробувати ще раз</button>' +
  '</body></html>';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (/^\/uroky\/(audio\/snd_[a-z_]+\.wav|icon-\d+\.png)$/.test(url.pathname)) {
    // Range-запити (перемотування аудіо) не кешуємо — лише цілий файл
    if (req.headers.has('range')) return;
    e.respondWith(caches.open(CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok && r.status === 200) c.put(req, r.clone());
      return r;
    }))));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => new Response(OFFLINE, {headers: {'Content-Type': 'text/html; charset=utf-8'}})));
  }
});
