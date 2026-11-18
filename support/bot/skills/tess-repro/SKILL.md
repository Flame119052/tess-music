---
name: tess-repro
description: "Turning a vague complaint into exact steps to reproduce a Tess problem: page, song type, window size, what they clicked. Use once you know roughly what is wrong, before anything is filed."
version: 1.0.0
author: Tess Music
license: MIT
metadata:
  hermes:
    tags: [tess, support, reproduction]
---

# Reproduce it

A report nobody can reproduce gets closed as "can't reproduce", and the person is back where they started. Your job
here is to turn "the lyrics are off" into something a stranger could follow on their own Mac.

Write it as numbered steps, then **read them back and get a yes**.

## What makes the difference

Ask only what changes the answer:

- **Which page** — Home, a playlist, an album, an artist, the full-screen player, the library, the miniplayer.
- **Which kind of song** — with lyrics, without lyrics, one with a Canvas, a podcast episode, a local file. This one
  matters more than people expect: several Tess bugs only happen on a song with no lyrics.
- **Window size** — full screen, a normal window, or the small miniplayer. "Only in full screen" is a different bug
  from "always".
- **What they clicked** — the exact thing, in order. "Clicked the vinyl" not "opened it".
- **How often** — every time, the first time after opening Spotify, or once and then never.

## Shape

> 1. Open Spotify.
> 2. Play *any* song **with lyrics** and open the full-screen player (click the artwork).
> 3. Drag the window to about half the screen.
> 4. The lyric line stays put for about half a second after the singer.
>
> Is that what happens? Anything I've got wrong?

The last two lines are not politeness. If they say "no, it's only on songs without lyrics", you just avoided filing the
wrong bug.

## Rules

- **They confirm the steps.** Never file on your own reconstruction.
- If they can't remember, ask them to try it once while you wait, and tell you what they did. That's their Mac and their
  hands, not yours.
- If the steps don't reproduce it, say so and file it as "not reproduced, reported by one person" rather than
  pretending you saw it.
- Keep it to six steps. Longer means you haven't understood it yet.
