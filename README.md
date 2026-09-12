# Custom Discord RPC

A desktop app (Electron) that sets a custom Discord Rich Presence status from
whatever's playing on your PC, or shows a fully custom activity you design
yourself.

## Setup

This download does not include `node_modules` — that keeps the download
small and lets you verify every dependency yourself before installing
anything. To run it:

1. Install [Node.js](https://nodejs.org) (LTS version) if you don't have it.
2. Open a terminal in the `app-src` folder.
3. Run:
   ```
   npm install
   npm start
   ```

To build a standalone `.exe` you can run without Node installed:
```
npm run dist
```
This uses `electron-builder` and puts the result in `app-src/dist`.

## What's new in this update

- **Fixed cover art for singles.** The Deezer lookup used to grab the
  first search result and give up if its cover was missing — which mostly
  affected singles and less common tracks. It now checks several results,
  picks the closest title/artist match, and falls back through every
  available cover size before giving up.
- **Unsaved changes now actually block navigation.** Switching panels with
  unsaved changes shakes the save bar like before, but no longer lets you
  leave the page — save or reset first.
- **Live "Now Playing" card** on the Music panel shows the actual track
  position (e.g. `0:20 / 3:45`), advancing every second in real time —
  matching what Discord itself would show.
- **Redesigned interface** — refined colors, spacing, and typography
  throughout.
- **Added a Legal & Privacy page** inside the app, explaining exactly what
  data this app touches and where it goes (short version: your settings
  stay on your computer; the only outside connections are to your own
  Discord client and to Deezer's public search API for cover art).

## Privacy & security, in brief

- No account, no login, no analytics, no telemetry.
- Settings are saved to a local `config.json` in your OS's app-data folder.
- Outbound network calls: your local Discord client (IPC, never leaves your
  machine) and `api.deezer.com` (song title + artist only, for cover art).
- Full detail is in the app's Legal & Privacy page.

See `app-src/main.js`, `app-src/src/`, and `app-src/renderer/` for the full
source — every file is plain, readable JavaScript with no obfuscation, no
build step, and no bundled binaries in this download.
