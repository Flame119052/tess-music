#!/bin/zsh
# Tess guard: when a Spotify update puts back its stock interface, re-apply Tess and reopen Spotify.
APPS=/Applications/Spotify.app/Contents/Resources/Apps
LOG="$HOME/Library/Application Support/Tess/guard.log"
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
[ -d "$APPS" ] || exit 0
[ -d "$APPS/xpui" ] && exit 0          # already themed
sleep 5                                  # let the updater finish writing
[ -d "$APPS/xpui" ] && exit 0
running=$(pgrep -x Spotify >/dev/null && echo 1)
echo "$(date) Spotify updated; re-applying Tess" >> "$LOG"
spicetify backup apply --no-restart >> "$LOG" 2>&1 || spicetify restore backup apply >> "$LOG" 2>&1
if [ -n "$running" ]; then
  osascript -e 'tell application "Spotify" to quit' 2>/dev/null
  for i in {1..40}; do pgrep -x Spotify >/dev/null || break; sleep 0.5; done
  open -a Spotify
fi
