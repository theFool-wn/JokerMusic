(function(root) {
    'use strict';

    // A single choice is shared by preloading and the subsequent track change.
    function nextIndex(length, current, mode, automatic, reserved = -1, random = Math.random) {
        if (!length) return -1;
        if (automatic && mode === 'repeat') return current;
        if (mode === 'shuffle') {
            if (length === 1) return 0;
            if (reserved >= 0 && reserved < length && reserved !== current) return reserved;
            const offset = 1 + Math.floor(random() * (length - 1));
            return (current + offset) % length;
        }
        if (current + 1 < length) return current + 1;
        return automatic ? -1 : 0; // Sequence intentionally ends at the end of the queue.
    }

    function attachRecovery(audio, env = root) {
        const rawPlay = audio.play.bind(audio),
            rawPause = audio.pause.bind(audio);
        const rawLoad = audio.load.bind(audio);
        let wanted = false,
            attempts = 0,
            timer = null,
            generation = 0;
        let lastPosition = 0,
            pendingPosition = null;
        const cancel = () => {
            if (timer !== null) env.clearTimeout(timer);
            timer = null;
        };
        const failure = (e) => {
            if (e && e.name === 'NotAllowedError') {
                wanted = false;
                cancel();
            }
        };
        audio.play = () => {
            wanted = true;
            attempts = 0;
            return rawPlay().catch(e => {
                failure(e);
                throw e;
            });
        };
        audio.pause = () => {
            wanted = false;
            generation++;
            cancel();
            rawPause();
        };
        audio.load = () => {
            generation++;
            attempts = 0;
            pendingPosition = null;
            cancel();
            rawLoad();
        };
        audio.cancelRecovery = () => {
            wanted = false;
            generation++;
            cancel();
        };
        const recover = async () => {
            timer = null;
            if (!wanted || audio.ended || attempts >= 3 || env.navigator?.onLine === false) return;
            const epoch = generation,
                src = audio.src;
            attempts++;
            try {
                const response = await env.fetch('/api/songs', {
                    credentials: 'same-origin',
                    cache: 'no-store'
                });
                if (epoch !== generation || !wanted || src !== audio.src) return;
                if (response.status === 401) {
                    audio.pause();
                    audio.dispatchEvent(new CustomEvent('playbackfailure', {
                        detail: '登录已过期，请重新登录'
                    }));
                    return;
                }
                if (!response.ok) throw new Error('HTTP ' + response.status);
                pendingPosition = Number.isFinite(audio.currentTime) ? audio.currentTime : lastPosition;
                rawLoad();
                await rawPlay();
            } catch (e) {
                if (epoch === generation && wanted) {
                    failure(e);
                    schedule(1500 * attempts);
                }
            }
        };

        function schedule(delay = 8000) {
            if (!wanted || timer !== null || attempts >= 3) return;
            timer = env.setTimeout(recover, delay);
        }
        audio.addEventListener('loadedmetadata', () => {
            if (pendingPosition !== null) {
                const position = pendingPosition;
                pendingPosition = null;
                if (Number.isFinite(audio.duration) && position < audio.duration) audio.currentTime = position;
            }
        });
        audio.addEventListener('timeupdate', () => {
            if (audio.readyState >= 3 && !audio.paused && audio.currentTime > lastPosition + 0.1) {
                attempts = 0;
                cancel();
            }
            lastPosition = audio.currentTime;
        });
        audio.addEventListener('playing', cancel);
        audio.addEventListener('waiting', () => schedule());
        audio.addEventListener('stalled', () => schedule());
        audio.addEventListener('error', () => {
            if (audio.error?.code === 2) schedule(1000);
        });
        env.addEventListener?.('online', () => {
            if (wanted && (audio.error || audio.readyState < 3)) schedule(500);
        });
        return audio;
    }

    class NativeAudio extends EventTarget {
        constructor(bridge) {
            super();
            this.isNative = true;
            this.nativeState = {
                queue: [],
                index: -1,
                position: 0,
                duration: 0,
                playing: false,
                volume: 0.7
            };
            this.pending = new Map();
            this.sequence = 0;
            this._muted = false;
            this._volume = 0.7;
            this.ready = new Promise((resolve, reject) => {
                this.resolveReady = resolve;
                this.rejectReady = reject;
            });
            bridge.onmessage = event => this.receive(JSON.parse(event.data));
            this.bridge = bridge;
            this.send('hello').catch(error => this.rejectReady(error));
        }
        send(command, data = {}) {
            const id = ++this.sequence;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error('原生播放器未响应，请重新打开应用'));
                }, 15000);
                this.pending.set(id, {
                    resolve,
                    reject,
                    timer
                });
                try {
                    this.bridge.postMessage(JSON.stringify({
                        id,
                        command,
                        ...data
                    }));
                } catch (error) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(error);
                }
            });
        }
        fire(command, data) {
            this.send(command, data).catch(error => this.dispatchEvent(new CustomEvent('playbackfailure', {
                detail: error.message
            })));
        }
        receive(message) {
            if (message.type === 'ack' || message.type === 'error') {
                const pending = this.pending.get(message.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(message.id);
                    if (message.type === 'error') pending.reject(new Error(message.message));
                    else pending.resolve();
                }
                return;
            }
            if (message.type !== 'state') return;
            const before = this.nativeState;
            this.nativeState = message;
            this.resolveReady();
            if (!this._muted) this._volume = message.volume;
            if (before.queue?.[before.index]?.filename !== message.queue?.[message.index]?.filename || before.playlistId !== message.playlistId) {
                this.dispatchEvent(new Event('nativechange'));
            }
            if (before.duration !== message.duration) this.dispatchEvent(new Event('loadedmetadata'));
            if (before.playing !== message.playing) this.dispatchEvent(new Event(message.playing ? 'play' : 'pause'));
            this.dispatchEvent(new Event('timeupdate'));
            if (message.error && message.error !== before.error) this.dispatchEvent(new CustomEvent('playbackfailure', {
                detail: message.error
            }));
            // Native Media3 owns end-of-track advancement: never emit a web 'ended' event.
        }
        setQueue(songs, index, mode, playlistId, position = 0, play = true) {
            return this.send('queue', {
                songs: songs.map(s => ({
                    filename: s.filename,
                    title: s.title || s.filename,
                    artist: s.artist || '薛之谦',
                    album: s.album || "Joker's Music"
                })),
                index,
                mode,
                playlistId,
                position,
                play
            });
        }
        play() {
            return this.send('play');
        }
        pause() {
            this.fire('pause');
        }
        next() {
            this.fire('next');
        }
        previous() {
            this.fire('previous');
        }
        setMode(mode) {
            this.fire('mode', {
                mode
            });
        }
        refresh() {
            this.fire('hello');
        }
        get paused() {
            return !this.nativeState.playing;
        }
        get ended() {
            return !!this.nativeState.ended;
        }
        get currentTime() {
            return this.nativeState.position || 0;
        }
        set currentTime(position) {
            this.fire('seek', {
                position
            });
        }
        get duration() {
            return this.nativeState.duration || 0;
        }
        get playbackRate() {
            return 1;
        }
        get volume() {
            return this._volume;
        }
        set volume(volume) {
            this._volume = volume;
            this.fire('volume', {
                volume: this._muted ? 0 : volume
            });
        }
        get muted() {
            return this._muted;
        }
        set muted(muted) {
            this._muted = muted;
            this.fire('volume', {
                volume: muted ? 0 : this._volume
            });
        }
    }

    const api = {
        nextIndex,
        attachRecovery,
        NativeAudio,
        createAudio: audio => root.JokerNative ? new NativeAudio(root.JokerNative) : attachRecovery(audio)
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.JokerPlayback = api;
})(globalThis);