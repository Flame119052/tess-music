# Tess Music

Spotify, redesigned for the Mac. Tess gives the real Spotify desktop app an Apple-Music-grade interface, so
everything Spotify has (your library, Daily Mixes, downloads, lossless, lyrics, Canvas, Jam) keeps working.

## Install

You need a Mac (macOS 12+) with the Spotify desktop app installed and signed in. In Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/install.sh | sh
```

Spotify reopens with Tess and a short welcome to pick your defaults. Tess updates itself when Spotify starts, and a
small helper puts it back after Spotify updates itself. **Tess Mini**, a miniplayer that floats over every app, comes
with it (macOS 13+).

Update or repair with the same line. Remove everything and put Spotify back to stock:

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/uninstall.sh | sh
```

## What's in it

- A floating glass playing bar; a full-screen player with synced lyrics, Artwork / Video / Vinyl modes and a queue
  Cover Flow
- Home: a greeting, **The Dial** (a ring of picks you spin), "On this day"
- Library: a timeline in the sidebar, **Glass Shelves** when expanded
- Artist pages with a full-height looping video; playlist pages with a cover wall and who's-in-it
- ⌘K search, Spotify's real right-click menus, Liquid-Glass surfaces, a window that takes the music's colours
- Settings → Theme for every option

## Credits

- **Spicetify** — Tess is applied by `patcher/`, a fork of [Spicetify CLI](https://github.com/spicetify/cli)
  © the Spicetify contributors, under the **GNU Lesser General Public License v2.1** (`patcher/LICENSE`,
  `patcher/NOTICE.md`). Its history is kept in this repo; our changes are listed in `patcher/NOTICE.md`. All credit
  for the patching engine and the Spotify API wrapper belongs to the Spicetify project.
- The Dial's picking algorithm was designed with DeepSeek (`theme/Tess/src/dial-pick.js`, `docs/dial-algorithm.md`).
- Spotify is a trademark of Spotify AB. Tess is not affiliated with or endorsed by Spotify.

Tess modifies the Spotify app's interface files on your Mac. It never touches your account or downloads.
Spotify's User Guidelines say not to modify the client; no action against theme users is documented, but the risk is
yours to judge.

## For development

| Path | What |
|---|---|
| `theme/Tess/src/` | theme source (`core`, `home`, `playlist`, `dial-pick`); `tools/build.mjs` joins them into `user.css` / `theme.js` |
| `theme/loader/` | the self-updating, signature-checking loader the installer writes into Spotify |
| `installer/` | `install.sh`, `uninstall.sh` (test against a copy: `TESS_TEST=1 TESS_SPOTIFY=/path/Spotify.app`) |
| `mini/` | Tess Mini (SwiftUI) |
| `patcher/` | the Spicetify CLI fork |
| `tools/` | `hot.mjs` (live reload), `cdp.mjs` / `cdp-input.mjs` (drive the app), `release.mjs`, audits, profiling |
| `docs/` | research notes, the feedback checklist, what's left |
| branches `stable`, `beta` | the signed release bundles the loader downloads (written by `tools/release.mjs`) |

Release: every push to `main` that touches `theme/`, `mini/`, `patcher/` or `installer/updater.sh` ships to stable by
itself (`.github/workflows/release.yml`, once the `TESS_SIGNING_KEY` and `TESS_MIRROR_TOKEN` secrets are set). By hand:
`node tools/release.mjs auto|X.Y.Z [stable|beta]` (signing key in `~/.config/tess-signing/`).

How installed Macs update: the look and features load fresh on every Spotify start (`theme/loader/`, which falls back to
the last release that started cleanly). Every other part (the loader, patcher, Tess Mini, the updater itself) is kept
current by `installer/updater.sh`, which macOS runs every few minutes; it installs only what changed, after checking the
signed parts list. Installs from 0.1.0 read `Flame119052/tess-releases`, which each release mirrors; never archive it.
