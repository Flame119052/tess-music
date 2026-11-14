# Tess Support

A support bot people message, built as a **Hermes bot** — a profile called `tess-support` — running on **Krish's
server** on **OpenCode's free tier**. Someone says what broke, it reads Tess's own doctor report and their screenshots,
works out what it is, and sends the whole thing to the **inbox** Krish already runs. Krish's side turns that into a
GitHub issue with its priority and labels.

Nobody installs anything, nobody needs a GitHub account, and nothing of Tess's runs on their Mac.

## For Krish: turn it on, once

1. **A Telegram bot.** Message **@BotFather** → `/newbot` → a name and a username ending in `bot`. It replies with a
   token.
2. **Your own id.** Message **@userinfobot**; it replies with a number.
3. **A posting token.** With your Cloudflare login, from a checkout of this repo:

   ```sh
   node tools/reports.mjs support token add "Krish bot"
   ```

   It prints a token once and stores only its hash, so a copy of the database can't leak it.
4. **A machine** — yours, and **not** the one running Paperclip. The setup script refuses that machine outright.
5. **OpenCode** signed in on that machine (free tier). If it isn't, the first reply from the bot says so and
   `hermes -p tess-support model` fixes it in one step.

Then, on the server:

```sh
curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/support/setup.sh | \
  TESS_TELEGRAM_TOKEN=… TESS_OWNER_ID=… TESS_SUPPORT_TOKEN=… sh
```

It installs Hermes if it's missing, installs the bot, keeps the model already connected there (falling back to
OpenCode's free tier), stores the three values in the bot's own `.env` at mode 600, puts you on the allowlist and nobody
else, and starts the gateway. Run it again to update.

Message the bot from your own account. Then give someone the link: **https://t.me/<your bot's username>**.

## Who can use it

Two gates, both yours, and neither is a prompt rule:

1. **The allowlist**, checked by Hermes before the model is called. A gateway with no list refuses everyone. From your
   own account, in the bot's chat:

   ```
   /allow 123456789 Sam — asked in the Discord
   /deny 123456789
   /who
   ```

   The number is their Telegram user id, from @userinfobot — not their phone number, and it never enters this repo.
   `bot/skills/tess-support/scripts/allowlist.mjs` refuses a wildcard, anything that isn't a numeric id, a request that
   didn't come from your id, and removing you; it rewrites the list and the gateway's `.env` at 600, atomically, logs
   every change, and restarts the gateway so a removal takes effect now.

2. **The posting token**, checked by the Worker. Without it, a report is refused — so even a bot that has been talked
   into something silly can't write to your inbox.

Anyone else who messages the bot gets one polite refusal and then silence. No pairing code, no way to ask for access.

## What a person does

1. Message the bot. Say what's wrong, in any words.
2. Send a screenshot, or a few seconds of screen recording they make themselves (**Shift-Cmd-5**).
3. Paste one line into Terminal: `tess report`.
4. Paste back what it printed.
5. Get told what's happening, and that fixes arrive on their own.

They never file anything, never need an account, and the bot never touches their Mac.

## The six skills

Each is its own short file under `bot/skills/`, with its own trigger, so the bot loads one thing at a time:

| Skill | When it loads | What it settles |
| --- | --- | --- |
| `tess-support` | any message about Tess being broken | the front door: tone, order of the visit, hard limits |
| `tess-evidence` | they need to show something | screenshots, and a recording of **only the Spotify window** that they make with Cmd-Shift-5; the bot accepts the file, checks its type and size, and never records anything itself |
| `tess-repro` | you know roughly what's wrong | exact steps — page, song type, window size, what they clicked — **confirmed by them** |
| `tess-duplicate` | just before filing | the cached open-issue titles the inbox serves; a match attaches to that issue instead |
| `tess-gather` | before triage | `tess report`, versions, macOS, Mac type, `tess status`, update-log lines — all scrubbed |
| `tess-triage` | before filing | P0–P3 and the area per `docs/triage.md`, **with the reason in one line** |
| `tess-handoff` | at the end | one report to the inbox, the folder deleted, plain words to them and to you |

## The disk, and the process

The bot is allowed to hold a person's screenshots and a recording for exactly as long as it needs them, and not a
minute longer. `bot/skills/tess-support/scripts/session.mjs` enforces it:

- **One folder per visit**, under `$HERMES_HOME/cache/support/sessions`. Everything they send goes in it.
- **Recordings: 50 MB and 2 minutes.** Over that, it re-encodes down with `ffmpeg` if it's there, and refuses if it
  isn't — it never keeps a big file to sort out later.
- **The folder is deleted the moment the inbox accepts the report.** What's left is one line in `handoffs.log`: report
  id, time, file count, size.
- **Anything older than 24 hours is swept**, and the total is held under **500 MB**, so a crash can't leave a folder
  behind and a burst can't fill the disk.
- **No background processes.** Every command finishes; nothing watches a folder.
- **The process is capped only when systemd owns it.** [`tess-support.service`](tess-support.service) is a template
  giving the bot its own user, `MemoryMax=1G` and `CPUQuota=50%`. `setup.sh` fills in your user and paths and starts the
  bot **through that unit** when it runs as root on a systemd machine; otherwise it starts the gateway plainly and
  **says the process is not capped**, because that is the truth. Two gateways on one profile fight over the same
  session store, so it never does both.

## Where a report goes

```
person ──message──▶ bot on your server ──POST /v1/support──▶ the inbox at tess-music-player.janus.ing ──▶ D1
                                                                                                  │
                                                                              your Cloudflare login
                                                                                                  ▼
                                                    node tools/reports.mjs support list | show | filed
                                                                                                  │
                                                                    you (or your agent) file the issue
```

- The bot posts **one JSON payload**: their words, its diagnosis, a suggested priority, areas and kind, the doctor
  report's install id, and the finished write-up.
- The Worker checks the token, checks that the priority, areas and kind are real ones, and stores it. There is **no read
  endpoint** — nothing comes back out over the web, same rule the health reports have always had.
- You read it with your Cloudflare login:

  ```sh
  node tools/reports.mjs support list                 # unfiled first
  node tools/reports.mjs support show 12              # the words, the diagnosis, the finished write-up, the labels
  node tools/reports.mjs support filed 12 --issue https://github.com/Flame119052/tess-music/issues/90
  ```

  `support show` prints the exact `gh issue create` line with the labels on it, so filing is one paste — for you or for
  your agent.
- The bot also sends you one short Telegram line per report, so you know something arrived.

## What runs where

| Where | What |
| --- | --- |
| Their Mac | Nothing new. Spotify, Tess, and `tess report` which they start. |
| Your server | The bot and its posting token. One process. |
| Cloudflare | The inbox: stores it, serves nothing back. Same free plan as today. |
| Your Mac | `tools/reports.mjs` → the GitHub issue. |

**Never Paperclip.** `setup.sh` checks for `/srv/paperclip` and refuses before installing anything.

## What it costs

Hermes is free, Telegram is free, the inbox is already running and the new rows are smaller than the health reports it
stores, and the model is OpenCode's free tier. **Nothing here bills anything.**

## How to check it

```sh
node tools/test-inbox.mjs    # the new endpoint, locally, no Cloudflare account and no deploy
node tools/test-support.mjs  # the bot's triage, the payload, the allowlist, the setup script
```

`test-inbox` drives the real `inbox/worker.js` against a real SQLite database built from `inbox/schema.sql`: no token,
a wrong token and a revoked token are refused and store nothing; an approved one stores the report with its label; a bad
priority, a made-up area or a missing title is refused; an oversized body is refused; and there is no GET for it.

`test-support` runs the triage step on real-shaped doctor reports, checks the payload carries only fields the endpoint
accepts and no secret, checks the allowlist refusals, and runs `setup.sh` against a **real `tar` over a real archive**
laid out the way GitHub ships them, with a stub `hermes`.

Once it's running, four checks in order:

1. From an account **not** on the list — one-line refusal, nothing else.
2. From your account — "my tess looks broken"; one short question, then a screenshot request.
3. `/who` — lists you.
4. A real blank-window report — `support list` shows it, with the right priority.

## Before it can work: two things on your side

- **Applying the schema.** The new tables are in `inbox/schema.sql`; run it once against D1
  (`npx wrangler@4 d1 execute tess-inbox --remote --file schema.sql` from `inbox/`). Until then the support endpoint
  answers `503` — and the nightly job still cleans the health reports, because that cleanup runs before the support one
  and the support one is wrapped in its own `try`.
- **Creating the R2 bucket** (`npx wrangler@4 r2 bucket create tess-support`) before `wrangler deploy`: a bound bucket
  that doesn't exist fails the deploy outright.
- **Deploying the Worker** (`npx wrangler@4 deploy` from `inbox/`). Neither is done by this PR, and neither was done by
  me.

## Where the secrets live

`~/.hermes/profiles/tess-support/.env` on that server, mode 600, outside this repo: `TELEGRAM_BOT_TOKEN`,
`TESS_OWNER_ID`, `TESS_SUPPORT_TOKEN`, `TESS_INBOX`. Names only are in [`docs/secrets-and-env.md`](../docs/secrets-and-env.md).
If a token leaks: `/revoke` in BotFather, or `node tools/reports.mjs support token revoke "<label>"`. Neither can reach
a person's Mac.

## Known limits

- **The bot has a real terminal on that server.** `config.yaml` removes the desktop, computer-use and browser toolsets,
  and `approvals` denies dangerous commands in unattended contexts, but a shell is a shell. What it can reach is one
  posting token and a public repo; every access change is logged and echoed to you.
- **A screen recording over 20 MB** is refused by Telegram; screenshots always work.
- **`support/` has no area label** in `docs/triage.md` yet; it is reviewed as sensitive, because it ships a program.
