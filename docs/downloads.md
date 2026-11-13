# Spotify downloads: what was wrong and what changed

## The cause

Downloads were pointed at the wrong kind of disk.

Spotify was told to save offline songs in `~/Dell/Spotify`. That
folder is not a real disk — it is a network share, a window into the Dell
server over Wi-Fi. Spotify could write its small index file there but never
got a single song file onto it (the app itself reported 0 MB downloaded while
the sidebar said "Downloading 5 of 591"). The moment the location was moved to
the real SSD, files started appearing within seconds. No account limit, no
device limit — Premium is fine and allows 10,000 songs on 5 devices.

A safety net was also broken. The folder Spotify uses when it can't find your
chosen location was pointed at an old drive ("iMac II") that isn't connected
anymore, and the old background helper only looked after a different thing
(the streaming cache) and had been quietly failing every 30 seconds since its
disk image was deleted in October.

## What changed

| Thing | Before | Now |
| --- | --- | --- |
| Download folder | `~/Dell/Spotify` (network share) | `/Volumes/DellSSD/Spotify` (the SSD) |
| Download size cap | 1,536 MB | 40,960 MB (about 40 GB, room for all 591 songs at lossless) |
| Spotify's fallback folder | symlink to a missing drive | symlink to `/Volumes/DellSSD/Spotify`, locked so Spotify can't replace it |
| Streaming cache (temp files while listening) | symlink to a deleted disk image | symlink to `/Volumes/DellSSD/Spotify Streaming Cache` |
| Background helper | mounted a disk image that no longer exists | new guard, same schedule (every 30 s) |
| Audio quality | already Lossless for streaming and downloads — untouched | |

## The guard, in plain terms

A tiny script runs every 30 seconds under the same system entry as before
(`music.tess.spotify-cache`). Its whole job:

- **SSD connected:** make sure both pointers above still aim at the SSD, and
  while Spotify is closed, put the download folder back in Spotify's settings
  file if Spotify ever rewrites it.
- **SSD disconnected:** show one notification saying why, then close Spotify
  once so it can't move downloads to the internal disk while it shuts down.
  If you reopen Spotify anyway it leaves you alone — the pointers dangle on
  purpose, so downloads simply cannot start on the internal disk.
- **SSD plugged back in:** heals everything automatically and forgets the
  episode.

The script lives on the internal disk at
`~/Library/Application Support/Spotify Storage Guard/spotify_storage_guard.py`
so it still works when the SSD is unplugged. The editable copy is here in the
repo at `tools/downloads/spotify_storage_guard.py`; after editing it, run
`tools/downloads/install.sh` to copy it into place and reload.

What it writes: `status.json` (what it saw and did last run) and `guard.log`
(history), both in that same folder.

The old helper's files were moved, not deleted:
`~/Library/Application Support/Spotify Storage Guard/superseded-streaming-cache-20261018/`.

## Turn it off

```sh
tools/downloads/uninstall.sh          # removes the guard
launchctl bootout gui/$(id -u)/music.tess.spotify-cache   # or just stop it once
```

To put Spotify fully back to defaults afterwards: quit Spotify, then in
`~/Library/Application Support/Spotify/prefs` set `storage.location` and
`storage.last-location` to `"$HOME/Library/Application Support/Spotify/PersistentCache/Storage"`,
unlock and remove the two links (`chflags -h nouchg` then `rm` on
`PersistentCache/Storage` and `~/Library/Caches/com.spotify.client/Data`).

## Left for you

- Nothing needed for downloads — they resume on their own.
- If you want the old empty folder gone: `~/Dell/Spotify` on the
  Dell server holds only a 512-byte index file; safe to delete whenever.
- Songs that were ever downloaded to the old "iMac II" drive stay there;
  nothing is copied over. Spotify re-downloads everything fresh to the SSD.
