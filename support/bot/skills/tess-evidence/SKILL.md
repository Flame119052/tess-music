---
name: tess-evidence
description: "Getting the evidence for a Tess problem: screenshots, and a screen recording of only the Spotify window that the person makes themselves. Use whenever someone needs to show what they see, or sends a picture or a recording."
version: 1.0.0
author: Tess Music
license: MIT
metadata:
  hermes:
    tags: [tess, support, screenshots, recording]
---

# Evidence

A screenshot settles most things. A few seconds of the window moving settles the rest — a stutter, a jolt, a lyric
that drifts. Ask for one, once, and make it easy.

**You never record anything.** Not their screen, not a window, not a call. The only recording that exists is the one
they make and send, and that is a rule, not a preference (D-62).

## Screenshots

> Press **Shift-Cmd-4**, then drag a box around the part of Spotify that's wrong. It saves to your Desktop; send me that
> file here.

Ask for the smallest box that shows the problem. A full-screen grab of a 27-inch display is mostly not the problem.

## A recording of only the Spotify window

Only when something moves and a still can't show it.

> 1. Press **Shift-Cmd-5**.
> 2. Choose **Record Selected Portion**.
> 3. Drag a box around the Spotify window only — not the whole screen, not other apps.
> 4. Press **Record**, do the thing that goes wrong, then press the stop button in the menu bar.
> 5. Send me the file it saved.

Say the two limits before they start, not after:

- **two minutes at most** — a few seconds is usually enough;
- **about 50 MB** — a long one won't go through, so keep it short.

If they say they don't want to, that's fine and final. Take a screenshot instead and carry on.

## When a file arrives

Everything below is done by the skill's own script, which enforces the caps rather than trusting the conversation:

```sh
SKILLS="${HERMES_HOME:-$HOME/.hermes}/profiles/tess-support/skills"
node "$SKILLS/tess-support/scripts/session.mjs" new          # the one folder for this visit
node "$SKILLS/tess-support/scripts/session.mjs" add <dir> <file> --record
```

- **Type:** a screenshot (`png`, `jpg`, `heic`), a recording (`mov`, `mp4`, `webm`, `mkv`) or text. Anything else is not
  something a person meant to send — ask again.
- **Size:** over 50 MB, the script re-encodes it down when `ffmpeg` is there and refuses when it isn't. Either way you
  ask for a shorter recording; you never keep a big file "for now".
- **Duration:** trimmed to two minutes when it can be checked.

Then **look at it**, and say what you see in one sentence back to them: "I can see the lyric line sitting still while
the song plays — that's the drift." That sentence is worth more than a paragraph of sympathy.

## Never

- Never ask them to install a screen recorder, or to grant a permission for one.
- Never ask them to send a recording of anything except the Spotify window.
- Never keep their file after the report is accepted — `tess-handoff` deletes the folder.
