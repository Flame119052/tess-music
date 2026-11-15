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
# "rescue.sh --adopt" only records the current order as already seen.
# Order format: "tess-rescue 2" / "serial N" / "expires <unix time>" / optional "only <id> <id>..." / optional
# "timeout <seconds>" (60-3600, default 1800) / "action <name>".
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
log "running rescue order $serial: $action (from $got, up to ${timeout}s)"
# Only the lines this order writes are reported, so note where the log ends now, before anything has run.
offset=$(wc -c < "$LOG" 2>/dev/null || echo 0)
# TESS_TEST logs what would run; TESS_TEST_RUN makes the sandbox actually run it, against the sandbox's own stand-in tools
if [ -n "$TESS_TEST" ] && [ -z "$TESS_TEST_RUN" ]; then
  echo "test: would run ${cmd[*]}" >> "$LOG"; rc=0
else
  started=$(date +%s)
  "${cmd[@]}" >> "$LOG" 2>&1 &
  pid=$!
  # The limit is enforced by a short poll rather than one long sleep, so nothing of this order is still running after it
  # has finished. The stop is logged here rather than in the poll, because the poll is killed the moment the action dies.
  (
    waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$timeout" ]; do sleep 1; waited=$((waited + 1)); done
    kill "$pid" 2>/dev/null
  ) &
  watchdog=$!
  wait "$pid"; rc=$?
  kill "$watchdog" 2>/dev/null
  if [ $(( $(date +%s) - started )) -ge "$timeout" ]; then log "rescue order $serial ran past ${timeout}s; stopped it"; fi
fi
log "rescue order $serial finished (exit $rc)"
# tell the inbox it ran, unless reports are off. Only this order's own lines, through the one privacy filter, and only
# when the install id really is a Tess id (it is pasted into JSON here).
if [ ! -f "$T/reports-off" ] && [ -n "$id" ] && printf '%s' "$id" | grep -qx '[0-9a-f]\{32\}'; then
  body=$(tail -c +"$((offset + 1))" "$LOG" 2>/dev/null | tail -c 6000 | tess_redact | awk 'BEGIN { ORS = ""; print "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, ""); gsub(/[\001-\037]/, ""); print $0 "\\n" } END { print "\"" }')
  report="{\"install\":\"$id\",\"kind\":\"rescue\",\"status\":\"order $serial $action exit $rc\",\"body\":$body}"
  if [ -n "$TESS_TEST" ]; then
    # a sandbox keeps the report in its own folder instead of sending it, so a test can read what would have gone out
    printf '%s' "$report" > "$R/order-report.json"
  else
    curl -fsS --max-time 30 -H "content-type: application/json" -d "$report" "$INBOX/v1/report" >/dev/null 2>&1
  fi
fi
exit 0
