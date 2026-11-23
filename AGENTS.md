# AGENTS.md — working on Tess Music

Read this file before doing anything in this repo. It is the single source of instructions for every agent (Claude,
Codex, opencode, any other) and for people. `CLAUDE.md` only points here. Design decisions live in `DESIGN.md`, how
the pieces fit in `docs/architecture.md`, what is open in `docs/status.md` and GitHub issues, what comes next in
`docs/roadmap.md`, why things are the way they are in `docs/decisions.md` (add an entry for every decision you take)
and `docs/principles.md`.

## What Tess is

Tess Music restyles the real Spotify desktop app (macOS) into an Apple Music feel: a Liquid Glass bar and player,
synced lyrics, a vinyl/artwork/Canvas full-screen player, a Dial on Home, a timeline library. It runs inside Spotify
through a fork of Spicetify (`patcher/`), installs with one line, and keeps every part of itself up to date for life.
Owner: Krish (GitHub `Flame119052`). Real users run it on their own Macs; treat their Spotify as precious.

## The rules that are never broken

1. **Never leave anyone's Spotify broken.** Spotify's interface folder (`Spotify.app/Contents/Resources/Apps`) is never
   deleted and refilled; it is only replaced by switching in a complete, checked copy (`tess-patcher swap-apps`, backed
   by `swapApps` in the patcher). A failure at any step must leave Spotify exactly as it was. `tools/check-safety.sh`
   enforces this and blocks every release that breaks it.
2. **Test installers and updaters against a copy, never the real Spotify.** Use a sandbox (`TESS_TEST=1` with
   `TESS_HOME`, `TESS_CONFIG`, `TESS_SPOTIFY` pointing at a copied `Spotify.app` in a scratch folder). Run anything on
   Krish's real Spotify only when he says so, with Spotify closed.
   **Never source an installer script and never run one from a checkout to see what it does.** `. installer/tess-install.sh`
   (or `sh -c '. installer/tess-install.sh; …'`) ran the real installer on Krish's Mac once, and a checkout's copy is
   not the signed copy users get. Every entry-point script now refuses all of them outside a sandbox and prints why:
   sourcing does nothing at all, handing the file's text to a shell (`sh -c "$(cat …)"`, `eval`) exits, and a copy
   inside a git checkout or worktree exits unless `TESS_REAL_INSTALL=1` is set exactly. Do not
   add an escape around that guard, and do not "just run it once" with the flag; test the script in a sandbox
   (`tools/test-script-guards.mjs` proves the guard, `tools/check-safety.sh` blocks a release that loses it).
3. **Nothing reaches users untested.** Every push to `main` builds to the internal `dev` channel only (Krish's Mac).
   Users get a build only when it is promoted (Actions → release → `promote`, or `node tools/promote.mjs`) after Krish
   says "ship it". The public install line runs the last promoted installer.
4. **Krish decides:** merging pull requests, declaring a release, promoting to users, installing outside skills or tools, anything with
   `sudo`, deleting data, and design directions he hasn't approved. Name one recommended option and ask.
5. **Secrets stay secret.** Signing keys live in `~/.config/tess-signing/` (`chmod 600` on APFS with ownership) and
   GitHub Actions secrets, never in the repo, in chat, or in a `.env` on a `noowners`-mounted external drive. The
   rescue key (`rescue.pem`) exists only on Krish's Mac and its AES-256 encrypted backups. Never touch Krish's
   hardware security keys/YubiKey without checking slots read-only first, keep machine-specific backup paths inside
   gitignored `.local/`, and see [`docs/secrets-and-env.md`](docs/secrets-and-env.md) and [`.env.example`](.env.example).
   Don't put Krish's email or personal details into any outside request or public file.
6. **Users' privacy:** health reports strip names, home paths, computer names and emails; `tess reports off` turns
   them off. Never add anything personal to a report.

## Repo map

| Path | What it is |
| --- | --- |
| `theme/Tess/src/` | The look and features: `core.js/css` (bar, player, lyrics, settings, menus, perf marks), `home.js/css` (Dial, greeting, On this day), `playlist.js/css`, `dial-pick.js` (Dial picking). Built into `theme/Tess/theme.js` + `user.css` by `tools/build.mjs`. |
| `theme/loader/loader.js` | What Spotify runs: fetches the signed newest theme for its channel, falls back to the last good one. |
| `patcher/` | Fork of Spicetify CLI 2.46.4 (Go). Tess changes: `src/cmd/swap.go` (safe folder swap), `can-write`, `tessverify/`. |
| `installer/` | `install.sh` (public stub, never changes), `tess-install.sh` (real installer), `updater.sh` (background helper, self-updating), `doctor.sh`, `rescue.sh` (separate never-updated rescue line), `uninstall.sh`, `wake.sh`, `tess-command.sh`, `redact.sh` (the one privacy filter every reporter copies in; the only file here that is safe to source). Every entry-point script carries the same guard block at the top (issue #107): sourcing it or handing its text to a shell does nothing, and a checkout or worktree copy refuses to run outside a sandbox. |
| `mini/` | Tess Mini, the macOS miniplayer (Swift). |
| `inbox/` | Cloudflare Worker at `tess-music-player.janus.ing`: receives anonymous health reports, serves the signed rescue order and its public wake serial. No read endpoint for reports. |
| `companion/` | Phone PWA (separate project, issue #8). |
| `tools/` | Build, release, promote, rescue, reports, and every measuring tool (see below). |
| `docs/` | Architecture, secrets & env (`secrets-and-env.md`), status, design rules, algorithms, research. |
| `.env.example`, `.local/` | Safe env template (committed) and private machine-specific backup/secret notes (`.local/`, `.env`, `.dev.vars` — gitignored). |
| `.github/workflows/release.yml` | Safety gate → build/sign → `dev`; `declare` → beta; `promote` → stable. |

## Daily development loop (on Krish's Mac)

Iterate **locally first** using `tools/dev.mjs` until a change works end-to-end on Krish's Mac, then run `node tools/dev.mjs check` and push **once** to GitHub `dev` as the final packaging/updater rehearsal before `beta`.

```sh
node tools/dev.mjs                      # show branch, Spotify DevTools, Mini, and Support state
node tools/dev.mjs theme --launch       # restart Spotify with DevTools :9222 and hot-load the theme
node tools/dev.mjs theme --watch        # auto-build & hot-load theme/Tess/src/* on save (~1s)
node tools/dev.mjs support              # instantly sync local SOUL.md, tess-visit.ts & skills into Tess/support/current
node tools/dev.mjs mini                 # compile local Tess Mini (.build/dev-mini/) and restart it (~3s)
node tools/dev.mjs restore              # switch back to the signed ~/Applications/Tess Mini.app
node tools/dev.mjs worker               # run Worker chat & inbox tests locally (~2s; --dev for wrangler dev)
node tools/dev.mjs all                  # hot-load theme + sync support + restart local Mini in one pass
node tools/dev.mjs check                # full local pre-push gate (build, tests, check-safety.sh)
node tools/cdp.mjs eval '<js>'          # run JS in Spotify's page
node tools/cdp.mjs shot out.png         # screenshot (works with the window hidden)
```

- Edit `theme/Tess/src/*`, never `theme/Tess/theme.js` or `user.css` (generated).
- Tess pauses its work while the window is hidden (by design); for tests that need placers to run,
  `window.__tess.debug.place()`. Timing and frame measurements need the window visible and in front.
- `node tools/dev.mjs check` (or `node tools/build.mjs && node --check theme/Tess/theme.js`) before pushing.

## How to check work (a claim needs proof)

A ticket is done when the real thing was run and there is something a person can look at: a screenshot, a measured
before/after, a failing then passing test, or a log. "Should work" is not done.

| Kind of change | Check |
| --- | --- |
| Look / layout | `tools/hot.mjs`, then screenshots of every affected page/state via `tools/cdp.mjs shot` |
| Anything that moves, or perf | Window visible: `tools/cpu-ab.mjs "<css>"` (real CPU), `tools/ab.mjs` (main-thread work), `/tmp`-free traces via `tools/trace-idle.mjs`, `tools/trace-style.mjs`; full run `tools/bench.mjs <label>` (memory, clicks, long tasks; appends to `.build/bench.jsonl`) |
| Installer / updater / doctor / rescue | Sandbox copy of Spotify with `TESS_TEST=1`; cover success, a blocked write, a failure mid-way, and a fresh Mac; `tools/check-safety.sh`. An upgrade from the pinned 0.2.22 build is `node tools/test-upgrade.mjs` |
| Any installer script's guard | `node tools/test-script-guards.mjs` (in a scratch copy of the checkout: sourcing and `sh -c "$(cat …)"`/`eval` do nothing, a checkout and worktree copy refuse, `TESS_REAL_INSTALL=0`/`false` refuse, the piped install line and installed copies still run) |
| Patcher (Go) | `cd patcher && go test ./src/cmd/` plus an apply → restore cycle on a sandbox copy |
| Dial picking | `node tools/test-dial-pick.mjs` |
| Rescue line | `node tools/test-rescue.mjs` (signed orders in a sandbox: five actions accepted; scripts, unknown actions, injected text, bad signatures, expired orders, replays refused), `node tools/test-rescue-control.mjs` (notice, off/on, status) |
| Updater, wake, swaps | `node tools/test-updater.mjs` (success, fresh Mac, blocked write, failed swap, rollback + no retry, playing vs idle), `node tools/test-wake.mjs`, `node tools/test-swap-recovery.mjs` (kill mid-swap) |

Read numbers carefully: `ps %cpu` on macOS is a minute-long average (use `tools/cpu-ab.mjs`); a hidden window draws
nothing; Krish using the Mac adds noise, so alternate with/without and repeat (the tools do).

## Shipping

- `tools/check-safety.sh` must pass (CI runs it before every build).
- Push to `main` → CI builds, signs (Ed25519 for content, the stable "Tess Music" code-signing identity for binaries)
  and publishes to `dev`. Krish's Mac picks it up (look: next Spotify start; other parts: within ~5–30 minutes).
- Declare when Krish says so: `node tools/declare.mjs` copies the exact dev build to beta and writes notes for every
  PR merged since the previous beta. Promote with `node tools/promote.mjs` after beta is clean; it copies that exact
  beta to stable. Both mirror their public channel to `Flame119052/tess-releases` (never archive that repo: 0.1.x
  installs read it).
- Emergency fix for Macs whose updates are stuck: `node tools/rescue.mjs <check|update|repair|restore-spotify|uninstall>
  [--only <install id>]` (signed with the offline rescue key; Krish's Mac only). Rescue orders are those five Tess
  actions only; never add a way for an order to run a script or reach anything outside Tess and Spotify. Macs check every
  6 hours, at login, and within ~5 minutes of a new order via the wake check; users can turn it off (`tess rescue off`).
- Health reports: `node tools/reports.mjs problems | macs | mac <id> | show <n>` (needs Krish's Cloudflare login).

## Work tracking

- One GitHub issue per piece of work, in this repo. The issue names the goal, the check, and what blocks it.
- Give every issue a **clear, plain-English title** that anyone can understand without knowing internal code names.
- Tag every issue using the 4-axis system in `docs/triage.md` (`P0`–`P3` priority, `area:*` category, type, workflow status) and assign it to the matching roadmap milestone.
- Comment the evidence on the issue and close it **only after its PR is merged into `main`** and checked (or let
  GitHub close it on merge via `Closes #N`). Never close a GitHub issue on unpushed or unmerged local commits: that
  makes GitHub lie about what actually exists in `dev` and `stable`. Leave an issue open (with why) when it still needs
  a real-world event (e.g. #28 needs a real blocked Mac).
- **Always branch from fresh `origin/main`:** run `git fetch origin main` and create your branch from `origin/main`,
  never from a stale local `main` or whatever branch the checkout happens to sit on. Verify
  `git merge-base --is-ancestor origin/main HEAD` before opening a PR.
- Work follows [`docs/workflow.md`](docs/workflow.md): issue → approach comment → PR into `main` → dev → beta (Krish
  declares a release) → stable (Krish promotes). **Opening a PR is the normal end of a build (D-63) — always push your
  branch and open the PR into `main`; never stop at an unpushed local branch to ask permission to open a PR.** When
  Krish asks you to fix an issue (or issues), take it all the way onto the internal **`dev`** build: open the PR, pass
  CI + required `@tess-review` approval, and merge into `main` so Krish can see it on `dev` right away. **`dev` →
  `beta` (`declare`) and `beta` → `stable` (`promote`) always wait for Krish's explicit word and GitHub's `release`
  approval gate — nothing ever reaches real users without his say.** Keep each PR focused on one issue or a tight slice
  rather than bundling a dozen unrelated issues onto one branch.
- **Respect sensitive-tier review gates:** before writing code for any sensitive path (`installer/`, `inbox/`,
  `patcher/`, `support/`, `.github/`, `tools/release.mjs`, `tools/promote.mjs`, `tools/rescue.mjs`,
  `tools/check-safety.sh`, signing, rescue, or release-shipped `mini/` helpers), post an approach comment and get
  `@tess-review approach` approved first, then get `@tess-review pr` approved before merge.
- **Re-pin `support/mac/install.sh` (`PROFILE_COMMIT`) to `main` after merge (D-105):** when changing files under
  `support/mac/`, an unmerged branch SHA in `PROFILE_COMMIT` is temporary for PR checks only; follow up right after
  merge so `PROFILE_COMMIT` points to a real commit on `main`.
- Tag `@tess-review
  approach` or `@tess-review pr` to call a reviewer agent; the tier (docs / normal / sensitive) decides which reviews a
  change needs. Name the reviewer you chose in the tag — `provider=… model=… effort=… author=…` plus one line saying why —
  because the job runs that model or refuses with a comment; it never picks one for you. `author=` is the provider that
  wrote the change, and it must be a different one from the reviewer. `machine=github|mac|omarchy` chooses where it runs
  (omitted = GitHub), `machine=vps` is refused, an optional `prompt="…"` (400 characters) adds the owner's focus, and
  `effort=` is refused on the machine path, where a T3 thread has nowhere to put it (docs/workflow.md → Choosing a
  reviewer). Small,
  focused commits; the message says what changed for the user and why, and ends with the issue number, e.g. `(#30)`.
- Update `docs/status.md` when something user-visible changes state.

## Communicating with Krish

- **Explain simply, in plain English:** when giving updates, explaining what changed, or comparing trade-offs, write in
  clear, everyday language first. Focus on what the user sees and feels, why it matters, and real numbers—avoid walls
  of internal code jargon unless he asks for code-level details.
- **Quality & premium feel come first:** speed and efficiency must coexist with the rich, made-for-you Apple Music
  feel—never cut animations, visual polish, or richness just to lower CPU numbers (#58). Keep foreground animations
  (especially vinyls) running whenever any part of Spotify is visible on screen; pause/sleep only when completely
  hidden (#57).
- **Respect "triage / issues only" requests:** when Krish asks to file or organize issues first (or asks a question
  about how things work), update issues/docs without editing app code until he asks to build.

## Writing style (code and docs)

- Plain words. Comments explain *why* (a constraint, a measured cost, a Spotify quirk), never restate the code.
- Spotify's class names are hashed and change per version: target `data-testid`, `data-encore-id`, ARIA, structure,
  or Tess's own `data-tess-*` marks (set in `markLayout`), not hashed classes. Never write broad `:has()` rules (see
  `DESIGN.md` → Performance).
- No new runtime dependencies in the theme. Installer scripts use only what every Mac has (`sh`, `zsh`, `curl`,
  `awk`, `ditto`; no `python3`, no `node`).
