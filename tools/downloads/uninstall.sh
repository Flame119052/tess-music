#!/bin/sh
# Remove the storage guard. Does not touch Spotify prefs, the symlinks, or any
# downloaded files -- see docs/downloads.md for putting those back by hand.
set -e
LABEL="com.krishay.spotify-cache"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
rm -f "$HOME/Library/Application Support/Spotify Storage Guard/spotify_storage_guard.py"
echo "Guard removed."
