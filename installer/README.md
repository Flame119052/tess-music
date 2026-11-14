# Tess Music

Spotify, redesigned for the Mac — an Apple-Music-grade interface on top of the real Spotify desktop app, so everything
Spotify has (your library, Daily Mixes, downloads, lossless, lyrics, Jam) is still there.

## Install

You need a Mac (macOS 12+) with the Spotify desktop app installed and signed in. Open Terminal and run:

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/install.sh | sh
```

That's all. Spotify reopens with Tess and a short welcome to pick your defaults. Tess updates itself every time Spotify
starts, and puts itself back automatically after Spotify updates.

**Tess Mini**, a miniplayer that floats over every app and desktop, is installed too (macOS 13+). The first time you
open it, macOS asks to let it control Spotify — choose **Allow**.

## Update, repair, remove

```sh
~/Library/Application\ Support/Tess/tess update      # or repair
~/Library/Application\ Support/Tess/tess uninstall   # puts Spotify back to stock
```

## What it does, honestly

Tess changes how the Spotify desktop app looks by patching the app's interface files on your Mac (using
[tess-patcher](https://github.com/Flame119052/tess-music/tree/main/patcher), a fork of Spicetify). It never touches your account,
password or downloads. Spotify's User Guidelines say not to modify the client; no action against theme users or
authors is documented, but the risk is yours to judge. Spotify updates remove Tess for a few seconds until the helper
puts it back.

Tess also has a rescue line: the maintainer can remotely make your Mac run one of five Tess actions (check, update,
repair, restore Spotify, or uninstall) using orders signed with an offline key. See what ran with
`~/Library/Application Support/Tess/tess rescue log`, and turn it off with
`~/Library/Application Support/Tess/tess rescue off`.

Credits and licences: see `NOTICE.md`.
