# tess-patcher

tess-patcher is a fork of [Spicetify CLI](https://github.com/spicetify/cli) (© the Spicetify contributors), used
by [Tess Music](https://github.com/Flame119052/tess-releases) to apply its theme to the Spotify desktop app.

It is distributed under the same licence as Spicetify, the **GNU Lesser General Public License v2.1** (see
`LICENSE`). All credit for the patching engine, the Spotify API wrapper (`jsHelper/`) and the CSS map belongs to the
Spicetify project and its contributors.

Changes from upstream (all under LGPL-2.1, source in this repository):
- configuration lives in `~/.config/tess-patcher` (so it never collides with a real Spicetify install)
- defaults: theme `Tess`, colour scheme `base`, no Spicetify update check
- built as a universal macOS binary for the Tess installer
