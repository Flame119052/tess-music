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

# --- 1. Spotify updated itself: its files are stock again, so apply Tess -------------------------------------------
if [ -f "$APPS/xpui.spa" ] && [ ! -d "$APPS/xpui" ]; then
  sleep 8
  if [ -f "$APPS/xpui.spa" ] && [ ! -d "$APPS/xpui" ]; then
    log "Spotify updated; re-applying Tess"
    running=$(spotify_running && echo 1)
    if "$PATCHER" backup apply --no-restart >> "$LOG" 2>&1 && [ -d "$APPS/xpui" ]; then
      if [ -n "$running" ]; then
        osascript -e 'tell application "Spotify" to quit' >/dev/null 2>&1
        for i in {1..40}; do pgrep -x Spotify >/dev/null || break; sleep 0.5; done
        open -a "$SPOTIFY"
      fi
    else
      notify "Spotify updated. Run the Tess install line again to bring Tess back."
    fi
  fi
fi

# --- 2. Tess's own parts --------------------------------------------------------------------------------------------
# At most every 20 minutes (TESS_FORCE=1 checks now).
STAMP="$STATE/.checked"
[ -z "$TESS_FORCE" ] && [ -f "$STAMP" ] && [ -z "$(find "$STAMP" -mmin +20 2>/dev/null)" ] && exit 0
touch "$STAMP"
[ -x "$VERIFY" ] || exit 0
CHANNEL="${TESS_PARTS_CHANNEL:-stable}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$LOCK"' EXIT
get() { curl -fsSL --max-time 60 -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/$REPO/contents/dist/$1?ref=$CHANNEL" -o "$2"; }
get components.txt "$TMP/components.txt" && get components.sig "$TMP/components.sig" || exit 0
if ! "$VERIFY" "$TMP/components.txt" "$(tr -d '\n' < "$TMP/components.sig")"; then
  log "parts list failed its signature check; ignored"
  exit 0
fi

# each line: name sha256 url
while read -r name sha url; do
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
      mv "$HOME_TESS/bin/patcher.new" "$HOME_TESS/bin/patcher"; rm -rf "$HOME_TESS/bin/patcher.old" ;;
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
  log "$name: updated"
done < "$TMP/components.txt"
exit 0
