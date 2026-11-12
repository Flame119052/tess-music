#!/bin/sh
# Removes Tess Music and puts Spotify back to stock.
#   curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-releases/main/uninstall.sh | sh
HOME_TESS="$HOME/Library/Application Support/Tess"
PATCHER="$HOME_TESS/bin/patcher/tess-patcher"
echo; printf '\033[1m%s\033[0m\n\n' "Removing Tess Music"
for a in music.tess.guard music.tess.mini; do
  launchctl bootout "gui/$(id -u)/$a" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/LaunchAgents/$a.plist"
done
if pgrep -x Spotify >/dev/null; then osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1; sleep 2; fi
[ -x "$PATCHER" ] && "$PATCHER" restore >/dev/null 2>&1 || true
rm -rf "$HOME/Applications/Tess Mini.app" "$HOME_TESS" "$HOME/.config/tess-patcher"
echo "  Spotify is back to normal. (Your Spotify account, library and downloads were never touched.)"
echo
