#!/bin/sh
# Tess's verifying installer stub, rendered by tools/release.mjs at release time.
# It downloads the verifier and the installer for this channel, checks the verifier's pinned SHA-256, checks the
# installer's Ed25519 signature with it, and only then runs the installer. There is no fallback: if any check fails,
# nothing runs and nothing on the Mac is touched.
CH="${TESS_CHANNEL:-stable}"
case "$CH" in stable|beta|dev) ;; *) echo "TESS_CHANNEL must be stable, beta or dev"; exit 1 ;; esac
BASE="https://raw.githubusercontent.com/Flame119052/tess-music"
[ -n "$TESS_TEST" ] && [ -n "$TESS_STUB_BASE" ] && BASE="$TESS_STUB_BASE"
VERIFY_SHA='__TESS_VERIFY_SHA__'
fail() { echo "$1"; exit 1; }
case "$VERIFY_SHA" in __*) fail "This installer wasn't published (no verifier pin). Use the install line." ;; esac

D=$(mktemp -d) || exit 1
trap 'rm -rf "$D"' EXIT
curl -fsSL --max-time 60 "$BASE/$CH/dist/tess-verify" -o "$D/tess-verify" \
  || fail "Couldn't download Tess's verifier. Check your connection and try again."
[ "$(shasum -a 256 "$D/tess-verify" | cut -d' ' -f1)" = "$VERIFY_SHA" ] \
  || fail "Tess's verifier didn't match its published checksum, so nothing was installed."
chmod +x "$D/tess-verify" || fail "Couldn't prepare Tess's verifier."
curl -fsSL --max-time 60 "$BASE/$CH/dist/install.sh" -o "$D/install.sh" \
  && curl -fsSL --max-time 60 "$BASE/$CH/dist/install.sig" -o "$D/install.sig" \
  || fail "Couldn't download Tess's installer. Check your connection and try again."
"$D/tess-verify" "$D/install.sh" "$(tr -d '\n' < "$D/install.sig")" \
  || fail "Tess's installer didn't pass its signature check, so nothing was installed."
TESS_CHANNEL="$CH" TESS_VERIFY="$D/tess-verify" sh "$D/install.sh"
