# Credits

Tess Music stands on other people's work. This file lists everything it includes, builds on, or learned from, with
licences. Tess's own code is MIT (`LICENSE`); the patcher keeps its upstream licence.

## Code included in Tess

### Spicetify CLI — the patching engine
- **What:** `patcher/` is a fork of [Spicetify CLI](https://github.com/spicetify/cli) v2.46.4, © the Spicetify
  contributors. Its full git history is kept in this repository. Release builds also include Spicetify's compiled
  JavaScript helper (`jsHelper/`, the Spotify API wrapper Tess calls as `Spicetify.*`) and its CSS map, downloaded
  from the official [v2.46.4 release](https://github.com/spicetify/cli/releases/tag/v2.46.4).
- **Licence:** GNU Lesser General Public License v2.1 (`patcher/LICENSE`). Tess's changes to it are under the same
  licence, with source in this repository, and are listed in `patcher/NOTICE.md`.
- **Credit:** all credit for patching the Spotify client, the `Spicetify` JavaScript API and the class-name map
  belongs to the Spicetify project and its contributors.

### Go libraries used by the patcher
| Library | Licence |
| --- | --- |
| [go-ini/ini](https://github.com/go-ini/ini) | Apache-2.0 |
| [mattn/go-colorable](https://github.com/mattn/go-colorable) | MIT |
| [pterm/pterm](https://github.com/pterm/pterm) | MIT |
| [golang.org/x/net](https://pkg.go.dev/golang.org/x/net), [golang.org/x/sys](https://pkg.go.dev/golang.org/x/sys) | BSD-3-Clause |

and their own dependencies, listed in `patcher/go.mod` / `go.sum` under their own licences.

Everything else (the theme and loader, installer, updater, doctor, rescue line, Tess Mini, the inbox, the companion
and its icons, the tools) was written for Tess.

## Design references (read and learned from; no code or text copied)

- **Apple Music** and Apple's **Liquid Glass** design language: the look Tess aims for. Apple, Apple Music, Liquid
  Glass and SF Pro are trademarks of Apple Inc.; Tess uses the system font already on your Mac and ships no Apple
  assets.
- **Design-engineering rules** in `DESIGN.md` (motion, animation performance, the craft floor) were distilled from:
  - [emilkowalski/skill](https://github.com/emilkowalski/skill) by Emil Kowalski (MIT): animation decisions,
    easing, press feedback, animation performance (composite-only properties, inherited CSS variables, `will-change`).
  - [pbakaus/impeccable](https://github.com/pbakaus/impeccable) by Paul Bakaus (Apache-2.0): the craft floor
    (contrast, no eyebrow labels, one entrance per page, themed browser surfaces).
  - [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) by Leonxlnx (MIT): motion restraint (no fade-in on
    every section) and small hover/press motions.
  These were found through a short-video post about Claude design skills and read on 13 Nov 2026; they are not
  installed or bundled.

## Help along the way

- **The Dial's picking algorithm** (`theme/Tess/src/dial-pick.js`, `docs/dial-algorithm.md`) and the first
  write-up of every picking rule (`docs/algorithms.md`) were worked out with the DeepSeek model.
- Much of the code and documentation was written with AI coding assistants (Claude, DeepSeek) under the owner's
  direction and review.

## Services

GitHub (code, releases, Actions), jsDelivr (a fallback mirror for updates) and Cloudflare Workers (the anonymous
health-report inbox) run parts of Tess's delivery; no code from them is included.

## Trademarks and disclaimer

Spotify is a trademark of Spotify AB. Tess Music is an independent project, not affiliated with, endorsed by or
sponsored by Spotify or Apple. Tess modifies the Spotify app's interface files on your Mac; it never touches your
account, library or downloads. Spotify's User Guidelines say not to modify the client; no action against theme
users is documented, but the risk is yours to judge.
