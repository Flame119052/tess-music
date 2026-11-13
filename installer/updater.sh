#!/bin/zsh
# Tess's background helper. macOS runs it every few minutes and whenever Spotify's files change (LaunchAgent
# music.tess.guard). It does two jobs, and never deletes or restores anything of Spotify's:
#  1. After Spotify updates itself, it puts Tess back.
#  2. It keeps Tess's own parts current: the loader inside Spotify, the patcher, Tess Mini and this script. It reads
#     the signed list of parts for the stable channel, checks the signature and every file's checksum, and only then
#     installs. (The look and features update separately, inside Spotify, every time Spotify starts.)
# It also keeps the doctor (doctor.sh) and the rescue line (rescue/) installed, sends a small daily health report
# and asks the doctor to fix and report whenever something here fails (unless reports are off: tess reports off).
# Settings written by the installer: updater.env (SPOTIFY=...). Log: guard.log.
HOME_TESS="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
[ -f "$HOME_TESS/updater.env" ] && . "$HOME_TESS/updater.env"
[ -n "$TESS_CONFIG" ] && export SPICETIFY_CONFIG="$TESS_CONFIG"
CONF="${TESS_CONFIG:-$HOME/.config/tess-patcher}"
APPS="$SPOTIFY/Contents/Resources/Apps"
PATCHER="$HOME_TESS/bin/patcher/tess-patcher"
VERIFY="$HOME_TESS/bin/patcher/tess-verify"
STATE="$HOME_TESS/state"
LOCK="$HOME_TESS/.installing"
LOG="$HOME_TESS/guard.log"
REPO="Flame119052/tess-music"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
trouble=""
problem() { log "$*"; trouble=1; }
doctor() { [ -f "$HOME_TESS/doctor.sh" ] && /bin/zsh "$HOME_TESS/doctor.sh" "$1" >/dev/null 2>&1; }
notify() { [ -n "$TESS_TEST" ] || osascript -e "display notification \"$1\" with title \"Tess Music\"" >/dev/null 2>&1; }
spotify_running() { [ -z "$TESS_TEST" ] && pgrep -x Spotify >/dev/null; }

[ -n "$SPOTIFY" ] && [ -d "$SPOTIFY" ] || exit 0
[ -e "$LOCK" ] && [ -z "$(find "$LOCK" -mmin +30 2>/dev/null)" ] && exit 0   # another run or the installer is working
touch "$LOCK"; trap 'rm -f "$LOCK"' EXIT
mkdir -p "$STATE"
# Tidy-ups for older installs. This script updates itself, so a change to how Tess is set up on a Mac goes here.
rm -f "$HOME_TESS/reapply.sh"
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 500000 ] && tail -c 250000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
[ -f "$HOME_TESS/install-id" ] || od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$HOME_TESS/install-id"

# The rescue line: installed once from the patcher package, then never replaced by updates (see rescue.sh)
install_rescue() {
  local src="$HOME_TESS/bin/patcher/rescue" dst="$HOME_TESS/rescue" pl="$HOME/Library/LaunchAgents/music.tess.rescue.plist"
  [ -x "$dst/tess-rescue-verify" ] && [ -f "$dst/rescue.sh" ] && { [ -n "$TESS_TEST" ] || [ -f "$pl" ]; } && return 0
  [ -x "$src/tess-rescue-verify" ] && [ -f "$src/rescue.sh" ] || return 0
  mkdir -p "$dst"; cp "$src/tess-rescue-verify" "$src/rescue.sh" "$dst/"; chmod +x "$dst/tess-rescue-verify" "$dst/rescue.sh"
  /bin/zsh "$dst/rescue.sh" --adopt >/dev/null 2>&1   # orders published before this Mac had the rescue line are not run
  [ -n "$TESS_TEST" ] && { log "rescue line installed (test)"; return 0; }
  mkdir -p "$HOME/Library/LaunchAgents"
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict>' '<key>Label</key><string>music.tess.rescue</string>' \
    "<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$dst/rescue.sh</string></array>" \
    '<key>StartInterval</key><integer>21600</integer>' '<key>RunAtLoad</key><true/>' '</dict></plist>' > "$pl"
  launchctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1
  launchctl bootstrap "gui/$(id -u)" "$pl" >/dev/null 2>&1
  log "rescue line installed"
}
install_rescue

# --- 1. Spotify updated itself: its files are stock again, so apply Tess -------------------------------------------
# If this Spotify is too new for the current patcher, Spotify is left exactly as it was (stock, working) and this is
# tried again: every hour, and straight after a newer patcher arrives in step 2. No command is ever needed.
reapply() {
  [ -f "$APPS/xpui.spa" ] && [ ! -d "$APPS/xpui" ] || return 0
  local spv=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$SPOTIFY/Contents/Info.plist" 2>/dev/null)
  local tried="$STATE/.reapply-failed-$spv"
  [ -z "$1" ] && [ -f "$tried" ] && [ -z "$(find "$tried" -mmin +60 2>/dev/null)" ] && return 0
  log "Spotify $spv is stock; applying Tess"
  local bak="$HOME_TESS/.apps-before-reapply"
  rm -rf "$bak"; ditto "$APPS" "$bak" || return 0
  local running=$(spotify_running && echo 1)
  if "$PATCHER" backup apply --no-restart >> "$LOG" 2>&1 && grep -q spicetifyWrapper "$APPS/xpui/index.html" 2>/dev/null; then
    rm -rf "$bak"; find "$STATE" -name ".reapply-failed-*" -delete
    log "Tess applied to Spotify $spv"
    if [ -n "$running" ]; then
      osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1
      for i in {1..40}; do pgrep -x Spotify >/dev/null || break; sleep 0.5; done
      open -a "$SPOTIFY"
    fi
  else
    rm -rf "$APPS"; ditto "$bak" "$APPS"; rm -rf "$bak"
    [ -f "$tried" ] || { notify "Spotify updated to a version Tess doesn't support yet. Spotify works normally; Tess comes back by itself once it's supported."; trouble=1; }
    touch "$tried"
    log "Spotify $spv: Tess couldn't apply yet; Spotify left stock, will retry"
  fi
}
if [ -f "$APPS/xpui.spa" ] && [ ! -d "$APPS/xpui" ]; then sleep 8; reapply; fi
# Spotify's interface missing altogether: the doctor puts it back from Tess's safety copy when it can
[ ! -f "$APPS/xpui.spa" ] && [ ! -d "$APPS/xpui" ] && problem "Spotify's interface files are missing"
[ -n "$trouble" ] && doctor --auto && trouble=""

# a small health report once a day
HB="$STATE/.heartbeat"
if [ ! -f "$HB" ] || [ -n "$(find "$HB" -mmin +1440 2>/dev/null)" ]; then touch "$HB"; doctor --heartbeat; fi

# --- 2. Tess's own parts --------------------------------------------------------------------------------------------
# At most every 20 minutes (TESS_FORCE=1 checks now).
STAMP="$STATE/.checked"
[ -z "$TESS_FORCE" ] && [ -f "$STAMP" ] && [ -z "$(find "$STAMP" -mmin +20 2>/dev/null)" ] && exit 0
touch "$STAMP"
[ -x "$VERIFY" ] || exit 0
CHANNEL="${TESS_PARTS_CHANNEL:-stable}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$LOCK"' EXIT
# GitHub's API is read live but allows 60 reads an hour per network; the raw file address is the fallback
get() { curl -fsSL --max-time 60 -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/$REPO/contents/dist/$1?ref=$CHANNEL" -o "$2" \
  || curl -fsSL --max-time 60 "https://raw.githubusercontent.com/$REPO/$CHANNEL/dist/$1" -o "$2"; }
get components.txt "$TMP/components.txt" && get components.sig "$TMP/components.sig" || exit 0
if ! "$VERIFY" "$TMP/components.txt" "$(tr -d '\n' < "$TMP/components.sig")"; then
  problem "parts list failed its signature check; ignored"; doctor --auto
  exit 0
fi

# each line: name sha256 url source-hash (and one "version X.Y.Z" line)
awk '$1 == "version" { print $2 }' "$TMP/components.txt" > "$STATE/version.new" && [ -s "$STATE/version.new" ] && mv "$STATE/version.new" "$STATE/version"
changed=0
while read -r name sha url _src; do
  [ -n "$name" ] && [ -n "$sha" ] && [ -n "$url" ] || continue
  [ "$(cat "$STATE/$name" 2>/dev/null)" = "$sha" ] && continue
  f="$TMP/$name.dl"
  curl -fsSL --max-time 300 "$url" -o "$f" || { problem "$name: download failed"; continue; }
  [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$sha" ] || { problem "$name: checksum mismatch; ignored"; continue; }
  case "$name" in
    doctor)
      zsh -n "$f" || { problem "doctor: bad file"; continue; }
      cp "$f" "$HOME_TESS/doctor.sh.new" && mv "$HOME_TESS/doctor.sh.new" "$HOME_TESS/doctor.sh" || continue ;;
    updater)
      zsh -n "$f" || { problem "updater: bad file"; continue; }
      cp "$f" "$HOME_TESS/updater.sh.new" && chmod +x "$HOME_TESS/updater.sh.new" && mv "$HOME_TESS/updater.sh.new" "$HOME_TESS/updater.sh" || continue ;;
    patcher)
      rm -rf "$HOME_TESS/bin/patcher.new"; mkdir -p "$HOME_TESS/bin/patcher.new"
      tar -xzf "$f" -C "$HOME_TESS/bin/patcher.new" && [ -x "$HOME_TESS/bin/patcher.new/tess-patcher" ] || { problem "patcher: bad archive"; continue; }
      rm -rf "$HOME_TESS/bin/patcher.old"; mv "$HOME_TESS/bin/patcher" "$HOME_TESS/bin/patcher.old"
      mv "$HOME_TESS/bin/patcher.new" "$HOME_TESS/bin/patcher"; rm -rf "$HOME_TESS/bin/patcher.old"; new_patcher=1; install_rescue ;;
    mini)
      [ -n "$TESS_TEST" ] && { echo "$sha" > "$STATE/$name"; log "mini: updated (test: not installed)"; continue; }
      mkdir -p "$TMP/mini" && ditto -x -k "$f" "$TMP/mini" && [ -d "$TMP/mini/Tess Mini.app" ] || { problem "mini: bad archive"; continue; }
      launchctl bootout "gui/$(id -u)/music.tess.mini" >/dev/null 2>&1
      rm -rf "$HOME/Applications/Tess Mini.app"; ditto "$TMP/mini/Tess Mini.app" "$HOME/Applications/Tess Mini.app"
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.mini.plist" >/dev/null 2>&1 ;;
    theme)
      # the loader Spotify runs; only its two files inside Spotify change, and the old ones come back if anything fails
      [ -d "$APPS/xpui" ] || continue
      mkdir -p "$TMP/theme" && tar -xzf "$f" -C "$TMP/theme" && [ -f "$TMP/theme/Tess/theme.js" ] || { problem "theme: bad archive"; continue; }
      cp "$APPS/xpui/user.css" "$TMP/user.css.bak" 2>/dev/null; cp "$APPS/xpui/extensions/theme.js" "$TMP/theme.js.bak" 2>/dev/null
      rm -rf "$CONF/Themes/Tess.old"; [ -d "$CONF/Themes/Tess" ] && mv "$CONF/Themes/Tess" "$CONF/Themes/Tess.old"
      mkdir -p "$CONF/Themes"; ditto "$TMP/theme/Tess" "$CONF/Themes/Tess"
      if "$PATCHER" refresh >> "$LOG" 2>&1 && grep -q "TESS_BASELINE" "$APPS/xpui/extensions/theme.js"; then
        rm -rf "$CONF/Themes/Tess.old"
      else
        problem "theme: refresh failed; put the previous loader back"
        rm -rf "$CONF/Themes/Tess"; [ -d "$CONF/Themes/Tess.old" ] && mv "$CONF/Themes/Tess.old" "$CONF/Themes/Tess"
        [ -f "$TMP/user.css.bak" ] && cp "$TMP/user.css.bak" "$APPS/xpui/user.css"
        [ -f "$TMP/theme.js.bak" ] && cp "$TMP/theme.js.bak" "$APPS/xpui/extensions/theme.js"
        continue
      fi ;;
    *) continue ;;
  esac
  echo "$sha" > "$STATE/$name"
  log "$name: updated"; changed=$((changed + 1))
done < "$TMP/components.txt"
[ "$changed" -gt 0 ] && log "parts current ($changed updated)"
# a newer patcher may support a Spotify version the old one could not
[ -n "$new_patcher" ] && reapply now
[ -n "$trouble" ] && doctor --auto
exit 0
