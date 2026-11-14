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
report_parts_failure() {
  local stamp="$STATE/.parts-list-reported"
  if [ ! -f "$stamp" ] || [ -n "$(find "$stamp" -mmin +1440 2>/dev/null)" ]; then
    touch "$stamp"
    doctor --report
  fi
}
notify() { [ -n "$TESS_TEST" ] || osascript -e "display notification \"$1\" with title \"Tess Music\"" >/dev/null 2>&1; }
spotify_running() { { [ -n "$TESS_TEST" ] && [ "$TESS_TEST_SPOTIFY_RUNNING" = 1 ]; } || { [ -z "$TESS_TEST" ] && pgrep -x Spotify >/dev/null; }; }
# Playing audio makes macOS hold a sleep assertion for Spotify, usually filed by coreaudiod "Created for PID: <Spotify>".
# pmset needs no permission (osascript would ask every user). macOS awk has no IGNORECASE, so match both cases.
spotify_playing() {
  pids=" $(pgrep -f '/Spotify.app/Contents/' 2>/dev/null | tr '\n' ' ') "
  pmset -g assertions 2>/dev/null | LC_ALL=C awk -v pids="$pids" '
    /Created for PID:/ { n = $0; gsub(/[^0-9]/, "", n); if (n != "" && index(pids, " " n " ")) found = 1 }
    /\(Spotify/ && /[Aa]udio|[Pp]laying/ { found = 1 }
    END { exit !found }'
}
restart_spotify_when_idle() {
  spotify_running || { rm -f "$STATE/.restart-pending"; return 0; }
  if spotify_playing; then
    touch "$STATE/.restart-pending"
    log "Spotify restart deferred while music is playing"
    return 1
  fi
  rm -f "$STATE/.restart-pending"
  [ -n "$TESS_TEST" ] && { log "Spotify restarted (test)"; return 0; }
  pkill -TERM -x Spotify 2>/dev/null || true
  for i in {1..40}; do pgrep -x Spotify >/dev/null || break; sleep 0.5; done
  pgrep -x Spotify >/dev/null && pkill -KILL -x Spotify 2>/dev/null || true
  open -a "$SPOTIFY"
}

[ -n "$SPOTIFY" ] && [ -d "$SPOTIFY" ] || exit 0
[ -e "$LOCK" ] && [ -z "$(find "$LOCK" -mmin +30 2>/dev/null)" ] && exit 0   # another run or the installer is working
touch "$LOCK"; trap 'rm -f "$LOCK"' EXIT
mkdir -p "$STATE"
if [ -f "$STATE/.restart-pending" ]; then restart_spotify_when_idle || true; fi
# Tidy-ups for older installs. This script updates itself, so a change to how Tess is set up on a Mac goes here.
rm -f "$HOME_TESS/reapply.sh"; find "$STATE" -name ".reapply-failed-*" -delete 2>/dev/null
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 500000 ] && tail -c 250000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
[ -f "$HOME_TESS/install-id" ] || od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$HOME_TESS/install-id"

install_guard() {
  local la="$HOME/Library/LaunchAgents" pl
  [ -n "$TESS_TEST" ] && la="$HOME_TESS/LaunchAgents"
  pl="$la/music.tess.guard.plist"
  mkdir -p "$la"
  cat > "$pl.new" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.guard</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$HOME_TESS/updater.sh</string></array>
<key>WatchPaths</key><array><string>$SPOTIFY/Contents/Resources/Apps</string></array>
<key>StartInterval</key><integer>1800</integer>
<key>RunAtLoad</key><true/>
</dict></plist>
EOF
  plutil -lint "$pl.new" >/dev/null 2>&1 || { rm -f "$pl.new"; problem "updater: invalid LaunchAgent"; return 1; }
  local changed=""
  if [ ! -f "$pl" ] || [ "$(shasum -a 256 "$pl.new" | cut -d' ' -f1)" != "$(shasum -a 256 "$pl" | cut -d' ' -f1)" ]; then
    mv "$pl.new" "$pl"; changed=1
  else
    rm -f "$pl.new"
  fi
  [ -n "$TESS_TEST" ] && { log "update agent installed (test)"; return 0; }
  if [ -n "$changed" ]; then
    log "update agent plist set to every 30 minutes; a loaded agent adopts it at next login"
  fi
  launchctl print "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 \
    || launchctl bootstrap "gui/$(id -u)" "$pl" >/dev/null 2>&1
}
install_guard

# Rescue keeps an independent verifier so a broken patcher update cannot disable recovery.
install_rescue() {
  local src="$HOME_TESS/bin/patcher/rescue" dst="$HOME_TESS/rescue" pl="$HOME/Library/LaunchAgents/music.tess.rescue.plist"
  [ -n "$TESS_TEST" ] && pl="$HOME_TESS/LaunchAgents/music.tess.rescue.plist"
  if [ -f "$HOME_TESS/rescue-off" ]; then
    if [ -z "$TESS_TEST" ]; then
      launchctl disable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
      launchctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
    fi
    rm -f "$pl"
    log "rescue line stays off"
    return 0
  fi
  [ -x "$src/tess-rescue-verify" ] && [ -f "$src/rescue.sh" ] || return 0
  # The install notice is the only place a person is told this line exists. Do not add it later on a Mac that was told it is not there.
  if [ ! -f "$dst/rescue.sh" ] && [ ! -f "$STATE/rescue-notice-shown" ]; then
    return 0
  fi
  local fresh=""
  mkdir -p "$dst"
  if [ ! -x "$dst/tess-rescue-verify" ]; then
    cp "$src/tess-rescue-verify" "$dst/tess-rescue-verify"; fresh=1
  fi
  [ -f "$dst/rescue.sh" ] || { cp "$src/rescue.sh" "$dst/rescue.sh"; fresh=1; }
  chmod +x "$dst/tess-rescue-verify" "$dst/rescue.sh"
  [ -n "$fresh" ] && /bin/zsh "$dst/rescue.sh" --adopt >/dev/null 2>&1
  [ -f "$pl" ] && return 0
  mkdir -p "$(dirname "$pl")"
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict>' '<key>Label</key><string>music.tess.rescue</string>' \
    "<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$dst/rescue.sh</string></array>" \
    '<key>StartInterval</key><integer>21600</integer>' '<key>RunAtLoad</key><true/>' '<key>AbandonProcessGroup</key><true/>' '</dict></plist>' > "$pl"
  [ -n "$TESS_TEST" ] && { log "rescue line installed (test)"; return 0; }
  launchctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1
  launchctl bootstrap "gui/$(id -u)" "$pl" >/dev/null 2>&1
  log "rescue line installed"
}
install_rescue

install_wake() {
  local la="$HOME/Library/LaunchAgents" pl
  [ -n "$TESS_TEST" ] && la="$HOME_TESS/LaunchAgents"
  pl="$la/music.tess.wake.plist"
  [ -x "$HOME_TESS/wake.sh" ] && zsh -n "$HOME_TESS/wake.sh" || return 0
  mkdir -p "$la"
  "$HOME_TESS/wake.sh" --plist > "$pl.new" || { rm -f "$pl.new"; return 1; }
  plutil -lint "$pl.new" >/dev/null 2>&1 || { rm -f "$pl.new"; problem "wake: invalid LaunchAgent"; return 1; }
  local changed=""
  if [ ! -f "$pl" ] || [ "$(shasum -a 256 "$pl.new" | cut -d' ' -f1)" != "$(shasum -a 256 "$pl" | cut -d' ' -f1)" ]; then
    mv "$pl.new" "$pl"; changed=1
  else
    rm -f "$pl.new"
  fi
  [ -n "$TESS_TEST" ] && { log "wake agent installed (test)"; return 0; }
  if [ -n "$changed" ]; then
    launchctl bootout "gui/$(id -u)/music.tess.wake" >/dev/null 2>&1
    launchctl bootstrap "gui/$(id -u)" "$pl" >/dev/null 2>&1
    log "wake agent installed"
  else
    launchctl print "gui/$(id -u)/music.tess.wake" >/dev/null 2>&1 \
      || launchctl bootstrap "gui/$(id -u)" "$pl" >/dev/null 2>&1
  fi
}
install_wake

# --- 1. Spotify updated itself: its files are stock again, so apply Tess -------------------------------------------
# Tess is put back only when there is a reason to expect it to work: Spotify's version changed since the last try, a
# newer patcher arrived (step 2), or the user asked (tess repair, or "Try Again" below). Never on a timer, so one
# failure can't turn into a stream of macOS alerts. Before touching anything the patcher asks macOS whether it may
# change Spotify's files at all; if not, Spotify is left exactly as it is (stock, working) and the user is asked once.
SETTINGS_URL="x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles"
asked=""
blocked() {   # macOS's App Management protection stopped the patcher
  problem "Spotify $1: macOS App Management is blocking tess-patcher; Spotify left stock"
  [ -n "$asked" ] && return 0; asked=1
  [ -n "$TESS_TEST" ] && { touch "$STATE/.asked-$1"; return 0; }
  local b=$(osascript -e 'display dialog "Spotify updated, and macOS is stopping Tess from putting its look back. Spotify works normally in the meantime.

To allow it once: in System Settings › Privacy & Security › App Management, turn on tess-patcher." with title "Tess Music" buttons {"Later", "Open Settings"} default button 2 giving up after 900' -e 'button returned of result' 2>/dev/null)
  [ "$b" = "Open Settings" ] || return 0
  open "$SETTINGS_URL"
  b=$(osascript -e 'display dialog "When tess-patcher is turned on, click Try Again." with title "Tess Music" buttons {"Later", "Try Again"} default button 2 giving up after 900' -e 'button returned of result' 2>/dev/null)
  [ "$b" = "Try Again" ] && reapply now
}
# Spotify's interface folder is only ever replaced by switching in a complete copy: the copy is made next to it and
# checked, then two renames swap them, and if anything fails the original stays. Never delete-then-copy: a block
# halfway through that left Spotify with no interface at all (black window). tools/check-safety.sh enforces this.
swap_apps() {
  _new="$APPS.tess-new"; _old="$APPS.tess-old"
  if [ ! -d "$APPS" ] && [ -d "$_old" ]; then mv "$_old" "$APPS" || return 1; fi
  rm -rf "$_new"
  ditto "$1" "$_new" || { rm -rf "$_new"; return 1; }
  [ -s "$_new/xpui.spa" ] || [ -s "$_new/xpui/index.html" ] || { rm -rf "$_new"; return 1; }
  rm -rf "$_old"
  if [ -d "$APPS" ]; then mv "$APPS" "$_old" || { rm -rf "$_new"; return 1; }; fi
  mv "$_new" "$APPS" || { [ -d "$_old" ] && mv "$_old" "$APPS"; rm -rf "$_new"; return 1; }
  rm -rf "$_old"
}
reapply() {
  [ -f "$APPS/xpui.spa" ] && [ ! -d "$APPS/xpui" ] || return 0
  local spv=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$SPOTIFY/Contents/Info.plist" 2>/dev/null)
  local tried="$STATE/.reapply-tried-$spv"
  [ -z "$1" ] && [ -f "$tried" ] && return 0
  local running=$(spotify_running && echo 1)
  if [ -n "$running" ] && spotify_playing; then
    log "Spotify $spv is stock; reapply deferred while music is playing"
    return 0
  fi
  touch "$tried"
  [ -z "$1" ] && sleep 8   # let Spotify's own update finish writing
  "$PATCHER" can-write "$APPS" >/dev/null 2>&1; local cw=$?
  case $cw in
    0) ;;
    3) blocked "$spv"; return 0 ;;
    4) problem "Spotify $spv: its files belong to another user; Spotify left stock"
       notify "Spotify updated, and its files belong to another account on this Mac. Run: tess repair"; return 0 ;;
    *) problem "Spotify $spv: couldn't check whether Tess may change Spotify (code $cw); Spotify left stock"; return 0 ;;
  esac
  log "Spotify $spv is stock; applying Tess"
  local bak="$HOME_TESS/.apps-before-reapply"
  rm -rf "$bak"; ditto "$APPS" "$bak" || return 0
  if "$PATCHER" backup apply --no-restart >> "$LOG" 2>&1 && grep -q spicetifyWrapper "$APPS/xpui/index.html" 2>/dev/null; then
    rm -rf "$bak"; find "$STATE" \( -name ".reapply-*" -o -name ".asked-*" \) -delete
    log "Tess applied to Spotify $spv"
    [ -n "$running" ] && restart_spotify_when_idle || true
  else
    swap_apps "$bak" && rm -rf "$bak"
    notify "Spotify updated to a version Tess doesn't support yet. Spotify works normally; Tess comes back by itself once it's supported."
    trouble=1
    log "Spotify $spv: Tess couldn't apply yet; Spotify left stock (tried again when a newer patcher arrives)"
  fi
}
reapply
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
if ! get components.txt "$TMP/components.txt" || ! get components.sig "$TMP/components.sig"; then
  problem "parts list download failed"
  report_parts_failure
  exit 0
fi
if ! "$VERIFY" "$TMP/components.txt" "$(tr -d '\n' < "$TMP/components.sig")"; then
  problem "parts list failed its signature check; ignored"
  report_parts_failure
  exit 0
fi
rm -f "$STATE/.parts-list-reported"

# each line: name sha256 url source-hash (and one "version X.Y.Z" and one "rev N" line)
rev=$(awk '$1 == "rev" { print $2 }' "$TMP/components.txt")
last=$(cat "$STATE/rev-$CHANNEL" 2>/dev/null); case "$last" in ''|*[!0-9]*) last=0 ;; esac
if [ -z "$rev" ]; then
  # A pre-rev list is only acceptable before this channel has ever installed a rev; otherwise it is a replay.
  [ "$last" -gt 0 ] && { problem "parts list has no rev but $last is installed; ignored"; report_parts_failure; exit 0; }
else
  case "$rev" in *[!0-9]*) problem "parts list has a bad rev; ignored"; report_parts_failure; exit 0 ;; esac
  # correctly signed is not enough: an older list served by a mirror is still a downgrade
  [ "$rev" -ge "$last" ] || { problem "parts list is older than the one already installed ($rev < $last); ignored"; report_parts_failure; exit 0; }
fi
# Only record the version once the list is accepted, so a refused downgrade cannot relabel the install.
awk '$1 == "version" { print $2 }' "$TMP/components.txt" > "$STATE/version.new" && [ -s "$STATE/version.new" ] && mv "$STATE/version.new" "$STATE/version"
part_file() {
  case "$1" in
    command) echo "$HOME_TESS/tess" ;;
    doctor|updater|installer|uninstall|wake) echo "$HOME_TESS/$1.sh" ;;
  esac
}
backup_part() {
  local name=$1 good="$HOME_TESS/$1.last-good" file
  rm -rf "$good"
  case "$name" in
    doctor|updater|installer|uninstall|wake|command)
      file=$(part_file "$name"); [ -f "$file" ] && cp "$file" "$good" ;;
    patcher) [ -d "$HOME_TESS/bin/patcher" ] && ditto "$HOME_TESS/bin/patcher" "$good" ;;
    mini) [ -z "$TESS_TEST" ] && [ -d "$HOME/Applications/Tess Mini.app" ] && ditto "$HOME/Applications/Tess Mini.app" "$good" ;;
    theme)
      mkdir -p "$good"
      [ -d "$CONF/Themes/Tess" ] && ditto "$CONF/Themes/Tess" "$good/Tess"
      [ -d "$APPS" ] && ditto "$APPS" "$good/Apps" ;;
  esac
}
restore_part() {
  local name=$1 good="$HOME_TESS/$1.last-good" file
  case "$name" in
    doctor|updater|installer|uninstall|wake|command)
      file=$(part_file "$name"); [ -f "$good" ] || return 1
      # Write beside it and rename: zsh reads a running script as it goes, so overwriting it in place could run a mix.
      cp "$good" "$file.restore" && chmod +x "$file.restore" && mv -f "$file.restore" "$file"
      if [ "$name" = wake ]; then install_wake; fi ;;
    patcher)
      [ -d "$good" ] || return 1
      rm -rf "$HOME_TESS/bin/patcher"; ditto "$good" "$HOME_TESS/bin/patcher"
      install_rescue ;;
    mini)
      [ -n "$TESS_TEST" ] && return 0
      [ -d "$good" ] || return 1
      rm -rf "$HOME/Applications/Tess Mini.app"; ditto "$good" "$HOME/Applications/Tess Mini.app"
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.mini.plist" >/dev/null 2>&1 ;;
    theme)
      [ -d "$good/Apps" ] || return 1
      rm -rf "$CONF/Themes/Tess"
      [ -d "$good/Tess" ] && ditto "$good/Tess" "$CONF/Themes/Tess"
      swap_apps "$good/Apps" ;;
    *) return 1 ;;
  esac
}
# Existing health problems must not permanently reject an unrelated signed part.
baseline=0
doctor --validate || baseline=$?
changed=0
while read -r name sha url _src; do
  touch "$LOCK"
  [ -n "$name" ] && [ -n "$sha" ] && [ -n "$url" ] || continue
  [ "$(cat "$STATE/$name" 2>/dev/null)" = "$sha" ] && continue
  [ -f "$STATE/bad-$name-$sha" ] && { log "$name: skipped known bad $sha"; continue; }
  f="$TMP/$name.dl"
  curl -fsSL --max-time 300 "$url" -o "$f" || { problem "$name: download failed"; continue; }
  [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$sha" ] || { problem "$name: checksum mismatch; ignored"; continue; }
  backup_part "$name"
  case "$name" in
    wake)
      zsh -n "$f" || { problem "wake: bad file"; continue; }
      cp "$f" "$HOME_TESS/wake.sh.new" && chmod +x "$HOME_TESS/wake.sh.new" && mv "$HOME_TESS/wake.sh.new" "$HOME_TESS/wake.sh" \
        && install_wake || continue ;;
    command)
      sh -n "$f" || { problem "command: bad file"; continue; }
      cp "$f" "$HOME_TESS/tess.new" && chmod +x "$HOME_TESS/tess.new" && mv "$HOME_TESS/tess.new" "$HOME_TESS/tess" || continue ;;
    installer)
      sh -n "$f" || { problem "installer: bad file"; continue; }
      cp "$f" "$HOME_TESS/installer.sh.new" && chmod +x "$HOME_TESS/installer.sh.new" && mv "$HOME_TESS/installer.sh.new" "$HOME_TESS/installer.sh" || continue ;;
    uninstall)
      sh -n "$f" || { problem "uninstall: bad file"; continue; }
      cp "$f" "$HOME_TESS/uninstall.sh.new" && chmod +x "$HOME_TESS/uninstall.sh.new" && mv "$HOME_TESS/uninstall.sh.new" "$HOME_TESS/uninstall.sh" || continue ;;
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
      # Stage a complete Apps folder and switch it in one checked rename, like every other Spotify change.
      [ -d "$APPS/xpui" ] || continue
      mkdir -p "$TMP/theme" && tar -xzf "$f" -C "$TMP/theme" && [ -f "$TMP/theme/Tess/theme.js" ] || { problem "theme: bad archive"; continue; }
      mkdir -p "$TMP/theme-spotify"
      rm -rf "$TMP/theme-spotify/Apps"; ditto "$APPS" "$TMP/theme-spotify/Apps" || { problem "theme: couldn't stage Spotify's files"; continue; }
      # Refresh also generates colors.css and spicetify-config.json; isolate both its config and Spotify target.
      rm -rf "$TMP/theme-config"; ditto "$CONF" "$TMP/theme-config" || continue
      mkdir -p "$TMP/theme-config/Themes"; rm -rf "$TMP/theme-config/Themes/Tess"
      ditto "$TMP/theme/Tess" "$TMP/theme-config/Themes/Tess" || continue
      SPICETIFY_CONFIG="$TMP/theme-config" "$PATCHER" config spotify_path "$TMP/theme-spotify" >/dev/null 2>&1 \
        && SPICETIFY_CONFIG="$TMP/theme-config" "$PATCHER" refresh --no-restart >/dev/null 2>&1 \
        || { problem "theme: staged refresh failed"; continue; }
      grep -q "TESS_BASELINE" "$TMP/theme-spotify/Apps/xpui/extensions/theme.js" || { problem "theme: loader is incomplete"; continue; }
      mkdir -p "$CONF/Themes"; rm -rf "$CONF/Themes/Tess"; ditto "$TMP/theme/Tess" "$CONF/Themes/Tess"
      swap_apps "$TMP/theme-spotify/Apps" || { problem "theme: checked Spotify swap failed"; restore_part theme; continue; } ;;
    *) continue ;;
  esac
  if [ "$name" = doctor ]; then
    # The doctor is the checker. A result from the doctor already on the Mac cannot judge the one just installed.
    baseline=0; doctor --validate || baseline=$?
  elif [ "$baseline" = 0 ] && ! doctor --validate; then
    restore_part "$name" && restored="restored last good" || restored="no last good was available"
    touch "$STATE/bad-$name-$sha"
    problem "$name: doctor rejected $sha; $restored; marked bad"
    doctor --report
    continue
  fi
  echo "$sha" > "$STATE/$name"
  touch "$LOCK"
  log "$name: updated"; changed=$((changed + 1))
done < "$TMP/components.txt"
[ -n "$rev" ] && echo "$rev" > "$STATE/rev-$CHANNEL"
[ "$changed" -gt 0 ] && log "parts current ($changed updated)"
# a newer patcher may support a Spotify version the old one could not
[ -n "$new_patcher" ] && reapply now
[ -n "$trouble" ] && doctor --auto
exit 0
