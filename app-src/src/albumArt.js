/**
 * Looks up cover art for a track using Deezer's public search API.
 * Free, keyless, no account or sign-up needed — a plain GET request.
 * This is Deezer, not Apple/iTunes. No AI involved anywhere in this
 * file — it's a deterministic scoring function over Deezer's results.
 *
 * Matches on title + artist + album (+ duration, when we have it), so
 * two songs that share a title (extremely common — "Intro", "Home",
 * cover versions, remasters, etc.) no longer collide. Returns an https
 * image URL, or null if nothing matched confidently enough.
 */

// Short-lived cache so repeated lookups for the same track (every tick,
// every preview poll) don't hammer Deezer or re-do the same work.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

// Bits of a title/album that hurt search matching more than they help:
// "(feat. X)", "- Remastered 2011", "(Live)", "[Radio Edit]", etc.
const NOISE_PATTERN =
  /\s*[\(\[][^()[\]]*(feat\.?|featuring|remaster|remix|live|edit|version|mono|stereo|deluxe|explicit|clean|anniversary|bonus track)[^()[\]]*[\)\]]\s*/gi;
const DASH_SUFFIX_PATTERN = /\s+-\s+(remaster|remix|live|edit|version|mono|stereo|deluxe|single|radio edit).*$/i;

function cleanText(value) {
  return (value || '')
    .replace(NOISE_PATTERN, ' ')
    .replace(DASH_SUFFIX_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Picks the best available cover size for a Deezer track result. Singles
// and lower-profile releases sometimes lack the largest sizes, so this
// falls all the way down to whatever exists rather than giving up.
function bestCover(track) {
  const album = track?.album || {};
  return (
    album.cover_xl ||
    album.cover_big ||
    album.cover_medium ||
    album.cover_small ||
    track?.artist?.picture_xl ||
    track?.artist?.picture_big ||
    null
  );
}

/**
 * Scores how well a Deezer result matches what's actually playing.
 * Title and artist are still the primary signal, but album and track
 * duration are what actually disambiguate two different songs that
 * happen to share a title — which is the exact case that used to pick
 * the wrong cover art.
 */
function scoreMatch(result, want) {
  const rTitle = normalize(result?.title_short || result?.title);
  const rArtist = normalize(result?.artist?.name);
  const rAlbum = normalize(result?.album?.title);

  let score = 0;

  if (rTitle === want.title) score += 3;
  else if (rTitle && want.title && (rTitle.includes(want.title) || want.title.includes(rTitle))) score += 1.5;

  if (rArtist === want.artist) score += 2.5;
  else if (rArtist && want.artist && (rArtist.includes(want.artist) || want.artist.includes(rArtist))) score += 1;

  // Album match is the strongest disambiguator for same-titled tracks —
  // weighted higher than a loose title/artist overlap on its own.
  if (want.album) {
    if (rAlbum === want.album) score += 2.5;
    else if (rAlbum && (rAlbum.includes(want.album) || want.album.includes(rAlbum))) score += 1;
  }

  // Duration is a great tiebreaker when title+artist match multiple
  // releases (e.g. a song re-recorded, or on both a single and an
  // album). Deezer reports `duration` in whole seconds.
  if (want.durationMs && typeof result?.duration === 'number') {
    const deltaSeconds = Math.abs(result.duration - want.durationMs / 1000);
    if (deltaSeconds <= 2) score += 1.5;
    else if (deltaSeconds <= 6) score += 0.5;
  }

  if (bestCover(result)) score += 0.5; // slight nudge toward results that actually have art

  return score;
}

async function searchDeezer(query) {
  const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=15`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * @param {string} title
 * @param {string} artist
 * @param {object} [opts]
 * @param {string} [opts.album] - Album name, when known. Used to
 *   disambiguate tracks that share a title with something else.
 * @param {number} [opts.durationMs] - Track duration, when known. Used
 *   as a tiebreaker between otherwise-equal candidates.
 */
async function getAlbumArtUrl(title, artist, opts = {}) {
  const { album, durationMs } = opts;
  const cacheKey = `${title || ''}::${artist || ''}::${album || ''}`.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.url;

  try {
    const cleanedTitle = cleanText(title);
    const cleanedAlbum = cleanText(album);
    if (!cleanedTitle && !artist) return null;

    const want = {
      title: normalize(cleanedTitle || title),
      artist: normalize(artist),
      album: normalize(cleanedAlbum),
      durationMs,
    };

    // Try the most specific query first (title + artist + album), then
    // progressively looser fallbacks. A confident match early means we
    // skip the rest, so this doesn't burn extra requests in the common
    // case where the first query nails it.
    const queries = [
      [artist, cleanedTitle, cleanedAlbum].filter(Boolean).join(' '),
      [artist, cleanedTitle].filter(Boolean).join(' '),
      cleanedTitle,
      title,
    ]
      .map((q) => q.trim())
      .filter((q, i, arr) => q && arr.indexOf(q) === i); // dedupe

    let best = null;
    let bestScore = 0;
    for (const q of queries) {
      let results;
      try {
        results = await searchDeezer(q);
      } catch {
        continue;
      }
      for (const result of results) {
        const s = scoreMatch(result, want);
        if (s > bestScore) {
          bestScore = s;
          best = result;
        }
      }
      // A confident match (title + artist + one of album/duration
      // agreeing) is good enough — no need to burn extra requests on
      // the looser fallback queries.
      if (bestScore >= 5) break;
    }

    // Below this, we don't trust the match enough to risk showing the
    // wrong cover for a same-titled song — better no art than wrong art.
    const CONFIDENCE_FLOOR = 2;
    const url = best && bestScore >= CONFIDENCE_FLOOR ? bestCover(best) : null;
    cache.set(cacheKey, { url, at: Date.now() });
    return url;
  } catch (err) {
    console.error('[albumArt] lookup failed:', err.message);
    return null;
  }
}

module.exports = { getAlbumArtUrl };
