const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/sw.js'), 'utf8');
const {version} = require('../static/version.json');
const origin = 'https://jokermusic.example';

function worker() {
    const listeners = {}, stores = new Map(); let claimed = false, skipped = false, fail = false, quota = false;
    const key = request => new URL(typeof request === 'string' ? request : request.url, origin).href;
    const caches = { async keys() { return [...stores.keys()]; }, async delete(name) { return stores.delete(name); },
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const store = stores.get(name);
            return { async put(request, response) {
                if (quota) throw new Error('quota'); store.set(key(request), response.clone()); },
                async match(request) { return store.get(key(request))?.clone(); } };
        } };
    const self = { location: {origin}, addEventListener(name, fn) { listeners[name] = fn; },
        async skipWaiting() { skipped = true; }, clients: { async claim() { claimed = true; } } };
    vm.runInNewContext(source, {self, caches, URL, Response, fetch: async () => {
        if (fail) throw new Error('offline'); return new Response('network-v1');
    }});
    return {stores, caches, listeners, set offline(value) {fail = value;},
        set quotaExceeded(value) {quota = value;},
        get claimed() {return claimed;}, get skipped() {return skipped;},
        async event(name, data = {}) { let done; listeners[name]({...data, waitUntil(p) { done = p; }}); await done; },
        request(path, extra = {}) {
            let response; listeners.fetch({request: {url:new URL(path, origin).href, method:'GET', mode:'cors', ...extra},
                respondWith(p) {response = p;} }); return response;
        } };
}
test('upgrade removes only JokerMusic-owned caches and awaits claim', async () => {
    const w = worker();
    await w.caches.open('another-app'); await w.caches.open('JokerMusic');
    await w.caches.open('JokerMusic-static-0.1.0');
    await w.event('install'); await w.event('activate');
    assert.equal(w.skipped, true); assert.equal(w.claimed, true);
    assert.deepEqual([...w.stores.keys()].sort(), ['JokerMusic-static-' + version, 'another-app']);
});
test('failed precache never activates an incomplete release', async () => {
    const w = worker(); w.offline = true;
    await assert.rejects(w.event('install')); assert.equal(w.skipped, false);
});
test('API, audio Range, auth, navigation and foreign requests bypass caches', async () => {
    const w = worker();
    for (const path of ['/api/songs', '/api/stream/a.mp3', '/api/lyric/a.mp3', '/', '/login', '/logout',
        '/static/version.json', 'https://foreign.example/static/css/style.css', '/static/other.js'])
        assert.equal(w.request(path), undefined, path);
    assert.equal(w.request('/static/css/style.css', {method:'POST'}), undefined);
    assert.equal(w.request('/static/css/style.css', {mode:'navigate'}), undefined);
});
test('current JavaScript is refreshed and cached fallback survives offline', async () => {
    const w = worker(); await w.event('install');
    const path = '/static/js/app.js?v=' + version;
    assert.equal(await (await w.request(path)).text(), 'network-v1');
    w.offline = true;
    assert.equal(await (await w.request(path)).text(), 'network-v1');
    assert.equal(w.request('/static/js/app.js?v=0.1.0'), undefined);
});
test('cache quota failure still returns successful network JavaScript', async () => {
    const w = worker(); w.quotaExceeded = true;
    const response = await w.request('/static/js/app.js?v=' + version);
    assert.equal(response.status, 200); assert.equal(await response.text(), 'network-v1');
});