#!/bin/sh
# Tess Music install line. This file never changes: it hands over to the verifying stub for the chosen channel,
# which checks the verifier it downloads and the installer's signature before anything runs. TESS_CHANNEL=dev uses
# the internal build. Fallback order: the channel's stub, the channel's own installer, then (temporary) main's
# installer for channels that have neither yet.
CH="${TESS_CHANNEL:-stable}"
case "$CH" in stable|beta|dev) ;; *) echo "TESS_CHANNEL must be stable, beta or dev"; exit 1 ;; esac
BASE="https://raw.githubusercontent.com/Flame119052/tess-music"
[ -n "$TESS_TEST" ] && [ -n "$TESS_STUB_BASE" ] && BASE="$TESS_STUB_BASE"
T=$(mktemp) || exit 1
trap 'rm -f "$T"' EXIT
code=$(curl -sS -L --max-time 60 -w '%{http_code}' -o "$T" "$BASE/$CH/dist/stub.sh" 2>/dev/null) || code=000
if [ "$code" = 200 ]; then TESS_CHANNEL="$CH" sh "$T"; exit $?; fi
# Channels published before the verifying stub existed still have the promoted installer.
code=$(curl -sS -L --max-time 60 -w '%{http_code}' -o "$T" "$BASE/$CH/dist/install.sh" 2>/dev/null) || code=000
if [ "$code" = 200 ]; then
  echo "Tess's verified installer isn't on $CH yet; running the channel's installer."
  TESS_CHANNEL="$CH" sh "$T"; exit $?
fi
# TEMPORARY (#77): stable and beta do not have dist/install.sh until the first promote. Removed then; the safety
# gate fails once stable carries the file. Do not extend this to work in progress on main.
echo "Tess's installer isn't on $CH yet; using the temporary installer."
curl -fsSL --max-time 60 "$BASE/main/installer/tess-install.sh" -o "$T" \
  || { echo "Couldn't download Tess's installer. Check your connection and try again."; exit 1; }
TESS_CHANNEL="$CH" sh "$T"
