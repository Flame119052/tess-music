#!/bin/sh
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
# The rescue line writes the process group of a running order to order.pid, and the time that process started.
# A number left behind by a crash can belong to another program by now, so it counts only when it still leads its own
# group, that start time still matches, and its command is still one of Tess's own.
order_group() {  # <rescue folder>
  _og="$1/order.pid"
  [ -f "$_og" ] || return 0
  _op=$(sed -n '1p' "$_og" 2>/dev/null | tr -d '[:space:]')
  _started=$(sed -n '2p' "$_og" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  case $_op in ''|*[!0-9]*) return 0 ;; esac
  [ -n "$_started" ] || return 0
  [ "$(ps -o pgid= -p "$_op" 2>/dev/null | tr -d ' ')" = "$_op" ] || return 0
  _now=$(ps -o lstart= -p "$_op" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ "$_now" = "$_started" ] || return 0
  case "$(ps -o command= -p "$_op" 2>/dev/null)" in
    *"$T"*) echo "$_op" ;;
  esac
}
# Turning the line off must also stop an order that has already started: it runs in a process group of its own, and
# launchd's AbandonProcessGroup would leave it changing Spotify after the person said stop. TERM, a grace period, then
# KILL: the same way the order's own time limit stops it.
stop_order() {  # <rescue folder> -> prints "stopped" when it stopped something
  _sp=$(order_group "$1")
  [ -n "$_sp" ] || { rm -f "$1/order.pid"; return 0; }
  # The order reads this when the group dies. It has to be there before the signal, or the log only has the exit code.
  printf '%s\n' off > "$1/order.stop"
  kill -TERM -- "-$_sp" 2>/dev/null || true
  _n=0
  while kill -0 -- "-$_sp" 2>/dev/null && [ "$_n" -lt 10 ]; do sleep 1; _n=$((_n + 1)); done
  kill -KILL -- "-$_sp" 2>/dev/null || true
  rm -f "$1/order.pid"
  echo stopped
}
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
        # Stop the order while rescue.sh (the job's main process) is still alive to log and report it; bootout TERMs it.
        STOPPED=$(stop_order "$T/rescue")
        if [ -n "$STOPPED" ]; then _w=0; while [ -f "$T/rescue/order.stop" ] && [ "$_w" -lt 40 ]; do sleep 1; _w=$((_w + 1)); done; fi
        lctl bootout "gui/$(id -u)/music.tess.rescue" >/dev/null 2>&1 || true
        rm -f "$LA/music.tess.rescue.plist"
        [ -n "$STOPPED" ] && echo "An order that had already started was stopped."
        echo "The Tess rescue line is off. Updates will not turn it back on." ;;
      on)
        # Adoption reads a live order, so it fails with no network. A line that was already on must survive that: a person
        # asking for "on" again is not asking to switch their working line off.
        WAS_ON=""
        if [ ! -f "$T/rescue-off" ] && [ -x "$T/rescue/rescue.sh" ] && [ -x "$T/rescue/tess-rescue-verify" ]; then WAS_ON=1; fi
        if [ ! -x "$T/rescue/rescue.sh" ] || ! /bin/zsh "$T/rescue/rescue.sh" --adopt >/dev/null 2>&1; then
          if [ -n "$WAS_ON" ]; then
            echo "Couldn't read the current rescue order. The rescue line was already on, so it was left as it was. Try again when online."
            exit 1
          fi
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
    ORD=$(order_group "$T/rescue")
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
      # "Loaded" is the launchd job. Whether an order is in progress is a different question, and the one a person
      # asking status during a rescue actually has.
      if [ -n "$ORD" ]; then
        echo "Rescue: on, loaded; an order is running now (verifier SHA-256 $FP)"
      else
        echo "Rescue: on, loaded; no order is running (verifier SHA-256 $FP)"
      fi
    else
      echo "Rescue: on, stopped (verifier SHA-256 $FP)"
    fi
    [ -f "$T/reports-off" ] && echo "Reports: off" || echo "Reports: on"
    # Pending means the update did not pop the notice up (a test, or the popup did not run). Print it once.
    # An older script is not limited to the five actions, so it gets the same words the installer uses.
    if [ -f "$T/state/rescue-notice-pending" ]; then
      rm -f "$T/state/rescue-notice-pending"
      touch "$T/state/rescue-notice-shown"
      if [ -f "$T/rescue/rescue.sh" ] && ! grep -q 'grep -qx "tess-rescue 2"' "$T/rescue/rescue.sh"; then
        echo "Rescue notice: this Mac has an older Tess rescue line: orders signed by the owner's offline rescue key can run any script on this Mac as you, without asking."
      else
        echo "Rescue notice: Tess's maintainer can remotely run five Tess actions on this Mac, without asking: check, update, repair, restore Spotify, or uninstall Tess."
        echo "  It accepts only orders signed by the owner's offline rescue key."
      fi
      echo "  Turn it off any time: \"$T/tess\" rescue off"
      echo "  This notice is shown once."
    fi
    # An older script is not limited to the five actions. Repair is not the only place that should say so.
    if [ -f "$T/rescue/rescue.sh" ] && ! grep -q 'grep -qx "tess-rescue 2"' "$T/rescue/rescue.sh"; then
      echo "Rescue format: older (a signed order can run any script as you; tess rescue off stops it)"
    fi
    ;;
  *) echo "usage: tess doctor | report | reports on|off | rescue on|off|log | status | update | repair | uninstall" ;;
esac
