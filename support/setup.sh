#!/bin/sh
# Tess Support, set up on Krish's VPS in one command — isolated across two unprivileged system users:
#   1. `tess-cap` (`CAP_HOME=/home/tess-cap`) runs the local cap proxy (`cap-proxy/proxy.mjs`), owns the real
#      `OPENCODE_GO_API_KEY` in mode-600 `.env`, and persists daily usage counters in `StateDirectory=tess-cap`.
#   2. `tess-support` (`BOT_HOME=/home/tess-support`) runs the Hermes gateway, holds only a local proxy bearer token
#      (never the real OpenCode Go key), and cannot read or write `tess-cap` files or counters.
#
#   sudo -E sh support/setup.sh
#
# Required env vars (never pass secrets on the command line):
#   TESS_TELEGRAM_TOKEN   Bot token from @BotFather
#   TESS_OWNER_ID         Krish's numeric Telegram user id
#   TESS_SUPPORT_TOKEN    Posting token from `node tools/reports.mjs support token add "Krish bot"`
#   OPENCODE_GO_API_KEY   OpenCode Go plan key for opencode-go/deepseek-v4.1-flash (stored in tess-cap only)
#
# Optional env vars:
#   TESS_ALLOW_IDS        Comma- or space-separated numeric Telegram ids to seed alongside Krish (e.g. one tester)
#   TESS_DAILY_REPLY_CAP  Shared daily reply cap across all users (default: 40)
#   TESS_DAILY_USER_CAP   Per-person daily reply cap (default: 20)
#   TESS_DAILY_TOKEN_CAP  Optional daily token ceiling across all users (default: off / 0)
#   TESS_CAP_PORT         Loopback port for tess-cap proxy (default: 4193)
#   TESS_MODEL            Model override (default: opencode-go/deepseek-v4.1-flash)
#   TESS_INBOX            Inbox base URL (default: https://tess-music-player.janus.ing)
#
# Paperclip comes first on the shared VPS: `setup.sh` uses fixed `/home/tess-support` and `/home/tess-cap` homes,
# ignores inherited overrides when running as root (refusing `TESS_TEST=1` unless both an explicit scratch
# `TESS_TEST_ROOT` and faked system tools are present), resolves physical paths, refuses symlinks/`..` traversal and
# Paperclip/PostgreSQL paths, uses fd-safe `O_NOFOLLOW` permission checks, and installs both hardened systemd units.
#
# Safe to run again (idempotent). Never edits another Hermes profile and never touches Spotify.
set -e

NAME=tess-support
DEFAULT_BOT_USER=tess-support
DEFAULT_CAP_USER=tess-cap
BOT_USER=${TESS_BOT_USER:-$DEFAULT_BOT_USER}
CAP_USER=${TESS_CAP_USER:-$DEFAULT_CAP_USER}
REPO=Flame119052/tess-music
BRANCH=${TESS_SUPPORT_BRANCH:-main}

say() { printf '%s\n' "$1"; }
die() { printf '\nSomething stopped: %s\nNothing was changed past that point.\n' "$1" >&2; exit 1; }

NL=$(printf '\n_')
NL=${NL%_}
CR=$(printf '\r')

has_ctl() {
  case "$1" in
    *"$NL"*|*"$CR"*) return 0 ;;
    *) return 1 ;;
  esac
}

is_digits() {
  case "$1" in
    ""|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

is_valid_tg_id() {
  is_digits "$1" || return 1
  [ "${#1}" -ge 5 ] && [ "${#1}" -le 15 ]
}

check_no_paperclip_path() {
  _p=$1
  [ -n "$_p" ] || return 0
  _low=$(printf '%s' "$_p" | tr '[:upper:]' '[:lower:]')
  case "$_low" in
    /srv/paperclip|/srv/paperclip/*|/home/paperclip|/home/paperclip/*|/var/lib/postgresql|/var/lib/postgresql/*|/run/postgresql|/run/postgresql/*|*/var/lib/postgresql|*/var/lib/postgresql/*|*/run/postgresql|*/run/postgresql/*|*/paperclip|*/paperclip/*)
      die "refusing path \"$_p\": Tess support must never install inside or alongside Paperclip or PostgreSQL paths."
      ;;
  esac
  if [ -L "$_p" ]; then
    _phys=$(cd -P -- "$_p" 2>/dev/null && pwd -P || true)
    if [ -n "$_phys" ] && [ "$_phys" != "$_p" ]; then
      _phys_low=$(printf '%s' "$_phys" | tr '[:upper:]' '[:lower:]')
      case "$_phys_low" in
        /srv/paperclip|/srv/paperclip/*|/home/paperclip|/home/paperclip/*|/var/lib/postgresql|/var/lib/postgresql/*|/run/postgresql|/run/postgresql/*|*/var/lib/postgresql|*/var/lib/postgresql/*|*/run/postgresql|*/run/postgresql/*|*/paperclip|*/paperclip/*)
          die "refusing symlinked path \"$_p\" -> \"$_phys\": Tess support must never resolve to Paperclip or PostgreSQL paths."
          ;;
      esac
    fi
  fi
}

# Resolve an absolute path physically using cd -P / pwd -P (or realpath), walking segment by segment so
# non-existent trailing directories still resolve accurately without allowing '..' traversal or symlink escapes.
resolve_phys() {
  _rp_in=$1
  [ -n "$_rp_in" ] || return 1
  case "$_rp_in" in
    /*) ;;
    *) return 1 ;;
  esac
  case "/$_rp_in/" in
    */../*|*/./*) return 1 ;;
  esac
  _rp_cur=""
  _rp_old_ifs=$IFS
  IFS=/
  set -f
  # shellcheck disable=SC2086
  for _rp_seg in $_rp_in; do
    [ -n "$_rp_seg" ] || continue
    _rp_next="${_rp_cur}/${_rp_seg}"
    if [ -L "$_rp_next" ] && [ ! -d "$_rp_next" ]; then
      if command -v realpath >/dev/null 2>&1; then
        _rp_real=$(realpath "$_rp_next" 2>/dev/null || true)
        if [ -n "$_rp_real" ]; then
          _rp_cur=$_rp_real
          continue
        fi
      fi
      IFS=$_rp_old_ifs
      set +f
      return 1
    fi
    if [ -d "$_rp_next" ]; then
      _rp_phys=$(cd -P -- "$_rp_next" 2>/dev/null && pwd -P) || {
        IFS=$_rp_old_ifs
        set +f
        return 1
      }
      _rp_cur=$_rp_phys
    else
      _rp_cur=$_rp_next
    fi
  done
  IFS=$_rp_old_ifs
  set +f
  printf '%s\n' "${_rp_cur:-/}"
}

is_scratch_dir() {
  _isd_p=$1
  [ -n "$_isd_p" ] || return 1
  case "$_isd_p" in
    /tmp/*|/var/tmp/*|/private/tmp/*|/private/var/folders/*|/dev/shm/*) return 0 ;;
  esac
  if [ -n "${TMPDIR:-}" ]; then
    _isd_tmp=$(resolve_phys "${TMPDIR%/}" 2>/dev/null || true)
    case "$_isd_tmp" in
      ""|/tmp|/var/tmp|/private/tmp|/private/var/folders|/dev/shm) ;;
      /|/etc|/etc/*|/var|/var/lib|/var/lib/*|/home|/home/*|/usr|/usr/*|/opt|/opt/*|/root|/root/*|/srv|/srv/*|/boot|/boot/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/private|/private/etc|/private/etc/*|/private/var|/private/var/*) ;;
      *)
        case "$_isd_p" in
          "$_isd_tmp"/*) return 0 ;;
        esac
        ;;
    esac
  fi
  return 1
}

path_owner_uid() {
  _po_p=$1
  if stat -c '%u' "$_po_p" 2>/dev/null; then return 0; fi
  if stat -f '%u' "$_po_p" 2>/dev/null; then return 0; fi
  ls -ldn "$_po_p" 2>/dev/null | awk '{print $3; exit}'
}

check_owner_safe() {
  _cos_path=$1
  _cos_allowed_uid=${2:-}
  [ "$IS_ROOT" = 1 ] || return 0
  [ -e "$_cos_path" ] || return 0
  _cos_uid=$(path_owner_uid "$_cos_path")
  is_digits "$_cos_uid" || die "couldn't determine owner of \"$_cos_path\""
  _cos_ok=0
  [ "$_cos_uid" = 0 ] && _cos_ok=1
  if [ -n "$_cos_allowed_uid" ] && [ "$_cos_uid" = "$_cos_allowed_uid" ]; then
    _cos_ok=1
  elif [ -z "$_cos_allowed_uid" ] && [ -n "${BOT_UID:-}" ] && [ "$_cos_uid" = "$BOT_UID" ]; then
    _cos_ok=1
  fi
  if [ "$TEST_MODE" = 1 ] && [ -n "${TESS_TEST_ALLOW_UID:-}" ] && [ "$_cos_uid" = "$TESS_TEST_ALLOW_UID" ]; then
    _cos_ok=1
  fi
  [ "$_cos_ok" = 1 ] || die "refusing \"$_cos_path\": owned by uid $_cos_uid (expected root or service user)"
}

check_no_symlinks_under() {
  _cns_root=$1
  _cns_target=$2
  _cns_allowed_uid=${3:-}
  case "$_cns_target" in
    "$_cns_root")
      [ ! -L "$_cns_target" ] || die "refusing symlinked path \"$_cns_target\""
      return 0
      ;;
    "$_cns_root"/*) ;;
    *) die "refusing path \"$_cns_target\": outside \"$_cns_root\"" ;;
  esac
  _cns_rel=${_cns_target#"$_cns_root"/}
  _cns_cur=$_cns_root
  _cns_old_ifs=$IFS
  IFS=/
  set -f
  # shellcheck disable=SC2086
  for _cns_seg in $_cns_rel; do
    [ -n "$_cns_seg" ] || continue
    _cns_cur="${_cns_cur}/${_cns_seg}"
    [ ! -L "$_cns_cur" ] || { IFS=$_cns_old_ifs; set +f; die "refusing symlinked path \"$_cns_cur\""; }
    if [ -e "$_cns_cur" ]; then
      check_owner_safe "$_cns_cur" "$_cns_allowed_uid"
    fi
  done
  IFS=$_cns_old_ifs
  set +f
}

check_target_safe() {
  _cts_path=$1
  _cts_root=$2
  _cts_kind=$3   # dir | file | any
  _cts_allowed_uid=${4:-}

  check_no_paperclip_path "$_cts_path"
  [ ! -L "$_cts_path" ] || die "refusing symlinked path \"$_cts_path\""
  _cts_phys=$(resolve_phys "$_cts_path") \
    || die "refusing path \"$_cts_path\": relative '..' traversal or unresolvable symlink is not allowed."
  check_no_paperclip_path "$_cts_phys"
  if [ -n "$_cts_root" ]; then
    case "$_cts_phys" in
      "$_cts_root"|"$_cts_root"/*) ;;
      *) die "refusing path \"$_cts_path\" (resolved \"$_cts_phys\"): outside allowed root \"$_cts_root\"" ;;
    esac
  fi
  if [ -n "$_cts_root" ]; then
    check_no_symlinks_under "$_cts_root" "$_cts_phys" "$_cts_allowed_uid"
  fi
  if [ -e "$_cts_path" ]; then
    case "$_cts_kind" in
      dir)  [ -d "$_cts_path" ] || die "expected real directory at \"$_cts_path\"" ;;
      file) [ -f "$_cts_path" ] || die "expected real regular file at \"$_cts_path\"" ;;
      any)  [ -d "$_cts_path" ] || [ -f "$_cts_path" ] || die "refusing special file at \"$_cts_path\"" ;;
    esac
    check_owner_safe "$_cts_path" "$_cts_allowed_uid"
  fi
}

chown_no_follow() {
  _cnf_owner=$1
  _cnf_path=$2
  [ ! -L "$_cnf_path" ] || die "refusing to chown symlink \"$_cnf_path\""
  if [ "$_cnf_owner" = "root" ]; then
    chown -h root:root "$_cnf_path" 2>/dev/null \
      || chown -h 0:0 "$_cnf_path" 2>/dev/null \
      || chown -h root "$_cnf_path" 2>/dev/null \
      || die "couldn't set root ownership on $_cnf_path"
  else
    chown -h "${_cnf_owner}:${_cnf_owner}" "$_cnf_path" 2>/dev/null \
      || chown -h "$_cnf_owner" "$_cnf_path" 2>/dev/null \
      || die "couldn't set ownership of $_cnf_path to $_cnf_owner"
  fi
  [ ! -L "$_cnf_path" ] || die "path became symlink during chown: \"$_cnf_path\""
}

# FD-safe chmod via O_NOFOLLOW + fchmod + post-check, so a symlink swapped in after check_target_safe is never followed.
chmod_no_follow() {
  _cmf_mode=$1
  _cmf_path=$2
  _cmf_kind=${3:-any}
  [ -n "$_cmf_path" ] || die "chmod_no_follow: empty path"
  [ ! -L "$_cmf_path" ] || die "refusing to chmod symlink \"$_cmf_path\""
  node -e '
    const fs = require("node:fs");
    const mode = parseInt(process.argv[1], 8);
    const target = process.argv[2];
    const kind = process.argv[3];
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      console.error("invalid chmod mode: " + process.argv[1]);
      process.exit(2);
    }
    const before = fs.lstatSync(target);
    if (before.isSymbolicLink()) {
      console.error("refusing symlinked path: " + target);
      process.exit(3);
    }
    if (kind === "dir" && !before.isDirectory()) {
      console.error("expected directory: " + target);
      process.exit(4);
    }
    if (kind === "file" && !before.isFile()) {
      console.error("expected regular file: " + target);
      process.exit(5);
    }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const st = fs.fstatSync(fd);
      if (st.dev !== before.dev || st.ino !== before.ino) {
        console.error("path changed before fchmod: " + target);
        process.exit(6);
      }
      if (kind === "dir" && !st.isDirectory()) process.exit(4);
      if (kind === "file" && !st.isFile()) process.exit(5);
      fs.fchmodSync(fd, mode);
      const after = fs.lstatSync(target);
      if (after.isSymbolicLink() || after.dev !== st.dev || after.ino !== st.ino || (after.mode & 0o7777) !== mode) {
        console.error("post-fchmod verification failed: " + target);
        process.exit(7);
      }
    } finally {
      fs.closeSync(fd);
    }
  ' "$_cmf_mode" "$_cmf_path" "$_cmf_kind" || die "couldn't safely chmod $_cmf_mode on $_cmf_path"
}

ensure_dir() {
  _ed_path=$1
  _ed_root=$2
  _ed_mode=$3
  _ed_owner=$4
  _ed_uid=${5:-}
  check_target_safe "$_ed_path" "$_ed_root" dir "$_ed_uid"
  mkdir -p "$_ed_path"
  check_target_safe "$_ed_path" "$_ed_root" dir "$_ed_uid"
  if [ "$IS_ROOT" = 1 ]; then
    chown_no_follow "$_ed_owner" "$_ed_path"
  fi
  chmod_no_follow "$_ed_mode" "$_ed_path" dir
  check_target_safe "$_ed_path" "$_ed_root" dir "$_ed_uid"
}

UID_NUM=$(id -u 2>/dev/null || echo 1)
CUR_USER=$(id -un 2>/dev/null || true)
if [ "$UID_NUM" = 0 ]; then
  IS_ROOT=1
else
  IS_ROOT=0
fi

# --- 0. Isolation, fixed root paths & Paperclip collision guards ------------------------------------------------------
# On Krish's shared VPS, Paperclip comes first. Check requested user names before normalizing root paths.
_req_user_low=$(printf '%s' "${TESS_BOT_USER:-}" | tr '[:upper:]' '[:lower:]')
case "$_req_user_low" in
  root|*paperclip*|postgres*)
    die "refusing bot user \"$TESS_BOT_USER\": Tess support must run as its own unprivileged user (for example $DEFAULT_BOT_USER), never root, paperclip, or postgres."
    ;;
esac
_req_cap_low=$(printf '%s' "${TESS_CAP_USER:-}" | tr '[:upper:]' '[:lower:]')
case "$_req_cap_low" in
  root|*paperclip*|postgres*)
    die "refusing cap proxy user \"$TESS_CAP_USER\": Tess cap proxy must run as its own unprivileged user (for example $DEFAULT_CAP_USER), never root, paperclip, or postgres."
    ;;
esac
_cur_user_low=$(printf '%s' "$CUR_USER" | tr '[:upper:]' '[:lower:]')
case "$_cur_user_low" in
  *paperclip*|postgres*)
    die "refusing invoking user \"$CUR_USER\": never run Tess support setup as Paperclip or PostgreSQL."
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  die "Node is needed on this server (the cap proxy, triage, and allowlist scripts run on it). Install Node.js, then run this again.
  On a Mac user machine this script is the wrong script: a Tess user's Mac runs nothing of Tess's."
fi
NODE_BIN=$(command -v node)

TEST_MODE=0
TEST_ROOT_PHYS=""
if [ "${TESS_TEST:-0}" = 1 ]; then
  if [ "$IS_ROOT" = 1 ]; then
    # As root, TESS_TEST=1 must NEVER redirect real system paths. Only honor it when TESS_TEST_ROOT is an existing
    # non-symlinked directory inside a scratch folder AND useradd/chown/runuser/systemctl are faked inside it.
    [ -n "${TESS_TEST_ROOT:-}" ] || die "refusing TESS_TEST=1 as root without an explicit scratch TESS_TEST_ROOT"
    check_no_paperclip_path "$TESS_TEST_ROOT"
    [ ! -L "$TESS_TEST_ROOT" ] || die "refusing symlinked TESS_TEST_ROOT \"$TESS_TEST_ROOT\""
    [ -d "$TESS_TEST_ROOT" ] || die "TESS_TEST_ROOT must be an existing directory: \"$TESS_TEST_ROOT\""
    TEST_ROOT_PHYS=$(resolve_phys "$TESS_TEST_ROOT") || die "couldn't resolve TESS_TEST_ROOT \"$TESS_TEST_ROOT\""
    case "$TEST_ROOT_PHYS" in
      /|/etc|/etc/*|/var|/var/lib|/var/lib/*|/home|/home/*|/usr|/usr/*|/opt|/opt/*|/root|/root/*|/srv|/srv/*|/private|/private/etc|/private/etc/*|/private/var|/private/var/db|/private/var/db/*)
        die "refusing unsafe TESS_TEST_ROOT \"$TEST_ROOT_PHYS\""
        ;;
    esac
    check_no_paperclip_path "$TEST_ROOT_PHYS"
    is_scratch_dir "$TEST_ROOT_PHYS" || die "refusing TESS_TEST_ROOT outside scratch directory: \"$TEST_ROOT_PHYS\""
    for _fake_cmd in useradd chown runuser systemctl; do
      _fake_bin=$(command -v "$_fake_cmd" 2>/dev/null || true)
      case "$_fake_bin" in
        "$TEST_ROOT_PHYS"/*) ;;
        *) die "refusing TESS_TEST=1 as root: '$_fake_cmd' must be faked inside TESS_TEST_ROOT (found \"${_fake_bin:-none}\")" ;;
      esac
    done
    TEST_MODE=1
  elif [ -n "${TESS_TEST_ROOT:-}" ]; then
    check_no_paperclip_path "$TESS_TEST_ROOT"
    [ ! -L "$TESS_TEST_ROOT" ] || die "refusing symlinked TESS_TEST_ROOT \"$TESS_TEST_ROOT\""
    [ -d "$TESS_TEST_ROOT" ] || die "TESS_TEST_ROOT must be an existing directory: \"$TESS_TEST_ROOT\""
    TEST_ROOT_PHYS=$(resolve_phys "$TESS_TEST_ROOT") || die "couldn't resolve TESS_TEST_ROOT \"$TESS_TEST_ROOT\""
    check_no_paperclip_path "$TEST_ROOT_PHYS"
    is_scratch_dir "$TEST_ROOT_PHYS" || die "refusing TESS_TEST_ROOT outside scratch directory: \"$TEST_ROOT_PHYS\""
    TEST_MODE=1
  fi
fi

if [ "$IS_ROOT" = 1 ]; then
  if [ "$TEST_MODE" = 1 ]; then
    # Test mode under an explicit scratch root: still ignore caller's HOME and HERMES_HOME.
    _raw_bot_home=${TESS_BOT_HOME:-$TEST_ROOT_PHYS/home/$BOT_USER}
    check_no_paperclip_path "$_raw_bot_home"
    BOT_HOME=$(resolve_phys "$_raw_bot_home") \
      || die "refusing TESS_BOT_HOME \"$_raw_bot_home\": '..' traversal or unresolvable path is not allowed."
    check_no_paperclip_path "$BOT_HOME"
    case "$BOT_HOME" in
      "$TEST_ROOT_PHYS"/*) ;;
      *) die "refusing TESS_BOT_HOME \"$_raw_bot_home\" (resolved \"$BOT_HOME\"): outside scratch root \"$TEST_ROOT_PHYS\"" ;;
    esac
    ALLOWED_HOME_ROOT=$BOT_HOME

    _raw_hermes_home=${TESS_BOT_HERMES_HOME:-$BOT_HOME/.hermes}
    check_no_paperclip_path "$_raw_hermes_home"
    BOT_HERMES_HOME=$(resolve_phys "$_raw_hermes_home") \
      || die "refusing TESS_BOT_HERMES_HOME \"$_raw_hermes_home\": '..' traversal or unresolvable path is not allowed."
    check_no_paperclip_path "$BOT_HERMES_HOME"
    case "$BOT_HERMES_HOME" in
      "$BOT_HOME"/*) ;;
      *) die "refusing TESS_BOT_HERMES_HOME \"$_raw_hermes_home\" (resolved \"$BOT_HERMES_HOME\"): outside \"$BOT_HOME\"" ;;
    esac

    _raw_cap_home=${TESS_CAP_HOME:-$TEST_ROOT_PHYS/home/$CAP_USER}
    check_no_paperclip_path "$_raw_cap_home"
    CAP_HOME=$(resolve_phys "$_raw_cap_home") \
      || die "refusing TESS_CAP_HOME \"$_raw_cap_home\": '..' traversal or unresolvable path is not allowed."
    check_no_paperclip_path "$CAP_HOME"
    case "$CAP_HOME" in
      "$TEST_ROOT_PHYS"/*) ;;
      *) die "refusing TESS_CAP_HOME \"$_raw_cap_home\" (resolved \"$CAP_HOME\"): outside scratch root \"$TEST_ROOT_PHYS\"" ;;
    esac
    ALLOWED_CAP_ROOT=$CAP_HOME

    _raw_unit_dir=${TESS_SYSTEMD_DIR:-$TEST_ROOT_PHYS/etc/systemd/system}
    check_no_paperclip_path "$_raw_unit_dir"
    UNIT_DIR=$(resolve_phys "$_raw_unit_dir") \
      || die "refusing TESS_SYSTEMD_DIR \"$_raw_unit_dir\": '..' traversal or unresolvable path is not allowed."
    check_no_paperclip_path "$UNIT_DIR"
    case "$UNIT_DIR" in
      "$TEST_ROOT_PHYS"/*) ;;
      *) die "refusing TESS_SYSTEMD_DIR \"$_raw_unit_dir\" (resolved \"$UNIT_DIR\"): outside scratch root \"$TEST_ROOT_PHYS\"" ;;
    esac
    ALLOWED_UNIT_DIR=$UNIT_DIR
  else
    # Real root / sudo -E: ignore inherited HOME, HERMES_HOME, TESS_BOT_HOME, TESS_CAP_HOME, TESS_SYSTEMD_DIR.
    BOT_USER=$DEFAULT_BOT_USER
    CAP_USER=$DEFAULT_CAP_USER
    BOT_HOME=/home/tess-support
    BOT_HERMES_HOME=/home/tess-support/.hermes
    CAP_HOME=/home/tess-cap
    UNIT_DIR=/etc/systemd/system
    _home_base=$(resolve_phys /home) || die "refusing unresolvable /home"
    _etc_base=$(resolve_phys /etc) || die "refusing unresolvable /etc"
    _phys_bot_home=$(resolve_phys "$BOT_HOME") || die "refusing unresolvable $BOT_HOME"
    [ "$_phys_bot_home" = "$_home_base/tess-support" ] || die "refusing symlinked $BOT_HOME -> $_phys_bot_home"
    _phys_cap_home=$(resolve_phys "$CAP_HOME") || die "refusing unresolvable $CAP_HOME"
    [ "$_phys_cap_home" = "$_home_base/tess-cap" ] || die "refusing symlinked $CAP_HOME -> $_phys_cap_home"
    _phys_unit_dir=$(resolve_phys "$UNIT_DIR") || die "refusing unresolvable $UNIT_DIR"
    [ "$_phys_unit_dir" = "$_etc_base/systemd/system" ] || die "refusing symlinked $UNIT_DIR -> $_phys_unit_dir"
    ALLOWED_HOME_ROOT=$_phys_bot_home
    ALLOWED_CAP_ROOT=$_phys_cap_home
    ALLOWED_UNIT_DIR=$_phys_unit_dir
  fi
  HOME=$BOT_HOME
  export HOME
else
  BOT_USER=${CUR_USER:-$BOT_USER}
  CAP_USER=${CUR_USER:-$CAP_USER}
  _raw_bot_home=${TESS_BOT_HOME:-$HOME}
  check_no_paperclip_path "$_raw_bot_home"
  BOT_HOME=$(resolve_phys "$_raw_bot_home") \
    || die "refusing home path \"$_raw_bot_home\": '..' traversal or unresolvable path is not allowed."
  check_no_paperclip_path "$BOT_HOME"
  ALLOWED_HOME_ROOT=$BOT_HOME

  _raw_hermes_home=${TESS_BOT_HERMES_HOME:-${HERMES_HOME:-$BOT_HOME/.hermes}}
  check_no_paperclip_path "$_raw_hermes_home"
  BOT_HERMES_HOME=$(resolve_phys "$_raw_hermes_home") \
    || die "refusing HERMES_HOME \"$_raw_hermes_home\": '..' traversal or unresolvable path is not allowed."
  check_no_paperclip_path "$BOT_HERMES_HOME"

  _raw_cap_home=${TESS_CAP_HOME:-$(dirname "$BOT_HERMES_HOME")/tess-cap}
  check_no_paperclip_path "$_raw_cap_home"
  CAP_HOME=$(resolve_phys "$_raw_cap_home") \
    || die "refusing cap proxy home \"$_raw_cap_home\": '..' traversal or unresolvable path is not allowed."
  check_no_paperclip_path "$CAP_HOME"
  ALLOWED_CAP_ROOT=$CAP_HOME

  UNIT_DIR=${TESS_SYSTEMD_DIR:-/etc/systemd/system}
  ALLOWED_UNIT_DIR=""
fi
export HERMES_HOME="$BOT_HERMES_HOME"

for _chk_u in "$BOT_USER" "$CAP_USER"; do
  _chk_u_low=$(printf '%s' "$_chk_u" | tr '[:upper:]' '[:lower:]')
  case "$_chk_u_low" in
    root|*paperclip*|postgres*)
      die "refusing service user \"$_chk_u\": Tess support must run as its own unprivileged user, never root, paperclip, or postgres."
      ;;
  esac
done

if [ "$IS_ROOT" = 1 ]; then
  [ "$BOT_USER" != "$CAP_USER" ] || die "cap proxy user '$CAP_USER' must be distinct from bot user '$BOT_USER'"
  case "$CAP_HOME" in
    "$BOT_HOME"|"$BOT_HOME"/*) die "cap proxy home \"$CAP_HOME\" must be separate from bot home \"$BOT_HOME\"" ;;
  esac
  case "$BOT_HOME" in
    "$CAP_HOME"|"$CAP_HOME"/*) die "bot home \"$BOT_HOME\" must be separate from cap proxy home \"$CAP_HOME\"" ;;
  esac
fi

if [ -e "$BOT_HOME/paperclip" ] || [ -e "$BOT_HERMES_HOME/paperclip" ] || [ -e "$CAP_HOME/paperclip" ]; then
  die "found a paperclip directory inside \"$BOT_HOME\" or \"$CAP_HOME\" — Tess support will never install alongside Paperclip's own files."
fi

BOT_UID=""
CAP_UID=""
if [ "$IS_ROOT" = 1 ]; then
  if id "$BOT_USER" >/dev/null 2>&1; then
    BOT_UID=$(id -u "$BOT_USER" 2>/dev/null || true)
    if [ "$TEST_MODE" = 0 ]; then
      _passwd_home=$(getent passwd "$BOT_USER" 2>/dev/null | awk -F: '{print $6}' || true)
      if [ -z "$_passwd_home" ] && [ -r /etc/passwd ]; then
        _passwd_home=$(awk -F: -v u="$BOT_USER" '$1 == u { print $6; exit }' /etc/passwd 2>/dev/null || true)
      fi
      if [ -n "$_passwd_home" ] && [ "$_passwd_home" != "$BOT_HOME" ]; then
        die "existing user '$BOT_USER' has home \"$_passwd_home\", expected \"$BOT_HOME\""
      fi
    fi
  fi
  if id "$CAP_USER" >/dev/null 2>&1; then
    CAP_UID=$(id -u "$CAP_USER" 2>/dev/null || true)
    if [ "$TEST_MODE" = 0 ]; then
      _cap_passwd_home=$(getent passwd "$CAP_USER" 2>/dev/null | awk -F: '{print $6}' || true)
      if [ -z "$_cap_passwd_home" ] && [ -r /etc/passwd ]; then
        _cap_passwd_home=$(awk -F: -v u="$CAP_USER" '$1 == u { print $6; exit }' /etc/passwd 2>/dev/null || true)
      fi
      if [ -n "$_cap_passwd_home" ] && [ "$_cap_passwd_home" != "$CAP_HOME" ]; then
        die "existing user '$CAP_USER' has home \"$_cap_passwd_home\", expected \"$CAP_HOME\""
      fi
    fi
  fi
  check_target_safe "$BOT_HOME" "$ALLOWED_HOME_ROOT" dir "$BOT_UID"
  check_target_safe "$BOT_HERMES_HOME" "$ALLOWED_HOME_ROOT" dir "$BOT_UID"
  check_target_safe "$CAP_HOME" "$ALLOWED_CAP_ROOT" dir "$CAP_UID"
  check_target_safe "$UNIT_DIR" "$ALLOWED_UNIT_DIR" dir 0
fi

# On a Linux server with useradd and systemd, require root/sudo so we create both tess-support and tess-cap and
# install the resource-capped systemd units (unless updating as tess-support itself or running in sandbox tests).
if [ "$IS_ROOT" = 0 ] && [ "${TESS_TEST:-0}" != 1 ] && [ "$CUR_USER" != "$DEFAULT_BOT_USER" ]; then
  if command -v useradd >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
    die "on a Linux server with systemd, run this with sudo so it creates the '$DEFAULT_BOT_USER' and '$DEFAULT_CAP_USER' users and installs the capped systemd units:
  sudo -E sh support/setup.sh"
  fi
fi

say ""
say "  Tess Support — VPS / server setup"
say "  ---------------------------------"
say ""

# --- 1. Inputs (from environment or /dev/tty; never placed on any command line) ---------------------------------------
TOKEN=${TESS_TELEGRAM_TOKEN:-}
OWNER=${TESS_OWNER_ID:-}
SUPTOKEN=${TESS_SUPPORT_TOKEN:-}
GOKEY=${OPENCODE_GO_API_KEY:-}
ALLOW_IDS=${TESS_ALLOW_IDS:-}
INBOX=${TESS_INBOX:-https://tess-music-player.janus.ing}
MODEL=${TESS_MODEL:-opencode-go/deepseek-v4.1-flash}
DAILY_REPLY_CAP=${TESS_DAILY_REPLY_CAP:-}
DAILY_USER_CAP=${TESS_DAILY_USER_CAP:-}
DAILY_TOKEN_CAP=${TESS_DAILY_TOKEN_CAP:-}
CAP_PORT=${TESS_CAP_PORT:-4193}
EXPLICIT_PROXY_TOKEN=${TESS_CAP_PROXY_TOKEN:-}

if [ -z "$TOKEN" ] || [ -z "$OWNER" ] || [ -z "$SUPTOKEN" ] || [ -z "$GOKEY" ]; then
  if [ "${TESS_SUPPORT_NONINTERACTIVE:-0}" != 1 ] && [ -r /dev/tty ]; then
    [ -n "$TOKEN" ] || { printf 'Telegram bot token (from @BotFather): '; read -r TOKEN < /dev/tty; }
    [ -n "$OWNER" ] || { printf 'Your numeric Telegram id (from @userinfobot): '; read -r OWNER < /dev/tty; }
    [ -n "$SUPTOKEN" ] || { printf 'Support token (node tools/reports.mjs support token add "Krish bot"): '; read -r SUPTOKEN < /dev/tty; }
    [ -n "$GOKEY" ] || { printf 'OpenCode Go API key (OPENCODE_GO_API_KEY): '; read -r GOKEY < /dev/tty; }
  fi
fi

[ -n "$TOKEN" ] || die "no Telegram bot token: create one with @BotFather (/newbot) and pass TESS_TELEGRAM_TOKEN"
[ -n "$OWNER" ] || die "no Telegram user id: message @userinfobot and pass TESS_OWNER_ID"
[ -n "$SUPTOKEN" ] || die "no support token: run \`node tools/reports.mjs support token add \"Krish bot\"\` with your Cloudflare login and pass TESS_SUPPORT_TOKEN"
[ -n "$GOKEY" ] || die "no OpenCode Go API key: pass OPENCODE_GO_API_KEY (stored in $CAP_USER only)"

for _v in "$TOKEN" "$OWNER" "$SUPTOKEN" "$GOKEY" "$ALLOW_IDS" "$INBOX" "$MODEL" "$DAILY_REPLY_CAP" "$DAILY_USER_CAP" "$DAILY_TOKEN_CAP" "$CAP_PORT" "$EXPLICIT_PROXY_TOKEN"; do
  if has_ctl "$_v"; then
    die "control characters (newlines or CR) are not allowed in setup inputs."
  fi
done

is_valid_tg_id "$OWNER" || die "TESS_OWNER_ID must be a numeric Telegram user id (5-15 digits), not \"$OWNER\""

CLEAN_ALLOW_IDS=""
if [ -n "$ALLOW_IDS" ]; then
  for _aid in $(printf '%s' "$ALLOW_IDS" | tr ',' ' '); do
    is_valid_tg_id "$_aid" || die "TESS_ALLOW_IDS entries must be numeric Telegram user ids (5-15 digits), not \"$_aid\""
    CLEAN_ALLOW_IDS="${CLEAN_ALLOW_IDS:+$CLEAN_ALLOW_IDS }$_aid"
  done
fi

case "$MODEL" in
  */*)
    MP=${MODEL%%/*}
    MM=${MODEL#*/}
    [ -n "$MP" ] && [ -n "$MM" ] || die "TESS_MODEL must look like provider/model (for example opencode-go/deepseek-v4.1-flash), not \"$MODEL\""
    ;;
  *)
    die "TESS_MODEL must look like provider/model (for example opencode-go/deepseek-v4.1-flash), not \"$MODEL\""
    ;;
esac

if [ -n "$DAILY_REPLY_CAP" ] && ! is_digits "$DAILY_REPLY_CAP"; then
  die "TESS_DAILY_REPLY_CAP must be a non-negative integer, not \"$DAILY_REPLY_CAP\""
fi
if [ -n "$DAILY_USER_CAP" ] && ! is_digits "$DAILY_USER_CAP"; then
  die "TESS_DAILY_USER_CAP must be a non-negative integer, not \"$DAILY_USER_CAP\""
fi
if [ -n "$DAILY_TOKEN_CAP" ] && ! is_digits "$DAILY_TOKEN_CAP"; then
  die "TESS_DAILY_TOKEN_CAP must be a non-negative integer, not \"$DAILY_TOKEN_CAP\""
fi
is_digits "$CAP_PORT" && [ "$CAP_PORT" -ge 1 ] && [ "$CAP_PORT" -le 65535 ] \
  || die "TESS_CAP_PORT must be a valid TCP port (1-65535), not \"$CAP_PORT\""
CAP_BASE_URL="http://127.0.0.1:${CAP_PORT}/v1"

# --- 2. Create the dedicated unprivileged users (when running as root) ------------------------------------------------
if [ "$IS_ROOT" = 1 ]; then
  NOLOGIN=/bin/false
  for _sh in /usr/sbin/nologin /sbin/nologin /bin/false /usr/bin/false; do
    if [ -x "$_sh" ]; then
      NOLOGIN=$_sh
      break
    fi
  done
  if ! id "$BOT_USER" >/dev/null 2>&1; then
    say "Creating dedicated unprivileged system user '$BOT_USER' ($BOT_HOME)..."
    useradd --system --create-home --home-dir "$BOT_HOME" --shell "$NOLOGIN" "$BOT_USER" \
      || die "couldn't create system user $BOT_USER"
    BOT_UID=$(id -u "$BOT_USER" 2>/dev/null || true)
  fi
  if ! id "$CAP_USER" >/dev/null 2>&1; then
    say "Creating dedicated unprivileged cap-proxy user '$CAP_USER' ($CAP_HOME)..."
    useradd --system --create-home --home-dir "$CAP_HOME" --shell "$NOLOGIN" "$CAP_USER" \
      || die "couldn't create system user $CAP_USER"
    CAP_UID=$(id -u "$CAP_USER" 2>/dev/null || true)
  fi
  ensure_dir "$BOT_HOME" "$ALLOWED_HOME_ROOT" 750 "$BOT_USER" "$BOT_UID"
  ensure_dir "$BOT_HERMES_HOME" "$ALLOWED_HOME_ROOT" 700 "$BOT_USER" "$BOT_UID"
  ensure_dir "$CAP_HOME" "$ALLOWED_CAP_ROOT" 700 "$CAP_USER" "$CAP_UID"
fi

BOT_PATH="$PATH:$BOT_HOME/.local/bin"

run_as_bot() {
  if [ "$IS_ROOT" != 1 ]; then
    HOME="$BOT_HOME" HERMES_HOME="$BOT_HERMES_HOME" PATH="$BOT_PATH" "$@"
    return $?
  fi
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$BOT_USER" -- env "HOME=$BOT_HOME" "HERMES_HOME=$BOT_HERMES_HOME" "PATH=$BOT_PATH" "$@"
  elif command -v su >/dev/null 2>&1; then
    su -s /bin/sh "$BOT_USER" -c 'HOME=$1 HERMES_HOME=$2 PATH=$3; export HOME HERMES_HOME PATH; shift 3; exec "$@"' sh "$BOT_HOME" "$BOT_HERMES_HOME" "$BOT_PATH" "$@"
  else
    die "need runuser or su to run Hermes as $BOT_USER"
  fi
}

# --- 3. Hermes --------------------------------------------------------------------------------------------------------
find_hermes() {
  _h=$(PATH="$BOT_PATH" command -v hermes 2>/dev/null || true)
  [ -n "$_h" ] || { [ -x "$BOT_HOME/.local/bin/hermes" ] && _h="$BOT_HOME/.local/bin/hermes"; }
  if [ -z "$_h" ] && [ "$IS_ROOT" = 0 ] && [ -x "$HOME/.local/bin/hermes" ]; then
    _h="$HOME/.local/bin/hermes"
  fi
  printf '%s' "$_h"
}

HERMES=$(find_hermes)
if [ -z "$HERMES" ]; then
  say "Hermes isn't installed for '$BOT_USER' yet, so Nous Research's installer goes on first..."
  run_as_bot /bin/sh -c 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh' \
    || die "Hermes' installer didn't finish; nothing else was touched"
  HERMES=$(find_hermes)
  [ -n "$HERMES" ] || die "Hermes installed but its command isn't on PATH; check $BOT_HOME/.local/bin/hermes and run this again"
fi
say "Hermes: $(run_as_bot "$HERMES" --version 2>/dev/null | head -1 || echo "found at $HERMES")"

# --- 4. Download / locate and install the bot profile and cap proxy ---------------------------------------------------
TMP=$(mktemp -d "${TMPDIR:-/tmp}/tess-support.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM
if [ -n "${TESS_SUPPORT_BOT_DIR:-}" ]; then
  BASE_DIR=$TESS_SUPPORT_BOT_DIR      # a checkout, for testing and for installing from source
else
  say "Downloading the bot..."
  # GitHub's archive puts everything under <repo>-<branch>/, so that is the path inside the tarball. Getting this wrong
  # makes the one line fail for everybody, so the test runs a real tar against a real archive with this layout.
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" \
    | tar -xz -C "$TMP" --strip-components=1 "${REPO#*/}-$BRANCH/support" \
    || die "couldn't download the bot from GitHub"
  # Stripping <repo>-<branch>/ leaves support/ at the top: support/bot, support/cap-proxy, and the systemd units.
  BASE_DIR=$TMP/support
fi
[ -f "$BASE_DIR/bot/SOUL.md" ] || die "there is no bot at $BASE_DIR/bot"
[ -f "$BASE_DIR/cap-proxy/proxy.mjs" ] || die "cap proxy is missing at $BASE_DIR/cap-proxy/proxy.mjs"

if [ "$IS_ROOT" = 1 ]; then
  find "$TMP" ! -type l -type d -exec chmod 755 {} + 2>/dev/null || true
  find "$TMP" ! -type l -type f -exec chmod a+r {} + 2>/dev/null || true
fi

PROFILE_DIR="$BOT_HERMES_HOME/profiles/$NAME"
if [ "$IS_ROOT" = 1 ] && [ -e "$PROFILE_DIR/plugins" ]; then
  check_target_safe "$PROFILE_DIR/plugins" "$ALLOWED_HOME_ROOT" dir "$BOT_UID"
  _sym_plugins=$(find "$PROFILE_DIR/plugins" -type l 2>/dev/null | head -1 || true)
  [ -z "$_sym_plugins" ] || die "refusing symlink inside plugins directory: $_sym_plugins"
  # Temporarily remove root-owned plugins before `profile install --force` runs as $BOT_USER.
  rm -rf "$PROFILE_DIR/plugins"
fi

if run_as_bot "$HERMES" profile show "$NAME" >/dev/null 2>&1; then
  say "Updating the '$NAME' profile..."
  run_as_bot "$HERMES" profile install "$BASE_DIR/bot" --name "$NAME" --force --yes >/dev/null 2>&1 \
    || die "couldn't update the $NAME profile"
else
  say "Installing the bot as the Hermes profile '$NAME'..."
  run_as_bot "$HERMES" profile install "$BASE_DIR/bot" --name "$NAME" --yes >/dev/null 2>&1 \
    || die "couldn't install the bot"
fi
run_as_bot "$HERMES" profile show "$NAME" >/dev/null 2>&1 || die "the bot didn't install"

# --- 5. Model, proxy base URL, and non-secret profile settings --------------------------------------------------------
run_as_bot "$HERMES" -p "$NAME" config set model.provider "$MP" >/dev/null 2>&1 \
  || die "couldn't set the model provider ($MP)"
run_as_bot "$HERMES" -p "$NAME" config set model.default "$MM" >/dev/null 2>&1 \
  || die "couldn't set the model ($MM)"
run_as_bot "$HERMES" -p "$NAME" config set model.base_url "$CAP_BASE_URL" >/dev/null 2>&1 \
  || die "couldn't set the model base URL ($CAP_BASE_URL)"
say "Model: $MM ($MP via $CAP_BASE_URL)"

# Hermes' own admin gate: the gateway checks this before the model runs, so Hermes' admin commands are Krish's alone.
run_as_bot "$HERMES" -p "$NAME" config set gateway.platforms.telegram.extra.allow_admin_from "[\"$OWNER\"]" >/dev/null 2>&1 \
  || say "Couldn't write the admin gate; set it by hand before anyone else is added."

# --- 6. Install cap-proxy, harden dirs/plugins, and write separate .env files -----------------------------------------
CAP_PROXY_DIR="$CAP_HOME/cap-proxy"
CAP_PROXY_FILE="$CAP_PROXY_DIR/proxy.mjs"
CAP_PROXY_TMP="$TMP/proxy.mjs.new"
if [ "$IS_ROOT" = 1 ]; then
  ensure_dir "$CAP_PROXY_DIR" "$ALLOWED_CAP_ROOT" 755 root "$CAP_UID"
  check_target_safe "$CAP_PROXY_FILE" "$ALLOWED_CAP_ROOT" file "$CAP_UID"
else
  mkdir -p "$CAP_PROXY_DIR"
  chmod_no_follow 755 "$CAP_PROXY_DIR" dir
  [ ! -L "$CAP_PROXY_FILE" ] || die "refusing symlinked proxy file at $CAP_PROXY_FILE"
fi
cp "$BASE_DIR/cap-proxy/proxy.mjs" "$CAP_PROXY_TMP" || die "couldn't stage $CAP_PROXY_FILE"
chmod_no_follow 0644 "$CAP_PROXY_TMP" file
if [ "$IS_ROOT" = 1 ]; then
  chown_no_follow root "$CAP_PROXY_TMP"
fi
mv -f "$CAP_PROXY_TMP" "$CAP_PROXY_FILE"
if [ "$IS_ROOT" = 1 ]; then
  check_target_safe "$CAP_PROXY_FILE" "$ALLOWED_CAP_ROOT" file "$CAP_UID"
  chown_no_follow root "$CAP_PROXY_FILE"
  chmod_no_follow 0644 "$CAP_PROXY_FILE" file
  chown_no_follow root "$CAP_PROXY_DIR"
  chmod_no_follow 0755 "$CAP_PROXY_DIR" dir
  check_target_safe "$CAP_PROXY_FILE" "$ALLOWED_CAP_ROOT" file 0
else
  chmod_no_follow 0644 "$CAP_PROXY_FILE" file
fi

if [ "$IS_ROOT" = 1 ]; then
  ensure_dir "$BOT_HERMES_HOME/profiles" "$ALLOWED_HOME_ROOT" 700 "$BOT_USER" "$BOT_UID"
  ensure_dir "$PROFILE_DIR" "$ALLOWED_HOME_ROOT" 700 "$BOT_USER" "$BOT_UID"
  for _rt in sessions logs cache cache/support state runtime pending_messages image_cache audio_cache; do
    ensure_dir "$PROFILE_DIR/$_rt" "$ALLOWED_HOME_ROOT" 700 "$BOT_USER" "$BOT_UID"
  done

  # Lock down the optional early-UX daily-cap plugin: root-owned 0755 dirs, 0644 files, never symlinked.
  PLUGINS_ROOT="$PROFILE_DIR/plugins"
  CAP_PLUGIN_DIR="$PLUGINS_ROOT/daily-cap"
  check_target_safe "$PLUGINS_ROOT" "$ALLOWED_HOME_ROOT" dir "$BOT_UID"
  check_target_safe "$CAP_PLUGIN_DIR" "$ALLOWED_HOME_ROOT" dir "$BOT_UID"
  if [ -e "$CAP_PLUGIN_DIR/__pycache__" ]; then
    check_target_safe "$CAP_PLUGIN_DIR/__pycache__" "$ALLOWED_HOME_ROOT" dir "$BOT_UID"
    rm -rf "$CAP_PLUGIN_DIR/__pycache__"
  fi
  for _pf in "$CAP_PLUGIN_DIR/__init__.py" "$CAP_PLUGIN_DIR/plugin.yaml"; do
    [ -e "$_pf" ] || die "missing plugin file at $_pf"
    check_target_safe "$_pf" "$ALLOWED_HOME_ROOT" file "$BOT_UID"
    chown_no_follow root "$_pf"
    chmod_no_follow 0644 "$_pf" file
  done
  chown_no_follow root "$CAP_PLUGIN_DIR"
  chmod_no_follow 0755 "$CAP_PLUGIN_DIR" dir
  chown_no_follow root "$PLUGINS_ROOT"
  chmod_no_follow 0755 "$PLUGINS_ROOT" dir
else
  mkdir -p "$PROFILE_DIR"
  chmod_no_follow 700 "$PROFILE_DIR" dir
fi

CAP_ENV_FILE="$CAP_HOME/.env"
ENV_FILE="$PROFILE_DIR/.env"
if [ "$IS_ROOT" = 1 ]; then
  check_target_safe "$CAP_ENV_FILE" "$ALLOWED_CAP_ROOT" file "$CAP_UID"
  check_target_safe "$ENV_FILE" "$ALLOWED_HOME_ROOT" file "$BOT_UID"
else
  [ ! -L "$CAP_ENV_FILE" ] || die "refusing symlinked .env at $CAP_ENV_FILE"
  [ ! -L "$ENV_FILE" ] || die "refusing symlinked .env at $ENV_FILE"
fi

# Resolve effective daily caps and local proxy token from existing cap-proxy/.env or bot/.env without leaking secrets.
EXISTING_REPLY_CAP=""
EXISTING_USER_CAP=""
EXISTING_TOKEN_CAP=""
EXISTING_PROXY_TOKEN=""

for _seed_env in "$ENV_FILE" "$CAP_ENV_FILE"; do
  if [ -f "$_seed_env" ] && [ ! -L "$_seed_env" ]; then
    while IFS= read -r _line || [ -n "$_line" ]; do
      case "$_line" in
        TESS_DAILY_REPLY_CAP=*) EXISTING_REPLY_CAP=${_line#TESS_DAILY_REPLY_CAP=} ;;
        TESS_DAILY_USER_CAP=*)  EXISTING_USER_CAP=${_line#TESS_DAILY_USER_CAP=} ;;
        TESS_DAILY_TOKEN_CAP=*) EXISTING_TOKEN_CAP=${_line#TESS_DAILY_TOKEN_CAP=} ;;
        TESS_CAP_PROXY_TOKEN=*) EXISTING_PROXY_TOKEN=${_line#TESS_CAP_PROXY_TOKEN=} ;;
      esac
    done < "$_seed_env"
  fi
done

EFFECTIVE_REPLY_CAP=${DAILY_REPLY_CAP:-${EXISTING_REPLY_CAP:-40}}
EFFECTIVE_USER_CAP=${DAILY_USER_CAP:-${EXISTING_USER_CAP:-20}}
EFFECTIVE_TOKEN_CAP=${DAILY_TOKEN_CAP:-$EXISTING_TOKEN_CAP}

if [ -n "$EXPLICIT_PROXY_TOKEN" ]; then
  PROXY_TOKEN=$EXPLICIT_PROXY_TOKEN
elif [ -n "$EXISTING_PROXY_TOKEN" ] && [ "$EXISTING_PROXY_TOKEN" != "$GOKEY" ]; then
  PROXY_TOKEN=$EXISTING_PROXY_TOKEN
else
  PROXY_TOKEN=$(node -e 'process.stdout.write("tess-cap-" + require("node:crypto").randomBytes(24).toString("hex"))')
fi
[ -n "$PROXY_TOKEN" ] && [ "$PROXY_TOKEN" != "$GOKEY" ] \
  || die "local proxy token must be non-empty and distinct from OPENCODE_GO_API_KEY"

# Write tess-cap/.env (holds the REAL OPENCODE_GO_API_KEY; readable only by tess-cap).
CAP_ENV_TMP="$TMP/.cap-env.new"
(
  umask 077
  : > "$CAP_ENV_TMP"
  if [ -f "$CAP_ENV_FILE" ]; then
    while IFS= read -r _line || [ -n "$_line" ]; do
      case "$_line" in
        OPENCODE_GO_API_KEY=*|TESS_CAP_PROXY_TOKEN=*|TESS_CAP_UPSTREAM=*|TESS_CAP_LISTEN_HOST=*|TESS_CAP_LISTEN_PORT=*|TESS_DAILY_REPLY_CAP=*|TESS_DAILY_USER_CAP=*|TESS_DAILY_TOKEN_CAP=*|"")
          continue
          ;;
        *)
          printf '%s\n' "$_line" >> "$CAP_ENV_TMP"
          ;;
      esac
    done < "$CAP_ENV_FILE"
  fi
  printf '%s=%s\n' OPENCODE_GO_API_KEY "$GOKEY" >> "$CAP_ENV_TMP"
  printf '%s=%s\n' TESS_CAP_PROXY_TOKEN "$PROXY_TOKEN" >> "$CAP_ENV_TMP"
  printf '%s=%s\n' TESS_CAP_UPSTREAM "https://opencode.ai/zen/go/v1" >> "$CAP_ENV_TMP"
  printf '%s=%s\n' TESS_CAP_LISTEN_HOST "127.0.0.1" >> "$CAP_ENV_TMP"
  printf '%s=%s\n' TESS_CAP_LISTEN_PORT "$CAP_PORT" >> "$CAP_ENV_TMP"
  printf '%s=%s\n' TESS_DAILY_REPLY_CAP "$EFFECTIVE_REPLY_CAP" >> "$CAP_ENV_TMP"
  printf '%s=%s\n' TESS_DAILY_USER_CAP "$EFFECTIVE_USER_CAP" >> "$CAP_ENV_TMP"
  if [ -n "$EFFECTIVE_TOKEN_CAP" ]; then
    printf '%s=%s\n' TESS_DAILY_TOKEN_CAP "$EFFECTIVE_TOKEN_CAP" >> "$CAP_ENV_TMP"
  fi
) || die "couldn't write $CAP_ENV_FILE"

chmod_no_follow 600 "$CAP_ENV_TMP" file
if [ "$IS_ROOT" = 1 ]; then
  chown_no_follow "$CAP_USER" "$CAP_ENV_TMP"
fi
mv -f "$CAP_ENV_TMP" "$CAP_ENV_FILE"
if [ "$IS_ROOT" = 1 ]; then
  check_target_safe "$CAP_ENV_FILE" "$ALLOWED_CAP_ROOT" file "$CAP_UID"
  chown_no_follow "$CAP_USER" "$CAP_ENV_FILE"
fi
chmod_no_follow 600 "$CAP_ENV_FILE" file

# Write tess-support/.env (holds ONLY the local proxy bearer token + proxy base URL — NEVER the real Go key).
ENV_TMP="$TMP/.env.new"
(
  umask 077
  : > "$ENV_TMP"
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r _line || [ -n "$_line" ]; do
      case "$_line" in
        TELEGRAM_BOT_TOKEN=*|OPENCODE_GO_API_KEY=*|OPENCODE_GO_BASE_URL=*|TESS_OWNER_ID=*|TESS_SUPPORT_TOKEN=*|TESS_INBOX=*|TESS_DAILY_REPLY_CAP=*|TESS_DAILY_USER_CAP=*|TESS_DAILY_TOKEN_CAP=*|"")
          continue
          ;;
        *)
          printf '%s\n' "$_line" >> "$ENV_TMP"
          ;;
      esac
    done < "$ENV_FILE"
  fi

  printf '%s=%s\n' TELEGRAM_BOT_TOKEN "$TOKEN" >> "$ENV_TMP"
  printf '%s=%s\n' OPENCODE_GO_API_KEY "$PROXY_TOKEN" >> "$ENV_TMP"
  printf '%s=%s\n' OPENCODE_GO_BASE_URL "$CAP_BASE_URL" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_OWNER_ID "$OWNER" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_SUPPORT_TOKEN "$SUPTOKEN" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_INBOX "$INBOX" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_DAILY_REPLY_CAP "$EFFECTIVE_REPLY_CAP" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_DAILY_USER_CAP "$EFFECTIVE_USER_CAP" >> "$ENV_TMP"
  if [ -n "$EFFECTIVE_TOKEN_CAP" ]; then
    printf '%s=%s\n' TESS_DAILY_TOKEN_CAP "$EFFECTIVE_TOKEN_CAP" >> "$ENV_TMP"
  fi
) || die "couldn't write $ENV_FILE"

chmod_no_follow 600 "$ENV_TMP" file
if [ "$IS_ROOT" = 1 ]; then
  chown_no_follow "$BOT_USER" "$ENV_TMP"
fi
mv -f "$ENV_TMP" "$ENV_FILE"
if [ "$IS_ROOT" = 1 ]; then
  check_target_safe "$ENV_FILE" "$ALLOWED_HOME_ROOT" file "$BOT_UID"
  chown_no_follow "$BOT_USER" "$ENV_FILE"
fi
chmod_no_follow 600 "$ENV_FILE" file

say "Reports go to $INBOX, which you read with: node tools/reports.mjs support list"
say "Daily caps (enforced by $CAP_USER): $EFFECTIVE_REPLY_CAP shared replies/day, $EFFECTIVE_USER_CAP/day per person${EFFECTIVE_TOKEN_CAP:+, $EFFECTIVE_TOKEN_CAP tokens/day}"

# --- 7. Allowlist -----------------------------------------------------------------------------------------------------
INSTALLED="$PROFILE_DIR/skills/tess-support/scripts/allowlist.mjs"
[ -f "$INSTALLED" ] || die "the bot installed but its allowlist script is missing at $INSTALLED"
run_as_bot node "$INSTALLED" add "$OWNER" Krish --as "$OWNER" >/dev/null 2>&1 \
  || die "couldn't seed the allowlist for Krish"
if [ -n "$CLEAN_ALLOW_IDS" ]; then
  for _aid in $CLEAN_ALLOW_IDS; do
    [ "$_aid" = "$OWNER" ] && continue
    run_as_bot node "$INSTALLED" add "$_aid" tester --as "$OWNER" >/dev/null 2>&1 \
      || die "couldn't add $_aid to the allowlist"
  done
fi
run_as_bot node "$INSTALLED" sync --as "$OWNER" >/dev/null 2>&1 \
  || die "couldn't sync TELEGRAM_ALLOWED_USERS in $ENV_FILE"
chmod_no_follow 600 "$ENV_FILE" file

# --- 8. Systemd services & startup ------------------------------------------------------------------------------------
UNIT="$BASE_DIR/tess-support.service"
CAP_UNIT="$BASE_DIR/tess-cap.service"
UNIT_READY=0
FILLED_TMP="$TMP/tess-support.service.filled"
CAP_FILLED_TMP="$TMP/tess-cap.service.filled"

if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT" ] && [ -f "$CAP_UNIT" ]; then
  sed \
    -e "s|__USER__|$BOT_USER|g" \
    -e "s|__HOME__|$BOT_HOME|g" \
    -e "s|__CAP_HOME__|$CAP_HOME|g" \
    -e "s|__HERMES__|$HERMES|g" \
    "$UNIT" > "$FILLED_TMP" 2>/dev/null \
    || die "couldn't render systemd unit from $UNIT"
  sed \
    -e "s|__CAP_USER__|$CAP_USER|g" \
    -e "s|__CAP_HOME__|$CAP_HOME|g" \
    -e "s|__BOT_HOME__|$BOT_HOME|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    "$CAP_UNIT" > "$CAP_FILLED_TMP" 2>/dev/null \
    || die "couldn't render systemd unit from $CAP_UNIT"
  UNIT_READY=1
fi

if [ "$UNIT_READY" = 1 ] && [ "$IS_ROOT" = 1 ]; then
  check_target_safe "$UNIT_DIR" "$ALLOWED_UNIT_DIR" dir 0
  mkdir -p "$UNIT_DIR"
  check_target_safe "$UNIT_DIR" "$ALLOWED_UNIT_DIR" dir 0

  CAP_UNIT_DEST="$UNIT_DIR/tess-cap.service"
  UNIT_DEST="$UNIT_DIR/tess-support.service"
  check_target_safe "$CAP_UNIT_DEST" "$ALLOWED_UNIT_DIR" file 0
  check_target_safe "$UNIT_DEST" "$ALLOWED_UNIT_DIR" file 0

  chmod_no_follow 0644 "$CAP_FILLED_TMP" file
  chmod_no_follow 0644 "$FILLED_TMP" file
  chown_no_follow root "$CAP_FILLED_TMP"
  chown_no_follow root "$FILLED_TMP"
  mv -f "$CAP_FILLED_TMP" "$CAP_UNIT_DEST" || die "couldn't install systemd unit to $CAP_UNIT_DEST"
  mv -f "$FILLED_TMP" "$UNIT_DEST" || die "couldn't install systemd unit to $UNIT_DEST"
  check_target_safe "$CAP_UNIT_DEST" "$ALLOWED_UNIT_DIR" file 0
  check_target_safe "$UNIT_DEST" "$ALLOWED_UNIT_DIR" file 0
  chown_no_follow root "$CAP_UNIT_DEST"
  chown_no_follow root "$UNIT_DEST"
  chmod_no_follow 0644 "$CAP_UNIT_DEST" file
  chmod_no_follow 0644 "$UNIT_DEST" file

  # Stop any standalone gateway so two gateways never fight over the same session store.
  run_as_bot "$HERMES" -p "$NAME" gateway stop >/dev/null 2>&1 || true
  systemctl daemon-reload >/dev/null 2>&1 || die "systemctl daemon-reload failed"
  systemctl enable tess-cap >/dev/null 2>&1 || die "systemctl enable tess-cap failed"
  systemctl restart tess-cap >/dev/null 2>&1 || die "systemctl restart tess-cap failed"
  systemctl enable tess-support >/dev/null 2>&1 || die "systemctl enable tess-support failed"
  systemctl restart tess-support >/dev/null 2>&1 || die "systemctl restart tess-support failed"
  say "Installed and started $CAP_UNIT_DEST as user '$CAP_USER' (128M memory cap, StateDirectory=tess-cap, holds real OPENCODE_GO_API_KEY)."
  say "Installed and started $UNIT_DEST as user '$BOT_USER' (512M memory cap, no swap, 50% CPU quota, read-only plugins/.env/allow.txt, proxy token only, Paperclip and tess-cap paths inaccessible)."
elif [ "$UNIT_READY" = 1 ]; then
  OUT_DIR=$(dirname "$BOT_HERMES_HOME")
  FILLED="$OUT_DIR/tess-support.service.filled"
  CAP_FILLED="$OUT_DIR/tess-cap.service.filled"
  cp "$FILLED_TMP" "$FILLED" 2>/dev/null && chmod_no_follow 0644 "$FILLED" file || true
  cp "$CAP_FILLED_TMP" "$CAP_FILLED" 2>/dev/null && chmod_no_follow 0644 "$CAP_FILLED" file || true
  say ""
  say "To run both under systemd, where the memory/CPU caps, separate key isolation, and read-only allowlist apply, run:"
  say "  sudo install -m 0644 \"$CAP_FILLED\" /etc/systemd/system/tess-cap.service"
  say "  sudo install -m 0644 \"$FILLED\" /etc/systemd/system/tess-support.service"
  say "  sudo systemctl daemon-reload && sudo systemctl enable --now tess-cap tess-support"
  say ""
  if systemctl is-active --quiet tess-support 2>/dev/null; then
    say "Already running under systemd — restart with \`sudo systemctl restart tess-cap tess-support\` to pick up changes."
  else
    run_as_bot "$HERMES" -p "$NAME" gateway stop >/dev/null 2>&1 || true
    say "Not starting a second gateway: the lines above start both services under systemd."
  fi
else
  say "Starting the gateway for '$NAME'..."
  run_as_bot "$HERMES" -p "$NAME" gateway start >/dev/null 2>&1 \
    || die "couldn't start the gateway; start it by hand with: hermes -p $NAME gateway start"
  say ""
  say "This process is NOT capped by systemd (systemctl unavailable here)."
fi

say ""
say "Done. Message the bot from Telegram — it should answer only people on the allowlist."
say ""
if [ "$IS_ROOT" = 1 ]; then
  say "  · Add someone:  sudo -u $BOT_USER node $INSTALLED add <their id> <name> --restart"
  say "  · Remove them:  sudo -u $BOT_USER node $INSTALLED remove <their id> --restart"
  say "  · See the list: sudo -u $BOT_USER node $INSTALLED list"
else
  say "  · Add someone:  node $INSTALLED add <their id> <name> --restart"
  say "  · Remove them:  node $INSTALLED remove <their id> --restart"
  say "  · See the list: node $INSTALLED list"
fi
say ""
say "  Run those over SSH on this server, never from chat: the bot's own process cannot edit .env or allow.txt."
say "  · Reports:      node tools/reports.mjs support list"
say "  · Services:     sudo systemctl status tess-cap tess-support   |   sudo systemctl restart tess-cap tess-support"
say ""
