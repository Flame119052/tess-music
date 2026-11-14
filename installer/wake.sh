#!/bin/zsh
# Every five minutes, read the public release marker and wake the signed updater when it moved.
# The rescue serial is read only while that line is on, so a user who turned it off is not
# stuck waiting on the rescue branch for ordinary updates.
T="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
STATE="$T/state"
R="$T/rescue"
REPO="Flame119052/tess-music"
CHANNEL=$(sed -n "s/^TESS_PARTS_CHANNEL='\(.*\)'$/\1/p" "$T/updater.env" 2>/dev/null)
CHANNEL="${CHANNEL:-stable}"

if [ "$1" = --plist ]; then
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.wake</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$T/wake.sh</string></array>
<key>StartInterval</key><integer>300</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>Nice</key><integer>10</integer>
</dict></plist>
EOF
  exit 0
fi

mkdir -p "$STATE" "$R"
LOCK="$T/.installing"
[ -e "$LOCK" ] && [ -z "$(find "$LOCK" -mmin +30 2>/dev/null)" ] && exit 0

# One failed read pauses both for 15 minutes, so a dead network is not hit every 5.
# On that attempt the reads stay separate: a missing rescue order still wakes an update.
FAILED="$STATE/.wake-network-failed"
[ -f "$FAILED" ] && [ -z "$(find "$FAILED" -mmin +15 2>/dev/null)" ] && exit 0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
version_url="https://raw.githubusercontent.com/$REPO/$CHANNEL/dist/manifest.json"
rescue_url="https://raw.githubusercontent.com/$REPO/rescue/rescue.txt"
failed=""
if curl -fsSL --connect-timeout 5 --max-time 15 "$version_url" -o "$TMP/version"; then
  published=$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$TMP/version")
  installed=$(cat "$STATE/version" 2>/dev/null)
  if [ -n "$published" ] && [ "$published" != "$installed" ]; then
    launchctl kickstart "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 || true
  fi
else
  failed=1
fi
if [ -f "$T/rescue-off" ]; then
  if [ -n "$failed" ]; then touch "$FAILED"; else rm -f "$FAILED"; fi
  exit 0
fi
if ! curl -fsSL --connect-timeout 5 --max-time 15 "$rescue_url" -o "$TMP/rescue"; then
  failed=1
fi
if [ -n "$failed" ]; then touch "$FAILED"; else rm -f "$FAILED"; fi
[ -s "$TMP/rescue" ] || exit 0

serial=$(awk '$1 == "serial" { print $2; exit }' "$TMP/rescue")
case $serial in ''|*[!0-9]*) exit 0 ;; esac
done_serial=$(cat "$R/serial" 2>/dev/null); done_serial=${done_serial:-0}
case $done_serial in ''|*[!0-9]*) done_serial=0 ;; esac
kicked=$(cat "$STATE/.wake-rescue-kicked" 2>/dev/null)
if [ ! -f "$T/rescue-off" ] && [ "$serial" -gt "$done_serial" ] && [ "$serial" != "$kicked" ]; then
  echo "$serial" > "$STATE/.wake-rescue-kicked"
  launchctl kickstart "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
fi
exit 0
