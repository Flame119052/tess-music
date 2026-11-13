# Design rules Tess follows

Extracted (read, not installed) on 13 Nov 2026 from three public Claude design skills Krish pointed to:
[emilkowalski/skill](https://github.com/emilkowalski/skill) (design engineering, animation performance),
[pbakaus/impeccable](https://github.com/pbakaus/impeccable) (craft floor, polish, optimize) and
[Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) (mostly for marketing sites; only its motion rules carry
over to an app). Tess's own brief wins where they disagree: it is Apple Music's look, Liquid Glass included.

## Motion and performance (Emil Kowalski)
- Animate `transform` and `opacity`. Never `transition: all`; list the properties.
- Nothing moves for ever. On a Retina window any continuous motion redraws the whole window every frame (measured:
  ~1/3 of a CPU core). Records spin for a while after a song starts and on hover, then rest; the bar subtitle scrolls
  once per song; the progress line moves a pixel at a time.
- Don't drive per-frame motion through an inherited CSS variable on a parent (every child restyles); write `transform`
  on the element itself. Keyframes that read `var()` can't run on the GPU.
- `will-change` only on an element that animates, never on many (Spotify's buttons had it; Tess removes it).
- Never animate from `scale(0)`; start at ~0.5 with opacity 0.
- Strong ease-out for things that respond to you: `--tess-ease-out: cubic-bezier(0.23, 1, 0.32, 1)`.
- Pressable controls answer at once: `:active { transform: scale(0.96) }`, 160 ms.
- Respect `prefers-reduced-motion`.

## Craft floor (Impeccable)
- No eyebrow label above a heading: the heading carries itself; state or reason goes in the line under it.
- One authored entrance per page, not the same entrance on every section (Home: the Dial only).
- Secondary text at least 4.5:1 on its glass (white at 60% or more on Tess's dark surfaces).
- The parts nobody draws carry the design: selection colour, caret, keyboard focus ring, tabular numerals for times.
- Icons match their label (Pause shows two bars).

## Checking
`tools/check-safety.sh` guards the installer; for design changes look at the rendered result in Spotify (tools/hot.mjs,
tools/cdp.mjs shot) and, for anything that moves, measure it (tools/cpu-ab.mjs, tools/ab.mjs) with the window visible.
