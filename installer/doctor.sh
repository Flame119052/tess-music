#!/bin/zsh
# Tess doctor: checks every part of Tess on this Mac, fixes what it safely can, and (unless reports are off) sends a
# health report to the Tess inbox so problems can be seen and fixed remotely.
#   tess doctor            check and fix, print the result
#   tess doctor --report   same, and send the full report now
# The updater runs it by itself: "--auto" after something failed, "--heartbeat" once a day.
# It never deletes anything of Spotify's: the only thing it puts back is Spotify's own interface files, from the
# safety copy Tess made of this exact Spotify version, and only when they are missing.
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
T="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
[ -f "$T/updater.env" ] && . "$T/updater.env"
CONF="${TESS_CONFIG:-$HOME/.config/tess-patcher}"
[ -n "$TESS_CONFIG" ] && export SPICETIFY_CONFIG="$TESS_CONFIG"
REPO="Flame119052/tess-music"
INBOX="https://tess-music-player.janus.ing"
LA="$HOME/Library/LaunchAgents"
[ -n "$TESS_TEST" ] && LA="$T/LaunchAgents"
UID_=$(id -u)
# A launchd label is per user. A sandbox must not call /bin/launchctl, which is the owner's real job.
real_launchctl() { [ -n "$TESS_TEST" ] && [ "$(command -v launchctl)" = /bin/launchctl ]; }
MODE="${1:-check}"
OUT=$(mktemp); trap 'rm -f "$OUT"' EXIT
problems=0; fixed=0; st=()
say() { echo "$1" >> "$OUT"; [ "$MODE" = check ] || [ "$MODE" = --report ] && echo "$1"; }
ok() { say "  ✓ $1"; }
bad() { say "  ✕ $1"; problems=$((problems + 1)); }
fix() { say "  ↻ $1"; fixed=$((fixed + 1)); }
loaded() { [ -n "$TESS_TEST" ] && return 0; launchctl print "gui/$UID_/$1" >/dev/null 2>&1; }
load() { [ -n "$TESS_TEST" ] && return 0; launchctl bootstrap "gui/$UID_" "$LA/$1.plist" >/dev/null 2>&1; }
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
# The Spotify path is stored for the helper to read back with `.`, so it is written quoted: a folder name with a quote
# in it must not become a command in the helper's mouth.
env_line() {  # KEY value -> one line a POSIX shell reads back with `.`
  printf '%s=%s\n' "$1" "$2" | LC_ALL=C awk '{
    eq = index($0, "="); k = substr($0, 1, eq - 1); v = substr($0, eq + 1)
    gsub(/\047/, "\047\\\047\047", v)
    print k "=\047" v "\047"
  }'
}
set_env() {  # file KEY value: replace that key's line, keeping every other line
  local k=$2 line tmp="$1.new"
  line=$(env_line "$k" "$3") || return 1
  [ -f "$1" ] || : > "$1"
  # The new line arrives through the environment, not -v: awk would eat the backslashes that make the quoting valid.
  TESS_ENV_LINE="$line" LC_ALL=C awk -v k="$k" '
    substr($0, 1, length(k) + 1) == k "=" { if (!done) { print ENVIRON["TESS_ENV_LINE"]; done = 1 } next }
    { print }
    END { if (!done) print ENVIRON["TESS_ENV_LINE"] }' "$1" > "$tmp" && mv "$tmp" "$1"
}

[ -d "$T" ] || { echo "Tess isn't installed on this Mac."; exit 1; }
[ -f "$T/install-id" ] || od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$T/install-id"
ID=$(cat "$T/install-id")
say "Tess doctor  $(date '+%F %T')"

# --- stale lock: a run that died more than 30 minutes ago --------------------------------------------------------
if [ -e "$T/.installing" ] && [ -n "$(find "$T/.installing" -mmin +30 2>/dev/null)" ]; then rm -f "$T/.installing"; fix "cleared a lock left by a run that stopped"; fi

# --- which Spotify ----------------------------------------------------------------------------------------------
running=$(ps -axo comm= 2>/dev/null | sed -n 's|^\(.*/Spotify\.app\)/Contents/MacOS/Spotify$|\1|p' | head -1)
if [ -z "$SPOTIFY" ] || [ ! -d "$SPOTIFY" ] || { [ -n "$running" ] && [ -z "$TESS_TEST" ] && [ "$running" != "$SPOTIFY" ]; }; then
  new=""
  for p in "$running" "/Applications/Spotify.app" "$HOME/Applications/Spotify.app"; do
    [ -n "$p" ] && { [ -f "$p/Contents/Resources/Apps/xpui.spa" ] || [ -d "$p/Contents/Resources/Apps/xpui" ]; } && { new="$p"; break; }
  done
  if [ -n "$new" ] && [ -z "$TESS_TEST" ]; then
    SPOTIFY="$new"; set_env "$T/updater.env" SPOTIFY "$new"
    "$T/bin/patcher/tess-patcher" config spotify_path "$new/Contents/Resources" >/dev/null 2>&1
    fix "Tess now follows the Spotify at $new"
  fi
fi
[ -n "$SPOTIFY" ] && [ -d "$SPOTIFY" ] || { bad "can't find Spotify"; st+=(spotify=missing); }
SPV=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$SPOTIFY/Contents/Info.plist" 2>/dev/null)
APPS="$SPOTIFY/Contents/Resources/Apps"

# --- Tess's own programs ------------------------------------------------------------------------------------------
TMP=$(mktemp -d); trap 'rm -f "$OUT"; rm -rf "$TMP"' EXIT
list_ok=""
fetch_list() {
  [ -n "$list_ok" ] && return 0
  [ -x "$T/bin/patcher/tess-verify" ] || return 1
  for u in "https://api.github.com/repos/$REPO/contents/dist" "https://raw.githubusercontent.com/$REPO/${TESS_PARTS_CHANNEL:-stable}/dist"; do
    h=(); [[ $u == *api.github* ]] && h=(-H "Accept: application/vnd.github.raw")
    q=""; [[ $u == *api.github* ]] && q="?ref=${TESS_PARTS_CHANNEL:-stable}"
    curl -fsSL --max-time 60 "${h[@]}" "$u/components.txt$q" -o "$TMP/c.txt" && curl -fsSL --max-time 60 "${h[@]}" "$u/components.sig$q" -o "$TMP/c.sig" \
      && "$T/bin/patcher/tess-verify" "$TMP/c.txt" "$(tr -d '\n' < "$TMP/c.sig")" && { list_ok=1; return 0; }
  done
  return 1
}
fetch_part() {  # name dest: download a part named in the signed list and check its checksum
  fetch_list || return 1
  local line=$(awk -v n="$1" '$1 == n' "$TMP/c.txt")
  curl -fsSL --max-time 300 "$(echo "$line" | cut -d' ' -f3)" -o "$2" && [ "$(shasum -a 256 "$2" | cut -d' ' -f1)" = "$(echo "$line" | cut -d' ' -f2)" ]
}

if "$T/bin/patcher/tess-patcher" -v >/dev/null 2>&1 && [ -x "$T/bin/patcher/tess-verify" ]; then ok "patcher"; st+=(patcher=ok)
else
  bad "the patcher is damaged"; st+=(patcher=bad)
  # tess-verify may be gone with it; the rescue order is the way back then
  if fetch_part patcher "$TMP/p.tgz" && mkdir -p "$TMP/p" && tar -xzf "$TMP/p.tgz" -C "$TMP/p" && [ -x "$TMP/p/tess-patcher" ]; then
    rm -rf "$T/bin/patcher"; mkdir -p "$T/bin"; ditto "$TMP/p" "$T/bin/patcher"; rm -f "$T/state/patcher"; fix "downloaded the patcher again"
  fi
fi
if [ -f "$T/updater.sh" ] && zsh -n "$T/updater.sh" 2>/dev/null; then ok "updater"; st+=(updater=ok)
else
  bad "the updater is damaged"; st+=(updater=bad)
  if fetch_part updater "$TMP/u.sh" && zsh -n "$TMP/u.sh"; then cp "$TMP/u.sh" "$T/updater.sh"; chmod +x "$T/updater.sh"; rm -f "$T/state/updater"; fix "downloaded the updater again"; fi
fi

# Spotify's interface folder is only ever replaced by switching in a complete copy: the copy is made next to it and
# checked, then two renames swap them, and if anything fails the original stays. Never delete-then-copy: a block
# halfway through that left Spotify with no interface at all (black window). The copy and the swap run inside
# tess-patcher, not in this script: macOS's App Management protection denies /usr/bin/ditto when launchd starts a
# script under /bin/zsh. tools/check-safety.sh enforces it.
swap_apps() {
  if [ ! -x "$T/bin/patcher/tess-patcher" ]; then
    bad "tess-patcher is missing, so Spotify's folder cannot be switched"; return 1
  fi
  local log="$TMP/swap.log" rc=0
  "$T/bin/patcher/tess-patcher" swap-apps "$APPS" "$1" >"$log" 2>&1 || rc=$?
  [ $rc -eq 0 ] && return 0
  # Keep the patcher's own line. "A swap failed" hides that macOS denied the copy, which is the one thing the person
  # can act on; the exit code says the same thing the updater logs (3 blocked, 4 another user's files).
  while IFS= read -r line; do say "    $line"; done < "$log"
  case $rc in
    3) bad "macOS is blocking tess-patcher: System Settings › Privacy & Security › App Management, turn on tess-patcher" ;;
    4) bad "Spotify's files belong to another user; tess-patcher could not change them" ;;
    *) bad "tess-patcher couldn't switch Spotify's folder (code $rc)" ;;
  esac
  return 1
}
# --- Spotify's interface -------------------------------------------------------------------------------------------
if [ -f "$APPS/xpui/index.html" ] && grep -q spicetifyWrapper "$APPS/xpui/index.html" 2>/dev/null; then
  if grep -q TESS_BASELINE "$APPS/xpui/extensions/theme.js" 2>/dev/null; then ok "Tess is in Spotify $SPV"; st+=(spotify=tess)
  else bad "Spotify is modified but Tess's loader is missing"; st+=(spotify=noloader); rm -f "$T/state/theme"; fi
elif [ -f "$APPS/xpui.spa" ]; then
  st+=(spotify=stock)
  if [ "$MODE" = check ] || [ "$MODE" = --report ]; then
    # asked for by the user: let the helper try again now (it never retries on its own after a failure)
    rm -f "$T/state/.reapply-tried-$SPV"
    say "  · Spotify $SPV is stock; Tess goes back in within 5 minutes"
    "$T/bin/patcher/tess-patcher" can-write "$APPS" >/dev/null 2>&1
    if [ $? -eq 3 ]; then
      bad "macOS is blocking tess-patcher: System Settings › Privacy & Security › App Management, turn on tess-patcher"
      [ -z "$TESS_TEST" ] && open "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles"
      st+=(appmgmt=blocked)
    fi
  else
    say "  · Spotify $SPV is stock"
  fi
else
  bad "Spotify's interface files are missing"; st+=(spotify=broken)
  if [ -n "$SPV" ] && [ -f "$T/original-$SPV/xpui.spa" ]; then
    swap_apps "$T/original-$SPV" && fix "put back Spotify's own files from Tess's safety copy of $SPV"
  else
    say "    Tess has no copy of Spotify $SPV's files. Only reinstalling Spotify fixes this: https://www.spotify.com/download/mac/"
  fi
fi
grep -q "spotify_path *= *$SPOTIFY/Contents/Resources" "$CONF/config-xpui.ini" 2>/dev/null || {
  "$T/bin/patcher/tess-patcher" config spotify_path "$SPOTIFY/Contents/Resources" >/dev/null 2>&1 && fix "pointed the patcher at this Spotify"; }

# --- background helpers -----------------------------------------------------------------------------------------------
if [ -f "$LA/music.tess.guard.plist" ]; then
  if loaded music.tess.guard; then ok "update helper running"; st+=(guard=ok)
  else load music.tess.guard && fix "restarted the update helper"; st+=(guard=restarted); fi
else bad "the update helper is missing (run the install line once)"; st+=(guard=missing); fi
if [ -x "$T/wake.sh" ] && [ -f "$LA/music.tess.wake.plist" ]; then
  if loaded music.tess.wake; then ok "wake check running"; st+=(wake=ok)
  else load music.tess.wake && fix "restarted the wake check"; st+=(wake=restarted); fi
else bad "the wake check is missing"; st+=(wake=missing); fi
if [ -d "$HOME/Applications/Tess Mini.app" ] && [ -f "$LA/music.tess.mini.plist" ]; then
  if loaded music.tess.mini; then ok "Tess Mini running"; st+=(mini=ok)
  else load music.tess.mini && fix "restarted Tess Mini"; st+=(mini=restarted); fi
fi
rescue_fp=$(shasum -a 256 "$T/rescue/tess-rescue-verify" 2>/dev/null | cut -d' ' -f1)
if [ -f "$T/rescue-off" ]; then
  # A leftover plist loads again at login even when the job is not running now.
  if ! real_launchctl; then
    launchctl disable "gui/$UID_/music.tess.rescue" >/dev/null 2>&1 || true
    if launchctl print "gui/$UID_/music.tess.rescue" >/dev/null 2>&1; then
      launchctl bootout "gui/$UID_/music.tess.rescue" >/dev/null 2>&1 || true
      fix "stopped the rescue line you turned off"
    fi
  fi
  [ -f "$LA/music.tess.rescue.plist" ] && rm -f "$LA/music.tess.rescue.plist" && fix "removed the rescue line's login file"
  ok "rescue line is off by your choice"; st+=(rescue=off "rescue-verifier=${rescue_fp:-none}")
elif [ -x "$T/rescue/tess-rescue-verify" ] && [ -f "$LA/music.tess.rescue.plist" ]; then
  if loaded music.tess.rescue; then ok "rescue line ready"; st+=(rescue=ok)
  else load music.tess.rescue && fix "restarted the rescue line"; st+=(rescue=restarted); fi
  st+=("rescue-verifier=${rescue_fp:-none}")
else st+=(rescue=none "rescue-verifier=${rescue_fp:-none}"); fi

# --- network ----------------------------------------------------------------------------------------------------------
if [ "$MODE" != --validate ]; then
  if curl -fsS --max-time 15 -o /dev/null https://api.github.com/zen 2>/dev/null || curl -fsS --max-time 15 -o /dev/null https://raw.githubusercontent.com 2>/dev/null; then ok "can reach updates"
  else bad "can't reach GitHub for updates"; st+=(net=down); fi
fi

recent=$(tail -200 "$T/guard.log" 2>/dev/null | grep -iE "fail|mismatch|couldn|bad|error|ignored" | tail -5)
[ -n "$recent" ] && { say "  recent problems in the helper's log:"; echo "$recent" | sed 's/^/    /' | while read -r l; do say "$l"; done; }
say "$problems problem(s), $fixed fixed."

# --- report ------------------------------------------------------------------------------------------------------------
send() {
  [ -f "$T/reports-off" ] && return 0
  local kind=$1 tv=$(cat "$T/state/version" 2>/dev/null)
  { cat "$OUT"; echo; echo "--- guard.log"; tail -120 "$T/guard.log" 2>/dev/null; echo; echo "--- rescue.log"; tail -40 "$T/rescue/rescue.log" 2>/dev/null; echo; echo "--- files"
    ls -la "$APPS" 2>&1; ls "$T" 2>&1; } > "$TMP/body"
  # nothing personal leaves the Mac: the same filter the installer and the rescue line use removes home folders,
  # account names, computer names and email addresses
  local jstr='BEGIN { ORS = ""; print "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, ""); gsub(/[\001-\037]/, ""); print $0 "\\n" } END { print "\"" }'
  printf '{"install":"%s","kind":"%s","tess":"%s","spotify":"%s","macos":"%s","status":%s,"body":%s}' "$ID" "$kind" "$tv" "$SPV" \
    "$(sw_vers -productVersion)" "$(printf '%s' "${st[*]}" | awk "$jstr")" "$(tess_redact < "$TMP/body" | tail -c 20000 | awk "$jstr")" > "$TMP/r.json" || return 1
  [ -n "$TESS_TEST" ] && { cp "$TMP/r.json" "$T/last-report.json"; return 0; }
  curl -fsS --max-time 30 -H "content-type: application/json" --data-binary @"$TMP/r.json" "$INBOX/v1/report" >/dev/null 2>&1
}
case "$MODE" in
  --report) send doctor && echo "Report sent. Your install id: $ID" || echo "Couldn't send the report (reports off, or offline)." ;;
  --auto) [ "$problems" -gt 0 ] || [ "$fixed" -gt 0 ] && send problem ;;
  --heartbeat) send heartbeat ;;
  --validate) [ "$problems" -eq 0 ] ;;
esac
[ "$MODE" = --validate ] && [ "$problems" -gt 0 ] && exit 1
exit 0
