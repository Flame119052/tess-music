# Tess Music — what's left after 0.1.0 (12 Nov 2026)

Everything Krish asked for that is not finished, plus what shipping 0.1.0 taught us.

## Shipping / install
- **Only tested on Krish's Mac.** The installer was tested end to end against a copy of Spotify (install, repair, and a
  forced failure that puts Spotify back exactly), and the self-updating loader was checked against the live release.
  Still to test: an Intel Mac, macOS 12–14, a Mac with Spotify in `~/Applications`, a Mac that never had Spicetify.
- **"Spotify is damaged" (Gatekeeper).** A patched Spotify fails Apple's signature check. It still opens when
  Spotify was installed by Spotify's own installer, which is how almost everyone has it; a Spotify copied from a DMG
  by hand is refused. The installer should detect that case and tell the user to reinstall with Spotify's installer.
- **macOS App Management permission.** On newer macOS, Terminal may need permission to update other apps; the
  installer explains this if it happens. The update helper (a background job) may also be refused; it then shows a
  notification asking you to re-run the install line instead of retrying.
- **Tess Mini signing.** It's ad-hoc signed, so macOS asks again to let it control Spotify after every update of Tess
  Mini. Needs an Apple Developer ID certificate + notarization.
- **tess-patcher** is pinned to Spicetify 2.46.4. When a Spotify update breaks it, rebase the fork on the newer
  Spicetify release (`tess-2.46.4` branch → new tag) and re-publish.
- **Beta channel** exists in Settings but nothing has been published to it yet (`node tools/release.mjs X.Y.Z beta`).
- **Windows** (same pieces + a scheduled task) — not started.
- **Spicetify Marketplace listing** — optional, not done.
- On Krish's own Mac, Tess still runs through Spicetify from `~/Developer/tess-music` (the dev setup) with a safe
  re-apply helper; the public installer is not used there.

## Design asks still open
- **Library (full size):** Glass Shelves built (coloured spines, Dock-style magnification, sleeve + record on hover,
  records arrive one by one). Krish said he'd come back on the final library decision.
- **Sidebar → full library transition:** a morph plus records arriving on the shelves; a more creative transition was
  asked for and can go further.
- **Liquid Glass:** refraction, colour split at the rim, specular edges and an adaptive tint are in; Krish wants it at
  Apple's polish, so keep iterating on real screenshots.
- **Icons:** a new consistent set is in the bar and full-screen player; the rest of Spotify's icons are untouched.
- **Home speed:** placement no longer forces layout and data loads when idle, but home's load time wasn't measured with
  Spotify on screen.
- **Not yet seen on screen:** About/Credits dialogs and tooltips after the palette fix; the expand/collapse morph; the
  Dial's appearance speed; Tess Mini controls clicked by hand.

## Features deferred by Krish
- Listening stats page (Spotify's top-artists endpoints refused/404 — needs another source)
- Shareable lyric cards
- Apple-style album pages
- Word-by-word lyrics (#2)
- Phone companion — handled in its own thread

## Dial algorithm ideas (from DeepSeek)
- Store source/kind in the Dial's history for sharper time-of-day habits
- `SOURCE_SHARE` (25%) is the knob if the ring has too many or too few Daily Mixes
