// Flat top-level fields, bound directly to config[id].
const FIELDS = [
  'discordClientId',
  'updateIntervalSeconds',
  'musicLargeImage',
  'gameProcessName',
  'gameDetails',
  'gameState',
  'gameLargeImage',
];

// Fields that live under config.customActivity[id].
const CUSTOM_TEXT_FIELDS = [
  'customDetails',
  'customState',
  'customLargeImageKey',
  'customLargeImageText',
  'customSmallImageKey',
  'customSmallImageText',
];
// Maps input id -> key inside config.customActivity
const CUSTOM_KEY = {
  customDetails: 'details',
  customState: 'state',
  customLargeImageKey: 'largeImageKey',
  customLargeImageText: 'largeImageText',
  customSmallImageKey: 'smallImageKey',
  customSmallImageText: 'smallImageText',
};

// Sample values shown in the preview when nothing's actually playing yet.
const SAMPLE_TRACK = { title: 'Song Title', artist: 'Artist Name', album: 'Album Name', app: 'Spotify' };

let savedConfig = {};
let currentMode = 'auto';
let previewStartedAt = Date.now();
let previewTickHandle = null;
let previewPollHandle = null;
let livePreviewTrack = null;
let lastFocusedTemplateField = 'customDetails';

// Now Playing card state (Music panel). position/durationMs + fetchedAt
// come from the main process; the 1s ticker below extrapolates the
// current position locally in between polls, so the timer advances
// smoothly instead of jumping only when a new poll lands.
let nowPlayingData = null;
let nowPlayingTickHandle = null;

const saveBar = document.getElementById('saveBar');

function fieldEl(name) {
  return document.getElementById(name);
}

function readFormValues() {
  const values = {};
  for (const name of FIELDS) {
    const el = fieldEl(name);
    values[name] = el.type === 'number' ? Number(el.value) : el.value;
  }

  values.mode = currentMode;
  values.customActivity = {
    showTimestamp: fieldEl('customShowTimestamp').checked,
  };
  for (const name of CUSTOM_TEXT_FIELDS) {
    values.customActivity[CUSTOM_KEY[name]] = fieldEl(name).value;
  }

  return values;
}

function applyConfigToForm(config) {
  for (const name of FIELDS) {
    fieldEl(name).value = config[name] ?? '';
  }

  const c = config.customActivity || {};
  for (const name of CUSTOM_TEXT_FIELDS) {
    fieldEl(name).value = c[CUSTOM_KEY[name]] ?? '';
  }
  fieldEl('customShowTimestamp').checked = c.showTimestamp !== false;

  setMode(config.mode || 'auto', { silent: true });
  updatePreview();
}

function isDirty() {
  const current = readFormValues();
  const flatDirty = FIELDS.some(
    (name) => String(current[name]) !== String(savedConfig[name] ?? '')
  );
  const modeDirty = current.mode !== (savedConfig.mode || 'auto');
  const customDirty =
    JSON.stringify(current.customActivity) !==
    JSON.stringify({
      showTimestamp: true,
      details: '',
      state: '',
      largeImageKey: '',
      largeImageText: '',
      smallImageKey: '',
      smallImageText: '',
      ...(savedConfig.customActivity || {}),
    });
  return flatDirty || modeDirty || customDirty;
}

function refreshSaveBar() {
  const dirty = isDirty();
  saveBar.classList.toggle('visible', dirty);
  document.querySelectorAll('.nav-item:not(.active)').forEach((item) => {
    item.classList.toggle('locked', dirty);
  });
}

function shakeSaveBar() {
  saveBar.classList.remove('shake');
  // Force reflow so the animation restarts even if it's already mid-shake.
  void saveBar.offsetWidth;
  saveBar.classList.add('shake');
  setTimeout(() => saveBar.classList.remove('shake'), 450);
}

function setMode(mode, { silent } = {}) {
  currentMode = mode === 'custom' ? 'custom' : 'auto';
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });
  if (!silent) refreshSaveBar();
}

function setupNav() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.panel');

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      if (item.classList.contains('active')) return;
      if (isDirty()) {
        // Unsaved changes block navigation entirely — save or reset first.
        shakeSaveBar();
        return;
      }

      const target = item.dataset.panel;
      navItems.forEach((i) => i.classList.toggle('active', i === item));
      panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === target));
    });
  });
}

function setupModeSwitch() {
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value || '');
}

function setImageSlot(el, rawValue, resolvedValue) {
  if (rawValue && rawValue.trim() === '{albumArt}') {
    el.style.backgroundImage = resolvedValue && looksLikeUrl(resolvedValue) ? `url("${resolvedValue}")` : '';
    el.textContent = resolvedValue && looksLikeUrl(resolvedValue) ? '' : 'ART';
    return;
  }
  if (looksLikeUrl(rawValue)) {
    el.style.backgroundImage = `url("${rawValue.replace(/"/g, '')}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = rawValue ? rawValue.slice(0, 2).toUpperCase() : '';
  }
}

function fillTemplate(str) {
  const t = livePreviewTrack || SAMPLE_TRACK;
  return (str || '')
    .replace(/\{song\}/gi, t.title || '')
    .replace(/\{artist\}/gi, t.artist || '')
    .replace(/\{album\}/gi, t.album || '')
    .replace(/\{app\}/gi, t.app || '');
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')} elapsed`;
}

// mm:ss, matching how Discord itself displays elapsed/remaining time —
// e.g. 20 seconds in reads as "0:20", not "0:20 elapsed" or "00:20".
function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function renderNowPlaying() {
  const artEl = document.getElementById('npArt');
  const titleEl = document.getElementById('npTitle');
  const artistEl = document.getElementById('npArtist');
  const fillEl = document.getElementById('npBarFill');
  const timeEl = document.getElementById('npTime');

  if (!nowPlayingData) {
    artEl.style.backgroundImage = '';
    artEl.textContent = '♪';
    titleEl.textContent = 'Nothing playing right now';
    artistEl.textContent = 'Play something to see it here';
    fillEl.style.width = '0%';
    timeEl.textContent = '';
    return;
  }

  const { title, artist, artUrl, positionMs, durationMs, fetchedAt } = nowPlayingData;

  if (artUrl) {
    artEl.style.backgroundImage = `url("${artUrl.replace(/"/g, '')}")`;
    artEl.textContent = '';
  } else {
    artEl.style.backgroundImage = '';
    artEl.textContent = '♪';
  }

  titleEl.textContent = title || 'Unknown title';
  artistEl.textContent = artist || 'Unknown artist';

  if (durationMs > 0) {
    // The position ticks forward locally every second between polls, so
    // it advances in real time instead of only jumping every 4 seconds.
    const elapsedMs = Math.min(durationMs, (positionMs || 0) + (Date.now() - fetchedAt));
    fillEl.style.width = `${Math.min(100, (elapsedMs / durationMs) * 100)}%`;
    timeEl.textContent = `${formatTime(elapsedMs)} / ${formatTime(durationMs)}`;
  } else {
    fillEl.style.width = '0%';
    timeEl.textContent = '';
  }
}

function startNowPlayingTicker() {
  if (nowPlayingTickHandle) clearInterval(nowPlayingTickHandle);
  nowPlayingTickHandle = setInterval(renderNowPlaying, 1000);
}

function updatePreview() {
  const detailsRaw = fieldEl('customDetails').value;
  const stateRaw = fieldEl('customState').value;
  const largeImageRaw = fieldEl('customLargeImageKey').value;
  const smallImageRaw = fieldEl('customSmallImageKey').value;
  const showTimestamp = fieldEl('customShowTimestamp').checked;

  document.getElementById('previewDetails').textContent = fillTemplate(detailsRaw) || 'Details line goes here';
  document.getElementById('previewState').textContent = fillTemplate(stateRaw) || 'State line goes here';

  // The actual art URL is only resolved main-process side at update time
  // (that's where the Deezer lookup happens), so {albumArt} just shows a
  // muted "ART" placeholder here rather than a fetched image.
  setImageSlot(document.getElementById('previewLargeImg'), largeImageRaw, null);
  const smallImgEl = document.getElementById('previewSmallImg');
  smallImgEl.style.display = smallImageRaw ? 'block' : 'none';
  setImageSlot(smallImgEl, smallImageRaw, null);

  const elapsedEl = document.getElementById('previewElapsed');
  elapsedEl.textContent = showTimestamp ? formatElapsed(Date.now() - previewStartedAt) : '';
}

function insertTokenIntoField(fieldId, token) {
  const el = fieldEl(fieldId);
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + token + el.value.slice(end);
  const cursor = start + token.length;
  el.focus();
  el.setSelectionRange(cursor, cursor);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setupTokenButtons() {
  document.querySelectorAll('.field-row .token-btn, .token-row > .token-btn').forEach((btn) => {
    if (btn.id === 'useAlbumArtBtn') return; // handled separately, fixed target field
    btn.addEventListener('click', () => {
      insertTokenIntoField(lastFocusedTemplateField, btn.dataset.token);
    });
  });

  document.getElementById('useAlbumArtBtn').addEventListener('click', () => {
    insertTokenIntoField('customLargeImageKey', '{albumArt}');
  });

  ['customDetails', 'customState'].forEach((name) => {
    fieldEl(name).addEventListener('focus', () => {
      lastFocusedTemplateField = name;
    });
  });
}

function setupPreviewLiveUpdate() {
  const watched = [
    'customDetails',
    'customState',
    'customLargeImageKey',
    'customSmallImageKey',
    'customShowTimestamp',
  ];
  watched.forEach((name) => {
    fieldEl(name).addEventListener('input', () => {
      previewStartedAt = Date.now();
      updatePreview();
    });
  });

  if (previewTickHandle) clearInterval(previewTickHandle);
  previewTickHandle = setInterval(updatePreview, 1000);

  // Poll for what's actually playing right now, so the preview can show
  // real values instead of placeholder samples when tokens are used.
  const pollPreviewData = async () => {
    try {
      livePreviewTrack = await window.api.getPreviewData();
    } catch {
      livePreviewTrack = null;
    }
    nowPlayingData = livePreviewTrack;
    updatePreview();
    renderNowPlaying();
  };
  pollPreviewData();
  if (previewPollHandle) clearInterval(previewPollHandle);
  previewPollHandle = setInterval(pollPreviewData, 4000);
}

// --- Status box (replaces the old scrolling status-log) --------------------
//
// One fixed set of fields, updated in place every tick instead of an
// endless list of appended lines. The "Latest error" row is the only part
// that ever reads as an alert (styled red) and only holds the single most
// recent error — never a growing pile of past ones.

function renderStatusBox(state) {
  if (!state) return;
  document.getElementById('statSong').textContent = state.song || '—';
  document.getElementById('statAuthor').textContent = state.author || '—';
  document.getElementById('statAlbum').textContent = state.album || '—';
  document.getElementById('statSource').textContent = state.source || '—';
  document.getElementById('statUpdated').textContent = state.at || '—';

  const errorRow = document.getElementById('statErrorRow');
  const errorEl = document.getElementById('statError');
  if (state.error) {
    errorEl.textContent = state.error;
    errorRow.classList.add('has-error');
  } else {
    errorEl.textContent = 'None';
    errorRow.classList.remove('has-error');
  }
}

// --- Sleep mode --------------------------------------------------------

function setupSleepButton() {
  document.getElementById('sleepBtn').addEventListener('click', () => {
    window.api.enterSleepMode();
  });
}

// --- Browser-block overlay ----------------------------------------------
//
// window.api only exists when this page was loaded by our own preload
// script inside Electron. If it's missing, these files were opened some
// other way (a plain browser tab, a static web host, double-clicking the
// HTML file) where none of this can actually work — so block the page
// instead of pretending to function.

function showBlockedOverlay() {
  document.getElementById('blockedOverlay').hidden = false;
  document.querySelector('.app').hidden = true;
  document.getElementById('saveBar').hidden = true;

  document.getElementById('runOnAppBtn').addEventListener('click', () => {
    // Hands off to the installed desktop app via its registered
    // customrpc:// protocol. Browsers won't let a script close a tab it
    // didn't open itself, so if that's not possible here, this is the
    // most a web page is allowed to do — the rest is on the user to
    // close the tab and switch to the app that just opened.
    window.location.href = 'customrpc://focus';
  });
}

async function init() {
  if (!window.api) {
    showBlockedOverlay();
    return;
  }

  setupNav();
  setupModeSwitch();
  setupTokenButtons();
  setupPreviewLiveUpdate();
  setupSleepButton();
  startNowPlayingTicker();
  renderNowPlaying();

  savedConfig = await window.api.getConfig();
  applyConfigToForm(savedConfig);

  FIELDS.forEach((name) => {
    fieldEl(name).addEventListener('input', refreshSaveBar);
  });
  CUSTOM_TEXT_FIELDS.forEach((name) => {
    fieldEl(name).addEventListener('input', refreshSaveBar);
  });
  fieldEl('customShowTimestamp').addEventListener('input', refreshSaveBar);

  document.getElementById('resetBtn').addEventListener('click', () => {
    applyConfigToForm(savedConfig);
    refreshSaveBar();
  });

  document.getElementById('saveBtn').addEventListener('click', async () => {
    const values = readFormValues();
    savedConfig = await window.api.saveConfig(values);
    applyConfigToForm(savedConfig);
    previewStartedAt = Date.now();
    refreshSaveBar();
  });

  window.api.onStatusUpdate(renderStatusBox);
}

init();
