#!/bin/sh
# Install the Spotify storage guard: copy the script onto the internal disk
# (the SSD can be absent) and point the existing LaunchAgent at it.
# Re-run any time the repo copy changes. Undo with uninstall.sh.
set -e

GUARD_DIR="$HOME/Library/Application Support/Spotify Storage Guard"
LABEL="music.tess.spotify-cache"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SRC="$(cd "$(dirname "$0")" && pwd)/spotify_storage_guard.py"

mkdir -p "$GUARD_DIR"
cp "$SRC" "$GUARD_DIR/spotify_storage_guard.py"
chmod 755 "$GUARD_DIR/spotify_storage_guard.py"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>ExitTimeOut</key>
	<integer>10</integer>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProcessType</key>
	<string>Background</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/python3</string>
		<string>$GUARD_DIR/spotify_storage_guard.py</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>30</integer>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed. Label: $LABEL (runs every 30s)"
echo "Status: cat '$GUARD_DIR/status.json'"
echo "Unload: launchctl bootout gui/$(id -u)/$LABEL"
