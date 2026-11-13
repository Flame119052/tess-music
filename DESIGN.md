# DESIGN.md — how Tess looks, moves and performs

The brief: **the real Spotify app, with Apple Music's feel.** Calm dark surfaces, Liquid Glass controls, the artwork's
colours carrying the mood, music as the hero. When a rule below conflicts with Krish's explicit direction, his
direction wins; when an outside guide (Impeccable, Emil Kowalski, Taste) conflicts with this brief, the brief wins.

## Principles

1. **The music is the hero.** Artwork, Canvas video and lyrics get the space; chrome recedes.
2. **One material.** Panels are dark tinted glass; controls are Liquid Glass. No flat slabs of page colour, no
   gradients for decoration, no heavy black bands.
3. **Familiar, then delightful.** Spotify's features stay where users expect them (Tess restyles, it doesn't hide):
   the DJ button, queue, devices, shuffle/repeat, Settings.
4. **Quiet at rest.** Nothing moves for ever (see Motion). Motion answers the user or marks a moment.
5. **Fast is a feature.** A design that makes clicks slow or the fan spin is a broken design.

## Tokens (`theme/Tess/src/core.css`)

| Token | Value | Use |
| --- | --- | --- |
| `--tess-font` | SF Pro stack (`-apple-system`) | everything |
| `--tess-text` | `#fff` | primary text |
| `--tess-dim` | white 62% | secondary text (meets 4.5:1 on Tess glass) |
| `--tess-faint` | white 38% | only for non-text marks (dividers, inactive dots); never body text |
| `--tess-accent` | `#1ed760` (adapts to artwork where set) | playing state, toggles on, focus |
| `--tess-glass` / `--tess-glass-line` | grey 62% / white 13% | glass fill / hairline rim |
| `--tess-panel` / `--tess-panel-solid` | `rgba(20,20,23,.6)` / `#141417` | panels (glass) / when glass can't be used |
| `--tess-hairline` | white 7% | separators inside cards and lists |
| `--tess-pill` | white 12% | pill buttons and chips |
| `--tess-radius` | `14px` | cards and panels (artwork 10px, pills full) |
| `--tess-spring` | `cubic-bezier(.2,.9,.25,1.04)` | position/size changes that should feel physical |
| `--tess-ease-out` | `cubic-bezier(.23,1,.32,1)` | anything that responds to the user |

Secondary text is never below white 60% on dark glass. Spacing follows the existing 4/8 rhythm: tight inside a group,
generous between groups, more space above a heading than below it.

## Surfaces and components

- **Bar** (`#tess-bar`): floating Liquid Glass pill at the bottom: transport, artwork + title/subtitle, progress line,
  quality, DJ (when the DJ plays), lyrics, queue, devices, miniplayer, volume.
- **Full-screen player** (`#tess-np`): three looks: Artwork, Video (Canvas), Vinyl (with a tonearm that reaches the
  centre exactly at the song's end). Modes: lyrics (time-synced, "Back to now" after scrolling), queue (cover flow),
  none. No lyrics → the visual takes the stage, a small note sits in the corner. It sleeps (out of rendering) when
  closed.
- **Panels**: left library (timeline / full-size Glass Shelves), main view, right panel (side cover, live lyrics card,
  queue). Each is one glass surface; inner layers are transparent (`data-tess-clear*` marks).
- **Top strip** on pages: appears together with the page's name once the page title scrolls under it.
- **Home**: greeting (no eyebrow), Spotify's filters, the **Dial** (a ring of 12 picks around a record), On this day.
- **Settings**: a section list on the left, every section a glass card, Tess's card first.
- **Account menu**: glass card with you on top, grouped items with icons.
- **Labels**: no eyebrow/kicker label above a heading. State or reason goes in the line under the title
  ("Playing now · Song · Artist").
- **Icons**: Tess's own set (24-unit grid, 1.75 stroke, round caps, filled transport glyphs); an icon always matches
  its label (Pause shows two bars).

## Motion

- Animate `transform` and `opacity`. Never `transition: all`; list properties.
- Durations: press 100–160 ms; small popovers 125–200 ms; menus 150–250 ms; the player opening 450–600 ms.
- Easing: `--tess-ease-out` for anything responding to you; `--tess-spring` for physical movement; `linear` only for
  constant motion. Never `ease-in` for UI.
- Every pressable Tess control: `:active { transform: scale(.96) }`.
- Never animate from `scale(0)`; start around `.5` with opacity 0.
- **Nothing moves for ever.** On a Retina window any endless motion redraws the whole window every frame (measured:
  about a third of a CPU core). So: records spin for 12 s after a song starts or play is pressed and on hover, then
  rest, and stop when out of view; the bar subtitle scrolls once per song and on hover; the progress line moves a
  pixel at a time. The full-screen player is the one place continuous motion is allowed (it's what you're watching).
- One entrance per page, not the same entrance on every section.
- `prefers-reduced-motion` turns motion off (global rule at the end of `core.css`).

## Performance rules (each one measured on this app)

- No broad `:has()`. A rule like `div:has(> img)` is checked against every div on every change; with an attribute test
  inside (`[style*=…]`) any inline style change anywhere re-checks up to `<body>`. Mark the element in `markLayout`
  (`core.js`) with a `data-tess-*` attribute and target that.
- No `var()` inside animated keyframes and no per-frame changes to a CSS variable on a parent (every child restyles).
  Write `transform` on the element itself.
- `will-change` only on an element that is animating, never on many. Spotify's own buttons and cards get
  `will-change: auto` from Tess.
- Hidden things cost nothing: closed views leave rendering (`display: none` after their exit animation), videos play
  only while visible, work pauses while the window is hidden.
- Don't run timers faster than the thing changes (the progress line updates when it would move a pixel). Prefer one
  shared timer and draw-triggered placement (`onDraw`) to many intervals.
- Spotify's DOM is not Tess's: never move Spotify's elements (React owns them); add classes/attributes or order them
  with CSS. Classes Tess adds to Spotify's elements can be wiped when Spotify re-renders; prefer `data-tess-*`
  attributes or structural CSS.
- Budget (window visible, playing, at rest on Home): CPU within ~5 points of Spotify alone; clicks to paint under
  ~100 ms; no long task over 100 ms in normal use. Measure with the tools in `AGENTS.md`.

## Craft floor (from Impeccable, adapted)

- Contrast: text 4.5:1 (large 3:1).
- Browser surfaces are themed: text selection, caret, focus ring, tabular numerals for times.
- States: hover, pressed, focus, disabled, loading, empty, error, for every Tess control and view.
- Copy in the product's own voice: controls say what they do; errors say what happened and what to do.

## Sources

Extracted on 13 Nov 2026 (read, not installed) from [emilkowalski/skill](https://github.com/emilkowalski/skill),
[pbakaus/impeccable](https://github.com/pbakaus/impeccable) and [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill);
measurements from issue #35.
