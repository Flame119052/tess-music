# Architecture

How Tess gets onto a Mac, runs inside Spotify, keeps itself current, and gets fixed when something breaks.

## On a user's Mac

```
~/Library/Application Support/Tess/
  bin/patcher/        tess-patcher (Spicetify fork, signed "Tess Music"), tess-verify (release key), rescue/ (copies)
  updater.sh          background helper (self-updating)          ← LaunchAgent music.tess.guard (every 30 min + on Spotify file changes + woken by wake.sh)
  updater.env         SPOTIFY=…, TESS_PARTS_CHANNEL (dev/beta; absent = stable)
  doctor.sh           checks and safe fixes, health reports       ← `tess doctor`, `tess report`; run by the updater on trouble and daily
  wake.sh             reads two public markers (channel version, rescue serial) ← LaunchAgent music.tess.wake (every 5 min)
  installer.sh, uninstall.sh  signed copies used by `tess repair|uninstall` and the rescue line (no download from main)
  *.last-good         the previous copy of each updated part; state/bad-<part>-<sha> marks a version that broke, never retried
  rescue/             rescue.sh + tess-rescue-verify (rescue key) ← LaunchAgent music.tess.rescue (every 6 h, or woken); never auto-updated
  rescue-off          present after `tess rescue off`: the rescue line and its wake-up stay off
  state/              sha of each installed part, version, stamps (.reapply-tried-<ver>, .asked-<ver>, .checked, .heartbeat)
  original-<ver>/     a copy of this Spotify version's own interface files (for repair)
  install-id          random id used only in health reports
  tess                command: update | repair | doctor | report | reports on|off | uninstall
~/.config/tess-patcher/   patcher config + Themes/Tess (the loader theme)
~/.local/state/tess-patcher/Backup/   the patcher's backup of Spotify's .spa files
~/Applications/Tess Mini.app        ← LaunchAgent music.tess.mini
```

Inside Spotify (`Spotify.app/Contents/Resources/Apps/xpui`): Spicetify's wrapper, and `extensions/theme.js` =
**loader** + a baseline copy of the theme.

## Two update paths

1. **Look and features** (the theme): on every Spotify start the loader fetches `dist/manifest.json` for its channel
   (`tess:settings.channel` in Spotify's localStorage; default `stable`) from GitHub's API, falling back to jsDelivr;
   checks the Ed25519 signatures of `theme.js` and `user.css`; runs it. If a new release fails to start
   (`window.__tessReady` not set within 20 s), it's marked bad and the last good one (or the baseline) runs.
2. **Everything else** (updater, patcher, Tess Mini, doctor, loader theme): `updater.sh` reads the signed
   `dist/components.txt` for its channel (`name sha256 url source-hash` per line + `version`), verifies the signature
   with `tess-verify`, downloads only parts whose sha changed, checks each sha, installs. A new patcher triggers a
   re-apply check. The updater updates itself first.

## Rescue line

`rescue.sh` runs every six hours, at login, and within about 5 minutes of a new order (the wake check sees the new serial on the public `rescue` branch and starts it). `tess rescue off` turns it off for good; `tess status` shows whether it's on and which rescue key it trusts. The installer tells every user this. What it can do is fixed in the file and limited to Tess and Spotify: an
order names one of five actions (`check`, `update`, `repair`, `restore-spotify`, `uninstall`), each of which calls Tess's
own installed, signed tool (doctor, updater, the installed installer copy, the patcher's safe restore, the installed
uninstaller). Rescue lines installed from this release on download nothing from `main`; `repair` runs the installer
the Mac last installed with, which until the first promote can be the temporary `main` fallback (#77). Older installed rescue
scripts remain unchanged and may still fetch repair and uninstall scripts from `main`. An order can't carry
a script or a command, so the rescue key can only press those buttons; `tools/test-rescue.mjs` proves scripts, unknown
actions and smuggled text are refused. (Rescue lines installed before 13 Nov 2026 used an older script format that new
orders don't reach.)

## Spotify updates itself

Its files go back to stock (`Apps/xpui.spa`). The updater notices (LaunchAgent WatchPaths), and:
1. tries once per Spotify version (never on a timer): `tess-patcher can-write Apps` first;
2. blocked by macOS App Management → Spotify untouched, one dialog with "Open Settings" and "Try Again";
3. allowed → copies Apps aside, `backup apply`, verifies the wrapper; on failure swaps the copy back and notifies once.
`tess doctor` (run by the user) clears the "tried" stamp so the next run tries again.

## Safety mechanisms

| Mechanism | Where | Protects against |
| --- | --- | --- |
| Safe folder swap | `patcher/src/cmd/swap.go`, `swap_apps` in scripts | a half-done change leaving Spotify with no interface |
| Permission check first | `tess-patcher can-write` | macOS blocking mid-change |
| Safety copy + repair | `original-<ver>/`, patcher backup, known stock SHA-256s | lost interface files |
| Release gate | `tools/check-safety.sh` (CI + release script) | shipping a destructive or unparsable script |
| Signed content | Ed25519 release key (CI secret + Krish's Mac) | tampered downloads |
| Stable code signature | "Tess Music" self-signed identity | macOS re-asking for permissions every update |
| Loader fallback | `theme/loader/loader.js` | a broken theme release |
| Channels | `dev` → declare → `beta` → promote → `stable` | untested builds reaching users |
| Rescue line | `installer/rescue.sh`, offline rescue key | updates stuck on a Mac |
| Health reports | `doctor.sh` → inbox | problems nobody reports |

## Release pipeline

`push to main` → `.github/workflows/release.yml`: `tools/check-safety.sh` → `tools/release.mjs auto dev`:
build theme → sign → build patcher (+ tess-verify, rescue verify), Tess Mini (universal), sign binaries with the
"Tess Music" identity → write `dist/` (manifest, theme, components list + signature, `install.sh`, `uninstall.sh`) to
the `dev` branch → GitHub Release `vX.Y.Z` (prerelease, the part files) → mirror the branch to
`Flame119052/tess-releases`.
Declaration (`tools/declare.mjs`): copy `dev`'s `dist/` byte for byte to `beta` (only the unsigned manifest channel
changes), copy the installer stub to the channel root, record the source `main` commit, and write release notes from
every PR merged since the previous beta. Promotion (`tools/promote.mjs`): copy that exact beta to `stable`, including
its notes and channel-root stub, mirror it, and mark the release latest. Both public-channel jobs use the protected
GitHub `release` environment and support a no-write `--dry-run`.

Install line: `installer/install.sh` (stub on `main`) → downloads `dist/install.sh` from the channel (`stable` unless
`TESS_CHANNEL=dev|beta`) → runs it. It falls back to `main/installer/tess-install.sh` only if the channel has none.

## Secrets

See [`secrets-and-env.md`](secrets-and-env.md) and [`../.env.example`](../.env.example) for full local, CI, and cloud
secret handling, `.gitignore` safeguards, and encrypted off-Mac backup policy (machine-specific paths live in
gitignored `.local/`).

| Secret | Where | Signs / does |
| --- | --- | --- |
| Release key (Ed25519) | `~/.config/tess-signing/private.pem`, Actions `TESS_SIGNING_KEY` | theme, components list |
| Rescue key (Ed25519) | `~/.config/tess-signing/rescue.pem` + AES-256 backups only | rescue orders |
| Code-signing identity | `codesign.p12/.pass`, Actions `TESS_CODESIGN_P12/_PASS` | patcher, verifiers, Tess Mini |
| Mirror deploy key | Actions `TESS_MIRROR_KEY` | push to tess-releases |
| Inbox IP hash salt | Cloudflare Worker secret `SALT` (`inbox/.dev.vars` locally) | hashes reporter IPs in D1 |
| Cloudflare login | Krish's wrangler login | inbox deploys, reading reports, publishing rescue orders to KV |

## Inbox (`inbox/`)

Cloudflare Worker `tess-inbox`, custom domain `tess-music-player.janus.ing` (Cloudflare Access bypass for that host
only). `POST /v1/report` (≤32 KB JSON; Cloudflare per-IP limiter, 30/h per IP and 60/day per install in D1, 2,000/day
total, kept 30 days); `GET /v1/rescue.txt|.sig` from KV; `GET /v1/wake` returns the newest rescue serial from D1
(KV fallback). No endpoint returns reports.
