#!/bin/zsh
# Tess rescue: the way to fix Tess on a Mac when everything else is broken, even the updater.
# It is separate from the updater on purpose: it never updates itself, it has its own LaunchAgent
# (music.tess.rescue) and its own copy of the signature checker, so a bad update can't take it down with it.
#
# What it can do is fixed here, in this file, and limited to Tess and Spotify. An order names ONE of these actions;
# it can't carry a script or any command of its own, so even someone holding the rescue key can only press one of
# these buttons:
#   check            run Tess's doctor (checks Tess and Spotify, puts back only Tess's own safe fixes) and report
#   update           run Tess's updater now (it installs only parts signed with Tess's release key)
#   repair           run this Mac's signed installer copy on its channel (same as "tess repair")
#   restore-spotify  take Tess out of Spotify and put Spotify's own interface back (Spotify keeps working, plain)
#   uninstall        remove Tess completely (same as "tess uninstall")
# Nothing here reads your files, messages, other apps or settings outside Tess and Spotify.
#
# Every few hours it fetches the current rescue order from three places (GitHub's API, GitHub's raw files, and the
# Tess inbox). It runs the order only if ALL of these hold:
#  - it is signed by the rescue key. That key is a different key from the release key, it lives only on the owner's
#    Mac and never in GitHub or CI, so a stolen GitHub account or CI secret still can't issue a rescue;
#  - its serial number is higher than any order this Mac has run (an old order can't be replayed);
#  - it hasn't expired;
#  - it is meant for every Mac, or names this Mac's install id;
#  - its action is one of the five above.
# "rescue.sh --adopt" only records the current order as already seen. While an action runs, its process group and the
# time it started are written to Tess/rescue/order.pid, which is how "tess rescue off" stops an order that has already
# started. `rescue off` writes "off" to Tess/rescue/order.stop before the signal, so the log can say what stopped it.
# Order format: "tess-rescue 2" / "serial N" / "expires <unix time>" / optional "only <id> <id>..." / optional
# "timeout <seconds>" (60-3600, default 1800) / "action <name>".
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
R="$T/rescue"
VERIFY="$R/tess-rescue-verify"
LOG="$R/rescue.log"
REPO="Flame119052/tess-music"
INBOX="https://tess-music-player.janus.ing"
[ -f "$T/rescue-off" ] && [ "$1" != --adopt ] && exit 0
refuse() { [ "$1" = --adopt ] && exit 1; exit 0; }
[ -x "$VERIFY" ] || refuse "$1"
mkdir -p "$R"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
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
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 200000 ] && tail -c 100000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
got=""
for src in api raw inbox; do
  if [ -n "$TESS_TEST" ] && [ -n "$TESS_RESCUE_DIR" ]; then   # tests read a local folder instead
    cp "$TESS_RESCUE_DIR/rescue.txt" "$TMP/o" 2>/dev/null && cp "$TESS_RESCUE_DIR/rescue.sig" "$TMP/s" 2>/dev/null || break
    "$VERIFY" "$TMP/o" "$(tr -d '\n' < "$TMP/s")" && got=test; break
  fi
  case $src in
    api) a=(-H "Accept: application/vnd.github.raw" "https://api.github.com/repos/$REPO/contents/rescue.txt?ref=rescue")
         b=(-H "Accept: application/vnd.github.raw" "https://api.github.com/repos/$REPO/contents/rescue.sig?ref=rescue") ;;
    raw) a=("https://raw.githubusercontent.com/$REPO/rescue/rescue.txt"); b=("https://raw.githubusercontent.com/$REPO/rescue/rescue.sig") ;;
    inbox) a=("$INBOX/v1/rescue.txt"); b=("$INBOX/v1/rescue.sig") ;;
  esac
  curl -fsSL --max-time 60 "${a[@]}" -o "$TMP/o" 2>/dev/null && curl -fsSL --max-time 60 "${b[@]}" -o "$TMP/s" 2>/dev/null || continue
  "$VERIFY" "$TMP/o" "$(tr -d '\n' < "$TMP/s")" && { got=$src; break; }
  log "order from $src failed its signature check; ignored"
done
[ -n "$got" ] || refuse "$1"

# Only the action format is accepted. The older format ("tess-rescue 1", which carried a script) is refused here.
head -1 "$TMP/o" | grep -qx "tess-rescue 2" || refuse "$1"
field() { sed -n "s/^$1 \(.*\)$/\1/p" "$TMP/o" | head -1; }
serial=$(field serial); expires=$(field expires); only=$(field only); action=$(field action); timeout=$(field timeout)
case $serial in ''|*[!0-9]*) refuse "$1" ;; esac
case $expires in ''|*[!0-9]*) refuse "$1" ;; esac
# An order may ask for a shorter or longer run than half an hour, never an unbounded one: a repair that hangs must not
# hold the Mac forever, and a number typed wrong must not become one second. Anything else falls back to the default.
case $timeout in ''|*[!0-9]*) timeout=1800 ;; esac
[ "$timeout" -lt 60 ] && timeout=60
[ "$timeout" -gt 3600 ] && timeout=3600
done_serial=$(cat "$R/serial" 2>/dev/null); done_serial=${done_serial:-0}
# --adopt (used when the rescue line is first installed): note the current order as seen, without running it
if [ "$1" = --adopt ]; then
  if [ "$serial" -gt "$done_serial" ]; then echo "$serial" > "$R/serial" || exit 1; fi
  exit 0
fi
[ "$serial" -gt "$done_serial" ] || exit 0
[ "$(date +%s)" -lt "$expires" ] || exit 0
id=$(cat "$T/install-id" 2>/dev/null)
if [ -n "$only" ]; then [[ " $only " == *" $id "* ]] || { echo "$serial" > "$R/serial"; exit 0; }; fi

# mark it done first, so an order that crashes is never run again in a loop
echo "$serial" > "$R/serial"
CH=$(sed -n "s/^TESS_PARTS_CHANNEL='\(.*\)'$/\1/p" "$T/updater.env" 2>/dev/null)
PATCHER="$T/bin/patcher/tess-patcher"
case $action in
  check)           cmd=(/bin/zsh "$T/doctor.sh" --report) ;;
  update)          cmd=(/usr/bin/env TESS_FORCE=1 /bin/zsh "$T/updater.sh") ;;
  repair)          V="$T/bin/patcher/tess-verify"; if [ ! -x "$V" ]; then log "repair: no verifier installed; refused"; exit 0; fi; cmd=(/usr/bin/env TESS_CHANNEL="${CH:-stable}" TESS_VERIFY="$V" /bin/sh "$T/installer.sh") ;;
  # the patcher's restore swaps in Spotify's own files as one checked copy (swapApps), never delete-then-copy
  restore-spotify) cmd=(/bin/zsh -c '[ -f "$1/updater.env" ] && . "$1/updater.env"; [ -n "$TESS_CONFIG" ] && export SPICETIFY_CONFIG="$TESS_CONFIG"; exec "$2" restore' _ "$T" "$PATCHER") ;;
  uninstall)       cmd=(/bin/sh "$T/uninstall.sh") ;;
  *) log "rescue order $serial asks for '$action', which isn't one of Tess's rescue actions; refused"; exit 0 ;;
esac
# One action, under the order's limit, in a process group of its own.
# Killing just the action's shell leaves its children behind: the patcher, ditto and curl are children, `check`, `update`,
# `repair` and `uninstall` all start that way, and the rescue plist sets AbandonProcessGroup, so launchd would not reap what
# the kill left either. The log could then say the order had stopped while the patcher was still changing Spotify, and the
# next updater or rescue run could overlap that writer. So the action gets its own process group and the limit stops the
# whole group: TERM, a grace period, then KILL. The group is a separate one from the rescue script's own, or the stop would
# kill this script too. `/bin/sh` turns job control on for the action because zsh refuses `set -m` in a script.
# Stop file: absent when the action finished on its own; "off" when `tess rescue off` wrote that before its signal;
# "term" when the limit stopped the group with TERM, "kill" when it needed KILL, and "lingering" when something in it
# would not exit even then, so the log can say exactly what happened.
run_bounded() {  # <seconds> <log> <rc file> <stop file> <command...>
  _secs=$1 _log=$2 _rcf=$3 _stopf=$4 _pidf=${RUN_PIDFILE-}; shift 4
  /bin/sh -c '
    log=$1 secs=$2 rcf=$3 stopf=$4 pidf=$5; shift 5
    set -m
    # stdin is /dev/null for the action, as it was for a background job before: one that reads must not be stopped (SIGTTIN)
    "$@" >> "$log" 2>&1 < /dev/null &
    pid=$!
    # The group this order runs in, and the time it started, so `tess rescue off` can stop one that has already started
    # (#91) without signalling a later process that reused the number. It is a separate group from this script, so
    # stopping it cannot stop the script that is waiting on it.
    if [ -n "$pidf" ]; then
      _ls=$(ps -o lstart= -p "$pid" 2>/dev/null | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")
      printf "%s\n%s\n" "$pid" "$_ls" > "$pidf"
    fi
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$secs" ]; do sleep 1; waited=$((waited + 1)); done
    # finished on its own: nothing to stop, and the code written down is the one the action exited with
    if ! kill -0 "$pid" 2>/dev/null; then wait "$pid"; echo $? > "$rcf"; if [ -n "$pidf" ]; then rm -f "$pidf"; fi; exit 0; fi
    kill -TERM -- "-$pid" 2>/dev/null
    stop=term; n=0
    while kill -0 -- "-$pid" 2>/dev/null; do
      if [ "$n" -ge 10 ]; then stop=kill; kill -KILL -- "-$pid" 2>/dev/null; break; fi
      sleep 1; n=$((n + 1))
    done
    # KILL is final, but a process stuck in the kernel can still show for a moment; the log has to say so if it does
    if [ "$stop" = kill ]; then
      n=0
      while kill -0 -- "-$pid" 2>/dev/null && [ "$n" -lt 5 ]; do sleep 1; n=$((n + 1)); done
      kill -0 -- "-$pid" 2>/dev/null && stop=lingering
    fi
    # `tess rescue off` may already have written "off". Leave that reason in place.
    if [ "$(tr -d "[:space:]" < "$stopf" 2>/dev/null)" != off ]; then echo "$stop" > "$stopf"; fi
    wait "$pid"; echo $? > "$rcf"
    if [ -n "$pidf" ]; then rm -f "$pidf"; fi
  ' _ "$_log" "$_secs" "$_rcf" "$_stopf" "$_pidf" "$@" 2>/dev/null
}
log "running rescue order $serial: $action (from $got, up to ${timeout}s)"
# Only the lines this order writes are reported, so note where the log ends now, before anything has run.
offset=$(wc -c < "$LOG" 2>/dev/null || echo 0)
# While the action runs, its process group and start time are written here; `tess rescue off` reads them to stop a
# mistake already started. The stop file is the same folder, so `off` can name the reason before the signal.
RUN_PIDFILE="$R/order.pid"
_how=""
# TESS_TEST logs what would run; TESS_TEST_RUN makes the sandbox actually run it, against the sandbox's own stand-in tools
if [ -n "$TESS_TEST" ] && [ -z "$TESS_TEST_RUN" ]; then
  echo "test: would run ${cmd[*]}" >> "$LOG"; rc=0
else
  # This returns only once the action and everything it started are gone, so the lines below never describe a running order
  rm -f "$R/order.stop"
  run_bounded "$timeout" "$LOG" "$TMP/rc" "$R/order.stop" "${cmd[@]}"
  rc=$(cat "$TMP/rc" 2>/dev/null); rc=${rc:-1}
  if [ -f "$R/order.stop" ]; then _how=$(tr -d '[:space:]' < "$R/order.stop" 2>/dev/null || true); rm -f "$R/order.stop"; fi
  case $_how in
    off) log "rescue order $serial was stopped by rescue off" ;;
    term|kill) log "rescue order $serial ran past ${timeout}s; stopped it" ;;
    lingering) log "rescue order $serial ran past ${timeout}s; stopped it, but a process would not exit" ;;
  esac
fi
log "rescue order $serial finished (exit $rc)"
# tell the inbox it ran, unless reports are off. Only this order's own lines, through the one privacy filter, and only
# when the install id really is a Tess id (it is pasted into JSON here).
if [ ! -f "$T/reports-off" ] && [ -n "$id" ] && printf '%s' "$id" | grep -qx '[0-9a-f]\{32\}'; then
  body=$(tail -c +"$((offset + 1))" "$LOG" 2>/dev/null | tail -c 6000 | tess_redact | awk 'BEGIN { ORS = ""; print "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, ""); gsub(/[\001-\037]/, ""); print $0 "\\n" } END { print "\"" }')
  _status="order $serial $action exit $rc"
  [ "$_how" = off ] && _status="$_status, stopped by rescue off"
  report="{\"install\":\"$id\",\"kind\":\"rescue\",\"status\":\"$_status\",\"body\":$body}"
  if [ -n "$TESS_TEST" ]; then
    # a sandbox keeps the report in its own folder instead of sending it, so a test can read what would have gone out
    printf '%s' "$report" > "$R/order-report.json"
  else
    curl -fsS --max-time 30 -H "content-type: application/json" -d "$report" "$INBOX/v1/report" >/dev/null 2>&1
  fi
fi
exit 0
