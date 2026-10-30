// Static assets only
const VERSION = '1.1.1';
const CACHE_PREFIX = 'JokerMusic-static-';
const CACHE_NAME = CACHE_PREFIX + VERSION;
const STATIC_CACHE = [
    '/static/css/style.css',
    `/static/js/playback.js?v=${VERSION}`,
    `/static/js/app.js?v=${VERSION}`,
    '/static/manifest.json',
    '/static/img/icon-192.png',
    '/static/img/icon-512.png',
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        const responses = await Promise.all(STATIC_CACHE.map(async path => {
            const response = await fetch(path, {
                cache: 'reload'
            });
            if (!response.ok || response.redirected) throw new Error('Precache failed: ' + path);
            return response;
        }));
        // Incomplete downloads must not replace the previous working cache.
        await Promise.all(responses.map((response, i) => cache.put(STATIC_CACHE[i], response)));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(key => key !== CACHE_NAME &&
            (key === 'JokerMusic' || key.startsWith(CACHE_PREFIX))).map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
        event.request.mode === 'navigate' || !STATIC_CACHE.includes(url.pathname + url.search)) return;
    // Network first; never intercept HTML, login/logout, APIs or audio/Range requests.
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
            const response = await fetch(event.request);
            if (response.ok && !response.redirected) {
                // Storage pressure must not turn a successful network load into an error.
                await cache.put(event.request, response.clone()).catch(() => {});
                return response;
            }
            return (await cache.match(event.request)) || response;
        } catch (error) {
            return (await cache.match(event.request)) || Response.error();
        }
    })());
});

self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});