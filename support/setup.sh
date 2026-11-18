#!/bin/sh
# Tess Support, set up on Krish's VPS in one command — isolated under its own unprivileged system user.
# People never run this; they just message the bot on Telegram.
#
#   sudo -E sh support/setup.sh
#
# Required env vars (never pass secrets on the command line):
#   TESS_TELEGRAM_TOKEN   Bot token from @BotFather
#   TESS_OWNER_ID         Krish's numeric Telegram user id
#   TESS_SUPPORT_TOKEN    Posting token from `node tools/reports.mjs support token add "Krish bot"`
#   OPENCODE_GO_API_KEY   OpenCode Go plan key for opencode-go/deepseek-v4.1-flash
#
# Optional env vars:
#   TESS_ALLOW_IDS        Comma- or space-separated numeric Telegram ids to seed alongside Krish (e.g. one tester)
#   TESS_DAILY_REPLY_CAP  Shared daily reply cap across all users (default: 40)
#   TESS_DAILY_USER_CAP   Per-person daily reply cap (default: 20)
#   TESS_DAILY_TOKEN_CAP  Optional daily token ceiling across all users (default: off / 0)
#   TESS_MODEL            Model override (default: opencode-go/deepseek-v4.1-flash)
#   TESS_INBOX            Inbox base URL (default: https://tess-music-player.janus.ing)
#
# Paperclip comes first on the shared VPS: `setup.sh` creates the dedicated `tess-support` system user with its own
# fixed `/home/tess-support` folder, ignores inherited HOME/HERMES_HOME/TESS_BOT_HOME/TESS_SYSTEMD_DIR when running as
# root, resolves physical paths, refuses symlinks/.. traversal and Paperclip/PostgreSQL paths, and installs a systemd
# service with StateDirectory=tess-support, narrowed ReadWritePaths, read-only plugin/config, and hard resource caps.
#
# Safe to run again (idempotent). Never edits another Hermes profile and never touches Spotify.
set -e

NAME=tess-support
DEFAULT_BOT_USER=tess-support
BOT_USER=${TESS_BOT_USER:-$DEFAULT_BOT_USER}
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

path_owner_uid() {
  _po_p=$1
  if stat -c '%u' "$_po_p" 2>/dev/null; then return 0; fi
  if stat -f '%u' "$_po_p" 2>/dev/null; then return 0; fi
  ls -ldn "$_po_p" 2>/dev/null | awk '{print $3; exit}'
}

check_owner_safe() {
  _cos_path=$1
  [ "$IS_ROOT" = 1 ] || return 0
  [ -e "$_cos_path" ] || return 0
  _cos_uid=$(path_owner_uid "$_cos_path")
  is_digits "$_cos_uid" || die "couldn't determine owner of \"$_cos_path\""
  _cos_ok=0
  [ "$_cos_uid" = 0 ] && _cos_ok=1
  if [ -n "${BOT_UID:-}" ] && [ "$_cos_uid" = "$BOT_UID" ]; then
    _cos_ok=1
  fi
  if [ "$TEST_MODE" = 1 ] && [ -n "${TESS_TEST_ALLOW_UID:-}" ] && [ "$_cos_uid" = "$TESS_TEST_ALLOW_UID" ]; then
    _cos_ok=1
  fi
  [ "$_cos_ok" = 1 ] || die "refusing \"$_cos_path\": owned by uid $_cos_uid (expected root or $BOT_USER)"
}

check_no_symlinks_under() {
  _cns_root=$1
  _cns_target=$2
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
      check_owner_safe "$_cns_cur"
    fi
  done
  IFS=$_cns_old_ifs
  set +f
}

check_target_safe() {
  _cts_path=$1
  _cts_root=$2
  _cts_kind=$3   # dir | file | any

  check_no_paperclip_path "$_cts_path"
  _cts_phys=$(resolve_phys "$_cts_path") \
    || die "refusing path \"$_cts_path\": relative '..' traversal or unresolvable symlink is not allowed."
  check_no_paperclip_path "$_cts_phys"
  if [ -n "$_cts_root" ]; then
    case "$_cts_phys" in
      "$_cts_root"|"$_cts_root"/*) ;;
      *) die "refusing path \"$_cts_path\" (resolved \"$_cts_phys\"): outside allowed root \"$_cts_root\"" ;;
    esac
  fi
  [ ! -L "$_cts_path" ] || die "refusing symlinked path \"$_cts_path\""
  if [ -n "$_cts_root" ]; then
    check_no_symlinks_under "$_cts_root" "$_cts_phys"
  fi
  if [ -e "$_cts_path" ]; then
    case "$_cts_kind" in
      dir)  [ -d "$_cts_path" ] || die "expected real directory at \"$_cts_path\"" ;;
      file) [ -f "$_cts_path" ] || die "expected real regular file at \"$_cts_path\"" ;;
      any)  [ -d "$_cts_path" ] || [ -f "$_cts_path" ] || die "refusing special file at \"$_cts_path\"" ;;
    esac
    check_owner_safe "$_cts_path"
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
}

ensure_dir() {
  _ed_path=$1
  _ed_root=$2
  _ed_mode=$3
  _ed_owner=$4
  check_target_safe "$_ed_path" "$_ed_root" dir
  mkdir -p "$_ed_path"
  check_target_safe "$_ed_path" "$_ed_root" dir
  if [ "$IS_ROOT" = 1 ]; then
    chown_no_follow "$_ed_owner" "$_ed_path"
  fi
  chmod "$_ed_mode" "$_ed_path"
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
_cur_user_low=$(printf '%s' "$CUR_USER" | tr '[:upper:]' '[:lower:]')
case "$_cur_user_low" in
  *paperclip*|postgres*)
    die "refusing invoking user \"$CUR_USER\": never run Tess support setup as Paperclip or PostgreSQL."
    ;;
esac

TEST_MODE=0
TEST_ROOT_PHYS=""
if [ "${TESS_TEST:-0}" = 1 ] && [ -n "${TESS_TEST_ROOT:-}" ]; then
  check_no_paperclip_path "$TESS_TEST_ROOT"
  [ ! -L "$TESS_TEST_ROOT" ] || die "refusing symlinked TESS_TEST_ROOT \"$TESS_TEST_ROOT\""
  [ -d "$TESS_TEST_ROOT" ] || die "TESS_TEST_ROOT must be an existing directory: \"$TESS_TEST_ROOT\""
  TEST_ROOT_PHYS=$(resolve_phys "$TESS_TEST_ROOT") || die "couldn't resolve TESS_TEST_ROOT \"$TESS_TEST_ROOT\""
  case "$TEST_ROOT_PHYS" in
    /|/etc|/var|/home|/usr|/opt|/root|/private|/private/etc|/private/var)
      die "refusing unsafe TESS_TEST_ROOT \"$TEST_ROOT_PHYS\""
      ;;
  esac
  check_no_paperclip_path "$TEST_ROOT_PHYS"
  TEST_MODE=1
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
    # Real root / sudo -E: ignore inherited HOME, HERMES_HOME, TESS_BOT_HOME, TESS_BOT_HERMES_HOME, TESS_SYSTEMD_DIR.
    BOT_USER=$DEFAULT_BOT_USER
    BOT_HOME=/home/tess-support
    BOT_HERMES_HOME=/home/tess-support/.hermes
    UNIT_DIR=/etc/systemd/system
    _home_base=$(resolve_phys /home) || die "refusing unresolvable /home"
    _etc_base=$(resolve_phys /etc) || die "refusing unresolvable /etc"
    _phys_bot_home=$(resolve_phys "$BOT_HOME") || die "refusing unresolvable $BOT_HOME"
    [ "$_phys_bot_home" = "$_home_base/tess-support" ] || die "refusing symlinked $BOT_HOME -> $_phys_bot_home"
    _phys_unit_dir=$(resolve_phys "$UNIT_DIR") || die "refusing unresolvable $UNIT_DIR"
    [ "$_phys_unit_dir" = "$_etc_base/systemd/system" ] || die "refusing symlinked $UNIT_DIR -> $_phys_unit_dir"
    ALLOWED_HOME_ROOT=$_phys_bot_home
    ALLOWED_UNIT_DIR=$_phys_unit_dir
  fi
  HOME=$BOT_HOME
  export HOME
else
  BOT_USER=${CUR_USER:-$BOT_USER}
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
  UNIT_DIR=${TESS_SYSTEMD_DIR:-/etc/systemd/system}
  ALLOWED_UNIT_DIR=""
fi
export HERMES_HOME="$BOT_HERMES_HOME"

_bot_user_low=$(printf '%s' "$BOT_USER" | tr '[:upper:]' '[:lower:]')
case "$_bot_user_low" in
  root|*paperclip*|postgres*)
    die "refusing bot user \"$BOT_USER\": Tess support must run as its own unprivileged user (for example $DEFAULT_BOT_USER), never root, paperclip, or postgres."
    ;;
esac

if [ -e "$BOT_HOME/paperclip" ] || [ -e "$BOT_HERMES_HOME/paperclip" ]; then
  die "found a paperclip directory inside \"$BOT_HOME\" — Tess support will never install alongside Paperclip's own files."
fi

BOT_UID=""
if [ "$IS_ROOT" = 1 ] && id "$BOT_USER" >/dev/null 2>&1; then
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

if [ "$IS_ROOT" = 1 ]; then
  check_target_safe "$BOT_HOME" "$ALLOWED_HOME_ROOT" dir
  check_target_safe "$BOT_HERMES_HOME" "$ALLOWED_HOME_ROOT" dir
  check_target_safe "$UNIT_DIR" "$ALLOWED_UNIT_DIR" dir
fi

# On a Linux server with useradd and systemd, require root/sudo so we actually create tess-support and install the
# resource-capped systemd unit (unless updating as tess-support itself or running in sandbox tests).
if [ "$IS_ROOT" = 0 ] && [ "${TESS_TEST:-0}" != 1 ] && [ "$CUR_USER" != "$DEFAULT_BOT_USER" ]; then
  if command -v useradd >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
    die "on a Linux server with systemd, run this with sudo so it creates the dedicated '$DEFAULT_BOT_USER' user and installs the capped systemd unit:
  sudo -E sh support/setup.sh"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  die "Node is needed on this server (the triage and allowlist scripts run on it). Install Node.js, then run this again.
  On a Mac user machine this script is the wrong script: a Tess user's Mac runs nothing of Tess's."
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
[ -n "$GOKEY" ] || die "no OpenCode Go API key: pass OPENCODE_GO_API_KEY (used for $MODEL)"

for _v in "$TOKEN" "$OWNER" "$SUPTOKEN" "$GOKEY" "$ALLOW_IDS" "$INBOX" "$MODEL" "$DAILY_REPLY_CAP" "$DAILY_USER_CAP" "$DAILY_TOKEN_CAP"; do
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

# --- 2. Create the dedicated unprivileged user (when running as root) -------------------------------------------------
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
  ensure_dir "$BOT_HOME" "$ALLOWED_HOME_ROOT" 750 "$BOT_USER"
  ensure_dir "$BOT_HERMES_HOME" "$ALLOWED_HOME_ROOT" 700 "$BOT_USER"
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

# --- 4. Download / locate and install the bot profile -----------------------------------------------------------------
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
  # Stripping <repo>-<branch>/ leaves support/ at the top: the bot is support/bot, and the systemd unit sits beside it.
  BASE_DIR=$TMP/support
fi
[ -f "$BASE_DIR/bot/SOUL.md" ] || die "there is no bot at $BASE_DIR/bot"

if [ "$IS_ROOT" = 1 ]; then
  find "$TMP" ! -type l -type d -exec chmod 755 {} + 2>/dev/null || true
  find "$TMP" ! -type l -type f -exec chmod a+r {} + 2>/dev/null || true
fi

PROFILE_DIR="$BOT_HERMES_HOME/profiles/$NAME"
if [ "$IS_ROOT" = 1 ] && [ -e "$PROFILE_DIR/plugins" ]; then
  check_target_safe "$PROFILE_DIR/plugins" "$ALLOWED_HOME_ROOT" dir
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

# --- 5. Model and non-secret profile settings -------------------------------------------------------------------------
run_as_bot "$HERMES" -p "$NAME" config set model.provider "$MP" >/dev/null 2>&1 \
  || die "couldn't set the model provider ($MP)"
run_as_bot "$HERMES" -p "$NAME" config set model.default "$MM" >/dev/null 2>&1 \
  || die "couldn't set the model ($MM)"
say "Model: $MM ($MP)"

# Hermes' own admin gate: the gateway checks this before the model runs, so Hermes' admin commands are Krish's alone.
run_as_bot "$HERMES" -p "$NAME" config set gateway.platforms.telegram.extra.allow_admin_from "[\"$OWNER\"]" >/dev/null 2>&1 \
  || say "Couldn't write the admin gate; set it by hand before anyone else is added."

# --- 6. Harden profile runtime dirs, root-owned plugins, and .env secrets ---------------------------------------------
if [ "$IS_ROOT" = 1 ]; then
  ensure_dir "$BOT_HERMES_HOME/profiles" "$ALLOWED_HOME_ROOT" 700 "$BOT_USER"
  ensure_dir "$PROFILE_DIR" "$ALLOWED_HOME_ROOT" 700 "$BOT_USER"
  for _rt in sessions logs cache cache/support state runtime pending_messages image_cache audio_cache; do
    ensure_dir "$PROFILE_DIR/$_rt" "$ALLOWED_HOME_ROOT" 700 "$BOT_USER"
  done

  # Lock down the daily-cap plugin: root-owned 0755 dirs, 0644 files, never symlinked.
  PLUGINS_ROOT="$PROFILE_DIR/plugins"
  CAP_PLUGIN_DIR="$PLUGINS_ROOT/daily-cap"
  check_target_safe "$PLUGINS_ROOT" "$ALLOWED_HOME_ROOT" dir
  check_target_safe "$CAP_PLUGIN_DIR" "$ALLOWED_HOME_ROOT" dir
  if [ -e "$CAP_PLUGIN_DIR/__pycache__" ]; then
    check_target_safe "$CAP_PLUGIN_DIR/__pycache__" "$ALLOWED_HOME_ROOT" dir
    rm -rf "$CAP_PLUGIN_DIR/__pycache__"
  fi
  for _pf in "$CAP_PLUGIN_DIR/__init__.py" "$CAP_PLUGIN_DIR/plugin.yaml"; do
    [ -e "$_pf" ] || die "missing plugin file at $_pf"
    check_target_safe "$_pf" "$ALLOWED_HOME_ROOT" file
    chown_no_follow root "$_pf"
    chmod 0644 "$_pf"
  done
  chown_no_follow root "$CAP_PLUGIN_DIR"
  chmod 0755 "$CAP_PLUGIN_DIR"
  chown_no_follow root "$PLUGINS_ROOT"
  chmod 0755 "$PLUGINS_ROOT"
else
  mkdir -p "$PROFILE_DIR"
  chmod 700 "$PROFILE_DIR"
fi

ENV_FILE="$PROFILE_DIR/.env"
if [ "$IS_ROOT" = 1 ]; then
  check_target_safe "$ENV_FILE" "$ALLOWED_HOME_ROOT" file
else
  [ ! -L "$ENV_FILE" ] || die "refusing symlinked .env at $ENV_FILE"
fi

EXISTING_REPLY_CAP=""
EXISTING_USER_CAP=""
EXISTING_TOKEN_CAP=""
ENV_TMP="$TMP/.env.new"
(
  umask 077
  : > "$ENV_TMP"
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r _line || [ -n "$_line" ]; do
      case "$_line" in
        TELEGRAM_BOT_TOKEN=*|OPENCODE_GO_API_KEY=*|TESS_OWNER_ID=*|TESS_SUPPORT_TOKEN=*|TESS_INBOX=*)
          continue
          ;;
        TESS_DAILY_REPLY_CAP=*)
          EXISTING_REPLY_CAP=${_line#TESS_DAILY_REPLY_CAP=}
          continue
          ;;
        TESS_DAILY_USER_CAP=*)
          EXISTING_USER_CAP=${_line#TESS_DAILY_USER_CAP=}
          continue
          ;;
        TESS_DAILY_TOKEN_CAP=*)
          EXISTING_TOKEN_CAP=${_line#TESS_DAILY_TOKEN_CAP=}
          continue
          ;;
        "")
          continue
          ;;
        *)
          printf '%s\n' "$_line" >> "$ENV_TMP"
          ;;
      esac
    done < "$ENV_FILE"
  fi

  EFFECTIVE_REPLY_CAP=${DAILY_REPLY_CAP:-${EXISTING_REPLY_CAP:-40}}
  EFFECTIVE_USER_CAP=${DAILY_USER_CAP:-${EXISTING_USER_CAP:-20}}
  EFFECTIVE_TOKEN_CAP=${DAILY_TOKEN_CAP:-$EXISTING_TOKEN_CAP}

  printf '%s=%s\n' TELEGRAM_BOT_TOKEN "$TOKEN" >> "$ENV_TMP"
  printf '%s=%s\n' OPENCODE_GO_API_KEY "$GOKEY" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_OWNER_ID "$OWNER" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_SUPPORT_TOKEN "$SUPTOKEN" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_INBOX "$INBOX" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_DAILY_REPLY_CAP "$EFFECTIVE_REPLY_CAP" >> "$ENV_TMP"
  printf '%s=%s\n' TESS_DAILY_USER_CAP "$EFFECTIVE_USER_CAP" >> "$ENV_TMP"
  if [ -n "$EFFECTIVE_TOKEN_CAP" ]; then
    printf '%s=%s\n' TESS_DAILY_TOKEN_CAP "$EFFECTIVE_TOKEN_CAP" >> "$ENV_TMP"
  fi
) || die "couldn't write $ENV_FILE"

chmod 600 "$ENV_TMP"
if [ "$IS_ROOT" = 1 ]; then
  chown_no_follow "$BOT_USER" "$ENV_TMP"
fi
mv -f "$ENV_TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Read effective caps for status display without invoking external commands on secrets.
EFFECTIVE_REPLY_CAP=${DAILY_REPLY_CAP:-40}
EFFECTIVE_USER_CAP=${DAILY_USER_CAP:-20}
EFFECTIVE_TOKEN_CAP=${DAILY_TOKEN_CAP:-}
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      TESS_DAILY_REPLY_CAP=*) EFFECTIVE_REPLY_CAP=${_line#TESS_DAILY_REPLY_CAP=} ;;
      TESS_DAILY_USER_CAP=*)  EFFECTIVE_USER_CAP=${_line#TESS_DAILY_USER_CAP=} ;;
      TESS_DAILY_TOKEN_CAP=*) EFFECTIVE_TOKEN_CAP=${_line#TESS_DAILY_TOKEN_CAP=} ;;
    esac
  done < "$ENV_FILE"
fi
say "Reports go to $INBOX, which you read with: node tools/reports.mjs support list"
say "Daily caps: $EFFECTIVE_REPLY_CAP shared replies/day, $EFFECTIVE_USER_CAP/day per person${EFFECTIVE_TOKEN_CAP:+, $EFFECTIVE_TOKEN_CAP tokens/day}"

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
chmod 600 "$ENV_FILE"

# --- 8. Systemd service & gateway startup -----------------------------------------------------------------------------
UNIT="$BASE_DIR/tess-support.service"
UNIT_READY=0
FILLED_TMP="$TMP/tess-support.service.filled"

if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT" ]; then
  sed \
    -e "s|__USER__|$BOT_USER|g" \
    -e "s|__HOME__|$BOT_HOME|g" \
    -e "s|__HERMES__|$HERMES|g" \
    "$UNIT" > "$FILLED_TMP" 2>/dev/null \
    || die "couldn't render systemd unit from $UNIT"
  UNIT_READY=1
fi

if [ "$UNIT_READY" = 1 ] && [ "$IS_ROOT" = 1 ]; then
  check_target_safe "$UNIT_DIR" "$ALLOWED_UNIT_DIR" dir
  mkdir -p "$UNIT_DIR"
  check_target_safe "$UNIT_DIR" "$ALLOWED_UNIT_DIR" dir
  UNIT_DEST="$UNIT_DIR/tess-support.service"
  check_target_safe "$UNIT_DEST" "$ALLOWED_UNIT_DIR" file
  install -m 0644 "$FILLED_TMP" "$UNIT_DEST" \
    || die "couldn't install systemd unit to $UNIT_DEST"
  # Stop any standalone gateway so two gateways never fight over the same session store.
  run_as_bot "$HERMES" -p "$NAME" gateway stop >/dev/null 2>&1 || true
  systemctl daemon-reload >/dev/null 2>&1 || die "systemctl daemon-reload failed"
  systemctl enable tess-support >/dev/null 2>&1 || die "systemctl enable tess-support failed"
  systemctl restart tess-support >/dev/null 2>&1 || die "systemctl restart tess-support failed"
  say "Installed and started $UNIT_DEST as user '$BOT_USER' (512M memory cap, no swap, 50% CPU quota, StateDirectory=tess-support, read-only plugins/.env/allow.txt, Paperclip paths inaccessible)."
elif [ "$UNIT_READY" = 1 ]; then
  FILLED="$(dirname "$BOT_HERMES_HOME")/tess-support.service.filled"
  cp "$FILLED_TMP" "$FILLED" 2>/dev/null && chmod 0644 "$FILLED" || true
  say ""
  say "To run it under systemd, where the memory and CPU caps and read-only allowlist apply, run:"
  say "  sudo install -m 0644 \"$FILLED\" /etc/systemd/system/tess-support.service"
  say "  sudo systemctl daemon-reload && sudo systemctl enable --now tess-support"
  say ""
  if systemctl is-active --quiet tess-support 2>/dev/null; then
    say "Already running under systemd — restart it with \`sudo systemctl restart tess-support\` to pick up changes."
  else
    run_as_bot "$HERMES" -p "$NAME" gateway stop >/dev/null 2>&1 || true
    say "Not starting a second gateway: the two lines above start it under systemd."
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
say "  · Service:      sudo systemctl status tess-support   |   sudo systemctl restart tess-support"
say ""
