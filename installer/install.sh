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
INBOX="https://tess-music-player.janus.ing"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '  \033[32m●\033[0m %s\n' "$1"; }
PAUSED=""; WAS_RUNNING=""
fail() {
  printf '\n  \033[31m✕\033[0m %s\n\n' "$1"
  report_failure "$1"
  if [ -n "$PAUSED" ]; then
    # leave the Mac as it was found: helper running again, no lock, Spotify open if it was
    rm -f "$HOME_TESS/.installing"
    if [ -z "$TESS_TEST" ]; then
      [ -f "$HOME/Library/LaunchAgents/music.tess.guard.plist" ] && launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.guard.plist" >/dev/null 2>&1
      [ -n "$WAS_RUNNING" ] && open -a "$SPOTIFY" >/dev/null 2>&1
    fi
  fi
  exit 1
}
# When an install fails, a short anonymous report goes to the Tess inbox so the problem can be fixed (no names, no
# paths under your home folder, no account details). Turn reports off before installing: touch the file below.
report_failure() {
  [ -n "$TESS_TEST" ] || [ -f "$HOME_TESS/reports-off" ] && return 0
  command -v /usr/bin/python3 >/dev/null 2>&1 || return 0
  mkdir -p "$HOME_TESS" 2>/dev/null
  [ -f "$HOME_TESS/install-id" ] || od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$HOME_TESS/install-id"
  { echo "install failed: $1"; echo "spotify: ${SPOTIFY:-none}"
    for a in /Applications/Spotify.app "$HOME/Applications/Spotify.app"; do echo "== $a"; ls -la "$a/Contents/Resources/Apps" 2>&1; done
    echo "== running"; ps -axo comm= 2>/dev/null | grep '/Spotify.app/Contents/MacOS/Spotify$'
    echo "== tess"; ls -la "$HOME_TESS" "$HOME/.local/state/tess-patcher/Backup" 2>&1
    command -v spicetify >/dev/null 2>&1 && echo "spicetify is installed"
  } 2>&1 | sed -e "s|$HOME|~|g" -e "s|/Users/$(id -un)|~|g" | /usr/bin/python3 -c '
import json, sys
a = sys.argv
print(json.dumps({"install": a[1], "kind": "install", "spotify": a[2], "macos": a[3], "status": a[4][:300], "body": sys.stdin.read()[-22000:]}))
' "$(cat "$HOME_TESS/install-id")" "${SPV:-}" "${MACOS:-}" "$1" 2>/dev/null \
  | curl -fsS --max-time 20 -H "content-type: application/json" --data-binary @- "$INBOX/v1/report" >/dev/null 2>&1 || true
}
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | head -1)" = "$2" ]; }

echo; bold "Tess Music"; echo

# --- the Mac ---------------------------------------------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || fail "Tess Music runs on macOS."
MACOS=$(sw_vers -productVersion)
step "macOS $MACOS on $(uname -m)"

# --- Spotify -----------------------------------------------------------------------------------------------------
SPOTIFY="${TESS_SPOTIFY:-}"   # TESS_SPOTIFY / TESS_TEST=1 are for testing against a copy of Spotify
if [ -z "$SPOTIFY" ]; then
  # the copy that is running wins; otherwise the first complete one; otherwise the first one found
  RUN=$(ps -axo comm= 2>/dev/null | sed -n 's|^\(.*/Spotify\.app\)/Contents/MacOS/Spotify$|\1|p' | head -1)
  for p in "$RUN" "/Applications/Spotify.app" "$HOME/Applications/Spotify.app"; do
    [ -n "$p" ] && [ -d "$p/Contents/Resources/Apps" ] || continue
    if [ -f "$p/Contents/Resources/Apps/xpui.spa" ] || [ -d "$p/Contents/Resources/Apps/xpui" ]; then SPOTIFY="$p"; break; fi
    [ -n "$SPOTIFY" ] || SPOTIFY="$p"
  done
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

# Spotify's interface must be here (stock, or modified by an earlier Tess), or Tess's own safety copy of it
A0="$SPOTIFY/Contents/Resources/Apps"
[ -f "$A0/xpui.spa" ] || [ -d "$A0/xpui" ] || [ -f "$HOME_TESS/original-$SPV/xpui.spa" ] \
  || fail "Spotify's files at $SPOTIFY look incomplete, so nothing was changed. If Spotify opens normally, it is running from another place: please report this."

# --- download --------------------------------------------------------------------------------------------------
# The signed parts list says which file of each part is current; every download is checked against it.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
step "Downloading Tess"
CH="${TESS_PARTS_CHANNEL:-stable}"
getlist() { curl -fsSL --max-time 60 -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/$REPO/contents/dist/$1?ref=$CH" -o "$TMP/$1" \
  || curl -fsSL --max-time 60 "https://raw.githubusercontent.com/$REPO/$CH/dist/$1" -o "$TMP/$1"; }
getlist components.txt && getlist components.sig || fail "Download failed. Check your connection and try again."
part() { awk -v n="$1" '$1 == n { print $'"$2"' }' "$TMP/components.txt"; }
fetch() { curl -fsSL --retry 2 --connect-timeout 20 --max-time 300 "$(part "$1" 3)" -o "$2" && [ "$(shasum -a 256 "$2" | cut -d' ' -f1)" = "$(part "$1" 2)" ]; }
fetch patcher "$TMP/patcher.tgz" || fail "Download failed. Check your connection and try again."
mkdir -p "$TMP/p" && tar -xzf "$TMP/patcher.tgz" -C "$TMP/p"
"$TMP/p/tess-verify" "$TMP/components.txt" "$(tr -d '\n' < "$TMP/components.sig")" || fail "Tess's download didn't pass its signature check, so nothing was installed."
fetch theme "$TMP/theme.tgz" || fail "Download failed. Check your connection and try again."
fetch updater "$TMP/updater.sh" || fail "Download failed. Check your connection and try again."
fetch mini "$TMP/mini.zip" || rm -f "$TMP/mini.zip"
fetch doctor "$TMP/doctor.sh" || rm -f "$TMP/doctor.sh"
mkdir -p "$HOME_TESS/bin"
rm -rf "$HOME_TESS/bin/patcher"; ditto "$TMP/p" "$HOME_TESS/bin/patcher"
PATCHER="$HOME_TESS/bin/patcher/tess-patcher"
chmod +x "$PATCHER" "$HOME_TESS/bin/patcher/tess-verify"

# --- pause the update helper while we work (it must never run at the same time) --------------------------------------
launchctl bootout "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 || true
mkdir -p "$HOME_TESS"; touch "$HOME_TESS/.installing"; PAUSED=1

# --- quit Spotify, undo any earlier patching ---------------------------------------------------------------------
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
if [ ! -f "$APPS/xpui.spa" ] && [ -f "$HOME_TESS/original-$SPV/xpui.spa" ]; then
  # an earlier Tess kept a copy of this exact Spotify version's own files: put them back
  step "Putting back Spotify's own files from Tess's safety copy"
  rm -rf "$APPS"; ditto "$HOME_TESS/original-$SPV" "$APPS" || fail "Couldn't put Spotify's files back."
fi
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
OLD_MINI=$(cat "$HOME_TESS/state/mini" 2>/dev/null)
for n in patcher theme updater mini doctor; do
  { [ "$n" = mini ] && [ ! -s "$TMP/mini.zip" ]; } || { [ "$n" = doctor ] && [ ! -s "$TMP/doctor.sh" ]; } && continue
  part $n 2 > "$HOME_TESS/state/$n"
done
awk '$1 == "version" { print $2 }' "$TMP/components.txt" > "$HOME_TESS/state/version"
[ -s "$TMP/doctor.sh" ] && cp "$TMP/doctor.sh" "$HOME_TESS/doctor.sh"
[ -f "$HOME_TESS/install-id" ] || od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$HOME_TESS/install-id"
# the rescue line (see rescue.sh): its own copy, which updates never replace
if [ -x "$HOME_TESS/bin/patcher/rescue/tess-rescue-verify" ] && [ ! -x "$HOME_TESS/rescue/tess-rescue-verify" ]; then
  mkdir -p "$HOME_TESS/rescue"; cp "$HOME_TESS/bin/patcher/rescue/"* "$HOME_TESS/rescue/"
  chmod +x "$HOME_TESS/rescue/tess-rescue-verify" "$HOME_TESS/rescue/rescue.sh"
  TESS_HOME="$HOME_TESS" /bin/zsh "$HOME_TESS/rescue/rescue.sh" --adopt >/dev/null 2>&1 || true
fi
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

if [ -x "$HOME_TESS/rescue/rescue.sh" ]; then
cat > "$HOME/Library/LaunchAgents/music.tess.rescue.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.rescue</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$HOME_TESS/rescue/rescue.sh</string></array>
<key>StartInterval</key><integer>21600</integer>
<key>RunAtLoad</key><true/>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.rescue.plist" 2>/dev/null || true
fi

# --- Tess Mini (macOS 13+) ----------------------------------------------------------------------------------------------
# Only replaced when it changed: macOS treats a replaced app as new and shows its "runs in the background" notice again
if [ -s "$TMP/mini.zip" ] && ver_ge "$MACOS" "13.0" && [ "$OLD_MINI" = "$(part mini 2)" ] && [ -d "$HOME/Applications/Tess Mini.app" ] && [ -f "$HOME/Library/LaunchAgents/music.tess.mini.plist" ]; then
  launchctl print "gui/$(id -u)/music.tess.mini" >/dev/null 2>&1 || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.mini.plist" 2>/dev/null || true
elif [ -s "$TMP/mini.zip" ] && ver_ge "$MACOS" "13.0"; then
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
  doctor) /bin/zsh "$HOME/Library/Application Support/Tess/doctor.sh" ;;
  report) /bin/zsh "$HOME/Library/Application Support/Tess/doctor.sh" --report ;;
  reports)
    case "$2" in
      off) touch "$HOME/Library/Application Support/Tess/reports-off"; echo "Health reports are off." ;;
      on) rm -f "$HOME/Library/Application Support/Tess/reports-off"; echo "Health reports are on." ;;
      *) [ -f "$HOME/Library/Application Support/Tess/reports-off" ] && echo "Health reports are off." || echo "Health reports are on. (tess reports off)" ;;
    esac ;;
  *) echo "usage: tess doctor | report | reports on|off | update | repair | uninstall" ;;
esac
EOF
chmod +x "$HOME_TESS/tess"

echo
bold "Tess is installed."
echo "  Spotify opens now. The theme updates itself; Spotify updates are handled for you."
echo "  The first time you open the miniplayer, macOS asks to let Tess Mini control Spotify: choose Allow."
  echo "  To remove it: \"$HOME_TESS/tess\" uninstall      If something looks wrong: \"$HOME_TESS/tess\" doctor"
echo "  Tess sends a small anonymous health report (versions and errors, nothing personal) so problems get fixed."
echo "  To turn that off: \"$HOME_TESS/tess\" reports off"
echo
open -a "$SPOTIFY"
