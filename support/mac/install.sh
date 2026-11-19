#!/bin/sh
# One command for Tess Support on a person's Mac (D-105, #121).
#
#   curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh
#
# The support code is read from TESS_SUPPORT_TOKEN or typed at /dev/tty. It is never an argument.
# Apple Silicon: the bundled Hermes.app, checksum then codesign and spctl, and only then Applications.
# Intel: Hermes's command-line installer. The Dock icon opens the same chat in the browser.
# Safe to run again. --uninstall removes only this profile, this icon, and this Dock tile:
#
#   curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh -s -- --uninstall
#
# The profile files are the ones distribution.yaml lists, the same list install.mjs copies. This script cannot use
# install.mjs: a person's Mac may not have node. It downloads a pinned Node.js and keeps only bin/node under the
# profile, so a visit does not use a node from PATH. HERMES_HOME follows install.mjs's rule: a real install uses
# ~/.hermes, a test refuses the login home, and both refuse a symlink. --uninstall removes that Node with the profile.
set -eu

FEED_URL=https://hermes-assets.nousresearch.com/releases/darwin/stable/stable-mac.yml
ASSET_ORIGIN=https://hermes-assets.nousresearch.com
CLI_URL=https://hermes-agent.nousresearch.com/install.sh
PROFILE_ORIGIN=https://raw.githubusercontent.com/Flame119052/tess-music/main
INBOX_DEFAULT=https://tess-music-player.janus.ing
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
  found=$(printf '%s\n' "$line" | while IFS= read -r row; do
    case $row in
      NFSHomeDirectory:*)
        printf '%s\n' "${row#NFSHomeDirectory:}" | sed 's/^ *//'
        ;;
    esac
  done | head -1)
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

  mkdir -p "$HOME" "$HERMES_HOME" "$apps"
  [ -L "$chosen" ] && die "HERMES_HOME is a symlink. Refusing to follow it."
  HOME=$(physical "$HOME")
  HERMES_HOME=$(physical "$HERMES_HOME")
  apps=$(physical "$apps")
  if [ "${TESS_TEST:-}" != 1 ] && [ -n "${login:-}" ] && inside "$HERMES_HOME" "$login" && [ "$chosen" != "$login/.hermes" ]; then
    die "HERMES_HOME is inside the real home folder ($login) but is not ~/.hermes."
  fi
  if [ "${TESS_TEST:-}" = 1 ] && [ -n "${login:-}" ]; then
    inside "$HOME" "$login" && die "HOME is inside the real home folder ($login). Use a scratch directory."
    inside "$HERMES_HOME" "$login" && die "HERMES_HOME is inside the real home folder ($login). Use a scratch directory."
    inside "$apps" "$login" && die "TESS_APPLICATIONS is inside the real home folder ($login). Use a scratch directory."
  fi
  export HOME HERMES_HOME
  marker=$HERMES_HOME/tess-support-we-installed
  profile=$HERMES_HOME/profiles/tess-support
  support_app=$HOME/Applications/Tess\ Support.app
}

allow_url() {
  case $1 in
    "$ASSET_ORIGIN"/*|"$CLI_URL"|"$PROFILE_ORIGIN"/*|"$NODE_ORIGIN"/dist/*) ;;
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

# Download and check in $work. A mismatch returns before the profile is touched.
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

commit_node() {
  [ "$node_skip" = 1 ] && return 0
  case $profile in
    "$HERMES_HOME"/profiles/tess-support) ;;
    *) die "The profile path is not the tess-support profile." ;;
  esac
  if [ -L "$profile" ] || [ -L "$profile/runtime" ] || [ -L "$profile/runtime/node" ]; then
    die "The Node runtime path is a symlink. Refusing to follow it."
  fi
  incoming=$profile/runtime/.node-incoming
  previous=$profile/runtime/.node-previous
  rm -rf "$incoming"
  mkdir -p "$incoming/bin"
  cp "$srcfile" "$incoming/bin/node"
  chmod 755 "$incoming/bin/node"
  printf '%s\n' "$NODE_VERSION" > "$incoming/VERSION"
  rm -rf "$previous"
  if [ -d "$profile/runtime/node" ]; then
    mv "$profile/runtime/node" "$previous"
  fi
  if mv "$incoming" "$profile/runtime/node"; then
    rm -rf "$previous"
  else
    if [ -d "$previous" ]; then
      mv "$previous" "$profile/runtime/node"
    fi
    die "Could not install Node. The previous runtime was left in place."
  fi
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
}

read_inbox() {
  inbox=${TESS_INBOX:-$INBOX_DEFAULT}
  case $inbox in
    */) inbox=${inbox%/} ;;
  esac
  case $inbox in
    *\?*|*\#*|*'@'*) die "TESS_INBOX must not carry a user, a password, or a query." ;;
    https://*|http://*) ;;
    *) die "TESS_INBOX is not an address." ;;
  esac
  rest=${inbox#*://}
  case $rest in
    */*) die "TESS_INBOX must be the inbox origin, not a page on it." ;;
    "") die "TESS_INBOX is not an address." ;;
  esac
}

profile_source() {
  if [ -f "$0" ] && [ -f "$(dirname "$0")/config.yaml" ]; then
    src=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
    root=$(CDPATH= cd -- "$src/../.." && pwd)
    return 0
  fi
  src=$work/profile/support/mac
  root=$work/profile
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
support/mac/plugins/tess-notes/__init__.py
support/mac/plugins/tess-notes/plugin.yaml
support/bot/skills/tess-support/scripts/privacy.mjs
support/bot/skills/tess-support/scripts/triage.mjs
support/bot/skills/tess-support/scripts/inbox.mjs
support/bot/skills/tess-support/scripts/session.mjs
"
  for rel in $rels; do
    mkdir -p "$root/$(dirname "$rel")"
    fetch "$root/$rel" "$PROFILE_ORIGIN/$rel"
  done
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

install_profile() {
  profile_source
  case $profile in
    "$HERMES_HOME"/profiles/tess-support) ;;
    *) die "The profile path is not the tess-support profile." ;;
  esac
  names=$(owned_names "$src/distribution.yaml")
  [ -n "$names" ] || die "distribution.yaml lists no profile files."
  # Build the whole profile first, so a missing file stops the install before the old profile changes.
  stage=$work/stage
  rm -rf "$stage"
  mkdir -p "$stage"
  for name in $names; do
    # These names feed rm -rf below. A downloaded list must not reach outside the profile.
    case $name in
      ""|.|..|-*|*/*|*..*|.env|.env.*) die "distribution.yaml names a file this installer will not copy: $name" ;;
    esac
    [ -e "$src/$name" ] || die "distribution.yaml lists $name, which was not downloaded."
    cp -R "$src/$name" "$stage/$name"
  done
  find "$stage" -name .env -exec rm -rf {} +
  mkdir -p "$stage/skills/tess-support/scripts"
  for name in privacy.mjs triage.mjs inbox.mjs session.mjs; do
    cp "$root/support/bot/skills/tess-support/scripts/$name" "$stage/skills/tess-support/scripts/$name"
  done
  refuse_linked_profile
  mkdir -p "$profile"
  refuse_linked_profile
  # Each listed file is replaced whole, so a file the profile dropped does not linger. cache/ is not listed: an
  # unsent visit survives a reinstall.
  for name in $names; do
    rm -rf "${profile:?}/$name"
    cp -R "$stage/$name" "$profile/$name"
  done
  [ -L "$profile/.env" ] && die "The profile .env is a symlink. Refusing to follow it."
  # Builtin printf, so the code is not an argument of another program.
  umask 077
  printf 'TESS_SUPPORT_TOKEN=%s\nTESS_INBOX=%s\n' "$token" "$inbox" > "$profile/.env"
  chmod 600 "$profile/.env"
  umask 022
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
  if [ -z "$current" ] || [ "$current" = "default" ] || [ "$current" = "tess-support" ] || we_installed; then
    printf '%s\n' tess-support > "$HERMES_HOME/active_profile"
  fi
  if [ "$launch" = "desktop" ]; then
    desk="$HOME/Library/Application Support/Hermes"
    mkdir -p "$desk"
    pref="$desk/active-profile.json"
    if [ ! -f "$pref" ] || we_installed; then
      printf '%s\n' '{"profile":"tess-support"}' > "$pref"
    else
      got=$(tr -d '[:space:]' < "$pref")
      if [ "$got" = '{"profile":"tess-support"}' ] || [ -z "$got" ]; then
        printf '%s\n' '{"profile":"tess-support"}' > "$pref"
      fi
    fi
  fi
}

leave_applications() {
  if [ -d "$apps/.Hermes.app.tess-incoming" ]; then
    rm -rf "$apps/.Hermes.app.tess-incoming"
  fi
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
  if [ -d "$1/Hermes.app" ]; then
    printf '%s\n' "$1/Hermes.app"
    return 0
  fi
  for entry in "$1"/* "$1"/*/*; do
    [ -d "$entry" ] || continue
    if [ "$(basename "$entry")" = "Hermes.app" ]; then
      printf '%s\n' "$entry"
      return 0
    fi
  done
  return 1
}

install_desktop() {
  if [ -d "$apps/Hermes.app" ]; then
    if we_installed && [ "$(tr -d '[:space:]' < "$marker")" = "app" ]; then
      launch=desktop
      return 0
    fi
    printf '%s\n' "Hermes is already on this Mac. Tess Support will open its chat in the browser, so Hermes keeps the profile you already use."
    launch=web
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
  mounted=$(find_hermes_app "$mnt") || leave_applications "The download did not contain Hermes. Nothing was copied into Applications."
  if ! codesign --verify --deep --strict "$mounted"; then
    leave_applications "The Hermes app did not pass Apple's signature check. Nothing was copied into Applications. Do not open the download."
  fi
  if ! spctl --assess --type execute "$mounted"; then
    leave_applications "Apple's check refused the Hermes app. Nothing was copied into Applications. Do not open the download."
  fi
  # Checks passed. A failed copy removes only the temporary name, never an existing Hermes.app.
  if [ -d "$apps/.Hermes.app.tess-incoming" ]; then
    rm -rf "$apps/.Hermes.app.tess-incoming"
  fi
  ditto "$mounted" "$apps/.Hermes.app.tess-incoming"
  mv "$apps/.Hermes.app.tess-incoming" "$apps/Hermes.app"
  xattr -dr com.apple.quarantine "$apps/Hermes.app" 2>/dev/null || true
  printf '%s\n' app > "$marker"
  launch=desktop
}

install_cli() {
  printf '%s\n' "This Mac is Intel. Tess Support installs the Hermes command line, not the desktop app. macOS may ask once to install Command Line Tools. If a window opens, click Install."
  if ! git --version >/dev/null 2>&1; then
    printf '%s\n' "Command Line Tools are not installed yet. Click Install in the window macOS opens, wait until it finishes, then paste this command again." >&2
    if [ "${TESS_TEST:-}" != 1 ]; then
      xcode-select --install >/dev/null 2>&1 || true
    fi
    exit 1
  fi
  if [ -f "$marker" ] && [ "$(tr -d '[:space:]' < "$marker")" = "cli" ]; then
    launch=web
    return 0
  fi
  if command -v hermes >/dev/null 2>&1 || [ -x "$HOME/.local/bin/hermes" ]; then
    printf '%s\n' "Hermes is already on this Mac. Tess Support will use it, and will not replace it."
    launch=web
    return 0
  fi
  fetch "$work/hermes-install.sh" "$CLI_URL"
  /bin/bash "$work/hermes-install.sh" --non-interactive --skip-browser --skip-computer-use
  printf '%s\n' cli > "$marker"
  launch=web
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
  if [ "$launch" = "desktop" ]; then
    cat > "$support_app/Contents/MacOS/launch" <<EOF
#!/bin/sh
open -a $(printf '%s' "$apps/Hermes.app" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/") --args --profile=tess-support
EOF
  else
    cat > "$support_app/Contents/MacOS/launch" <<'EOF'
#!/bin/sh
if [ -x "$HOME/.local/bin/hermes" ]; then
  exec "$HOME/.local/bin/hermes" -p tess-support webapp
fi
exec hermes -p tess-support webapp
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
  killall Dock
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
    killall Dock
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
  if [ -L "$profile" ]; then
    rm -f "$profile"
  elif [ -d "$profile" ]; then
    case $profile in
      "$HERMES_HOME"/profiles/tess-support) rm -rf "$profile" ;;
      *) die "Refusing to remove a folder that is not the tess-support profile." ;;
    esac
  fi
  if [ -f "$marker" ]; then
    installed=$(tr -d '[:space:]' < "$marker")
    if [ "$installed" = "app" ] || [ "$installed" = "cli" ]; then
      if agree_remove_hermes; then
        if [ "$installed" = "app" ] && [ -d "$apps/Hermes.app" ]; then
          rm -rf "$apps/Hermes.app"
        fi
        if [ "$installed" = "cli" ]; then
          rm -f "$HOME/.local/bin/hermes"
          if [ -d "$HERMES_HOME/hermes-agent" ]; then
            rm -rf "$HERMES_HOME/hermes-agent"
          fi
        fi
        rm -f "$marker"
        printf '%s\n' "Hermes was removed. Other Hermes profiles were left in place."
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
  # Copy the code into the shell, then drop it, before dscl, curl, or defaults run.
  token=${TESS_SUPPORT_TOKEN:-}
  unset TESS_SUPPORT_TOKEN || true
  prepare_places
  read_token
  read_inbox
  launch=web
  if [ "$arch" = "arm64" ]; then
    install_desktop
  elif [ "$arch" = "x86_64" ]; then
    install_cli
  fi
  stage_node
  install_profile
  commit_node
  set_active_profile
  build_launcher
  pin_dock
  finish_words
}

work=$(mktemp -d "${TMPDIR:-/tmp}/tess-support.XXXXXX")
mnt=
cleanup() {
  if [ -n "${mnt:-}" ]; then
    hdiutil detach "$mnt" >/dev/null 2>&1 || true
  fi
  if [ -n "${apps:-}" ] && [ -d "$apps/.Hermes.app.tess-incoming" ]; then
    rm -rf "$apps/.Hermes.app.tess-incoming"
  fi
  if [ -n "${profile:-}" ] && [ -d "$profile/runtime/.node-incoming" ]; then
    rm -rf "$profile/runtime/.node-incoming"
  fi
  if [ -n "${work:-}" ]; then
    rm -rf "$work"
  fi
  true
}
trap cleanup EXIT

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
