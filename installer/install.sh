#!/bin/sh
# Tess Music install line:
#   curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/install.sh | sh
# This stub never changes. It runs the installer from the last promoted (public) release, so work in progress on
# main never reaches anyone's Mac before it has been tried and promoted. TESS_CHANNEL=dev uses the internal build.
CH="${TESS_CHANNEL:-stable}"
case "$CH" in stable|beta|dev) ;; *) echo "TESS_CHANNEL must be stable, beta or dev"; exit 1 ;; esac
T=$(mktemp) || exit 1
trap 'rm -f "$T"' EXIT
curl -fsSL --max-time 60 "https://raw.githubusercontent.com/Flame119052/tess-music/$CH/dist/install.sh" -o "$T" \
  || curl -fsSL --max-time 60 "https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/tess-install.sh" -o "$T" \
  || { echo "Couldn't download Tess's installer. Check your connection and try again."; exit 1; }
TESS_CHANNEL="$CH" sh "$T"
