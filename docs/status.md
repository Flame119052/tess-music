# Status

What's true right now, what's open, and what's waiting on whom. Update this when something user-visible changes.
Last updated: 14 Nov 2026.

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

## Open issues (GitHub, sorted by priority — see [`triage.md`](triage.md))

| # | Priority | Area | What | State / next step |
| --- | --- | --- | --- | --- |
| #56 | `P0` | `installer`, `release-ci` | Security audit (DeepSeek V4.1 via OpenCode Go): 25 findings, 2 Critical, 4 High | Open; Phase 1 top priority. |
| #68 | `P1` | `installer`, `release-ci` | Rescue line: start a new order within a minute instead of waiting up to six hours | Shipped to every Mac as the 5-minute wake check (D-63, #75): it reads two public files and starts the updater or the rescue line, which can only run its five actions (#69). Users can turn the rescue line off with `tess rescue off` (#53). |
| #53 | `P1` | `installer` | Tell users about the rescue line; `tess rescue off`, `tess status` | PR #75 review fixes implemented; sandbox checks cover persistent opt-out, older channel installs, separate wake reads, and the older-script notice. Awaiting CI and reviewer acceptance; not released. |
| #54 | `P1` | `docs`, `release-ci` | Purge old issue revisions and commit messages with personal details | Waiting on Krish (Phase 1). |
| #71 | `P1` | `installer`, `release-ci` | Issue → approach → PR → dev → beta → stable, with reviewer agents | Parts B–C implemented in PR; runner registration and repository settings remain owner steps. |
| #88 | `P1` | `release-ci` | A `@tess-agent` GitHub tag starts a T3 thread on the chosen reachable machine | In progress; implementation and mocked MCP proof are being prepared for PR review. |
| #62 | `P1` | `docs`, `release-ci` | Update docs & release flow for PRs → `dev` → `beta` → `stable` (approvers TBD) | Waiting on Krish (Phase 1). |
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
| #47 | `P2` | `theme` | Liquid Glass: Apple-level polish | Open (Phase 3). |
| #46 | `P2` | `theme` | Library: smoother, more creative animation when expanding from sidebar to full screen | Open (Phase 3). |
| #48 | `P2` | `theme` | Icons: carry Tess's icon set to the rest of Spotify | Open (Phase 3). |
| #64 | `P2` | `theme` | Customization & design: settings for look, motion, Dial, and Library preferences | Waiting on Krish (Phase 3). |
| #3 | `P2` | `theme` | Lyrics when Spotify has none, and fixing them | Open (Phase 4). |
| #5 | `P2` | `theme` | Artist video when no top song has a Canvas | Open (Phase 4). |
| #6 | `P2` | `installer` | Keep downloads off the Mac when the external drive is unplugged | Open (Phase 4). |
| #8 | `P2` | `companion` | Phone companion (PWA in `companion/`) | Waiting on Krish (Phase 5). |
| #2 | `P3` | `theme` | Word-by-word lyric highlight | Paused / deferred by Krish (Phase 4). |
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
