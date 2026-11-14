---
name: tess-triage
description: "Sorting a Tess report into P0–P3 and an area, per docs/triage.md, with the reason in one line. Use after the facts are gathered and before anything is sent."
version: 1.0.0
author: Tess Music
license: MIT
metadata:
  hermes:
    tags: [tess, support, triage, priority]
---

# Triage it

Two labels and one reason. The reason is the part that makes it reviewable: "P0 because Spotify opens to a black
window" can be argued with; "P0" on its own can't.

## Priority

| | Use when | Examples |
| --- | --- | --- |
| **P0** | Spotify is unusable, or their data is at risk | black window, Spotify won't open, interface files missing |
| **P1** | A core feature is broken but they can still use Spotify | can't install or update, app management blocking Tess, no lyrics at all in full screen |
| **P2** | A real bug, or polish that annoys | lyrics drift, tonearm wrong, Mini won't start |
| **P3** | Deferred, or a platform they don't have | Windows, a paused feature |

**The doctor's evidence is the floor.** The script sets it and will not let you go below it — a blank Spotify is P0
however calm the person sounds. You may go **up** if their words show more harm than the machine admits.

## Area

Exactly one, usually, from `docs/triage.md`:

- `area: theme` — look, player, lyrics, Dial, library, Home, artist and album pages
- `area: patcher` — the Spicetify fork, the CSS map, the safe swap
- `area: installer` — install, update, doctor, rescue, macOS permissions
- `area: mini` — the miniplayer
- `area: companion` — the phone PWA
- `area: release-ci` — the release pipeline, channels, signing, CI
- `area: docs` — documentation and process

Two when the report genuinely spans them (a theme bug that only happens because the updater picked the wrong part). Three
is a sign you haven't decided.

## The reason

One line, in the report, under the labels:

> `P0 — Spotify opens to a black window and the doctor says its interface files are missing.`

Not "high impact". Not "user cannot work". What they see, and what the machine said.

## When you disagree with the script

The script wins on the floor, and that is deliberate. If you think it is wrong, say so in that one line: "P0 by the
doctor's evidence; the person says Spotify is fine now" — Krish can move it in a click, and the disagreement is
visible instead of silent.

## Never

- Never file a P3 for a bug a person actually reported. P3 means "not now", not "small".
- Never invent an area outside the list. If none fits, say so in the report: "area not certain — looks like installer
  or theme".
- Never mark something security without a reason you can write in one sentence.
