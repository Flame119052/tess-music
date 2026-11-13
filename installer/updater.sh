#!/bin/zsh
# Tess's background helper. macOS runs it every few minutes and whenever Spotify's files change (LaunchAgent
# music.tess.guard). It does two jobs, and never deletes or restores anything of Spotify's:
#  1. After Spotify updates itself, it puts Tess back.
#  2. It keeps Tess's own parts current: the loader inside Spotify, the patcher, Tess Mini and this script. It reads
#     the signed list of parts for the stable channel, checks the signature and every file's checksum, and only then
#     installs. (The look and features update separately, inside Spotify, every time Spotify starts.)
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
notify() { [ -n "$TESS_TEST" ] || osascript -e "display notification \"$1\" with title \"Tess Music\"" >/dev/null 2>&1; }
spotify_running() { [ -z "$TESS_TEST" ] && pgrep -x Spotify >/dev/null; }

[ -n "$SPOTIFY" ] && [ -d "$SPOTIFY" ] || exit 0
[ -e "$LOCK" ] && [ -z "$(find "$LOCK" -mmin +30 2>/dev/null)" ] && exit 0   # another run or the installer is working
touch "$LOCK"; trap 'rm -f "$LOCK"' EXIT
mkdir -p "$STATE"
# Tidy-ups for older installs. This script updates itself, so a change to how Tess is set up on a Mac goes here.
rm -f "$HOME_TESS/reapply.sh"

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
    [ -f "$tried" ] || notify "Spotify updated to a version Tess doesn't support yet. Spotify works normally; Tess comes back by itself once it's supported."
    touch "$tried"
    log "Spotify $spv: Tess couldn't apply yet; Spotify left stock, will retry"
  fi
}
if [ -f "$APPS/xpui.spa" ] && [ ! -d "$APPS/xpui" ]; then sleep 8; reapply; fi

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
  log "parts list failed its signature check; ignored"
  exit 0
fi

# each line: name sha256 url source-hash
changed=0
while read -r name sha url _src; do
  [ -n "$name" ] && [ -n "$sha" ] && [ -n "$url" ] || continue
  [ "$(cat "$STATE/$name" 2>/dev/null)" = "$sha" ] && continue
  f="$TMP/$name.dl"
  curl -fsSL --max-time 300 "$url" -o "$f" || { log "$name: download failed"; continue; }
  [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$sha" ] || { log "$name: checksum mismatch; ignored"; continue; }
  case "$name" in
    updater)
      cp "$f" "$HOME_TESS/updater.sh.new" && chmod +x "$HOME_TESS/updater.sh.new" && mv "$HOME_TESS/updater.sh.new" "$HOME_TESS/updater.sh" || continue ;;
    patcher)
      rm -rf "$HOME_TESS/bin/patcher.new"; mkdir -p "$HOME_TESS/bin/patcher.new"
      tar -xzf "$f" -C "$HOME_TESS/bin/patcher.new" && [ -x "$HOME_TESS/bin/patcher.new/tess-patcher" ] || { log "patcher: bad archive"; continue; }
      rm -rf "$HOME_TESS/bin/patcher.old"; mv "$HOME_TESS/bin/patcher" "$HOME_TESS/bin/patcher.old"
      mv "$HOME_TESS/bin/patcher.new" "$HOME_TESS/bin/patcher"; rm -rf "$HOME_TESS/bin/patcher.old"; new_patcher=1 ;;
    mini)
      [ -n "$TESS_TEST" ] && { echo "$sha" > "$STATE/$name"; log "mini: updated (test: not installed)"; continue; }
      mkdir -p "$TMP/mini" && ditto -x -k "$f" "$TMP/mini" && [ -d "$TMP/mini/Tess Mini.app" ] || { log "mini: bad archive"; continue; }
      launchctl bootout "gui/$(id -u)/music.tess.mini" >/dev/null 2>&1
      rm -rf "$HOME/Applications/Tess Mini.app"; ditto "$TMP/mini/Tess Mini.app" "$HOME/Applications/Tess Mini.app"
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.mini.plist" >/dev/null 2>&1 ;;
    theme)
      # the loader Spotify runs; only its two files inside Spotify change, and the old ones come back if anything fails
      [ -d "$APPS/xpui" ] || continue
      mkdir -p "$TMP/theme" && tar -xzf "$f" -C "$TMP/theme" && [ -f "$TMP/theme/Tess/theme.js" ] || { log "theme: bad archive"; continue; }
      cp "$APPS/xpui/user.css" "$TMP/user.css.bak" 2>/dev/null; cp "$APPS/xpui/extensions/theme.js" "$TMP/theme.js.bak" 2>/dev/null
      rm -rf "$CONF/Themes/Tess.old"; [ -d "$CONF/Themes/Tess" ] && mv "$CONF/Themes/Tess" "$CONF/Themes/Tess.old"
      mkdir -p "$CONF/Themes"; ditto "$TMP/theme/Tess" "$CONF/Themes/Tess"
      if "$PATCHER" refresh >> "$LOG" 2>&1 && grep -q "TESS_BASELINE" "$APPS/xpui/extensions/theme.js"; then
        rm -rf "$CONF/Themes/Tess.old"
      else
        log "theme: refresh failed; put the previous loader back"
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
exit 0
