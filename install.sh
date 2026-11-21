#!/bin/sh
# Tess Music install line. The verifier is fetched from main and checked against the pin below; that verifier checks
# the channel installer's signature. A channel or mirror can change the installer but cannot make this Mac run an
# unverified one. A channel with no signed installer refuses: nothing runs.
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
CH="${TESS_CHANNEL:-stable}"
case "$CH" in stable|beta|dev) ;; *) echo "TESS_CHANNEL must be stable, beta or dev"; exit 1 ;; esac
BASE="https://raw.githubusercontent.com/Flame119052/tess-music"
[ -n "$TESS_TEST" ] && [ -n "$TESS_TEST_BASE" ] && BASE="$TESS_TEST_BASE"
VERIFY_SHA='c2917cd95f880965657d8cabbf5f9d2abccacfb32d9b06b24e49bb0bcaf163a4'
[ -n "$TESS_TEST" ] && [ -n "$TESS_VERIFY_SHA" ] && VERIFY_SHA="$TESS_VERIFY_SHA"
D=$(mktemp -d) || exit 1
trap 'rm -rf "$D"' EXIT
fail() { echo "$1"; exit 1; }

# 1. The verifier comes from main and must match the pin above. A channel cannot swap it.
curl -fsSL --max-time 60 "$BASE/main/installer/verify/$VERIFY_SHA" -o "$D/tess-verify" \
  || fail "Couldn't download Tess's signature checker. Check your connection and try again."
[ "$(shasum -a 256 "$D/tess-verify" | cut -d' ' -f1)" = "$VERIFY_SHA" ] \
  || fail "Tess's signature checker didn't match its published checksum, so nothing was installed."
chmod +x "$D/tess-verify" || fail "Couldn't prepare Tess's signature checker."

# 2. The channel's installer and its signature, as one pair. raw.githubusercontent caches each file on
# its own, so just after a promote one can be the new release and the other the old one, and a good
# install fails its signature check. The contents API is live. Both files of one try come from the same
# place. A signature miss fetches the pair once more. A live 404 is not replaced with the raw cache.
API=""
if [ -z "${TESS_TEST-}" ] || [ -n "${TESS_TEST_API-}" ]; then
  API="${TESS_TEST_API:-https://api.github.com/repos/Flame119052/tess-music}"
fi

pair_from_api() {
  [ -n "$API" ] || return 2
  rm -f "$D/install.sh" "$D/install.sig"
  code=$(curl -sS -L --max-time 60 -H "Accept: application/vnd.github.raw" -w '%{http_code}' -o "$D/install.sh" "$API/contents/dist/install.sh?ref=$CH" 2>/dev/null) || code=000
  if [ "$code" = 404 ]; then pair_err=missing; return 1; fi
  if [ "$code" != 200 ]; then rm -f "$D/install.sh"; return 2; fi
  code=$(curl -sS -L --max-time 60 -H "Accept: application/vnd.github.raw" -w '%{http_code}' -o "$D/install.sig" "$API/contents/dist/install.sig?ref=$CH" 2>/dev/null) || code=000
  if [ "$code" = 404 ]; then pair_err=nosig; return 1; fi
  if [ "$code" != 200 ]; then rm -f "$D/install.sh" "$D/install.sig"; return 2; fi
  return 0
}

pair_from_raw() {
  rm -f "$D/install.sh" "$D/install.sig"
  code=$(curl -sS -L --max-time 60 -w '%{http_code}' -o "$D/install.sh" "$BASE/$CH/dist/install.sh" 2>/dev/null) || code=000
  if [ "$code" = 404 ]; then pair_err=missing; return 1; fi
  if [ "$code" != 200 ]; then pair_err="HTTP $code"; return 1; fi
  code=$(curl -sS -L --max-time 60 -w '%{http_code}' -o "$D/install.sig" "$BASE/$CH/dist/install.sig" 2>/dev/null) || code=000
  if [ "$code" = 404 ]; then pair_err=nosig; return 1; fi
  if [ "$code" != 200 ]; then pair_err="HTTP $code"; return 1; fi
  return 0
}

fetch_pair() {
  pair_err=
  if [ -n "$API" ]; then
    pair_from_api
    api_st=$?
    if [ "$api_st" -eq 0 ]; then return 0; fi
    if [ "$api_st" -eq 1 ]; then return 1; fi
  fi
  pair_from_raw
}

explain_pair() {
  case "$pair_err" in
    missing) fail "Tess's $CH channel has no signed installer ready, so nothing was installed. Try again after Tess is released for this channel." ;;
    nosig) fail "Tess's installer has no signature on $CH, so nothing was installed." ;;
    HTTP*) fail "Couldn't download Tess's installer ($pair_err). Check your connection and try again." ;;
    *) fail "Couldn't download Tess's installer. Check your connection and try again." ;;
  esac
}

fetch_pair || explain_pair
if ! "$D/tess-verify" "$D/install.sh" "$(tr -d '\n' < "$D/install.sig")"; then
  fetch_pair || explain_pair
  "$D/tess-verify" "$D/install.sh" "$(tr -d '\n' < "$D/install.sig")" \
    || fail "Tess's installer didn't pass its signature check, so nothing was installed."
fi
TESS_CHANNEL="$CH" TESS_VERIFY="$D/tess-verify" sh "$D/install.sh"
