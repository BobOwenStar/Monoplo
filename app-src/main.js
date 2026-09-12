const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const { connect, setActivity, clearActivity, disconnect } = require('./src/discordPresence');
const { getNowPlaying } = require('./src/nowPlaying');
const { getGameStatus } = require('./src/hitmanDetector');
const { getAlbumArtUrl } = require('./src/albumArt');

// Tokens usable inside the Custom Activity text fields. {albumArt} is
// special-cased separately since it only makes sense inside an image key.
const TEXT_TOKEN_PATTERN = /\{(song|artist|album|app)\}/i;
const ART_TOKEN_PATTERN = /\{albumArt\}/i;

// Tiny built-in tray icon (a tray needs SOME image) so the app doesn't
// depend on an external asset file just for Sleep Mode to work.
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABA0lEQVR4nM1XQRKCMAwExqu+Tx4gj9IH6PvkAXpqp7RNs5sGdGc4MKTZzaahMAw/xsguuN7en9bz1+NC5YSDNWKrEDWIJWaFTHuSIzlEAR7kSK6qPRby5/28uZ+XtYiptaNwwLNyJPeoBUjIK85RcyAgdeKEEqLELGILkOq9yFOu5hhq5POyxguJr2HKFSGQSBkETsgBq/XIOrgFAb2VdwvwBj2GElJnmJbRDmjJ2f0CCbD2HVlnakGo0mp7ivhO9n4TatWH84DaA2grmJa5noYocddpyJJp2LSA/aS2IOco9sCeIqBPsr1ESDnFKfAU0crVHEMPEVqO//81Y4UcMUmu+ALNb3ygF7QCowAAAABJRU5ErkJggg==';

// Custom URL scheme used by the "Run back on app" button when the
// renderer detects it's been opened in a plain browser tab instead of
// inside this Electron app (see the browser-block overlay in
// renderer.js). Clicking it hands off to the OS, which — if this app is
// installed — launches/focuses it via the handler registered below.
const PROTOCOL_SCHEME = 'customrpc';

const DEFAULT_CONFIG = {
  discordClientId: '',
  updateIntervalSeconds: 15,
  // 'auto' = Game/Music detection below. 'custom' = whatever's in
  // customActivity, exactly as typed in the Custom Activity panel.
  mode: 'auto',
  musicLargeImage: 'music_logo',
  gameProcessName: 'HITMAN3.exe',
  gameDetails: 'Contract in progress',
  gameState: 'Playing HITMAN 3',
  gameLargeImage: 'hitman3_logo',
  customActivity: {
    details: '',
    state: '',
    largeImageKey: '',
    largeImageText: '',
    smallImageKey: '',
    smallImageText: '',
    showTimestamp: true,
  },
};

let config = cloneDefaults();
let mainWindow = null;
let tray = null;
let tickHandle = null;
let connectedClientId = null;
let customActivityStartedAt = Date.now();
let isQuitting = false;

// Remembers the last cover art URL found for a given track, keyed by
// "title::artist::album". The Custom Activity preview and Music panel
// reuse this instead of triggering their own Deezer lookups on every poll.
let lastArt = { key: null, url: null };

// Single persistent snapshot shown in the Status panel's boxed display —
// replaced in place every tick instead of appending endless log lines.
let statusState = {
  song: null,
  author: null,
  album: null,
  source: null, // "Spotify", "Playing HITMAN 3", etc.
  error: null,
};

function trackKey(track) {
  return track ? `${track.title || ''}::${track.artist || ''}::${track.album || ''}`.toLowerCase() : null;
}

function cloneDefaults() {
  return { ...DEFAULT_CONFIG, customActivity: { ...DEFAULT_CONFIG.customActivity } };
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    config = {
      ...cloneDefaults(),
      ...parsed,
      customActivity: { ...DEFAULT_CONFIG.customActivity, ...(parsed.customActivity || {}) },
    };
  } catch {
    config = cloneDefaults();
  }
}

function persistConfig(newConfig) {
  const prevCustomJSON = JSON.stringify(config.customActivity || {});
  const prevMode = config.mode;

  config = { ...config, ...newConfig };
  if (newConfig.customActivity) {
    config.customActivity = { ...DEFAULT_CONFIG.customActivity, ...newConfig.customActivity };
  }

  const nextCustomJSON = JSON.stringify(config.customActivity || {});
  const justSwitchedToCustom = config.mode === 'custom' && prevMode !== 'custom';
  if (nextCustomJSON !== prevCustomJSON || justSwitchedToCustom) {
    // Restart the "elapsed" timer whenever the custom activity's content
    // actually changes, so it reads as freshly started rather than
    // picking up wherever the old one left off.
    customActivityStartedAt = Date.now();
  }

  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  return config;
}

// --- Status panel state (boxed, non-spammy) -------------------------------
//
// Replaces the old scrolling "status-log" line-append approach. Instead of
// pushing a new line every tick, we keep one snapshot object and push the
// whole thing to the renderer each time something in it actually changes.
// The renderer just redraws the fixed set of fields in place.

function pushStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', { ...statusState, at: new Date().toLocaleTimeString() });
  }
}

function setNowPlayingStatus({ song, author, album, source }) {
  statusState = { ...statusState, song: song ?? null, author: author ?? null, album: album ?? null, source: source ?? null };
  pushStatus();
}

function setError(message) {
  statusState = { ...statusState, error: message };
  pushStatus();
}

function clearError() {
  if (statusState.error !== null) {
    statusState = { ...statusState, error: null };
  }
  pushStatus();
}

async function ensureDiscordConnected() {
  if (!config.discordClientId) return false;
  if (connectedClientId === config.discordClientId) return true;

  try {
    await connect(config.discordClientId);
    connectedClientId = config.discordClientId;
    clearError();
    return true;
  } catch (err) {
    setError(`Discord connect failed: ${err.message}`);
    return false;
  }
}

/**
 * Fetches whatever's currently playing, and optionally its cover art, in
 * one place — shared by the auto-detect music branch and by custom-mode
 * token substitution below, so both stay in sync.
 */
async function getMusicSnapshot({ needArt } = {}) {
  const { track, sessionNames } = await getNowPlaying();
  if (!track) return { track: null, sessionNames, artUrl: null };

  let artUrl = null;
  if (needArt) {
    try {
      // Looked up by title + artist + album (+ duration as a tiebreaker),
      // not just title/artist — otherwise two different songs that share
      // a title reliably grab the wrong cover.
      artUrl = await getAlbumArtUrl(track.title, track.artist, {
        album: track.album,
        durationMs: track.durationMs,
      });
      lastArt = { key: trackKey(track), url: artUrl };
    } catch {
      artUrl = null;
    }
  }
  return { track, sessionNames, artUrl };
}

async function applyCustomActivity() {
  const c = config.customActivity || {};
  const allText = [c.details, c.state, c.largeImageText, c.smallImageText].join('\n');
  const needsMusic = TEXT_TOKEN_PATTERN.test(allText);
  const needsArt = ART_TOKEN_PATTERN.test(c.largeImageKey || '') || ART_TOKEN_PATTERN.test(c.smallImageKey || '');

  let track = null;
  let artUrl = null;
  if (needsMusic || needsArt) {
    const snapshot = await getMusicSnapshot({ needArt: needsArt });
    track = snapshot.track;
    artUrl = snapshot.artUrl;
  }

  const fillText = (str) =>
    (str || '')
      .replace(/\{song\}/gi, track?.title || '')
      .replace(/\{artist\}/gi, track?.artist || '')
      .replace(/\{album\}/gi, track?.album || '')
      .replace(/\{app\}/gi, track?.app || '');

  const fillImage = (str) => (str || '').replace(ART_TOKEN_PATTERN, artUrl || config.musicLargeImage || '');

  const details = fillText(c.details);
  const state = fillText(c.state);
  const largeImageKey = fillImage(c.largeImageKey);
  const largeImageText = fillText(c.largeImageText);
  const smallImageKey = fillImage(c.smallImageKey);
  const smallImageText = fillText(c.smallImageText);

  if (!details && !state) {
    setNowPlayingStatus({ song: null, author: null, album: null, source: 'Custom Activity (empty)' });
    await clearActivity();
    return;
  }

  const activity = {
    details: details || undefined,
    state: state || undefined,
    largeImageKey: largeImageKey || undefined,
    largeImageText: largeImageText || undefined,
    smallImageKey: smallImageKey || undefined,
    smallImageText: smallImageText || undefined,
    instance: false,
  };

  if (c.showTimestamp) {
    activity.startTimestamp = Math.floor((customActivityStartedAt || Date.now()) / 1000);
  }

  await setActivity(activity);
  setNowPlayingStatus({
    song: track?.title || null,
    author: track?.artist || null,
    album: track?.album || null,
    source: 'Custom Activity',
  });
  clearError();
}

async function tick() {
  const connected = await ensureDiscordConnected();
  if (!connected) {
    setError('Waiting for a Discord Application ID to be set...');
    return;
  }

  if (config.mode === 'custom') {
    try {
      await applyCustomActivity();
    } catch (err) {
      setError(`Custom activity error: ${err.message}`);
    }
    return;
  }

  try {
    const game = await getGameStatus(config.gameProcessName);
    if (game.running) {
      await setActivity({
        details: config.gameDetails,
        state: config.gameState,
        startTimestamp: game.startedAt ? Math.floor(game.startedAt / 1000) : undefined,
        largeImageKey: config.gameLargeImage,
        largeImageText: config.gameState,
        instance: false,
      });
      setNowPlayingStatus({ song: null, author: null, album: null, source: config.gameState });
      clearError();
      return;
    }
  } catch (err) {
    setError(`Game detection error: ${err.message}`);
  }

  try {
    const { track, sessionNames, artUrl } = await getMusicSnapshot({ needArt: true });
    if (track) {
      const activity = {
        details: track.title,
        state: `by ${track.artist}`,
        largeImageKey: artUrl || config.musicLargeImage,
        largeImageText: track.album || track.title,
        instance: false,
      };
      if (track.durationMs > 0) {
        const nowMs = Date.now();
        activity.startTimestamp = Math.floor((nowMs - track.positionMs) / 1000);
        activity.endTimestamp = Math.floor((nowMs - track.positionMs + track.durationMs) / 1000);
      }
      await setActivity(activity);
      setNowPlayingStatus({ song: track.title, author: track.artist, album: track.album, source: track.app });
      clearError();
      return;
    }
    setNowPlayingStatus({
      song: null,
      author: null,
      album: null,
      source: sessionNames.length ? `Idle (open: ${sessionNames.join(', ')})` : 'No active media sessions',
    });
    clearError();
  } catch (err) {
    setError(`Music read error: ${err.message}`);
  }

  await clearActivity();
}

function startLoop() {
  if (tickHandle) clearInterval(tickHandle);
  const intervalMs = Math.max(5, Number(config.updateIntervalSeconds) || 15) * 1000;
  tickHandle = setInterval(tick, intervalMs);
  tick();
}

// --- Sleep mode (tray) -----------------------------------------------------
//
// "Sleep mode" hides the window entirely (no taskbar entry) while the
// tick loop above keeps running exactly as before, so Discord presence
// keeps updating. A tray icon is the only way back in — clicking it (or
// its "Show app" menu item) restores the window.

function createTray() {
  if (tray) return tray;
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip('Custom Discord RPC — sleeping (click to show)');
  const menu = Menu.buildFromTemplate([
    { label: 'Show app', click: wakeFromSleep },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', wakeFromSleep);
  tray.on('double-click', wakeFromSleep);
  return tray;
}

function enterSleepMode() {
  createTray();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
}

function wakeFromSleep() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

// --- Auto-update (GitHub Releases via electron-updater) --------------------
//
// Only meaningful in a packaged build (the installed .exe) — running via
// `npm start` from source has no app-update.yml to read, so this is a
// no-op in dev rather than throwing confusing errors. Only genuinely
// actionable states reach the renderer (an update needs a restart, or a
// check failed) — routine "checking..." pings are not surfaced, in
// keeping with keeping the UI from spamming the user with noise.

function pushUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', status);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    pushUpdateStatus({ state: 'downloading', version: info.version, percent: 0 });
  });

  autoUpdater.on('download-progress', (progress) => {
    pushUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    pushUpdateStatus({ state: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    pushUpdateStatus({ state: 'error', message: err.message });
  });

  const check = () => autoUpdater.checkForUpdates().catch((err) => {
    pushUpdateStatus({ state: 'error', message: err.message });
  });

  check();
  // Re-check periodically in case the app stays open for days at a time.
  setInterval(check, 4 * 60 * 60 * 1000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 760,
    minHeight: 580,
    backgroundColor: '#313338',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', () => {
    if (!isQuitting) mainWindow = null;
  });
}

// --- "Run back on app" protocol handoff ------------------------------------
//
// If someone hosts a copy of the renderer files on a plain website, that
// page has no preload/IPC bridge, so renderer.js shows a full-screen
// "APP BLOCKED — RUNNING ON WEBSITE" overlay with a "Run back on app"
// button. That button navigates to customrpc://focus, which the OS hands
// to this app (if installed) via the protocol handler below, and we just
// bring the real desktop window to the front.
if (!app.isDefaultProtocolClient(PROTOCOL_SCHEME)) {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Another launch (e.g. the protocol handoff, or double-clicking the
    // app again) should just surface the existing window, sleeping or not.
    if (tray) wakeFromSleep();
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.on('open-url', () => {
    if (tray) wakeFromSleep();
  });

  app.whenReady().then(() => {
    loadConfig();
    createWindow();
    startLoop();
    setupAutoUpdater();

    ipcMain.handle('get-config', () => config);

    ipcMain.handle('save-config', (_event, newConfig) => {
      const updated = persistConfig(newConfig);
      startLoop();
      return updated;
    });

    ipcMain.handle('enter-sleep-mode', () => {
      enterSleepMode();
      return true;
    });

    ipcMain.handle('restart-to-update', () => {
      autoUpdater.quitAndInstall();
    });

    // Lightweight snapshot of what's playing right now, for the Custom
    // Activity preview and the Music panel's "Now Playing" card. Position
    // and duration come straight from the OS (no network call), so this can
    // be polled often. Art is only ever included if a tick already looked
    // it up for this exact track — this handler never triggers its own
    // Deezer request, so polling it can't spam the API.
    ipcMain.handle('get-preview-data', async () => {
      try {
        const { track } = await getNowPlaying();
        if (!track) return null;
        const key = trackKey(track);
        return {
          title: track.title,
          artist: track.artist,
          album: track.album,
          app: track.app,
          positionMs: track.positionMs,
          durationMs: track.durationMs,
          fetchedAt: Date.now(),
          artUrl: lastArt.key === key ? lastArt.url : null,
        };
      } catch {
        return null;
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else wakeFromSleep();
    });
  });

  app.on('window-all-closed', () => {
    // A hidden (sleeping) window doesn't count as "closed" — hide() never
    // destroys it, so this only fires on a real quit.
    if (tickHandle) clearInterval(tickHandle);
    disconnect();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });
}
