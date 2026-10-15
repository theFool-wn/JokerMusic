const CACHE_NAME = 'JokerMusic';
const STATIC_CACHE = [
    '/static/css/style.css',
    '/static/js/app.js',
    '/static/manifest.json',
    '/static/img/icon-192.png',
    '/static/img/icon-512.png',
];

// 安装：缓存核心静态资源
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return Promise.all(STATIC_CACHE.map(async (path) => {
                const response = await fetch(path);
                if (response.ok && !response.redirected) {
                    await cache.put(path, response);
                }
            })).catch((err) => {
                console.log('SW 缓存部分资源失败（可忽略）:', err);
            });
        })
    );
    self.skipWaiting();
});

// 激活：清理旧缓存，立即接管页面
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// 拦截请求
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 只处理同源请求
    if (url.origin !== self.location.origin) return;
    if (event.request.method !== 'GET') return;
    if (event.request.mode === 'navigate' || url.pathname.endsWith('.html')) return;

    // 音频流：走网络，不缓存
    if (url.pathname.startsWith('/api/stream/')) {
        return; // 不调用 respondWith，让浏览器默认走网络
    }

    // 所有 API 请求：走网络，不缓存（依赖登录态，缓存会导致错误）
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // API 请求：网络优先，失败时返回缓存
    // 页面（/ 和 /login）：走网络，不缓存（有登录重定向）
    if (url.pathname === '/' || url.pathname === '/login') {
        return;
    }

    // 静态资源：缓存优先，后台更新
    event.respondWith(
        caches.match(event.request).then((cached) => {
            const networkFetch = fetch(event.request).then((response) => {
                if (response && response.status === 200 && !response.redirected) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => cached);
            return cached || networkFetch;
        })
    );
});

// 接收来自页面的消息
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
