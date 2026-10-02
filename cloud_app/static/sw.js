// Cache only an explicit list of public, versioned assets. Never cache HTML or APIs.
const CACHE = 'lanpower-static-1.8.0';
const ASSETS = ['/static/app.css?v=1.8.0','/static/app.js?v=1.8.0','/static/status.js?v=1.8.0',
  '/static/remote.css?v=1.8.0','/static/remote.js?v=1.8.0','/static/favicon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lanpower-static-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !ASSETS.includes(url.pathname + url.search)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
