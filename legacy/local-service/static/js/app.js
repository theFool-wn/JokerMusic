(function() {
    "use strict";

    const state = {
        songs: [],
        filteredSongs: [],
        playQueue: [],
        queueSource: "all",
        currentIndex: -1,
        currentSong: null,
        playMode: "sequence",
        isPlaying: false,
        isSeeking: false,
        lyricData: [],
        currentLyricIndex: -1,
        playlists: [],
        pendingSongFilename: null,
        dragSrcFilename: null,
        dragPlaylistId: null,
        sort: {
            field: "pinyin",
            order: "asc"
        },
        // 每个歌单独立的排序设置，key 为歌单 id（含 "all"）
        playlistSorts: {},
        rafId: null,
        // 当前左侧显示的歌单
        currentPlaylistId: "all",
        currentPlaylistName: "全部歌曲",
        // 当前正在播放的歌单
        playingPlaylistId: "all",
        playingPlaylistName: "全部歌曲",
        // 预加载下一首的音频对象
        preloadAudio: null,
    };

    const STORAGE_KEY = "joker_music_playlists";
    const MODE_KEY = "joker_music_mode";
    const VOLUME_KEY = "joker_music_volume";
    const THEME_KEY = "joker_music_theme";
    const NOWPLAYING_KEY = "joker_music_nowplaying";

    const $ = (id) => document.getElementById(id);
    const dom = {
        audio: $("audioPlayer"),
        searchInput: $("searchInput"),
        songList: $("songList"),
        reloadBtn: $("reloadBtn"),
        themeToggle: $("themeToggle"),
        themeIconDark: $("themeIconDark"),
        themeIconLight: $("themeIconLight"),
        modeBtns: document.querySelectorAll(".mode-btn"),
        playBtn: $("playBtn"),
        playIcon: $("playIcon"),
        pauseIcon: $("pauseIcon"),
        prevBtn: $("prevBtn"),
        nextBtn: $("nextBtn"),
        progressBar: $("progressBar"),
        progressFill: $("progressFill"),
        currentTime: $("currentTime"),
        totalTime: $("totalTime"),
        volumeBar: $("volumeBar"),
        volumeFill: $("volumeFill"),
        muteBtn: $("muteBtn"),
        volumePopup: $("volumePopup"),
        volumePopupBar: $("volumePopupBar"),
        volumePopupFill: $("volumePopupFill"),
        playerTitle: $("playerTitle"),
        playerArtist: $("playerArtist"),
        playerPlaylistTag: $("playerPlaylistTag"),
        playerCover: $("playerCover"),
        lyricScroll: $("lyricScroll"),
        lyricPlaceholder: $("lyricPlaceholder"),
        // 歌单选择器
        selectorBtn: $("selectorBtn"),
        selectorName: $("selectorName"),
        selectorCount: $("selectorCount"),
        selectorDropdown: $("selectorDropdown"),
        diAllCount: $("diAllCount"),
        dropdownList: $("dropdownList"),
        dropdownCreate: $("dropdownCreate"),
        dropdownCreateInput: $("dropdownCreateInput"),
        newPlaylistInput: $("newPlaylistInput"),
        confirmCreateBtn: $("confirmCreateBtn"),
        // 排序
        sortBtns: document.querySelectorAll(".sort-btn"),
        // 分隔条
        resizer: $("resizer"),
        songPanel: $("songPanel"),
        // 手机全屏歌词
        fullscreenLyric: $("fullscreenLyric"),
        flClose: $("flClose"),
        flTitle: $("flTitle"),
        flArtist: $("flArtist"),
        flLyricScroll: $("flLyricScroll"),
        // 模态框
        addToPlaylistModal: $("addToPlaylistModal"),
        modalPlaylistList: $("modalPlaylistList"),
        closeModalBtn: $("closeModalBtn"),
        toast: $("toast"),
    };

    // ============================================================
    // 工具函数
    // ============================================================
    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, "0")}`;
    }

    let toastTimer = null;

    function showToast(msg, duration = 2000) {
        dom.toast.textContent = msg;
        dom.toast.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => dom.toast.classList.remove("show"), duration);
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str || "";
        return div.innerHTML;
    }

    // ============================================================
    // API
    // ============================================================
    async function apiFetch(url, options = {}) {
        try {
            const res = await fetch(url, {
                credentials: "same-origin",
                ...options
            });
            if (res.status === 401) {
                window.location.href = "/login";
                return null;
            }
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `请求失败 (${res.status})`);
            }
            return res.json();
        } catch (e) {
            showToast("网络错误：" + e.message);
            throw e;
        }
    }

    async function loadSongs(forceRefresh = false) {
        const url = forceRefresh ? "/api/reload" : "/api/songs";
        const method = forceRefresh ? "POST" : "GET";
        const data = await apiFetch(url, {
            method
        });
        if (data && data.songs) {
            state.songs = data.songs;
            applySortAndFilter();
            updateSelectorCounts();
            if (forceRefresh) showToast(`歌库已刷新，共 ${data.count} 首`);
        }
    }

    async function loadLyric(filename) {
        const data = await apiFetch(`/api/lyric/${encodeURIComponent(filename)}`);
        if (data && data.has_lyric && data.lyric) {
            state.lyricData = parseLRC(data.lyric);
            renderLyric();
            renderFullscreenLyric();
        } else {
            state.lyricData = [];
            renderLyric();
            renderFullscreenLyric();
        }
    }

    // ============================================================
    // LRC 解析
    // ============================================================
    function parseLRC(lrcText) {
        const lines = lrcText.split(/\r?\n/);
        const result = [];
        const timeRegex = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
        for (const line of lines) {
            const matches = [...line.matchAll(timeRegex)];
            if (matches.length === 0) continue;
            const text = line.replace(timeRegex, "").trim();
            if (!text) continue;
            for (const m of matches) {
                const min = parseInt(m[1], 10);
                const sec = parseInt(m[2], 10);
                const ms = m[3] ? parseInt(m[3].padEnd(3, "0"), 10) : 0;
                result.push({
                    time: min * 60 + sec + ms / 1000,
                    text
                });
            }
        }
        result.sort((a, b) => a.time - b.time);
        return result;
    }

    function renderLyric() {
        if (state.lyricData.length === 0) {
            dom.lyricPlaceholder.style.display = "block";
            dom.lyricScroll.style.display = "none";
            dom.lyricScroll.innerHTML = "";
            // 有歌曲在播放但无歌词 → 显示"暂无歌词"；未播放 → 显示引导提示
            const ph = dom.lyricPlaceholder;
            if (state.currentSong) {
                ph.querySelector("p").textContent = "暂无歌词";
                ph.querySelector(".sub").textContent = "该歌曲未找到歌词文件";
            } else {
                ph.querySelector("p").textContent = "选择一首歌开始播放";
                ph.querySelector(".sub").textContent = "歌词将在这里同步显示";
            }
            return;
        }
        dom.lyricPlaceholder.style.display = "none";
        dom.lyricScroll.style.display = "block";
        dom.lyricScroll.innerHTML = state.lyricData
            .map((item, i) => `<div class="lyric-line" data-index="${i}">${escapeHtml(item.text)}</div>`)
            .join("");
        state.currentLyricIndex = -1;
    }

    function renderFullscreenLyric() {
        if (state.lyricData.length === 0) {
            dom.flLyricScroll.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px 0;">暂无歌词</div>';
            return;
        }
        dom.flLyricScroll.innerHTML = state.lyricData
            .map((item, i) => `<div class="lyric-line" data-index="${i}">${escapeHtml(item.text)}</div>`)
            .join("");
    }

    function updateLyric(currentTime) {
        if (state.lyricData.length === 0) return;
        let idx = -1;
        let low = 0,
            high = state.lyricData.length - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (state.lyricData[mid].time <= currentTime) {
                idx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        if (idx === state.currentLyricIndex) return;
        state.currentLyricIndex = idx;

        // 桌面歌词
        const lines = dom.lyricScroll.querySelectorAll(".lyric-line");
        lines.forEach((el) => el.classList.remove("active"));
        if (idx >= 0 && lines[idx]) {
            lines[idx].classList.add("active");
            const container = dom.lyricScroll;
            const lineTop = lines[idx].offsetTop;
            const lineHeight = lines[idx].offsetHeight;
            container.scrollTop = lineTop - container.clientHeight / 2 + lineHeight / 2;
        }

        // 手机全屏歌词
        const flLines = dom.flLyricScroll.querySelectorAll(".lyric-line");
        flLines.forEach((el) => el.classList.remove("active"));
        if (idx >= 0 && flLines[idx]) {
            flLines[idx].classList.add("active");
            const container = dom.flLyricScroll;
            const lineTop = flLines[idx].offsetTop;
            const lineHeight = flLines[idx].offsetHeight;
            container.scrollTop = lineTop - container.clientHeight / 2 + lineHeight / 2;
        }
    }

    // ============================================================
    // 歌单管理
    // ============================================================
    function loadPlaylists() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            state.playlists = raw ? JSON.parse(raw) : [];
        } catch (e) {
            state.playlists = [];
        }
    }

    function savePlaylists() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.playlists));
    }

    function getPlaylistName(id) {
        if (id === "all") return "全部歌曲";
        const pl = state.playlists.find((p) => p.id === id);
        return pl ? pl.name : "全部歌曲";
    }

    function getPlaylistSongs(id) {
        if (id === "all") return state.songs;
        const pl = state.playlists.find((p) => p.id === id);
        if (!pl) return state.songs;
        return pl.songs.map((f) => state.songs.find((s) => s.filename === f)).filter((s) => s !== undefined);
    }

    function createPlaylist(name) {
        name = name.trim();
        if (!name) {
            showToast("请输入歌单名称");
            return;
        }
        if (state.playlists.some((p) => p.name === name)) {
            showToast("歌单名称已存在");
            return;
        }
        const pl = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name,
            songs: [],
        };
        state.playlists.push(pl);
        savePlaylists();
        renderPlaylistDropdown();
        showToast(`歌单「${name}」已创建`);
        // 自动切换到新歌单
        switchPlaylist(pl.id);
    }

    function deletePlaylist(id) {
        const pl = state.playlists.find((p) => p.id === id);
        if (!pl) return;
        if (!confirm(`确定删除歌单「${pl.name}」吗？`)) return;
        state.playlists = state.playlists.filter((p) => p.id !== id);
        savePlaylists();
        renderPlaylistDropdown();
        // 如果当前显示的是被删除的歌单，切回全部歌曲
        if (state.currentPlaylistId === id) switchPlaylist("all");
        showToast("歌单已删除");
    }

    function renamePlaylist(id) {
        const pl = state.playlists.find((p) => p.id === id);
        if (!pl) return;
        const newName = prompt("请输入新的歌单名称", pl.name);
        if (newName === null) return;
        const trimmed = newName.trim();
        if (!trimmed) {
            showToast("歌单名称不能为空");
            return;
        }
        if (trimmed === pl.name) return;
        if (state.playlists.some((p) => p.id !== id && p.name === trimmed)) {
            showToast("已存在同名歌单");
            return;
        }
        pl.name = trimmed;
        savePlaylists();
        renderPlaylistDropdown();
        // 同步更新当前显示的歌单名
        if (state.currentPlaylistId === id) {
            state.currentPlaylistName = trimmed;
            dom.selectorName.textContent = trimmed;
        }
        // 同步更新播放器"来自"标签
        if (state.playingPlaylistId === id) {
            state.playingPlaylistName = trimmed;
            updatePlayerPlaylistTag();
        }
        showToast("歌单已重命名");
    }

    function addSongToPlaylist(playlistId, filename) {
        const pl = state.playlists.find((p) => p.id === playlistId);
        if (!pl) return;
        if (pl.songs.includes(filename)) {
            showToast("歌曲已在该歌单中");
            return;
        }
        pl.songs.push(filename);
        savePlaylists();
        renderPlaylistDropdown();
        // 如果当前显示的是这个歌单，刷新列表
        if (state.currentPlaylistId === playlistId) applySortAndFilter();
        showToast(`已添加到「${pl.name}」`);
    }

    function addAllSongsToPlaylist(playlistId) {
        const pl = state.playlists.find((p) => p.id === playlistId);
        if (!pl) return;
        let added = 0;
        for (const song of state.songs) {
            if (!pl.songs.includes(song.filename)) {
                pl.songs.push(song.filename);
                added++;
            }
        }
        savePlaylists();
        renderPlaylistDropdown();
        if (state.currentPlaylistId === playlistId) applySortAndFilter();
        showToast(added > 0 ? `已添加 ${added} 首到「${pl.name}」` : "所有歌曲已在该歌单中");
    }

    function removeSongFromPlaylist(playlistId, filename) {
        const pl = state.playlists.find((p) => p.id === playlistId);
        if (!pl) return;
        pl.songs = pl.songs.filter((f) => f !== filename);
        savePlaylists();
        renderPlaylistDropdown();
        if (state.currentPlaylistId === playlistId) applySortAndFilter();
    }

    function reorderPlaylistSongs(playlistId, srcFilename, targetFilename, insertBefore) {
        const pl = state.playlists.find((p) => p.id === playlistId);
        if (!pl) return;
        const srcIdx = pl.songs.indexOf(srcFilename);
        if (srcIdx === -1) return;
        pl.songs.splice(srcIdx, 1);
        let targetIdx = pl.songs.indexOf(targetFilename);
        if (targetIdx === -1) {
            pl.songs.splice(srcIdx, 0, srcFilename);
            return;
        }
        if (!insertBefore) targetIdx += 1;
        pl.songs.splice(targetIdx, 0, srcFilename);
        savePlaylists();
        renderPlaylistDropdown();
        applySortAndFilter();
        showToast("顺序已调整");
    }

    function saveNowPlaying() {
        if (!state.currentSong) return;
        const data = {
            filename: state.currentSong.filename,
            playingPlaylistId: state.playingPlaylistId,
            currentPlaylistId: state.currentPlaylistId,
            currentTime: dom.audio.currentTime || 0,
            sortField: state.sort.field,
            sortOrder: state.sort.order,
            playlistSorts: state.playlistSorts,
        };
        localStorage.setItem(NOWPLAYING_KEY, JSON.stringify(data));
    }

    async function restoreNowPlaying() {
        try {
            const raw = localStorage.getItem(NOWPLAYING_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (!data.filename) return;

            // 恢复各歌单独立排序设置
            if (data.playlistSorts) state.playlistSorts = data.playlistSorts;

            // 恢复播放来源歌单
            if (data.playingPlaylistId) {
                state.playingPlaylistId = data.playingPlaylistId;
                state.playingPlaylistName = getPlaylistName(data.playingPlaylistId);
                updatePlayerPlaylistTag();
            }

            // 左侧展示当前正在播放的歌属于的那个歌单（优先 playingPlaylistId，不存在则回退）
            const playlistExists = (id) => id === "all" || state.playlists.some((p) => p.id === id);
            const targetPlaylistId = (data.playingPlaylistId && playlistExists(data.playingPlaylistId))
                ? data.playingPlaylistId
                : (data.currentPlaylistId && playlistExists(data.currentPlaylistId)
                    ? data.currentPlaylistId
                    : "all");
            state.currentPlaylistId = targetPlaylistId;
            state.currentPlaylistName = getPlaylistName(targetPlaylistId);
            dom.selectorName.textContent = state.currentPlaylistName;

            // 恢复当前歌单的排序（优先用独立设置，兼容旧数据用全局 sortField）
            const savedSort = state.playlistSorts[targetPlaylistId];
            if (savedSort) {
                state.sort.field = savedSort.field;
                state.sort.order = savedSort.order;
            } else if (data.sortField) {
                state.sort.field = data.sortField;
                if (data.sortOrder) state.sort.order = data.sortOrder;
            } else {
                state.sort.field = "pinyin";
                state.sort.order = "asc";
            }
            // 全部歌曲不支持自定义排序，兜底回退
            if (targetPlaylistId === "all" && state.sort.field === "custom") {
                state.sort.field = "pinyin";
                state.sort.order = "asc";
            }

            const song = state.songs.find((s) => s.filename === data.filename);
            if (!song) return;

            // 从播放来源歌单构建队列
            const queueSongs = getPlaylistSongs(data.playingPlaylistId);
            const idx = queueSongs.findIndex((s) => s.filename === data.filename);
            state.currentSong = song;
            state.playQueue = queueSongs;
            state.currentIndex = idx >= 0 ? idx : 0;

            // 更新播放栏信息
            dom.playerTitle.textContent = song.title || song.filename;
            dom.playerArtist.textContent = song.artist || "薛之谦";
            dom.flTitle.textContent = song.title || song.filename;
            dom.flArtist.textContent = song.artist || "薛之谦";

            await loadLyric(song.filename);
            dom.audio.src = `/api/stream/${encodeURIComponent(song.filename)}`;
            dom.audio.load();

            const savedTime = data.currentTime || 0;

            // 歌词加载后，等下一帧布局稳定再刷新歌词（解决手机端隐藏容器布局未就绪的问题）
            const refreshLyric = () => {
                if (state.lyricData.length > 0) {
                    state.currentLyricIndex = -1; // 强制重置，避免 idx 相同被 updateLyric 跳过
                    updateLyric(savedTime);
                }
            };
            requestAnimationFrame(() => requestAnimationFrame(refreshLyric));

            // 恢复播放进度：同时监听 loadedmetadata 和 canplay，兼容手机端 loadedmetadata 不触发的情况
            const onReady = () => {
                try { dom.audio.currentTime = savedTime; } catch (e) { /* 手机端可能需等 canplay */ }
                const duration = dom.audio.duration || 0;
                const percent = duration > 0 ? (savedTime / duration) * 100 : 0;
                dom.progressFill.style.width = percent + "%";
                dom.currentTime.textContent = formatTime(savedTime);
                if (dom.totalTime) dom.totalTime.textContent = formatTime(duration);
                refreshLyric();
            };
            dom.audio.addEventListener("loadedmetadata", onReady, { once: true });
            dom.audio.addEventListener("canplay", onReady, { once: true });

            // 手机端兜底：如果 1.5 秒内两个事件都没触发（iOS 限制），至少确保歌词已刷新
            setTimeout(() => {
                if (state.lyricData.length > 0 && state.currentLyricIndex === -1) {
                    refreshLyric();
                }
            }, 1500);

            updateSelectorCounts();
            renderPlaylistDropdown();
            applySortAndFilter();
            highlightCurrentSong();
            setTimeout(scrollToCurrentSong, 100);
        } catch (e) {
            console.error("恢复播放状态失败:", e);
        }
    }

    // ============================================================
    // 歌单选择器
    // ============================================================
    function switchPlaylist(id) {
        // 保存当前歌单的排序设置
        state.playlistSorts[state.currentPlaylistId] = {
            field: state.sort.field,
            order: state.sort.order
        };
        state.currentPlaylistId = id;
        state.currentPlaylistName = getPlaylistName(id);
        dom.selectorName.textContent = state.currentPlaylistName;
        // 恢复新歌单的排序设置（没有则默认拼音正序）
        const saved = state.playlistSorts[id];
        if (saved) {
            state.sort.field = saved.field;
            state.sort.order = saved.order;
        } else {
            state.sort.field = "pinyin";
            state.sort.order = "asc";
        }
        // 全部歌曲不支持自定义排序，兜底回退
        if (id === "all" && state.sort.field === "custom") {
            state.sort.field = "pinyin";
            state.sort.order = "asc";
        }
        updateSelectorCounts();
        renderPlaylistDropdown();
        applySortAndFilter();
        closePanel("playlist");
        // 滚动到当前播放歌曲
        setTimeout(scrollToCurrentSong, 50);
    }

    function updateSelectorCounts() {
        const displaySongs = getPlaylistSongs(state.currentPlaylistId);
        dom.selectorCount.textContent = `${displaySongs.length} 首`;
        dom.diAllCount.textContent = `${state.songs.length} 首`;
    }

    function renderPlaylistDropdown() {
        document.querySelectorAll(".js-tooltip").forEach((el) => el.remove()); // 重新渲染会销毁按钮，先清 tooltip
        if (state.playlists.length === 0) {
            dom.dropdownList.innerHTML = '<div style="padding:10px 14px;color:var(--text-muted);font-size:12px;text-align:center;">暂无自定义歌单</div>';
        } else {
            dom.dropdownList.innerHTML = state.playlists.map((pl) => {
                const active = pl.id === state.currentPlaylistId;
                return `
                    <div class="dropdown-item ${active ? "active" : ""}" data-playlist="${pl.id}">
                        <span class="di-indicator">
                            <svg xmlns="http://www.w3.org/2000/svg"  viewBox="0 0 48 48" width="24" height="24"><path fill="currentColor" d="M 26 2.0039062 C 24.896 2.0039062 24 2.6769063 24 3.5039062 L 24 30.369141 C 24 31.083141 23.714953 31.731078 23.251953 32.205078 C 23.773953 32.318078 24.272328 32.481453 24.736328 32.689453 C 24.988328 32.802453 25.100281 33.097609 24.988281 33.349609 C 24.875281 33.601609 24.580125 33.713563 24.328125 33.601562 C 23.500125 33.229563 22.424141 33.016953 21.369141 33.001953 C 20.925141 33.001953 20.468 33.037375 20 33.109375 C 16.136 33.705375 13 36.605078 13 39.580078 C 13 42.555078 16.136953 44.487578 20.001953 43.892578 C 22.213953 43.552578 24.186703 42.454484 25.470703 41.021484 C 25.640703 40.841484 25.740406 40.700812 25.691406 40.757812 C 27.115406 38.910813 28 36.621047 28 34.998047 L 28 13.998047 C 31 13.998047 35 16.775047 35 19.998047 C 35 24.013047 33.512 26.359047 32 28.998047 L 34 29.998047 C 37.444 25.253047 39 22.106047 39 18.998047 C 39 9.9980469 28.000953 7.9980469 28.001953 3.9980469 L 28 3.5039062 C 28 2.6769063 27.103 2.0039062 26 2.0039062 z M 27.998047 6.4609375 C 28.320047 6.8459375 28.688453 7.1984844 29.064453 7.5214844 C 30.108453 8.4244844 31.613672 9.4310156 32.888672 10.416016 C 35.581672 12.498016 38 14.987047 38 18.998047 C 38 19.318047 37.980359 19.639844 37.943359 19.964844 C 37.566359 16.549844 35.341672 14.313016 32.888672 12.416016 C 31.613672 11.431016 29.349 10.427047 28 9.9980469 L 27.998047 6.4609375 z M 18.402344 34.998047 C 19.313437 35.001492 20 35.494578 20 36.205078 C 20 37.017078 19.104 37.811656 18 37.972656 C 16.896 38.133656 16 37.606922 16 36.794922 C 16 35.982922 16.896 35.188344 18 35.027344 C 18.138 35.007094 18.272188 34.997555 18.402344 34.998047 z M 19 46.998047 C 17.073 46.998047 12 47.218047 12 47.498047 C 12 47.777047 17.073 47.998047 19 47.998047 C 23.679 47.998047 36 47.777047 36 47.498047 C 36 47.218047 23.679 46.998047 19 46.998047 z"/></svg>
                        </span>
                        <span class="di-name">${escapeHtml(pl.name)}</span>
                        <span class="di-count">${pl.songs.length} 首</span>
                        <button class="di-add-all" data-playlist="${pl.id}" data-tooltip="添加所有歌曲到此歌单">
                            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></svg>
                        </button>
                        <button class="di-rename" data-playlist="${pl.id}" data-tooltip="重命名">
                            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" /></svg>
                        </button>
                        <button class="di-remove" data-playlist="${pl.id}" data-tooltip="删除歌单">&times;</button>
                    </div>`;
            }).join("");
        }
        // 更新全部歌曲active状态
        const allItem = dom.selectorDropdown.querySelector('.dropdown-item[data-playlist="all"]');
        if (allItem) allItem.classList.toggle("active", state.currentPlaylistId === "all");
    }

    function openSelectorDropdown() {
        dom.selectorDropdown.style.display = "flex";
        dom.selectorBtn.classList.add("open");
        dom.dropdownCreateInput.style.display = "none";
        dom.dropdownCreate.style.display = "flex";
        pushPanel("playlist");
        dom.newPlaylistInput.value = "";
    }

    function closeSelectorDropdown() {
        dom.selectorDropdown.style.display = "none";
        dom.selectorBtn.classList.remove("open");
        document.querySelectorAll(".js-tooltip").forEach((el) => el.remove());
    }

    function toggleSelectorDropdown() {
        if (dom.selectorDropdown.style.display === "flex") closePanel("playlist");
        else openSelectorDropdown();
    }

    // ============================================================
    // 排序 + 搜索过滤
    // ============================================================
    function applySortAndFilter() {
        const kw = (dom.searchInput.value || "").trim().toLowerCase();
        let list = [...getPlaylistSongs(state.currentPlaylistId)];

        // 搜索
        if (kw) {
            list = list.filter((s) =>
                (s.title || "").toLowerCase().includes(kw) ||
                (s.artist || "").toLowerCase().includes(kw) ||
                (s.album || "").toLowerCase().includes(kw) ||
                (s.filename || "").toLowerCase().includes(kw)
            );
        }

        // 排序（自定义排序不做额外排序，保持歌单原始顺序）
        const {
            field,
            order
        } = state.sort;
        if (field !== "custom") {
            const dir = order === "asc" ? 1 : -1;
            if (field === "pinyin") {
                list.sort((a, b) => dir * (a.title || "").localeCompare(b.title || "", "zh-Hans-CN"));
            } else if (field === "album") {
                list.sort((a, b) => dir * (a.album || "").localeCompare(b.album || "", "zh-Hans-CN"));
            } else if (field === "duration") {
                list.sort((a, b) => dir * ((a.duration || 0) - (b.duration || 0)));
            }
        }

        state.filteredSongs = list;
        renderSongList();
        updateSortButtons();
    }

    function updateSortButtons() {
        dom.sortBtns.forEach((btn) => {
            const field = btn.dataset.field;
            const active = field === state.sort.field;
            btn.classList.toggle("active", active);
            btn.classList.toggle("desc", active && state.sort.order === "desc");
            // 自定义排序仅用户歌单可用
            if (field === "custom") {
                btn.disabled = state.currentPlaylistId === "all";
            }
        });
    }

    function handleSort(field) {
        if (field === "custom" && state.currentPlaylistId === "all") {
            showToast("全部歌曲不支持自定义排序");
            return;
        }
        if (state.sort.field === field) {
            state.sort.order = state.sort.order === "asc" ? "desc" : "asc";
        } else {
            state.sort.field = field;
            state.sort.order = "asc";
        }
        // 保存到当前歌单的独立排序设置
        state.playlistSorts[state.currentPlaylistId] = {
            field: state.sort.field,
            order: state.sort.order
        };
        applySortAndFilter();
        const names = {
            pinyin: "拼音",
            album: "专辑",
            duration: "时长",
            custom: "自定义"
        };
        if (field === "custom") {
            showToast("按自定义排序");
        } else {
            const orderName = state.sort.order === "asc" ? "正序" : "逆序";
            showToast(`按${names[field]}${orderName}`);
        }
    }

    // ============================================================
    // 播放器核心
    // ============================================================
    function playSong(song, queue = null, index = -1, playlistId = null) {
        if (!song) return;
        state.currentSong = song;
        // 立即清空上一首歌词，让"选择一首歌开始播放"提示消失
        state.lyricData = [];
        state.currentLyricIndex = -1;
        renderLyric();
        renderFullscreenLyric();
        if (queue) {
            state.playQueue = queue;
            state.currentIndex = index;
        }

        // 记录当前播放的歌单
        if (playlistId) {
            state.playingPlaylistId = playlistId;
            state.playingPlaylistName = getPlaylistName(playlistId);
        } else {
            state.playingPlaylistId = state.currentPlaylistId;
            state.playingPlaylistName = state.currentPlaylistName;
        }
        updatePlayerPlaylistTag();

        dom.audio.src = `/api/stream/${encodeURIComponent(song.filename)}`;
        dom.audio.load();
        dom.audio.play().catch((e) => {
            // 快速切歌时上一个 play 被新 load 中断属正常现象，不提示
            if (e && /interrupted|abort|load/i.test(e.message || "")) return;
            console.error("播放失败:", e);
            showToast("播放失败：" + (e.message || "未知错误"));
        });

        dom.playerTitle.textContent = song.title || song.filename;
        dom.playerArtist.textContent = song.artist || "薛之谦";
        dom.flTitle.textContent = song.title || song.filename;
        dom.flArtist.textContent = song.artist || "薛之谦";

        loadLyric(song.filename);
        highlightCurrentSong();
        scrollToCurrentSong();
        saveNowPlaying();

        // Media Session API：锁屏显示歌曲信息 + 控制按钮，提升后台播放优先级
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: song.title || song.filename,
                    artist: song.artist || '薛之谦',
                    album: song.album || 'Joker\'s Music',
                    artwork: [
                        { src: '/static/img/icon-192.png', sizes: '192x192', type: 'image/png' },
                        { src: '/static/img/icon-512.png', sizes: '512x512', type: 'image/png' },
                    ],
                });
                navigator.mediaSession.setActionHandler('play', () => {
                    dom.audio.play().catch(() => {});
                });
                navigator.mediaSession.setActionHandler('pause', () => {
                    dom.audio.pause();
                });
                navigator.mediaSession.setActionHandler('previoustrack', () => {
                    playPrev();
                });
                navigator.mediaSession.setActionHandler('nexttrack', () => {
                    playNext(false);
                });
            } catch (e) { /* 不支持的浏览器忽略 */ }
        }

        // 预加载下一首，减少切歌时的加载等待
        preloadNextSong();
    }

    function updatePlayerPlaylistTag() {
        dom.playerPlaylistTag.textContent = `来自：${state.playingPlaylistName}`;
    }

    function scrollToCurrentSong() {
        requestAnimationFrame(() => {
            const item = dom.songList.querySelector(".song-item.playing");
            if (item) item.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });
        });
    }

    function togglePlay() {
        if (!state.currentSong) {
            if (state.playQueue.length > 0) playSong(state.playQueue[0], state.playQueue, 0);
            else if (state.filteredSongs.length > 0) playSong(state.filteredSongs[0], state.filteredSongs, 0);
            return;
        }
        if (dom.audio.paused) dom.audio.play().catch(() => {});
        else dom.audio.pause();
    }

    function playNext(auto = false) {
        if (state.playQueue.length === 0) return;
        if (state.playMode === "repeat" && auto) {
            dom.audio.currentTime = 0;
            dom.audio.play().catch(() => {});
            return;
        }
        let nextIndex;
        if (state.playMode === "shuffle") {
            if (state.playQueue.length === 1) nextIndex = 0;
            else {
                do {
                    nextIndex = Math.floor(Math.random() * state.playQueue.length);
                }
                while (nextIndex === state.currentIndex);
            }
        } else {
            nextIndex = state.currentIndex + 1;
            if (nextIndex >= state.playQueue.length) {
                if (auto) {
                    dom.audio.currentTime = 0;
                    updatePlayIcon(false);
                    return;
                }
                nextIndex = 0;
            }
        }
        playSong(state.playQueue[nextIndex], state.playQueue, nextIndex);
    }

    // 预加载下一首：当前歌曲播放时提前加载下一首的音频数据，切歌时几乎零延迟
    function preloadNextSong() {
        if (state.playQueue.length === 0) return;
        let nextIndex;
        if (state.playMode === "shuffle") {
            if (state.playQueue.length === 1) nextIndex = 0;
            else {
                do {
                    nextIndex = Math.floor(Math.random() * state.playQueue.length);
                } while (nextIndex === state.currentIndex);
            }
        } else {
            nextIndex = state.currentIndex + 1;
            if (nextIndex >= state.playQueue.length) nextIndex = 0;
        }
        const nextSong = state.playQueue[nextIndex];
        if (!nextSong) return;
        // 销毁上一个预加载对象
        if (state.preloadAudio) {
            state.preloadAudio.src = '';
            state.preloadAudio = null;
        }
        // 创建隐藏音频对象预加载（不播放，只加载数据到缓存）
        state.preloadAudio = new Audio();
        state.preloadAudio.preload = 'auto';
        state.preloadAudio.src = `/api/stream/${encodeURIComponent(nextSong.filename)}`;
        state.preloadAudio.load();
    }

    function playPrev() {
        if (state.playQueue.length === 0) return;
        if (dom.audio.currentTime > 3) {
            dom.audio.currentTime = 0;
            return;
        }
        let prevIndex;
        if (state.playMode === "shuffle") {
            if (state.playQueue.length === 1) prevIndex = 0;
            else {
                do {
                    prevIndex = Math.floor(Math.random() * state.playQueue.length);
                }
                while (prevIndex === state.currentIndex);
            }
        } else {
            prevIndex = state.currentIndex - 1;
            if (prevIndex < 0) prevIndex = state.playQueue.length - 1;
        }
        playSong(state.playQueue[prevIndex], state.playQueue, prevIndex);
    }

    function updatePlayIcon(playing) {
        state.isPlaying = playing;
        const showPlay = !playing;
        dom.playIcon.style.display = showPlay ? "block" : "none";
        dom.pauseIcon.style.display = showPlay ? "none" : "block";
        if (playing) {
            dom.playerCover.classList.add("spinning");
            dom.playerCover.classList.remove("paused");
        } else {
            dom.playerCover.classList.add("paused");
        }
    }

    function highlightCurrentSong() {
        const items = dom.songList.querySelectorAll(".song-item");
        // 仅当当前显示的歌单与正在播放的歌单一致时才高亮
        const canHighlight = state.currentPlaylistId === state.playingPlaylistId;
        items.forEach((el) => {
            el.classList.toggle("playing",
                !!(canHighlight && state.currentSong && el.dataset.filename === state.currentSong.filename));
        });
    }

    // ============================================================
    // requestAnimationFrame 高频更新
    // ============================================================
    function startRafLoop() {
        if (state.rafId) return;

        function loop() {
            if (!dom.audio.paused && !dom.audio.ended && !state.isSeeking) {
                const current = dom.audio.currentTime;
                const duration = dom.audio.duration || 0;
                const percent = duration > 0 ? (current / duration) * 100 : 0;
                dom.progressFill.style.width = percent + "%";
                dom.currentTime.textContent = formatTime(current);
                updateLyric(current);
            }
            state.rafId = requestAnimationFrame(loop);
        }
        state.rafId = requestAnimationFrame(loop);
    }

    // ============================================================
    // 歌曲列表渲染
    // ============================================================
    function renderSongList() {
        const list = state.filteredSongs;
        if (list.length === 0) {
            dom.songList.innerHTML = `
                <div style="flex:1;min-height:200px;display:flex;flex-direction:column;justify-content:center;text-align:center;padding:40px 20px;color:var(--text-muted);">
                    <p>没有找到歌曲</p>
                    <p style="font-size:12px;margin-top:6px;opacity:0.7;">从全部歌曲中添加到此歌单</p>
                </div>`;
            return;
        }
        const isCustomSort = state.sort.field === "custom" && state.currentPlaylistId !== "all";
        dom.songList.innerHTML = list.map((song, i) => {
            const metaParts = [];
            if (song.artist) metaParts.push(`<span class="artist-name">${escapeHtml(song.artist)}</span>`);
            if (song.album) metaParts.push(escapeHtml(song.album));
            if (song.duration) metaParts.push(formatTime(song.duration));
            const draggable = isCustomSort ? 'draggable="true"' : "";
            return `
                <div class="song-item" data-filename="${escapeHtml(song.filename)}" data-index="${i}" ${draggable}>
                    <span class="song-index">${i + 1}</span>
                    <div class="song-info">
                        <div class="song-title">${escapeHtml(song.title || song.filename)}</div>
                        <div class="song-meta">${metaParts.join(" · ")}</div>
                    </div>
                    <div class="song-actions">
                        ${state.currentPlaylistId !== "all" ? `
                        <button class="song-action-btn remove-from-playlist" data-filename="${escapeHtml(song.filename)}" data-tooltip="从歌单移除">
                            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                        </button>` : ""}
                        <button class="song-action-btn add-to-playlist" data-filename="${escapeHtml(song.filename)}" data-tooltip="添加到歌单">
                            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                        </button>
                    </div>
                    <span class="song-duration">${song.duration ? formatTime(song.duration) : ""}</span>
                </div>`;
        }).join("");
        highlightCurrentSong();
    }

    // ============================================================
    // 播放模式
    // ============================================================
    function setPlayMode(mode) {
        state.playMode = mode;
        localStorage.setItem(MODE_KEY, mode);
        dom.modeBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === mode));
        const names = {
            sequence: "顺序播放",
            shuffle: "随机播放",
            repeat: "单曲循环"
        };
        showToast(names[mode]);
    }

    // ============================================================
    // 明暗主题
    // ============================================================
    function applyTheme(theme) {
        if (theme === "light") {
            document.body.classList.add("light-theme");
            dom.themeIconDark.style.display = "none";
            dom.themeIconLight.style.display = "block";
        } else {
            document.body.classList.remove("light-theme");
            dom.themeIconDark.style.display = "block";
            dom.themeIconLight.style.display = "none";
        }
    }

    function toggleTheme() {
        const isLight = document.body.classList.contains("light-theme");
        const newTheme = isLight ? "dark" : "light";
        applyTheme(newTheme);
        localStorage.setItem(THEME_KEY, newTheme);
        showToast(newTheme === "light" ? "亮色模式" : "暗色模式");
    }

    // ============================================================
    // 进度 & 音量
    // ============================================================
    function seekTo(clientX) {
        const rect = dom.progressBar.getBoundingClientRect();
        let percent = (clientX - rect.left) / rect.width;
        percent = Math.max(0, Math.min(1, percent));
        const duration = dom.audio.duration || 0;
        if (duration > 0) {
            dom.audio.currentTime = percent * duration;
            dom.progressFill.style.width = percent * 100 + "%";
        }
    }

    function setVolume(clientX) {
        const rect = dom.volumeBar.getBoundingClientRect();
        let percent = (clientX - rect.left) / rect.width;

        percent = Math.max(0, Math.min(1, percent));
        dom.audio.volume = percent;
        dom.volumeFill.style.width = percent * 100 + "%";
        localStorage.setItem(VOLUME_KEY, percent.toString());
        dom.audio.muted = percent === 0;
    }

    // ============================================================
    // 可拖拽分隔条（接近居中时自动吸附到正中间）
    // ============================================================
    function initResizer() {
        let isResizing = false;
        const SNAP_RANGE = 1; // 距离正中 ±3% 范围内吸附
        dom.resizer.addEventListener("mousedown", (e) => {
            isResizing = true;
            dom.resizer.classList.add("active");
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        });
        document.addEventListener("mousemove", (e) => {
            if (!isResizing) return;
            const main = document.querySelector(".main-content");
            const rect = main.getBoundingClientRect();
            const percent = ((e.clientX - rect.left) / rect.width) * 100;
            let clamped = Math.max(25, Math.min(65, percent));
            // 接近正中时自动吸附
            if (clamped >= 50 - SNAP_RANGE && clamped <= 50 + SNAP_RANGE) {
                clamped = 50;
                dom.resizer.classList.add("near-center");
            } else {
                dom.resizer.classList.remove("near-center");
            }
            dom.songPanel.style.flex = `0 0 calc(${clamped}% - 2.5px)`;
        });
        document.addEventListener("mouseup", () => {
            if (isResizing) {
                isResizing = false;
                dom.resizer.classList.remove("active");
                dom.resizer.classList.remove("near-center");
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            }
        });
    }

    // ============================================================
    // 手机端全屏歌词
    // ============================================================
    function openFullscreenLyric() {
        // 仅手机端有效（桌面端CSS隐藏了该元素）
        if (window.innerWidth > 640) return;
        // 已打开则不重复压入历史
        if (dom.fullscreenLyric.classList.contains("show")) return;
        const playerHeight = document.querySelector(".player-bar").offsetHeight;
        dom.fullscreenLyric.style.bottom = playerHeight + "px";
        void dom.fullscreenLyric.offsetHeight;
        const actualHeight = dom.fullscreenLyric.getBoundingClientRect().height;
        // 设置变量前临时禁用子元素过渡，避免变量变化本身触发 transform 动画，与 show 过渡冲突
        const animChildren = dom.fullscreenLyric.querySelectorAll(".fl-header, .fl-lyric-scroll");
        animChildren.forEach((el) => { el.style.transition = "none"; });
        dom.fullscreenLyric.style.setProperty("--lyric-page-height", actualHeight + "px");
        void dom.fullscreenLyric.offsetHeight; // 强制应用无过渡的初始状态
        animChildren.forEach((el) => { el.style.transition = ""; });
        pushPanel("lyric");
        dom.fullscreenLyric.classList.add("show");
        document.body.style.overflow = "hidden";
        // 等展开过渡（0.35s）结束后元素尺寸稳定，再滚动歌词到当前播放行
        setTimeout(() => {
            if (state.currentSong && state.lyricData.length > 0) {
                // 重置索引，避免 updateLyric 里 idx 相同直接 return 导致不滚动
                state.currentLyricIndex = -1;
                updateLyric(dom.audio.currentTime || 0);
            }
        }, 380);
    }

    function closeFullscreenLyric() {
        dom.fullscreenLyric.classList.remove("show");
    }

    // ============================================================
    // 添加到歌单模态框
    // ============================================================
    function openAddToPlaylistModal(filename) {
        state.pendingSongFilename = filename;
        if (state.playlists.length === 0) {
            dom.modalPlaylistList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">还没有歌单，请先创建</div>';
        } else {
            dom.modalPlaylistList.innerHTML = state.playlists.map((pl) =>
                `<div class="modal-playlist-item" data-playlist="${pl.id}">
                    <span class="name">${escapeHtml(pl.name)}</span>
                    <span class="count">${pl.songs.length} 首</span>
                </div>`
            ).join("");
        }
        dom.addToPlaylistModal.style.display = "flex";
    }

    function closeAddToPlaylistModal() {
        dom.addToPlaylistModal.style.display = "none";
        state.pendingSongFilename = null;
    }

    // ===== 手机端面板历史管理（返回键收起面板而非退出网页）=====
    const panelHistory = {
        lyric: false,
        playlist: false
    };

    let isClosingPanel = false; // 标记 closePanel 触发的 history.back()，避免 popstate 误关其他面板

    function pushPanel(panel) {
        if (window.innerWidth > 640) return;
        // 防重复：该面板已在历史栈中时不再 push，避免历史堆积
        if (panelHistory[panel]) return;
        panelHistory[panel] = true;
        history.pushState({
            panel
        }, "");
    }

    function closePanel(panel) {
        if (panelHistory[panel]) {
            panelHistory[panel] = false;
            isClosingPanel = true;
            history.back(); // 减少历史栈长度，使基本页面按返回可离开网页
            setTimeout(() => { isClosingPanel = false; }, 80);
        }
        if (panel === "lyric") dom.fullscreenLyric.classList.remove("show");
        if (panel === "playlist") closeSelectorDropdown();
    }

    window.addEventListener("popstate", () => {
        if (window.innerWidth > 640) return;
        // closePanel 触发的后退：UI 已同步关闭，跳过避免误关其他面板
        if (isClosingPanel) return;
        // 用户按返回键：直接检查 DOM 真实状态，关闭当前打开的最上层面板
        if (dom.fullscreenLyric.classList.contains("show")) {
            panelHistory.lyric = false;
            dom.fullscreenLyric.classList.remove("show");
            return;
        }
        if (dom.selectorDropdown.style.display === "flex") {
            panelHistory.playlist = false;
            closeSelectorDropdown();
            return;
        }
        // 没有面板打开，允许正常返回离开页面
    });

    // ============================================================
    // 事件绑定
    // ============================================================
    function bindEvents() {
        // 搜索
        dom.searchInput.addEventListener("input", () => applySortAndFilter());

        // 刷新
        dom.reloadBtn.addEventListener("click", () => {
            dom.reloadBtn.style.pointerEvents = "none";
            loadSongs(true).finally(() => {
                dom.reloadBtn.style.pointerEvents = "auto";
            });
        });

        // 主题
        dom.themeToggle.addEventListener("click", toggleTheme);

        // 排序
        dom.sortBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                handleSort(btn.dataset.field);
                if (window.innerWidth <= 640) {
                    btn.classList.add("pressed");
                    setTimeout(() => btn.classList.remove("pressed"), 180);
                }
            });
        });

        // 歌单选择器
        dom.selectorBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleSelectorDropdown();
        });
        // 全部歌曲
        dom.selectorDropdown.addEventListener("click", (e) => {
            const allItem = e.target.closest('.dropdown-item[data-playlist="all"]');
            if (allItem) {
                switchPlaylist("all");
                return;
            }
            const plItem = e.target.closest(".dropdown-item[data-playlist]");
            if (plItem && plItem.dataset.playlist !== "all") {
                // 检查是否点的删除按钮
                const removeBtn = e.target.closest(".di-remove");
                if (removeBtn) {
                    e.stopPropagation();
                    deletePlaylist(removeBtn.dataset.playlist);
                    return;
                }
                // 检查是否点的添加所有歌曲按钮
                const addAllBtn = e.target.closest(".di-add-all");
                if (addAllBtn) {
                    e.stopPropagation();
                    addAllSongsToPlaylist(addAllBtn.dataset.playlist);
                    return;
                }
                // 检查是否点的重命名按钮
                const renameBtn = e.target.closest(".di-rename");
                if (renameBtn) {
                    e.stopPropagation();
                    renamePlaylist(renameBtn.dataset.playlist);
                    return;
                }
                switchPlaylist(plItem.dataset.playlist);
            }
        });
        // 新建歌单
        dom.dropdownCreate.addEventListener("click", () => {
            dom.dropdownCreate.style.display = "none";
            dom.dropdownCreateInput.style.display = "flex";
            dom.newPlaylistInput.focus();
        });
        dom.confirmCreateBtn.addEventListener("click", () => {
            createPlaylist(dom.newPlaylistInput.value);
        });
        dom.newPlaylistInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") createPlaylist(e.target.value);
        });
        // 点击外部关闭下拉
        document.addEventListener("click", (e) => {
            if (!dom.selectorDropdown.contains(e.target) && !dom.selectorBtn.contains(e.target)) {
                closePanel("playlist");
            }
        });

        // 播放模式
        dom.modeBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                if (window.innerWidth <= 640) {
                    const modes = ["sequence", "shuffle", "repeat"];
                    const next = modes[(modes.indexOf(state.playMode) + 1) % modes.length];
                    setPlayMode(next);
                    const activeBtn = document.querySelector(".mode-btn.active");
                    if (activeBtn) {
                        activeBtn.style.background = "var(--bg-hover)";
                        activeBtn.style.transform = "scale(0.92)";
                        activeBtn.style.transition = "background 0.1s, transform 0.1s";
                        setTimeout(() => {
                            activeBtn.style.background = "";
                            activeBtn.style.transform = "";
                        }, 200);
                    }
                } else {
                    setPlayMode(btn.dataset.mode);
                }
            });
        });

        // 播放控制
        dom.playBtn.addEventListener("click", togglePlay);
        dom.prevBtn.addEventListener("click", playPrev);
        dom.nextBtn.addEventListener("click", () => playNext(false));

        // 播放栏歌单标签点击 → 切换到该歌单
        dom.playerPlaylistTag.addEventListener("click", () => {
            if (state.playingPlaylistId !== state.currentPlaylistId) {
                switchPlaylist(state.playingPlaylistId);
            }
            // 手机端：歌词页打开时一并收起
            if (window.innerWidth <= 640 && dom.fullscreenLyric.classList.contains("show")) {
                closePanel("lyric");
            }
        });

        // 唱片/歌曲信息点击 → 手机端打开全屏歌词
        dom.playerCover.addEventListener("click", openFullscreenLyric);
        dom.playerTitle.addEventListener("click", openFullscreenLyric);

        // 手机全屏歌词控制
        dom.flClose.addEventListener("click", () => closePanel("lyric"));

        // 手机端：歌词展开时点击顶部 header-left（logo/标题区域）收起歌词
        document.querySelector(".header-left").addEventListener("click", () => {
            if (window.innerWidth <= 640 && dom.fullscreenLyric.classList.contains("show")) {
                closePanel("lyric");
            }
        });

        // Audio 事件
        dom.audio.addEventListener("play", () => {
            updatePlayIcon(true);
            saveNowPlaying();
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
                // 设置位置状态，帮助 Android 控制中心识别为媒体会话并显示进度条
                try {
                    const duration = dom.audio.duration || 0;
                    if (duration > 0) {
                        navigator.mediaSession.setPositionState({
                            duration: duration,
                            playbackRate: dom.audio.playbackRate || 1,
                            position: dom.audio.currentTime || 0,
                        });
                    }
                } catch (e) { /* 不支持忽略 */ }
            }
        });
        dom.audio.addEventListener("pause", () => {
            updatePlayIcon(false);
            saveNowPlaying();
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'paused';
            }
        });
        dom.audio.addEventListener("ended", () => playNext(true));
        dom.audio.addEventListener("loadedmetadata", () => {
            dom.totalTime.textContent = formatTime(dom.audio.duration);
            // metadata 加载完成后再设置一次位置状态（此时 duration 一定有效）
            if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration: dom.audio.duration,
                        playbackRate: 1,
                        position: 0,
                    });
                } catch (e) {}
            }
        });
        dom.audio.addEventListener("error", () => {
            if (state.currentSong) showToast("音频加载失败，请检查文件是否存在");
        });

        // 进度条拖拽
        let isDraggingProgress = false;
        dom.progressBar.addEventListener("mousedown", (e) => {
            isDraggingProgress = true;
            state.isSeeking = true;
            seekTo(e.clientX);
        });
        document.addEventListener("mousemove", (e) => {
            if (isDraggingProgress) seekTo(e.clientX);
        });
        document.addEventListener("mouseup", () => {
            if (isDraggingProgress) {
                isDraggingProgress = false;
                state.isSeeking = false;
            }
        });
        dom.progressBar.addEventListener("touchstart", (e) => {
            isDraggingProgress = true;
            state.isSeeking = true;
            seekTo(e.touches[0].clientX);
        }, {
            passive: true
        });
        document.addEventListener("touchmove", (e) => {
            if (isDraggingProgress) seekTo(e.touches[0].clientX);
        }, {
            passive: true
        });
        document.addEventListener("touchend", () => {
            if (isDraggingProgress) {
                isDraggingProgress = false;
                state.isSeeking = false;
            }
        });

        // 音量
        let isDraggingVolume = false;
        dom.volumeBar.addEventListener("mousedown", (e) => {
            isDraggingVolume = true;
            setVolume(e.clientX);
        });
        document.addEventListener("mousemove", (e) => {
            if (isDraggingVolume) setVolume(e.clientX);
        });
        document.addEventListener("mouseup", () => {
            isDraggingVolume = false;
        });
        dom.volumeBar.addEventListener("touchstart", (e) => {
            isDraggingVolume = true;
            setVolume(e.touches[0].clientX);
        }, {
            passive: true
        });
        document.addEventListener("touchmove", (e) => {
            if (isDraggingVolume) setVolume(e.touches[0].clientX);
        }, {
            passive: true
        });
        document.addEventListener("touchend", () => {
            isDraggingVolume = false;
        });

        // 静音
        dom.muteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (window.innerWidth <= 640) {
                const isOpen = dom.volumePopup.classList.toggle("show");
                dom.volumePopupFill.style.height = (dom.audio.volume * 100) + "%";
                document.querySelector(".player-bar").style.zIndex = isOpen ? "9999" : "";
            } else {
                dom.audio.muted = !dom.audio.muted;
                dom.volumeFill.style.width = dom.audio.muted ? "0%" : dom.audio.volume * 100 + "%";
            }
        });

        // 竖向音量弹出框拖动（可选链，元素不存在也不报错）
        let isDraggingPopupVolume = false;

        function setPopupVolume(clientY) {
            const rect = dom.volumePopupBar.getBoundingClientRect();
            let percent = 1 - (clientY - rect.top) / rect.height;
            percent = Math.max(0, Math.min(1, percent));
            dom.audio.volume = percent;
            dom.volumePopupFill.style.height = percent * 100 + "%";
            dom.volumeFill.style.width = percent * 100 + "%";
            localStorage.setItem(VOLUME_KEY, percent.toString());
            dom.audio.muted = percent === 0;
        }
        dom.volumePopupBar?.addEventListener("mousedown", (e) => {
            isDraggingPopupVolume = true;
            setPopupVolume(e.clientY);
            e.stopPropagation();
        });
        document.addEventListener("mousemove", (e) => {
            if (isDraggingPopupVolume) setPopupVolume(e.clientY);
        });
        document.addEventListener("mouseup", () => {
            isDraggingPopupVolume = false;
        });
        dom.volumePopupBar?.addEventListener("touchstart", (e) => {
            isDraggingPopupVolume = true;
            setPopupVolume(e.touches[0].clientY);
            e.stopPropagation();
        }, {
            passive: true
        });
        document.addEventListener("touchmove", (e) => {
            if (isDraggingPopupVolume) setPopupVolume(e.touches[0].clientY);
        }, {
            passive: true
        });
        document.addEventListener("touchend", () => {
            isDraggingPopupVolume = false;
        });

        // 点击其他地方关闭音量弹出框
        document.addEventListener("click", (e) => {
            if (dom.volumePopup &&
                !dom.volumePopup.contains(e.target) &&
                e.target !== dom.muteBtn &&
                !dom.muteBtn.contains(e.target)) {
                dom.volumePopup.classList.remove("show");
                document.querySelector(".player-bar").style.zIndex = "";
            }
        });

        // 歌曲列表点击
        dom.songList.addEventListener("click", (e) => {
            // 长按拖拽结束后阻止一次误触发的 click
            if (touchSuppressClick) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            const removeBtn = e.target.closest(".remove-from-playlist");
            if (removeBtn) {
                e.stopPropagation();
                removeSongFromPlaylist(state.currentPlaylistId, removeBtn.dataset.filename);
                return;
            }
            const addBtn = e.target.closest(".add-to-playlist");
            if (addBtn) {
                e.stopPropagation();
                openAddToPlaylistModal(addBtn.dataset.filename);
                return;
            }
            const item = e.target.closest(".song-item");
            if (item) {
                const filename = item.dataset.filename;
                const song = state.songs.find((s) => s.filename === filename);
                if (song) {
                    // 点击当前正在播放的歌曲（无论播放中还是暂停中）：展开歌词，不重新播放
                    if (state.currentSong && state.currentSong.filename === filename) {
                        openFullscreenLyric();
                        return;
                    }
                    const queue = [...getPlaylistSongs(state.currentPlaylistId)];
                    const idx = queue.findIndex((s) => s.filename === filename);
                    playSong(song, queue, idx >= 0 ? idx : 0, state.currentPlaylistId);
                }
            }
        });

        // 自定义排序：歌曲列表拖拽
        dom.songList.addEventListener("dragstart", (e) => {
            if (state.sort.field !== "custom" || state.currentPlaylistId === "all") return;
            const item = e.target.closest(".song-item");
            if (!item) return;
            state.dragSrcFilename = item.dataset.filename;
            state.dragPlaylistId = state.currentPlaylistId;
            item.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
            // Firefox 等浏览器必须在 dragstart 中 setData 才能启动拖拽，不用 try-catch 吞掉错误
            e.dataTransfer.setData("text/plain", item.dataset.filename);
        });

        dom.songList.addEventListener("dragover", (e) => {
            if (state.sort.field !== "custom") return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const item = e.target.closest(".song-item");
            if (!item) return;
            dom.songList.querySelectorAll(".song-item.drag-over").forEach((el) => {
                if (el !== item) el.classList.remove("drag-over");
            });
            item.classList.add("drag-over");
        });
        dom.songList.addEventListener("dragleave", (e) => {
            const item = e.target.closest(".song-item");
            if (item && !item.contains(e.relatedTarget)) item.classList.remove("drag-over");
        });
        dom.songList.addEventListener("drop", (e) => {
            if (state.sort.field !== "custom") return;
            e.preventDefault();
            const targetItem = e.target.closest(".song-item");
            dom.songList.querySelectorAll(".song-item.drag-over").forEach((el) => el.classList.remove("drag-over"));
            if (!targetItem || !state.dragSrcFilename) return;
            const targetFilename = targetItem.dataset.filename;
            if (targetFilename === state.dragSrcFilename) {
                state.dragSrcFilename = null;
                return;
            }
            // 始终插入到目标歌曲的上一个位置
            reorderPlaylistSongs(state.currentPlaylistId, state.dragSrcFilename, targetFilename, true);
            state.dragSrcFilename = null;
        });
        dom.songList.addEventListener("dragend", (e) => {
            const item = e.target.closest(".song-item");
            if (item) item.classList.remove("dragging");
            dom.songList.querySelectorAll(".song-item.drag-over").forEach((el) => el.classList.remove("drag-over"));
            state.dragSrcFilename = null;
            state.dragPlaylistId = null;
        });

        // ============================================================
        // 手机端触摸拖拽排序（HTML5 Drag API 在触摸设备上不可用）
        // ============================================================
        let touchTimer = null;
        let touchDragActive = false;
        let touchSrcFilename = null;
        let touchStartY = 0;
        let touchMoved = false;
        let touchSuppressClick = false;

        const clearTouchDrag = () => {
            if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
            touchDragActive = false;
            touchSrcFilename = null;
            touchMoved = false;
            dom.songList.querySelectorAll(".song-item.dragging, .song-item.drag-over").forEach((el) => {
                el.classList.remove("dragging", "drag-over");
            });
        };

        // 仅触摸设备绑定触摸拖拽，电脑端走 HTML5 Drag API，互不影响
        const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        if (isTouchDevice) {
            dom.songList.addEventListener("touchstart", (e) => {
                if (state.sort.field !== "custom" || state.currentPlaylistId === "all") return;
                const item = e.target.closest(".song-item");
                if (!item) return;
                touchStartY = e.touches[0].clientY;
                touchMoved = false;
                touchSrcFilename = item.dataset.filename;
                touchTimer = setTimeout(() => {
                    touchDragActive = true;
                    item.classList.add("dragging");
                    if (navigator.vibrate) navigator.vibrate(30);
                }, 300);
            }, { passive: true });

            dom.songList.addEventListener("touchmove", (e) => {
                if (!touchSrcFilename) return;
                const dy = Math.abs(e.touches[0].clientY - touchStartY);
                // 未激活拖拽时，移动超过 10px 视为滚动，取消长按
                if (!touchDragActive) {
                    if (dy > 10) {
                        if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
                        touchSrcFilename = null;
                    }
                    return;
                }
                // 拖拽中：阻止页面滚动，更新插入位置指示
                e.preventDefault();
                touchMoved = true;
                const touch = e.touches[0];
                const el = document.elementFromPoint(touch.clientX, touch.clientY);
                const targetItem = el ? el.closest(".song-item") : null;
                dom.songList.querySelectorAll(".song-item.drag-over").forEach((old) => {
                    if (old !== targetItem) old.classList.remove("drag-over");
                });
                if (targetItem && targetItem.dataset.filename !== touchSrcFilename) {
                    targetItem.classList.add("drag-over");
                }
            }, { passive: false });

            dom.songList.addEventListener("touchend", (e) => {
                if (!touchSrcFilename && !touchDragActive) return;
                if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
                if (touchDragActive) {
                    const touch = e.changedTouches[0];
                    const el = document.elementFromPoint(touch.clientX, touch.clientY);
                    const targetItem = el ? el.closest(".song-item") : null;
                    dom.songList.querySelectorAll(".song-item.drag-over").forEach((old) => old.classList.remove("drag-over"));
                    if (targetItem && targetItem.dataset.filename !== touchSrcFilename) {
                        // 始终插入到目标歌曲的上一个位置
                        reorderPlaylistSongs(state.currentPlaylistId, touchSrcFilename, targetItem.dataset.filename, true);
                    }
                    // 拖拽激活后 touchend 会触发 click，阻止一次
                    touchSuppressClick = true;
                    setTimeout(() => { touchSuppressClick = false; }, 300);
                }
                clearTouchDrag();
            });

            dom.songList.addEventListener("touchcancel", clearTouchDrag);
        }

        // 添加到歌单模态框
        dom.modalPlaylistList.addEventListener("click", (e) => {
            const item = e.target.closest(".modal-playlist-item");
            if (item && state.pendingSongFilename) {
                addSongToPlaylist(item.dataset.playlist, state.pendingSongFilename);
                closeAddToPlaylistModal();
            }
        });
        dom.closeModalBtn.addEventListener("click", closeAddToPlaylistModal);
        dom.addToPlaylistModal.addEventListener("click", (e) => {
            if (e.target === dom.addToPlaylistModal) closeAddToPlaylistModal();
        });

        // 键盘快捷键
        document.addEventListener("keydown", (e) => {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
            if (e.code === "Space") {
                e.preventDefault();
                togglePlay();
            } else if (e.code === "ArrowRight") {
                playNext(false);
            } else if (e.code === "ArrowLeft") {
                playPrev();
            }
        });

        window.addEventListener("beforeunload", saveNowPlaying);
    }

    // ============================================================
    // 手机端：锁定 body 高度为键盘弹出前的视口高度，防止键盘挤压布局
    // ============================================================
    function lockViewportHeight() {
        if (window.innerWidth > 640) return;
        let lockedH = window.innerHeight;
        let lastVVH = window.innerHeight;
        let recoverTimer = null;
        const apply = () => { document.body.style.height = lockedH + "px"; };
        apply();
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", () => {
                const vv = window.visualViewport;
                const goingDown = vv.height < lastVVH; // 高度变小 = 键盘正在弹出
                lastVVH = vv.height;
                if (goingDown) {
                    // 键盘弹出过程中绝不更新锁定高度，防止误判导致瞬间空白
                    clearTimeout(recoverTimer);
                    return;
                }
                // 键盘正在收起：阈值收紧到 30px，且等 300ms 动画结束后再更新
                if (vv.height >= lockedH - 30) {
                    clearTimeout(recoverTimer);
                    recoverTimer = setTimeout(() => {
                        lockedH = window.innerHeight;
                        apply();
                    }, 300);
                }
            });
        }
        window.addEventListener("orientationchange", () => {
            setTimeout(() => {
                lockedH = window.innerHeight;
                lastVVH = window.innerHeight;
                apply();
            }, 300);
        });
    }

    // ============================================================
    // 下拉菜单 tooltip：渲染到 body（只作用于 .selector-dropdown，其他 tooltip 不受影响）
    // ============================================================
    function initDropdownTooltips() {
        const removeTips = () => document.querySelectorAll(".js-tooltip").forEach((el) => el.remove());
        document.addEventListener("mouseover", (e) => {
            const target = e.target.closest(".selector-dropdown [data-tooltip]");
            if (!target) return;
            const text = target.dataset.tooltip;
            if (!text) return;
            removeTips();
            const tipEl = document.createElement("div");
            tipEl.className = "js-tooltip";
            tipEl.textContent = text;
            document.body.appendChild(tipEl);
            const rect = target.getBoundingClientRect();
            const tipRect = tipEl.getBoundingClientRect();
            let left = rect.left + rect.width / 2 - tipRect.width / 2;
            let top = rect.top - tipRect.height - 8; // 默认显示在按钮上方
            left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
            if (top < 8) top = rect.bottom + 8; // 上方空间不够则显示在下方
            tipEl.style.left = left + "px";
            tipEl.style.top = top + "px";
        });
        document.addEventListener("mouseout", (e) => {
            if (e.target.closest(".selector-dropdown [data-tooltip]")) removeTips();
        });
    }

    // ============================================================
    // 初始化
    // ============================================================
    async function init() {
        lockViewportHeight();
        initDropdownTooltips();
        // 主题
        const savedTheme = localStorage.getItem(THEME_KEY);
        applyTheme(savedTheme === "light" ? "light" : "dark");

        // 播放模式
        const savedMode = localStorage.getItem(MODE_KEY);
        if (savedMode && ["sequence", "shuffle", "repeat"].includes(savedMode)) {
            state.playMode = savedMode;
            dom.modeBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === savedMode));
        }

        // 音量
        const savedVolume = localStorage.getItem(VOLUME_KEY);
        if (savedVolume !== null) {
            const v = parseFloat(savedVolume);
            dom.audio.volume = isNaN(v) ? 0.7 : v;
            dom.volumeFill.style.width = (isNaN(v) ? 0.7 : v) * 100 + "%";
        } else {
            dom.audio.volume = 0.7;
        }

        loadPlaylists();
        renderPlaylistDropdown();
        bindEvents();
        initResizer();
        updateSortButtons();
        updateSelectorCounts();
        startRafLoop();

        await loadSongs();
        restoreNowPlaying();

        // PWA：监听 Service Worker 发来的恢复音频消息（后台被挂起时由 SW 唤醒）
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'RESUME_AUDIO') {
                    if (state.currentSong && dom.audio.paused && !dom.audio.ended) {
                        dom.audio.play().catch(() => {});
                    }
                }
            });
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();