# Custom Discord RPC

A desktop app (Electron) that sets a custom Discord Rich Presence status from
whatever's playing on your PC, or shows a fully custom activity you design
yourself.

Repo: https://github.com/BobOwenStar/Monoplo

## Running it from source (development)

1. Install [Node.js](https://nodejs.org) (LTS version) if you don't have it.
2. Open a terminal in the `app-src` folder.
3. Run:
   ```
   npm install
   npm start
   ```
   Auto-update checks are skipped in this mode (see below) — that's expected.

## Getting the code onto GitHub (one-time)

You already have the empty repo at `github.com/BobOwenStar/Monoplo`. From
inside this folder (the one containing this README):

```
git init
git remote add origin https://github.com/BobOwenStar/Monoplo.git
git add .
git commit -m "Initial commit"
git branch -M main
git push -u origin main
```

That's it — the code, the GitHub Actions workflow, and the auto-updater
config (`app-src/package.json`'s `build.publish` block) are already pointed
at `BobOwenStar/Monoplo`, so nothing else needs editing.

## Producing the .exe (automatic, via GitHub)

Every time you push a version tag, GitHub builds the Windows installer for
you (on GitHub's own Windows machine — you don't need Node, Electron, or
Windows locally to do this) and publishes it as a Release with the `.exe`
attached:

```
# bump "version" in app-src/package.json first, e.g. 1.0.0 -> 1.0.1
git add app-src/package.json
git commit -m "Bump version to 1.0.1"
git tag v1.0.1
git push origin main --tags
```

Watch it build under the repo's **Actions** tab. When it finishes, the
**Releases** page on the right side of the repo has the `.exe` — that's the
one file to hand out. No `node_modules`, no separate DLLs, nothing else to
zip up.

## What the .exe does when someone runs it

- Shows a normal Windows installer wizard (pick install folder, create
  shortcuts) — no admin prompt, installs just for the current user.
- Adds a Start Menu shortcut and a desktop shortcut.
- Registers itself in **Settings → Apps** (and Control Panel's "Programs and
  Features"), with a proper **Uninstall** entry — this is created
  automatically by the installer, no extra step needed.
- From then on, the running app quietly checks `BobOwenStar/Monoplo`'s
  Releases in the background. If a newer tagged version has been published,
  it downloads it and shows a small blue banner at the top: **"Update ready
  — restart to apply"**. The person just clicks Restart — no reinstalling,
  no re-downloading the `.exe` by hand. If a check ever fails (no internet,
  GitHub unreachable), the banner says so; it never fails silently.

## Shipping an update to everyone who already has it installed

Just repeat the tag step above with a higher version number. You never
resend the `.exe` to anyone — every existing install picks it up on its own
within a few hours (or immediately on next launch).

## What's in this update

- **Fixed the elapsed-time drift** ("2:34 in, showing 0:38") — the app now
  keeps its own running clock per track and self-corrects instead of
  trusting a potentially stale OS-reported position.
- **Status panel redesigned** as a fixed box (Song / Author / Album / Music
  Source) that updates in place, instead of an endlessly scrolling log.
  "Latest error" is a single line that only turns red while an error is
  actually active.
- **Cover-art lookup now uses album + track duration**, not just
  title/artist — fixes same-titled songs grabbing the wrong art, and won't
  guess if it isn't confident.
- **Browser-block screen** — if these files are ever opened outside the
  real app (e.g. hosted on a website), it blocks the page instead of
  pretending to work, with a "Run back on app" button.
- **Sleep mode** — hides the window into a tray icon; Discord presence
  keeps updating in the background. Click the tray icon to bring it back.
- **Auto-update via GitHub Releases** and a proper **Windows installer +
  uninstaller** (see above).

## Privacy & security, in brief

- No account, no login, no analytics, no telemetry.
- Settings are saved to a local `config.json` in your OS's app-data folder.
- Outbound network calls: your local Discord client (IPC, never leaves your
  machine), `api.deezer.com` (song title/artist/album, for cover art), and
  GitHub Releases (to check for and download app updates).
- Full detail is in the app's Legal & Privacy page.

See `app-src/main.js`, `app-src/src/`, and `app-src/renderer/` for the full
source — every file is plain, readable JavaScript with no obfuscation, no
build step, and no bundled binaries in this download.
