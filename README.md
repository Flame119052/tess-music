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

## Fixing a Mac remotely

Each Mac has three layers. Each one keeps working when the layer above it is broken:

1. **Updates.** The updater installs whatever the signed parts list on `stable` says. A push to `main` ships it.
2. **Doctor.** `tess doctor` checks every part and fixes what it safely can. The updater also runs it by itself
   whenever something fails. `tess report` sends a report right away and prints the Mac's install id.
3. **Rescue line.** A separate agent (`music.tess.rescue`) that updates never replace. Every 6 hours it fetches the
   rescue order from the `rescue` branch (or from the inbox if GitHub is unreachable) and runs it once. It runs only
   orders signed with the **rescue key** (`~/.config/tess-signing/rescue.pem`, kept only on this Mac, never in GitHub
   or CI), with a higher serial than any it has run, not expired, and for every Mac or this Mac's id.
   Publish one with `node tools/rescue.mjs fix.sh [--days 3] [--only <install id>]`.

**Reports.** Macs send anonymous health reports (a daily heartbeat, problems, failed installs, rescue results) to
the inbox, a Cloudflare Worker at `tess-music-player.janus.ing` (`inbox/`). Nothing personal is sent: the home
folder, account name, computer name and emails are removed. Users can turn reports off with `tess reports off`.
The inbox has no way to read anything over the web. Read reports with `node tools/reports.mjs`
(`problems`, `macs`, `mac <id>`, `show <n>`), which needs your Cloudflare login. Its limits keep it inside
Cloudflare's free allowances: 6 reports a minute per IP, 2,000 a day in total, 24 KB each, kept 30 days.

**Keys.** The release key (`private.pem`, also the `TESS_SIGNING_KEY` Actions secret) signs releases. The rescue key
signs rescue orders only. Back both up somewhere offline. Losing the rescue key means rescue orders can't be issued;
a leaked rescue key means rotating it with a normal update.

## For development

Start with **[`AGENTS.md`](AGENTS.md)** (rules, repo map, dev loop, how to check and ship), then
**[`DESIGN.md`](DESIGN.md)** (design system, motion and performance rules) and
**[`docs/architecture.md`](docs/architecture.md)** (install, updates, safety, releases). What's open:
[`docs/status.md`](docs/status.md) and the GitHub issues. Report security problems privately ([`SECURITY.md`](SECURITY.md)).

| Path | What |
|---|---|
| `theme/Tess/src/` | theme source (`core`, `home`, `playlist`, `dial-pick`); `tools/build.mjs` joins them into `user.css` / `theme.js` |
| `theme/loader/` | the self-updating, signature-checking loader the installer writes into Spotify |
| `installer/` | `install.sh` (public stub), `tess-install.sh` (installer; test against a copy: `TESS_TEST=1 TESS_HOME=… TESS_CONFIG=… TESS_SPOTIFY=/path/Spotify.app`), `updater.sh`, `doctor.sh`, `rescue.sh`, `uninstall.sh` |
| `mini/` | Tess Mini (SwiftUI) |
| `patcher/` | the Spicetify CLI fork (safe folder swap, `can-write`, `tess-verify`) |
| `inbox/` | the health-report inbox (Cloudflare Worker) |
| `tools/` | `hot.mjs` (live reload), `cdp.mjs` (drive the app), `bench.mjs` / `cpu-ab.mjs` / `ab.mjs` / traces (measure), `release.mjs`, `promote.mjs`, `rescue.mjs`, `reports.mjs`, `check-safety.sh` |
| branches `dev`, `stable`, `beta` | the signed release bundles (`dev` internal; `stable`/`beta` only by promotion) |

Release: every push to `main` that touches `theme/`, `mini/`, `patcher/` or `installer/` is built, signed and published
to the internal **`dev`** channel only (`.github/workflows/release.yml`); only the owner's Mac follows it. Nobody else
gets it until it's **promoted**: Actions → release → Run workflow → action `promote` (or `node tools/promote.mjs`),
which copies that exact dev build to `stable` and `beta`. The public install line (`installer/install.sh`) is a stub
that runs the installer from the last promoted release (`dist/install.sh`), so the installer is gated the same way;
the real installer is `installer/tess-install.sh`. Follow dev on a Mac with `TESS_CHANNEL=dev` before the install
line. By hand: `node tools/release.mjs auto|X.Y.Z [dev|beta|stable]` (signing keys in `~/.config/tess-signing/`).

How installed Macs update: the look and features load fresh on every Spotify start (`theme/loader/`, which falls back to
the last release that started cleanly). Every other part (the loader, patcher, Tess Mini, the updater itself) is kept
current by `installer/updater.sh`, which macOS runs every few minutes; it installs only what changed, after checking the
signed parts list. Installs from 0.1.0 read `Flame119052/tess-releases`, which each release mirrors; never archive it.
