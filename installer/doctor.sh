#!/bin/zsh
# Tess doctor: checks every part of Tess on this Mac, fixes what it safely can, and (unless reports are off) sends a
# health report to the Tess inbox so problems can be seen and fixed remotely.
#   tess doctor            check and fix, print the result
#   tess doctor --report   same, and send the full report now
# The updater runs it by itself: "--auto" after something failed, "--heartbeat" once a day.
# It never deletes anything of Spotify's: the only thing it puts back is Spotify's own interface files, from the
# safety copy Tess made of this exact Spotify version, and only when they are missing.
T="${TESS_HOME:-$HOME/Library/Application Support/Tess}"
[ -f "$T/updater.env" ] && . "$T/updater.env"
CONF="${TESS_CONFIG:-$HOME/.config/tess-patcher}"
[ -n "$TESS_CONFIG" ] && export SPICETIFY_CONFIG="$TESS_CONFIG"
REPO="Flame119052/tess-music"
INBOX="https://tess-music-player.janus.ing"
LA="$HOME/Library/LaunchAgents"
UID_=$(id -u)
MODE="${1:-check}"
OUT=$(mktemp); trap 'rm -f "$OUT"' EXIT
problems=0; fixed=0; st=()
say() { echo "$1" >> "$OUT"; [ "$MODE" = check ] || [ "$MODE" = --report ] && echo "$1"; }
ok() { say "  ✓ $1"; }
bad() { say "  ✕ $1"; problems=$((problems + 1)); }
fix() { say "  ↻ $1"; fixed=$((fixed + 1)); }
loaded() { [ -n "$TESS_TEST" ] && return 0; launchctl print "gui/$UID_/$1" >/dev/null 2>&1; }
load() { [ -n "$TESS_TEST" ] && return 0; launchctl bootstrap "gui/$UID_" "$LA/$1.plist" >/dev/null 2>&1; }

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
    SPOTIFY="$new"; sed -i '' "s|^SPOTIFY=.*|SPOTIFY='$new'|" "$T/updater.env"
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
# halfway through that left Spotify with no interface at all (black window). tools/check-safety.sh enforces this.
swap_apps() {
  _new="$APPS.tess-new"; _old="$APPS.tess-old"
  rm -rf "$_new"
  ditto "$1" "$_new" || { rm -rf "$_new"; return 1; }
  [ -s "$_new/xpui.spa" ] || [ -s "$_new/xpui/index.html" ] || { rm -rf "$_new"; return 1; }
  rm -rf "$_old"
  if [ -d "$APPS" ]; then mv "$APPS" "$_old" || { rm -rf "$_new"; return 1; }; fi
  mv "$_new" "$APPS" || { [ -d "$_old" ] && mv "$_old" "$APPS"; rm -rf "$_new"; return 1; }
  rm -rf "$_old"
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
if [ -d "$HOME/Applications/Tess Mini.app" ] && [ -f "$LA/music.tess.mini.plist" ]; then
  if loaded music.tess.mini; then ok "Tess Mini running"; st+=(mini=ok)
  else load music.tess.mini && fix "restarted Tess Mini"; st+=(mini=restarted); fi
fi
if [ -x "$T/rescue/tess-rescue-verify" ] && [ -f "$LA/music.tess.rescue.plist" ]; then
  if loaded music.tess.rescue; then ok "rescue line ready"; st+=(rescue=ok)
  else load music.tess.rescue && fix "restarted the rescue line"; st+=(rescue=restarted); fi
else st+=(rescue=none); fi

# --- network ----------------------------------------------------------------------------------------------------------
if curl -fsS --max-time 15 -o /dev/null https://api.github.com/zen 2>/dev/null || curl -fsS --max-time 15 -o /dev/null https://raw.githubusercontent.com 2>/dev/null; then ok "can reach updates"
else bad "can't reach GitHub for updates"; st+=(net=down); fi

recent=$(tail -200 "$T/guard.log" 2>/dev/null | grep -iE "fail|mismatch|couldn|bad|error|ignored" | tail -5)
[ -n "$recent" ] && { say "  recent problems in the helper's log:"; echo "$recent" | sed 's/^/    /' | while read -r l; do say "$l"; done; }
say "$problems problem(s), $fixed fixed."

# --- report ------------------------------------------------------------------------------------------------------------
send() {
  [ -f "$T/reports-off" ] && return 0
  local kind=$1 tv=$(cat "$T/state/version" 2>/dev/null)
  { cat "$OUT"; echo; echo "--- guard.log"; tail -120 "$T/guard.log" 2>/dev/null; echo; echo "--- rescue.log"; tail -40 "$T/rescue/rescue.log" 2>/dev/null; echo; echo "--- files"
    ls -la "$APPS" 2>&1; ls "$T" 2>&1; } > "$TMP/body"
  # nothing personal leaves the Mac: home folder, account name, computer name and email addresses are removed
  local me=$(id -un) host=$(scutil --get ComputerName 2>/dev/null)
  sed -i '' "s|$HOME|~|g" "$TMP/body"
  [ ${#me} -ge 3 ] && sed -i '' "s|$me|user|g" "$TMP/body"
  [ -n "$host" ] && sed -i '' "s|$host|this-mac|g" "$TMP/body"
  sed -i '' -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/(email)/g' "$TMP/body"
  local jstr='BEGIN { ORS = ""; print "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, ""); gsub(/[\001-\037]/, ""); print $0 "\\n" } END { print "\"" }'
  printf '{"install":"%s","kind":"%s","tess":"%s","spotify":"%s","macos":"%s","status":%s,"body":%s}' "$ID" "$kind" "$tv" "$SPV" \
    "$(sw_vers -productVersion)" "$(printf '%s' "${st[*]}" | awk "$jstr")" "$(tail -c 20000 "$TMP/body" | awk "$jstr")" > "$TMP/r.json" || return 1
  [ -n "$TESS_TEST" ] && { cp "$TMP/r.json" "$T/last-report.json"; return 0; }
  curl -fsS --max-time 30 -H "content-type: application/json" --data-binary @"$TMP/r.json" "$INBOX/v1/report" >/dev/null 2>&1
}
case "$MODE" in
  --report) send doctor && echo "Report sent. Your install id: $ID" || echo "Couldn't send the report (reports off, or offline)." ;;
  --auto) [ "$problems" -gt 0 ] || [ "$fixed" -gt 0 ] && send problem ;;
  --heartbeat) send heartbeat ;;
esac
exit 0
