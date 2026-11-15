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
