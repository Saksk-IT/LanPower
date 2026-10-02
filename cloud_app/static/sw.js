// Cache only an explicit list of public, versioned assets. Never cache HTML or APIs.
const CACHE = 'lanpower-static-1.13.1';
const ASSETS = ['/static/app.css?v=1.13.1','/static/app.js?v=1.13.1','/static/status.js?v=1.13.1',
  '/static/remote.css?v=1.13.1','/static/remote.js?v=1.13.1','/static/favicon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lanpower-static-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !ASSETS.includes(url.pathname + url.search)) return;
  // Fresh public assets also matter during local development within the same version.
  event.respondWith(caches.open(CACHE).then(async cache => {
    try {
      const response = await fetch(event.request, {cache: 'no-store'});
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch { return (await cache.match(event.request)) || Response.error(); }
  }));
});
