#!/bin/sh
# Tess Music installer for macOS.
#   curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-releases/main/install.sh | sh
# Installs Tess into the Spotify desktop app, a helper that re-applies it after Spotify updates, and Tess Mini.
# Nothing else to set up; run it again any time to repair. Remove with: ~/Library/Application\ Support/Tess/tess uninstall
set -e

REPO="Flame119052/tess-releases"
DL="https://github.com/$REPO/releases/latest/download"
HOME_TESS="$HOME/Library/Application Support/Tess"
CONF="$HOME/.config/tess-patcher"
MIN_SPOTIFY="1.2.40"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '  \033[32m●\033[0m %s\n' "$1"; }
fail() { printf '\n  \033[31m✕\033[0m %s\n\n' "$1"; exit 1; }
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | head -1)" = "$2" ]; }

echo; bold "Tess Music"; echo

# --- the Mac ---------------------------------------------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || fail "Tess Music runs on macOS."
MACOS=$(sw_vers -productVersion)
step "macOS $MACOS on $(uname -m)"

# --- Spotify -----------------------------------------------------------------------------------------------------
SPOTIFY=""
for p in "/Applications/Spotify.app" "$HOME/Applications/Spotify.app"; do [ -d "$p" ] && SPOTIFY="$p" && break; done
[ -n "$SPOTIFY" ] || fail "Spotify isn't installed. Get the desktop app from https://www.spotify.com/download/mac/ , open it once and sign in, then run this again."
SPV=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$SPOTIFY/Contents/Info.plist" 2>/dev/null || echo 0)
if ! ver_ge "$SPV" "$MIN_SPOTIFY"; then
  open -a "$SPOTIFY" 2>/dev/null || true
  fail "Spotify $SPV is too old for Tess (needs $MIN_SPOTIFY or newer). In Spotify open the Spotify menu → About Spotify (or Check for Updates), update, then run this again."
fi
step "Spotify $SPV"
if [ ! -f "$HOME/Library/Application Support/Spotify/prefs" ]; then
  step "Opening Spotify once so it can set itself up…"
  open -a "$SPOTIFY"; i=0
  while [ ! -f "$HOME/Library/Application Support/Spotify/prefs" ] && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done
  [ -f "$HOME/Library/Application Support/Spotify/prefs" ] || fail "Open Spotify, sign in, then run this again."
fi
if [ ! -w "$SPOTIFY/Contents/Resources" ]; then
  step "Spotify belongs to another user; asking for your password to let Tess update it"
  sudo chown -R "$(id -un)" "$SPOTIFY" </dev/tty || fail "Couldn't get permission to update Spotify."
fi

# --- download --------------------------------------------------------------------------------------------------
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
step "Downloading Tess"
curl -fsSL "$DL/tess-patcher-macos-universal.tar.gz" -o "$TMP/patcher.tgz" || fail "Download failed. Check your connection and try again."
curl -fsSL "$DL/tess-theme.tar.gz" -o "$TMP/theme.tgz" || fail "Download failed. Check your connection and try again."
curl -fsSL "$DL/tess-mini.zip" -o "$TMP/mini.zip" || true
mkdir -p "$HOME_TESS/bin"
rm -rf "$HOME_TESS/bin/patcher"; mkdir -p "$HOME_TESS/bin/patcher"
tar -xzf "$TMP/patcher.tgz" -C "$HOME_TESS/bin/patcher"
PATCHER="$HOME_TESS/bin/patcher/tess-patcher"
chmod +x "$PATCHER"

# --- quit Spotify, undo any earlier patching ---------------------------------------------------------------------
WAS_RUNNING=""
if pgrep -x Spotify >/dev/null; then
  WAS_RUNNING=1; step "Closing Spotify"
  osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1 || true
  i=0; while pgrep -x Spotify >/dev/null && [ $i -lt 40 ]; do sleep 0.5; i=$((i+1)); done
  pkill -x Spotify 2>/dev/null || true
fi
if [ -d "$SPOTIFY/Contents/Resources/Apps/xpui" ]; then
  # Spotify was already modified (an earlier Tess, or Spicetify): put it back to stock first
  if [ -d "$CONF/Backup" ]; then "$PATCHER" restore >/dev/null 2>&1 || true
  elif command -v spicetify >/dev/null 2>&1; then step "Spicetify found: restoring stock Spotify first"; spicetify restore >/dev/null 2>&1 || true
  fi
  [ -d "$SPOTIFY/Contents/Resources/Apps/xpui" ] && fail "Spotify has been modified by another tool. Reinstall Spotify from https://www.spotify.com/download/mac/ and run this again."
fi

# --- install the theme --------------------------------------------------------------------------------------------
step "Installing Tess into Spotify"
"$PATCHER" -c >/dev/null 2>&1 || true
mkdir -p "$CONF/Themes"
rm -rf "$CONF/Themes/Tess"
tar -xzf "$TMP/theme.tgz" -C "$CONF/Themes"
"$PATCHER" config spotify_path "$SPOTIFY/Contents/Resources" >/dev/null
"$PATCHER" config current_theme Tess >/dev/null
"$PATCHER" config color_scheme base >/dev/null
"$PATCHER" config inject_theme_js 1 >/dev/null
"$PATCHER" config check_spicetify_update 0 >/dev/null
rm -rf "$CONF/Backup" 2>/dev/null || true
"$PATCHER" backup apply --no-restart >/dev/null 2>&1 || "$PATCHER" backup apply --no-restart || fail "Couldn't apply Tess to Spotify $SPV."

# --- the guard: re-apply after Spotify updates itself -----------------------------------------------------------------
step "Keeping Tess on through Spotify updates"
cat > "$HOME_TESS/reapply.sh" <<EOF
#!/bin/zsh
APPS="$SPOTIFY/Contents/Resources/Apps"
[ -d "\$APPS" ] || exit 0
[ -d "\$APPS/xpui" ] && exit 0
sleep 5; [ -d "\$APPS/xpui" ] && exit 0
running=\$(pgrep -x Spotify >/dev/null && echo 1)
echo "\$(date) Spotify updated; re-applying Tess" >> "$HOME_TESS/guard.log"
"$PATCHER" backup apply --no-restart >> "$HOME_TESS/guard.log" 2>&1 || { "$PATCHER" restore backup apply --no-restart >> "$HOME_TESS/guard.log" 2>&1; }
if [ -n "\$running" ]; then osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1; for i in {1..40}; do pgrep -x Spotify >/dev/null || break; sleep 0.5; done; open -a "$SPOTIFY"; fi
EOF
chmod +x "$HOME_TESS/reapply.sh"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/music.tess.guard.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.guard</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$HOME_TESS/reapply.sh</string></array>
<key>WatchPaths</key><array><string>$SPOTIFY/Contents/Resources/Apps</string></array>
<key>StartInterval</key><integer>300</integer>
<key>RunAtLoad</key><true/>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.guard.plist" 2>/dev/null || true

# --- Tess Mini (macOS 13+) ----------------------------------------------------------------------------------------------
if [ -s "$TMP/mini.zip" ] && ver_ge "$MACOS" "13.0"; then
  step "Installing Tess Mini"
  mkdir -p "$HOME/Applications"
  launchctl bootout "gui/$(id -u)/music.tess.mini" >/dev/null 2>&1 || true
  rm -rf "$HOME/Applications/Tess Mini.app"
  ditto -x -k "$TMP/mini.zip" "$HOME/Applications"
  cat > "$HOME/Library/LaunchAgents/music.tess.mini.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.mini</string>
<key>ProgramArguments</key><array><string>$HOME/Applications/Tess Mini.app/Contents/MacOS/TessMini</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
EOF
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.mini.plist" 2>/dev/null || true
fi

# --- the tess command (update / repair / uninstall) -----------------------------------------------------------------
cat > "$HOME_TESS/tess" <<'EOF'
#!/bin/sh
case "$1" in
  update|repair) curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-releases/main/install.sh | sh ;;
  uninstall) curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-releases/main/uninstall.sh | sh ;;
  *) echo "usage: tess update | repair | uninstall" ;;
esac
EOF
chmod +x "$HOME_TESS/tess"

echo
bold "Tess is installed."
echo "  Spotify opens now. The theme updates itself; Spotify updates are handled for you."
echo "  The first time you open the miniplayer, macOS asks to let Tess Mini control Spotify: choose Allow."
echo "  To remove it: \"$HOME_TESS/tess\" uninstall"
echo
open -a "$SPOTIFY"
