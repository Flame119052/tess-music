#!/bin/zsh
# Dev-machine guard (Spicetify): when a Spotify update puts back its stock interface, re-apply Tess. It only acts on a
# clean, fully-updated Spotify, never restores or deletes anything, and notifies if it can't.
APPS=/Applications/Spotify.app/Contents/Resources/Apps
LOG="$HOME/Library/Application Support/Tess/guard.log"
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
[ -f "$APPS/xpui.spa" ] || exit 0
[ -d "$APPS/xpui" ] && exit 0
pgrep -f "Install Spotify" >/dev/null && exit 0
sleep 8
{ [ -f "$APPS/xpui.spa" ] && [ ! -d "$APPS/xpui" ]; } || exit 0
running=$(pgrep -x Spotify >/dev/null && echo 1)
echo "$(date) Spotify updated; re-applying Tess" >> "$LOG"
if spicetify backup apply --no-restart >> "$LOG" 2>&1 && [ -d "$APPS/xpui" ]; then
  if [ -n "$running" ]; then osascript -e 'tell application "Spotify" to quit' 2>/dev/null; for i in {1..40}; do pgrep -x Spotify >/dev/null || break; sleep 0.5; done; open -a Spotify; fi
else
  osascript -e 'display notification "Spotify updated; run spicetify backup apply to bring Tess back." with title "Tess Music"' >/dev/null 2>&1
fi
