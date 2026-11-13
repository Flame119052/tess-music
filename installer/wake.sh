#!/bin/zsh
# Tess wake: starts the rescue line within a minute of an order being sent, instead of waiting for the 6-hour check.
# It runs from its own LaunchAgent (music.tess.wake, every minute), asks the inbox for the newest rescue serial, and
# asks launchd to run the rescue agent when that serial is newer than the last one this Mac saw.
#
# It can only ring the bell: an order still has to be downloaded and pass the offline rescue key's signature before
# anything runs. It is kept separate from the updater and from the 6-hour rescue agent on purpose; if it breaks, rescue
# still runs every six hours. The request carries no install id; the serial it asks about is public (the signed order
# is public too).
T="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
R="$T/rescue"
INBOX="${TESS_INBOX:-https://tess-music-player.janus.ing}"
AGENT="gui/$(id -u)/music.tess.rescue"

# The installer and the updater both use this one copy to write the LaunchAgent, so the two can never disagree.
if [ "$1" = --plist ]; then
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.wake</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$T/wake.sh</string></array>
<key>StartInterval</key><integer>60</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>Nice</key><integer>10</integer>
</dict></plist>
EOF
  exit 0
fi

[ -x "$R/rescue.sh" ] || exit 0
# The installer or an updater run is working (it holds this lock for up to 30 minutes). Try again next minute.
[ -e "$T/.installing" ] && [ -z "$(find "$T/.installing" -mmin +30 2>/dev/null)" ] && exit 0

token=$(curl -fsSL --connect-timeout 5 --max-time 15 "$INBOX/v1/wake" 2>/dev/null) || exit 0
case $token in ''|*[!0-9]*) exit 0 ;; esac
done=$(cat "$R/serial" 2>/dev/null); done=${done:-0}
[ "$token" -gt "$done" ] || exit 0

# An order that cannot start (expired, or meant for another Mac) is retried every 15 minutes, not every minute.
tried="$R/wake-tried"
[ "$(cat "$tried" 2>/dev/null)" = "$token" ] && [ -z "$(find "$tried" -mmin +15 2>/dev/null)" ] && exit 0
echo "$token" > "$tried"
echo "$(date '+%F %T') wake: order $token is out; starting the rescue line" >> "$R/wake.log"
[ "$(wc -c < "$R/wake.log" 2>/dev/null || echo 0)" -gt 50000 ] && tail -c 25000 "$R/wake.log" > "$R/wake.log.tmp" && mv "$R/wake.log.tmp" "$R/wake.log"

# launchd does not start a second copy of the rescue agent while one is already running.
if launchctl print "$AGENT" >/dev/null 2>&1; then
  launchctl kickstart "$AGENT" >/dev/null 2>&1
else
  /bin/zsh "$R/rescue.sh" >/dev/null 2>&1
fi
exit 0
