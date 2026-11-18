#!/bin/sh
# Compare the vendored Spicetify 2.46.4 files with that upstream release.
# A person runs this. The release does not: tools/release.mjs copies patcher/prebuilt and never
# downloads this archive. The SHA-256 is the archive named in patcher/prebuilt/spicetify-2.46.4/README.md.
set -e
cd "$(dirname "$0")/.."
PIN='d217bcf3b780136d66dee9b3548b3689f6004263a958c57d96ad73d7f6fcdd5b'
URL='https://github.com/spicetify/cli/releases/download/v2.46.4/spicetify-2.46.4-darwin-arm64.tar.gz'
PREBUILT="${TESS_SPICETIFY_PREBUILT:-patcher/prebuilt/spicetify-2.46.4}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -n "${TESS_SPICETIFY_TARBALL-}" ]; then
  arc=$TESS_SPICETIFY_TARBALL
else
  arc=$TMP/src.tar.gz
  curl -fsSL --max-time 180 -o "$arc" "$URL" || { echo "couldn't download $URL" >&2; exit 1; }
fi
got=$(shasum -a 256 "$arc" | cut -d' ' -f1)
if [ "$got" != "$PIN" ]; then
  echo "Spicetify v2.46.4 archive SHA-256 is $got, not $PIN" >&2
  exit 1
fi
mkdir -p "$TMP/out"
tar -xzf "$arc" -C "$TMP/out"
while read -r _sum path; do
  [ -n "$path" ] || continue
  if [ ! -f "$TMP/out/$path" ]; then
    echo "upstream archive has no $path" >&2
    exit 1
  fi
  if ! diff -q "$TMP/out/$path" "$PREBUILT/$path" >/dev/null; then
    echo "vendored $path does not match the upstream archive" >&2
    exit 1
  fi
done < "$PREBUILT/SHA256SUMS"
echo "vendored Spicetify 2.46.4 matches the upstream archive"
