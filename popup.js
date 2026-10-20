// YouTube Timestamp Tools — toolbar popup
'use strict';

const ICONS = {
  logo: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  up: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'
};

function icon(name, s = 14) {
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
}

function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + 'm ' + (s ? s + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function getSync(keys) { return new Promise(r => chrome.storage.sync.get(keys, r)); }
function setSync(obj) { return new Promise(r => chrome.storage.sync.set(obj, () => r(!chrome.runtime.lastError))); }
function setLocal(obj) { return new Promise(r => chrome.storage.local.set(obj, () => r(!chrome.runtime.lastError))); }

async function getAllVideos() {
  const s = await new Promise(r => chrome.storage.sync.get(null, r));
  const l = await new Promise(r => chrome.storage.local.get(null, r));
  const out = {};
  for (const [k, v] of Object.entries(Object.assign({}, l, s))) {
    if (!k.startsWith('v:') || !v || typeof v !== 'object') continue;
    const id = k.slice(2);
    if (!out[id] || ((v.u || 0) >= (out[id].u || 0))) out[id] = v;
  }
  return out;
}

async function saveVideo(id, data) {
  const ok = await setSync({ ['v:' + id]: data });
  if (!ok) await setLocal({ ['v:' + id]: data });
}

async function loadSettings() {
  const { settings } = await getSync('settings');
  return Object.assign({ enabled: true, loopsOn: true, skipsOn: true, panelHidden: false }, settings || {});
}

function status(msg, good = true) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.color = good ? '#4ade80' : '#fb7185';
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3500);
}

let currentTab = null;

async function init() {
  document.getElementById('logo').innerHTML = icon('logo', 18);
  document.getElementById('btnExport').innerHTML = icon('down') + ' Export all';
  document.getElementById('btnImport').innerHTML = icon('up') + ' Import';

  const s = await loadSettings();
  document.getElementById('swExt').checked = !!s.enabled;
  document.getElementById('swPanel').checked = !s.panelHidden;

  // current tab info
  const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
  currentTab = tabs && tabs[0];
  const url = currentTab && currentTab.url || '';
  const isYT = /^https:\/\/www\.youtube\.com\/(watch|shorts)/.test(url);

  if (isYT) {
    try {
      const res = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(currentTab.id, { type: 'getStatus' }, r => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError); else resolve(r);
        });
      });
      if (res && res.ok) {
        document.getElementById('videoBox').classList.remove('hidden');
        document.getElementById('vTitle').textContent = res.title || 'YouTube video';
        document.getElementById('vMeta').textContent =
          res.live ? 'Live stream — timestamps not available'
            : (res.videoId ? (res.loops + ' loop' + (res.loops === 1 ? '' : 's') + ' · ' + res.skips + ' skip' + (res.skips === 1 ? '' : 's') + ' saved for this video') : '');
      } else { showHint(); }
    } catch (e) { showHint(); }
  } else {
    document.getElementById('videoBox').classList.add('hidden');
    document.getElementById('hintBox').classList.remove('hidden');
    document.getElementById('hintText').textContent = 'Open a YouTube video or Short to start looping & skipping.';
  }

  // total time saved across all videos
  try {
    const all = await getAllVideos();
    let total = 0;
    for (const v of Object.values(all)) total += (v.stats && v.stats.secondsSaved) || 0;
    document.getElementById('totalSaved').textContent = total > 0 ? ('Time saved: ' + fmtDur(total)) : '';
  } catch (e) { /* ignore */ }
}

function showHint() {
  document.getElementById('videoBox').classList.add('hidden');
  document.getElementById('hintBox').classList.remove('hidden');
  document.getElementById('hintText').textContent = 'Refresh the YouTube page once, then come back here.';
}

document.getElementById('swExt').addEventListener('change', async e => {
  const s = await loadSettings();
  s.enabled = e.target.checked;
  await setSync({ settings: s });
});

document.getElementById('swPanel').addEventListener('change', async e => {
  const s = await loadSettings();
  s.panelHidden = !e.target.checked;
  await setSync({ settings: s });
});

document.getElementById('btnOpen').addEventListener('click', async () => {
  if (!currentTab) return;
  try {
    chrome.tabs.sendMessage(currentTab.id, { type: 'showPanel' }, () => void chrome.runtime.lastError);
  } catch (e) { /* ignore */ }
  window.close();
});

document.getElementById('btnExport').addEventListener('click', async () => {
  const all = await getAllVideos();
  const payload = { app: 'youtube-timestamp-tools', version: 1, exported: new Date().toISOString(), videos: all };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'youtube-timestamp-tools-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  status('Backup file downloaded ✓');
});

document.getElementById('btnImport').addEventListener('click', () => document.getElementById('file').click());

document.getElementById('file').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const data = JSON.parse(text);
    const videos = data && data.videos;
    if (!videos || typeof videos !== 'object') { status('Not a valid backup file', false); return; }
    let n = 0;
    for (const [id, v] of Object.entries(videos)) {
      if (!v || typeof v !== 'object') continue;
      await saveVideo(id, v);
      n++;
    }
    status('Imported ' + n + ' video' + (n === 1 ? '' : 's') + ' ✓');
  } catch (err) {
    status('Could not read that file', false);
  }
  e.target.value = '';
});

init();
