#!/bin/sh
# Push theme changes into Spotify and restart it with the debug port open.
set -e
cd "$(dirname "$0")/.."
node tools/build.mjs
node --check theme/Tess/theme.js
spicetify refresh >/dev/null
pkill -x Spotify || true
i=0; while pgrep -x Spotify >/dev/null && [ $i -lt 40 ]; do perl -e 'select(undef,undef,undef,0.25)'; i=$((i+1)); done
open -a Spotify --args --remote-debugging-port=9222
i=0
until [ "$(node tools/cdp.mjs eval '!!document.getElementById("tess-bar")' 2>/dev/null)" = "true" ] || [ $i -ge 80 ]; do
  perl -e 'select(undef,undef,undef,0.5)'; i=$((i+1))
done
node tools/cdp.mjs eval '!!document.getElementById("tess-bar")'
