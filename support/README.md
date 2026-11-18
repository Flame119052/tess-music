# Tess Support

A support bot people message, built as a **Hermes bot** — a profile called `tess-support` — running on **Krish's VPS** as its own isolated system user (`tess-support`) on **OpenCode Go** (`opencode-go/deepseek-v4.1-flash`) with a **daily cap**. Someone says what broke, it reads Tess's own doctor report and their screenshots, works out what it is, and sends the whole thing to the **inbox** Krish already runs (`tess-music-player.janus.ing`). Krish's side (or his agents) turns that into a GitHub issue with its priority and labels.

Nobody needs a GitHub account. The VPS bot on this page is the one Krish runs.

A person's own Mac uses a separate profile, [`mac/`](mac/). The unit files below stay on the VPS. On the Mac they open a chat, the agent runs `tess doctor` and can capture the Spotify window, and the model is reached only through the support gate with their own token.

## For the person

Paste this line into Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh
```

When Terminal asks, type the code Krish gave you and press Return. The code is not part of the line, so it does not stay in Terminal's history.

**Tess Support** appears in the Dock. Click that icon, then type what went wrong.

macOS asks once to allow screen recording the first time Tess Support needs to see Spotify. Turn it on for Tess Support in System Settings, under Privacy and Security, then click the Dock icon again.

On an Intel Mac, macOS may ask once to install Command Line Tools. If a window opens, click Install.

To remove Tess Support, paste this line. It removes the Dock icon and the Tess Support profile. It leaves Hermes unless this install put Hermes on the Mac and you type `yes`.

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/mac/install.sh | sh -s -- --uninstall
```

Then ask Krish to revoke your code. Until he does, that code can still reach Tess support.

## For Krish: turn it on and give someone access

### 1. Gather four things (plus an optional tester id)

1. **A Telegram bot.** Message **@BotFather** → `/newbot` → pick a name and username ending in `bot`. It gives you `TESS_TELEGRAM_TOKEN`.
2. **Your own id.** Message **@userinfobot**; it replies with your numeric Telegram id (`TESS_OWNER_ID`).
3. **A posting token.** With your Cloudflare login, from a checkout of this repo:

   ```sh
   node tools/reports.mjs support token add "Krish bot"
   ```

   It prints `TESS_SUPPORT_TOKEN` once and stores only its SHA-256 hash in D1.
4. **An OpenCode Go API key.** Your `OPENCODE_GO_API_KEY` from OpenCode Go (used by `opencode-go/deepseek-v4.1-flash`; OpenCode's free tier returns 403 from Hermes).
5. **Optional:** your trusted tester's numeric Telegram id (`TESS_ALLOW_IDS`, e.g. from `@userinfobot`), and optional daily cap overrides (`TESS_DAILY_REPLY_CAP`, `TESS_DAILY_USER_CAP`, `TESS_DAILY_TOKEN_CAP`).

### 2. Turn it on (one install command on the VPS)

SSH into your VPS, export those environment variables so no secret ever appears on a command line (`ps`), and run [`setup.sh`](setup.sh) with `sudo -E`:

```sh
export TESS_TELEGRAM_TOKEN='...'
export TESS_OWNER_ID='...'
export TESS_SUPPORT_TOKEN='...'
export OPENCODE_GO_API_KEY='...'
export TESS_ALLOW_IDS='...'          # optional: your trusted tester's numeric id

curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/setup.sh -o /tmp/tess-setup.sh
sudo -E sh /tmp/tess-setup.sh
rm -f /tmp/tess-setup.sh
```

You can also run `sudo sh /tmp/tess-setup.sh` with no exported variables and answer the interactive prompts at the terminal (`/dev/tty`). It is safe to run again to update the bot or rotate keys.

What `setup.sh` does:
- Ignores inherited `HOME`, `HERMES_HOME`, `TESS_BOT_HOME`, `TESS_CAP_HOME`, and `TESS_SYSTEMD_DIR` when run as `root` (even via `sudo -E`), refuses `TESS_TEST=1` unless both an explicit scratch `TESS_TEST_ROOT` and faked system tools are present, resolves physical paths, refuses `..` traversal/symlinks, uses fd-safe `O_NOFOLLOW` permission checks, and refuses Paperclip/PostgreSQL paths.
- Creates two dedicated unprivileged system users: `tess-cap` (`/home/tess-cap`, holding the real `OPENCODE_GO_API_KEY` and enforced cap state) and `tess-support` (`/home/tess-support`, running the Hermes bot).
- Installs Hermes inside `/home/tess-support` (as `tess-support`, never as `root`), installs the `tess-support` profile with `model.base_url: http://127.0.0.1:4193/v1`, installs [`cap-proxy/proxy.mjs`](cap-proxy/proxy.mjs) root-owned under `/home/tess-cap/cap-proxy`, and locks down `plugins/` as root-owned (`0755`/`0644`).
- Writes the real `OPENCODE_GO_API_KEY` and generated local `TESS_CAP_PROXY_TOKEN` into `/home/tess-cap/.env` (`tess-cap:tess-cap`, mode `600`), and writes the bot's secrets (with only the local proxy token in `OPENCODE_GO_API_KEY` and `OPENCODE_GO_BASE_URL=http://127.0.0.1:4193/v1`) into `/home/tess-support/.hermes/profiles/tess-support/.env` at mode `600` (shell builtins only — zero secrets on any command line).
- Seeds `allow.txt` and `TELEGRAM_ALLOWED_USERS` with Krish (and any `TESS_ALLOW_IDS`).
- Installs [`tess-cap.service`](tess-cap.service) and [`tess-support.service`](tess-support.service) in `/etc/systemd/system/`, reloads systemd, and enables/restarts `tess-cap` followed by `tess-support`.

> [!NOTE]
> Keep this bot to **yourself and one trusted tester** (`TESS_ALLOW_IDS`). Do not turn it into a public multi-user service on a personal OpenCode Go plan.

### 3. Give someone access (or take it away) in one command

Adding or removing someone is **one command over SSH** on the VPS — never from inside the Telegram chat:

```sh
# Give someone access (replace <id> with their numeric id from @userinfobot)
sudo -u tess-support node /home/tess-support/.hermes/profiles/tess-support/skills/tess-support/scripts/allowlist.mjs add <id> <name> --restart

# Take access away
sudo -u tess-support node /home/tess-support/.hermes/profiles/tess-support/skills/tess-support/scripts/allowlist.mjs remove <id> --restart

# See who currently has access
sudo -u tess-support node /home/tess-support/.hermes/profiles/tess-support/skills/tess-support/scripts/allowlist.mjs list
```

Message the bot from your Telegram account first, then send your tester the link: **https://t.me/\<your bot's username\>**.

## Who can use it

Three gates, none relying on model judgement or in-bot state:

1. **The allowlist (`allow.txt` + `TELEGRAM_ALLOWED_USERS`)**, checked by Hermes before the model is called. A gateway with no list refuses everyone. `allowlist.mjs` refuses wildcards (`*`), phone numbers, anything other than a 5–15 digit Telegram id, and removing Krish; it atomically rewrites `allow.txt` and `.env` at mode `600`, logs every change, and `--restart` signals the systemd service `MainPID` so systemd brings the gateway right back with the updated list without needing root.
2. **The out-of-process daily-cap & key proxy ([`cap-proxy/proxy.mjs`](cap-proxy/proxy.mjs) running as `tess-cap`):**
   - Listens on `127.0.0.1:4193` only (`TESS_CAP_PORT` override), authenticates requests with `TESS_CAP_PROXY_TOKEN` via constant-time comparison, and strictly allows only `POST /v1/chat/completions` on loopback `Host` headers (refusing `CONNECT`, `Upgrade`, other routes/methods, dot segments, and escapes before forwarding).
   - Holds the real `OPENCODE_GO_API_KEY` in `/home/tess-cap/.env` (`0600`, unreadable to `tess-support`) and stores cap counters in systemd `StateDirectory=tess-cap` (`/var/lib/tess-cap/daily-cap.json`, `0700`, unreachable by `tess-support` via both Unix permissions and `InaccessiblePaths`).
   - Enforces **40 replies/day** total across all users (`TESS_DAILY_REPLY_CAP`), **20/day** per person when the request carries a Telegram user id (`TESS_DAILY_USER_CAP`), and an optional **daily token budget** (`TESS_DAILY_TOKEN_CAP`) counted from upstream response `usage` (JSON and SSE). Fails closed on cap hit (`429` `terminal_quota_exhausted`), symlinked/corrupt state (`503`), and never resets counters on malformed upstream responses.
   - `plugins/daily-cap/` stays enabled only for a friendly early UX message and naive tool-path hygiene; `tess-cap` is the real enforced limit.
3. **The posting token (`TESS_SUPPORT_TOKEN`)**, checked by the Cloudflare Worker on `POST /v1/support` (stored as SHA-256).

Anyone not on the allowlist gets one polite refusal and 24 hours of silence (`unauthorized_dm_behavior: decline`).

**The secrets that remain in `tess-support`.** The bot's process **never holds `OPENCODE_GO_API_KEY`** — it only holds `TELEGRAM_BOT_TOKEN`, `TESS_SUPPORT_TOKEN`, and the local `TESS_CAP_PROXY_TOKEN` (which can only spend within the daily cap on `POST /v1/chat/completions`). A compromised bot could still read `TELEGRAM_BOT_TOKEN` or `TESS_SUPPORT_TOKEN` until revoked (`/revoke` in BotFather, or `node tools/reports.mjs support token revoke "<label>"`). No GitHub token is on the VPS, and Paperclip / PostgreSQL / `tess-cap` are unreachable from `tess-support`.

## Paperclip comes first (shared VPS isolation)

Paperclip owns its own directories and services on the VPS and always has priority. Both `tess-support` and `tess-cap` are fenced at user and kernel levels:

- **Dedicated unprivileged users (`tess-support` and `tess-cap`):** own only `/home/tess-support` and `/home/tess-cap` (`nologin` shells). `setup.sh` runs Hermes commands via `runuser -u tess-support` and refuses any path or username referencing `paperclip`, `postgres`, or `root`.
- **Resource limits:** [`tess-support.service`](tess-support.service) caps `MemoryMax=512M`, `MemorySwapMax=0`, `CPUQuota=50%`, `TasksMax=64`, `Nice=19`, `IOSchedulingClass=idle`; [`tess-cap.service`](tess-cap.service) caps `MemoryMax=128M`, `MemorySwapMax=0`, `CPUQuota=25%`, `TasksMax=32`, `Nice=19`, `IOSchedulingClass=idle`.
- **Kernel filesystem isolation:** Both units enforce `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ProtectHome=read-only`, and `InaccessiblePaths` over `-/srv/paperclip -/home/paperclip -/var/lib/postgresql -/run/postgresql` (plus `tess-support` blocks `-/home/tess-cap -/var/lib/tess-cap`, and `tess-cap` blocks `-/home/tess-support`).
- **No Tincan / Paperclip integration:** neither service ever connects to PostgreSQL, `/srv/paperclip`, any Paperclip service, or the Tincan relay.

## What a person does

1. Message the bot on Telegram. Say what's wrong, in any words.
2. Send a screenshot, or a few seconds of screen recording they make themselves (**Shift-Cmd-5**).
3. Paste one line into Terminal: `tess report`.
4. Paste back what it printed.
5. Get told what's happening, and that fixes arrive on their own.

They never file anything, never need a GitHub account, and the bot never touches their Mac. A person Krish set up on their own Mac follows [For the person](#for-the-person) instead of these Telegram steps.

## The proxy, skills, and plugin

| Component | Where / When it runs | What it settles |
| --- | --- | --- |
| `cap-proxy/proxy.mjs` | `tess-cap.service` (`127.0.0.1:4193`) | real `OPENCODE_GO_API_KEY`, `POST /v1/chat/completions` allowlist, enforced 40/day global, 20/day per-person & optional token cap (`StateDirectory=tess-cap`), resets `00:00 UTC` |
| `plugins/daily-cap` | `pre_llm_call`, `pre_tool_call` | friendly early UX message and naive tool-path hygiene (not the enforced security boundary) |
| `tess-support` | any message about Tess being broken | the front door: tone, order of the visit, hard limits |
| `tess-evidence` | they need to show something | screenshots, and a recording of **only the Spotify window** made with Cmd-Shift-5 |
| `tess-repro` | roughly know what's wrong | exact steps — page, song type, window size, what they clicked — **confirmed by them** |
| `tess-duplicate` | just before filing | the cached open-issue titles the inbox serves via `inbox.mjs issues`; a match attaches there |
| `tess-gather` | before triage | `tess report`, versions, macOS, Mac type, `tess status`, update-log lines — all scrubbed |
| `tess-triage` | before filing | P0–P3 and the area per `docs/triage.md`, **with the reason in one line** |
| `tess-handoff` | at the end | one report to the inbox via `inbox.mjs report`, folder deleted, plain words to user and Krish |

## The disk, and the process

The bot is allowed to hold a person's screenshots and recording only as long as needed to post the report. `bot/skills/tess-support/scripts/session.mjs` enforces it:

- **One folder per visit**, under `$HERMES_HOME/cache/support/sessions`.
- **Recordings: 50 MB and 2 minutes.** Over that, re-encoded with `ffmpeg` if available, or refused.
- **Deleted immediately when the inbox accepts the report.** Only one line in `handoffs.log` stays: report id, time, file count, size.
- **24-hour sweep and 500 MB ceiling** across the cache folder.
- **No background processes.** Every command finishes cleanly.
- **Single gateway:** under systemd, `ExecStart=... -p tess-support gateway run` owns the foreground process. Never run `hermes gateway start` alongside the systemd service.

## The bot never files

It has no GitHub token, no `gh`, and no GitHub write of any kind. It sends **one report to the inbox and stops**; you — or your own agents, with your Cloudflare login — read it with `tools/reports.mjs` and file the GitHub issue with its labels. `tools/test-support.mjs` fails if anything in `support/bot/` grows a GitHub write.

## Where a report goes

```
person ──message──▶ tess-support on VPS ──127.0.0.1:4193──▶ tess-cap proxy ──▶ OpenCode Go
                        │
                        └──POST /v1/support──▶ inbox at tess-music-player.janus.ing ──▶ D1 (+ R2 clip)
                                                                                           │
                                                                       your Cloudflare login
                                                                                           ▼
                                                           node tools/reports.mjs support list | show | filed
                                                                                           │
                                                                           you (or your agent) file the issue
```

- The bot posts **one JSON payload** via `inbox.mjs` (pinned to `https://tess-music-player.janus.ing`, reading files by verified open handle inside the session folder).
- The Worker checks the token, validates priority/areas/kind, applies shared `privacy.mjs` `clean()`, and stores it with **no read endpoint** (`GET` returns `404`).
- Read and file from your Mac:

  ```sh
  node tools/reports.mjs support list                 # unfiled first
  node tools/reports.mjs support show 12              # words, diagnosis, write-up, labels, gh command
  node tools/reports.mjs support filed 12 --issue https://github.com/Flame119052/tess-music/issues/90
  ```

## What runs where

| Where | What |
| --- | --- |
| Their Mac (Telegram) | Spotify, Tess, and `tess report`, which they start. The bot does not install anything. |
| Their Mac (Dock) | **Tess Support** in the Dock and the `tess-support` profile. Hermes is added only when it was not already there (D-105). |
| Krish's VPS (`tess-cap`) | Isolated `tess-cap` user + systemd service, real `OPENCODE_GO_API_KEY`, `cap-proxy/proxy.mjs`, enforced `StateDirectory=tess-cap`. |
| Krish's VPS (`tess-support`) | Isolated `tess-support` user + systemd service, proxy token + Telegram/inbox `.env`, early-UX `daily-cap` plugin. |
| Paperclip on VPS | Completely untouched (`/srv/paperclip`, PostgreSQL, Paperclip services, Tincan relay). |
| Cloudflare | The inbox: stores reports and recordings, serves nothing back. |
| Your Mac / Agents | `tools/reports.mjs` → the GitHub issue. |

## What it costs

Hermes and Telegram are free, the Worker is on Cloudflare's existing setup (noting R2 requires a payment method on file within the free allowance), and the model uses **Krish's existing OpenCode Go plan** bounded by `tess-cap`'s enforced daily cap (40 shared replies/day, 20/person/day by default) so a burst or compromised tool call cannot burn through quota or leak the key.

## How to check it

```sh
node tools/test-cap-proxy.mjs        # route/host allowlist, cap persistence, malformed upstream, permission isolation
node tools/test-inbox-support.mjs    # endpoint + D1 + privacy.mjs + token hashing (no deploy)
node tools/test-session.mjs          # session caps, sweeping, symlink/hardlink checks
node tools/test-support.mjs          # triage, inbox handoff, allowlist, daily-cap plugin, setup.sh
node tools/test-support-mac.mjs      # Mac profile in a scratch home, and a refused token
node tools/test-support-mac-install.mjs  # installer with a fake Dock, fake disk tools, and fake curl
```

Once installed on the VPS, check in order:
1. `sudo systemctl status tess-cap tess-support` — both active, owned by `tess-cap` and `tess-support`, memory/CPU capped.
2. From a Telegram account **not** on the allowlist — one-line refusal, then silence.
3. From Krish's account — `"my tess looks broken"`; short reply powered by `opencode-go/deepseek-v4.1-flash`.
4. `sudo -u tess-support node /home/tess-support/.hermes/profiles/tess-support/skills/tess-support/scripts/allowlist.mjs list` — lists Krish (and your trusted tester if added).
5. One full test report — `node tools/reports.mjs support list` shows it with the right priority and labels.

## Before it can work: three things on your side

- **Apply schema:** `npx wrangler@4 d1 execute tess-inbox --remote --file schema.sql` from `inbox/`.
- **Create R2 bucket:** `npx wrangler@4 r2 bucket create tess-support`.
- **Deploy Worker:** `npx wrangler@4 deploy` from `inbox/` (with `SALT` secret configured).

## Where the secrets live

- `/home/tess-cap/.env` (`tess-cap:tess-cap`, mode `600`, read-only to the running proxy): real `OPENCODE_GO_API_KEY`, `TESS_CAP_PROXY_TOKEN`, upstream URL, loopback listen host/port, and enforced cap limits (`TESS_DAILY_REPLY_CAP`, `TESS_DAILY_USER_CAP`, optional `TESS_DAILY_TOKEN_CAP`).
- `/home/tess-support/.hermes/profiles/tess-support/.env` (`tess-support:tess-support`, mode `600`, read-only to the running gateway): `TELEGRAM_BOT_TOKEN`, local proxy token (`OPENCODE_GO_API_KEY` + `OPENCODE_GO_BASE_URL=http://127.0.0.1:4193/v1`), `TESS_OWNER_ID`, `TESS_SUPPORT_TOKEN`, `TESS_INBOX`, and `TELEGRAM_ALLOWED_USERS`. Names only are in [`docs/secrets-and-env.md`](../docs/secrets-and-env.md).

## Known limits

- **The bot has a real terminal on the VPS**, scoped to user `tess-support` with `ProtectSystem=strict`, `ProtectHome=read-only`, `InaccessiblePaths` over Paperclip/PostgreSQL/`tess-cap`, and read-only `.env`/`allow.txt`.
- **Telegram refuses videos over 20 MB**; screenshots always work.
- **`support/` has no area label** in `docs/triage.md` yet; changes to it are reviewed as sensitive.
