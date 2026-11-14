#!/bin/sh
# Tess Music install line. The pin below is the trust anchor: the verifier is fetched from main and checked against
# it, and that verifier checks the channel installer's signature. A channel or mirror can change the installer but
# cannot make this Mac run an unverified one. The verifier is rebuilt (and this pin updated) when its source changes.
CH="${TESS_CHANNEL:-stable}"
case "$CH" in stable|beta|dev) ;; *) echo "TESS_CHANNEL must be stable, beta or dev"; exit 1 ;; esac
BASE="https://raw.githubusercontent.com/Flame119052/tess-music"
[ -n "$TESS_TEST" ] && [ -n "$TESS_TEST_BASE" ] && BASE="$TESS_TEST_BASE"
VERIFY_SHA='aedefab8667ec0528829b57f8b9f728133fb446e2fc49533bc2cc03d5d92340e'
[ -n "$TESS_TEST" ] && [ -n "$TESS_VERIFY_SHA" ] && VERIFY_SHA="$TESS_VERIFY_SHA"
D=$(mktemp -d) || exit 1
trap 'rm -rf "$D"' EXIT
fail() { echo "$1"; exit 1; }

# 1. The verifier comes from main and must match the pin above. A channel cannot swap it.
curl -fsSL --max-time 60 "$BASE/main/installer/tess-verify" -o "$D/tess-verify" \
  || fail "Couldn't download Tess's signature checker. Check your connection and try again."
[ "$(shasum -a 256 "$D/tess-verify" | cut -d' ' -f1)" = "$VERIFY_SHA" ] \
  || fail "Tess's signature checker didn't match its published checksum, so nothing was installed."
chmod +x "$D/tess-verify" || fail "Couldn't prepare Tess's signature checker."

# 2. The channel's installer and its signature. A channel with no installer yet (before the first promote, #77) gets
# main's installer; after that the channel's installer must be signed and the fallback goes.
code=$(curl -sS -L --max-time 60 -w '%{http_code}' -o "$D/install.sh" "$BASE/$CH/dist/install.sh" 2>/dev/null) || code=000
if [ "$code" != 200 ]; then
  echo "Tess's installer isn't on $CH yet; using the temporary installer."
  curl -fsSL --max-time 60 "$BASE/main/installer/tess-install.sh" -o "$D/install.sh" \
    || fail "Couldn't download Tess's installer. Check your connection and try again."
  TESS_CHANNEL="$CH" sh "$D/install.sh"
  exit $?
fi
curl -fsSL --max-time 60 "$BASE/$CH/dist/install.sig" -o "$D/install.sig" \
  || fail "Tess's installer has no signature on $CH, so nothing was installed."
"$D/tess-verify" "$D/install.sh" "$(tr -d '\n' < "$D/install.sig")" \
  || fail "Tess's installer didn't pass its signature check, so nothing was installed."
TESS_CHANNEL="$CH" TESS_VERIFY="$D/tess-verify" sh "$D/install.sh"
