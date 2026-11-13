# Status

What's true right now, what's open, and what's waiting on whom. Update this when something user-visible changes.
Last updated: 13 Nov 2026.

## Releases

| Channel | Who follows it | Version |
| --- | --- | --- |
| `dev` | Krish's Mac (internal) | follows every push to `main` |
| `stable` / `beta` | everyone else | 0.2.22 (promoted only when Krish says "ship it") |

Promote: Actions → release → Run workflow → action `promote` (or `node tools/promote.mjs`).
Users on record (health inbox): Krish (dev), Kavya (stable, repaired 13 Nov after the 0.1.0 helper blanked her Spotify).

## Open issues (GitHub)

| # | What | State / next step |
| --- | --- | --- |
| #28 | macOS App Management: ask once, never loop, approval survives updates | Shipped (stable signing identity, `can-write` check, one dialog). Open until the prompt is seen on a real blocked Mac at the next Spotify update. |
| #34 | Windows version | **Paused by Krish.** One repo, one install address for both systems (stub serves the Mac or Windows script). |
| #9 | Ship Tess to any Premium Mac user | Done in practice (one line, own patcher, self-updating, signed, gated releases); Krish to confirm and close. |
| #7 | Survive Spotify updates | Done (updater re-applies once per version, safe swap, App Management handling, rescue line); Krish to confirm and close. |
| #8 | Phone companion (PWA in `companion/`) | Its own thread. |
| #6 | Keep downloads off the Mac when the external drive is unplugged | Notes in `docs/downloads.md`. |
| #5 | Artist video when no top song has a Canvas | Open. |
| #4 | Album and playlist pages: review round with Krish | Waiting on Krish's review. |
| #3 | Lyrics when Spotify has none, and fixing them | Open (no-lyrics view done in #32; sourcing lyrics is not). |
| #2 | Word-by-word lyric highlight | Deferred by Krish. |
| #1 | Tess Music v1 (umbrella) | Umbrella. |
| #45 | Library (full size): final decision on Glass Shelves | Waiting on Krish. |
| #46 | Sidebar → full library: a more creative transition | Open. |
| #47 | Liquid Glass: Apple-level polish | Open. |
| #48 | Icons across the rest of Spotify | Open. |
| #49 | Check on screen: About/Credits, tooltips, library morph, Tess Mini controls | Open. |
| #50 | Test on other Macs (Intel, macOS 12–14, `~/Applications`, never-Spicetify) | Open. |
| #51 | Installer: detect a hand-copied (DMG) Spotify that Gatekeeper refuses | Open. |
| #52 | Licence for the repo | Waiting on Krish. |

Closed on 13 Nov: #13 (Dial picking), #29 (DJ button), #30 (top bar), #31 (vinyl arm), #32 (no lyrics), #33 (Settings
and account menu), #35 (performance hill climb), #36 (Kavya's blanked Spotify + safe swap), #37 (doctor, reports,
rescue), #38 (Home bar), #39 (progress line), #40 (queue cut-off), #41 (Back to now), #42 (design skills pass),
#43 (dev channel), #44 (repo setup). Before that: #10–#26.

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
