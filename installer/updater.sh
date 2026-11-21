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
# >>> tess script guard: keep this block identical in every installer script (issue #107) >>>
# This file used to be able to act on a real Mac when nobody meant it, three ways: being sourced (a shell one-liner
# like `sh -c '. installer/tess-install.sh; …'` ran the whole real installer), having its text handed to a shell to run
# (`sh -c "$(cat installer/tess-install.sh)"`, or `eval` of that text), and being run from a git checkout, whose copy is
# for developing and for sandboxed tests, not for a real install. All three stop here, before anything is read,
# downloaded or changed. The published `curl … | sh` line is none of them: that shell reads the pipe as its own script,
# so it starts with no `-c` and no file to resolve.
_tess_sourced=""
_tess_embedded=""
if [ -n "${ZSH_VERSION-}" ]; then
  # zsh says where it is evaluating: a sourced file ends in ":file", `zsh -c …` and `eval` begin with "cmdarg", and a
  # script run as its own command is exactly "toplevel".
  case ${ZSH_EVAL_CONTEXT-} in
    *:file) _tess_sourced=1 ;;
    cmdarg|cmdarg:*|eval|eval:*|*:eval|*:eval:*) _tess_embedded=1 ;;
  esac
else
  # sh/bash puts a `c` in $- only when the commands were given to the shell as an argument (`sh -c …`), and `return`
  # works in a subshell only when this file was sourced.
  case $- in *c*) _tess_embedded=1 ;; esac
  if (return 0 2>/dev/null); then _tess_sourced=1; fi
fi
# A shell that kept the `-c` out of $- still shows it in its own command line. Only the argument list is compared: a
# piped script's is just "/bin/sh", so the published install line is left alone.
case "$(ps -o args= -p $$ 2>/dev/null) " in *" -c "*) _tess_embedded=1 ;; esac
if [ -n "$_tess_sourced" ]; then
  echo "Tess: this file was sourced, so it did nothing. Tess's installer, updater, doctor, rescue line and uninstaller act only when they are run as their own command, so sourcing one can never install, update, repair or remove anything." >&2
  echo "Tess: run it as its own command (sh ./file or zsh ./file), or use Tess's published install line." >&2
  return 1
fi
if [ -n "$_tess_embedded" ] && [ -z "${TESS_TEST-}" ] && [ "${TESS_REAL_INSTALL-}" != 1 ]; then
  echo "Tess: not run. This file's text was handed to a shell to run, as in sh -c \"...\" or eval, so the file itself is not what runs and its own checks cannot see it. Tess's installer, updater, doctor, rescue line and uninstaller act only when they are run as their own command." >&2
  echo "Tess: run it as its own command (sh ./file or zsh ./file), or use Tess's published install line; TESS_REAL_INSTALL=1 is the deliberate way through." >&2
  exit 1
fi
unset _tess_sourced _tess_embedded
# A development copy sits inside a git checkout or worktree (a .git folder or file somewhere above it). Outside a
# sandbox it must not act on a real Mac: it is not the installed copy, and its parts are not the signed ones users get.
# TESS_TEST=1 is the sandbox (AGENTS.md rule 2); TESS_REAL_INSTALL=1 is a person deliberately letting this exact copy act.
# zsh makes $0 the function's own name inside a function, so the path is taken once, here.
_tess_self=$0
# The home folder can be a symlink (`/tmp` is `/private/tmp`; a sandbox often is), so compare its real path as well.
_tess_home=$(CDPATH= cd -P -- "$HOME" 2>/dev/null && pwd -P) || _tess_home=$HOME
tess_guard_checkout() {
  _tg=$_tess_self
  case $_tg in
    */*) ;;
    # `cd installer && sh tess-install.sh` names no folder, so the folder is the current one. A piped copy
    # (`curl … | sh`) names the shell itself, not a file here, so it takes the branch above and the walk starts outside
    # any checkout: the pipe is allowed by that, not by this branch.
    *) [ -f "./$_tg" ] || return 1; _tg="./$_tg" ;;
  esac
  _tg=$(CDPATH= cd -P -- "$(dirname -- "$_tg")" 2>/dev/null && pwd -P) || return 1
  while [ -n "$_tg" ] && [ "$_tg" != "/" ]; do
    # A dotfiles repository in the home folder (`git init` in ~) is not a copy of Tess.
    [ "$_tg" = "$HOME" ] && return 1
    [ "$_tg" = "$_tess_home" ] && return 1
    [ -e "$_tg/.git" ] && return 0
    _tg=$(dirname -- "$_tg")
  done
  return 1
}
if [ -z "${TESS_TEST-}" ] && [ "${TESS_REAL_INSTALL-}" != 1 ] && tess_guard_checkout; then
  echo "Tess: not run. This copy ($_tg) is inside a git checkout, and a checkout's copy is for developing and for sandboxed tests, not for changing a real Mac." >&2
  echo "Tess: use Tess's published install line, or set TESS_REAL_INSTALL=1 if you really do mean to let this checkout act on this Mac." >&2
  exit 1
fi
# <<< tess script guard <<<
HOME_TESS="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
[ -f "$HOME_TESS/updater.env" ] && . "$HOME_TESS/updater.env"
[ -n "$TESS_CONFIG" ] && export SPICETIFY_CONFIG="$TESS_CONFIG"
CONF="${TESS_CONFIG:-$HOME/.config/tess-patcher}"
APPS="$SPOTIFY/Contents/Resources/Apps"
PATCHER="$HOME_TESS/bin/patcher/tess-patcher"
VERIFY="$HOME_TESS/bin/patcher/tess-verify"
STATE="$HOME_TESS/state"
LOCK="$HOME_TESS/.installing"
# The invite dialog has a lock of its own: it can wait 15 minutes, and the update lock above must never be held that long.
SLOCK="$STATE/.support-invite.lock"
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
# Values Tess stores or hands to another program are escaped where they are written: a folder called "Tom & Jerry"
# still produces a launchd file macOS can read, and a Spotify version in a notification cannot end the AppleScript string.
xml_esc() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
as_esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
notify() { [ -n "$TESS_TEST" ] || osascript -e "display notification \"$(as_esc "$1")\" with title \"Tess Music\"" >/dev/null 2>&1; }
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
  local updater_xml=$(xml_esc "$HOME_TESS/updater.sh") apps_xml=$(xml_esc "$SPOTIFY/Contents/Resources/Apps")
  cat > "$pl.new" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.guard</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$updater_xml</string></array>
<key>WatchPaths</key><array><string>$apps_xml</string></array>
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

# D-93: the line is already on this Mac and rescue-notice-shown is absent, so this person was never told.
# Pop the notice up once. A test run skips that and leaves the marker for `tess status`.
mark_rescue_notice() { # <rescue.sh>
  [ -f "$1" ] || return 0
  [ -f "$STATE/rescue-notice-shown" ] && return 0
  mkdir -p "$STATE"
  touch "$STATE/rescue-notice-pending"
  [ -n "$TESS_TEST" ] && return 0
  local _note=0
  if ! grep -q 'grep -qx "tess-rescue 2"' "$1"; then
    notify "This Mac has an older Tess rescue line: orders signed by the owner's offline rescue key can run any script on this Mac as you, without asking." || _note=1
  else
    notify "Tess's maintainer can remotely run five Tess actions on this Mac, without asking: check, update, repair, restore Spotify, or uninstall Tess." || _note=1
  fi
  # A popup that did not run stays pending, so `tess status` can still say it.
  [ "$_note" -eq 0 ] || return 0
  rm -f "$STATE/rescue-notice-pending"
  touch "$STATE/rescue-notice-shown"
}

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
  [ -x "$src/tess-rescue-verify" ] && [ -f "$src/rescue.sh" ] || { mark_rescue_notice "$dst/rescue.sh"; return 0; }
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
  # A Mac that already has the line, and was never told, is told once. One that was already told is not told again.
  mark_rescue_notice "$dst/rescue.sh"
  [ -f "$pl" ] && return 0
  mkdir -p "$(dirname "$pl")"
  local rescue_xml=$(xml_esc "$dst/rescue.sh")
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict>' '<key>Label</key><string>music.tess.rescue</string>' \
    "<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$rescue_xml</string></array>" \
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
# halfway through that left Spotify with no interface at all (black window). The copy and the swap run inside
# tess-patcher, not in this script: macOS's App Management protection denies /usr/bin/ditto when launchd starts a
# script under /bin/zsh, so a shell copy in the background could never update Spotify. tools/check-safety.sh enforces it.
swap_apps() {
  [ -x "$PATCHER" ] || { log "Spotify swap: tess-patcher is missing; Spotify left as it was"; return 1; }
  "$PATCHER" swap-apps "$APPS" "$1" >> "$LOG" 2>&1
  local rc=$?
  case $rc in
    0) return 0 ;;
    3) log "Spotify swap: macOS App Management is blocking tess-patcher; Spotify left as it was" ;;
    4) log "Spotify swap: Spotify's files belong to another user; Spotify left as it was" ;;
    *) log "Spotify swap: tess-patcher couldn't switch the folder (code $rc); Spotify left as it was" ;;
  esac
  return 1
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
      [ -f "$HOME_TESS/installer.sh" ] && [ -f "$HOME_TESS/uninstall.sh" ] || { problem "command: waiting for installer/uninstall parts"; continue; }
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

# Every Spotify repair happens here, while the main lock is still held. The invite check below drops that lock, so
# nothing after this point may ask the doctor to repair Spotify.
[ -n "$trouble" ] && doctor --auto

# --- 3. A private Tess Support invite (issue #137) ----------------------------------------------------------------
# Krish invites one Mac by its 32-hex install id (`tools/reports.mjs support invite add …`, run on his Mac). Nothing about Tess
# Support is downloaded, shown or even mentioned unless this Mac was invited, and the check answers only yes or no.
# A yes asks once, in the person's own words; Not now is remembered for that invite for good, and a dialog nobody was
# there to answer is not a decision, so it asks again next time.
#
# The invite is not spent until the signed installer has passed the verifier: a failed download or a bad signature
# costs nothing. The token is minted by the inbox at claim time and only ever reaches the installer through its
# environment, never a command line, and it is gone before anything else runs. This function never reads or writes
# Spotify, so tools/check-safety.sh's rule about Spotify's folder is untouched by it.
#
# For the same reason every failure below is logged with `log`, never `problem`: `problem` sets trouble, which asks the
# doctor to repair Spotify, and nothing on this path ever touched Spotify.
#
# Runs inside the 20-minute parts check above (which is where TESS_FORCE=1 already lands), so it asks no more often.
SUPPORT_INBOX="https://tess-music-player.janus.ing"
# A sandbox may point the check at its own fake; a real Mac always uses the one inbox, so an env var cannot send a
# person's invite elsewhere.
[ -n "$TESS_TEST" ] && [ -n "${TESS_INBOX:-}" ] && SUPPORT_INBOX=$TESS_INBOX
# A sandbox keeps its support profile inside its own folder (TESS_TEST only); a real Mac always uses ~/.hermes, so a
# stray environment variable can neither offer Tess Support again nor hide it.
SUPPORT_CONFIG="$HOME/.hermes/profiles/tess-support/config.yaml"
[ -n "$TESS_TEST" ] && [ -n "${TESS_SUPPORT_CONFIG:-}" ] && SUPPORT_CONFIG=$TESS_SUPPORT_CONFIG

# What the person clicked: install, decline, or nothing at all. A timeout (or a dialog that could not be shown) is not
# an answer, so the invite asks again the next time someone is at the Mac.
support_ask() {
  if [ -n "$TESS_TEST" ]; then
    # Hold the dialog open, as a person who walked away would, so a test can prove nothing else on the Mac waits on it.
    [ -n "${TESS_TEST_INVITE_WAIT:-}" ] && sleep "$TESS_TEST_INVITE_WAIT"
    case "${TESS_TEST_INVITE_ANSWER:-}" in
      install|decline) printf '%s\n' "$TESS_TEST_INVITE_ANSWER" ;;
    esac
    return 0
  fi
  local res
  res=$(osascript -e 'display dialog "Krish invited you to Tess Support — a private helper in your Dock that can check Spotify and send him a bug note when something looks off. Nothing runs unless you open it.

Install Tess Support?" with title "Tess Music" buttons {"Not now", "Install"} default button 2 giving up after 900' 2>/dev/null) || res=""
  case "$res" in
    *"gave up:true"*) return 0 ;;                        # they were not there; ask again next check
    *"button returned:Install"*) printf '%s\n' install ;;
    *"button returned:Not now"*) printf '%s\n' decline ;;
  esac
  return 0
}

# Once it is installed, say what it is and offer to open it. This is the only place a person is told it is a thing.
support_welcome() {
  local app="$HOME/Applications/Tess Support.app"
  if [ -n "$TESS_TEST" ]; then
    [ "${TESS_TEST_WELCOME_ANSWER:-}" = open ] && open "$app" >/dev/null 2>&1
    return 0
  fi
  local res
  res=$(osascript -e 'display dialog "Tess Support is now in your Dock.

Click Tess Support anytime something in Spotify looks off — it can run a quick check, ask before taking a screenshot, and send Krish a note. Nothing runs unless you open it." with title "Tess Music" buttons {"Done", "Open Tess Support"} default button 1 giving up after 900' 2>/dev/null) || res=""
  case "$res" in
    *"button returned:Open Tess Support"*) [ -d "$app" ] && open "$app" >/dev/null 2>&1 ;;
  esac
  return 0
}

check_support_invite() {
  [ -x "$VERIFY" ] || return 0
  # They already have it: never mention it, never ask again.
  [ -f "$SUPPORT_CONFIG" ] && return 0
  # A dialog can wait 15 minutes, and the install runs after it. Nothing below touches Spotify, so the main lock —
  # the one that holds off wake.sh, the installer and every other update — is dropped here. A lock of its own keeps
  # two invite dialogs from ever opening at once without ever standing in the way of an update.
  rm -f "$LOCK"
  # A run killed mid-dialog leaves the folder behind; an hour is longer than any dialog plus install.
  [ -d "$SLOCK" ] && [ -n "$(find "$SLOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ] && rmdir "$SLOCK" 2>/dev/null
  mkdir "$SLOCK" 2>/dev/null || return 0
  trap 'rm -rf "$TMP"; rm -f "$LOCK"; rmdir "$SLOCK" 2>/dev/null' EXIT
  local iid invited invite_id body tok rc code claim
  iid=$(tr -d '[:space:]' < "$HOME_TESS/install-id" 2>/dev/null) || iid=""
  # A report id is 32 lowercase hex characters; anything else is not an id this Mac can be invited by.
  case "$iid" in ''|*[!0-9a-f]*) return 0 ;; esac
  [ ${#iid} -eq 32 ] || return 0
  curl -fsS --max-time 30 -H "content-type: application/json" --data-binary "{\"install\":\"$iid\"}" \
    "$SUPPORT_INBOX/v1/support/invite/check" -o "$TMP/invite-check.json" 2>/dev/null \
    || { log "support invite: check failed"; return 0; }
  body=$(cat "$TMP/invite-check.json" 2>/dev/null) || body=""
  invited=$(printf '%s' "$body" | sed -n 's/.*"invited"[[:space:]]*:[[:space:]]*true.*/1/p')
  [ "$invited" = 1 ] || return 0
  invite_id=$(printf '%s' "$body" | sed -n 's/.*"invite_id"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  case "$invite_id" in ''|*[!0-9]*) return 0 ;; esac
  [ -f "$STATE/.support-invite-asked-$invite_id" ] && return 0
  case "$(support_ask)" in
    decline) touch "$STATE/.support-invite-asked-$invite_id"; log "support invite $invite_id: not now"; return 0 ;;
    install) ;;
    *) return 0 ;;   # nobody answered: ask again next time, and do not spend the invite
  esac
  # Signed first, claimed second: a bad download or a bad signature must not use up the invite.
  if ! get support-install.sh "$TMP/support-install.sh" || ! get support-install.sig "$TMP/support-install.sig"; then
    log "support invite $invite_id: installer download failed"
    return 0
  fi
  if ! "$VERIFY" "$TMP/support-install.sh" "$(tr -d '\n' < "$TMP/support-install.sig")"; then
    log "support invite $invite_id: installer failed its signature check; nothing was installed"
    return 0
  fi
  notify "Installing Tess Support… this takes about a minute."
  # The status code, not -f, decides what happened: a 404 is a spent invite, while a 429/503 or a dropped connection is
  # a temporary miss. The reply body goes to a private temp file (it may hold the token) and is never logged.
  claim="$TMP/invite-claim.json"
  : > "$claim"; chmod 600 "$claim" 2>/dev/null
  code=$(curl -sS --max-time 30 -H "content-type: application/json" \
    --data-binary "{\"install\":\"$iid\",\"invite_id\":$invite_id}" \
    -o "$claim" -w '%{http_code}' "$SUPPORT_INBOX/v1/support/invite/claim" 2>/dev/null) || code=""
  case "$code" in
    200) ;;
    404)
      # Spent, expired, revoked, or not this Mac's: the invite is gone, so never ask about it again.
      touch "$STATE/.support-invite-asked-$invite_id"
      log "support invite $invite_id: the invite is no longer open (spent, expired or revoked); not asking again"
      rm -f "$claim"; return 0 ;;
    *)
      # 429, a 5xx, or no answer at all: temporary. The invite is still open, so keep it and ask again next check.
      log "support invite $invite_id: the invite could not be claimed (HTTP ${code:-none})"
      rm -f "$claim"; return 0 ;;
  esac
  body=$(cat "$claim" 2>/dev/null) || body=""
  rm -f "$claim"
  tok=$(printf '%s' "$body" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\(tess_[0-9a-f]*\)".*/\1/p')
  body=""
  case "$tok" in tess_*) ;; *) tok="" ;; esac
  if [ ${#tok} -lt 20 ]; then
    # A 200 with no token is a broken reply, but the invite may have been spent on the other side: never ask again.
    touch "$STATE/.support-invite-asked-$invite_id"
    log "support invite $invite_id: the inbox answered without a token; not asking again"
    return 0
  fi
  # The token is in this one command's environment and nowhere else: not argv (which any process can read), not the
  # log, not the shell it came from. The installer copies it out and unsets it itself.
  TESS_SUPPORT_TOKEN="$tok" sh "$TMP/support-install.sh" >> "$LOG" 2>&1
  rc=$?
  tok=""
  touch "$STATE/.support-invite-asked-$invite_id"
  if [ "$rc" -eq 0 ]; then
    log "support installed"
    support_welcome
  else
    # Not "nothing was changed": the installer runs one step at a time and may have finished some of them.
    log "support invite $invite_id: installer exited $rc"
    notify "Tess Support couldn't finish installing; some files may have been partially set up. Run the uninstall command or ask Krish."
  fi
  return 0
}
check_support_invite

exit 0
