const { getActiveSessions } = require('windows-media-sessions');

/**
 * --- Why the elapsed timer used to drift ("2:34 in, showing 0:38") ---
 * Windows only reports a fresh `positionMs` when the source app (Spotify,
 * a browser tab, etc.) explicitly pushes a timeline update — it does NOT
 * interpolate that number for us in between. Some apps push updates every
 * second; others only push on play/pause/seek and otherwise leave a
 * stale value sitting there for a while. The old code did
 * `Date.now() - positionMs` as if positionMs had just been measured
 * *right now*, so on any tick where the OS handed back a stale number,
 * Discord's "time elapsed" would fall further and further behind the
 * real playback position.
 *
 * Fix: keep our own running clock per track, and self-correct instead of
 * needing a manual fix. Every time the raw OS position agrees with what
 * we'd predict from steady playback, we trust our own clock (which never
 * goes stale). Whenever the raw value disagrees by more than a small
 * tolerance — a real seek, a pause/resume, or the source finally pushing
 * a fresh update — we resync to it. That keeps the timer accurate
 * automatically, tick after tick, with no manual intervention.
 */
const RESYNC_TOLERANCE_MS = 1500;

let posTracker = null; // { key, baseMs, baseAt }

function trackKey(t) {
  return `${t.title || ''}::${t.artist || ''}::${t.app || ''}`.toLowerCase();
}

function correctedPositionMs(rawTrack) {
  const now = Date.now();
  const raw = rawTrack.positionMs || 0;
  const key = trackKey(rawTrack);

  if (!posTracker || posTracker.key !== key) {
    posTracker = { key, baseMs: raw, baseAt: now };
    return raw;
  }

  const predicted = posTracker.baseMs + (now - posTracker.baseAt);

  if (Math.abs(raw - predicted) > RESYNC_TOLERANCE_MS) {
    // A real seek/pause/resume, or the source just pushed a fresh,
    // trustworthy update — resync our clock to it.
    posTracker = { key, baseMs: raw, baseAt: now };
    return raw;
  }

  // Raw value is just stale-but-consistent with steady playback; trust
  // our own clock so the number keeps advancing smoothly and accurately
  // between real OS updates instead of lagging behind.
  const clamped = rawTrack.durationMs > 0 ? Math.min(predicted, rawTrack.durationMs) : predicted;
  return Math.max(0, clamped);
}

/**
 * Returns whichever media session is currently playing, from ANY app —
 * Spotify, Apple Music, YouTube Music, a browser tab, VLC, anything that
 * reports to Windows' native media transport controls. There's no
 * per-app filtering and no third-party lookups: everything comes
 * straight from the OS (position/duration only — cover art is a
 * separate, opt-in lookup in albumArt.js).
 *
 * Returns { track, sessionNames }. track is null if nothing is playing.
 * sessionNames lists every currently-active session, for diagnostics.
 */
async function getNowPlaying() {
  const sessions = await getActiveSessions();

  const sessionNames = sessions.map(
    (s) => s.sourceAppDisplayName || s.sourceAppUserModelId
  );

  // getActiveSessions() already filters to playbackStatus === 'playing',
  // so the first result is simply whichever app is currently playing.
  const match = sessions[0];

  if (!match) {
    posTracker = null; // nothing playing — don't extrapolate stale state
    return { track: null, sessionNames };
  }

  const rawTrack = {
    title: match.title || 'Unknown title',
    artist: match.artist || 'Unknown artist',
    album: match.albumTitle || null,
    app: match.sourceAppDisplayName || match.sourceAppUserModelId,
    positionMs: match.timeline?.positionMs ?? 0,
    durationMs: match.timeline?.durationMs ?? 0,
  };

  rawTrack.positionMs = correctedPositionMs(rawTrack);

  return { track: rawTrack, sessionNames };
}

module.exports = { getNowPlaying };
