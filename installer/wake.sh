#!/bin/zsh
# Every five minutes, read the public release marker and wake the signed updater when it moved.
# The rescue serial is read only while that line is on, so a user who turned it off is not
# stuck waiting on the rescue branch for ordinary updates.
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
STATE="$T/state"
R="$T/rescue"
REPO="Flame119052/tess-music"
CHANNEL=$(sed -n "s/^TESS_PARTS_CHANNEL='\(.*\)'$/\1/p" "$T/updater.env" 2>/dev/null)
CHANNEL="${CHANNEL:-stable}"
# A folder name with & or < in it would otherwise produce a launchd file macOS refuses to load.
xml_esc() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

if [ "$1" = --plist ]; then
  WAKE_SCRIPT=$(xml_esc "$T/wake.sh")
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>music.tess.wake</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>$WAKE_SCRIPT</string></array>
<key>StartInterval</key><integer>300</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>Nice</key><integer>10</integer>
</dict></plist>
EOF
  exit 0
fi

mkdir -p "$STATE" "$R"
LOCK="$T/.installing"
[ -e "$LOCK" ] && [ -z "$(find "$LOCK" -mmin +30 2>/dev/null)" ] && exit 0

# One failed read pauses both for 15 minutes, so a dead network is not hit every 5.
# On that attempt the reads stay separate: a missing rescue order still wakes an update.
FAILED="$STATE/.wake-network-failed"
[ -f "$FAILED" ] && [ -z "$(find "$FAILED" -mmin +15 2>/dev/null)" ] && exit 0

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
version_url="https://raw.githubusercontent.com/$REPO/$CHANNEL/dist/manifest.json"
rescue_url="https://raw.githubusercontent.com/$REPO/rescue/rescue.txt"
failed=""
if curl -fsSL --connect-timeout 5 --max-time 15 "$version_url" -o "$TMP/version"; then
  published=$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$TMP/version")
  installed=$(cat "$STATE/version" 2>/dev/null)
  if [ -n "$published" ] && [ "$published" != "$installed" ]; then
    launchctl kickstart "gui/$(id -u)/music.tess.guard" >/dev/null 2>&1 || true
  fi
else
  failed=1
fi
if [ -f "$T/rescue-off" ]; then
  if [ -n "$failed" ]; then touch "$FAILED"; else rm -f "$FAILED"; fi
  exit 0
fi
if ! curl -fsSL --connect-timeout 5 --max-time 15 "$rescue_url" -o "$TMP/rescue"; then
  failed=1
fi
if [ -n "$failed" ]; then touch "$FAILED"; else rm -f "$FAILED"; fi
[ -s "$TMP/rescue" ] || exit 0

serial=$(awk '$1 == "serial" { print $2; exit }' "$TMP/rescue")
case $serial in ''|*[!0-9]*) exit 0 ;; esac
done_serial=$(cat "$R/serial" 2>/dev/null); done_serial=${done_serial:-0}
case $done_serial in ''|*[!0-9]*) done_serial=0 ;; esac
kicked=$(cat "$STATE/.wake-rescue-kicked" 2>/dev/null)
if [ ! -f "$T/rescue-off" ] && [ "$serial" -gt "$done_serial" ] && [ "$serial" != "$kicked" ]; then
  echo "$serial" > "$STATE/.wake-rescue-kicked"
  launchctl kickstart "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
fi
exit 0
