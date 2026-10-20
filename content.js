// ============================================================================
// YouTube Timestamp Tools — Loop & Skip
// Content script: runs on youtube.com, injects a Shadow-DOM control panel,
// loops/skips video sections with rAF precision, persists per video.
// ============================================================================
(() => {
  'use strict';

  if (window.__ytlxLoaded) return;
  window.__ytlxLoaded = true;

  // ---------------------------------------------------------------- helpers
  const PALETTE = ['#22c55e', '#84cc16', '#14b8a6', '#eab308', '#f97316', '#a855f7', '#ec4899', '#94a3b8'];

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function fmt(t) {
    if (typeof t !== 'number' || !isFinite(t) || t < 0) return '—';
    t = Math.round(t * 10) / 10;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    let s = t % 60;
    s = (s < 10 ? '0' : '') + (Number.isInteger(s) ? String(s) : s.toFixed(1));
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }

  function parseTime(str) {
    if (typeof str === 'number') return isFinite(str) ? str : NaN;
    const s = String(str == null ? '' : str).trim().toLowerCase().replace(/s$/, '');
    if (!s) return NaN;
    const parts = s.split(':');
    let sec = 0;
    for (const p of parts) {
      const v = parseFloat(p);
      if (isNaN(v)) return NaN;
      sec = sec * 60 + v;
    }
    return sec;
  }

  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    if (sec <= 0) return '0s';
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + 'm ' + (s ? s + 's' : '');
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  function hexA(hex, a) {
    let h = String(hex || '#22c55e').replace('#', '');
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    const n = parseInt(h, 16) || 0x22c55e;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  const ICONS = {
    logo: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    min: '<polyline points="6 9 12 15 18 9"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    up: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'
  };
  const icon = (n, s = 14) =>
    '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[n] + '</svg>';

  // ---------------------------------------------------------------- storage
  function getSync(keys) { return new Promise(r => chrome.storage.sync.get(keys, r)); }
  function setSync(obj) { return new Promise(r => chrome.storage.sync.set(obj, () => r(!chrome.runtime.lastError))); }
  function getLocal(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
  function setLocal(obj) { return new Promise(r => chrome.storage.local.set(obj, () => r(!chrome.runtime.lastError))); }

  const DEFAULT_SETTINGS = { enabled: true, loopsOn: true, skipsOn: true, panelHidden: false, panelPos: null, firstRun: false };

  async function loadSettings() {
    try {
      let { settings } = await getSync('settings');
      if (!settings) {
        const l = await getLocal('settings');
        settings = l.settings;
      }
      return Object.assign({}, DEFAULT_SETTINGS, settings || {});
    } catch (e) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    state.lastWrite = Date.now();
    const s = Object.assign({}, state.settings);
    setSync({ settings: s }).then(ok => { if (!ok) setLocal({ settings: s }); });
  }

  function freshData() {
    return { loops: [], skips: [], stats: { loopPlays: 0, skipCount: 0, secondsSaved: 0 }, seq: { loop: 0, skip: 0 } };
  }

  function normalize(d) {
    d = (d && typeof d === 'object') ? d : {};
    if (!Array.isArray(d.loops)) d.loops = [];
    if (!Array.isArray(d.skips)) d.skips = [];
    if (!d.stats || typeof d.stats !== 'object') d.stats = { loopPlays: 0, skipCount: 0, secondsSaved: 0 };
    d.stats.loopPlays = +d.stats.loopPlays || 0;
    d.stats.skipCount = +d.stats.skipCount || 0;
    d.stats.secondsSaved = +d.stats.secondsSaved || 0;
    if (!d.seq || typeof d.seq !== 'object') d.seq = {};
    d.seq.loop = +d.seq.loop || d.loops.length;
    d.seq.skip = +d.seq.skip || d.skips.length;
    for (const l of d.loops) {
      l.enabled = l.enabled !== false;
      l.repeats = +l.repeats || 0;
      l.start = +l.start || 0;
      l.end = +l.end || 0;
      if (!l.color) l.color = PALETTE[0];
      if (!l.name) l.name = '';
    }
    for (const s of d.skips) {
      s.enabled = s.enabled !== false;
      s.start = +s.start || 0;
      s.end = +s.end || 0;
      if (!s.color) s.color = PALETTE[1];
      if (!s.name) s.name = '';
    }
    return d;
  }

  async function getVideoData(id) {
    const key = 'v:' + id;
    try {
      const s = await getSync(key);
      if (s && s[key]) return normalize(s[key]);
      const l = await getLocal(key);
      if (l && l[key]) return normalize(l[key]);
    } catch (e) { /* fall through */ }
    return freshData();
  }

  async function setVideoData(id, data) {
    const key = 'v:' + id;
    const ok = await setSync({ [key]: data });
    if (!ok) await setLocal({ [key]: data }); // sync quota fallback (stays on this browser)
  }

  async function getAllVideos() {
    let s = {}, l = {};
    try { s = await new Promise(r => chrome.storage.sync.get(null, r)) || {}; } catch (e) {}
    try { l = await new Promise(r => chrome.storage.local.get(null, r)) || {}; } catch (e) {}
    const out = {};
    for (const [k, v] of Object.entries(Object.assign({}, l, s))) {
      if (!k.startsWith('v:') || !v || typeof v !== 'object') continue;
      const id = k.slice(2);
      if (!out[id] || ((v.u || 0) >= (out[id].u || 0))) out[id] = v;
    }
    return out;
  }

  // ---------------------------------------------------------------- state
  const state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    data: freshData(),
    videoId: null,
    bound: null,          // bound <video> element
    prevTime: null,
    loadSeq: 0,
    dirty: false,
    saveTimer: null,
    lastWrite: 0,
    tab: 'loops',         // panel tab
    edit: null,           // { type:'loop'|'skip', id } when editor open
    editColor: PALETTE[0],
    editStep: 0.1,        // fine nudge step (seconds)
    fabHover: false       // mouse is over the mini button (keep it visible)
  };

  const ui = {};

  function dirty() {
    state.dirty = true;
    if (!state.saveTimer) state.saveTimer = setTimeout(flush, 900);
    updateFootStat();
  }

  function flush() {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    if (!state.dirty || !state.videoId) return;
    state.dirty = false;
    state.lastWrite = Date.now();
    const clean = JSON.parse(JSON.stringify(state.data, (k, v) => (k.charAt(0) === '_') ? undefined : v));
    clean.u = Date.now();
    setVideoData(state.videoId, clean);
  }

  // ---------------------------------------------------------------- page detection
  function getVideoId() {
    try {
      const p = location.pathname;
      if (p.startsWith('/shorts/')) return 's_' + p.split('/')[2];
      const v = new URLSearchParams(location.search).get('v');
      if (v) return v;
      const m = p.match(/^\/(?:embed|v|live)\/([\w-]+)/);
      if (m) return 'e_' + m[1];
    } catch (e) {}
    return null;
  }

  function isWatchPage() {
    const p = location.pathname;
    return p.startsWith('/watch') || p.startsWith('/shorts/') || p.startsWith('/embed/') || p.startsWith('/live/');
  }

  function isShorts() { return location.pathname.startsWith('/shorts/'); }

  // ---------------------------------------------------------------- video binding
  function pickVideo() {
    const vids = document.querySelectorAll('video');
    if (!vids.length) return null;
    let best = null, bestScore = -1;
    for (const v of vids) {
      let score = 0;
      const r = v.getBoundingClientRect();
      if (r.width > 50 && r.height > 50) score += r.width * r.height;
      if (!v.paused && !v.ended) score += 5e6;
      if (v.currentTime > 0) score += 1e4;
      if (v.isConnected && v.offsetParent !== null) score += 2e5;
      if (v.classList.contains('html5-main-video')) score += 3e5;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  function ensureBound() {
    const v = pickVideo();
    if (v !== state.bound) state.bound = v;
  }

  // ---------------------------------------------------------------- engine
  function processLoops(v, t) {
    const loops = state.data.loops;
    for (const l of loops) {
      if (!l.enabled || l._done) continue;
      let end = l.end;
      if (isFinite(v.duration) && v.duration > 0) end = Math.min(end, v.duration - 0.15);
      if (end <= l.start + 0.05) continue;
      // influence zone: inside the loop, or slightly past its end (frame overshoot)
      if (t >= l.start && t < end + 0.45) {
        if (t >= end - 0.03) {
          l._plays = (l._plays || 0) + 1;
          state.data.stats.loopPlays++;
          dirty();
          const reps = l.repeats | 0;
          if (reps > 0 && l._plays >= reps) {
            l._done = true;
            toast('Loop "' + (l.name || 'Untitled') + '" finished ' + reps + (reps === 1 ? ' repeat' : ' repeats') + ' — playing on');
            if (state.tab === 'loops') renderList();
            return;
          }
          v.currentTime = l.start;
          state.prevTime = l.start;
          return;
        }
      }
    }
  }

  function processSkips(v, t) {
    const skips = state.data.skips;
    const dur = v.duration;
    for (const s of skips) {
      if (!s.enabled || s._off) continue;
      let end = s.end;
      if (isFinite(dur) && dur > 0) end = Math.min(end, dur - 0.2);
      if (end <= s.start + 0.05) continue;
      if (t >= s.start && t < end) {
        const prev = state.prevTime;
        // natural entry = playback carried us here (or video just started).
        // If the user scrubbed/jumped into the zone, leave them alone.
        const natural = (prev == null) || (prev < s.start && (s.start - prev) < 2.0);
        if (!natural) continue;
        const target = end + 0.01;
        v.currentTime = target;
        state.prevTime = target;
        state.data.stats.skipCount++;
        state.data.stats.secondsSaved += (end - s.start) / (v.playbackRate || 1);
        dirty();
        if (state.tab === 'skips') renderList();
        toast('Skipped ' + fmt(s.start) + ' – ' + fmt(s.end), () => {
          s._off = true;
          try { v.currentTime = Math.max(0, s.start - 0.25); } catch (e) {}
          state.prevTime = v.currentTime;
          toast('OK — that skip is paused until you open the video again');
        });
        return;
      }
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    updateFab();
    const v = state.bound;
    if (!v || !v.isConnected) ensureBound();
    const vv = state.bound;
    if (!vv || !state.settings.enabled) { state.prevTime = null; return; }
    const t = vv.currentTime;
    if (!(vv.duration > 0) || vv.duration === Infinity) { state.prevTime = t; return; } // live / no metadata
    if (state.settings.loopsOn) processLoops(vv, t);
    if (state.settings.skipsOn) processSkips(vv, t);
    state.prevTime = vv.currentTime;
  }

  // ---------------------------------------------------------------- markers
  const MK_CSS =
    '.ytlx-markers{position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none;z-index:1}' +
    '.ytlx-mk{position:absolute;top:0;bottom:0}' +
    '.ytlx-mk-loop{border-left:2px solid var(--mkc);border-right:2px solid var(--mkc);background:var(--mkbg)}' +
    '.ytlx-mk-skip{background:repeating-linear-gradient(135deg,var(--mkc) 0 4px,transparent 4px 9px);opacity:.55}';

  let markerWrap = null;
  let markerRO = null;
  let mkTimer = null;

  function injectMarkerCss() {
    if (document.getElementById('ytlx-mk-css')) return;
    const st = document.createElement('style');
    st.id = 'ytlx-mk-css';
    st.textContent = MK_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function renderMarkers() {
    if (markerWrap) { markerWrap.remove(); markerWrap = null; }
    if (markerRO) { markerRO.disconnect(); markerRO = null; }
    if (!state.videoId || !state.settings.enabled) return;
    const v = state.bound;
    if (!v || !isFinite(v.duration) || v.duration <= 0) return;
    const bar = document.querySelector('.ytp-progress-bar, .YtProgressBarLineHost');
    const list = bar ? (bar.querySelector('.ytp-progress-list') || bar) : null;
    if (!list) return;
    const items = [];
    if (state.settings.loopsOn) {
      for (const l of state.data.loops) {
        if (l.enabled && l.end > l.start) items.push({ type: 'loop', s: l.start, e: l.end, c: l.color });
      }
    }
    if (state.settings.skipsOn) {
      for (const s of state.data.skips) {
        if (s.enabled && s.end > s.start) items.push({ type: 'skip', s: s.start, e: s.end, c: s.color });
      }
    }
    if (!items.length) return;
    const w = document.createElement('div');
    w.className = 'ytlx-markers';
    for (const it of items) {
      const d = document.createElement('div');
      d.className = 'ytlx-mk ytlx-mk-' + it.type;
      d.style.left = (it.s / v.duration * 100) + '%';
      d.style.width = Math.max(0.35, (it.e - it.s) / v.duration * 100) + '%';
      d.style.setProperty('--mkc', it.c);
      if (it.type === 'loop') d.style.setProperty('--mkbg', hexA(it.c, 0.25));
      d.title = (it.type === 'loop' ? 'Loop' : 'Skip') + ' ' + fmt(it.s) + ' – ' + fmt(it.e);
      w.appendChild(d);
    }
    list.appendChild(w);
    markerWrap = w;
    try {
      markerRO = new ResizeObserver(() => {
        clearTimeout(mkTimer);
        mkTimer = setTimeout(() => { if (markerWrap && !markerWrap.isConnected) renderMarkers(); }, 250);
      });
      markerRO.observe(list);
    } catch (e) { /* ResizeObserver unavailable — non-fatal */ }
  }

  function ensureMarkers() {
    if (!state.videoId) return;
    const hasItems = state.data.loops.length || state.data.skips.length;
    if (!hasItems || !state.settings.enabled) {
      if (markerWrap) { markerWrap.remove(); markerWrap = null; }
      return;
    }
    if (!markerWrap || !markerWrap.isConnected) renderMarkers();
  }

  // ---------------------------------------------------------------- styles & template
  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

.panel {
  position: fixed; width: 330px; max-width: calc(100vw - 14px);
  background: #0b100df6; color: #f4f4f5;
  border: 1px solid #22c55e2e; border-radius: 14px;
  box-shadow: 0 14px 44px #000a, 0 0 28px #22c55e1f;
  font: 13px/1.45 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;
  user-select: none; overflow: hidden;
}
.panel.compact { width: 288px; }
.panel.off .scroll { opacity: .45; }
.panel.live .addbar { opacity: .35; pointer-events: none; }

.hdr { display: flex; align-items: center; gap: 8px; padding: 9px 10px; background: #22c55e0f; border-bottom: 1px solid #22c55e1f; cursor: grab; }
.hdr:active { cursor: grabbing; }
.logo { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg,#22c55e,#047857); display: flex; align-items: center; justify-content: center; color: #fff; flex: none; }
.ttl { font-weight: 700; font-size: 13px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge-off { font-size: 10px; color: #fbbf24; background: #fbbf241a; border: 1px solid #fbbf2433; padding: 1px 6px; border-radius: 999px; }
.ic { background: none; border: 0; color: #a1a1aa; width: 24px; height: 24px; border-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; padding: 0; }
.ic:hover { background: #ffffff14; color: #fff; }
.ic svg { display: block; }

.scroll { max-height: 432px; overflow-y: auto; overscroll-behavior: contain; }
.panel.min .scroll, .panel.min .foot { display: none; }
.scroll::-webkit-scrollbar { width: 8px; }
.scroll::-webkit-scrollbar-thumb { background: #22c55e40; border-radius: 4px; }
.scroll::-webkit-scrollbar-track { background: transparent; }

.masters { padding: 8px 10px; border-bottom: 1px solid #ffffff0a; display: flex; flex-direction: column; gap: 7px; }
.mrow { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; color: #d4d4d8; }
.mrow .sw input:checked + i { background: #22c55e; }
.mrow.skips .sw input:checked + i { background: #14b8a6; }

.sw { position: relative; width: 32px; height: 18px; flex: none; display: inline-block; }
.sw input { opacity: 0; position: absolute; inset: 0; margin: 0; cursor: pointer; width: 100%; height: 100%; z-index: 1; }
.sw i { position: absolute; inset: 0; border-radius: 999px; background: #3f3f46; transition: .15s; pointer-events: none; }
.sw i::after { content: ''; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: #e4e4e7; transition: .15s; }
.sw input:checked + i { background: #22c55e; }
.sw input:checked + i::after { transform: translateX(14px); background: #fff; }

.tabs { display: flex; gap: 4px; padding: 8px 10px 0; }
.tab { flex: 1; background: #ffffff08; border: 1px solid #ffffff0d; color: #a1a1aa; padding: 6px 0; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 5px; }
.tab.on { background: #22c55e1f; border-color: #22c55e45; color: #86efac; }
.tab b { background: #ffffff14; border-radius: 999px; font-size: 10px; padding: 0 6px; line-height: 16px; font-weight: 700; }

.list { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; min-height: 60px; }
.item { display: flex; align-items: center; gap: 8px; background: #ffffff08; border: 1px solid #ffffff0a; border-radius: 10px; padding: 7px 8px; }
.item .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.meta { flex: 1; min-width: 0; }
.nm { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rng { font-size: 11px; color: #a1a1aa; }
.item.off .meta { opacity: .45; }
.empty { color: #71717a; font-size: 11.5px; text-align: center; padding: 16px 8px; line-height: 1.65; }

.addbar { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 2px 10px 10px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; background: #26262e; color: #f4f4f5; border: 1px solid #ffffff14; border-radius: 9px; padding: 8px 10px; font: inherit; font-weight: 600; font-size: 12.5px; cursor: pointer; }
.btn:hover { background: #2f2f39; }
.btn:active { transform: translateY(1px); }
.btn svg { flex: none; }
.btn.add-loop { background: #22c55e14; border-color: #22c55e40; color: #86efac; }
.btn.add-loop:hover { background: #22c55e2e; }
.btn.add-skip { background: #14b8a614; border-color: #14b8a640; color: #5eead4; }
.btn.add-skip:hover { background: #14b8a62e; }
.btn.tiny { padding: 6px 9px; font-size: 11px; flex: none; }
.btn.primary { background: #22c55e; border-color: #22c55e; color: #fff; flex: 1; }
.btn.primary:hover { background: #16a34a; }
.btn.ghost { background: #ffffff08; border-color: #ffffff14; color: #d4d4d8; flex: 1; }

.foot { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-top: 1px solid #ffffff0f; background: #ffffff05; }
.fstat { flex: 1; font-size: 10.5px; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ed { padding: 2px 0; }
.ed-h { font-size: 12px; font-weight: 700; color: #86efac; margin: 2px 0 10px; }
.f { display: block; margin-bottom: 9px; font-size: 11px; color: #a1a1aa; }
.f > span { display: block; margin-bottom: 4px; }
.f em { color: #71717a; font-style: normal; }
.ed input, .ed select { width: 100%; background: #0c0c0f; border: 1px solid #ffffff17; border-radius: 8px; color: #f4f4f5; padding: 7px 9px; font: inherit; font-size: 12.5px; outline: none; }
.ed input:focus, .ed select:focus { border-color: #22c55e66; }
.tgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.trow2 { display: flex; gap: 6px; }
.trow2 input { flex: 1; min-width: 0; }
.swatches { display: flex; gap: 6px; flex-wrap: wrap; }
.swb { width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; flex: none; padding: 0; }
.swb.on { border-color: #fff; }
.ed-err { color: #fb7185; font-size: 11px; min-height: 15px; margin-bottom: 5px; }
.ed-actions { display: flex; gap: 8px; }

.tl { position: relative; height: 38px; background: #0c1210; border: 1px solid #22c55e2e; border-radius: 9px; overflow: hidden; cursor: pointer; touch-action: none; margin-top: 2px; }
.tl-range { position: absolute; top: 0; bottom: 0; background: #22c55e2e; border-left: 2px solid #22c55e; border-right: 2px solid #22c55e; pointer-events: none; }
.tl-ph { position: absolute; top: 0; bottom: 0; width: 2px; background: #ffffffb3; pointer-events: none; z-index: 1; }
.tl-h { position: absolute; top: 50%; width: 15px; height: 24px; transform: translate(-50%, -50%); border-radius: 5px; cursor: ew-resize; z-index: 2; border: 1px solid #04140b; box-shadow: 0 0 10px #22c55e66; }
.tl-h-s { background: #22c55e; }
.tl-h-e { background: #14b8a6; }
.tl-h::after { content: ''; position: absolute; left: 50%; top: 5px; bottom: 5px; width: 2px; margin-left: -1px; background: #04140b66; border-radius: 2px; }
.steps { display: flex; gap: 5px; flex-wrap: wrap; }
.chip { background: #ffffff08; border: 1px solid #ffffff14; color: #a1a1aa; border-radius: 999px; padding: 4px 11px; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.chip.on { background: #22c55e1f; border-color: #22c55e4d; color: #86efac; }
.nb { width: 30px; padding: 0 !important; font-weight: 700; flex: none; }

.stats { padding: 4px 2px; }
.srow { display: flex; justify-content: space-between; align-items: center; padding: 8px 4px; border-bottom: 1px dashed #ffffff0d; font-size: 12.5px; color: #d4d4d8; }
.srow b { color: #fff; font-weight: 700; }
.srow.total b { color: #4ade80; }
.stats .btn { margin-top: 10px; width: 100%; }

.toast { position: fixed; left: 50%; bottom: 96px; transform: translate(-50%, 8px); display: flex; align-items: center; gap: 10px; background: #26262eee; border: 1px solid #ffffff1f; color: #f4f4f5; padding: 9px 12px; border-radius: 11px; font: 12.5px/1.4 -apple-system,'Segoe UI',Roboto,Arial,sans-serif; opacity: 0; pointer-events: none; transition: .18s; box-shadow: 0 8px 28px #0009; max-width: min(92vw, 460px); z-index: 2; }
.toast.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
.toast span { overflow: hidden; text-overflow: ellipsis; }
.toast button { border: 0; cursor: pointer; flex: none; }
#toastUndo { background: #22c55e; color: #fff; border-radius: 7px; padding: 4px 11px; font-weight: 700; font-size: 11.5px; font-family: inherit; }
#toastUndo:hover { background: #16a34a; }
#toastClose { background: none; color: #a1a1aa; font-size: 13px; padding: 2px; font-family: inherit; }
#toastClose:hover { color: #fff; }

.fab { position: fixed; right: 18px; bottom: 110px; width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(135deg,#22c55e,#047857); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 6px 20px #0008, 0 0 24px #22c55e52; border: 1px solid #34d39959; transition: transform .12s, opacity .22s; }
.fab:hover { transform: scale(1.07); box-shadow: 0 6px 20px #0008, 0 0 34px #34d39973; }
.fab:active { transform: scale(.95); }
.fab.faded { opacity: 0; pointer-events: none; transform: scale(.85); }
.fab.onshorts { right: auto; left: 14px; bottom: 90px; }
`;

  const TPL = `
<div class="panel" id="panel" style="display:none">
  <div class="hdr" id="hdr">
    <span class="logo">${icon('logo', 13)}</span>
    <span class="ttl">Timestamp Tools</span>
    <span class="badge-off" id="badgeOff" hidden>PAUSED</span>
    <button class="ic" data-act="min" title="Minimize" aria-label="Minimize panel">${icon('min')}</button>
    <button class="ic" data-act="hide" title="Hide — reopen with the round button" aria-label="Hide panel">${icon('x')}</button>
  </div>
  <div class="scroll">
    <div class="masters">
      <div class="mrow"><span>Extension</span><label class="sw"><input type="checkbox" id="swAll" aria-label="Toggle extension"><i></i></label></div>
      <div class="mrow loops"><span>Loops</span><label class="sw"><input type="checkbox" id="swLoops" aria-label="Toggle loops"><i></i></label></div>
      <div class="mrow skips"><span>Skips</span><label class="sw"><input type="checkbox" id="swSkips" aria-label="Toggle skips"><i></i></label></div>
    </div>
    <div class="tabs">
      <button class="tab on" data-tab="loops">Loops <b id="nLoops">0</b></button>
      <button class="tab" data-tab="skips">Skips <b id="nSkips">0</b></button>
      <button class="tab" data-tab="stats">Stats</button>
    </div>
    <div class="list" id="list"></div>
    <div class="addbar">
      <button class="btn add-loop" id="addLoop">${icon('logo', 12)} Add loop</button>
      <button class="btn add-skip" id="addSkip">${icon('up', 12)} Add skip</button>
    </div>
  </div>
  <div class="foot">
    <span class="fstat" id="footStat"></span>
    <button class="ic" data-act="export" title="Export all videos (backup file)" aria-label="Export backup">${icon('down')}</button>
    <button class="ic" data-act="import" title="Import a backup file" aria-label="Import backup">${icon('up')}</button>
  </div>
</div>
<div class="fab" id="fab" style="display:none" title="Open Timestamp Tools" role="button" aria-label="Open Timestamp Tools">${icon('logo', 18)}</div>
<div class="toast" id="toast" role="status"><span id="toastMsg"></span><button id="toastUndo">Undo</button><button id="toastClose" aria-label="Dismiss">✕</button></div>
<input type="file" id="file" accept=".json,application/json" hidden>
`;

  // ---------------------------------------------------------------- UI build
  function buildUI() {
    if (ui.host) return;
    injectMarkerCss();
    const host = document.createElement('div');
    host.id = 'ytlx-host';
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
    const sh = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.innerHTML = TPL;
    sh.appendChild(style);
    sh.appendChild(wrap);
    (document.documentElement || document.body).appendChild(host);

    ui.host = host; ui.shadow = sh; ui.wrap = wrap;
    ui.panel = wrap.querySelector('#panel');
    ui.fab = wrap.querySelector('#fab');
    ui.toast = wrap.querySelector('#toast');
    ui.toastMsg = wrap.querySelector('#toastMsg');
    ui.toastUndo = wrap.querySelector('#toastUndo');
    ui.list = wrap.querySelector('#list');
    ui.footStat = wrap.querySelector('#footStat');
    ui.badgeOff = wrap.querySelector('#badgeOff');
    ui.file = wrap.querySelector('#file');

    bindUI();
  }

  function bindUI() {
    const w = ui.wrap;

    // header buttons
    w.querySelector('#hdr').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'min') ui.panel.classList.toggle('min');
      if (act === 'hide') { state.settings.panelHidden = true; saveSettings(); applyVisibility(); }
      if (act === 'export') exportAll();
      if (act === 'import') ui.file.click();
    });

    // drag
    const hdr = w.querySelector('#hdr');
    hdr.addEventListener('pointerdown', onDragStart);

    // masters
    w.querySelector('#swAll').addEventListener('change', e => {
      state.settings.enabled = e.target.checked;
      saveSettings(); applyEnabled(); renderMarkers();
    });
    w.querySelector('#swLoops').addEventListener('change', e => {
      state.settings.loopsOn = e.target.checked;
      saveSettings(); applyEnabled(); renderMarkers();
    });
    w.querySelector('#swSkips').addEventListener('change', e => {
      state.settings.skipsOn = e.target.checked;
      saveSettings(); applyEnabled(); renderMarkers();
    });

    // tabs
    w.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      state.tab = t.dataset.tab;
      state.edit = null;
      w.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
      renderList();
    }));

    // add buttons
    w.querySelector('#addLoop').addEventListener('click', () => openEditor('loop', null));
    w.querySelector('#addSkip').addEventListener('click', () => openEditor('skip', null));

    // list interactions (delegated)
    ui.list.addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'resetStats') { resetStats(); return; }
      if (act === 'swatch') {
        state.editColor = btn.dataset.c;
        ui.list.querySelectorAll('.swb').forEach(x => x.classList.toggle('on', x === btn));
        return;
      }
      const row = e.target.closest('[data-kind][data-id]');
      if (!row) return;
      const kind = row.dataset.kind, id = row.dataset.id;
      if (act === 'edit') openEditor(kind, id);
      if (act === 'del') deleteItem(kind, id);
    });
    ui.list.addEventListener('change', e => {
      if (!e.target.matches('.item .sw input')) return;
      const row = e.target.closest('[data-kind][data-id]');
      if (!row) return;
      toggleItem(row.dataset.kind, row.dataset.id, e.target.checked);
    });

    // fab / toast / file
    ui.fab.addEventListener('click', () => {
      state.settings.panelHidden = false;
      saveSettings(); applyVisibility();
    });
    ui.fab.addEventListener('pointerenter', () => { state.fabHover = true; updateFab(); });
    ui.fab.addEventListener('pointerleave', () => { state.fabHover = false; updateFab(); });
    w.querySelector('#toastUndo').addEventListener('click', () => {
      const f = toastUndoFn; hideToast();
      if (f) f();
    });
    w.querySelector('#toastClose').addEventListener('click', hideToast);
    ui.file.addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const n = await importFromText(text);
        toast('Imported ' + n + ' video' + (n === 1 ? '' : 's') + ' ✓');
        renderList(); renderMarkers(); updateFootStat();
      } catch (err) {
        toast('Could not read that file — is it a backup from this extension?');
      }
      e.target.value = '';
    });

    window.addEventListener('resize', () => { applyPos(true); });
  }

  // ---------------------------------------------------------------- drag
  function onDragStart(e) {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const r = ui.panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => {
      const pos = {
        x: clamp(ev.clientX - dx, -40, window.innerWidth - 60),
        y: clamp(ev.clientY - dy, 0, window.innerHeight - 40)
      };
      ui.panel.style.left = pos.x + 'px';
      ui.panel.style.top = pos.y + 'px';
      ui.panel.style.right = 'auto';
      ui.panel.style.bottom = 'auto';
      state._dragPos = pos;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (state._dragPos) {
        state.settings.panelPos = state._dragPos;
        saveSettings();
        state._dragPos = null;
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function applyPos(keepInViewport) {
    const p = state.settings.panelPos;
    let x, y;
    if (p && typeof p.x === 'number') { x = p.x; y = p.y; }
    else {
      x = window.innerWidth > 420 ? window.innerWidth - 346 : 8;
      y = 88;
    }
    if (keepInViewport) {
      x = clamp(x, -40, Math.max(0, window.innerWidth - 60));
      y = clamp(y, 0, Math.max(0, window.innerHeight - 40));
    }
    ui.panel.style.left = x + 'px';
    ui.panel.style.top = y + 'px';
    ui.panel.style.right = 'auto';
    ui.panel.style.bottom = 'auto';
  }

  // ---------------------------------------------------------------- rendering
  function controlsVisible() {
    // YouTube adds the class "ytp-autohide" to the player when its own
    // control bar fades out (mouse idle). We mirror that for the mini button.
    const p = document.querySelector('#movie_player');
    return !p || !p.classList.contains('ytp-autohide');
  }

  let fabFaded = null;
  function updateFab() {
    if (!ui.fab) return;
    let show = true;
    if (!isShorts()) {
      if (document.fullscreenElement) show = false;          // fullscreen: keep the video clean
      else show = controlsVisible() || !!state.fabHover;     // otherwise fade with YouTube's controls
    }
    if (fabFaded === show) return;
    fabFaded = show;
    ui.fab.classList.toggle('faded', !show);
  }

  function applyVisibility() {
    if (!ui.panel) return;
    const watch = isWatchPage();
    const showPanel = watch && !state.settings.panelHidden;
    ui.panel.style.display = showPanel ? '' : 'none';
    ui.fab.style.display = (watch && state.settings.panelHidden) ? '' : 'none';
    ui.panel.classList.toggle('compact', isShorts());
    ui.fab.classList.toggle('onshorts', isShorts());
    fabFaded = null; updateFab();
    applyPos(false);
  }

  function applyEnabled() {
    ui.wrap.querySelector('#swAll').checked = !!state.settings.enabled;
    ui.wrap.querySelector('#swLoops').checked = !!state.settings.loopsOn;
    ui.wrap.querySelector('#swSkips').checked = !!state.settings.skipsOn;
    ui.panel.classList.toggle('off', !state.settings.enabled);
    ui.badgeOff.hidden = !!state.settings.enabled;
    ui.wrap.querySelector('#swLoops').disabled = !state.settings.enabled;
    ui.wrap.querySelector('#swSkips').disabled = !state.settings.enabled;
  }

  function updateCounts() {
    ui.wrap.querySelector('#nLoops').textContent = state.data.loops.length;
    ui.wrap.querySelector('#nSkips').textContent = state.data.skips.length;
  }

  function updateFootStat() {
    if (!ui.footStat) return;
    const d = state.data;
    const live = state.bound && state.bound.duration === Infinity;
    if (live) { ui.footStat.textContent = 'Live video — timestamps not available'; return; }
    const saved = fmtDur(d.stats.secondsSaved);
    ui.footStat.textContent =
      d.loops.length + ' loop' + (d.loops.length === 1 ? '' : 's') + ' · ' +
      d.skips.length + ' skip' + (d.skips.length === 1 ? '' : 's') +
      (d.stats.secondsSaved > 0 ? ' · saved ' + saved : '');
  }

  function renderAll() {
    applyEnabled();
    updateCounts();
    updateFootStat();
    applyVisibility();
    renderList();
    renderMarkers();
  }

  function renderList() {
    if (!ui.list) return;
    // never clobber an open editor form (engine-driven re-renders may arrive mid-edit)
    if (state.edit) return;
    const t = state.tab;
    if (t === 'stats') { renderStats(); return; }
    const isLoop = t === 'loops';
    const arr = isLoop ? state.data.loops : state.data.skips;
    if (!arr.length) {
      ui.list.innerHTML = '<div class="empty">' +
        (isLoop
          ? 'No loops yet.<br>Tap <b>+ Add loop</b>, then use the <b>Now</b> buttons to grab the start & end times.'
          : 'No skips yet.<br>Tap <b>+ Add skip</b> to jump over a boring part automatically.') +
        '</div>';
      return;
    }
    let html = '';
    for (const it of arr) {
      const sub = fmt(it.start) + ' – ' + fmt(it.end) +
        (isLoop && (it.repeats | 0) > 0 ? ' · ×' + it.repeats + (it._plays ? ' (' + Math.min(it._plays, it.repeats) + '/' + it.repeats + ')' : '') : '') +
        (it.name ? '' : '');
      html += '<div class="item' + (it.enabled ? '' : ' off') + '" data-kind="' + t + '" data-id="' + it.id + '">' +
        '<span class="dot" style="background:' + it.color + '"></span>' +
        '<div class="meta"><div class="nm">' + escapeHtml(it.name || (isLoop ? 'Loop' : 'Skip')) + '</div>' +
        '<div class="rng">' + sub + '</div></div>' +
        '<label class="sw"><input type="checkbox"' + (it.enabled ? ' checked' : '') + ' aria-label="Toggle"><i></i></label>' +
        '<button class="ic" data-act="edit" title="Edit" aria-label="Edit">' + icon('pencil') + '</button>' +
        '<button class="ic" data-act="del" title="Delete" aria-label="Delete">' + icon('trash') + '</button>' +
        '</div>';
    }
    ui.list.innerHTML = html;
  }

  function renderStats() {
    const s = state.data.stats;
    let html = '<div class="stats">' +
      '<div class="srow"><span>Loops played on this video</span><b>' + s.loopPlays + '</b></div>' +
      '<div class="srow"><span>Times skipped on this video</span><b>' + s.skipCount + '</b></div>' +
      '<div class="srow"><span>Watch time saved here</span><b>' + fmtDur(s.secondsSaved) + '</b></div>' +
      '<div class="srow total"><span>Time saved (all videos)</span><b id="allSaved">…</b></div>' +
      '<button class="btn ghost" data-act="resetStats">Reset this video&#39;s stats</button>' +
      '</div>';
    ui.list.innerHTML = html;
    getAllVideos().then(all => {
      let total = 0;
      for (const v of Object.values(all)) total += (v.stats && v.stats.secondsSaved) || 0;
      const el = ui.list.querySelector('#allSaved');
      if (el) el.textContent = fmtDur(total);
    });
  }

  function renderEditor() {
    const isLoop = state.edit.type === 'loop';
    const item = state.edit.id ? findItem(state.edit.type, state.edit.id) : null;
    const defStart = item ? item.start : (state.bound ? Math.floor(state.bound.currentTime) : 0);
    const defEnd = item ? item.end : Math.min(defStart + 15, (state.bound && isFinite(state.bound.duration)) ? state.bound.duration : defStart + 15);
    const defColor = item ? item.color : state.editColor;
    const defName = item ? item.name : '';
    const defRep = item ? (item.repeats | 0) : 0;
    const dur = (state.bound && isFinite(state.bound.duration) && state.bound.duration > 0) ? state.bound.duration : null;

    let reps = '<option value="0">Forever</option>';
    for (const n of [1, 2, 3, 4, 5, 10, 15, 20, 30, 50, 100]) {
      reps += '<option value="' + n + '"' + (defRep === n ? ' selected' : '') + '>' + n + (n === 1 ? ' time' : ' times') + '</option>';
    }

    let swatches = '';
    PALETTE.forEach(c => {
      swatches += '<button class="swb' + (c === defColor ? ' on' : '') + '" data-act="swatch" data-c="' + c + '" style="background:' + c + '" aria-label="Color ' + c + '"></button>';
    });

    const tlHtml = dur
      ? '<div class="f"><span>Fine-select with your mouse — drag the two handles on the bar</span>' +
        '<div class="tl" id="eTl">' +
        '<div class="tl-range" id="tlRange"></div>' +
        '<div class="tl-ph" id="tlPh"></div>' +
        '<div class="tl-h tl-h-s" id="tlHs" data-h="start" title="Start time"></div>' +
        '<div class="tl-h tl-h-e" id="tlHe" data-h="end" title="End time"></div>' +
        '</div></div>'
      : '';

    let steps = '';
    for (const sv of [0.1, 0.5, 1, 5]) {
      steps += '<button class="chip' + (state.editStep === sv ? ' on' : '') + '" data-step="' + sv + '">' + sv + 's</button>';
    }

    ui.list.innerHTML = '<div class="ed">' +
      '<div class="ed-h">' + (item ? 'Edit ' : 'New ') + (isLoop ? 'loop' : 'skip') + '</div>' +
      '<label class="f"><span>Name <em>(optional)</em></span><input id="eName" maxlength="40" placeholder="' + (isLoop ? 'e.g. Chorus' : 'e.g. Boring intro') + '" value="' + escapeAttr(defName) + '"></label>' +
      tlHtml +
      '<div class="f"><span>Start</span><div class="trow2">' +
      '<button class="btn tiny nb" data-nudge="start" data-dir="-1" aria-label="Nudge start back">−</button>' +
      '<input id="eStart" inputmode="decimal" placeholder="0:12" value="' + escapeAttr(fmt(defStart)) + '">' +
      '<button class="btn tiny nb" data-nudge="start" data-dir="1" aria-label="Nudge start forward">+</button>' +
      '<button class="btn tiny" data-act="now" data-t="start">Now</button>' +
      '</div></div>' +
      '<div class="f"><span>End</span><div class="trow2">' +
      '<button class="btn tiny nb" data-nudge="end" data-dir="-1" aria-label="Nudge end back">−</button>' +
      '<input id="eEnd" inputmode="decimal" placeholder="0:30" value="' + escapeAttr(fmt(defEnd)) + '">' +
      '<button class="btn tiny nb" data-nudge="end" data-dir="1" aria-label="Nudge end forward">+</button>' +
      '<button class="btn tiny" data-act="now" data-t="end">Now</button>' +
      '</div></div>' +
      '<div class="f"><span>Fine step (for the − / + buttons)</span><div class="steps">' + steps + '</div></div>' +
      (isLoop ? '<div class="f"><span>Repeat</span><select id="eRep">' + reps + '</select></div>' : '') +
      '<div class="f"><span>Color</span><div class="swatches">' + swatches + '</div></div>' +
      '<div class="ed-err" id="eErr"></div>' +
      '<div class="ed-actions"><button class="btn primary" data-act="save">Save</button><button class="btn ghost" data-act="cancel">Cancel</button></div>' +
      '</div>';

    const inpStart = ui.list.querySelector('#eStart');
    const inpEnd = ui.list.querySelector('#eEnd');
    const tl = ui.list.querySelector('#eTl');
    const range = ui.list.querySelector('#tlRange');
    const ph = ui.list.querySelector('#tlPh');
    const hS = ui.list.querySelector('#tlHs');
    const hE = ui.list.querySelector('#tlHe');

    const toPct = t => dur ? clamp(t / dur * 100, 0, 100) : 0;

    function tlSync() {
      if (!dur) return;
      const s = clamp(parseTime(inpStart.value) || 0, 0, dur);
      let e = parseTime(inpEnd.value);
      if (isNaN(e)) e = s + 1;
      e = clamp(e, Math.min(s + 0.1, dur), dur);
      range.style.left = toPct(s) + '%';
      range.style.width = Math.max(0.4, toPct(e) - toPct(s)) + '%';
      hS.style.left = toPct(s) + '%';
      hE.style.left = toPct(e) + '%';
    }

    function nudge(field, dir) {
      const inp = field === 'start' ? inpStart : inpEnd;
      let t = parseTime(inp.value);
      if (isNaN(t)) t = 0;
      t = Math.round((t + dir * state.editStep) * 1000) / 1000;
      if (t < 0) t = 0;
      if (dur) t = Math.min(t, dur);
      inp.value = fmt(t);
      tlSync();
    }

    ui.list.querySelectorAll('[data-nudge]').forEach(b => {
      const field = b.dataset.nudge, dir = parseInt(b.dataset.dir, 10);
      bindHold(b, () => nudge(field, dir));
    });

    ui.list.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
      state.editStep = parseFloat(c.dataset.step) || 0.1;
      ui.list.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
    }));

    ui.list.querySelectorAll('[data-act="now"]').forEach(b => b.addEventListener('click', () => {
      const v = state.bound;
      if (!v) return;
      const inp = b.dataset.t === 'start' ? inpStart : inpEnd;
      inp.value = fmt(v.currentTime);
      tlSync();
    }));

    if (tl) {
      tl.addEventListener('pointerdown', e => {
        const rect = tl.getBoundingClientRect();
        const timeAt = x => clamp((x - rect.left) / rect.width, 0, 1) * dur;
        const handle = e.target.closest('.tl-h');
        if (handle) {
          e.preventDefault();
          const field = handle.dataset.h;
          const move = ev => {
            const t = Math.round(timeAt(ev.clientX) * 1000) / 1000;
            if (field === 'start') {
              const en = parseTime(inpEnd.value) || dur;
              inpStart.value = fmt(clamp(t, 0, Math.max(0, en - 0.1)));
            } else {
              const st = parseTime(inpStart.value) || 0;
              inpEnd.value = fmt(clamp(t, Math.min(st + 0.1, dur), dur));
            }
            tlSync();
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        } else if (state.bound) {
          // click anywhere on the bar: jump the video there to preview the spot
          try { state.bound.currentTime = Math.min(timeAt(e.clientX), dur - 0.05); } catch (err) {}
        }
      });
      // live playhead while the editor is open
      const drawPh = () => {
        const v = state.bound;
        if (v && isFinite(v.duration)) ph.style.left = toPct(v.currentTime) + '%';
      };
      drawPh();
      state._tlTimer = setInterval(() => {
        if (!ph || !ph.isConnected) { clearInterval(state._tlTimer); state._tlTimer = null; return; }
        drawPh();
      }, 200);
      tlSync();
    }

    ui.list.querySelector('[data-act="save"]').addEventListener('click', () => {
      if (state._tlTimer) { clearInterval(state._tlTimer); state._tlTimer = null; }
      saveEditor();
    });
    ui.list.querySelector('[data-act="cancel"]').addEventListener('click', () => {
      if (state._tlTimer) { clearInterval(state._tlTimer); state._tlTimer = null; }
      state.edit = null;
      renderList();
    });
  }

  function saveEditor() {
    const isLoop = state.edit.type === 'loop';
    const errEl = ui.list.querySelector('#eErr');
    const start = parseTime(ui.list.querySelector('#eStart').value);
    let end = parseTime(ui.list.querySelector('#eEnd').value);
    const name = (ui.list.querySelector('#eName').value || '').trim();
    const v = state.bound;
    const dur = v && isFinite(v.duration) ? v.duration : null;

    const fail = m => { errEl.textContent = m; };

    if (isNaN(start) || start < 0) return fail('Start time looks wrong. Try formats like 1:23 or 1:02:03.');
    if (isNaN(end) || end <= start) return fail('End must be after the start.');
    if (dur != null) {
      if (start >= dur) return fail('This video is only ' + fmt(dur) + ' long.');
      if (end > dur) end = isLoop ? dur : Math.max(start + 0.5, dur - 0.2);
    }
    if (state.edit.type === 'skip' && dur != null) {
      if (start >= dur - 0.2) return fail('Skips must end before the video does.');
      end = Math.min(end, dur - 0.2);
    }

    const arr = isLoop ? state.data.loops : state.data.skips;
    if (state.edit.id) {
      const it = findItem(state.edit.type, state.edit.id);
      if (it) {
        it.start = start; it.end = end; it.name = name; it.color = state.editColor;
        if (isLoop) it.repeats = parseInt(ui.list.querySelector('#eRep').value, 10) || 0;
      }
    } else {
      const seqKey = isLoop ? 'loop' : 'skip';
      const item = {
        id: uid(),
        name: name || (isLoop ? 'Loop ' + (++state.data.seq.loop) : 'Skip ' + (++state.data.seq.skip)),
        start, end, color: state.editColor, enabled: true
      };
      if (isLoop) item.repeats = parseInt(ui.list.querySelector('#eRep').value, 10) || 0;
      arr.push(item);
    }
    state.edit = null;
    dirty(); renderList(); renderMarkers();
    toast((isLoop ? 'Loop' : 'Skip') + ' saved for this video ✓');
  }

  function openEditor(type, id) {
    state.edit = { type, id };
    if (id) {
      const it = findItem(type, id);
      if (it) state.editColor = it.color;
    } else {
      const count = (type === 'loop' ? state.data.loops.length : state.data.skips.length);
      state.editColor = PALETTE[count % PALETTE.length];
    }
    renderEditor();
  }

  function findItem(type, id) {
    const arr = type === 'loop' ? state.data.loops : state.data.skips;
    return arr.find(x => x.id === id) || null;
  }

  function toggleItem(kind, id, on) {
    const it = findItem(kind, id);
    if (!it) return;
    it.enabled = on;
    if (kind === 'loop') { it._plays = 0; it._done = false; }
    else it._off = false;
    dirty(); renderList(); renderMarkers();
  }

  let lastDeleted = null;
  function deleteItem(kind, id) {
    const arr = kind === 'loop' ? state.data.loops : state.data.skips;
    const idx = arr.findIndex(x => x.id === id);
    if (idx < 0) return;
    const [item] = arr.splice(idx, 1);
    if (state.edit && state.edit.id === id) state.edit = null;
    lastDeleted = { kind, item, idx };
    dirty(); renderList(); renderMarkers();
    toast('Deleted "' + (item.name || kind) + '"', () => {
      if (!lastDeleted) return;
      const a = lastDeleted.kind === 'loop' ? state.data.loops : state.data.skips;
      a.splice(Math.min(lastDeleted.idx, a.length), 0, lastDeleted.item);
      lastDeleted = null;
      dirty(); renderList(); renderMarkers();
      toast('Restored ✓');
    });
  }

  function resetStats() {
    const old = Object.assign({}, state.data.stats);
    state.data.stats = { loopPlays: 0, skipCount: 0, secondsSaved: 0 };
    dirty(); renderList();
    toast('Stats reset for this video', () => {
      state.data.stats = old;
      dirty(); renderList();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const escapeAttr = escapeHtml;

  // press-and-hold repeater for nudge buttons
  function bindHold(btn, fn) {
    let rep = null, delay = null;
    const start = e => {
      e.preventDefault();
      fn();
      delay = setTimeout(() => { rep = setInterval(fn, 100); }, 350);
    };
    const stop = () => { clearTimeout(delay); clearInterval(rep); rep = null; delay = null; };
    btn.addEventListener('pointerdown', start);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stop));
  }

  // ---------------------------------------------------------------- toast
  let toastTimer = null, toastUndoFn = null;
  function toast(msg, undoFn, ms = 4500) {
    if (!ui.toast) return;
    ui.toastMsg.textContent = msg;
    ui.toastUndo.style.display = undoFn ? '' : 'none';
    toastUndoFn = undoFn || null;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    ui.toast.classList.remove('show');
    toastUndoFn = null;
  }

  // ---------------------------------------------------------------- export / import
  async function exportAll() {
    const all = await getAllVideos();
    const payload = { app: 'youtube-timestamp-tools', version: 1, exported: new Date().toISOString(), videos: all };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'youtube-timestamp-tools-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Backup file downloaded ✓');
  }

  async function importFromText(text) {
    const data = JSON.parse(text);
    const videos = data && data.videos;
    if (!videos || typeof videos !== 'object') throw new Error('bad file');
    let n = 0;
    for (const [id, v] of Object.entries(videos)) {
      if (!v || typeof v !== 'object') continue;
      await setVideoData(id, v);
      n++;
    }
    if (state.videoId) state.data = normalize(await getVideoData(state.videoId));
    return n;
  }

  // ---------------------------------------------------------------- navigation
  async function loadVideo(id) {
    const seq = ++state.loadSeq;
    const d = await getVideoData(id);
    if (seq !== state.loadSeq) return;
    state.data = d;
    renderAll();
  }

  function onNav() {
    const id = getVideoId();
    if (id === state.videoId) { ensureBound(); applyVisibility(); ensureMarkers(); return; }
    flush();
    state.videoId = id;
    state.prevTime = null;
    if (state._tlTimer) { clearInterval(state._tlTimer); state._tlTimer = null; }
    state.edit = null;
    ensureBound();
    if (id) loadVideo(id);
    else { state.data = freshData(); renderAll(); }
  }

  // ---------------------------------------------------------------- external wiring
  function watchStorage() {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'sync' && area !== 'local') return;
      if (ch.settings) {
        state.settings = Object.assign({}, DEFAULT_SETTINGS, ch.settings.newValue || {});
        applyEnabled(); applyVisibility(); renderMarkers();
      }
      for (const k of Object.keys(ch)) {
        if (k === 'v:' + state.videoId && Date.now() - state.lastWrite > 1500) {
          loadVideo(state.videoId);
        }
      }
    });
  }

  function bindMessages() {
    chrome.runtime.onMessage.addListener((msg, _sender, send) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'getStatus') {
        send({
          ok: true,
          isWatch: isWatchPage(),
          videoId: state.videoId,
          title: (document.title || '').replace(/ - YouTube$/, ''),
          loops: state.data.loops.length,
          skips: state.data.skips.length,
          enabled: state.settings.enabled,
          live: !!(state.bound && state.bound.duration === Infinity)
        });
      } else if (msg.type === 'showPanel') {
        if (!isWatchPage()) { toast('Open a YouTube video or Short first'); }
        else {
          state.settings.panelHidden = false;
          saveSettings(); applyVisibility();
        }
        send({ ok: true });
      }
    });
  }

  function startWatchers() {
    window.addEventListener('yt-navigate-finish', () => setTimeout(onNav, 60));
    window.addEventListener('yt-navigate-start', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('fullscreenchange', updateFab);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    setInterval(() => {
      ensureBound();
      if (getVideoId() !== state.videoId) onNav();
      else ensureMarkers();
    }, 700);
  }

  // ---------------------------------------------------------------- init
  async function init() {
    state.settings = await loadSettings();
    buildUI();
    onNav();
    if (state.settings.firstRun) {
      setTimeout(() => toast('Welcome! Drag the panel header to move it — everything you add is saved automatically.', null, 7000), 1200);
      state.settings.firstRun = false;
      saveSettings();
    }
    startWatchers();
    watchStorage();
    bindMessages();
    requestAnimationFrame(tick);
  }

  init();
})();
