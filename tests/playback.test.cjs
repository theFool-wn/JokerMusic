const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextIndex, attachRecovery, NativeAudio } = require('../static/js/playback.js');

test('sequence stops automatically but manual next wraps', () => {
    assert.equal(nextIndex(3, 1, 'sequence', true), 2);
    assert.equal(nextIndex(3, 2, 'sequence', true), -1);
    assert.equal(nextIndex(3, 2, 'sequence', false), 0);
    assert.equal(nextIndex(0, -1, 'sequence', false), -1);
});
test('repeat and single-song shuffle work without a random selection loop', () => {
    assert.equal(nextIndex(3, 1, 'repeat', true), 1);
    assert.equal(nextIndex(3, 1, 'repeat', false), 2);
    assert.equal(nextIndex(1, 0, 'shuffle', true), 0);
});
test('shuffle consumes the preloaded choice and never immediately repeats', () => {
    const reserved = nextIndex(5, 2, 'shuffle', true, -1, () => 0.75);
    assert.equal(nextIndex(5, 2, 'shuffle', true, reserved, () => 0), reserved);
    for (let current = 0; current < 5; current++) {
        for (const random of [0, 0.1, 0.4, 0.9, 0.9999])
            assert.notEqual(nextIndex(5, current, 'shuffle', true, -1, () => random), current);
    }
});

class AudioStub extends EventTarget {
    src = '/api/stream/a.mp3'; currentTime = 42; duration = 100; ended = false; readyState = 2;
    plays = 0; loads = 0; pauses = 0; rejectPlay = null;
    async play() { this.plays++; if (this.rejectPlay) throw this.rejectPlay; }
    pause() { this.pauses++; }
    load() { this.loads++; this.currentTime = 0; }
}
function recovery(fetch = async () => ({ok: true, status: 200})) {
    const timers = new Map(); let id = 0;
    const env = { navigator: {onLine: true}, fetch,
        setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
    return { audio: attachRecovery(new AudioStub(), env), timers,
        async tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); } };
}
test('network recovery reloads the same song and restores its position', async () => {
    const r = recovery(); await r.audio.play(); r.audio.dispatchEvent(new Event('stalled'));
    await r.tick(); assert.equal(r.audio.loads, 1); assert.equal(r.audio.plays, 2);
    r.audio.dispatchEvent(new Event('loadedmetadata')); assert.equal(r.audio.currentTime, 42);
});
test('pause cancels retry and cannot be undone by a late authentication response', async () => {
    let finish; const r = recovery(() => new Promise(resolve => { finish = resolve; }));
    await r.audio.play(); r.audio.dispatchEvent(new Event('waiting'));
    const pending = r.tick(); r.audio.pause(); finish({ok: true, status: 200}); await pending;
    assert.equal(r.audio.plays, 1); assert.equal(r.audio.loads, 0); assert.equal(r.timers.size, 0);
});
test('switching song discards the old asynchronous recovery', async () => {
    let finish; const r = recovery(() => new Promise(resolve => { finish = resolve; }));
    await r.audio.play(); r.audio.dispatchEvent(new Event('stalled'));
    const pending = r.tick(); r.audio.src = '/api/stream/b.mp3'; r.audio.load();
    finish({ok: true, status: 200}); await pending;
    assert.equal(r.audio.loads, 1); assert.equal(r.audio.plays, 1);
});
test('expired login stops retries instead of requesting audio repeatedly', async () => {
    const r = recovery(async () => ({ok: false, status: 401})); let message;
    r.audio.addEventListener('playbackfailure', e => { message = e.detail; });
    await r.audio.play(); r.audio.dispatchEvent(new Event('waiting')); await r.tick();
    assert.match(message, /登录/); assert.equal(r.audio.pauses, 1); assert.equal(r.timers.size, 0);
});
test('network failures have a finite retry budget', async () => {
    const r = recovery(async () => { throw new Error('offline'); });
    await r.audio.play(); r.audio.dispatchEvent(new Event('stalled'));
    await r.tick(); await r.tick(); await r.tick();
    assert.equal(r.timers.size, 0); assert.equal(r.audio.loads, 0);
});
test('autoplay refusal is not worked around by a retry timer', async () => {
    const r = recovery(); r.audio.rejectPlay = new DOMException('gesture required', 'NotAllowedError');
    await assert.rejects(r.audio.play()); r.audio.dispatchEvent(new Event('stalled'));
    assert.equal(r.timers.size, 0);
});
test('late timeupdate while buffering does not cancel a pending recovery', async () => {
    const r = recovery(); await r.audio.play(); r.audio.dispatchEvent(new Event('waiting'));
    r.audio.currentTime = 43; r.audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(r.timers.size, 1); await r.tick(); assert.equal(r.audio.loads, 1);
});

test('native state restores the queue without sending web-ended or another queue', async () => {
    const commands = [];
    const bridge = { postMessage(data) {
        const command = JSON.parse(data); commands.push(command);
        queueMicrotask(() => bridge.onmessage({data: JSON.stringify({type:'ack', id: command.id})}));
    }};
    const audio = new NativeAudio(bridge); let changes = 0, ended = 0;
    audio.addEventListener('nativechange', () => changes++); audio.addEventListener('ended', () => ended++);
    const state = {type:'state', queue:[{filename:'a.mp3'}, {filename:'b.mp3'}], index:0,
        position:45, duration:100, playing:true, volume:0.7, playlistId:'my-list'};
    bridge.onmessage({data: JSON.stringify(state)}); await audio.ready;
    bridge.onmessage({data: JSON.stringify({...state, index:1, position:0})});
    bridge.onmessage({data: JSON.stringify({...state, index:1, playing:false, ended:true})});
    assert.equal(changes, 2); assert.equal(ended, 0); assert.equal(audio.paused, true);
    assert.deepEqual(commands.map(c => c.command), ['hello']);
    await audio.setQueue([{filename:'中文.mp3', title:'歌名', url:'https://ignored.invalid/'}], 0, 'repeat', 'all');
    assert.equal(commands.at(-1).songs[0].url, undefined);
});