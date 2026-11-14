#!/bin/sh
# Tess Support, set up on a server, in one line — the machine only Krish touches. People never run this; they just
# message the bot.
#
#   TESS_TELEGRAM_TOKEN=… TESS_OWNER_ID=… TESS_SUPPORT_TOKEN=… sh support/setup.sh
#
# What it does, and nothing else: installs Hermes if it is missing, installs this repo's `support/bot` as the Hermes
# profile `tess-support`, copies the model already connected on this machine into it, stores the Telegram token and
# Krish's id, seeds the allowlist with Krish, and starts that profile's gateway.
#
# Why a server and not the person's Mac: the GitHub token that files labelled issues has to live somewhere only Krish
# controls, and one allowlist has to be one list. The person's Mac runs nothing of Tess's but `tess report`, which they
# start themselves (D-62, D-65).
#
# Safe to run twice. It never edits another Hermes profile, never touches Spotify, and never installs a service.
set -e

NAME=tess-support
REPO=Flame119052/tess-music
BRANCH=${TESS_SUPPORT_BRANCH:-main}
export HERMES_HOME=${HERMES_HOME:-$HOME/.hermes}

say() { printf '%s\n' "$1"; }
die() { printf '\nSomething stopped: %s\nNothing was changed past that point.\n' "$1" >&2; exit 1; }

# --- 0. Not on the machine that runs Paperclip ------------------------------------------------------------------------
# Paperclip owns /srv/paperclip and its services on the VPS. A support bot has no business sharing that machine's files
# or its process budget, so this refuses rather than being careful later.
if [ -d /srv/paperclip ] || [ -d "$HOME/paperclip" ] || [ "${TESS_SUPPORT_SHARED_HOST:-}" = 1 ]; then
  die "this looks like the machine that runs Paperclip. Tess support gets its own machine, so Paperclip's files, database
  and services are never shared with it. Run this somewhere else."
fi

if ! command -v node >/dev/null 2>&1; then
  die "Node is needed on this server (the triage step runs on it). Install it, then run this again.
  On a Mac this script is the wrong script: the person's Mac runs nothing of Tess's."
fi

say ""
say "  Tess Support — server setup"
say "  ---------------------------"
say ""

# --- 1. Inputs -------------------------------------------------------------------------------------------------------
TOKEN=${TESS_TELEGRAM_TOKEN:-}
OWNER=${TESS_OWNER_ID:-}
SUPTOKEN=${TESS_SUPPORT_TOKEN:-}
INBOX=${TESS_INBOX:-https://tess-music-player.janus.ing}
# OpenCode's free tier by default: no paid key, nothing of Krish's billed.
MODEL=${TESS_MODEL:-opencode/deepseek-v4.1-flash-free}
if [ -z "$TOKEN" ] || [ -z "$OWNER" ] || [ -z "$SUPTOKEN" ]; then
  if [ -r /dev/tty ]; then
    [ -n "$TOKEN" ] || { printf 'Telegram bot token (from @BotFather): '; read -r TOKEN < /dev/tty; }
    [ -n "$OWNER" ] || { printf 'Your numeric Telegram id (from @userinfobot): '; read -r OWNER < /dev/tty; }
    [ -n "$SUPTOKEN" ] || { printf 'Support token (node tools/reports.mjs support token add "Krish bot"): '; read -r SUPTOKEN < /dev/tty; }
  fi
fi
[ -n "$TOKEN" ] || die "no Telegram bot token: create one with @BotFather (/newbot) and pass TESS_TELEGRAM_TOKEN"
[ -n "$OWNER" ] || die "no Telegram user id: message @userinfobot and pass TESS_OWNER_ID"
[ -n "$SUPTOKEN" ] || die "no support token: run \`node tools/reports.mjs support token add \"Krish bot\"\` with your Cloudflare login and pass TESS_SUPPORT_TOKEN"
case "$OWNER" in *[!0-9]*) die "TESS_OWNER_ID must be a number, not \"$OWNER\"";; esac

# --- 2. Hermes --------------------------------------------------------------------------------------------------------
HERMES=$(command -v hermes 2>/dev/null || true)
[ -n "$HERMES" ] || { [ -x "$HOME/.local/bin/hermes" ] && HERMES="$HOME/.local/bin/hermes"; }
if [ -z "$HERMES" ]; then
  say "Hermes isn't on this machine yet, so it goes on first — Nous Research's own installer."
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh \
    || die "Hermes' installer didn't finish; nothing else was touched"
  HERMES=$(command -v hermes 2>/dev/null || true)
  [ -n "$HERMES" ] || { [ -x "$HOME/.local/bin/hermes" ] && HERMES="$HOME/.local/bin/hermes"; }
  [ -n "$HERMES" ] || die "Hermes installed but its command isn't on PATH; open a new shell and run this again"
fi
say "Hermes: $("$HERMES" --version 2>/dev/null | head -1 || echo "found at $HERMES")"

# --- 3. The bot -------------------------------------------------------------------------------------------------------
TMP=$(mktemp -d "${TMPDIR:-/tmp}/tess-support.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM
if [ -n "$TESS_SUPPORT_BOT_DIR" ]; then
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

if "$HERMES" profile show "$NAME" >/dev/null 2>&1; then
  say "Updating the copy already on this machine..."
  "$HERMES" profile install "$BASE_DIR/bot" --name "$NAME" --force --yes >/dev/null 2>&1 \
    || die "couldn't update the $NAME profile"
else
  say "Installing the bot as the Hermes profile '$NAME'..."
  "$HERMES" profile install "$BASE_DIR/bot" --name "$NAME" --yes >/dev/null 2>&1 \
    || die "couldn't install the bot"
fi
"$HERMES" profile show "$NAME" >/dev/null 2>&1 || die "the bot didn't install"

# --- 4. A model, borrowed from what this machine already uses ---------------------------------------------------------
get() { "$HERMES" -p "$1" config get "$2" 2>/dev/null | head -1 | tr -d '[:space:]'; }
if [ -z "$(get "$NAME" model.default)" ]; then
  DP=$(get default model.provider); DM=$(get default model.default)
  if [ -n "$DM" ]; then
    say "Using the model this machine already uses: $DM (${DP:-default provider})"
    "$HERMES" -p "$NAME" config set model.default "$DM" >/dev/null 2>&1 || die "couldn't set the model"
    [ -z "$DP" ] || "$HERMES" -p "$NAME" config set model.provider "$DP" >/dev/null 2>&1 || true
  else
    # Nothing connected: use OpenCode's free tier rather than asking for a paid key.
    MP=${MODEL%%/*}; MM=${MODEL#*/}
    say "Nothing is connected on this machine, so this uses OpenCode's free tier: $MM ($MP)."
    "$HERMES" -p "$NAME" config set model.provider "$MP" >/dev/null 2>&1 || die "couldn't set the model provider"
    "$HERMES" -p "$NAME" config set model.default "$MM" >/dev/null 2>&1 || die "couldn't set the model"
    say "If OpenCode isn't signed in on this machine the first reply will say so; \`hermes -p $NAME model\` fixes it once."
  fi
fi
say "Model: $(get "$NAME" model.default) ($(get "$NAME" model.provider))"

# --- 5. The token, the owner, and who may talk to it ------------------------------------------------------------------
# UPPER_SNAKE keys land in the profile's own .env on this machine, at mode 600. Nothing here is ever printed back.
"$HERMES" -p "$NAME" config set TELEGRAM_BOT_TOKEN "$TOKEN" >/dev/null 2>&1 || die "couldn't store the Telegram token"
"$HERMES" -p "$NAME" config set TESS_OWNER_ID "$OWNER" >/dev/null 2>&1 || die "couldn't store your id"
# The bot posts to the inbox, not to GitHub: no GitHub token here, and the person needs no account at all.
"$HERMES" -p "$NAME" config set TESS_INBOX "$INBOX" >/dev/null 2>&1 || die "couldn't store the inbox address"
"$HERMES" -p "$NAME" config set TESS_SUPPORT_TOKEN "$SUPTOKEN" >/dev/null 2>&1 || die "couldn't store the support token"
say "Reports go to $INBOX, which you read with: node tools/reports.mjs support list"

# The allowlist starts with Krish on it and nobody else. He adds people from the chat, which the skill explains.
TESS_OWNER_ID="$OWNER" HERMES_HOME="$HERMES_HOME" TESS_PROFILE="$NAME" \
  node "$BASE_DIR/bot/skills/tess-support/scripts/allowlist.mjs" add "$OWNER" Krish --as "$OWNER" >/dev/null 2>&1 \
  || die "couldn't write the allowlist"

# --- 6. Start it ------------------------------------------------------------------------------------------------------
say "Starting the gateway for '$NAME'..."
"$HERMES" -p "$NAME" gateway start >/dev/null 2>&1 \
  || die "couldn't start the gateway; start it by hand with: hermes -p $NAME gateway start"

# --- 7. A ceiling on the process -------------------------------------------------------------------------------------
# Wherever this runs, the bot gets a memory and CPU cap: a support bot that leaks or spins must not take a machine with
# it. Installed only when systemd is there and this is being run with the right to write units; otherwise said out loud.
UNIT="$BASE_DIR/tess-support.service"
if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT" ]; then
  if [ -w /etc/systemd/system ] 2>/dev/null; then
    cp "$UNIT" /etc/systemd/system/tess-support.service 2>/dev/null && systemctl daemon-reload 2>/dev/null \
      && say "Memory (1G) and CPU (50%) caps installed as a systemd unit." \
      || say "Couldn't install the systemd unit; the gateway is running without a cap. See support/tess-support.service."
  else
    say "Not root, so the cap wasn't installed. To bound it:"
    say "  sudo cp $UNIT /etc/systemd/system/ && sudo systemctl daemon-reload"
  fi
fi

say ""
say "Done. Message the bot from Telegram — it should answer you and nobody else."
say ""
say "  · Add someone:  /allow <their id> <a name>     (their id comes from @userinfobot)"
say "  · Remove them:  /deny <their id>"
say "  · See the list: /who"
say "  · Reports:      node tools/reports.mjs support list"
say "  · Restart it:   hermes -p $NAME gateway restart"
say ""
