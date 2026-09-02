/* ============================================================
   STATE
============================================================ */
const S = {
    videoUrl: null,
    audioUrl: null,
    images: [],
    caption: '',
    theme: localStorage.getItem('tt-theme') || 'dark',
    pwaPrompt: null,
    progressTimer: null,
    fetchTimer: null,
    copyCount: 0,
    userRating: 0,
    history: JSON.parse(localStorage.getItem('tt-history') || '[]'),
    currentData: null
};

/* ============================================================
   URL RESOLUTION (FIX: TikWM often returns relative paths like
   "/video/media/hdplay/xxx.mp4" instead of full URLs. Without
   resolving these against the TikWM host, the browser resolves
   them against OUR domain instead, which 404s and silently
   breaks the <video>/<img>/<audio> preview. This was the root
   cause of "video preview does not appear".)
============================================================ */
const TIKWM_HOST = 'https://www.tikwm.com';

function resolveTikwmUrl(u) {
    if (!u || typeof u !== 'string') return null;
    if (/^https?:\/\//i.test(u)) return u;      // already absolute
    if (u.startsWith('//')) return 'https:' + u; // protocol-relative
    if (u.startsWith('/')) return TIKWM_HOST + u; // relative path
    return u;
}

// FIX: TikWM sometimes returns http:// links. Your page is served over
// https://, and a browser will silently block (or auto-upgrade-and-fail)
// an http:// video/audio request from an https:// page — this shows a
// poster/frame but the file never actually plays. Force https here.
function forceHttps(u) {
    if (!u) return u;
    return u.replace(/^http:\/\//i, 'https://');
}

function cleanMediaUrl(u) {
    return forceHttps(resolveTikwmUrl(u));
}

/* Build an ordered, deduped list of every video URL TikWM gave us
   (HD, standard, watermarked) so we can fall back automatically if
   one CDN link is blocked/throttled while another still works.
   Used for the "Download Video" button, where HD quality matters. */
function videoCandidates(data) {
    return [data.hdplay, data.play, data.wmplay]
        .map(cleanMediaUrl)
        .filter((u, i, all) => u && all.indexOf(u) === i);
}

/* Same links, but reordered smallest/fastest-first for the on-page
   PREVIEW specifically. The preview doesn't need HD — prioritizing the
   smaller standard-res files means less data has to arrive before
   playback can start, which is the single biggest lever on load time. */
function previewVideoCandidates(data) {
    return [data.play, data.wmplay, data.hdplay]
        .map(cleanMediaUrl)
        .filter((u, i, all) => u && all.indexOf(u) === i);
}

/* Warms up the DNS/TLS connection to a URL's origin the moment we know
   it, so the browser isn't starting that handshake from zero when we
   actually assign it as a video src a moment later. */
function preconnectTo(url) {
    try {
        const origin = new URL(url).origin;
        if (document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = origin;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
    } catch (e) { /* ignore invalid URLs */ }
}

/* Races several candidate URLs at once using hidden probe <video>
   elements, resolving with whichever becomes playable first instead of
   trying candidates one at a time. This is the main speed win: if the
   fastest CDN link responds in 300ms, we don't waste time waiting out a
   slow/dead one first. */
function raceNativeCandidates(candidates, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!candidates.length) { reject(new Error('no candidates')); return; }
        let settled = false;
        let failCount = 0;
        const probes = candidates.map(url => {
            const probe = document.createElement('video');
            probe.preload = 'auto';
            probe.muted = true;
            probe.playsInline = true;
            probe.style.display = 'none';
            probe.src = url;
            probe.load();
            probe.oncanplay = () => finish(url);
            probe.onerror = fail;
            return probe;
        });
        function cleanup() {
            probes.forEach(p => { p.oncanplay = null; p.onerror = null; try { p.src = ''; p.load(); } catch (e) {} p.remove(); });
        }
        function finish(url) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve(url);
        }
        function fail() {
            failCount++;
            if (failCount >= probes.length && !settled) {
                settled = true;
                clearTimeout(timer);
                cleanup();
                reject(new Error('all candidates errored'));
            }
        }
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('timeout'));
        }, timeoutMs);
    });
}

/* Fetches a candidate video fully with a hard timeout (so a slow/blocked
   mobile connection can't hang forever) and plays it from a local blob URL.
   Used only as a fallback when native streaming (below) doesn't pan out. */
async function fetchVideoBlob(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { mode: 'cors', signal: controller.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        if (!blob || blob.size < 1000) throw new Error('Empty/invalid response (size ' + (blob && blob.size) + ')');
        return blob;
    } finally {
        clearTimeout(timer);
    }
}

function setVideoLoadingHint(videoWrap, show) {
    let hint = videoWrap.querySelector('.vw-loading-hint');
    if (show) {
        if (!hint) {
            hint = document.createElement('div');
            hint.className = 'vw-loading-hint';
            hint.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);color:#fff;font-size:0.8rem;font-weight:600;pointer-events:none;z-index:2;';
            hint.textContent = 'Loading preview…';
            if (getComputedStyle(videoWrap).position === 'static') videoWrap.style.position = 'relative';
            videoWrap.appendChild(hint);
        }
    } else if (hint) {
        hint.remove();
    }
}

/* Poster/thumbnail sometimes fails too — verify it actually loads before
   assigning it, and fall back to an alternate cover field if it doesn't,
   instead of leaving a blank/broken poster. */
function setPosterWithFallback(videoEl, data) {
    const candidates = [data.cover, data.origin_cover, data.ai_dynamic_cover, data.dynamic_cover]
        .map(cleanMediaUrl)
        .filter((u, i, all) => u && all.indexOf(u) === i);
    let i = 0;
    (function tryNext() {
        if (i >= candidates.length) return;
        const url = candidates[i++];
        const probe = new Image();
        probe.onload = () => { videoEl.poster = url; };
        probe.onerror = () => tryNext();
        probe.src = url;
    })();
}

/* Race-first strategy for speed:
   STAGE 1 — Race every candidate at once via hidden probes (see
   raceNativeCandidates). Whichever CDN link responds first wins — we
   don't wait out a dead one before trying the next. Tight 1.2s timeout:
   if nothing is playable that fast, something's blocked, so bail early
   instead of waiting it out.
   STAGE 2 — Continuous mid-playback stall watch (unchanged from before):
   catches the "first frame loads, then freezes" case.
   STAGE 3 — Full-fetch blob fallback, only if racing + stall-recovery
   both fail. Tries the smallest/fastest variant first (candidates are
   already ordered that way by previewVideoCandidates) with an 8s cap
   per source. */
function playVideoFast(videoEl, videoWrap, candidates, onAllFailed) {
    if (videoEl.dataset.blobUrl) {
        URL.revokeObjectURL(videoEl.dataset.blobUrl);
        delete videoEl.dataset.blobUrl;
    }
    candidates.forEach(preconnectTo);
    setVideoLoadingHint(videoWrap, true);

    let escalated = false;
    let usingBlob = false;
    let stallTimer = null;

    function clearStallTimer() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }

    function armStallWatch() {
        clearStallTimer();
        stallTimer = setTimeout(() => {
            if (escalated || usingBlob) return;
            console.warn('[TikTok Downloader] Playback stalled mid-stream at', videoEl.currentTime, '- escalating to full-fetch fallback.');
            escalated = true;
            tryBlobFallback();
        }, 2500);
    }

    function attachPlayingSource(url) {
        videoEl.onerror = null;
        videoEl.oncanplay = null;
        videoEl.onwaiting = armStallWatch;
        videoEl.onstalled = armStallWatch;
        videoEl.onplaying = clearStallTimer;
        setVideoLoadingHint(videoWrap, false);
        console.log('[TikTok Downloader] Playing from:', url);
    }

    console.log(`[TikTok Downloader] Racing ${candidates.length} source(s) in parallel...`);
    raceNativeCandidates(candidates, 1200)
        .then(winnerUrl => {
            if (escalated) return;
            videoEl.src = winnerUrl;
            videoEl.load();
            attachPlayingSource(winnerUrl);
        })
        .catch(err => {
            if (escalated) return;
            console.warn('[TikTok Downloader] Native race failed/timed out:', err.message, '- trying full-fetch fallback...');
            tryBlobFallback();
        });

    async function tryBlobFallback() {
        if (usingBlob) return;
        usingBlob = true;
        clearStallTimer();
        setVideoLoadingHint(videoWrap, true);
        for (let j = 0; j < candidates.length; j++) {
            const url = candidates[j];
            try {
                console.log(`[TikTok Downloader] Fetching video (fallback ${j + 1}/${candidates.length}):`, url);
                const blob = await fetchVideoBlob(url, 8000);
                const objectUrl = URL.createObjectURL(blob);
                videoEl.dataset.blobUrl = objectUrl;
                videoEl.onerror = null;
                videoEl.oncanplay = null;
                videoEl.onwaiting = null;
                videoEl.onstalled = null;
                videoEl.onplaying = null;
                videoEl.src = objectUrl;
                videoEl.load();
                setVideoLoadingHint(videoWrap, false);
                console.log('[TikTok Downloader] Preview loaded via fallback fetch, size:', blob.size, 'type:', blob.type);
                return;
            } catch (err) {
                console.warn(`[TikTok Downloader] Fallback source ${j + 1} failed:`, err && err.message ? err.message : err);
            }
        }
        setVideoLoadingHint(videoWrap, false);
        console.warn('[TikTok Downloader] All video sources failed (native + fallback):', candidates);
        onAllFailed();
    }
}

/* ============================================================
   AUTO THEME SYSTEM
============================================================ */
const AutoTheme = (() => {
    const CFG = {
        dayStart: 6, nightStart: 20,
        manualKey: 'tt-theme-manual',
        manualExpiryKey: 'tt-theme-manual-expiry',
        manualDuration: 6 * 60 * 60 * 1000,
        checkInterval: 60 * 1000
    };
    let _timer = null, _mq = null, _lastAuto = null;

    function _hour() { return new Date().getHours(); }
    function _timeTheme() { const h = _hour(); return (h >= CFG.dayStart && h < CFG.nightStart) ? 'light' : 'dark'; }
    function _sysTheme() {
        if (!window.matchMedia) return null;
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
        return null;
    }
    function _autoTheme() { return _sysTheme() || _timeTheme(); }
    function _isManual() {
        const m = localStorage.getItem(CFG.manualKey);
        const e = localStorage.getItem(CFG.manualExpiryKey);
        if (!m || !e) return false;
        if (Date.now() > parseInt(e)) {
            localStorage.removeItem(CFG.manualKey);
            localStorage.removeItem(CFG.manualExpiryKey);
            return false;
        }
        return true;
    }
    function _apply(theme, src) {
        const cur = document.documentElement.getAttribute('data-theme');
        if (cur === theme) return;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('tt-theme', theme);
        S.theme = theme;
        const e = document.getElementById('ttEmoji');
        if (e) e.textContent = theme === 'dark' ? '🌙' : '☀️';
        if (src === 'auto-switch') {
            showToast(theme === 'dark' ? '🌙 Dark Mode' : '☀️ Light Mode',
                theme === 'dark' ? 'Switched automatically. Good evening!' : 'Switched automatically. Good morning!', 'info');
        }
    }
    function _check(src) {
        if (_isManual()) return;
        const a = _autoTheme();
        if (a !== _lastAuto) { _lastAuto = a; _apply(a, src); }
    }
    return {
        init() {
            // NOTE: theme is now also set synchronously in <head> (see index.html)
            // to avoid a flash of the wrong theme before this script runs.
            if (_isManual()) {
                _apply(localStorage.getItem(CFG.manualKey), 'manual-restore');
            } else {
                const a = _autoTheme();
                _lastAuto = a; _apply(a, 'auto-init');
            }
            if (window.matchMedia) {
                _mq = window.matchMedia('(prefers-color-scheme: dark)');
                const handler = () => { if (!_isManual()) { const a = _autoTheme(); _lastAuto = a; _apply(a, 'system'); } };
                _mq.addEventListener ? _mq.addEventListener('change', handler) : _mq.addListener(handler);
            }
            _timer = setInterval(() => _check('auto-switch'), CFG.checkInterval);
        },
        onManual(theme) {
            localStorage.setItem(CFG.manualKey, theme);
            localStorage.setItem(CFG.manualExpiryKey, (Date.now() + CFG.manualDuration).toString());
            _apply(theme, 'manual');
            showToast(`${theme === 'dark' ? '🌙' : '☀️'} ${theme === 'dark' ? 'Dark' : 'Light'} Mode`,
                'Preference saved for 6 hours. Auto mode resumes after.', 'success');
        },
        getStatus() {
            return { current: document.documentElement.getAttribute('data-theme'), auto: _autoTheme(), hour: _hour(), isManual: _isManual() };
        }
    };
})();

/* ============================================================
   INIT
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
    AutoTheme.init();
    document.getElementById('footerYear').textContent = new Date().getFullYear();

    const urlInput = document.getElementById('tiktokUrl');
    urlInput.addEventListener('input', onInput);
    urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchTikTok(); });
    syncCaptionLayout();
    window.addEventListener('resize', syncCaptionLayout);

    document.querySelectorAll('.faq-q').forEach(q => {
        q.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFaq(q); } });
    });
    document.getElementById('themeToggle').addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTheme(); }
    });

    window.addEventListener('scroll', () => {
        document.getElementById('mainNav').classList.toggle('scrolled', window.scrollY > 40);
        document.getElementById('scrollTopBtn').classList.toggle('show', window.scrollY > 400);
    }, { passive: true });

    document.querySelectorAll('a[href^="#"]').forEach(a => {
        a.addEventListener('click', e => {
            const t = document.querySelector(a.getAttribute('href'));
            if (t) { e.preventDefault(); t.scrollIntoView(); }
        });
    });

    document.getElementById('hamburgerBtn').addEventListener('click', () => {
        const nl = document.getElementById('navLinks');
        const open = nl.classList.toggle('open');
        document.getElementById('hamburgerBtn').setAttribute('aria-expanded', open);
    });

    // Star hover effects
    document.querySelectorAll('.star-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            const val = parseInt(btn.dataset.star);
            document.querySelectorAll('.star-btn').forEach(s => {
                s.classList.toggle('hover', parseInt(s.dataset.star) <= val);
            });
        });
        btn.addEventListener('mouseleave', () => {
            document.querySelectorAll('.star-btn').forEach(s => s.classList.remove('hover'));
            updateStars(S.userRating);
        });
    });

    initStats();
    renderHistory();

    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.pwaPrompt = e; });

    console.log('%c🎵 TikTok Downloader · tiktokvideodownload.app · by Dilawar Pro', 'background:#6C3EF4;color:#fff;padding:8px 18px;border-radius:8px;font-weight:700;');
    window.AutoTheme = AutoTheme;
});

function syncCaptionLayout() {
    const caption = document.getElementById('captionCard');
    const previewColumn = document.getElementById('mp3');
    const captionsColumn = document.getElementById('captions');
    if (!caption || !previewColumn || !captionsColumn) return;
    if (window.innerWidth <= 991) previewColumn.appendChild(caption);
    else captionsColumn.appendChild(caption);
}

/* ============================================================
   THEME
============================================================ */
function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    AutoTheme.onManual(cur === 'dark' ? 'light' : 'dark');
}

/* ============================================================
   ANNOUNCE BAR
============================================================ */
function closeAnnounceBar() {
    const bar = document.getElementById('announceBar');
    bar.style.maxHeight = bar.offsetHeight + 'px';
    bar.style.overflow = 'hidden';
    bar.style.transition = 'max-height 0.4s ease, padding 0.4s ease, opacity 0.3s ease';
    requestAnimationFrame(() => {
        bar.style.maxHeight = '0';
        bar.style.padding = '0';
        bar.style.opacity = '0';
    });
    setTimeout(() => bar.remove(), 400);
}

/* ============================================================
   INSTALL PWA
============================================================ */
function handleInstall() {
    if (S.pwaPrompt) {
        S.pwaPrompt.prompt();
        S.pwaPrompt.userChoice.then(r => {
            if (r.outcome === 'accepted') showToast('Installed!', 'TikTok Downloader added to your home screen.', 'success');
            S.pwaPrompt = null;
        });
    } else {
        showToast('Install TikTok Downloader', 'Tap your browser menu → "Add to Home Screen" to install.', 'info');
    }
}

/* ============================================================
   INPUT
============================================================ */
function onInput() {
    const val = this.value.trim();
    document.getElementById('clearBtn').style.display = val ? 'flex' : 'none';
    document.querySelector('.btn-paste').style.display = val ? 'none' : 'flex';
    if (!val) { this.className = 'url-input'; return; }
    const ok = val.includes('tiktok.com') || val.includes('vm.tiktok.com') || val.includes('vt.tiktok.com');
    this.className = 'url-input ' + (ok ? 'valid' : 'invalid');
}

function clearInput() {
    const el = document.getElementById('tiktokUrl');
    el.value = ''; el.className = 'url-input';
    document.getElementById('clearBtn').style.display = 'none';
    document.querySelector('.btn-paste').style.display = 'flex';
    el.focus();
}

async function pasteURL() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            document.getElementById('tiktokUrl').value = text;
            document.getElementById('tiktokUrl').dispatchEvent(new Event('input'));
            showToast('Pasted!', text.includes('tiktok') ? 'TikTok URL pasted.' : 'Content pasted. Please verify the URL.', 'success');
        } else {
            showToast('Empty Clipboard', 'Nothing in clipboard.', 'error');
        }
    } catch {
        showToast('Permission Denied', 'Allow clipboard access or paste manually (Ctrl+V).', 'error');
    }
}

function setExample(type) {
    const urls = {
        video: 'https://www.tiktok.com/@mucaash4q/video/7621241062966742292?is_from_webapp=1&sender_device=pc',
        audio: 'https://www.tiktok.com/@soundscapehits/video/7639120823592160532?is_from_webapp=1&sender_device=pc&web_id=7631390762047309320'
    };
    document.getElementById('tiktokUrl').value = urls[type];
    document.getElementById('tiktokUrl').dispatchEvent(new Event('input'));
    showToast('Example URL Set!', 'Click Download to test the tool.', 'info');
}

function scrollToHistory() {
    document.getElementById('history-section').scrollIntoView();
}

/* ============================================================
   SCROLL TO TOP
============================================================ */
function scrollToTop() {
    window.scrollTo(0, 0);
}

/* ============================================================
   STATS COUNTER
============================================================ */
function initStats() {
    const obs = new IntersectionObserver(entries => {
        entries.forEach(e => { if (e.isIntersecting) { countUp(e.target); obs.unobserve(e.target); } });
    }, { threshold: 0.5 });
    document.querySelectorAll('[data-target]').forEach(el => obs.observe(el));
}

function countUp(el) {
    const target = parseInt(el.dataset.target);
    const suffix = el.dataset.suffix || '';
    let cur = 0;
    const step = target / (1800 / 16);
    const t = setInterval(() => {
        cur = Math.min(cur + step, target);
        el.textContent = Math.floor(cur) + suffix;
        if (cur >= target) clearInterval(t);
    }, 16);
}

/* ============================================================
   PROGRESS
============================================================ */
function startProgress() {
    document.getElementById('progressSection').style.display = 'block';
    document.getElementById('progressFill').style.width = '0%';
    const steps = [
        {p:15, t:'Connecting to servers...'},
        {p:32, t:'Fetching video data...'},
        {p:55, t:'Extracting caption...'},
        {p:74, t:'Processing content...'},
        {p:90, t:'Preparing download links...'}
    ];
    let i = 0;
    clearInterval(S.progressTimer);
    S.progressTimer = setInterval(() => {
        if (i < steps.length) {
            document.getElementById('progressFill').style.width = steps[i].p + '%';
            document.getElementById('progressLabel').textContent = steps[i].t;
            document.getElementById('progressPct').textContent = steps[i].p + '%';
            i++;
        }
    }, 550);
}

function finishProgress() {
    clearInterval(S.progressTimer);
    document.getElementById('progressFill').style.width = '100%';
    document.getElementById('progressLabel').textContent = 'Done!';
    document.getElementById('progressPct').textContent = '100%';
    setTimeout(() => { document.getElementById('progressSection').style.display = 'none'; }, 700);
}

function resetProgress() {
    clearInterval(S.progressTimer);
    document.getElementById('progressSection').style.display = 'none';
}

/* ============================================================
   FETCH TIKTOK
============================================================ */
async function fetchTikTok() {
    const url = document.getElementById('tiktokUrl').value.trim();
    if (!url) { showToast('URL Required', 'Paste a TikTok video URL first.', 'error'); document.getElementById('tiktokUrl').focus(); return; }
    if (!url.includes('tiktok.com')) { showToast('Invalid URL', 'Please enter a valid TikTok URL.', 'error'); return; }

    setLoading(true); hideResult(); startProgress();

    if (S.fetchTimer) clearTimeout(S.fetchTimer);
    S.fetchTimer = setTimeout(() => { setLoading(false); resetProgress(); showToast('Timeout', 'Request timed out. Try again.', 'error'); }, 30000);

    try {
        const res = await fetch(`${TIKWM_HOST}/api/?url=${encodeURIComponent(url)}&hd=1`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        clearTimeout(S.fetchTimer);
        // FIX: TikWM returns { code: 0, data: {...} } on success and
        // { code: -1, msg: "..." } (data can be missing/null) on failure.
        // The previous check only looked at json.data.play/images, which
        // threw a confusing error instead of surfacing the real API message.
        if (json && json.code === 0 && json.data && (json.data.play || json.data.hdplay || (json.data.images && json.data.images.length))) {
            processData(json.data, url);
        } else {
            throw new Error((json && json.msg) || 'No data');
        }
    } catch (err) {
        clearTimeout(S.fetchTimer);
        try { await fetchBackup(url); }
        catch { setLoading(false); resetProgress(); showToast('Failed', 'Could not load this TikTok. Check the URL and try again.', 'error'); }
    }
}

async function fetchBackup(url) {
    const res = await fetch(`https://api.tikmate.app/api/lookup?url=${encodeURIComponent(url)}`);
    const json = await res.json();
    if (json && json.id) {
        processData({
            play: `https://tikmate.app/download/${json.token}/${json.id}.mp4`,
            music: json.musicUrl || null,
            title: json.desc || '',
            author: { nickname: json.author || 'TikTok User' },
            duration: json.duration || 0,
            images: []
        }, url);
    } else throw new Error('Backup failed');
}

/* ============================================================
   PROCESS DATA
============================================================ */
function processData(data, originalUrl) {
    S.images = normalizeImages(data.images);
    S.caption = data.title || '';
    // FIX: resolve possibly-relative + http:// TikWM URLs (see cleanMediaUrl
    // above). This is the fix for the video preview not appearing/playing.
    const vCandidates = videoCandidates(data);           // HD-first, for the Download button
    const previewCandidates = previewVideoCandidates(data); // fastest-first, for the inline preview
    S.videoUrl = vCandidates[0] || null; // used by the "Download Video" button
    S.audioUrl = cleanMediaUrl(data.music || (data.music_info && data.music_info.play) || null);
    S.currentData = data;
    S.copyCount = 0;

    // Caption
    const captionEl = document.getElementById('captionArea');
    captionEl.value = S.caption || 'No caption found for this video.';
    document.getElementById('charCount').textContent = S.caption ? `${S.caption.length} characters` : '';
    document.getElementById('copyCountBadge').style.display = 'none';

    // Video Info
    const author = data.author ? (data.author.nickname || data.author.unique_id || 'Unknown') : 'Unknown';
    document.getElementById('infoAuthor').textContent = '@' + author;
    document.getElementById('infoDuration').textContent = fmtDur(data.duration);
    document.getElementById('infoLikes').textContent = fmtNum(data.digg_count);
    document.getElementById('infoViews').textContent = fmtNum(data.play_count);
    document.getElementById('videoInfoCard').style.display = 'block';

    // Preview
    const videoWrap = document.getElementById('videoWrap');
    const videoEl = document.getElementById('tiktokVideo');
    const slideshowWrap = document.getElementById('slideshowWrap');
    const placeholder = document.getElementById('previewPlaceholder');

    videoWrap.style.display = 'none';
    slideshowWrap.style.display = 'none';
    placeholder.style.display = 'none';
    videoEl.onerror = null;
    videoEl.oncanplay = null;
    videoEl.onwaiting = null;
    videoEl.onstalled = null;
    videoEl.onplaying = null;
    setVideoLoadingHint(videoWrap, false);
    if (videoEl.dataset.blobUrl) { URL.revokeObjectURL(videoEl.dataset.blobUrl); delete videoEl.dataset.blobUrl; }
    videoEl.removeAttribute('poster');
    videoEl.src = '';
    videoEl.load();
    videoEl.pause();
    videoEl.currentTime = 0;

    if (S.images.length > 0) {
        document.getElementById('contentBadge').textContent = `📸 ${S.images.length} Images`;
        buildSlides(S.images);
        slideshowWrap.style.display = 'block';
        document.getElementById('btnMp4').style.display = 'none';
        document.getElementById('btnAllImg').style.display = 'flex';
        document.getElementById('btnAllImgSub').textContent = `${S.images.length} slides · Save all at once`;
    } else if (previewCandidates.length > 0) {
        document.getElementById('contentBadge').textContent = '🎬 HD Video';
        setPosterWithFallback(videoEl, data);
        videoWrap.style.display = 'block';
        document.getElementById('btnMp4').style.display = 'flex';
        document.getElementById('btnAllImg').style.display = 'none';

        // FIX: race all candidates in parallel (fastest response wins),
        // preferring the smaller/faster variant for the preview specifically,
        // with tight timeouts and continuous stall-recovery.
        playVideoFast(videoEl, videoWrap, previewCandidates, () => {
            videoWrap.style.display = 'none';
            placeholder.style.display = 'block';
            document.getElementById('btnMp4').style.display = 'none';
            showToast('Preview Unavailable', 'This video could not be loaded for preview (open DevTools → Console for details). The Download button may still work.', 'error');
        });
    } else {
        placeholder.style.display = 'block';
    }

    document.getElementById('btnMp3').style.display = S.audioUrl ? 'flex' : 'none';

    // Save to history
    saveToHistory(data, originalUrl);

    // Reset rating
    S.userRating = 0;
    updateStars(0);
    document.getElementById('ratingLabel').textContent = 'Click a star to rate';

    finishProgress();
    setLoading(false);
    showResult();
    showToast('Success!', 'TikTok content fetched. Caption ready to copy!', 'success');
    setTimeout(() => { document.getElementById('resultSection').scrollIntoView({ block: 'start' }); }, 350);
}

/* ============================================================
   SLIDESHOW
============================================================ */
function buildSlides(images) {
    const grid = document.getElementById('slidesGrid');
    grid.innerHTML = '';
    const preview = document.createElement('div');
    preview.className = 'gallery-preview';
    preview.setAttribute('aria-label', `Open TikTok slideshow with ${images.length} photos`);
    const previewImage = document.createElement('img');
    previewImage.alt = 'TikTok slideshow preview';
    previewImage.loading = 'eager';
    previewImage.decoding = 'async';
    previewImage.referrerPolicy = 'no-referrer';
    preview.appendChild(previewImage);
    const previewLabel = document.createElement('span');
    previewLabel.innerHTML = '<i class="bi bi-images" aria-hidden="true"></i> View ' + images.length + ' Photos';
    preview.appendChild(previewLabel);
    let currentIndex = 0;
    const currentDownload = document.getElementById('downloadCurrentImage');
    const updatePreview = index => {
        currentIndex = (index + images.length) % images.length;
        setImageFallbacks(previewImage, images[currentIndex]);
        previewLabel.innerHTML = `<i class="bi bi-images" aria-hidden="true"></i> ${currentIndex + 1} / ${images.length} Photos`;
        if (currentDownload) currentDownload.onclick = () => doDownload(images[currentIndex], `TikTok_Slide_${currentIndex + 1}.jpg`);
    };
    setImageFallbacks(previewImage, images[0]);
    if (currentDownload) currentDownload.onclick = () => doDownload(images[0], `TikTok_Slide_1.jpg`);
    const previousButton = document.createElement('button');
    previousButton.type = 'button';
    previousButton.className = 'gallery-nav gallery-nav-prev';
    previousButton.setAttribute('aria-label', 'View previous slideshow image');
    previousButton.innerHTML = '<i class="bi bi-chevron-left" aria-hidden="true"></i>';
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'gallery-nav gallery-nav-next';
    nextButton.setAttribute('aria-label', 'View next slideshow image');
    nextButton.innerHTML = '<i class="bi bi-chevron-right" aria-hidden="true"></i>';
    previousButton.addEventListener('click', event => { event.stopPropagation(); updatePreview(currentIndex - 1); });
    nextButton.addEventListener('click', event => { event.stopPropagation(); updatePreview(currentIndex + 1); });
    preview.append(previousButton, nextButton);
    grid.appendChild(preview);
}

/* ============================================================
   SHOW/HIDE
============================================================ */
function showResult() { document.getElementById('resultSection').style.display = 'block'; }

function imagePreviewUrl(url) {
    return `https://wsrv.nl/?url=${encodeURIComponent(url)}&output=jpg`;
}

function normalizeImages(images) {
    if (!Array.isArray(images)) return [];
    return images.flatMap(image => {
        if (typeof image === 'string') return [image];
        if (!image || typeof image !== 'object') return [];
        const candidates = [
            image.url, image.src, image.image, image.download_url,
            image.display_url, image.origin_cover, image.url_list
        ];
        return candidates.flatMap(candidate => Array.isArray(candidate) ? candidate : [candidate]);
    })
        .map(resolveTikwmUrl) // FIX: resolve relative TikWM image paths too
        .filter((url, index, all) =>
            typeof url === 'string' && /^https?:\/\//i.test(url) && all.indexOf(url) === index
        );
}

function setImageFallbacks(image, originalUrl) {
    const sources = [imagePreviewUrl(originalUrl), `https://images.weserv.nl/?url=${encodeURIComponent(originalUrl)}`, originalUrl];
    let sourceIndex = 0;
    const tryNextSource = () => {
        sourceIndex++;
        if (sourceIndex < sources.length) image.src = sources[sourceIndex];
    };
    image.addEventListener('error', tryNextSource);
    image.src = sources[0];
}

function hideResult() {
    document.getElementById('resultSection').style.display = 'none';
    document.getElementById('videoInfoCard').style.display = 'none';
    ['btnMp4','btnMp3','btnAllImg'].forEach(id => document.getElementById(id).style.display = 'none');
}
function setLoading(on) {
    const btn = document.getElementById('fetchBtn');
    btn.disabled = on;
    btn.innerHTML = on
        ? '<i class="bi bi-hourglass-split"></i> Fetching...'
        : '<i class="bi bi-lightning-charge-fill"></i> Download';
}

/* ============================================================
   DOWNLOAD
============================================================ */
function doDownload(url, filename) {
    if (!url) { showToast('No URL', 'Download URL not available.', 'error'); return; }
    showToast('Starting...', `Preparing ${filename}`, 'info');
    const isImage = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(url) || /\.(?:jpe?g|png|webp|gif|avif)$/i.test(filename);
    const downloadSources = isImage
        ? [imagePreviewUrl(url), `https://images.weserv.nl/?url=${encodeURIComponent(url)}`, url]
        : [url];
    const downloadRequest = downloadSources.reduce(
        (request, source) => request.catch(() => fetch(source, { mode: 'cors' })),
        Promise.reject()
    );
    downloadRequest
        .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
        .then(blob => {
            const bUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = bUrl; a.download = filename;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(bUrl), 5000);
            showToast('Downloaded!', `${filename} saved successfully.`, 'success');
        })
        .catch(() => {
            showToast('Download unavailable', 'Your browser or the image server blocked direct saving.', 'error');
        });
}

function doMp4() { if (!S.videoUrl) { showToast('No Video', 'Fetch a TikTok URL first.', 'error'); return; } doDownload(S.videoUrl, 'TikTok_Video_NoWatermark.mp4'); }
function doMp3() { if (!S.audioUrl) { showToast('No Audio', 'No audio track found.', 'error'); return; } doDownload(S.audioUrl, 'TikTok_Audio.mp3'); }
function downloadAllSlides() {
    if (!S.images.length) { showToast('No Images', 'No slideshow images found.', 'error'); return; }
    showToast('Bulk Download', `Downloading ${S.images.length} images...`, 'info');
    S.images.forEach((url, i) => setTimeout(() => doDownload(url, `TikTok_Slide_${i+1}.jpg`), i * 900));
}

/* ============================================================
   CAPTION
============================================================ */
function copyCaption() {
    const el = document.getElementById('captionArea');
    const val = el.value;
    if (!val || val === 'No caption found for this video.') { showToast('No Caption', 'Fetch a TikTok video first.', 'error'); return; }
    navigator.clipboard.writeText(val)
        .then(() => {
            el.classList.add('copy-flash');
            setTimeout(() => el.classList.remove('copy-flash'), 400);
            S.copyCount++;
            document.getElementById('copyCountNum').textContent = S.copyCount;
            document.getElementById('copyCountBadge').style.display = 'flex';
            showToast('Caption Copied!', 'TikTok caption copied to clipboard.', 'success');
        })
        .catch(() => { el.select(); document.execCommand('copy'); showToast('Copied!', 'Caption copied.', 'success'); });
}

function saveCaption() {
    const val = document.getElementById('captionArea').value;
    if (!val) { showToast('No Caption', 'Fetch a TikTok video first.', 'error'); return; }
    const blob = new Blob([val], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'TikTok_Caption.txt';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Saved!', 'Caption downloaded as TikTok_Caption.txt', 'success');
}

async function shareCaption() {
    const val = document.getElementById('captionArea').value;
    if (!val || val === 'No caption found for this video.') { showToast('No Caption', 'Fetch a TikTok video first.', 'error'); return; }
    if (navigator.share) {
        try {
            await navigator.share({ title: 'TikTok Caption', text: val });
            showToast('Shared!', 'Caption shared successfully.', 'success');
        } catch { showToast('Cancelled', 'Share was cancelled.', 'info'); }
    } else {
        navigator.clipboard.writeText(val).then(() => showToast('Copied!', 'Share not supported. Caption copied instead.', 'info'));
    }
}

/* ============================================================
   RATING
============================================================ */
function rateTool(stars) {
    S.userRating = stars;
    updateStars(stars);
    const labels = ['', 'Poor 😔', 'Fair 😐', 'Good 😊', 'Great 😄', 'Amazing! 🤩'];
    document.getElementById('ratingLabel').textContent = `${labels[stars]}. Thank you for rating!`;
    localStorage.setItem('tt-user-rating', stars);
    showToast('Thank You! ⭐', `You rated us ${stars} star${stars > 1 ? 's' : ''}. We appreciate it!`, 'success');
}

function updateStars(active) {
    document.querySelectorAll('.star-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.star) <= active);
    });
}

/* ============================================================
   HISTORY
============================================================ */
function saveToHistory(data, url) {
    const author = data.author ? (data.author.nickname || 'Unknown') : 'Unknown';
    const item = {
        id: Date.now(),
        url,
        title: data.title || 'No caption',
        author: '@' + author,
        type: data.images && data.images.length > 0 ? 'slideshow' : 'video',
        // FIX: resolve relative/http TikWM paths before persisting to
        // history too, otherwise reloaded history thumbnails/downloads
        // break the same way.
        cover: cleanMediaUrl(data.cover || data.origin_cover || null),
        videoUrl: cleanMediaUrl(data.hdplay || data.play || null),
        audioUrl: cleanMediaUrl(data.music || null),
        images: normalizeImages(data.images),
        timestamp: Date.now()
    };

    // Remove duplicate URLs
    S.history = S.history.filter(h => h.url !== url);
    S.history.unshift(item);
    if (S.history.length > 10) S.history.pop();
    localStorage.setItem('tt-history', JSON.stringify(S.history));
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('historyList');
    if (!S.history.length) {
        list.innerHTML = `<div class="history-empty">
            <i class="bi bi-clock-history" aria-hidden="true"></i>
            <p style="font-size:0.88rem;font-weight:600;">No downloads yet</p>
            <p style="font-size:0.78rem;">Your recent downloads will appear here</p>
        </div>`;
        return;
    }
    list.innerHTML = S.history.map(item => `
        <div class="history-item" role="listitem">
            <div class="history-thumb">
                ${item.cover
                    ? `<img src="${item.cover}" alt="TikTok video by ${escHtml(item.author)}" loading="lazy" width="56" height="56" onerror="this.style.display='none'">`
                    : `<i class="bi bi-${item.type === 'slideshow' ? 'images' : 'camera-video'}" aria-hidden="true"></i>`
                }
            </div>
            <div class="history-info">
                <div class="history-title">${escHtml(item.title.substring(0, 60))}${item.title.length > 60 ? '...' : ''}</div>
                <div class="history-meta">
                    <i class="bi bi-person-circle" aria-hidden="true"></i> ${escHtml(item.author)} ·
                    <i class="bi bi-${item.type === 'slideshow' ? 'images' : 'camera-video'}" aria-hidden="true"></i> ${item.type === 'slideshow' ? `${item.images.length} images` : 'Video'} ·
                    ${fmtTime(item.timestamp)}
                </div>
            </div>
            <div class="history-actions">
                <button class="history-btn" onclick="reloadHistory(${item.id})" aria-label="Reload this download">
                    <i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Reload
                </button>
                <button class="history-btn" onclick="copyHistoryCaption(${item.id})" aria-label="Copy caption from history">
                    <i class="bi bi-clipboard" aria-hidden="true"></i> Copy
                </button>
                <button class="history-btn" onclick="removeHistory(${item.id})" style="color:var(--secondary);" aria-label="Remove from history">
                    <i class="bi bi-trash" aria-hidden="true"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function reloadHistory(id) {
    const item = S.history.find(h => h.id === id);
    if (!item) return;
    document.getElementById('tiktokUrl').value = item.url;
    document.getElementById('tiktokUrl').dispatchEvent(new Event('input'));
    fetchTikTok();
    document.getElementById('downloader').scrollIntoView();
}

function copyHistoryCaption(id) {
    const item = S.history.find(h => h.id === id);
    if (!item || !item.title) { showToast('No Caption', 'No caption in history.', 'error'); return; }
    navigator.clipboard.writeText(item.title)
        .then(() => showToast('Copied!', 'Caption copied from history.', 'success'))
        .catch(() => showToast('Failed', 'Could not copy caption.', 'error'));
}

function removeHistory(id) {
    S.history = S.history.filter(h => h.id !== id);
    localStorage.setItem('tt-history', JSON.stringify(S.history));
    renderHistory();
    showToast('Removed', 'Item removed from history.', 'info');
}

function clearHistory() {
    if (!S.history.length) { showToast('Already Empty', 'History is already empty.', 'info'); return; }
    S.history = [];
    localStorage.setItem('tt-history', '[]');
    renderHistory();
    showToast('History Cleared', 'Download history has been cleared.', 'success');
}

/* ============================================================
   FAQ
============================================================ */
function toggleFaq(el) {
    const item = el.closest('.faq-item');
    const wasOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => { i.classList.remove('open'); i.querySelector('.faq-q').setAttribute('aria-expanded','false'); });
    if (!wasOpen) { item.classList.add('open'); el.setAttribute('aria-expanded','true'); }
}

/* ============================================================
   TOAST
============================================================ */
function showToast(title, sub, type = 'success') {
    const icons = { success:'bi-check-circle-fill', error:'bi-x-circle-fill', info:'bi-info-circle-fill' };
    const box = document.getElementById('toastBox');
    const el = document.createElement('div');
    el.className = `toast-el ${type}`;
    el.innerHTML = `
        <div class="toast-ico"><i class="bi ${icons[type] || icons.info}" aria-hidden="true"></i></div>
        <div><span class="toast-title">${escHtml(title)}</span><span class="toast-sub">${escHtml(sub)}</span></div>`;
    box.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 400); }, 3800);
}

/* ============================================================
   HELPERS
============================================================ */
function fmtDur(s) { if (!s) return 'N/A'; return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
function fmtNum(n) { if (!n) return 'N/A'; if (n>=1e6) return (n/1e6).toFixed(1)+'M'; if (n>=1e3) return (n/1e3).toFixed(1)+'K'; return String(n); }
function fmtTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
    return `${Math.floor(diff/86400000)}d ago`;
}
function escHtml(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
}