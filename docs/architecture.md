# Architecture

How Tess gets onto a Mac, runs inside Spotify, keeps itself current, and gets fixed when something breaks.

## On a user's Mac

```
~/Library/Application Support/Tess/
  bin/patcher/        tess-patcher (Spicetify fork, signed "Tess Music"), tess-verify (release key), rescue/ (copies)
  updater.sh          background helper (self-updating)          ← LaunchAgent music.tess.guard (every 30 min + on Spotify file changes + woken by wake.sh)
  updater.env         SPOTIFY=…, TESS_PARTS_CHANNEL (dev/beta; absent = stable)
  doctor.sh           checks and safe fixes, health reports       ← `tess doctor`, `tess report`; run by the updater on trouble and daily
  wake.sh             reads the channel version, and the rescue serial only when rescue is on ← LaunchAgent music.tess.wake (every 5 min)
  installer.sh, uninstall.sh  signed copies used by `tess repair|uninstall` and the rescue line (no download from main)
  *.last-good         the previous copy of each updated part; state/bad-<part>-<sha> marks a version that broke, never retried
  rescue/             rescue.sh + tess-rescue-verify (rescue key) ← LaunchAgent music.tess.rescue (every 6 h, or woken); never auto-updated
  rescue-off          present after `tess rescue off`: the rescue line and its wake-up stay off
  state/              sha of each installed part, version, stamps (.reapply-tried-<ver>, .asked-<ver>, .checked, .heartbeat)
  original-<ver>/     a copy of this Spotify version's own interface files (for repair)
  install-id          random id used only in health reports (a new one any time: `tess reports new-id`)
  tess                command: update | repair | doctor | report | reports on|off|new-id | rescue on|off|log | status | uninstall
~/.config/tess-patcher/   patcher config + Themes/Tess (the loader theme)
~/.local/state/tess-patcher/Backup/   the patcher's backup of Spotify's .spa files
~/Applications/Tess Mini.app        ← LaunchAgent music.tess.mini
```

Inside Spotify (`Spotify.app/Contents/Resources/Apps/xpui`): Spicetify's wrapper, and `extensions/theme.js` =
**loader** + a baseline copy of the theme.

## Two update paths

1. **Look and features** (the theme): on every Spotify start the loader fetches `dist/manifest.json` for its channel
   (`tess:settings.channel` in Spotify's localStorage; default `stable`) from GitHub's API, falling back to jsDelivr;
   checks the signed envelope (`version`, `js`, `css`, `jsSha`, `cssSha`, `rev`) and the Ed25519 signatures of `theme.js` and
   `user.css`; runs it. `rev` only goes up per channel: a correctly signed but older release served by a mirror is
   refused. The cached copy is verified again on every read, so writing `tess:bundle` by hand no longer runs code. If a
   new release fails to start (`window.__tessReady` not set within 20 s), it's marked bad and the last good one (or the
   baseline) runs.
2. **Everything else** (updater, patcher, Tess Mini, doctor, loader theme): `updater.sh` reads the signed
   `dist/components.txt` for its channel (`name sha256 url source-hash` per line, plus `version` and `rev`), verifies
   the signature with `tess-verify`, refuses a lower `rev` than the channel has already installed, downloads only parts
   whose sha changed, checks each sha, installs. A new patcher triggers a
   re-apply check. The updater updates itself first. A theme part is staged as a complete `Apps` copy in a temp folder
   and switched in by `tess-patcher swap-apps`: macOS's App Management protection denies `/usr/bin/ditto` when launchd
   starts a script under `/bin/zsh`, so a background update cannot copy into Spotify itself. The swap (copy beside
   `Apps`, check it, two renames, restore on any failure) lives in the signed patcher; the scripts only call it.

## Rescue line

`rescue.sh` runs every six hours, at login, and within about 5 minutes of a new order (the wake check sees the new serial on the public `rescue` branch and starts it). The wake check reads that serial only when the rescue line is installed and on, and a failure to read it does not block an update wake-up. `tess rescue off` turns it off for good, and stops an order that has already started; `tess status` says whether the job is loaded, whether an order is running now, and which rescue key it trusts. The installer tells every user this. A Mac that already has the line and was never told is shown the notice once after its next update, as a notification, and `tess status` prints it if it has not been seen. What it can do is fixed in the file and limited to Tess and Spotify: an
order names one of five actions (`check`, `update`, `repair`, `restore-spotify`, `uninstall`), each of which calls Tess's
own installed, signed tool (doctor, updater, the installed installer copy, the patcher's safe restore, the installed
uninstaller). An order's header is `tess-rescue 2`, a serial, an expiry, an optional `only <id>...`, an optional
`timeout <seconds>` (60-3600, half an hour by default) and the action; nothing in it is executed as a script. The order
is stopped at its limit, and the stop and the limit go in the log. An action runs in a process group of its own, so the
limit stops the action and every process it started (the patcher, `ditto`, `curl`), not just the shell that started them;
the group's id and the time it started are written to `Tess/rescue/order.pid` while it runs, which is how `tess rescue off` stops a mistake that
already started (a number that no longer leads a group of Tess's own processes, or whose start time has changed, is ignored, then removed). `rescue off` writes `off` to the order's stop file before the signal, so the log and the report name it;
nothing of the order is still running when the line is logged. The report sent afterwards covers only the lines that
order wrote (the log's size is noted before it starts) and passes through the same privacy filter as every other report.
Rescue lines installed from this release on download nothing from `main`; `repair` runs the installer
the Mac last installed with. Older installed rescue
scripts remain unchanged and may still fetch repair and uninstall scripts from `main`. A current rescue script's
order can't carry a script or a command, so the rescue key can only press those buttons; `tools/test-rescue.mjs` proves scripts, unknown
actions and smuggled text are refused. Rescue lines installed before 13 Nov 2026 keep an older format whose signed orders can run any script, and updates never replace that script.

## Spotify updates itself

Its files go back to stock (`Apps/xpui.spa`). The updater notices (LaunchAgent WatchPaths), and:
1. tries once per Spotify version (never on a timer): `tess-patcher can-write Apps` first;
2. blocked by macOS App Management → Spotify untouched, one dialog with "Open Settings" and "Try Again";
3. allowed → copies Apps aside, `backup apply`, verifies the wrapper; on failure swaps the copy back and notifies once.
`tess doctor` (run by the user) clears the "tried" stamp so the next run tries again.

## Safety mechanisms

| Mechanism | Where | Protects against |
| --- | --- | --- |
| Safe folder swap | `patcher/src/cmd/swap.go`, run as `tess-patcher swap-apps` from the scripts | a half-done change leaving Spotify with no interface; macOS refusing a shell's copy in the background |
| Permission check first | `tess-patcher can-write` | macOS blocking mid-change |
| Safety copy + repair | `original-<ver>/`, patcher backup, known stock SHA-256s | lost interface files |
| Release gate | `tools/check-safety.sh` (CI + release script) | shipping a destructive or unparsable script |
| Script entry guard | the same block at the top of every `installer/*.sh` entry point, gated by `tools/check-safety.sh` and proved by `tools/test-script-guards.mjs` | an agent or a person running the real install, update, repair or uninstall by accident: a sourced copy, or a checkout's copy (#107) |
| Signed content | Ed25519 release key (CI secret + Krish's Mac) | tampered downloads |
| Pinned verifier | `installer/install.sh` + `installer/verify/<sha>` | a channel or mirror swapping the checker and installer together |
| Signed envelope + `rev` floor | `dist/manifest.json`, `components.txt`, loader | a correctly signed but older release (downgrade) |
| Verified cache | `theme/loader/loader.js` | code written into `tess:bundle` by another extension or an XSS |
| Stable code signature | "Tess Music" self-signed identity | macOS re-asking for permissions every update |
| Loader fallback | `theme/loader/loader.js` | a broken theme release |
| Channels | `dev` → declare → `beta` → promote → `stable` | untested builds reaching users |
| Rescue line | `installer/rescue.sh`, offline rescue key | updates stuck on a Mac |
| Health reports | `doctor.sh` → inbox | problems nobody reports |
| One privacy filter | `installer/redact.sh`, copied into the installer, doctor and rescue line, gated by `tools/check-safety.sh` | a report path leaking names, paths or emails because it was written separately |
| Verified ownership | `codesign`/`spctl` before any `sudo chown`: `codesign --verify --strict -R=…` tests Spotify's team id `2FNC3A47ZF` against the signature itself, and the canonical path is refused if it holds a control character | a password prompt and a root `chown -R` on a folder that is not Spotify |
| Single-statement inbox limits | `inbox/worker.js` | two requests at once slipping past a capped counter |
| Invisible characters dropped | `inbox/worker.js`, and again in `tools/reports.mjs` | a bidi override or zero-width character reordering a report line in a terminal |

## Release pipeline

`push to main` → `.github/workflows/release.yml`: `tools/check-safety.sh` → `tools/release.mjs auto dev`:
build theme → sign → build patcher (+ tess-verify, rescue verify), Tess Mini (universal), sign binaries with the
"Tess Music" identity → write `dist/` (manifest with `rev` and a signed envelope binding both file hashes, theme, components list +
signature + `rev`, `install.sh`, `install.sig`, `uninstall.sh`) to the
`dev` branch → GitHub Release `vX.Y.Z` (prerelease, the part files) → mirror the branch to
`Flame119052/tess-releases`.
Declaration (`tools/declare.mjs`): copy `dev`'s `dist/` byte for byte to `beta` (only the manifest's channel field
changes; it is outside the signed envelope), copy the install line to the channel root, record the source `main`
commit, and write release notes from every PR merged since the previous beta. Promotion (`tools/promote.mjs`): copy
that exact beta to `stable`, including its notes and channel-root install line, mirror it, and mark the release latest.
Both public-channel jobs use the protected GitHub `release` environment and support a no-write `--dry-run`.

Install line: `installer/install.sh` (forwarder on `main`) pins the committed verifier's SHA-256, downloads
`main/installer/verify/<sha>`, checks it, then downloads `$CH/dist/install.sh` and `dist/install.sig` and verifies the
installer before running it with that verifier → the installer checks `components.txt` before unpacking the patcher.
A channel with no signed installer refuses to install: the forwarder checks the verifier's pin and then stops with a
clear message. There is no fallback to `main`; after the first promote stable carries its own signed installer.

Every script that can act on a Mac — `install.sh`, `tess-install.sh`, `updater.sh`, `doctor.sh`, `rescue.sh`,
`uninstall.sh`, `wake.sh`, `tess-command.sh` — refuses to act when it is sourced or handed to a shell as text (`sh -c
"$(cat …)"`, `eval`), and, outside `TESS_TEST=1`, refuses to run from a git checkout or worktree unless
`TESS_REAL_INSTALL` is exactly `1` (#107). The installed copies keep working:
they are not checkout files, and the published install line arrives through a pipe, which names no file. `installer/redact.sh`
is a library, so it is the one file that is meant to be sourced.

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
only). `POST /v1/report` (≤32 KB JSON counted in bytes; Cloudflare per-IP limiter, 30/h per IP and 60/day per install in
D1, 2,000/day total, 24 KB of bytes kept per report, kept 30 days); `GET /v1/rescue.txt|.sig` from KV; `GET /v1/wake`
returns the newest rescue serial from D1 (KV fallback). No endpoint returns reports.

It fails closed: without the `SALT` secret (or with one shorter than 16 characters) `POST /v1/report` answers 503 and
stores nothing, because the stored per-IP keys would otherwise be a plain hash of an IP address. Every counter is one
`INSERT ... ON CONFLICT ... DO UPDATE`, so requests that arrive together cannot both read the same number and pass. Every
text field is stored with its C0 and C1 controls, bidi overrides and marks, zero-width characters and byte-order mark
removed: a report is read in a terminal, and those characters can reorder a line so an honest path reads as another one.
`tools/reports.mjs` drops them again on the way out, because rows stored before this rule are still in the database.
