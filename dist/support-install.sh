#!/bin/sh
# Fast Tess Support installer powered by Pi's official standalone binary (~46 MB).
#
# Installs into ~/Library/Application Support/Tess/support/ — never touches ~/.hermes,
# /Applications, or Spotify.app. Verified with official Pi SHA-256 checksums and Tess's
# Ed25519 release signature (tess-verify).
#
#   TESS_SUPPORT_TOKEN=<token> sh support-install.sh
#   sh support-install.sh --uninstall
# >>> tess script guard: keep this block identical in every installer script (issue #107) >>>
# This file used to be able to act on a real Mac when nobody meant it, three ways: being sourced (a shell one-liner
# like `sh -c '. installer/tess-install.sh; …'` ran the whole real installer), having its text handed to a shell to run
# (`sh -c "$(cat installer/tess-install.sh)"`, or `eval` of that text), and being run from a git checkout, whose copy is
# for developing and for sandboxed tests, not for a real install. All three stop here, before anything is read,
# downloaded or changed. The published `curl … | sh` line is none of them: that shell reads the pipe as its own script,
# so it starts with no `-c` and no file to resolve.
_tess_sourced=""
_tess_embedded=""
if [ -n "${ZSH_VERSION-}" ]; then
  # zsh says where it is evaluating: a sourced file ends in ":file", `zsh -c …` and `eval` begin with "cmdarg", and a
  # script run as its own command is exactly "toplevel".
  case ${ZSH_EVAL_CONTEXT-} in
    *:file) _tess_sourced=1 ;;
    cmdarg|cmdarg:*|eval|eval:*|*:eval|*:eval:*) _tess_embedded=1 ;;
  esac
else
  # sh/bash puts a `c` in $- only when the commands were given to the shell as an argument (`sh -c …`), and `return`
  # works in a subshell only when this file was sourced.
  case $- in *c*) _tess_embedded=1 ;; esac
  if (return 0 2>/dev/null); then _tess_sourced=1; fi
fi
# A shell that kept the `-c` out of $- still shows it in its own command line. Only the argument list is compared: a
# piped script's is just "/bin/sh", so the published install line is left alone.
case "$(ps -o args= -p $$ 2>/dev/null) " in *" -c "*) _tess_embedded=1 ;; esac
if [ -n "$_tess_sourced" ]; then
  echo "Tess: this file was sourced, so it did nothing. Tess's installer, updater, doctor, rescue line and uninstaller act only when they are run as their own command, so sourcing one can never install, update, repair or remove anything." >&2
  echo "Tess: run it as its own command (sh ./file or zsh ./file), or use Tess's published install line." >&2
  return 1
fi
if [ -n "$_tess_embedded" ] && [ -z "${TESS_TEST-}" ] && [ "${TESS_REAL_INSTALL-}" != 1 ]; then
  echo "Tess: not run. This file's text was handed to a shell to run, as in sh -c \"...\" or eval, so the file itself is not what runs and its own checks cannot see it. Tess's installer, updater, doctor, rescue line and uninstaller act only when they are run as their own command." >&2
  echo "Tess: run it as its own command (sh ./file or zsh ./file), or use Tess's published install line; TESS_REAL_INSTALL=1 is the deliberate way through." >&2
  exit 1
fi
unset _tess_sourced _tess_embedded
# A development copy sits inside a git checkout or worktree (a .git folder or file somewhere above it). Outside a
# sandbox it must not act on a real Mac: it is not the installed copy, and its parts are not the signed ones users get.
# TESS_TEST=1 is the sandbox (AGENTS.md rule 2); TESS_REAL_INSTALL=1 is a person deliberately letting this exact copy act.
# zsh makes $0 the function's own name inside a function, so the path is taken once, here.
_tess_self=$0
# The home folder can be a symlink (`/tmp` is `/private/tmp`; a sandbox often is), so compare its real path as well.
_tess_home=$(CDPATH= cd -P -- "$HOME" 2>/dev/null && pwd -P) || _tess_home=$HOME
tess_guard_checkout() {
  _tg=$_tess_self
  case $_tg in
    */*) ;;
    # `cd installer && sh tess-install.sh` names no folder, so the folder is the current one. A piped copy
    # (`curl … | sh`) names the shell itself, not a file here, so it takes the branch above and the walk starts outside
    # any checkout: the pipe is allowed by that, not by this branch.
    *) [ -f "./$_tg" ] || return 1; _tg="./$_tg" ;;
  esac
  _tg=$(CDPATH= cd -P -- "$(dirname -- "$_tg")" 2>/dev/null && pwd -P) || return 1
  while [ -n "$_tg" ] && [ "$_tg" != "/" ]; do
    # A dotfiles repository in the home folder (`git init` in ~) is not a copy of Tess.
    [ "$_tg" = "$HOME" ] && return 1
    [ "$_tg" = "$_tess_home" ] && return 1
    [ -e "$_tg/.git" ] && return 0
    _tg=$(dirname -- "$_tg")
  done
  return 1
}
if [ -z "${TESS_TEST-}" ] && [ "${TESS_REAL_INSTALL-}" != 1 ] && tess_guard_checkout; then
  echo "Tess: not run. This copy ($_tg) is inside a git checkout, and a checkout's copy is for developing and for sandboxed tests, not for changing a real Mac." >&2
  echo "Tess: use Tess's published install line, or set TESS_REAL_INSTALL=1 if you really do mean to let this checkout act on this Mac." >&2
  exit 1
fi
# <<< tess script guard <<<
set -eu

token=${TESS_SUPPORT_TOKEN-}
unset TESS_SUPPORT_TOKEN || true

PI_VERSION='1.6.0'
PI_ARM64_URL="https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-darwin-arm64.tar.gz"
PI_ARM64_SHA='6429287b7ae98d726ec577815d14fd680e7c587e89ecc5153b4a145dc4adba33'
PI_X64_URL="https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-darwin-x64.tar.gz"
PI_X64_SHA='5b69cd87c3b00e74cce2d1499df3b7a1ec73632f11abf64696d110f0f4dc4192'

INBOX_DEFAULT='https://tess-music-player.janus.ing'
MODEL_DEFAULT='deepseek-v4.1-flash'

TESS_DIR=${TESS_HOME:-"$HOME/Library/Application Support/Tess"}
SUPPORT_ROOT="$TESS_DIR/support"
VERIFY=${TESS_VERIFY:-}
if [ -z "$VERIFY" ]; then
  if [ -x "$TESS_DIR/bin/patcher/tess-verify" ]; then
    VERIFY="$TESS_DIR/bin/patcher/tess-verify"
  else
    VERIFY="$TESS_DIR/bin/tess-verify"
  fi
fi
PROGRESS_FILE=${TESS_SUPPORT_PROGRESS_FILE-}

die() {
  printf 'Tess Support: %s\n' "$1" >&2
  exit 1
}

progress() {
  [ -n "$PROGRESS_FILE" ] || return 0
  _p_phase=$1 _p_pct=$2 _p_step=$3 _p_detail=${4:-}
  _p_tmp="$PROGRESS_FILE.tmp.$$"
  # Fixed words and measurements only; never paths, tokens, or logs.
  printf '{"phase":"%s","progress":%s,"step":"%s","detail":"%s"}\n' \
    "$_p_phase" "$_p_pct" "$_p_step" "$_p_detail" > "$_p_tmp" 2>/dev/null \
    && mv -f "$_p_tmp" "$PROGRESS_FILE" 2>/dev/null || rm -f "$_p_tmp" 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$SUPPORT_ROOT"
  rm -f "$TESS_DIR/state/.support-invited"
  printf 'Tess Support removed.\n'
  exit 0
fi

# Always use a stable local temp dir (never an ephemeral harness TMPDIR).
work_base=/tmp
[ "${TESS_TEST:-}" = 1 ] && [ -n "${TMPDIR:-}" ] && work_base=$TMPDIR
work=$(mktemp -d "${work_base%/}/tess-pi-support.XXXXXX")
cleanup() { rm -rf "$work" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Check macOS & architecture
if [ "$(uname -s)" != Darwin ] && [ "${TESS_TEST:-}" != 1 ]; then
  die "Tess Support installs on a Mac."
fi
if [ "${TESS_TEST:-}" = 1 ] && [ -n "${TESS_ARCH:-}" ]; then
  arch=$TESS_ARCH
else
  arch=$(uname -m)
fi
case "$arch" in
  arm64) pi_url=$PI_ARM64_URL; pi_sha=$PI_ARM64_SHA; pi_bytes=48128107 ;;
  x86_64) pi_url=$PI_X64_URL; pi_sha=$PI_X64_SHA; pi_bytes=50637824 ;;
  *) die "Unsupported Mac architecture: $arch" ;;
esac
if [ "${TESS_TEST:-}" = 1 ]; then
  [ -n "${TESS_PI_URL:-}" ] && pi_url=$TESS_PI_URL
  [ -n "${TESS_PI_SHA:-}" ] && pi_sha=$TESS_PI_SHA
fi

[ -n "$token" ] || die "Missing support token."
case "$token" in
  *[!A-Za-z0-9._:-]*) die "Support token contains invalid characters." ;;
esac

# Validate inbox origin
inbox=${TESS_INBOX:-$INBOX_DEFAULT}
case "$inbox" in
  https://tess-music-player.janus.ing) ;;
  http://127.0.0.1:*|http://localhost:*)
    [ "${TESS_TEST:-}" = 1 ] || die "Refusing non-Tess inbox address." ;;
  *) die "Refusing unknown inbox address." ;;
esac

# Determine channel (dev/beta/stable) from updater.env (TESS_PARTS_CHANNEL or CHANNEL), defaulting to stable.
channel=stable
if [ -f "$TESS_DIR/updater.env" ]; then
  _ch=$(sed -n "s/^[[:space:]]*TESS_PARTS_CHANNEL=['\"]*\([a-z]*\)['\"]*.*/\1/p" "$TESS_DIR/updater.env" 2>/dev/null | head -n 1)
  [ -z "$_ch" ] && _ch=$(sed -n "s/^[[:space:]]*CHANNEL=['\"]*\([a-z]*\)['\"]*.*/\1/p" "$TESS_DIR/updater.env" 2>/dev/null | head -n 1)
  case "$_ch" in dev|beta|stable) channel=$_ch ;; esac
fi
[ "${TESS_TEST:-}" = 1 ] && [ -n "${TESS_CHANNEL:-}" ] && channel=$TESS_CHANNEL

RAW_BASE=${TESS_COMPONENTS_BASE:-"https://raw.githubusercontent.com/Flame119052/tess-music/$channel/dist"}

allow_url() {
  if [ "${TESS_TEST:-}" = 1 ]; then
    case "$1" in
      http://127.0.0.1:*|http://localhost:*|file://*) return 0 ;;
    esac
  fi
  case "$1" in
    https://github.com/earendil-works/pi/releases/download/*) return 0 ;;
    https://github.com/Flame119052/tess-music/releases/download/*) return 0 ;;
    https://raw.githubusercontent.com/Flame119052/tess-music/*) return 0 ;;
    *) die "Refusing download from untrusted address." ;;
  esac
}

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0
}

fetch_with_progress() {
  _url=$1 _out=$2 _step=$3 _total=$4 _p0=$5 _p1=$6
  allow_url "$_url"
  _proto="=https"
  [ "${TESS_TEST:-}" = 1 ] && _proto="=https,http,file"
  curl -fsSL --proto "$_proto" --connect-timeout 20 --max-time 600 --retry 2 --retry-delay 1 -o "$_out" "$_url" &
  _cpid=$!
  _start=$(date +%s)
  while kill -0 "$_cpid" 2>/dev/null; do
    _now=$(date +%s)
    _got=$(file_size "$_out")
    _el=$((_now - _start))
    [ "$_el" -lt 1 ] && _el=1
    if [ "$_total" -gt 0 ] && [ "$_got" -gt 0 ]; then
      _pct=$(awk -v g="$_got" -v t="$_total" -v a="$_p0" -v b="$_p1" 'BEGIN { f=g/t; if (f>1) f=1; printf "%.3f", a + (b-a)*f }')
      _mb_g=$(awk -v g="$_got" 'BEGIN { printf "%.1f", g/1048576 }')
      _mb_t=$(awk -v t="$_total" 'BEGIN { printf "%.0f", t/1048576 }')
      _spd=$(awk -v g="$_got" -v e="$_el" 'BEGIN { printf "%.1f", (g/1048576)/e }')
      _rem=$(awk -v g="$_got" -v t="$_total" -v e="$_el" 'BEGIN { if (g<=0) { print 0; exit } r=(t-g)/(g/e); if (r<0) r=0; printf "%d", r }')
      if [ "$_rem" -ge 60 ]; then
        _eta="$(( (_rem + 30) / 60 ))m left"
      else
        _eta="~${_rem}s left"
      fi
      progress installing "$_pct" "$_step" "${_mb_g} MB / ${_mb_t} MB · ${_spd} MB/s · ${_eta}"
    else
      progress installing "$_p0" "$_step" "Connecting…"
    fi
    sleep 0.5
  done
  wait "$_cpid" || die "Download failed for $_step."
}

progress installing 0.04 "Checking setup" "Verifying signed release files…"

# 1. Verify Tess signed components list (gives us support-kit and optional tess-record)
[ -x "$VERIFY" ] || die "Tess verifier is missing."
allow_url "$RAW_BASE/components.txt"
allow_url "$RAW_BASE/components.sig"
curl -fsSL --connect-timeout 20 --max-time 60 -o "$work/components.txt" "$RAW_BASE/components.txt" || die "Could not fetch components list."
curl -fsSL --connect-timeout 20 --max-time 60 -o "$work/components.sig" "$RAW_BASE/components.sig" || die "Could not fetch components signature."
"$VERIFY" "$work/components.txt" "$(tr -d '\n' < "$work/components.sig")" || die "Release signature check failed."

kit_sha=$(awk '$1 == "support-kit" { print $2 }' "$work/components.txt")
kit_url=$(awk '$1 == "support-kit" { print $3 }' "$work/components.txt")
[ -n "$kit_sha" ] && [ -n "$kit_url" ] || die "This release channel does not include support-kit yet."

# 2. Download official standalone Pi binary (~46 MB) unless exact version is already installed
reuse_pi=0
if [ -x "$SUPPORT_ROOT/current/bin/pi" ] && [ -f "$SUPPORT_ROOT/current/pi-sha256" ]; then
  if [ "$(cat "$SUPPORT_ROOT/current/pi-sha256" 2>/dev/null)" = "$pi_sha" ]; then
    reuse_pi=1
  fi
fi

stage="$work/stage"
mkdir -p "$stage/bin" "$stage/agent" "$stage/extensions" "$stage/skills" "$stage/scripts"

if [ "$reuse_pi" -eq 1 ]; then
  progress installing 0.72 "Checking Pi runtime" "Already up to date"
  cp -R "$SUPPORT_ROOT/current/bin/"* "$stage/bin/"
else
  fetch_with_progress "$pi_url" "$work/pi.tar.gz" "Downloading Tess Support" "$pi_bytes" 0.08 0.76
  progress installing 0.78 "Verifying download" "Checking official Pi SHA-256…"
  got_pi_sha=$(sha256_of "$work/pi.tar.gz")
  [ "$got_pi_sha" = "$pi_sha" ] || die "Pi download checksum mismatch."
  progress installing 0.82 "Unpacking runtime" "Keeping only the minimal Pi binary…"
  mkdir -p "$work/pi-unpack"
  tar -xzf "$work/pi.tar.gz" -C "$work/pi-unpack"
  pi_src="$work/pi-unpack/pi"
  [ -x "$pi_src/pi" ] || die "Unpacked Pi archive is missing the pi binary."
  cp "$pi_src/pi" "$stage/bin/pi"
  chmod 755 "$stage/bin/pi"
  [ -f "$pi_src/photon_rs_bg.wasm" ] && cp "$pi_src/photon_rs_bg.wasm" "$stage/bin/photon_rs_bg.wasm"
  [ -f "$pi_src/package.json" ] && cp "$pi_src/package.json" "$stage/bin/package.json"
  [ -d "$pi_src/native" ] && cp -R "$pi_src/native" "$stage/bin/native"
fi
printf '%s\n' "$pi_sha" > "$stage/pi-sha256"

# 3. Download & verify Tess support-kit (~15 KB: SOUL.md, tess-visit.ts, 4 skills, privacy.mjs, triage.mjs)
progress installing 0.86 "Installing support skills" "Downloading signed skills and tools…"
allow_url "$kit_url"
curl -fsSL --connect-timeout 20 --max-time 60 -o "$work/support-kit.tar.gz" "$kit_url" || die "Could not download support-kit."
[ "$(sha256_of "$work/support-kit.tar.gz")" = "$kit_sha" ] || die "support-kit checksum mismatch."
tar -xzf "$work/support-kit.tar.gz" -C "$stage"
[ -f "$stage/SOUL.md" ] && [ -f "$stage/extensions/tess-visit.ts" ] || die "support-kit is incomplete."

# 4. Download optional Spotify window recorder (~0.5 MB) if present on this channel
rec_sha=$(awk '$1 == "record" { print $2 }' "$work/components.txt")
rec_url=$(awk '$1 == "record" { print $3 }' "$work/components.txt")
if [ -n "$rec_sha" ] && [ -n "$rec_url" ]; then
  progress installing 0.90 "Adding window recorder" "Verifying signed helper…"
  allow_url "$rec_url"
  if curl -fsSL --connect-timeout 20 --max-time 60 -o "$work/tess-record" "$rec_url"; then
    if [ "$(sha256_of "$work/tess-record")" = "$rec_sha" ]; then
      cp "$work/tess-record" "$stage/bin/tess-record"
      chmod 755 "$stage/bin/tess-record"
    fi
  fi
fi

# 5. Write stripped models.json pointing exclusively to Tess's Worker
cat > "$stage/agent/models.json" <<EOF
{
  "providers": {
    "tess-gate": {
      "baseUrl": "${inbox}/v1/support",
      "api": "openai-completions",
      "apiKey": "\$TESS_SUPPORT_TOKEN",
      "models": [
        {
          "id": "${MODEL_DEFAULT}",
          "name": "Tess Support",
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      ]
    }
  }
}
EOF

# 6. Smoke-check the unpacked Pi binary before swapping into place
progress installing 0.94 "Finishing setup" "Checking Pi runtime…"
if [ "${TESS_TEST:-}" != 1 ]; then
  PI_CODING_AGENT_DIR="$stage/agent" PI_OFFLINE=1 "$stage/bin/pi" --version >/dev/null 2>&1 || die "Pi binary failed startup check."
fi

# 7. Atomically swap staged support folder into place and write token (0600)
mkdir -p "$SUPPORT_ROOT/cache/sessions"
chmod 700 "$SUPPORT_ROOT" "$SUPPORT_ROOT/cache" "$SUPPORT_ROOT/cache/sessions"

# Store token with 0600 permissions before writing installed.json
umask 077
printf '%s\n' "$token" > "$SUPPORT_ROOT/token.tmp"
chmod 600 "$SUPPORT_ROOT/token.tmp"
mv -f "$SUPPORT_ROOT/token.tmp" "$SUPPORT_ROOT/token"
token=""

printf '{"engine":"pi","piVersion":"%s","arch":"%s","channel":"%s"}\n' "$PI_VERSION" "$arch" "$channel" > "$stage/installed.json"

rm -rf "$SUPPORT_ROOT/.incoming" "$SUPPORT_ROOT/.previous"
cp -R "$stage" "$SUPPORT_ROOT/.incoming"
if [ -d "$SUPPORT_ROOT/current" ]; then
  mv "$SUPPORT_ROOT/current" "$SUPPORT_ROOT/.previous"
fi
mv "$SUPPORT_ROOT/.incoming" "$SUPPORT_ROOT/current"
rm -rf "$SUPPORT_ROOT/.previous"

progress done 1.0 "Tess Support is ready" "Open the chat right inside Spotify."
printf 'Tess Support (Pi %s) installed.\n' "$PI_VERSION"
