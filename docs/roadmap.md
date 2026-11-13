# Roadmap

Where Tess is going, in order. Each item is a GitHub issue; this file is the order and the reasoning. Phases finish
roughly in sequence, but anything marked *waiting on Krish* can move as soon as he decides. Update it when priorities
change (and log the change in `decisions.md`).

## Phase 0 — Done (Nov 2026)

One-line install on any Mac; Tess's own patcher; every part signed and self-updating; survives Spotify updates; safe
folder swap and a release gate; doctor, anonymous health reports, rescue line; internal `dev` channel with promotion;
Apple-Music design across bar, player, Home (Dial), library, Settings, menus; a performance pass (CPU at rest 71% →
29%); MIT licence; repo set up for multi-thread work. Details: closed issues #10–#44, #52.

## Phase 1 — Trust and safety (now)

The goal: anyone who installs Tess can trust it, and the owner can recover from anything.

| Issue | What | Why first |
| --- | --- | --- |
| Security audit issue (label `security`) | Work through the audit's findings, Critical/High first | It's code running on other people's Macs |
| #53 | Tell users about the rescue line; `tess rescue off`, `tess status` | Consent for remote fix-ups |
| #55 | Back up the signing keys offline | The rescue key is a master key; losing or leaking it is the worst case |
| #54 | Purge old issue revisions and commit messages with personal details | Privacy |
| #28 | See the App Management prompt on a real blocked Mac | Confirms the once-only approval works |
| — | Confirm the Cloudflare Workers plan is Free (D-16) | No surprise bills |
| #7, #9 | Owner confirms and closes | Bookkeeping |

## Phase 2 — Reach (next)

The goal: Tess works on every Mac a Premium user might have, and installs never surprise anyone.

| Issue | What |
| --- | --- |
| #50 | Test on Intel, macOS 12–14, Spotify in `~/Applications`, a Mac that never had Spicetify |
| #51 | Detect a hand-copied (DMG) Spotify that Gatekeeper refuses, before changing anything |
| — | Patcher rebase plan for the next Spotify version that breaks Spicetify 2.46.4 |
| — | Optional: Apple Developer ID + notarization (would replace the self-signed identity, D-20) |

## Phase 3 — Polish (design)

The goal: Apple-level finish everywhere, within DESIGN.md's performance budget.

| Issue | What |
| --- | --- |
| #45 | Full-size library: final decision (*waiting on Krish*) |
| #46 | A more creative sidebar → library transition |
| #47 | Liquid Glass at Apple's polish |
| #48 | Tess's icons across the rest of Spotify |
| #49 | Check About/Credits, tooltips, the library morph, Tess Mini controls on screen |
| #4 | Album and playlist pages review (*waiting on Krish*) |

## Phase 4 — Features

| Issue | What |
| --- | --- |
| #3 | Lyrics when Spotify has none |
| #5 | Artist video when no top song has a Canvas |
| #6 | Keep downloads off the Mac when the external drive is unplugged |
| #2 | Word-by-word lyric highlight (deferred by Krish) |
| — | Deferred: listening stats page, shareable lyric cards, Apple-style album pages, Spicetify Marketplace listing |

## Phase 5 — Beyond the Mac

| Issue | What |
| --- | --- |
| #34 | Windows (paused by Krish): one install address for both systems |
| #8 | Phone companion (PWA in `companion/`), its own thread |

## How a phase moves

Krish picks what's next; a thread takes one issue, works it with proof, closes it; pushes reach his Mac on `dev`;
he says "ship it" and the build is promoted to users. See `AGENTS.md`.
