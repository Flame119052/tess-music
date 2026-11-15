#!/bin/sh
# Tess Music install line. The verifier is fetched from main and checked against the pin below; that verifier checks
# the channel installer's signature. A channel or mirror can change the installer but cannot make this Mac run an
# unverified one. A channel with no signed installer refuses: nothing runs.
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

# 2. The channel's installer and its signature. Both must come from the promoted channel; there is no fallback.
code=$(curl -sS -L --max-time 60 -w '%{http_code}' -o "$D/install.sh" "$BASE/$CH/dist/install.sh" 2>/dev/null) || code=000
if [ "$code" = 404 ]; then
  fail "Tess's $CH channel has no signed installer ready, so nothing was installed. Try again after Tess is released for this channel."
elif [ "$code" != 200 ]; then
  fail "Couldn't download Tess's installer (HTTP $code). Check your connection and try again."
fi
curl -fsSL --max-time 60 "$BASE/$CH/dist/install.sig" -o "$D/install.sig" \
  || fail "Tess's installer has no signature on $CH, so nothing was installed."
"$D/tess-verify" "$D/install.sh" "$(tr -d '\n' < "$D/install.sig")" \
  || fail "Tess's installer didn't pass its signature check, so nothing was installed."
TESS_CHANNEL="$CH" TESS_VERIFY="$D/tess-verify" sh "$D/install.sh"
