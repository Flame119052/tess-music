#!/bin/sh
# Tess Music installer for macOS.
# Installs Tess into the Spotify desktop app, a helper that re-applies it after Spotify updates, and Tess Mini.
# Nothing else to set up; run it again any time to repair. Remove with: ~/Library/Application\ Support/Tess/tess uninstall
# >>> tess script guard: keep this block identical in every installer script (issue #107) >>>
# This file used to be able to act on a real Mac when nobody meant it, twice over: being sourced (a shell one-liner
# like `sh -c '. installer/tess-install.sh; …'` ran the whole real installer), and being run from a git checkout, whose
# copy is for developing and for sandboxed tests, not for a real install. Both stop here, before anything is read,
# downloaded or changed.
_tess_sourced=""
if [ -n "${ZSH_EVAL_CONTEXT-}" ]; then
  # zsh says where it is evaluating: a sourced file ends in ":file", a script run as its own command is "toplevel".
  case $ZSH_EVAL_CONTEXT in *:file) _tess_sourced=1 ;; esac
elif (return 0 2>/dev/null); then
  # sh/bash: `return` works only in a sourced file, so this subshell succeeds only when this file was sourced.
  _tess_sourced=1
fi
if [ -n "$_tess_sourced" ]; then
  echo "Tess: this file was sourced, so it did nothing. Tess's installer, updater, doctor, rescue line and uninstaller act only when they are run as their own command, so sourcing one can never install, update, repair or remove anything." >&2
  echo "Tess: run it as its own command (sh <file> or zsh <file>), or use Tess's published install line." >&2
  return 1
fi
unset _tess_sourced
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
    # `cd installer && sh tess-install.sh` names no folder; a piped copy (`curl … | sh`) names only "sh" and uses the
    # code from the pipe, so it is not a checkout's file and is left alone.
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
if [ -z "${TESS_TEST-}" ] && [ -z "${TESS_REAL_INSTALL-}" ] && tess_guard_checkout; then
  echo "Tess: not run. This copy ($_tg) is inside a git checkout, and a checkout's copy is for developing and for sandboxed tests, not for changing a real Mac." >&2
  echo "Tess: use Tess's published install line, or set TESS_REAL_INSTALL=1 if you really do mean to let this checkout act on this Mac." >&2
  exit 1
fi
# <<< tess script guard <<<
set -e

REPO="Flame119052/tess-music"
# The install stub passes the verifier it already downloaded and checked; absent only when this file is run by hand.
VERIFY="${TESS_VERIFY:-}"
DIST="${TESS_DIST_BASE:-https://raw.githubusercontent.com/$REPO}"
HOME_TESS="$HOME/Library/Application Support/Tess"
CONF="$HOME/.config/tess-patcher"
if [ -n "$TESS_TEST" ]; then
  # a test install must not touch the real Tess: its own folders, its own patcher settings, a copy of Spotify
  [ -n "$TESS_HOME" ] && [ -n "$TESS_CONFIG" ] && [ -n "$TESS_SPOTIFY" ] || { echo "TESS_TEST needs TESS_HOME, TESS_CONFIG and TESS_SPOTIFY"; exit 1; }
  HOME_TESS="$TESS_HOME"; CONF="$TESS_CONFIG"
  export SPICETIFY_CONFIG="$TESS_CONFIG" SPICETIFY_STATE="$TESS_CONFIG/state"
fi
# A launchd label is per user. A sandbox must not call /bin/launchctl, which is the owner's real job.
real_launchctl() { [ -n "$TESS_TEST" ] && [ "$(command -v launchctl)" = /bin/launchctl ]; }
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
# JSON string from stdin, with only what every Mac has (awk)
jstr() { awk 'BEGIN { ORS = ""; print "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, ""); gsub(/[\001-\037]/, ""); print $0 "\\n" } END { print "\"" }'; }
# The one privacy filter every report path uses; installer/redact.sh is the copy of record and tools/check-safety.sh
# fails if this copy drifts. Do not edit it here: edit redact.sh and copy the function across.
tess_redact() {
  _rh="$HOME"
  # `|| true` because the installer runs under set -e and a missing scutil must not stop a report
  _ru=$(id -un 2>/dev/null || true)
  _rc=$(scutil --get ComputerName 2>/dev/null || true)
  _rl=$(scutil --get LocalHostName 2>/dev/null || true)
  LC_ALL=C awk -v home="$_rh" -v acct="$_ru" -v host="$_rc" -v lhost="$_rl" '
    # Literal replacement. sed and gsub would read a path containing . or & as a pattern, or a & in the replacement.
    function lit(s, from, to,   out, p) {
      if (from == "") return s
      out = ""
      while ((p = index(s, from)) > 0) { out = out substr(s, 1, p - 1) to; s = substr(s, p + length(from)) }
      return out s
    }
    # A bare account name means a person only where no letter or digit touches it, so "mac" cannot turn "macOS" into
    # "userOS" and a file called "sam.jones.bak" is still replaced.
    function word(s, w, to,   out, p, b, a) {
      if (w == "") return s
      out = ""
      while ((p = index(s, w)) > 0) {
        b = (p > 1) ? substr(s, p - 1, 1) : ""
        a = substr(s, p + length(w), 1)
        if (b ~ /[A-Za-z0-9]/ || a ~ /[A-Za-z0-9]/) { out = out substr(s, 1, p); s = substr(s, p + 1) }
        else { out = out substr(s, 1, p - 1) to; s = substr(s, p + length(w)) }
      }
      return out s
    }
    {
      line = $0
      # a home folder of any account on the Mac, including one whose name starts like this one
      while (match(line, /\/Users\/[A-Za-z0-9._-]+/)) line = substr(line, 1, RSTART - 1) "~" substr(line, RSTART + RLENGTH)
      line = lit(line, home, "~")
      gsub(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "(email)", line)
      line = lit(line, host, "this-mac")
      line = lit(line, lhost, "this-mac")
      if (length(acct) >= 3) line = word(line, acct, "user")
      print line
    }'
}
report_failure() {
  [ -n "$TESS_TEST" ] || [ -f "$HOME_TESS/reports-off" ] && return 0
  mkdir -p "$HOME_TESS" 2>/dev/null
  [ -f "$HOME_TESS/install-id" ] || od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$HOME_TESS/install-id"
  body=$({ echo "install failed: $1"; echo "spotify: ${SPOTIFY:-none}"
    for a in /Applications/Spotify.app "$HOME/Applications/Spotify.app"; do echo "== $a"; ls -la "$a/Contents/Resources" "$a/Contents/Resources/Apps" 2>&1 | head -60; done
    echo "== running"; ps -axo comm= 2>/dev/null | grep '/Spotify.app/Contents/MacOS/Spotify$'
    echo "== tess"; ls -la "$HOME_TESS" "$HOME/.local/state/tess-patcher/Backup" "$HOME/.local/state/spicetify/Backup" 2>&1
    grep -h "^version" "$HOME/.config/tess-patcher/config-xpui.ini" "$HOME/.config/spicetify/config-xpui.ini" 2>/dev/null
    command -v spicetify >/dev/null 2>&1 && echo "spicetify is installed"
  } 2>&1 | tess_redact | tail -c 20000 | jstr)
  st=$(printf '%s' "$1" | cut -c1-300 | jstr)
  printf '{"install":"%s","kind":"install","spotify":"%s","macos":"%s","status":%s,"body":%s}' \
    "$(cat "$HOME_TESS/install-id")" "${SPV:-}" "${MACOS:-}" "$st" "$body" \
    | curl -fsS --max-time 20 -H "content-type: application/json" --data-binary @- "$INBOX/v1/report" >/dev/null 2>&1 || true
}
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | head -1)" = "$2" ]; }
# Values Tess stores for a later run are quoted and escaped where they are written, so a folder called "Sam's Apps"
# or "Tom & Jerry" is stored exactly and cannot run anything when the helper reads the file back.
env_line() {  # KEY value -> one line a POSIX shell reads back with `.`
  printf '%s=%s\n' "$1" "$2" | LC_ALL=C awk '{
    eq = index($0, "="); k = substr($0, 1, eq - 1); v = substr($0, eq + 1)
    gsub(/\047/, "\047\\\047\047", v)
    print k "=\047" v "\047"
  }'
}
xml_esc() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
# sudo needs a terminal for its prompt. A sandbox has none, and must not be given the real one.
run_sudo() { if [ -n "$TESS_TEST" ]; then sudo "$@"; else sudo "$@" </dev/tty; fi; }
# Playing audio makes macOS hold a sleep assertion for Spotify, usually filed by coreaudiod "Created for PID: <Spotify>".
# pmset needs no permission (osascript would ask every user). macOS awk has no IGNORECASE, so match both cases.
spotify_playing() {
  pids=" $(pgrep -f '/Spotify.app/Contents/' 2>/dev/null | tr '\n' ' ') "
  pmset -g assertions 2>/dev/null | LC_ALL=C awk -v pids="$pids" '
    /Created for PID:/ { n = $0; gsub(/[^0-9]/, "", n); if (n != "" && index(pids, " " n " ")) found = 1 }
    /\(Spotify/ && /[Aa]udio|[Pp]laying/ { found = 1 }
    END { exit !found }'
}
wait_for_idle() {
  # Someone running the install line in Terminal wants it now; background repairs wait, but at most 12 minutes, which
  # stays under a default rescue order's 30-minute limit so a repair order is not stopped half-way.
  [ -t 1 ] && return 0
  waiting=""; i=0
  while spotify_playing && [ $i -lt ${TESS_IDLE_WAIT_TRIES:-48} ]; do
    i=$((i+1))
    [ -n "$waiting" ] || { step "Waiting for the current song to stop before restarting Spotify…"; waiting=1; }
    [ -e "$HOME_TESS/.installing" ] && touch "$HOME_TESS/.installing"
    sleep 15
  done
}

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
    [ -n "$p" ] && [ -d "$p/Contents/MacOS" ] || continue
    if [ -f "$p/Contents/Resources/Apps/xpui.spa" ] || [ -d "$p/Contents/Resources/Apps/xpui" ]; then SPOTIFY="$p"; break; fi
    [ -n "$SPOTIFY" ] || SPOTIFY="$p"
  done
fi
[ -n "$SPOTIFY" ] || fail "Spotify isn't installed. Get the desktop app from https://www.spotify.com/download/mac/ , open it once and sign in, then run this again."
# The path is stored for the helper to read later and written into launchd files, so it is checked before it is used:
# absolute (a relative path means the helper reads it from wherever launchd starts), no line break (the settings file
# holds one value per line), and a real Spotify bundle.
case "$SPOTIFY" in /*) ;; *) fail "Tess needs Spotify's full path, and found \"$SPOTIFY\"." ;; esac
[ "$(printf '%s' "$SPOTIFY" | wc -l | tr -d ' ')" -eq 0 ] \
  || fail "Spotify's folder name has a line break in it, which Tess can't save. Move Spotify somewhere else and run this again."
[ -d "$SPOTIFY/Contents/MacOS" ] && [ -f "$SPOTIFY/Contents/Info.plist" ] \
  || fail "\"$SPOTIFY\" isn't a Spotify app, so nothing was changed."
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
# The bundle Tess is about to take ownership of must be Spotify's own app. A folder called Spotify.app that is not is
# refused: asking for a password and then running chown -R as root on an unchecked path is not something Tess does.
spotify_is_spotifys_own() {
  [ "$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$1/Contents/Info.plist" 2>/dev/null)" = "com.spotify.client" ] || return 1
  codesign --verify --strict "$1" >/dev/null 2>&1 || return 1
  # The team is tested against the signature itself, by asking codesign to check a requirement, never by searching text
  # it prints: `codesign -dvvv` echoes `Executable=<path>`, so a folder name with a newline in it could add a line of its
  # own that reads `TeamIdentifier=...`. Resources are skipped here because the seal was checked on the line above and
  # Tess itself rewrites Spotify's interface files. 2FNC3A47ZF is Spotify AB's team; spctl accepts any notarized app, so
  # this requirement is the check that names Spotify.
  codesign --verify --strict --ignore-resources -R='anchor apple generic and certificate leaf[subject.OU] = "2FNC3A47ZF"' "$1" >/dev/null 2>&1 || return 1
  spctl --assess --type execute "$1" >/dev/null 2>&1
}
# A path is saved one value per line and printed in errors, so a control character in it (a line break, a CR, a tab) is
# refused before anything reads it. LC_ALL=C so a byte class, not a locale's idea of printing.
has_control_chars() {
  ( LC_ALL=C; case "$1" in *[[:cntrl:]]*) exit 0 ;; esac; exit 1 )
}
if [ ! -w "$SPOTIFY/Contents/Resources" ]; then
  # canonicalise first, so a link or a ".." chain cannot point the chown somewhere else
  SPOTIFY=$(cd "$SPOTIFY" && pwd -P) || fail "Spotify's folder can't be read, so nothing was changed."
  # The name Tess was given can be clean while the one it resolves to is not: `pwd -P` follows a link whose target's
  # name carries the line break. Refused here, before the bundle id, the signature or spctl is read.
  has_control_chars "$SPOTIFY" \
    && fail "Spotify's folder has a line break or another control character in its path, which Tess can't save. Move Spotify somewhere else and run this again."
  spotify_is_spotifys_own "$SPOTIFY" \
    || fail "The Spotify at $SPOTIFY isn't Spotify's own signed app, so Tess left it alone. Install Spotify from https://www.spotify.com/download/mac/ and run this again."
  step "Spotify belongs to another user; asking for your password to let Tess update it"
  run_sudo chown -R "$(id -un)" "$SPOTIFY" || fail "Couldn't get permission to update Spotify."
fi

# Spotify's interface must be here (stock, or modified by an earlier Tess), or Tess's own safety copy of it
A0="$SPOTIFY/Contents/Resources/Apps"
# Spotify's own interface files for this exact version, kept by an earlier Tess (its safety copy, or the patcher's
# backup) or by Spicetify; used only when Spotify's are missing
# A backup counts when its settings say it is this version, or when its files match Spotify's own files for this
# version exactly (SHA-256 of the stock files, listed below as they are confirmed).
KNOWN_SPA="
1.3.9.2055 xpui.spa b64742faa2bd1db859aefddd804e76246731f2748d2eb138af212277f27f3e44
1.3.9.2055 login.spa 9fb9807b21e101c083948af4a0d3cb32806af1e7cc8868e84515465ae2dced48
"
known_stock() {  # dir: every .spa in it is a listed stock file of this Spotify version
  n=0
  for f in "$1"/*.spa; do
    [ -f "$f" ] || return 1
    h=$(shasum -a 256 "$f" | cut -d' ' -f1)
    echo "$KNOWN_SPA" | grep -q "^$SPV $(basename "$f") $h\$" || return 1
    n=$((n + 1))
  done
  [ $n -gt 0 ]
}
repair_source() {
  [ -f "$HOME_TESS/original-$SPV/xpui.spa" ] && { echo "$HOME_TESS/original-$SPV"; return; }
  for pair in "$HOME/.local/state/tess-patcher/Backup|$CONF/config-xpui.ini" "$HOME/.local/state/spicetify/Backup|$HOME/.config/spicetify/config-xpui.ini"; do
    b=${pair%%|*}; c=${pair#*|}
    [ -f "$b/xpui.spa" ] || continue
    { grep -qE "^version *= *$SPV *$" "$c" 2>/dev/null || known_stock "$b"; } && { echo "$b"; return; }
  done
}
REPAIR=$(repair_source || true)
[ -f "$A0/xpui.spa" ] || [ -d "$A0/xpui" ] || [ -n "$REPAIR" ] \
  || fail "Spotify's files at $SPOTIFY are missing and there's no copy of them for Spotify $SPV on this Mac, so nothing was changed. Only reinstalling Spotify (https://www.spotify.com/download/mac/) brings them back; your account, library and downloads are kept."

# --- download --------------------------------------------------------------------------------------------------
# The signed parts list says which file of each part is current; every download is checked against it.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
step "Downloading Tess"
CH="${TESS_CHANNEL:-${TESS_PARTS_CHANNEL:-stable}}"   # dev = internal builds (only the owner's Mac)
# The channel is stored in the settings file and read back by sed, so only these three words are allowed.
case "$CH" in stable|beta|dev) ;; *) fail "TESS_CHANNEL must be stable, beta or dev (got \"$CH\")." ;; esac
getlist() {
  # TESS_DIST_BASE is for sandbox tests: a local folder server instead of GitHub.
  if [ -n "$TESS_TEST" ] && [ -n "$TESS_DIST_BASE" ]; then curl -fsSL --max-time 60 "$DIST/$CH/dist/$1" -o "$TMP/$1"; return; fi
  curl -fsSL --max-time 60 -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/$REPO/contents/dist/$1?ref=$CH" -o "$TMP/$1" \
    || curl -fsSL --max-time 60 "https://raw.githubusercontent.com/$REPO/$CH/dist/$1" -o "$TMP/$1"
}
getlist components.txt && getlist components.sig || fail "Download failed. Check your connection and try again."
# Check the signed list before the patcher is fetched or unpacked: the verifier came from the stub, not from the
# download it is checking. (A manual run without TESS_VERIFY keeps the old order; the install line always sets it.)
if [ -n "$VERIFY" ]; then
  [ -x "$VERIFY" ] || fail "Tess's installer couldn't find its signature checker, so nothing was installed."
  "$VERIFY" "$TMP/components.txt" "$(tr -d '\n' < "$TMP/components.sig")" || fail "Tess's download didn't pass its signature check, so nothing was installed."
fi
part() { awk -v n="$1" '$1 == n { print $'"$2"' }' "$TMP/components.txt"; }
# The same forward-only rule as the updater: a repair must not install an older release or reset the rev floor.
rev=$(awk '$1 == "rev" { print $2 }' "$TMP/components.txt") || true
old=$(cat "$HOME_TESS/state/rev-$CH" 2>/dev/null) || true; case "$old" in ''|*[!0-9]*) old=0 ;; esac
if [ -z "$rev" ]; then
  if [ "$old" -gt 0 ]; then fail "This installer's list has no rev, but rev $old is already installed; nothing was changed."; fi
else
  case "$rev" in *[!0-9]*) fail "This installer's list has a bad rev; nothing was changed." ;; esac
  [ "$rev" -ge "$old" ] || fail "This installer is older than the version already installed; nothing was changed."
fi
fetch() { curl -fsSL --retry 2 --connect-timeout 20 --max-time 300 "$(part "$1" 3)" -o "$2" && [ "$(shasum -a 256 "$2" | cut -d' ' -f1)" = "$(part "$1" 2)" ]; }
fetch patcher "$TMP/patcher.tgz" || fail "Download failed. Check your connection and try again."
mkdir -p "$TMP/p" && tar -xzf "$TMP/patcher.tgz" -C "$TMP/p"
if [ -z "$VERIFY" ]; then
  # Manual run: the verifier comes from the archive it is about to check, so this only catches corruption in transit.
  "$TMP/p/tess-verify" "$TMP/components.txt" "$(tr -d '\n' < "$TMP/components.sig")" || fail "Tess's download didn't pass its signature check, so nothing was installed."
fi
fetch theme "$TMP/theme.tgz" || fail "Download failed. Check your connection and try again."
fetch updater "$TMP/updater.sh" || fail "Download failed. Check your connection and try again."
fetch mini "$TMP/mini.zip" || rm -f "$TMP/mini.zip"
fetch doctor "$TMP/doctor.sh" || rm -f "$TMP/doctor.sh"
for n in installer uninstall wake command; do
  fetch "$n" "$TMP/$n.sh" && zsh -n "$TMP/$n.sh" || rm -f "$TMP/$n.sh"
done
mkdir -p "$HOME_TESS/bin"
rm -rf "$HOME_TESS/bin/patcher"; ditto "$TMP/p" "$HOME_TESS/bin/patcher"
PATCHER="$HOME_TESS/bin/patcher/tess-patcher"
chmod +x "$PATCHER" "$HOME_TESS/bin/patcher/tess-verify"

# --- pause the update helper while we work (it must never run at the same time) --------------------------------------
real_launchctl || launchctl bootout "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 || true
mkdir -p "$HOME_TESS"; touch "$HOME_TESS/.installing"; PAUSED=1

# --- quit Spotify, undo any earlier patching ---------------------------------------------------------------------
if [ -z "$TESS_TEST" ] && pgrep -x Spotify >/dev/null; then
  WAS_RUNNING=1; wait_for_idle; step "Closing Spotify"
  pkill -TERM -x Spotify 2>/dev/null || true
  i=0; while pgrep -x Spotify >/dev/null && [ $i -lt 40 ]; do sleep 0.5; i=$((i+1)); done
  pkill -KILL -x Spotify 2>/dev/null || true
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
if [ ! -f "$APPS/xpui.spa" ] && [ -n "$REPAIR" ]; then
  # put back this exact Spotify version's own interface files from the copy found above
  step "Putting back Spotify's own files"
  swap_apps "$REPAIR" || fail "Couldn't put Spotify's files back; Spotify was left as it was."
fi
[ -f "$APPS/xpui.spa" ] || fail "Spotify's files look incomplete. Reinstall Spotify from https://www.spotify.com/download/mac/ and run this again."
ORIG="$HOME_TESS/original-$SPV"
# the new safety copy is complete before any older one is removed
rm -rf "$ORIG.new"
ditto "$APPS" "$ORIG.new" || { rm -rf "$ORIG.new"; fail "Couldn't make a safety copy of Spotify's files; nothing was changed."; }
for o in "$HOME_TESS"/original-*; do [ "$o" = "$ORIG.new" ] || rm -rf "$o"; done
mv "$ORIG.new" "$ORIG"
put_back() {
  swap_apps "$ORIG"
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
# Copy beside the target and rename: sh and zsh read a running script as they go, and `tess repair` runs this installer
# (and the tess command) from the very files written here, so overwriting them in place could run a mix of two versions.
put() { cp "$1" "$2.new" && chmod +x "$2.new" && mv -f "$2.new" "$2"; }
# --- the updater: keeps every part of Tess current from now on, and puts Tess back after Spotify updates --------------
put "$TMP/updater.sh" "$HOME_TESS/updater.sh"
{ env_line SPOTIFY "$SPOTIFY"
  if [ -n "$TESS_TEST" ]; then env_line TESS_CONFIG "$CONF"; fi
  if [ "$CH" != stable ]; then env_line TESS_PARTS_CHANNEL "$CH"; fi
} > "$HOME_TESS/updater.env" || fail "Couldn't save Tess's settings; nothing else was changed."
mkdir -p "$HOME_TESS/state"
OLD_MINI=$(cat "$HOME_TESS/state/mini" 2>/dev/null || true)
for n in patcher theme updater mini doctor installer uninstall wake command; do
  { [ "$n" = mini ] && [ ! -s "$TMP/mini.zip" ]; } || { [ "$n" = doctor ] && [ ! -s "$TMP/doctor.sh" ]; } && continue
  [ -n "$(part "$n" 2)" ] || continue
  case "$n" in installer|uninstall|wake|command) [ -s "$TMP/$n.sh" ] || continue ;; esac
  part $n 2 > "$HOME_TESS/state/$n"
done
awk '$1 == "version" { print $2 }' "$TMP/components.txt" > "$HOME_TESS/state/version"
if [ -n "$rev" ]; then echo "$rev" > "$HOME_TESS/state/rev-$CH"; fi
[ -s "$TMP/doctor.sh" ] && put "$TMP/doctor.sh" "$HOME_TESS/doctor.sh"
for n in installer uninstall wake; do
  if [ -s "$TMP/$n.sh" ]; then put "$TMP/$n.sh" "$HOME_TESS/$n.sh"; fi
done
[ -f "$HOME_TESS/install-id" ] || od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$HOME_TESS/install-id"
# Older channels have no local repair or uninstall parts.
[ -s "$HOME_TESS/installer.sh" ] || { [ -f "$0" ] && cp "$0" "$HOME_TESS/installer.sh" && chmod +x "$HOME_TESS/installer.sh"; } || true
if [ ! -s "$HOME_TESS/uninstall.sh" ]; then
  cat > "$HOME_TESS/uninstall.sh" <<'TESS_UNINSTALL'
#!/bin/sh
# Removes Tess Music and puts Spotify back to stock.
# Installed as a signed Tess part; run with: ~/Library/Application\ Support/Tess/tess uninstall
# >>> tess script guard: keep this block identical in every installer script (issue #107) >>>
# This file used to be able to act on a real Mac when nobody meant it, twice over: being sourced (a shell one-liner
# like `sh -c '. installer/tess-install.sh; …'` ran the whole real installer), and being run from a git checkout, whose
# copy is for developing and for sandboxed tests, not for a real install. Both stop here, before anything is read,
# downloaded or changed.
_tess_sourced=""
if [ -n "${ZSH_EVAL_CONTEXT-}" ]; then
  # zsh says where it is evaluating: a sourced file ends in ":file", a script run as its own command is "toplevel".
  case $ZSH_EVAL_CONTEXT in *:file) _tess_sourced=1 ;; esac
elif (return 0 2>/dev/null); then
  # sh/bash: `return` works only in a sourced file, so this subshell succeeds only when this file was sourced.
  _tess_sourced=1
fi
if [ -n "$_tess_sourced" ]; then
  echo "Tess: this file was sourced, so it did nothing. Tess's installer, updater, doctor, rescue line and uninstaller act only when they are run as their own command, so sourcing one can never install, update, repair or remove anything." >&2
  echo "Tess: run it as its own command (sh <file> or zsh <file>), or use Tess's published install line." >&2
  return 1
fi
unset _tess_sourced
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
    # `cd installer && sh tess-install.sh` names no folder; a piped copy (`curl … | sh`) names only "sh" and uses the
    # code from the pipe, so it is not a checkout's file and is left alone.
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
if [ -z "${TESS_TEST-}" ] && [ -z "${TESS_REAL_INSTALL-}" ] && tess_guard_checkout; then
  echo "Tess: not run. This copy ($_tg) is inside a git checkout, and a checkout's copy is for developing and for sandboxed tests, not for changing a real Mac." >&2
  echo "Tess: use Tess's published install line, or set TESS_REAL_INSTALL=1 if you really do mean to let this checkout act on this Mac." >&2
  exit 1
fi
# <<< tess script guard <<<
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
TESS_UNINSTALL
  chmod +x "$HOME_TESS/uninstall.sh"
fi
# Rescue keeps an independent verifier so a broken patcher update cannot disable recovery.
RESCUE_SRC="$HOME_TESS/bin/patcher/rescue"
if [ -x "$RESCUE_SRC/tess-rescue-verify" ] && [ -f "$RESCUE_SRC/rescue.sh" ]; then
  mkdir -p "$HOME_TESS/rescue"; RESCUE_FRESH=""
  if [ ! -x "$HOME_TESS/rescue/tess-rescue-verify" ]; then
    cp "$RESCUE_SRC/tess-rescue-verify" "$HOME_TESS/rescue/tess-rescue-verify"; RESCUE_FRESH=1
  fi
  if [ ! -f "$HOME_TESS/rescue/rescue.sh" ]; then cp "$RESCUE_SRC/rescue.sh" "$HOME_TESS/rescue/rescue.sh"; RESCUE_FRESH=1; fi
  chmod +x "$HOME_TESS/rescue/tess-rescue-verify" "$HOME_TESS/rescue/rescue.sh"
  [ -n "$RESCUE_FRESH" ] && TESS_HOME="$HOME_TESS" /bin/zsh "$HOME_TESS/rescue/rescue.sh" --adopt >/dev/null 2>&1 || true
fi
rm -f "$HOME_TESS/reapply.sh"
rm -f "$HOME_TESS/.installing"

# --- the tess command ----------------------------------------------------------------------------------------------
if [ -s "$TMP/command.sh" ]; then
  cp "$TMP/command.sh" "$HOME_TESS/tess.new"
else
  # Older channels have no command part; keep rescue opt-out available before their next promotion.
  cat > "$HOME_TESS/tess.new" <<'TESS_COMMAND'
#!/bin/sh
# >>> tess script guard: keep this block identical in every installer script (issue #107) >>>
# This file used to be able to act on a real Mac when nobody meant it, twice over: being sourced (a shell one-liner
# like `sh -c '. installer/tess-install.sh; …'` ran the whole real installer), and being run from a git checkout, whose
# copy is for developing and for sandboxed tests, not for a real install. Both stop here, before anything is read,
# downloaded or changed.
_tess_sourced=""
if [ -n "${ZSH_EVAL_CONTEXT-}" ]; then
  # zsh says where it is evaluating: a sourced file ends in ":file", a script run as its own command is "toplevel".
  case $ZSH_EVAL_CONTEXT in *:file) _tess_sourced=1 ;; esac
elif (return 0 2>/dev/null); then
  # sh/bash: `return` works only in a sourced file, so this subshell succeeds only when this file was sourced.
  _tess_sourced=1
fi
if [ -n "$_tess_sourced" ]; then
  echo "Tess: this file was sourced, so it did nothing. Tess's installer, updater, doctor, rescue line and uninstaller act only when they are run as their own command, so sourcing one can never install, update, repair or remove anything." >&2
  echo "Tess: run it as its own command (sh <file> or zsh <file>), or use Tess's published install line." >&2
  return 1
fi
unset _tess_sourced
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
    # `cd installer && sh tess-install.sh` names no folder; a piped copy (`curl … | sh`) names only "sh" and uses the
    # code from the pipe, so it is not a checkout's file and is left alone.
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
if [ -z "${TESS_TEST-}" ] && [ -z "${TESS_REAL_INSTALL-}" ] && tess_guard_checkout; then
  echo "Tess: not run. This copy ($_tg) is inside a git checkout, and a checkout's copy is for developing and for sandboxed tests, not for changing a real Mac." >&2
  echo "Tess: use Tess's published install line, or set TESS_REAL_INSTALL=1 if you really do mean to let this checkout act on this Mac." >&2
  exit 1
fi
# <<< tess script guard <<<
T="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
LA="${TESS_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
channel() {
  CH=$(sed -n "s/^TESS_PARTS_CHANNEL='\(.*\)'$/\1/p" "$T/updater.env" 2>/dev/null)
  echo "${CH:-stable}"
}
# A launchd label is per user. Under TESS_TEST, /bin/launchctl is the owner's real jobs.
real_launchctl() { [ -n "$TESS_TEST" ] && [ "$(command -v launchctl)" = /bin/launchctl ]; }
lctl() { real_launchctl && return 1; command launchctl "$@"; }
# A folder name with & or < in it would otherwise produce a launchd file macOS refuses to load.
xml_esc() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
case "$1" in
  update) /usr/bin/env TESS_FORCE=1 /bin/zsh "$T/updater.sh" ;;
  repair) V="$T/bin/patcher/tess-verify"; [ -x "$V" ] || { echo "Tess's verifier is missing; run the install line to repair Tess."; exit 1; }; exec /usr/bin/env TESS_CHANNEL="$(channel)" TESS_VERIFY="$V" /bin/sh "$T/installer.sh" ;;
  uninstall) exec /bin/sh "$T/uninstall.sh" ;;
  doctor) /bin/zsh "$T/doctor.sh" ;;
  report) /bin/zsh "$T/doctor.sh" --report ;;
  reports)
    case "$2" in
      off) touch "$T/reports-off"; echo "Health reports are off." ;;
      on) rm -f "$T/reports-off"; echo "Health reports are on." ;;
      # The id is the only thing that links this Mac's reports over time. A new one breaks the link for good.
      new-id)
        rm -f "$T/install-id"
        od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$T/install-id" || { echo "Couldn't write a new install id."; exit 1; }
        echo "New install id: $(cat "$T/install-id")"
        echo "Reports from this Mac can no longer be linked to the ones before it." ;;
      *) [ -f "$T/reports-off" ] && echo "Health reports are off." || echo "Health reports are on. (tess reports off)" ;;
    esac ;;
  rescue)
    case "$2" in
      off)
        touch "$T/rescue-off"
        lctl disable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        lctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        rm -f "$LA/music.tess.rescue.plist"
        echo "The Tess rescue line is off. Updates will not turn it back on." ;;
      on)
        if [ ! -x "$T/rescue/rescue.sh" ] || ! /bin/zsh "$T/rescue/rescue.sh" --adopt >/dev/null 2>&1; then
          touch "$T/rescue-off"
          lctl disable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
          lctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
          rm -f "$LA/music.tess.rescue.plist"
          echo "Couldn't read the current rescue order; the rescue line stays off. Try again when online."
          exit 1
        fi
        mkdir -p "$LA"
        RESCUE_PATH=$(xml_esc "$T/rescue/rescue.sh")
        printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
          '<plist version="1.0"><dict><key>Label</key><string>music.tess.rescue</string>' \
          "<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$RESCUE_PATH</string></array>" \
          '<key>StartInterval</key><integer>21600</integer><key>RunAtLoad</key><true/><key>AbandonProcessGroup</key><true/></dict></plist>' > "$LA/music.tess.rescue.plist" || exit 1
        rm -f "$T/rescue-off"
        lctl enable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        lctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        if lctl bootstrap "gui/$(id -u)" "$LA/music.tess.rescue.plist" >/dev/null 2>&1; then
          echo "The Tess rescue line is on. A current, unexpired order may run, including one sent while it was off."
        else
          touch "$T/rescue-off"
          lctl disable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
          rm -f "$LA/music.tess.rescue.plist"
          echo "The rescue line could not start; it stays off. Run tess doctor."
          exit 1
        fi
        ;;
      log) tail -100 "$T/rescue/rescue.log" 2>/dev/null || echo "No rescue orders have run." ;;
      *) if [ -f "$T/rescue-off" ]; then echo "The Tess rescue line is off. (tess rescue on)"
         elif [ ! -x "$T/rescue/tess-rescue-verify" ]; then echo "The Tess rescue line is not installed on this Mac."
         else echo "The Tess rescue line is on. (tess rescue off)"; fi ;;
    esac ;;
  status)
    VERSION=$(cat "$T/state/version" 2>/dev/null || echo unknown)
    echo "Tess $VERSION ($(channel))"
    lctl print "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 && echo "Updater: running" || echo "Updater: stopped"
    lctl print "gui/$(id -u)/music.tess.wake" >/dev/null 2>&1 && echo "Wake check: running" || echo "Wake check: stopped"
    FP=$(shasum -a 256 "$T/rescue/tess-rescue-verify" 2>/dev/null | cut -d' ' -f1)
    [ -n "$FP" ] || FP=not-installed
    # Status is how a person checks the line. "On" with no verifier describes a line that is not there.
    if [ ! -x "$T/rescue/tess-rescue-verify" ]; then
      echo "Rescue: not installed"
    elif [ -f "$T/rescue-off" ]; then
      if lctl print "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1; then
        echo "Rescue: off, but the agent is still loaded; run: tess rescue off (verifier SHA-256 $FP)"
      else
        echo "Rescue: off (verifier SHA-256 $FP)"
      fi
    elif lctl print "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1; then
      echo "Rescue: on, running (verifier SHA-256 $FP)"
    else
      echo "Rescue: on, stopped (verifier SHA-256 $FP)"
    fi
    [ -f "$T/reports-off" ] && echo "Reports: off" || echo "Reports: on"
    # An older script is not limited to the five actions. Repair is not the only place that should say so.
    if [ -f "$T/rescue/rescue.sh" ] && ! grep -q 'grep -qx "tess-rescue 2"' "$T/rescue/rescue.sh"; then
      echo "Rescue format: older (a signed order can run any script as you; tess rescue off stops it)"
    fi
    ;;
  *) echo "usage: tess doctor | report | reports on|off | rescue on|off|log | status | update | repair | uninstall" ;;
esac
TESS_COMMAND
fi
chmod +x "$HOME_TESS/tess.new" && mv -f "$HOME_TESS/tess.new" "$HOME_TESS/tess"

rescue_notice() {
  if [ -f "$HOME_TESS/rescue-off" ]; then
    echo "  The Tess rescue line is off on this Mac. Turn it back on: \"$HOME_TESS/tess\" rescue on"
  # Remember that this Mac was told the line exists, so a later update may put the files back. "Isn't set up" does not.
  elif [ -x "$HOME_TESS/rescue/rescue.sh" ] && ! grep -q 'grep -qx "tess-rescue 2"' "$HOME_TESS/rescue/rescue.sh"; then
    echo "  This Mac has an older Tess rescue line: orders signed by the owner's offline rescue key can run any script on this Mac as you, without asking."
    echo "  Turn it off any time: \"$HOME_TESS/tess\" rescue off"
    mkdir -p "$HOME_TESS/state"; touch "$HOME_TESS/state/rescue-notice-shown"
  elif [ -x "$HOME_TESS/rescue/rescue.sh" ]; then
    echo "  Tess's maintainer can remotely run five Tess actions on this Mac, without asking: check, update, repair, restore Spotify, or uninstall Tess."
    echo "  It accepts only orders signed by the owner's offline rescue key. Turn it off any time: \"$HOME_TESS/tess\" rescue off"
    mkdir -p "$HOME_TESS/state"; touch "$HOME_TESS/state/rescue-notice-shown"
  else
    echo "  The Tess rescue line isn't set up on this Mac."
  fi
}

if [ -x "$HOME_TESS/rescue/rescue.sh" ] && [ ! -f "$HOME_TESS/rescue-off" ]; then
  real_launchctl || launchctl enable "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
fi

if [ -n "$TESS_TEST" ]; then
  echo; bold "Test install into $SPOTIFY finished."
  rescue_notice
  exit 0
fi

# --- the helper that runs the updater -----------------------------------------------------------------------------
step "Keeping Tess up to date, and on through Spotify updates"
mkdir -p "$HOME/Library/LaunchAgents"
GUARD_UPDATER=$(xml_esc "$HOME_TESS/updater.sh")
GUARD_APPS=$(xml_esc "$SPOTIFY/Contents/Resources/Apps")
cat > "$HOME/Library/LaunchAgents/music.tess.guard.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.guard</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$GUARD_UPDATER</string></array>
<key>WatchPaths</key><array><string>$GUARD_APPS</string></array>
<key>StartInterval</key><integer>1800</integer>
<key>RunAtLoad</key><true/>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.guard.plist" 2>/dev/null || true

# A bad wake plist must not abort the rest of install: Mini, rescue and the notice still have to run.
if [ -x "$HOME_TESS/wake.sh" ] && "$HOME_TESS/wake.sh" --plist > "$HOME/Library/LaunchAgents/music.tess.wake.plist.new" \
   && plutil -lint "$HOME/Library/LaunchAgents/music.tess.wake.plist.new" >/dev/null; then
  mv -f "$HOME/Library/LaunchAgents/music.tess.wake.plist.new" "$HOME/Library/LaunchAgents/music.tess.wake.plist"
  launchctl bootout "gui/$(id -u)/music.tess.wake" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.wake.plist" 2>/dev/null || true
else
  rm -f "$HOME/Library/LaunchAgents/music.tess.wake.plist.new"
fi

if [ -x "$HOME_TESS/rescue/rescue.sh" ] && [ ! -f "$HOME_TESS/rescue-off" ]; then
RESCUE_SCRIPT=$(xml_esc "$HOME_TESS/rescue/rescue.sh")
cat > "$HOME/Library/LaunchAgents/music.tess.rescue.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.rescue</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$RESCUE_SCRIPT</string></array>
<key>StartInterval</key><integer>21600</integer>
<key>RunAtLoad</key><true/>
<key>AbandonProcessGroup</key><true/>
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
  MINI_BIN=$(xml_esc "$HOME/Applications/Tess Mini.app/Contents/MacOS/TessMini")
  cat > "$HOME/Library/LaunchAgents/music.tess.mini.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.mini</string>
<key>ProgramArguments</key><array><string>$MINI_BIN</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
EOF
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/music.tess.mini.plist" 2>/dev/null || true
fi

echo
bold "Tess is installed."
echo "  Spotify opens now. The theme updates itself; Spotify updates are handled for you."
echo "  The first time you open the miniplayer, macOS asks to let Tess Mini control Spotify: choose Allow."
echo "  To remove it: \"$HOME_TESS/tess\" uninstall      If something looks wrong: \"$HOME_TESS/tess\" doctor"
rescue_notice
echo "  Tess sends a small anonymous health report (versions and errors, nothing personal) so problems get fixed."
echo "  Each Mac has a random install id; \"$HOME_TESS/tess\" report shows it. A new one any time: \"$HOME_TESS/tess\" reports new-id"
echo "  To turn that off: \"$HOME_TESS/tess\" reports off"
echo
open -a "$SPOTIFY"
