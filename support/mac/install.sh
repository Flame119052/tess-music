#!/bin/sh
# One command for Tess Support on a person's Mac (D-105, #121).
#
#   curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh
#
# The support code is read from TESS_SUPPORT_TOKEN or typed at /dev/tty. It is never an argument.
# Apple Silicon: the bundled Hermes.app, checksum then codesign and spctl, and only then Applications.
# Intel: Hermes's command-line installer, pinned to one commit. That installer then downloads Hermes
# and its Python packages without its own pins. The Dock icon opens the same chat in the browser.
# Safe to run again. --uninstall removes this profile, a half-finished swap, this icon, and this Dock tile:
#
#   curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh -s -- --uninstall
#
# The profile files are the ones distribution.yaml lists, the same list install.mjs copies. This script cannot use
# install.mjs: a person's Mac may not have node. It downloads a pinned Node.js and keeps only bin/node under the
# profile, so a visit does not use a node from PATH. HERMES_HOME follows install.mjs's rule: a real install uses
# ~/.hermes, a test refuses the login home, and both refuse a symlink. --uninstall removes that Node with the profile,
# and also .tess-support.previous and .tess-support.incoming. A reinstall keeps every top-level item this installer
# does not own, so the person's chat history stays. It replaces the listed files, .env, and the Node runtime.
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
# Copy the code out of the environment before mktemp or any other program can see it.
token=${TESS_SUPPORT_TOKEN-}
unset TESS_SUPPORT_TOKEN || true

FEED_URL=https://hermes-assets.nousresearch.com/releases/darwin/stable/stable-mac.yml
ASSET_ORIGIN=https://hermes-assets.nousresearch.com
# v0.23.2's scripts/install.sh at the commit the tag points at (ae2a81cc, 19 Nov 2026). A tag can move.
# The hash is checked before it runs. That script then downloads Hermes and its Python packages with no pins of its own.
CLI_URL=https://raw.githubusercontent.com/NousResearch/hermes-agent/ae2a81ccc00e9b7c06301523e5bb09608397149c/scripts/install.sh
CLI_SHA=c73dad4dcf7c9ecadb98578e28cc763d23d7be3fa1b513545319038795493214
# Nous Research's Apple team and the bundle identifier. codesign -dvv on Hermes Agent.app inside the
# read-only mount of HermesBundled-0.22.0-mac-arm64.dmg (the arm64 image named in stable-mac.yml on 19 Nov 2026).
# The published SHA-512 matched. The image was unmounted and deleted. It was not copied into /Applications.
HERMES_TEAM='763K57MW7Z'
HERMES_ID='com.nousresearch.hermes-bundled'
# The same minimum distribution.yaml names. A checkout whose file disagrees is refused.
HERMES_REQUIRES='>=0.22.0'
# >>> support profile pins >>>
PROFILE_COMMIT=f98cfc17b7d2fea7fc3946af2dc6aa135f1a3353
PROFILE_PINS='
support/mac/config.yaml 7f7ed106b34a83666281084295e685d6e64c90c92cbaf3700a57f29687535341
support/mac/distribution.yaml eadfc479acbfbba4ea2a628e2786b32e5370294e7162d185de0a8d6b06f32bd4
support/mac/SOUL.md 44df084838b8212d6b61f2dd1652e26d937b8c3f19d9470b1ac379ed550f258d
support/mac/skills/tess-evidence/SKILL.md be7d6435be3a2a0ce9ef1ad1f19d0e14129c2376e887d055c825c41ae4005540
support/mac/skills/tess-evidence/scripts/spotify-window.mjs f5d5c8b9d8901d8da2290f47f1d82e5ae9a5ccfcd0b19eb7f16e4b4d33edf3f5
support/mac/skills/tess-gather/SKILL.md d21be1c58227e2776d27685752224fb95268bc05fc34315a199a4bba3fd11722
support/mac/skills/tess-gather/scripts/doctor.mjs 0fae204654e8e0d3e94858a241291813c1c1ef9b5c7083b1a1b246e00d93e85e
support/mac/skills/tess-handoff/SKILL.md dae977620d82a3b2254f69280e239c89d37c0a68f0a420f57f6638f24c4d9a9e
support/mac/skills/tess-handoff/scripts/triage-inbox.mjs 8d7ab61be0eaa4a68d6b52e9ee689ebcd0ee5195047dd614c39d5408cdc0383a
support/mac/skills/tess-support/SKILL.md 0a6bac9ca40354738ebe3b20d6ca7615a0459164770ffda54eb1b7a6bfc65404
support/mac/plugins/tess-visit/__init__.py b55102c772535f620513348f67e62e4dcfc442a2509092c73b7cbc6539bf8ba2
support/mac/plugins/tess-visit/plugin.yaml 0bac423e3497ce06d27355aa44df5b1fa562c962aedb75d7ac302cf7aedb49fc
support/bot/skills/tess-support/scripts/privacy.mjs 180b494458c0c984f3f62f4b10dc0a75f543a28dc681b25093e99e064de95c51
support/bot/skills/tess-support/scripts/triage.mjs 89196e4117d2bec8052ba6d0f383f8bf62aac116c6860de8fe21f23e8aeacd77
support/bot/skills/tess-support/scripts/inbox.mjs 0914d20381b9f4655e8ffc308aaf073258e970f523691b929a3cad3ef015ed26
support/bot/skills/tess-support/scripts/session.mjs 01e0447a8ab88163ae478dc60e3a330665ea834c275a8177dc949f5f13aebe99
'
# <<< support profile pins <<<
PROFILE_ORIGIN=https://raw.githubusercontent.com/Flame119052/tess-music/$PROFILE_COMMIT
INBOX_DEFAULT=https://tess-music-player.janus.ing
# The window recorder is a Tess release part. Its SHA-256 comes from the stable
# channel's signed components list, verified with the release public key by the
# pinned Node this installer already downloads — the same trust the updater gets
# from tess-verify, with no second binary to ship first. A channel too old to
# have the part is fine: the visit then takes a still only.
COMPONENTS_ORIGIN=https://raw.githubusercontent.com/Flame119052/tess-music/stable/dist
RELEASE_KEY_X='XOYW72EMGoUz6Km-BpIgzTdliV6VzywqMmALhAdr1ws'
# Current LTS (Lithium). The darwin tarball's bin/node links only macOS system libraries.
NODE_VERSION=v26.13.1
NODE_ORIGIN=https://nodejs.org
NODE_SHA_ARM64=aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735
NODE_SHA_X64=82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

# Percent-encode a path for a Dock file URL. The token is never passed here.
file_url() {
  printf 'file://'
  printf '%s/' "$1" | /usr/bin/od -An -tu1 | tr -s ' ' '\n' | while IFS= read -r byte; do
    [ -n "${byte:-}" ] || continue
    if [ "$byte" -eq 45 ] || [ "$byte" -eq 46 ] || [ "$byte" -eq 47 ] || [ "$byte" -eq 95 ] || [ "$byte" -eq 126 ] \
      || { [ "$byte" -ge 48 ] && [ "$byte" -le 57 ]; } \
      || { [ "$byte" -ge 65 ] && [ "$byte" -le 90 ]; } \
      || { [ "$byte" -ge 97 ] && [ "$byte" -le 122 ]; }; then
      oct=$(printf '%03o' "$byte")
      printf "\\$oct"
    else
      printf '%%%02X' "$byte"
    fi
  done
}

login_home() {
  user=$(/usr/bin/id -un)
  case $user in
    *[!A-Za-z0-9._-]*) return 0 ;;
  esac
  line=$(/usr/bin/dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null || true)
  # sh rejects a case pattern that contains a colon inside this substitution.
  found=$(printf '%s\n' "$line" | sed -n 's/^NFSHomeDirectory:[[:space:]]*//p' | head -1)
  if [ -n "$found" ]; then
    printf '%s\n' "$found"
    return 0
  fi
  # macOS names the home through dscl. A Linux test has no Directory Service;
  # the passwd entry is the same directory the checks refuse to touch.
  if command -v getent >/dev/null 2>&1; then
    getent passwd "$user" | awk -F: 'NR == 1 { print $6 }'
  fi
}

inside() {
  [ "$1" = "$2" ] || [ "${1#"$2"/}" != "$1" ]
}

physical() {
  (CDPATH= cd -- "$1" && pwd -P)
}

# mkdir follows a symlink in an ancestor. Resolve the part that already exists, and decide from
# that path, before any directory is created.
predict() {
  chosen_path=$1
  cur=$chosen_path
  while [ ! -e "$cur" ] && [ ! -L "$cur" ]; do
    parent=$(dirname -- "$cur")
    [ "$parent" = "$cur" ] && break
    cur=$parent
  done
  if [ -d "$cur" ] || [ -L "$cur" ]; then
    base=$(physical "$cur") || die "Could not resolve $cur."
  else
    base=$cur
  fi
  case $chosen_path in
    "$cur") printf '%s\n' "$base" ;;
    "$cur"/*) printf '%s\n' "$base/${chosen_path#"$cur"/}" ;;
    *) die "Could not resolve $chosen_path." ;;
  esac
}

require_test_fakes() {
  tool=$1
  found=$(command -v "$tool" || true)
  case $found in
    /usr/bin/"$tool"|/bin/"$tool"|"") die "A test run would call the real $tool. It stopped." ;;
  esac
}

# A test sets TESS_TEST=1 and scratch folders. A person's Mac does not.
prepare_places() {
  # A person's install is a Mac. The sandbox (TESS_TEST=1) also runs on Linux, with the
  # disk tools faked, and it must still refuse the real home before it creates anything.
  if [ "$(uname -s)" != Darwin ] && [ "${TESS_TEST:-}" != 1 ]; then
    die "Tess Support installs on a Mac."
  fi
  if [ "${TESS_TEST:-}" = 1 ] && [ -n "${TESS_ARCH:-}" ]; then
    arch=$TESS_ARCH
  else
    arch=$(uname -m)
  fi
  case $arch in
    arm64|x86_64) ;;
    *) die "This Mac is not supported. Tess Support needs Apple Silicon or a 64-bit Intel Mac." ;;
  esac

  if [ "${TESS_TEST:-}" = 1 ]; then
    [ -n "${HOME:-}" ] || die "Set HOME to a scratch folder."
    [ -n "${HERMES_HOME:-}" ] || die "Set HERMES_HOME to a scratch folder."
    [ -n "${TESS_APPLICATIONS:-}" ] || die "Set TESS_APPLICATIONS to a scratch folder."
    case $TESS_APPLICATIONS in
      /Applications|/Applications/*) die "Refusing the real Applications folder." ;;
    esac
    apps=$TESS_APPLICATIONS
  else
    if [ -z "${HERMES_HOME:-}" ]; then
      HERMES_HOME=$HOME/.hermes
    fi
    apps=/Applications
  fi

  case $HERMES_HOME in
    /*) ;;
    *) die "HERMES_HOME must be a full path." ;;
  esac
  while :; do
    case $HERMES_HOME in
      ?*/) HERMES_HOME=${HERMES_HOME%/} ;;
      *) break ;;
    esac
  done
  chosen=$HERMES_HOME
  [ -L "$chosen" ] && die "HERMES_HOME is a symlink. Refusing to follow it."

  # Refuse a real home before creating anything. A symlink is checked again after mkdir.
  login=$(login_home || true)
  if [ "${TESS_TEST:-}" != 1 ] && [ -n "${login:-}" ] && inside "$chosen" "$login" && [ "$chosen" != "$login/.hermes" ]; then
    die "HERMES_HOME is inside the real home folder ($login) but is not ~/.hermes."
  fi
  if [ "${TESS_TEST:-}" = 1 ]; then
    if [ -n "${login:-}" ]; then
      inside "$HOME" "$login" && die "HOME is inside the real home folder ($login). Use a scratch directory."
      inside "$HERMES_HOME" "$login" && die "HERMES_HOME is inside the real home folder ($login). Use a scratch directory."
      inside "$apps" "$login" && die "TESS_APPLICATIONS is inside the real home folder ($login). Use a scratch directory."
    fi
    for tool in curl hdiutil spctl codesign defaults killall; do
      require_test_fakes "$tool"
    done
  fi

  # Resolve ancestors before creating anything. A symlink above a missing folder would otherwise
  # be created inside the symlink's target, and the check would run too late.
  home_real=$(predict "$HOME")
  hermes_real=$(predict "$HERMES_HOME")
  apps_real=$(predict "$apps")
  if [ "${TESS_TEST:-}" = 1 ] && inside "$apps_real" "/Applications"; then
    die "Refusing the real Applications folder."
  fi
  if [ "${TESS_TEST:-}" != 1 ] && [ -n "${login:-}" ] && inside "$hermes_real" "$login" && [ "$chosen" != "$login/.hermes" ]; then
    die "HERMES_HOME is inside the real home folder ($login) but is not ~/.hermes."
  fi
  if [ "${TESS_TEST:-}" = 1 ] && [ -n "${login:-}" ]; then
    inside "$home_real" "$login" && die "HOME is inside the real home folder ($login). Use a scratch directory."
    inside "$hermes_real" "$login" && die "HERMES_HOME is inside the real home folder ($login). Use a scratch directory."
    inside "$apps_real" "$login" && die "TESS_APPLICATIONS is inside the real home folder ($login). Use a scratch directory."
  fi

  # A later run must not replace a profile name the person chose after the first install.
  # Recorded before any directory is created, so a refused code still counts as a fresh install.
  created_home=0
  if [ ! -e "$HERMES_HOME" ]; then
    created_home=1
  fi
  marker=$HERMES_HOME/tess-support-we-installed
  profile=$HERMES_HOME/profiles/tess-support
  support_app=$HOME/Applications/Tess\ Support.app
}

# Create the folders only after the code, the inbox, Node, the profile files, and the Hermes download have been checked.
# --uninstall never creates a missing HERMES_HOME.
ensure_places() {
  if [ "${1:-}" = "uninstall" ]; then
    if [ -e "$HOME" ] || [ -L "$HOME" ]; then
      HOME=$(physical "$HOME") || die "Could not resolve HOME."
    fi
    if [ -L "$HERMES_HOME" ]; then
      die "HERMES_HOME is a symlink. Refusing to follow it."
    fi
    if [ -e "$HERMES_HOME" ]; then
      HERMES_HOME=$(physical "$HERMES_HOME") || die "Could not resolve HERMES_HOME."
    fi
    if [ -e "$apps" ] || [ -L "$apps" ]; then
      apps=$(physical "$apps") || die "Could not resolve Applications."
    fi
  else
    mkdir -p "$HOME" "$HERMES_HOME" "$apps"
    [ -L "$chosen" ] && die "HERMES_HOME is a symlink. Refusing to follow it."
    HOME=$(physical "$HOME") || die "Could not resolve HOME."
    HERMES_HOME=$(physical "$HERMES_HOME") || die "Could not resolve HERMES_HOME."
    apps=$(physical "$apps") || die "Could not resolve Applications."
  fi
  if [ "${TESS_TEST:-}" = 1 ] && inside "$apps" "/Applications"; then
    die "Refusing the real Applications folder."
  fi
  if [ "${TESS_TEST:-}" != 1 ] && [ -n "${login:-}" ] && [ -e "$HERMES_HOME" ] && inside "$HERMES_HOME" "$login" && [ "$chosen" != "$login/.hermes" ]; then
    die "HERMES_HOME is inside the real home folder ($login) but is not ~/.hermes."
  fi
  if [ "${TESS_TEST:-}" = 1 ] && [ -n "${login:-}" ]; then
    inside "$HOME" "$login" && die "HOME is inside the real home folder ($login). Use a scratch directory."
    if [ -e "$HERMES_HOME" ]; then
      inside "$HERMES_HOME" "$login" && die "HERMES_HOME is inside the real home folder ($login). Use a scratch directory."
    fi
    if [ -e "$apps" ]; then
      inside "$apps" "$login" && die "TESS_APPLICATIONS is inside the real home folder ($login). Use a scratch directory."
    fi
  fi
  export HOME HERMES_HOME
  marker=$HERMES_HOME/tess-support-we-installed
  profile=$HERMES_HOME/profiles/tess-support
  support_app=$HOME/Applications/Tess\ Support.app
}

allow_url() {
  case $1 in
    "$ASSET_ORIGIN"/*|"$CLI_URL"|"$PROFILE_ORIGIN"/*|"$NODE_ORIGIN"/dist/*|"$COMPONENTS_ORIGIN"/*|"https://github.com/Flame119052/tess-music/releases/download/"*) ;;
    *) die "Refusing a download from an unknown address." ;;
  esac
}

fetch() {
  allow_url "$2"
  curl -fsSL --proto '=https' --retry 2 --retry-delay 1 -o "$1" "$2"
}

is_sha256() {
  printf '%s' "$1" | grep -Eq '^[0-9a-f]{64}$'
}

sha256_file() {
  /usr/bin/openssl dgst -sha256 "$1" | awk '{ print $NF }'
}

# A test may point the Intel installer pin at the stub the sandbox serves.
apply_cli_test_pins() {
  [ "${TESS_TEST:-}" = 1 ] || return 0
  if [ -n "${TESS_HERMES_CLI_SHA:-}" ]; then
    is_sha256 "$TESS_HERMES_CLI_SHA" || die "TESS_HERMES_CLI_SHA is not a SHA-256."
    CLI_SHA=$TESS_HERMES_CLI_SHA
  fi
}

shell_quote() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/"
}

hermes_need() {
  case $HERMES_REQUIRES in
    '>='[0-9]*.[0-9]*.[0-9]*) printf '%s\n' "${HERMES_REQUIRES#>=}" ;;
    *) die "The Hermes version this installer asks for is not one it can check." ;;
  esac
}

version_at_least() {
  awk -v have="$1" -v need="$2" 'BEGIN {
    n = split(have, a, ".")
    m = split(need, b, ".")
    if (n < 3 || m < 3) exit 2
    for (i = 1; i <= 3; i++) {
      if ((a[i] + 0) > (b[i] + 0)) exit 0
      if ((a[i] + 0) < (b[i] + 0)) exit 1
    }
    exit 0
  }'
}

# distribution.yaml beside this file is the checkout. A piped copy has no file there.
same_requirement() {
  yaml=$(dirname -- "$0")/distribution.yaml
  [ -f "$yaml" ] || return 0
  got=$(awk -F'"' '/^hermes_requires:/ { print $2; exit }' "$yaml")
  [ "$got" = "$HERMES_REQUIRES" ] || die "distribution.yaml asks for a different Hermes than this installer pins."
}

app_version() {
  plist_buddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null | tr -d '[:space:]' || true
}

# The Dock's PATH is only /usr/bin:/bin:/usr/sbin:/sbin, so the launcher gets a full path.
resolve_hermes_cli() {
  hermes_cli=
  if [ -x "$HOME/.local/bin/hermes" ]; then
    hermes_cli=$HOME/.local/bin/hermes
    return 0
  fi
  found=$(command -v hermes 2>/dev/null || true)
  case $found in
    /*)
      if [ -x "$found" ]; then
        hermes_cli=$found
        return 0
      fi
      ;;
  esac
  for bundle in "$apps/Hermes.app" "$apps/Hermes Agent.app"; do
    [ -d "$bundle" ] || continue
    for candidate in \
      "$bundle/Contents/Resources/agent-payload/bin/hermes" \
      "$bundle/Contents/MacOS/hermes" \
      "$bundle/Contents/Resources/hermes"
    do
      if [ -f "$candidate" ] && [ -x "$candidate" ]; then
        hermes_cli=$candidate
        return 0
      fi
    done
  done
  return 1
}

cli_version() {
  case $hermes_cli in
    "$apps/Hermes.app"/*)
      app_version "$apps/Hermes.app"
      return 0
      ;;
    "$apps/Hermes Agent.app"/*)
      app_version "$apps/Hermes Agent.app"
      return 0
      ;;
  esac
  out=$("$hermes_cli" --version 2>/dev/null || true)
  printf '%s\n' "$out" | sed -n 's/[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -1
}

require_hermes_cli() {
  if ! resolve_hermes_cli; then
    die "Hermes is already on this Mac, but Tess Support could not find its hermes command. Install the Hermes command line, then paste this command again."
  fi
  case $hermes_cli in
    /*) ;;
    *) die "Hermes is already on this Mac, but Tess Support could not find its hermes command. Install the Hermes command line, then paste this command again." ;;
  esac
  ver=$(cli_version)
  need=$(hermes_need)
  if [ -z "$ver" ] || ! version_at_least "$ver" "$need"; then
    die "This Hermes is ${ver:-unknown}. Tess Support needs Hermes $need or newer."
  fi
}

# A test may point the pins at a fake archive. A real install ignores those variables.
apply_node_test_pins() {
  [ "${TESS_TEST:-}" = 1 ] || return 0
  if [ -n "${TESS_NODE_VERSION:-}" ]; then
    case $TESS_NODE_VERSION in
      *[!0-9v.]*) die "TESS_NODE_VERSION is not a Node version." ;;
      v*.*.*) NODE_VERSION=$TESS_NODE_VERSION ;;
      *) die "TESS_NODE_VERSION is not a Node version." ;;
    esac
  fi
  if [ -n "${TESS_NODE_SHA_ARM64:-}" ]; then
    is_sha256 "$TESS_NODE_SHA_ARM64" || die "TESS_NODE_SHA_ARM64 is not a SHA-256."
    NODE_SHA_ARM64=$TESS_NODE_SHA_ARM64
  fi
  if [ -n "${TESS_NODE_SHA_X64:-}" ]; then
    is_sha256 "$TESS_NODE_SHA_X64" || die "TESS_NODE_SHA_X64 is not a SHA-256."
    NODE_SHA_X64=$TESS_NODE_SHA_X64
  fi
}

runtime_current() {
  [ -f "$runtime_dir/VERSION" ] || return 1
  [ -f "$runtime_dir/bin/node" ] || return 1
  [ -L "$runtime_dir" ] && return 1
  [ -L "$runtime_dir/bin" ] && return 1
  [ -L "$runtime_dir/bin/node" ] && return 1
  have=$(tr -d '[:space:]' < "$runtime_dir/VERSION")
  [ "$have" = "$NODE_VERSION" ]
}

# Download and check in $work. A mismatch returns before HERMES_HOME exists and before Hermes is installed.
stage_node() {
  apply_node_test_pins
  runtime_dir=$profile/runtime/node
  node_skip=0
  if runtime_current; then
    node_skip=1
    return 0
  fi
  case $arch in
    arm64) node_arch=arm64; node_sha=$NODE_SHA_ARM64 ;;
    x86_64) node_arch=x64; node_sha=$NODE_SHA_X64 ;;
    *) die "This Mac is not supported. Tess Support needs Apple Silicon or a 64-bit Intel Mac." ;;
  esac
  is_sha256 "$node_sha" || die "The Node checksum in this installer is not a SHA-256."
  node_name="node-${NODE_VERSION}-darwin-${node_arch}.tar.gz"
  base="$NODE_ORIGIN/dist/$NODE_VERSION"
  fetch "$work/SHASUMS256.txt" "$base/SHASUMS256.txt"
  published=$(awk -v name="$node_name" '$2 == name { print $1; exit }' "$work/SHASUMS256.txt")
  if [ "$published" != "$node_sha" ]; then
    die "The Node checksum in this installer does not match Node's published list. Nothing was unpacked into the profile."
  fi
  fetch "$work/node.tar.gz" "$base/$node_name"
  got=$(/usr/bin/openssl dgst -sha256 "$work/node.tar.gz" | awk '{ print $NF }')
  if [ "$got" != "$node_sha" ]; then
    die "The Node download did not match the checksum. Nothing was unpacked into the profile."
  fi
  tar -tzf "$work/node.tar.gz" > "$work/node-members"
  member=
  count=0
  while IFS= read -r path; do
    case $path in
      */bin/node)
        count=$((count + 1))
        member=$path
        ;;
    esac
  done < "$work/node-members"
  if [ "$count" != 1 ]; then
    die "The Node archive did not contain exactly one bin/node. Nothing was unpacked into the profile."
  fi
  case $member in
    /*|*..*) die "The Node archive had an unsafe path. Nothing was unpacked into the profile." ;;
  esac
  kind=$(tar -tvzf "$work/node.tar.gz" "$member" | awk 'NR==1 { print substr($1, 1, 1); exit }')
  if [ "$kind" != "-" ]; then
    die "The Node archive's bin/node is not a plain file. Nothing was unpacked into the profile."
  fi
  rm -rf "$work/node-src"
  mkdir -p "$work/node-src"
  tar -xzf "$work/node.tar.gz" -C "$work/node-src" "$member"
  srcfile=$work/node-src/$member
  if [ ! -f "$srcfile" ] || [ -L "$srcfile" ] || [ ! -s "$srcfile" ]; then
    die "The Node archive did not unpack bin/node. Nothing was unpacked into the profile."
  fi
}

# The window recorder, checked before any folder moves. TESS_RECORD_TEST_FILE is
# the sandbox's stand-in: a real install never sets it.
stage_record() {
  record_file=
  if [ "${TESS_TEST:-}" = 1 ] && [ -n "${TESS_RECORD_TEST_FILE:-}" ]; then
    if [ ! -f "$TESS_RECORD_TEST_FILE" ] || [ -L "$TESS_RECORD_TEST_FILE" ]; then
      die "TESS_RECORD_TEST_FILE is not a file."
    fi
    record_file=$TESS_RECORD_TEST_FILE
    return 0
  fi
  key_x=$RELEASE_KEY_X
  if [ "${TESS_TEST:-}" = 1 ] && [ -n "${TESS_TEST_RELEASE_KEY_X:-}" ]; then
    key_x=$TESS_TEST_RELEASE_KEY_X
  fi
  fetch "$work/components.txt" "$COMPONENTS_ORIGIN/components.txt"
  fetch "$work/components.sig" "$COMPONENTS_ORIGIN/components.sig"
  node_bin=${srcfile:-}
  if [ -z "$node_bin" ] || [ ! -f "$node_bin" ]; then
    node_bin=$profile/runtime/node/bin/node
  fi
  if [ ! -x "$node_bin" ]; then
    die "The pinned Node is missing, so the components list cannot be checked."
  fi
  "$node_bin" -e 'const{createPublicKey,verify}=require("crypto");const fs=require("fs");const key=createPublicKey({key:{kty:"OKP",crv:"Ed25519",x:process.argv[3]},format:"jwk"});const ok=verify(null,fs.readFileSync(process.argv[1]),key,Buffer.from(fs.readFileSync(process.argv[2],"utf8").trim(),"base64"));process.exit(ok?0:1)' "$work/components.txt" "$work/components.sig" "$key_x" || die "The release components list failed its signature."
  record_line=$(awk '$1 == "record" { print $2, $3; exit }' "$work/components.txt")
  if [ -z "$record_line" ]; then
    return 0
  fi
  record_sha=$(printf '%s\n' "$record_line" | awk '{ print $1 }')
  record_url=$(printf '%s\n' "$record_line" | awk '{ print $2 }')
  is_sha256 "$record_sha" || die "The record part in the components list has no SHA-256."
  case $record_url in
    *..*) die "Refusing a record download from an unknown address." ;;
    https://github.com/Flame119052/tess-music/releases/download/*) ;;
    *) die "Refusing a record download from an unknown address." ;;
  esac
  fetch "$work/tess-record" "$record_url"
  got=$(sha256_file "$work/tess-record")
  if [ "$got" != "$record_sha" ]; then
    die "The window recorder download did not match its checksum. Nothing was unpacked into the profile."
  fi
  record_file=$work/tess-record
}

# The new profile and its Node are built together, so a failed swap does not leave one without the other.
place_node() {
  dest=$1
  if [ "$node_skip" = 1 ]; then
    if [ -e "$profile/runtime" ]; then
      if [ -L "$profile/runtime" ] || [ ! -d "$profile/runtime" ]; then
        die "The Node runtime path is a symlink. Refusing to follow it."
      fi
      cp -R "$profile/runtime" "$dest/runtime"
    fi
    return 0
  fi
  if [ -z "${srcfile:-}" ] || [ ! -f "$srcfile" ] || [ -L "$srcfile" ]; then
    die "Node was not downloaded. Nothing was unpacked into the profile."
  fi
  mkdir -p "$dest/runtime/node/bin"
  cp "$srcfile" "$dest/runtime/node/bin/node"
  chmod 755 "$dest/runtime/node/bin/node"
  printf '%s\n' "$NODE_VERSION" > "$dest/runtime/node/VERSION"
}

# place_record runs after place_node so a reused runtime folder is already in
# place; an older install with no recorder simply gains runtime/bin here.
place_record() {
  dest=$1
  [ -z "${record_file:-}" ] && return 0
  mkdir -p "$dest/runtime/bin"
  cp "$record_file" "$dest/runtime/bin/tess-record"
  chmod 755 "$dest/runtime/bin/tess-record"
}

read_token() {
  if [ -z "${token:-}" ]; then
    [ -r /dev/tty ] || die "Run this from Terminal. It will ask for the code Krish gave you."
    printf 'Enter the code Krish gave you: ' >/dev/tty
    stty -echo </dev/tty || true
    IFS= read -r token </dev/tty || token=
    stty echo </dev/tty || true
    printf '\n' >/dev/tty
  fi
  # Drop it from the environment before any other program runs.
  unset TESS_SUPPORT_TOKEN || true
  [ -n "$token" ] || die "The support code is missing."
  case $token in
    *'
'*|*'	'*) die "The support code is missing." ;;
  esac
  case $token in
    *OPENCODE*|*opencode.ai*|sk-*) die "Refusing a value that looks like an OpenCode key." ;;
  esac
  # tools/reports.mjs support token add prints tess_ plus 32 random bytes, hex.
  if ! printf '%s' "$token" | grep -Eq '^tess_[0-9a-f]{64}$'; then
    die "The support code is not one Krish issued."
  fi
}

read_inbox() {
  inbox=${TESS_INBOX:-$INBOX_DEFAULT}
  case $inbox in
    */) inbox=${inbox%/} ;;
  esac
  case $inbox in
    *\?*|*\#*|*'@'*|*' '*) die "TESS_INBOX must not carry a user, a password, or a query." ;;
  esac
  proto=
  rest=
  case $inbox in
    https://*) proto=https; rest=${inbox#https://} ;;
    http://*) proto=http; rest=${inbox#http://} ;;
    *) die "TESS_INBOX must be $INBOX_DEFAULT" ;;
  esac
  case $rest in
    ''|*/*) die "TESS_INBOX must be the inbox origin, not a page on it." ;;
  esac
  host=$rest
  port=
  case $host in
    \[::1\]:*)
      port=${host#\[::1\]:}
      host=::1
      ;;
    \[::1\]) host=::1 ;;
    *:*)
      port=${host##*:}
      host=${host%:*}
      case $host in
        *:*) die "TESS_INBOX must be $INBOX_DEFAULT" ;;
      esac
      ;;
  esac
  if [ -n "$port" ]; then
    case $port in
      *[!0-9]*) die "TESS_INBOX must be $INBOX_DEFAULT" ;;
    esac
  fi
  if [ "$proto" = https ] && [ "$host" = tess-music-player.janus.ing ] && [ -z "$port" ]; then
    inbox=$INBOX_DEFAULT
    return 0
  fi
  # install.mjs allows plain http only for a loopback host, and only under TESS_TEST.
  if [ "${TESS_TEST:-}" = 1 ] && [ "$proto" = http ]; then
    case $host in
      127.0.0.1|localhost|::1)
        if [ "$host" = ::1 ]; then
          if [ -n "$port" ]; then inbox="http://[::1]:$port"; else inbox="http://[::1]"; fi
        elif [ -n "$port" ]; then
          inbox="http://$host:$port"
        else
          inbox="http://$host"
        fi
        return 0
        ;;
    esac
  fi
  die "TESS_INBOX must be $INBOX_DEFAULT"
}

stage_profile_files() {
  # tools/pin-support-mac.mjs reads this list and rewrites PROFILE_PINS from one commit.
  rels="
support/mac/config.yaml
support/mac/distribution.yaml
support/mac/SOUL.md
support/mac/skills/tess-evidence/SKILL.md
support/mac/skills/tess-evidence/scripts/spotify-window.mjs
support/mac/skills/tess-gather/SKILL.md
support/mac/skills/tess-gather/scripts/doctor.mjs
support/mac/skills/tess-handoff/SKILL.md
support/mac/skills/tess-handoff/scripts/triage-inbox.mjs
support/mac/skills/tess-support/SKILL.md
support/mac/plugins/tess-visit/__init__.py
support/mac/plugins/tess-visit/plugin.yaml
support/bot/skills/tess-support/scripts/privacy.mjs
support/bot/skills/tess-support/scripts/triage.mjs
support/bot/skills/tess-support/scripts/inbox.mjs
support/bot/skills/tess-support/scripts/session.mjs
"
  if [ -f "$0" ] && [ -f "$(dirname "$0")/config.yaml" ]; then
    src=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
    root=$(CDPATH= cd -- "$src/../.." && pwd)
  else
    src=$work/profile/support/mac
    root=$work/profile
    set -f
    for rel in $rels; do
      mkdir -p "$root/$(dirname "$rel")"
      fetch "$root/$rel" "$PROFILE_ORIGIN/$rel"
    done
    set +f
  fi
  verify_profile_files
}

verify_profile_files() {
  set -f
  for rel in $rels; do
    [ -f "$root/$rel" ] || die "The profile file $rel is missing. Nothing was changed in the profile."
    expect=$(printf '%s\n' "$PROFILE_PINS" | awk -v want="$rel" '$1 == want { print $2; exit }')
    is_sha256 "${expect:-}" || die "This installer has no checksum for $rel. Nothing was changed in the profile."
    got=$(sha256_file "$root/$rel")
    if [ "$got" != "$expect" ]; then
      die "The profile file $rel did not match its pinned checksum. Nothing was changed in the profile."
    fi
  done
  set +f
}

refuse_linked_profile() {
  if [ -L "$HERMES_HOME/profiles" ] || [ -L "$profile" ]; then
    die "The profile folder is a symlink. Refusing to follow it."
  fi
}

# The names under distribution_owned:, read the way install.mjs reads them.
owned_names() {
  awk '
    found && /^[[:space:]]*$/ { next }
    found { if ($0 ~ /^  - [^ ]+$/) { sub(/^  - /, ""); print; next } exit }
    $0 == "distribution_owned:" { found = 1 }
  ' "$1"
}

# A directory is removed. A symlink is removed as a link, and the folder it points at stays.
remove_tree_or_link() {
  if [ -L "$1" ]; then
    rm -f "$1"
  elif [ -e "$1" ]; then
    rm -rf "$1"
  fi
}

# Live means the folder this installer finished: the support code and the file list. A logs stub is not live.
profile_is_live() {
  [ -e "$profile" ] || return 1
  [ -L "$profile" ] && return 1
  [ -f "$profile/.env" ] || return 1
  [ -f "$profile/distribution.yaml" ] || return 1
  return 0
}

# .previous is the only complete copy until the new folder is in place. Never delete it before that is true.
drop_previous() {
  if [ ! -e "$profile_previous" ] && [ ! -L "$profile_previous" ]; then
    return 0
  fi
  if [ ! -f "$profile/.env" ] || [ -e "$profile/.tess-support.incoming" ] || [ -L "$profile/.tess-support.incoming" ]; then
    die "The previous profile was kept because this folder is not a complete Tess Support profile."
  fi
  remove_tree_or_link "$profile_previous"
}

require_profile_absent() {
  if [ -e "$profile" ] || [ -L "$profile" ]; then
    die "The profile folder appeared during the install. Quit Tess Support and run this again. The previous profile was kept."
  fi
}

# A lock is a regular file linked into place only after pid and start time are
# written, so another process never sees a half-written live lock. macOS reuses
# pids, so a live pid with a different start time is stale. Stale recovery is
# serialized per stale inode so two retries cannot have the second move away
# the first one's fresh live lock.
path_inode() {
  [ -e "$1" ] || [ -L "$1" ] || return 1
  ino=$(ls -id -- "$1" 2>/dev/null | awk '{print $1; exit}') || return 1
  case $ino in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$ino"
}

# POSIX ln puts the link inside the target when the target is an existing directory.
# Check before and after so a legacy directory lock never looks like a win.
link_exclusive() {
  [ ! -d "$2" ] && [ ! -L "$2" ] || return 1
  ln "$1" "$2" 2>/dev/null || return 1
  if [ -d "$2" ] || [ -L "$2" ] || [ "$(path_inode "$2" || true)" != "$(path_inode "$1" || true)" ]; then
    rm -f "$2/$(basename "$1")" 2>/dev/null || true
    return 1
  fi
  return 0
}

lock_owner_matches() {
  lock=$1
  old=
  recorded=
  if [ -L "$lock" ]; then
    return 1
  elif [ -f "$lock" ]; then
    old=$(sed -n 's/^pid=//p' "$lock" 2>/dev/null | head -n 1 | tr -d '[:space:]' || true)
    recorded=$(sed -n 's/^lstart=//p' "$lock" 2>/dev/null | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)
  elif [ -d "$lock" ]; then
    [ -f "$lock/pid" ] && [ ! -L "$lock/pid" ] || return 1
    [ -f "$lock/lstart" ] && [ ! -L "$lock/lstart" ] || return 1
    old=$(tr -d '[:space:]' < "$lock/pid" 2>/dev/null || true)
    recorded=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' < "$lock/lstart" 2>/dev/null || true)
  else
    return 1
  fi
  case $old in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ -n "$recorded" ] || return 1
  now=$(TZ=UTC0 LC_ALL=C ps -o lstart= -p "$old" 2>/dev/null) || return 1
  now=$(printf '%s' "$now" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$now" ] || return 1
  [ "$now" = "$recorded" ]
}

acquire_swap_lock() {
  swap_lock=$profiles_dir/.tess-support.lock
  if [ -L "$swap_lock" ]; then
    die "The install lock is a symlink. Refusing to follow it."
  fi
  started=$(TZ=UTC0 LC_ALL=C ps -o lstart= -p "$$") || die "Could not keep the install lock."
  started=$(printf '%s' "$started" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -n "$started" ] || die "Could not keep the install lock."

  swap_lock_tmp=$profiles_dir/.tess-support.lock.tmp.$$
  remove_tree_or_link "$swap_lock_tmp"
  umask 077
  printf 'pid=%s\nlstart=%s\n' "$$" "$started" > "$swap_lock_tmp" || die "Could not keep the install lock."
  umask 022
  my_lock_ino=$(path_inode "$swap_lock_tmp") || die "Could not keep the install lock."

  if link_exclusive "$swap_lock_tmp" "$swap_lock"; then
    held_swap_lock=1
    rm -f "$swap_lock_tmp" || true
    swap_lock_tmp=
    return 0
  fi

  if [ -L "$swap_lock" ]; then
    die "The install lock is a symlink. Refusing to follow it."
  fi
  old_ino=$(path_inode "$swap_lock" || true)
  if [ -z "$old_ino" ]; then
    if link_exclusive "$swap_lock_tmp" "$swap_lock"; then
      held_swap_lock=1
      rm -f "$swap_lock_tmp" || true
      swap_lock_tmp=
      return 0
    fi
    die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
  fi
  if lock_owner_matches "$swap_lock"; then
    die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
  fi
  if [ -L "$swap_lock" ]; then
    die "The install lock is a symlink. Refusing to follow it."
  fi
  cur_ino=$(path_inode "$swap_lock" || true)
  if [ "$cur_ino" != "$old_ino" ]; then
    die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
  fi

  swap_lock_claim=$profiles_dir/.tess-support.lock.claim.$old_ino
  if [ -L "$swap_lock_claim" ]; then
    die "The install lock is a symlink. Refusing to follow it."
  fi
  if ! link_exclusive "$swap_lock_tmp" "$swap_lock_claim"; then
    if [ -L "$swap_lock_claim" ]; then
      die "The install lock is a symlink. Refusing to follow it."
    fi
    claim_ino=$(path_inode "$swap_lock_claim" || true)
    if [ -z "$claim_ino" ] || lock_owner_matches "$swap_lock_claim"; then
      die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
    fi
    if [ "$(path_inode "$swap_lock_claim" || true)" != "$claim_ino" ]; then
      die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
    fi
    dead_claim=$profiles_dir/.tess-support.lock.claim.dead.$$
    remove_tree_or_link "$dead_claim"
    if ! mv "$swap_lock_claim" "$dead_claim" 2>/dev/null; then
      die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
    fi
    rm -rf "$dead_claim" || true
    if ! link_exclusive "$swap_lock_tmp" "$swap_lock_claim"; then
      die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
    fi
  fi

  if [ -L "$swap_lock" ]; then
    die "The install lock is a symlink. Refusing to follow it."
  fi
  cur_ino=$(path_inode "$swap_lock" || true)
  if [ "$cur_ino" != "$old_ino" ] || lock_owner_matches "$swap_lock"; then
    die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
  fi

  stale=$profiles_dir/.tess-support.lock.stale.$$.$(date +%s)
  n=0
  while [ -e "$stale" ] || [ -L "$stale" ]; do
    n=$((n + 1))
    [ "$n" -lt 100 ] || die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
    stale=$profiles_dir/.tess-support.lock.stale.$$.$n
  done
  if ! mv "$swap_lock" "$stale" 2>/dev/null; then
    die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
  fi
  if ! link_exclusive "$swap_lock_tmp" "$swap_lock"; then
    rm -rf "$stale" || true
    die "Another Tess Support install is already changing this profile. Wait until it finishes, then run this again."
  fi
  held_swap_lock=1
  rm -rf "$stale" || true
  rm -f "$swap_lock_claim" "$swap_lock_tmp" || true
  swap_lock_claim=
  swap_lock_tmp=
}

# Quit Hermes before the folders move. The app can be on the active profile with no
# profile name in its command, and an unrelated command can contain those words.
# A Hermes from this home is a program path inside HERMES_HOME. The Hermes app is
# the program inside Hermes Agent.app or Hermes.app. Runs in a subshell so no loop
# variable (or IFS / set -f) can overwrite the caller's globals such as $token.
refuse_live_hermes() (
  if [ "${TESS_TEST:-}" = 1 ] && [ "${TESS_CHECK_LIVE_HERMES:-}" != 1 ]; then
    exit 0
  fi
  # A program path may say /var while this home says /private/var. Compare after
  # symlinks are resolved. The words --profile and -p are not the signal.
  list=$(ps -ax -ww -o args= 2>/dev/null || true)
  set -f
  IFS='
'
  hit=0
  for line in $list; do
    case $line in
      *install.sh*) continue ;;
    esac
    case $line in
      *"Hermes Agent.app/Contents/MacOS/"*|*"Hermes.app/Contents/MacOS/"*)
        hit=1
        break
        ;;
    esac
    IFS=' '
    for arg in $line; do
      case $arg in
        /*) ;;
        *) continue ;;
      esac
      base=$(basename -- "$arg")
      case $base in
        hermes|Hermes) ;;
        *)
          case $arg in
            */hermes-agent/*) ;;
            *) continue ;;
          esac
          ;;
      esac
      dir=$(dirname -- "$arg")
      [ -d "$dir" ] || continue
      real=$(physical "$dir" 2>/dev/null || true)
      [ -n "$real" ] || continue
      if [ "$real" = "$HERMES_HOME" ] || inside "$real" "$HERMES_HOME"; then
        hit=1
        break
      fi
    done
    IFS='
'
    [ "$hit" = 1 ] && break
  done
  if [ "$hit" = 1 ]; then
    die "Hermes is open. Quit Hermes, then run this again."
  fi
  exit 0
)

move_stub_aside() {
  if [ ! -e "$profile" ] && [ ! -L "$profile" ]; then
    return 0
  fi
  aside=$profiles_dir/.tess-support.aside
  remove_tree_or_link "$aside" || return 1
  mv "$profile" "$aside" || return 1
}

# A signal between the two renames leaves the good profile at .previous. Put it back.
# This never deletes .previous. A folder without .env and distribution.yaml is not the live profile.
# Safe to call again, including from the exit trap. It does not exit the script.
recover_profile_swap() {
  if [ -L "$HERMES_HOME/profiles" ] || [ -L "$profile" ]; then
    return 1
  fi
  profiles_dir=$HERMES_HOME/profiles
  profile_incoming=$profiles_dir/.tess-support.incoming
  profile_previous=$profiles_dir/.tess-support.previous
  if profile_is_live; then
    remove_tree_or_link "$profile_incoming" || return 1
    return 0
  fi
  if [ -d "$profile_previous" ] && [ ! -L "$profile_previous" ]; then
    move_stub_aside || return 1
    remove_tree_or_link "$profile_incoming" || return 1
    if [ -e "$profile" ] || [ -L "$profile" ]; then
      return 1
    fi
    mv "$profile_previous" "$profile" || return 1
    return 0
  fi
  if [ -e "$profile" ] || [ -L "$profile" ]; then
    move_stub_aside || return 1
  fi
  if [ ! -e "$profile" ] && [ ! -L "$profile" ]; then
    remove_tree_or_link "$profile_incoming" || return 1
  fi
  return 0
}

# Chat history, cache, and anything else Hermes wrote. Not the files distribution.yaml owns, .env, or Node.
carry_profile_items() {
  set +f
  for item in "$profile"/* "$profile"/.[!.]* "$profile"/..?*; do
    if [ ! -e "$item" ] && [ ! -L "$item" ]; then
      continue
    fi
    base=$(basename "$item")
    case $base in
      .|..|.env|runtime|.tess-support.*) continue ;;
    esac
    owned=0
    set -f
    for name in $names; do
      if [ "$base" = "$name" ]; then
        owned=1
      fi
    done
    set +f
    [ "$owned" = 1 ] && continue
    if [ -L "$item" ]; then
      die "The profile $base is a symlink. Refusing to follow it."
    fi
    if [ "$base" = "cache" ] && [ ! -d "$item" ]; then
      die "The profile cache is a symlink. Refusing to follow it."
    fi
    # -p keeps the mode the person already had. The profile folder around it is private.
    cp -R -p "$item" "$profile_incoming/$base"
  done
}

install_profile() {
  case $profile in
    "$HERMES_HOME"/profiles/tess-support) ;;
    *) die "The profile path is not the tess-support profile." ;;
  esac
  names=$(owned_names "$src/distribution.yaml")
  [ -n "$names" ] || die "distribution.yaml lists no profile files."
  set -f
  for name in $names; do
    # These names are the folders distribution.yaml owns. Only the pinned files inside them are copied.
    case $name in
      ""|.|..|-*|*/*|*..*|.env|.env.*) die "distribution.yaml names a file this installer will not copy: $name" ;;
    esac
    [ -e "$src/$name" ] || die "distribution.yaml lists $name, which was not downloaded."
  done
  set +f
  profiles_dir=$HERMES_HOME/profiles
  profile_incoming=$profiles_dir/.tess-support.incoming
  profile_previous=$profiles_dir/.tess-support.previous
  # A symlink has to be refused before recovery renames anything inside it.
  refuse_linked_profile
  if [ ! -e "$profiles_dir" ]; then
    mkdir -p "$profiles_dir"
  fi
  refuse_linked_profile
  if [ -L "$profile" ]; then
    die "The profile folder is a symlink. Refusing to follow it."
  fi
  if [ -e "$profile" ] && [ ! -d "$profile" ]; then
    die "The profile path is not a folder. Nothing was changed in the profile."
  fi
  refuse_live_hermes
  acquire_swap_lock
  swap_started=1
  recover_profile_swap || die "Could not put the previous profile back."
  if [ -e "$profile" ] && [ ! -d "$profile" ]; then
    die "The profile path is not a folder. Nothing was changed in the profile."
  fi
  # The new profile is a sibling of the live one, so the swap is a rename on the same disk.
  remove_tree_or_link "$profile_incoming"
  # Other accounts must not read a carried chat file through a 755 folder.
  mkdir -p -m 700 "$profile_incoming"
  chmod 700 "$profile_incoming"
  incoming_ours=1
  set -f
  for rel in $rels; do
    case $rel in
      support/mac/*)
        dest=${rel#support/mac/}
        case $dest in
          /*|*..*) die "The profile file $rel is not one this installer will copy." ;;
        esac
        mkdir -p "$profile_incoming/$(dirname -- "$dest")"
        cp "$root/$rel" "$profile_incoming/$dest"
        ;;
      support/bot/skills/tess-support/scripts/*)
        mkdir -p "$profile_incoming/skills/tess-support/scripts"
        cp "$root/$rel" "$profile_incoming/skills/tess-support/scripts/${rel##*/}"
        ;;
      *) die "The profile file $rel is not one this installer will copy." ;;
    esac
  done
  set +f
  find "$profile_incoming" -name .env -exec rm -rf {} +
  if profile_is_live; then
    carry_profile_items
  fi
  place_node "$profile_incoming"
  place_record "$profile_incoming"
  if [ -L "$profile/.env" ]; then
    die "The profile .env is a symlink. Refusing to follow it."
  fi
  umask 077
  printf 'TESS_SUPPORT_TOKEN=%s\nTESS_INBOX=%s\n' "$token" "$inbox" > "$profile_incoming/.env"
  chmod 600 "$profile_incoming/.env"
  umask 022
  if profile_is_live; then
    drop_previous
    mv "$profile" "$profile_previous" || die "Could not replace the profile. It was left as it was."
    require_profile_absent
    if mv "$profile_incoming" "$profile"; then
      chmod 700 "$profile"
      drop_previous
    else
      if [ -e "$profile" ] || [ -L "$profile" ]; then
        die "Could not install the profile, and the folder was in the way. The previous profile was kept."
      fi
      mv "$profile_previous" "$profile" || die "Could not put the previous profile back."
      die "Could not install the profile. The previous one was put back."
    fi
  else
    if [ -e "$profile" ] || [ -L "$profile" ]; then
      die "The profile folder is incomplete, and there is no previous profile to put back."
    fi
    require_profile_absent
    mv "$profile_incoming" "$profile" || die "Could not install the profile. Nothing was changed in the profile."
    chmod 700 "$profile"
  fi
}

we_installed() {
  [ -f "$marker" ] || return 1
  kind_now=$(tr -d '[:space:]' < "$marker")
  [ "$kind_now" = "app" ] || [ "$kind_now" = "cli" ]
}

set_active_profile() {
  current=
  if [ -f "$HERMES_HOME/active_profile" ]; then
    current=$(tr -d '[:space:]' < "$HERMES_HOME/active_profile")
  fi
  # Only a home this run created gets tess-support. A later run overwrites it only while it still says that.
  if [ "$created_home" = 1 ] || [ "$current" = "tess-support" ]; then
    printf '%s\n' tess-support > "$HERMES_HOME/active_profile"
  fi
  if [ "$launch" != "desktop" ]; then
    return 0
  fi
  desk="$HOME/Library/Application Support/Hermes"
  mkdir -p "$desk"
  pref="$desk/active-profile.json"
  got=
  if [ -f "$pref" ]; then
    got=$(tr -d '[:space:]' < "$pref")
  fi
  if [ "$created_home" = 1 ] || [ "$got" = '{"profile":"tess-support"}' ]; then
    printf '%s\n' '{"profile":"tess-support"}' > "$pref"
  fi
}

drop_incoming() {
  [ -n "${apps:-}" ] || return 0
  if [ -d "$apps/.Hermes.app.tess-incoming" ]; then
    rm -rf "$apps/.Hermes.app.tess-incoming"
  fi
  if [ -d "$apps/.Hermes Agent.app.tess-incoming" ]; then
    rm -rf "$apps/.Hermes Agent.app.tess-incoming"
  fi
}

leave_applications() {
  drop_incoming
  printf '%s\n' "$1" >&2
  exit 1
}

parse_feed() {
  dmg_path=
  dmg_hash=
  pending=0
  while IFS= read -r line; do
    case $line in
      *url:*mac-arm64.dmg*)
        dmg_path=${line#*url:}
        dmg_path=$(printf '%s' "$dmg_path" | tr -d ' "\r')
        pending=1
        ;;
      *sha512:*)
        if [ "$pending" = 1 ]; then
          dmg_hash=${line#*sha512:}
          dmg_hash=$(printf '%s' "$dmg_hash" | tr -d ' "\r\n\t')
          pending=0
        fi
        ;;
    esac
  done < "$1"
  case $dmg_path in
    /releases/tag/*/HermesBundled-*-mac-arm64.dmg) ;;
    *) die "The Hermes download list did not name an Apple Silicon app. Nothing was copied into Applications." ;;
  esac
  case $dmg_path in
    *..*) die "The Hermes download list had an unsafe path. Nothing was copied into Applications." ;;
  esac
  [ -n "$dmg_hash" ] || die "The Hermes download list had no checksum. Nothing was copied into Applications."
}

find_hermes_app() {
  # A symlink named Hermes.app would pass -d and then be copied as if it were the app.
  if [ -L "$1/Hermes.app" ] || [ -L "$1/Hermes Agent.app" ]; then
    return 1
  fi
  if [ -d "$1/Hermes.app" ]; then
    printf '%s\n' "$1/Hermes.app"
    return 0
  fi
  # The stable disk image names the bundle "Hermes Agent.app".
  if [ -d "$1/Hermes Agent.app" ]; then
    printf '%s\n' "$1/Hermes Agent.app"
    return 0
  fi
  for entry in "$1"/* "$1"/*/*; do
    [ -L "$entry" ] && continue
    [ -d "$entry" ] || continue
    base=$(basename "$entry")
    if [ "$base" = "Hermes.app" ] || [ "$base" = "Hermes Agent.app" ]; then
      printf '%s\n' "$entry"
      return 0
    fi
  done
  return 1
}

# Download and check the disk image before any Hermes folder is created. The copy into Applications is later.
prepare_desktop() {
  desktop_ready=0
  if [ -d "$apps/Hermes.app" ] || [ -d "$apps/Hermes Agent.app" ]; then
    return 0
  fi
  fetch "$work/stable-mac.yml" "$FEED_URL"
  parse_feed "$work/stable-mac.yml"
  fetch "$work/Hermes.dmg" "$ASSET_ORIGIN$dmg_path"
  got=$(/usr/bin/openssl dgst -sha512 -binary "$work/Hermes.dmg" | /usr/bin/openssl base64 | tr -d '\n')
  if [ "$got" != "$dmg_hash" ]; then
    leave_applications "The download did not match Hermes's published checksum. Nothing was copied into Applications."
  fi
  mnt=$work/mnt
  mkdir -p "$mnt"
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$work/Hermes.dmg"
  desktop_mounted=$(find_hermes_app "$mnt") || leave_applications "The download did not contain Hermes. Nothing was copied into Applications."
  if ! codesign --verify --deep --strict -R="anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = \"${HERMES_TEAM}\" and identifier \"${HERMES_ID}\"" "$desktop_mounted"; then
    leave_applications "The Hermes app did not pass Apple's signature check. Nothing was copied into Applications. Do not open the download."
  fi
  if ! spctl --assess --type execute "$desktop_mounted"; then
    leave_applications "Apple's check refused the Hermes app. Nothing was copied into Applications. Do not open the download."
  fi
  ver=$(app_version "$desktop_mounted")
  need=$(hermes_need)
  if [ -z "$ver" ] || ! version_at_least "$ver" "$need"; then
    leave_applications "This Hermes is ${ver:-unknown}. Tess Support needs Hermes $need or newer. Nothing was copied into Applications."
  fi
  desktop_app_name=$(basename "$desktop_mounted")
  case $desktop_app_name in
    Hermes.app|"Hermes Agent.app") ;;
    *) leave_applications "The download did not contain Hermes. Nothing was copied into Applications." ;;
  esac
  desktop_ready=1
}

install_desktop() {
  hermes_app=
  if [ -d "$apps/Hermes.app" ]; then
    hermes_app=$apps/Hermes.app
  elif [ -d "$apps/Hermes Agent.app" ]; then
    hermes_app="$apps/Hermes Agent.app"
  fi
  if [ -n "$hermes_app" ]; then
    if we_installed && [ "$(tr -d '[:space:]' < "$marker")" = "app" ]; then
      launch=desktop
      ver=$(app_version "$hermes_app")
      need=$(hermes_need)
      if [ -z "$ver" ] || ! version_at_least "$ver" "$need"; then
        die "This Hermes is ${ver:-unknown}. Tess Support needs Hermes $need or newer."
      fi
      return 0
    fi
    printf '%s\n' "Hermes is already on this Mac. Tess Support will open its own chat in the browser. The Hermes profile you already use stays as it is."
    launch=web
    require_hermes_cli
    return 0
  fi
  [ "${desktop_ready:-}" = 1 ] || die "The Hermes app was not checked. Nothing was copied into Applications."
  app_name=$desktop_app_name
  # Checks passed. A failed copy removes only the temporary name, never an existing Hermes app.
  incoming="$apps/.$app_name.tess-incoming"
  if [ -d "$incoming" ]; then
    rm -rf "$incoming"
  fi
  ditto "$desktop_mounted" "$incoming"
  if ! mv "$incoming" "$apps/$app_name"; then
    rm -rf "$incoming"
    leave_applications "Could not put Hermes into Applications. Applications was left as it was."
  fi
  xattr -dr com.apple.quarantine "$apps/$app_name" 2>/dev/null || true
  printf '%s\n' app > "$marker"
  printf '%s\n' "$app_name" > "$HERMES_HOME/tess-support-app-name"
  hermes_app=$apps/$app_name
  launch=desktop
}

# Download and check the Intel installer before any Hermes folder is created. It is run later.
prepare_cli() {
  cli_ready=0
  if [ -f "$marker" ] && [ "$(tr -d '[:space:]' < "$marker")" = "cli" ]; then
    return 0
  fi
  if command -v hermes >/dev/null 2>&1 || [ -x "$HOME/.local/bin/hermes" ]; then
    return 0
  fi
  apply_cli_test_pins
  fetch "$work/hermes-install.sh" "$CLI_URL"
  got=$(sha256_file "$work/hermes-install.sh")
  if [ "$got" != "$CLI_SHA" ]; then
    die "The Hermes installer did not match its pinned checksum. It was not run."
  fi
  cli_ready=1
}

install_cli() {
  printf '%s\n' "This Mac is Intel. Tess Support installs the Hermes command line, not the desktop app. macOS may ask once to install Command Line Tools. If a window opens, click Install."
  if [ -f "$marker" ] && [ "$(tr -d '[:space:]' < "$marker")" = "cli" ]; then
    launch=web
    require_hermes_cli
    return 0
  fi
  if command -v hermes >/dev/null 2>&1 || [ -x "$HOME/.local/bin/hermes" ]; then
    printf '%s\n' "Hermes is already on this Mac. Tess Support will open its own chat in the browser. The Hermes profile you already use stays as it is."
    launch=web
    require_hermes_cli
    return 0
  fi
  [ "${cli_ready:-}" = 1 ] || die "The Hermes installer was not checked. It was not run."
  # v0.23.2's scripts/install.sh (commit ae2a81cc) honours these and would follow a stray value.
  # HERMES_REPO_URL redirects the clone. HERMES_INSTALL_DIR is not the folder uninstall removes.
  # HERMES_INSTALL_CHANNEL, HERMES_INSTALL_VERBOSE and HERMES_RUNTIME_DIR are read the same way.
  # UV_CMD is cleared by that script before use; UV_PIN_URL, UV_PIN_SHA256 and UV_PIN_MIRROR are
  # assigned by it. They are still removed here so a caller cannot reach a later change in that script.
  # HERMES_HOME is kept: this installer chose it, and uninstall removes $HERMES_HOME/hermes-agent.
  env -u HERMES_REPO_URL -u HERMES_INSTALL_CHANNEL -u HERMES_INSTALL_DIR -u HERMES_INSTALL_VERBOSE \
    -u HERMES_RUNTIME_DIR -u UV_CMD -u UV_PIN_URL -u UV_PIN_SHA256 -u UV_PIN_MIRROR \
    /bin/bash "$work/hermes-install.sh" --non-interactive --skip-browser --skip-computer-use
  printf '%s\n' cli > "$marker"
  launch=web
  require_hermes_cli
}

build_launcher() {
  mkdir -p "$HOME/Applications" "$support_app/Contents/MacOS"
  cat > "$support_app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Tess Support</string>
  <key>CFBundleDisplayName</key>
  <string>Tess Support</string>
  <key>CFBundleIdentifier</key>
  <string>ing.janus.tess.support</string>
  <key>CFBundleExecutable</key>
  <string>launch</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF
  # The launch choice is fixed here. The click does not read the support code.
  # The path is absolute because the Dock does not search Homebrew or ~/.local/bin.
  if [ "$launch" = "desktop" ]; then
    [ -n "${hermes_app:-}" ] || die "Tess Support could not find Hermes, so it did not add a Dock icon."
    cat > "$support_app/Contents/MacOS/launch" <<EOF
#!/bin/sh
open -a $(shell_quote "$hermes_app") --args --profile=tess-support
EOF
  else
    case ${hermes_cli:-} in
      /*) ;;
      *) die "Tess Support could not find the hermes command, so it did not add a Dock icon." ;;
    esac
    cat > "$support_app/Contents/MacOS/launch" <<EOF
#!/bin/sh
exec $(shell_quote "$hermes_cli") -p tess-support webapp
EOF
  fi
  chmod 755 "$support_app/Contents/MacOS/launch"
}

dock_url() {
  file_url "$support_app"
}

dock_has_us() {
  current=$(defaults read com.apple.dock persistent-apps 2>/dev/null || true)
  needle=$(dock_url)
  case $current in
    *"$needle"*) return 0 ;;
  esac
  return 1
}

pin_dock() {
  if dock_has_us; then
    return 0
  fi
  url=$(dock_url)
  xml="<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${url}</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>Tess Support</string></dict><key>tile-type</key><string>file-tile</string></dict>"
  defaults write com.apple.dock persistent-apps -array-add "$xml"
  if ! dock_has_us; then
    die "The Dock did not keep Tess Support. Click the icon in your Applications folder. It is named Tess Support."
  fi
  killall Dock || true
}

# A Mac has this tool. The sandbox on Linux puts its own on PATH, and only a test may use that.
plist_buddy() {
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy "$@"
  elif [ "${TESS_TEST:-}" = 1 ]; then
    PlistBuddy "$@"
  else
    return 1
  fi
}

unpin_dock() {
  plist=$work/dock.plist
  if ! defaults export com.apple.dock "$plist" 2>/dev/null; then
    return 0
  fi
  removed=0
  i=0
  while :; do
    url=$(plist_buddy -c "Print :persistent-apps:${i}:tile-data:file-data:_CFURLString" "$plist" 2>/dev/null) || break
    case $url in
      *Tess%20Support.app/*)
        plist_buddy -c "Delete :persistent-apps:${i}" "$plist" >/dev/null
        removed=1
        ;;
      *) i=$((i + 1)) ;;
    esac
  done
  if [ "$removed" = 1 ]; then
    defaults import com.apple.dock "$plist"
    killall Dock || true
  fi
}

agree_remove_hermes() {
  if [ "${TESS_UNINSTALL_HERMES:-}" = "yes" ]; then
    return 0
  fi
  if [ "${TESS_TEST:-}" = 1 ]; then
    return 1
  fi
  [ -r /dev/tty ] || return 1
  printf 'Tess Support installed Hermes on this Mac. Remove Hermes too? Type yes to remove it: ' >/dev/tty
  IFS= read -r answer </dev/tty || answer=
  case $answer in
    yes|YES) return 0 ;;
  esac
  return 1
}

uninstall() {
  unset TESS_SUPPORT_TOKEN || true
  prepare_places
  ensure_places uninstall
  # A symlink here would make the rm below follow it. Stop before anything is removed.
  refuse_linked_profile
  # Same lock as an install. Take it before the icon, the Dock tile, or the profile is removed.
  profiles_dir=$HERMES_HOME/profiles
  if [ -d "$profiles_dir" ] && [ ! -L "$profiles_dir" ]; then
    acquire_swap_lock
  fi
  unpin_dock
  if [ -d "$support_app" ]; then
    rm -rf "$support_app"
  fi
  if [ -f "$HERMES_HOME/active_profile" ]; then
    current=$(tr -d '[:space:]' < "$HERMES_HOME/active_profile")
    if [ "$current" = "tess-support" ]; then
      rm -f "$HERMES_HOME/active_profile"
    fi
  fi
  pref="$HOME/Library/Application Support/Hermes/active-profile.json"
  if [ -f "$pref" ]; then
    got=$(tr -d '[:space:]' < "$pref")
    if [ "$got" = '{"profile":"tess-support"}' ]; then
      rm -f "$pref"
    fi
  fi
  if [ -d "$profile" ]; then
    case $profile in
      "$HERMES_HOME"/profiles/tess-support) rm -rf "$profile" ;;
      *) die "Refusing to remove a folder that is not the tess-support profile." ;;
    esac
  fi
  # An interrupted swap leaves the code in these folders. A symlink is only the link.
  remove_profile_leftover "$HERMES_HOME/profiles/.tess-support.previous"
  remove_profile_leftover "$HERMES_HOME/profiles/.tess-support.incoming"
  remove_profile_leftover "$HERMES_HOME/profiles/.tess-support.aside"
  if [ -f "$marker" ]; then
    installed=$(tr -d '[:space:]' < "$marker")
    if [ "$installed" = "app" ] || [ "$installed" = "cli" ]; then
      if agree_remove_hermes; then
        if [ "$installed" = "app" ]; then
          app_name=Hermes.app
          if [ -f "$HERMES_HOME/tess-support-app-name" ]; then
            IFS= read -r app_name < "$HERMES_HOME/tess-support-app-name" || app_name=
            app_name=$(printf '%s' "$app_name" | tr -d '\r')
          fi
          case $app_name in
            Hermes.app|"Hermes Agent.app")
              if [ -d "$apps/$app_name" ] && [ ! -L "$apps/$app_name" ]; then
                rm -rf "$apps/$app_name"
              fi
              rm -f "$HERMES_HOME/tess-support-app-name"
              rm -f "$marker"
              printf '%s\n' "Hermes was removed. Other Hermes profiles were left in place."
              ;;
            *)
              printf '%s\n' "The recorded Hermes app is not one this installer knows (${app_name:-empty}), so Hermes was left in place." >&2
              ;;
          esac
        fi
        if [ "$installed" = "cli" ]; then
          rm -f "$HOME/.local/bin/hermes"
          if [ -d "$HERMES_HOME/hermes-agent" ]; then
            rm -rf "$HERMES_HOME/hermes-agent"
          fi
          rm -f "$marker"
          printf '%s\n' "Hermes was removed. Other Hermes profiles were left in place."
        fi
      else
        printf '%s\n' "Hermes is still installed."
      fi
    fi
  fi
  printf '%s\n' "Ask Krish to revoke your code. Until he does, that code can still reach Tess support."
}

finish_words() {
  printf '%s\n' "Tess Support is in the Dock. Click that icon, then type what went wrong."
  printf '%s\n' "macOS will ask once to allow screen recording the first time Tess Support needs to see Spotify."
  printf '%s\n' "Turn it on for Tess Support in System Settings, under Privacy and Security, then click the Dock icon again."
}

install_main() {
  prepare_places
  read_token
  read_inbox
  same_requirement
  if [ "$arch" = "x86_64" ] && ! git --version >/dev/null 2>&1; then
    printf '%s\n' "This Mac is Intel. Tess Support installs the Hermes command line, not the desktop app. macOS may ask once to install Command Line Tools. If a window opens, click Install."
    printf '%s\n' "Command Line Tools are not installed yet. Click Install in the window macOS opens, wait until it finishes, then paste this command again." >&2
    if [ "${TESS_TEST:-}" != 1 ]; then
      xcode-select --install >/dev/null 2>&1 || true
    fi
    exit 1
  fi
  stage_node
  stage_record
  stage_profile_files
  if [ "$arch" = "arm64" ]; then
    prepare_desktop
  elif [ "$arch" = "x86_64" ]; then
    prepare_cli
  fi
  ensure_places
  launch=web
  if [ "$arch" = "arm64" ]; then
    install_desktop
  elif [ "$arch" = "x86_64" ]; then
    install_cli
  fi
  install_profile
  set_active_profile
  build_launcher
  pin_dock
  finish_words
}

work=$(mktemp -d "${TMPDIR:-/tmp}/tess-support.XXXXXX")
mnt=
restore_echo() {
  { stty echo </dev/tty; } 2>/dev/null || true
}

remove_profile_leftover() {
  case $1 in
    "$HERMES_HOME"/profiles/.tess-support.previous|\
    "$HERMES_HOME"/profiles/.tess-support.incoming|\
    "$HERMES_HOME"/profiles/.tess-support.aside) ;;
    *) die "Refusing to remove a folder that is not a Tess Support leftover." ;;
  esac
  remove_tree_or_link "$1"
}

cleanup() {
  restore_echo
  # Put a half-finished swap back before this process goes away. Never delete .previous here.
  if [ "${swap_started:-}" = 1 ]; then
    recover_profile_swap || true
  fi
  if [ "${incoming_ours:-}" = 1 ] && [ -n "${profile_incoming:-}" ]; then
    if [ -L "$profile_incoming" ]; then
      rm -f "$profile_incoming" || true
    elif [ -e "$profile_incoming" ]; then
      rm -rf "$profile_incoming" || true
    fi
  fi
  if [ -n "${swap_lock_claim:-}" ] && [ ! -L "$swap_lock_claim" ]; then
    if [ "$(path_inode "$swap_lock_claim" 2>/dev/null || true)" = "${my_lock_ino:-}" ]; then
      rm -f "$swap_lock_claim" || true
    fi
  fi
  if [ -n "${swap_lock_tmp:-}" ] && [ ! -L "$swap_lock_tmp" ]; then
    rm -f "$swap_lock_tmp" || true
  fi
  if [ "${held_swap_lock:-}" = 1 ] && [ -n "${swap_lock:-}" ] && [ ! -L "$swap_lock" ]; then
    if [ "$(path_inode "$swap_lock" 2>/dev/null || true)" = "${my_lock_ino:-}" ]; then
      rm -rf "$swap_lock" || true
    fi
  fi
  if [ -n "${mnt:-}" ]; then
    hdiutil detach "$mnt" >/dev/null 2>&1 || true
  fi
  drop_incoming
  if [ -n "${work:-}" ]; then
    rm -rf "$work"
  fi
  true
}
trap cleanup EXIT
trap 'restore_echo; exit 130' INT TERM

mode=install
if [ "${1:-}" = "--uninstall" ]; then
  [ -z "${2:-}" ] || die "Usage: install.sh [--uninstall]"
  mode=uninstall
elif [ -n "${1:-}" ]; then
  die "Usage: install.sh [--uninstall]"
fi

if [ "$mode" = "uninstall" ]; then
  uninstall
else
  install_main
fi
