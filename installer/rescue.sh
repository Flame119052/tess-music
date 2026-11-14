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
# Order format: "tess-rescue 2" / "serial N" / "expires <unix time>" / optional "only <id> <id>..." / "action <name>".
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
serial=$(field serial); expires=$(field expires); only=$(field only); action=$(field action)
case $serial in ''|*[!0-9]*) refuse "$1" ;; esac
case $expires in ''|*[!0-9]*) refuse "$1" ;; esac
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
  repair)          V="$T/bin/patcher/tess-verify"; [ -x "$V" ] || V=; cmd=(/usr/bin/env TESS_CHANNEL="${CH:-stable}" TESS_VERIFY="$V" /bin/sh "$T/installer.sh") ;;
  # the patcher's restore swaps in Spotify's own files as one checked copy (swapApps), never delete-then-copy
  restore-spotify) cmd=(/bin/zsh -c '[ -f "$1/updater.env" ] && . "$1/updater.env"; [ -n "$TESS_CONFIG" ] && export SPICETIFY_CONFIG="$TESS_CONFIG"; exec "$2" restore' _ "$T" "$PATCHER") ;;
  uninstall)       cmd=(/bin/sh "$T/uninstall.sh") ;;
  *) log "rescue order $serial asks for '$action', which isn't one of Tess's rescue actions; refused"; exit 0 ;;
esac
log "running rescue order $serial: $action (from $got)"
if [ -n "$TESS_TEST" ]; then
  echo "test: would run ${cmd[*]}" >> "$LOG"; rc=0
else
  "${cmd[@]}" >> "$LOG" 2>&1 &
  pid=$!
  ( sleep 900; kill $pid 2>/dev/null ) &
  watchdog=$!
  wait $pid; rc=$?
  kill $watchdog 2>/dev/null
fi
log "rescue order $serial finished (exit $rc)"
# tell the inbox it ran, unless reports are off
if [ ! -f "$T/reports-off" ] && [ -n "$id" ] && [ -z "$TESS_TEST" ]; then
  body=$(tail -c 6000 "$LOG" | sed "s|$HOME|~|g" | awk 'BEGIN { ORS = ""; print "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, ""); gsub(/[\001-\037]/, ""); print $0 "\\n" } END { print "\"" }')
  curl -fsS --max-time 30 -H "content-type: application/json" -d "{\"install\":\"$id\",\"kind\":\"rescue\",\"status\":\"order $serial $action exit $rc\",\"body\":$body}" "$INBOX/v1/report" >/dev/null 2>&1
fi
exit 0
