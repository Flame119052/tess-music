#!/bin/sh
# Tess Music installer for macOS.
#   curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/install.sh | sh
# Installs Tess into the Spotify desktop app, a helper that re-applies it after Spotify updates, and Tess Mini.
# Nothing else to set up; run it again any time to repair. Remove with: ~/Library/Application\ Support/Tess/tess uninstall
set -e

REPO="Flame119052/tess-music"
HOME_TESS="$HOME/Library/Application Support/Tess"
CONF="$HOME/.config/tess-patcher"
if [ -n "$TESS_TEST" ]; then
  # a test install must not touch the real Tess: its own folders, its own patcher settings, a copy of Spotify
  [ -n "$TESS_HOME" ] && [ -n "$TESS_CONFIG" ] && [ -n "$TESS_SPOTIFY" ] || { echo "TESS_TEST needs TESS_HOME, TESS_CONFIG and TESS_SPOTIFY"; exit 1; }
  HOME_TESS="$TESS_HOME"; CONF="$TESS_CONFIG"
  export SPICETIFY_CONFIG="$TESS_CONFIG" SPICETIFY_STATE="$TESS_CONFIG/state"
fi
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
SPOTIFY="${TESS_SPOTIFY:-}"   # TESS_SPOTIFY / TESS_TEST=1 are for testing against a copy of Spotify
if [ -z "$SPOTIFY" ]; then
  for p in "/Applications/Spotify.app" "$HOME/Applications/Spotify.app"; do [ -d "$p" ] && SPOTIFY="$p" && break; done
fi
[ -n "$SPOTIFY" ] || fail "Spotify isn't installed. Get the desktop app from https://www.spotify.com/download/mac/ , open it once and sign in, then run this again."
SPV=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$SPOTIFY/Contents/Info.plist" 2>/dev/null || echo 0)
if ! ver_ge "$SPV" "$MIN_SPOTIFY"; then
  open -a "$SPOTIFY" 2>/dev/null || true
  fail "Spotify $SPV is too old for Tess (needs $MIN_SPOTIFY or newer). In Spotify open the Spotify menu → About Spotify (or Check for Updates), update, then run this again."
fi
step "Spotify $SPV"
i=0; while pgrep -f "Install Spotify" >/dev/null && [ $i -lt 120 ]; do [ $i -eq 0 ] && step "Waiting for Spotify's installer to finish…"; sleep 2; i=$((i+1)); done
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
# The signed parts list says which file of each part is current; every download is checked against it.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
step "Downloading Tess"
CH="${TESS_PARTS_CHANNEL:-stable}"
getlist() { curl -fsSL -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/$REPO/contents/dist/$1?ref=$CH" -o "$TMP/$1" \
  || curl -fsSL "https://raw.githubusercontent.com/$REPO/$CH/dist/$1" -o "$TMP/$1"; }
getlist components.txt && getlist components.sig || fail "Download failed. Check your connection and try again."
part() { awk -v n="$1" '$1 == n { print $'"$2"' }' "$TMP/components.txt"; }
fetch() { curl -fsSL "$(part "$1" 3)" -o "$2" && [ "$(shasum -a 256 "$2" | cut -d' ' -f1)" = "$(part "$1" 2)" ]; }
fetch patcher "$TMP/patcher.tgz" || fail "Download failed. Check your connection and try again."
mkdir -p "$TMP/p" && tar -xzf "$TMP/patcher.tgz" -C "$TMP/p"
"$TMP/p/tess-verify" "$TMP/components.txt" "$(tr -d '\n' < "$TMP/components.sig")" || fail "Tess's download didn't pass its signature check, so nothing was installed."
fetch theme "$TMP/theme.tgz" || fail "Download failed. Check your connection and try again."
fetch updater "$TMP/updater.sh" || fail "Download failed. Check your connection and try again."
fetch mini "$TMP/mini.zip" || rm -f "$TMP/mini.zip"
mkdir -p "$HOME_TESS/bin"
rm -rf "$HOME_TESS/bin/patcher"; ditto "$TMP/p" "$HOME_TESS/bin/patcher"
PATCHER="$HOME_TESS/bin/patcher/tess-patcher"
chmod +x "$PATCHER" "$HOME_TESS/bin/patcher/tess-verify"

# --- pause the update helper while we work (it must never run at the same time) --------------------------------------
launchctl bootout "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 || true
mkdir -p "$HOME_TESS"; touch "$HOME_TESS/.installing"

# --- quit Spotify, undo any earlier patching ---------------------------------------------------------------------
WAS_RUNNING=""
if [ -z "$TESS_TEST" ] && pgrep -x Spotify >/dev/null; then
  WAS_RUNNING=1; step "Closing Spotify"
  osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1 || true
  i=0; while pgrep -x Spotify >/dev/null && [ $i -lt 40 ]; do sleep 0.5; i=$((i+1)); done
  pkill -x Spotify 2>/dev/null || true
fi
if [ -d "$SPOTIFY/Contents/Resources/Apps/xpui" ]; then
  # Spotify was already modified (an earlier Tess, or Spicetify): put it back to stock first
  if [ -f "$CONF/config-xpui.ini" ]; then "$PATCHER" config spotify_path "$SPOTIFY/Contents/Resources" >/dev/null 2>&1; "$PATCHER" restore --no-restart >/dev/null 2>&1 || true
  elif [ -z "$TESS_TEST" ] && command -v spicetify >/dev/null 2>&1 && spicetify -c 2>/dev/null | xargs grep -q "spotify_path *= *$SPOTIFY" 2>/dev/null; then step "Spicetify found: restoring stock Spotify first"; spicetify restore >/dev/null 2>&1 || true
  fi
  [ -d "$SPOTIFY/Contents/Resources/Apps/xpui" ] && fail "Spotify has been modified by another tool. Reinstall Spotify from https://www.spotify.com/download/mac/ and run this again."
fi

# --- keep the original interface files, so nothing can be lost ------------------------------------------------------
APPS="$SPOTIFY/Contents/Resources/Apps"
[ -f "$APPS/xpui.spa" ] || fail "Spotify's files look incomplete. Reinstall Spotify from https://www.spotify.com/download/mac/ and run this again."
ORIG="$HOME_TESS/original-$SPV"
rm -rf "$HOME_TESS"/original-*
ditto "$APPS" "$ORIG" || fail "Couldn't make a safety copy of Spotify's files; nothing was changed."
put_back() {
  rm -rf "$APPS"
  ditto "$ORIG" "$APPS"
  rm -f "$HOME_TESS/.installing"
}

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
"$PATCHER" config home_config 0 >/dev/null
rm -rf "$CONF/Backup" 2>/dev/null || true
if ! "$PATCHER" backup apply --no-restart >"$TMP/apply.log" 2>&1; then
  put_back
  if grep -q "operation not permitted" "$TMP/apply.log"; then
    fail "macOS blocked Terminal from updating Spotify. Open System Settings > Privacy & Security > App Management, turn on your terminal app, then run this again."
  fi
  tail -5 "$TMP/apply.log" 2>/dev/null || true
  fail "Couldn't apply Tess to Spotify $SPV. Spotify was put back exactly as it was."
fi
if [ ! -f "$APPS/xpui/index.html" ] || ! grep -q "spicetifyWrapper" "$APPS/xpui/index.html"; then
  put_back
  fail "Tess didn't apply cleanly. Spotify was put back exactly as it was; please report this."
fi
# --- the updater: keeps every part of Tess current from now on, and puts Tess back after Spotify updates --------------
cp "$TMP/updater.sh" "$HOME_TESS/updater.sh"; chmod +x "$HOME_TESS/updater.sh"
{ echo "SPOTIFY='$SPOTIFY'"; [ -n "$TESS_TEST" ] && echo "TESS_CONFIG='$CONF'"; } > "$HOME_TESS/updater.env"
mkdir -p "$HOME_TESS/state"
for n in patcher theme updater mini; do [ "$n" = mini ] && [ ! -s "$TMP/mini.zip" ] && continue; part $n 2 > "$HOME_TESS/state/$n"; done
rm -f "$HOME_TESS/reapply.sh"
rm -f "$HOME_TESS/.installing"

if [ -n "$TESS_TEST" ]; then echo; bold "Test install into $SPOTIFY finished."; exit 0; fi

# --- the helper that runs the updater -----------------------------------------------------------------------------
step "Keeping Tess up to date, and on through Spotify updates"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/music.tess.guard.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.guard</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$HOME_TESS/updater.sh</string></array>
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
  update|repair) curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/install.sh | sh ;;
  uninstall) curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/uninstall.sh | sh ;;
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
