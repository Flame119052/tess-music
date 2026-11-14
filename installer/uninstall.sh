#!/bin/sh
# Removes Tess Music and puts Spotify back to stock.
# Installed as a signed Tess part; run with: ~/Library/Application\ Support/Tess/tess uninstall
HOME_TESS="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
[ -f "$HOME_TESS/updater.env" ] && . "$HOME_TESS/updater.env"
CONF="${TESS_CONFIG:-$HOME/.config/tess-patcher}"
[ -n "$TESS_CONFIG" ] && export SPICETIFY_CONFIG="$TESS_CONFIG"
PATCHER="$HOME_TESS/bin/patcher/tess-patcher"
echo; printf '\033[1m%s\033[0m\n\n' "Removing Tess Music"
# A launchd label is per user. A sandbox must not call /bin/launchctl, which is the owner's real job.
real_launchctl() { [ -n "$TESS_TEST" ] && [ "$(command -v launchctl)" = /bin/launchctl ]; }
real_launchctl || launchctl enable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
if [ -z "$TESS_TEST" ]; then
  for a in music.tess.guard music.tess.mini music.tess.rescue music.tess.wake; do
    launchctl bootout "gui/$(id -u)/$a" >/dev/null 2>&1 || true
    rm -f "$HOME/Library/LaunchAgents/$a.plist"
  done
  if pgrep -x Spotify >/dev/null; then osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1; sleep 2; fi
fi
[ -x "$PATCHER" ] && "$PATCHER" restore --no-restart >/dev/null 2>&1 || true
[ -z "$TESS_TEST" ] && rm -rf "$HOME/Applications/Tess Mini.app"
rm -rf "$HOME_TESS" "$CONF"
echo "  Spotify is back to normal. (Your Spotify account, library and downloads were never touched.)"
echo
