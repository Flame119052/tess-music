# Roadmap

Where Tess is going, in order. Each item is a GitHub issue; this file mirrors the GitHub milestones and priorities in
[`triage.md`](triage.md). Phases finish roughly in sequence, but anything marked *waiting on Krish* can move as soon as
he decides. Update it when priorities change (and log the change in `decisions.md`).

## Phase 0 — Done (Nov 2026)

One-line install on any Mac; Tess's own patcher; every part signed and self-updating; survives Spotify updates; safe
folder swap and a release gate; doctor, anonymous health reports, rescue line; internal `dev` channel with promotion;
Apple-Music design across bar, player, Home (Dial), library, Settings, menus; a performance pass (CPU at rest 71% →
29%); MIT licence; repo set up for multi-thread work. Details: closed issues #10–#44, #52.

## Phase 1 — Trust, Security & Release Flow (now)

The goal: anyone who installs Tess can trust it, the release pipeline is gated cleanly, and the owner can recover from anything.

| Issue | Priority | What | Why first |
| --- | --- | --- | --- |
| #56 | `P0` | Security audit: 25 findings (2 Critical, 4 High). Start with SEC-01/02, SEC-03, SEC-04, SEC-05 | It's code running on other people's Macs |
| #55 | `P0` | Back up the signing keys offline | **Done (13 Nov 2026)** — AES-256 encrypted `.dmg` verified across network, external SSD, and cloud storage |
| #53 | `P1` | Tell users about the rescue line; `tess rescue off`, `tess status` | Consent for remote fix-ups |
| #54 | `P1` | Purge old issue revisions and commit messages with personal details | Privacy |
| #62 | `P1` | Update docs & release flow for PRs → `dev` → `beta` → `stable` (approvers TBD) | Aligns process before wider rollout |
| #28 | `P1` | See the App Management prompt on a real blocked Mac | Confirms the once-only approval works |
| — | `P1` | Confirm the Cloudflare Workers plan is Free (D-16) | No surprise bills |
| #7, #9 | `P1` | Owner confirms and closes | Bookkeeping |

## Phase 2 — Core Fixes, Quality & Reach (next)

The goal: restore rich foreground motion and quality, fix open bugs, clean up the Spicetify fork, and verify across Mac setups.

| Issue | Priority | What |
| --- | --- | --- |
| #57 | `P1` | Animations & sleep: keep vinyls and UI motion running whenever any part is visible; sleep only when hidden |
| #58 | `P1` | Performance & craft: keep rich, upgraded Liquid Glass feel first (revisit layer & shelf-arrow trade-offs) |
| #60 | `P1` | Artist page: fix Photo/Video switch being reversed, snapping back to Video, and forgetting choice |
| #63 | `P1` | Vinyl player: fix tonearm start/end position, proportional tracking, and playback sync |
| #65 | `P1` | Full-screen player: right side stays blank instead of filling the page when a song has no lyrics |
| #59 | `P1` | Spicetify fork: fix Spotify button lookups directly and watch upstream for new updates |
| #51 | `P1` | Installer: warn users if Spotify was dragged from a DMG (macOS blocks patching it) |
| #61 | `P2` | Library: separate Blends and Playlists in the expanded view and filter |
| #45 | `P2` | Full-size library: final decision on Glass Shelves (*waiting on Krish*) |
| #4 | `P2` | Album and playlist pages review (*waiting on Krish*) |
| #49 | `P2` | Visual check: verify About/Credits dialogs, tooltips, library expand animation, and Tess Mini |
| #50 | `P2` | Compatibility testing: test on Intel Macs, macOS 12–14, `~/Applications`, and fresh setups |
| — | `P2` | Optional: Apple Developer ID + notarization (would replace the self-signed identity, D-20) |

## Phase 3 — Apple-Level Polish

The goal: Apple-level finish everywhere, with performance coexisting with visual richness.

| Issue | Priority | What |
| --- | --- | --- |
| #47 | `P2` | Liquid Glass at Apple's polish |
| #46 | `P2` | Library: smoother, more creative animation when expanding from sidebar to full screen |
| #48 | `P2` | Tess's icons across the rest of Spotify |
| #64 | `P2` | Customization & design: settings for look, motion, Dial, and Library preferences (*waiting on Krish*) |

## Phase 4 — Features & Enhancements

| Issue | Priority | What |
| --- | --- | --- |
| #3 | `P2` | Lyrics when Spotify has none |
| #5 | `P2` | Artist video when no top song has a Canvas |
| #6 | `P2` | Keep downloads off the Mac when the external drive is unplugged |
| #2 | `P3` | Word-by-word lyric highlight (*paused / deferred by Krish*) |
| — | `P3` | Deferred: listening stats page, shareable lyric cards, Apple-style album pages, Spicetify Marketplace listing |

## Phase 5 — Beyond the Mac

| Issue | Priority | What |
| --- | --- | --- |
| #8 | `P2` | Phone companion (PWA in `companion/`), its own thread |
| #34 | `P3` | Windows (*paused by Krish*): one install address for both systems |

## How a phase moves

Krish picks what's next; a thread takes one issue, works it with proof, closes it; pushes reach his Mac on `dev`;
he says "ship it" and the build is promoted to users. See `AGENTS.md` (and `#62` for the upcoming PR-based flow).
