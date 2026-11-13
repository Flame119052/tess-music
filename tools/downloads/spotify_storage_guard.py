#!/usr/bin/env python3
"""Keep Spotify's downloads and streaming cache on the Dell SSD, never the internal disk.

Every 30 s (LaunchAgent music.tess.spotify-cache) this does one of four things:

  SSD mounted, Spotify running   -> keep the two symlinks aimed at the SSD.
  SSD mounted, Spotify quit      -> also restore storage.location in prefs.
  SSD missing, Spotify running   -> notify once, quit Spotify once; if Krish
                                    reopens it anyway, just keep the symlinks
                                    dangling so nothing can land internally.
  SSD missing, Spotify quit      -> restore prefs and symlinks for next launch.

The symlinks are the hard stop: ~/Library/.../PersistentCache/Storage always
points at the SSD, so even Spotify's own "reset to default" resolves back onto
the SSD. While the SSD is gone the links dangle and writes fail instead of
silently filling the internal disk.

Test without unplugging the drive:
  SSG_MOUNT=/nonexistent SSG_DRY_RUN=1 python3 spotify_storage_guard.py
"""
import datetime
import fcntl
import json
import os
import pathlib
import subprocess
import time

GUARD_DIR = pathlib.Path.home() / "Library/Application Support/Spotify Storage Guard"
STATUS = GUARD_DIR / "status.json"
LOG = GUARD_DIR / "guard.log"
EPISODE = GUARD_DIR / "missing-drive-episode"

APP_SUPPORT = pathlib.Path.home() / "Library/Application Support/Spotify"
PREFS = APP_SUPPORT / "prefs"
STORAGE_LINK = APP_SUPPORT / "PersistentCache" / "Storage"
DATA_LINK = pathlib.Path.home() / "Library/Caches/com.spotify.client/Data"

MOUNT = pathlib.Path(os.environ.get("SSG_MOUNT", "/Volumes/DellSSD"))
DOWNLOAD_DIR = pathlib.Path(os.environ.get("SSG_DOWNLOAD_DIR", str(MOUNT / "Spotify")))
STREAM_DIR = pathlib.Path(os.environ.get("SSG_STREAM_DIR", str(MOUNT / "Spotify Streaming Cache")))
DRY_RUN = os.environ.get("SSG_DRY_RUN") == "1"

actions = []


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def act(msg):
    actions.append(msg)


def run(cmd, timeout=15):
    if DRY_RUN:
        act("would run: " + " ".join(map(str, cmd)))
        return None
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def spotify_running():
    return subprocess.run(["/usr/bin/pgrep", "-xq", "Spotify"]).returncode == 0


def notify(body):
    act("notify: " + body)
    run(["/usr/bin/osascript", "-e",
         'display notification "{}" with title "Spotify Storage Guard"'.format(body)])


def quit_spotify():
    act("asking Spotify to quit")
    run(["/usr/bin/osascript", "-e", 'tell application "Spotify" to quit'])
    for _ in range(24):
        if DRY_RUN or not spotify_running():
            return
        time.sleep(0.5)
    act("still running after 12s; sending TERM")
    run(["/usr/bin/pkill", "-x", "Spotify"])


def chflags_h(flag, path):
    # -h acts on the symlink itself, which may dangle while the SSD is away.
    subprocess.run(["/usr/bin/chflags", "-h", flag, str(path)],
                   capture_output=True, timeout=10)


def fix_link(link, target):
    """Point `link` at `target`, then lock it uchg so Spotify cannot replace it
    with a real directory while it runs. A real directory found in the way is
    moved aside, never deleted."""
    target = str(target)
    if link.is_symlink() and os.readlink(link) == target:
        if not DRY_RUN:
            chflags_h("uchg", link)
        return
    if not DRY_RUN:
        chflags_h("nouchg", link)
    if link.is_symlink() or not link.exists():
        act("%s %s -> %s" % ("repoint" if link.is_symlink() else "create link", link, target))
        if not DRY_RUN:
            link.parent.mkdir(parents=True, exist_ok=True)
            if link.is_symlink():
                link.unlink()
            link.symlink_to(target)
    else:
        rescued = link.with_name(link.name + ".internal-rescue-" + time.strftime("%Y%m%d-%H%M%S"))
        act("real dir in the way; move %s -> %s, then link to %s" % (link, rescued, target))
        if not DRY_RUN:
            link.rename(rescued)
            link.symlink_to(target)
    if not DRY_RUN:
        chflags_h("uchg", link)


def fix_prefs():
    """Restore storage.location/last-location to DOWNLOAD_DIR. Only ever called
    while Spotify is quit, because Spotify rewrites prefs from memory on exit."""
    if not PREFS.exists():
        act("no prefs file; skipping")
        return
    lines = PREFS.read_text().splitlines()
    wanted = {
        "storage.location": 'storage.location="%s"' % DOWNLOAD_DIR,
        "storage.last-location": 'storage.last-location="%s"' % DOWNLOAD_DIR,
    }
    seen = set()
    out = []
    changed = False
    for line in lines:
        key = line.split("=", 1)[0]
        if key in wanted:
            seen.add(key)
            if line != wanted[key]:
                out.append(wanted[key])
                changed = True
            else:
                out.append(line)
        else:
            out.append(line)
    for key, val in wanted.items():
        if key not in seen:
            out.append(val)
            changed = True
    if changed:
        act("prefs: point storage.location at %s" % DOWNLOAD_DIR)
        if not DRY_RUN:
            tmp = PREFS.with_suffix(".guard-tmp")
            tmp.write_text("\n".join(out) + "\n")
            tmp.replace(PREFS)


def main():
    GUARD_DIR.mkdir(parents=True, exist_ok=True)
    lock = (GUARD_DIR / "guard.lock").open("a+")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return

    mounted = os.path.ismount(MOUNT)
    running = spotify_running()
    state = "%s-%s" % ("mounted" if mounted else "missing", "running" if running else "quit")

    if mounted:
        if EPISODE.exists():
            act("SSD back; clearing missing-drive marker")
            if not DRY_RUN:
                EPISODE.unlink()
        for d in (DOWNLOAD_DIR, STREAM_DIR):
            if not d.exists():
                act("mkdir %s" % d)
                if not DRY_RUN:
                    d.mkdir(parents=True, exist_ok=True)
        fix_link(STORAGE_LINK, DOWNLOAD_DIR)
        fix_link(DATA_LINK, STREAM_DIR)
        if not running:
            fix_prefs()
    else:
        if running and not EPISODE.exists():
            notify("Dell SSD is not connected. Closed Spotify so downloads stay off the internal disk; reconnect the drive and reopen Spotify.")
            if not DRY_RUN:
                EPISODE.write_text(now() + "\n")
            quit_spotify()
            running = spotify_running() if not DRY_RUN else False
            state = "%s-%s" % ("missing", "running" if running else "quit")
        # Whether he left it closed or reopened it, keep the shield dangling
        # and prefs aimed at the SSD so nothing is re-routed internally.
        fix_link(STORAGE_LINK, DOWNLOAD_DIR)
        fix_link(DATA_LINK, STREAM_DIR)
        if not running:
            fix_prefs()

    result = {"at": now(), "state": state, "mount": str(MOUNT),
              "download_dir": str(DOWNLOAD_DIR), "stream_dir": str(STREAM_DIR),
              "actions": actions}
    if DRY_RUN:
        print(json.dumps(result, indent=2))
        return
    tmp = STATUS.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, indent=2) + "\n")
    tmp.replace(STATUS)
    if actions:
        with LOG.open("a") as f:
            for a in actions:
                f.write("%s %s %s\n" % (now(), state, a))
        if LOG.stat().st_size > 262144:
            LOG.write_text(LOG.read_text()[-65536:])


if __name__ == "__main__":
    main()
