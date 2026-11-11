# Tess Music

Tess Music restyles the Spotify desktop app so it feels like Apple Music. It is part of the Tess project.

It is a [Spicetify](https://spicetify.app) theme, so everything Spotify has keeps working: downloads, Daily Mixes, lossless audio, Spotify's lyrics, and Canvas videos. Tess Music changes four things:

- **Playing bar.** A floating glass bar replaces Spotify's bottom bar. Click the artwork to open the full-screen player.
- **Full-screen player.** A moving background drawn from the album art, the song's Canvas video in place of the cover when it has one, and Spotify's lyrics highlighted in time with the song.
- **Album and playlist pages.** A cleaner header, Play as a pill button, and hairline track rows.
- **Artist pages.** A tall header with the artist's name centered and a looping Canvas video from one of their top songs.

Home and the rest of Spotify stay as Spotify made them.

## Try it

You need Spotify for Mac and [Homebrew](https://brew.sh).

```sh
brew install spicetify-cli
spicetify                                   # creates ~/.config/spicetify
ln -sfn "$PWD/theme/Tess" ~/.config/spicetify/Themes/Tess
spicetify config current_theme Tess color_scheme base inject_theme_js 1
spicetify backup apply
```

After you edit anything in `theme/Tess`, run `tools/reload.sh`. It pushes the theme into Spotify and restarts Spotify with a debug port open, so `tools/cdp.mjs` can inspect the running app and take screenshots.

To put Spotify back the way it was, run `spicetify restore`.

## Layout

- `theme/Tess/user.css`: all styling
- `theme/Tess/theme.js`: the playing bar, the full-screen player, lyrics sync, Canvas video playback, and the artist page video
- `tools/`: the reload script and the DevTools driver
- The first mockups are on the `prototype/mockups` branch.
