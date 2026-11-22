# Status

What's true right now, what's open, and what's waiting on whom. Update this when something user-visible changes.
Last updated: 19 Nov 2026.

## Releases

| Channel | Who follows it | Version |
| --- | --- | --- |
| `dev` | Krish's Mac (internal) | follows every push to `main` |
| `beta` | beta testers | 0.2.22 (changes only when Krish declares a release) |
| `stable` | everyone else | 0.2.22 (changes only when Krish promotes the tested beta) |

Declare: Actions → release → Run workflow → action `declare` (or `node tools/declare.mjs`). Promote the resulting
beta with action `promote` (or `node tools/promote.mjs`).
Installs on record (health inbox): the owner's Mac (dev) and one user's Mac (stable, repaired 13 Nov after the 0.1.0
helper blanked its Spotify).

## Support bot

Built and tested in `support/` (#70, D-76, D-77, D-95, D-102): **one isolated Hermes bot (`tess-support`) on Krish's VPS**,
on OpenCode Go (`opencode-go/deepseek-v4.1-flash`) with a hard daily cap (40 shared replies/day, 20/person/day), that
Krish and a trusted tester message. It works out what broke from Tess's own doctor report and their screenshots and
**posts it to the inbox** — `POST /v1/support`, token-authenticated, stored beside the health reports. Krish's side
reads it with `tools/reports.mjs support list` and files the issue with its P0–P3 and area labels; **the bot itself
never files, and has no GitHub token or `gh` at all**. Access is an allowlist only Krish can change, on the server
over SSH (D-79).

A Mac profile lives in `support/mac/` (D-104, D-105, D-106, D-110, #121). It has no Telegram and no gateway. The model base is
`${TESS_INBOX}/v1/support` (Hermes posts to `/chat/completions` under it) and the bearer is the per-person support token.
The model has no shell. A visit is a fixed set of tools: doctor, a still of the Spotify window after the person says yes, or a short silent clip of just that window after its own separate yes (D-115, #128), then the scrubbed text and the evidence posted to the inbox. It cannot record the whole screen, another window, or the microphone.
`support/mac/install.sh` is the one command that installs that profile, a pinned Node.js for the visit, and Tess Support in the Dock (D-105).
Uninstall removes the profile, including that Node, the icon, and the Dock tile. The checks run it in a scratch home with fake disk tools.
They do not touch a real Mac. The VPS unit files are unchanged.
A real chat turn from that profile has been run against the real Worker under `wrangler dev --local` and a fake model:
the reply streams, the key stays on the Worker, the turn is counted, and a revoked code is refused with "This support
code is not active" before the model is called (`node tools/test-support-mac-chat.mjs`, D-108). Krish's steps (make a
code, send it, watch use, revoke, daily limits, Extra Usage off) are in [`support/RUNBOOK-mac.md`](../support/RUNBOOK-mac.md).
A Mac can also be invited instead (#137, D-114): `node tools/reports.mjs support invite add <install id> "<label>"`
stores only the SHA-256 of that Mac's install id, and the Mac's updater shows one native `Not now` / `Install` dialog
when it next checks. Install verifies the signed `dist/support-install.sh` before it claims a one-time token, and
`Not now` is remembered for that invite for good. Nothing about Tess Support is downloaded, shown or mentioned on a
Mac that was not invited, and no plaintext token is ever stored in D1.

**Not deployed, and not part of a release.** Before it can work: `inbox/schema.sql` applied to D1, the Worker deployed,
and the R2 bucket created — all Krish's, none done here — plus a machine, a Telegram bot and a posting token. What can be
run now: `node tools/test-inbox-support.mjs`, `node tools/test-session.mjs`, `node tools/test-reports.mjs`,
`node tools/test-support.mjs`, `node tools/test-support-mac.mjs`, `node tools/test-support-mac-install.mjs`, `node tools/test-support-mac-chat.mjs`.
The private invite (#137, D-114) also needs the new `support_invites` table applied and the Worker deployed before a Mac
can see one; `node tools/test-updater.mjs` runs the consent, signature-before-claim and claim path in a sandbox.

## Open issues (GitHub, sorted by priority — see [`triage.md`](triage.md))

| # | Priority | Area | What | State / next step |
| --- | --- | --- | --- | --- |
| #56 | `P0` | `installer`, `release-ci` | Security audit (DeepSeek V4.1 via OpenCode Go): 25 findings, 2 Critical, 4 High | Open. Releases B and C are on main (#76, #106), with #109, #110, #114 and #117. The loader refuses a part name that leaves `dist/`, an install without the pinned verifier stops, a piped uninstall from `main` does not run, and Tess Mini ignores other websites (D-98 to D-101). Still Krish: a new rescue key (SEC-06), 2FA and branch protection (SEC-12), rewriting history (#54, SEC-21), deleting `stable`'s root `install.sh` on the next promote (SEC-22), and signing the channel name plus a rev floor the page cannot rewrite (#92). |
| #68 | `P1` | `installer`, `release-ci` | Rescue line: start a new order within a minute instead of waiting up to six hours | Shipped to every Mac as the 5-minute wake check (D-63, #75): it reads two public files and starts the updater or the rescue line, which can only run its five actions (#69). Users can turn the rescue line off with `tess rescue off` (#53). |
| #53 | `P1` | `installer` | Tell users about the rescue line; `tess rescue off`, `tess status` | PR #75 review fixes implemented; sandbox checks cover persistent opt-out, older channel installs, separate wake reads, and the older-script notice. The #91 follow-ups landed too: an offline `rescue on` keeps an already-on line on, `rescue off` stops an order that has already started, a Mac without the line no longer reads the rescue branch, `tess status` says the job is loaded and whether an order is running, and an existing Mac sees the notice once after its next update (D-93). Awaiting CI and reviewer acceptance; not released. |
| #54 | `P1` | `docs`, `release-ci` | Purge old issue revisions and commit messages with personal details | Waiting on Krish (Phase 1). |
| #71 | `P1` | `installer`, `release-ci` | Issue → approach → PR → dev → beta → stable, with reviewer agents | Parts B–C implemented. Reviews run on a fresh GitHub-hosted `ubuntu-latest` VM per review (D-66): only the tagged reviewer's CLI is installed, only its own plan login reaches the step, and bubblewrap still refuses to run bare. Plans only, with the tagging agent choosing the model and the job refusing anything that breaks a rule (D-71, D-72). The tag also attests the author (`author=`, D-75), and a review that fails for an unexpected reason still leaves a marker comment before the job stops. One tag now also chooses where the review runs: `machine=github` (the default) or `machine=mac`/`machine=omarchy`, where a watcher on that machine opens the review as a T3 thread; `machine=vps` is refused, an `effort=` is refused on that path, and the tag may add a 400-character `prompt=` focus (D-76). That path is bound to T3's strictest runtime mode before any pull-request text is sent, and the thread posts nothing — the watcher does; it starts the thread in the same stripped copy the GitHub job reads, reads T3's own end-of-run as the finish, and posts with the same context and footer as a GitHub review (D-77, D-78). The watcher is written, tested and **not installed**: installing it is Krish's step (`tools/review-watch/README.md`). Waiting on Krish: add `CODEX_AUTH_JSON` (`node tools/codex-ci-login.mjs`), retire the old runners, and install the watcher where he wants reviews he can watch. |
| #62 | `P1` | `docs`, `release-ci` | Update docs & release flow for PRs → `dev` → `beta` → `stable` (approvers TBD) | Waiting on Krish (Phase 1). |
| #137 | `P1` | `installer`, `release-ci` | Private Tess Support invite: one native Install dialog, nothing to paste | Built and tested in a sandbox (#137, D-114): `node tools/test-inbox-support.mjs`, `node tools/test-reports.mjs`, `node tools/test-updater.mjs`, `tools/check-safety.sh`. Waiting on Krish to merge, apply `inbox/schema.sql`, deploy the Worker, then promote a release whose updater knows about invites. |
| #28 | `P1` | `installer`, `patcher` | macOS App Management: ask once, never loop, approval survives updates | Shipped; `status: verify` on a real blocked Mac at next Spotify update. |
| #7 | `P1` | `patcher`, `installer` | Survive Spotify updates | Done; waiting on Krish to confirm and close. |
| #9 | `P1` | `installer`, `release-ci` | Ship Tess to any Premium Mac user | Done in practice; waiting on Krish to confirm and close. |
| #57 | `P1` | `theme` | Animations & sleep: keep vinyls and motion running when any part is visible; sleep only when hidden | Open (Phase 2, reverses #35 cutoff). |
| #58 | `P1` | `theme` | Performance & craft: keep rich Liquid Glass feel first (revisit layer/shelf-arrow trade-offs) | Open (Phase 2). |
| #60 | `P1` | `theme` | Artist page: fix Photo/Video switch being reversed, snapping back to Video, and forgetting choice | Open bug (Phase 2). |
| #63 | `P1` | `theme` | Vinyl player: fix tonearm start/end position, proportional tracking, and playback sync | Open bug (Phase 2). |
| #65 | `P1` | `theme` | Full-screen player: right side stays blank instead of filling the page when a song has no lyrics | Open bug (Phase 2). |
| #59 | `P1` | `patcher`, `release-ci` | Spicetify fork: fix Spotify button lookups directly and watch upstream for new updates | Open (Phase 2). |
| #51 | `P1` | `installer` | Installer: warn users if Spotify was dragged from a DMG (macOS blocks patching it) | Open bug (Phase 2; approach #1 confirmed: detect quarantine upfront and tell user to reinstall via Spotify's installer). |
| #61 | `P2` | `theme` | Library: separate Blends and Playlists in the expanded view and filter | Open (Phase 2). |
| #45 | `P2` | `theme` | Library (full size): final decision on Glass Shelves | Waiting on Krish (Phase 2). |
| #4 | `P2` | `theme` | Album and playlist pages: review round with Krish | Waiting on Krish's review (Phase 2). |
| #49 | `P2` | `theme`, `mini` | Visual check: verify About/Credits dialogs, tooltips, library expand animation, and Tess Mini | Open testing (Phase 2). |
| #50 | `P2` | `installer`, `patcher` | Compatibility testing: test on Intel Macs, macOS 12–14, `~/Applications`, and fresh setups | Open testing (Phase 2). |
| #128 | `P2` | `mini`, `installer` | Record only the Spotify window for a support visit | Done. `mini/TessRecord.swift` ships as the signed `record` part to `runtime/bin/tess-record`; `tess_record` takes a silent ≤10s clip of the Spotify window only, under its own separate consent. Branch `feat/support-window-rec`, awaiting PR. |
| #108 | `P2` | `installer`, `patcher` | A background theme update logged "checked Spotify swap failed" (macOS App Management denied the helper's `ditto`) | Fixed: the swap runs inside `tess-patcher swap-apps`, which opens Spotify's folder while it validates it and does every step relative to that descriptor, so a path replaced mid-copy — or a real folder moved into `Resources` during the plist read — stops the swap instead of redirecting it; Go and sandbox tests cover a blocked write, a failure partway through, a kill mid-swap, `Resources` swapped for a symlink during the copy, and `Resources`/`Contents` swapped for another real folder during the check. PR #110 pending review. |
| #47 | `P2` | `theme` | Liquid Glass: Apple-level polish | Open (Phase 3). |
| #46 | `P2` | `theme` | Library: smoother, more creative animation when expanding from sidebar to full screen | Open (Phase 3). |
| #48 | `P2` | `theme` | Icons: carry Tess's icon set to the rest of Spotify | Open (Phase 3). |
| #64 | `P2` | `theme` | Customization & design: settings for look, motion, Dial, and Library preferences | Waiting on Krish (Phase 3). |
| #3 | `P2` | `theme` | Lyrics when Spotify has none, and fixing them | Open (Phase 4). |
| #5 | `P2` | `theme` | Artist video when no top song has a Canvas | Open (Phase 4). |
| #6 | `P2` | `installer` | Keep downloads off the Mac when the external drive is unplugged | Open (Phase 4). |
| #8 | `P2` | `companion` | Phone companion (PWA in `companion/`) | Waiting on Krish (Phase 5). |
| #2 | `P3` | `theme` | Word-by-word lyric highlight | Paused / deferred by Krish (Phase 4). |
| #70 | `P2` | `docs`, `release-ci`, `installer` | Support bot: a Hermes bot people message, that sends what broke to the inbox for Krish to file | Built in `support/` (D-76, D-77). Waiting on Krish to merge, deploy the Worker and create the bot. |
| #34 | `P3` | `installer`, `patcher`, `theme` | Windows version | Paused by Krish (Phase 5). |
| #1 | `P2` | `theme` | Tess Music v1 | Umbrella `spec`. |

Closed on 13 Nov: #13 (Dial picking), #29 (DJ button), #30 (top bar), #31 (vinyl arm), #32 (no lyrics), #33 (Settings
and account menu), #35 (performance hill climb), #36 (a user's blanked Spotify + safe swap), #37 (doctor, reports,
rescue), #38 (Home bar), #39 (progress line), #40 (queue cut-off), #41 (Back to now), #42 (design skills pass),
#43 (dev channel), #44 (repo setup), #52 (MIT licence). Before that: #10–#26.

## Design asks still open

- **Library (full size):** Glass Shelves built; Krish to give the final decision.
- **Sidebar → full library transition:** a morph exists; a more creative transition was asked for.
- **Liquid Glass:** in place (lens, rim colour split, specular edge, adaptive tint); Krish wants Apple-level polish.
  Keep it cheap (see DESIGN.md → Performance).
- **Icons:** Tess's own set covers the bar, player, Settings and the account menu; the rest of Spotify's icons are
  untouched.
- **Not yet checked on screen:** About/Credits dialogs, tooltips, the library expand/collapse morph, Tess Mini
  controls by hand.

## Testing gaps

- Only tested on Apple silicon with macOS 26–27 and Spotify 1.3.9. Still to test: an Intel Mac, older macOS
  (12–14), Spotify in `~/Applications`, a Mac that never had Spicetify.
- A Spotify copied from a DMG by hand fails Gatekeeper once patched; the installer should detect it and say to
  reinstall with Spotify's own installer.
- The patcher is pinned to Spicetify 2.46.4. When a Spotify update breaks it, rebase `patcher/` on the newer Spicetify
  and ship a new patcher (Macs re-apply by themselves when it arrives).

## Deferred by Krish

Listening stats page (Spotify's endpoints refuse; needs another source) · shareable lyric cards · Apple-style album
pages · word-by-word lyrics (#2) · Spicetify Marketplace listing.

## Ideas parked

- Dial: store source/kind in its history for sharper time-of-day habits; `SOURCE_SHARE` (25%) tunes how many Daily
  Mixes appear (`docs/algorithms.md`).
- Perf: per-frame cost is dominated by compositing ~140 layers on a Retina window; fewer layers would make the
  full-screen player's continuous motion cheaper too.
