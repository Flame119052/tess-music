# Secrets & Environment Handling

How Tess Music stores, loads, and backs up secrets across **local development**, **GitHub Actions (CI/CD)**, and **Cloudflare (`inbox/`)** without ever committing sensitive material to Git.

## 1. Where secrets live

| Secret | Local (Mac) | Cloud (CI / Worker) | Purpose |
| --- | --- | --- | --- |
| Release key (Ed25519) | `~/.config/tess-signing/private.pem` | GitHub Actions `TESS_SIGNING_KEY` | Signs `theme.js`, `user.css`, and `components.txt` |
| Code-signing identity | `~/.config/tess-signing/codesign.p12` + `codesign.pass` | GitHub Actions `TESS_CODESIGN_P12` + `TESS_CODESIGN_PASS` | Signs `tess-patcher`, `tess-verify`, and Tess Mini with `"Tess Music"` |
| Mirror deploy key | *(uses local `gh` / git auth)* | GitHub Actions `TESS_MIRROR_KEY` | Pushes builds to `Flame119052/tess-releases` |
| Rescue key (Ed25519) | `~/.config/tess-signing/rescue.pem` (**Mac only**) | **Never in GitHub / CI** | Signs emergency rescue orders via [`tools/rescue.mjs`](../tools/rescue.mjs) |
| Inbox IP hash salt | `inbox/.dev.vars` (if running locally) | Cloudflare Worker secret `SALT`, **required** (`wrangler secret put SALT`; at least 16 characters) | Salts hashed IPs in [`inbox/worker.js`](../inbox/worker.js). With no usable salt the Worker answers 503 and stores nothing, because an unsalted hash of an IPv4 address is reversible |
| OpenCode Go key for support chat | Not on a person's Mac. A local wrangler test can put a fake value in `inbox/.dev.vars` (gitignored) | Cloudflare Worker secret `OPENCODE_GO_API_KEY` (`npx wrangler@4 secret put OPENCODE_GO_API_KEY` from `inbox/`). Never a `[vars]` entry and never in git | Attached only to the Worker's own request to `https://opencode.ai/zen/go/v1/chat/completions`. `POST /v1/support/chat` answers 503 and does not call upstream when this secret is missing (D-103) |
| Cloudflare auth | `npx wrangler@4 login` session | Cloudflare dashboard / API | Deploys `inbox/` and reads D1/KV reports |
| Reviewer plan logins | `~/.config/tess-codex-ci/auth.json` (Codex only) | Actions secrets `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`, `OPENCODE_API_KEY`, `ZHIPU_API_KEY` | The hosted AI reviewer. Every one is a subscription login; no pay-per-use API key is used (D-71, D-73). Setup and the Codex renewal step: [`tools/runner-setup.md`](../tools/runner-setup.md) |

## 2. Repo safeguards (`.gitignore`)

[`.gitignore`](../.gitignore) blocks accidental commits of:
- Environment files (`.env`, `.env.*`, `!.env.example`, `.dev.vars`, `.dev.vars.*`)
- Wrangler local state (`.wrangler/`)
- Raw key, certificate, passphrase, and encrypted backup files (`*.pem`, `*.p12`, `*.key`, `*.pass`, `*.dmg`, `*.keychain`, `*.keychain-db`)
- Machine-specific private notes (`.local/`, `*.local.md`)

> [!IMPORTANT]
> If the repo sits on an external drive mounted with `noowners`, keep raw keys out of the project directory altogether. Store them under `~/.config/tess-signing/` (`chmod 700` directory, `chmod 600` files) on the internal system volume, and use `.env` only for non-secret local defaults.

## 3. How scripts load configuration

- **Releases ([`tools/release.mjs`](../tools/release.mjs)):** Reads `TESS_SIGNING_KEY`, `TESS_CODESIGN_P12`, `TESS_CODESIGN_PASS`, and `TESS_MIRROR_KEY_FILE` from `process.env` in CI, and falls back to `~/.config/tess-signing/` locally.
- **Promotion ([`tools/promote.mjs`](../tools/promote.mjs)):** Uses `TESS_MIRROR_KEY_FILE` in CI or local git/GitHub auth locally.
- **Rescue orders ([`tools/rescue.mjs`](../tools/rescue.mjs)):** Always reads `~/.config/tess-signing/rescue.pem` directly so the rescue key never needs to live in CI or `.env`.
- **Support bot ([`support/`](../support/README.md), D-76, D-77, D-95, D-102):** Runs on Krish's VPS split across two
  unprivileged system users (never `root`, never touching `/srv/paperclip`, PostgreSQL, or Tincan):
  `tess-cap` holds the real `OPENCODE_GO_API_KEY`, local `TESS_CAP_PROXY_TOKEN`, loopback listener settings, and
  enforced daily cap limits (`TESS_DAILY_REPLY_CAP`, `TESS_DAILY_USER_CAP`, optional `TESS_DAILY_TOKEN_CAP`) in
  `/home/tess-cap/.env` at mode `600`; `tess-support` holds `TELEGRAM_BOT_TOKEN`, the local proxy bearer token as
  `OPENCODE_GO_API_KEY` + `OPENCODE_GO_BASE_URL`, `TESS_OWNER_ID`, `TESS_SUPPORT_TOKEN`, `TESS_INBOX`, and
  `TELEGRAM_ALLOWED_USERS` in `/home/tess-support/.hermes/profiles/tess-support/.env` at mode `600`, written without
  putting secrets on any command line and mounted read-only to each systemd service. Neither user holds a GitHub token
  — filing happens with Krish's own Cloudflare and GitHub logins on his machine.
- **Support posting tokens (inbox):** minted by `node tools/reports.mjs support token add "<label>"`, stored in D1 as a
  plain SHA-256, revoked with `support token revoke "<label>"`. Recordings go to the `tess-support` R2 bucket, never the
  database, and are deleted when the report is filed or at 14 days. The same token is the bearer for
  `POST /v1/support/chat` (D-103). Revoking it stops both routes.
- **Support chat settings (inbox vars, not secrets):** set in [`inbox/wrangler.toml`](../inbox/wrangler.toml).
  `SUPPORT_MODEL` is `deepseek-v4.1-flash`. `SUPPORT_CHAT_PERSON_REQUESTS` is 80 and `SUPPORT_CHAT_SHARED_REQUESTS` is
  400 per UTC day. `SUPPORT_CHAT_PERSON_TOKENS` is 300000 and `SUPPORT_CHAT_SHARED_TOKENS` is 2000000; a token var of
  `0` turns that budget off. Counters live in the existing `limits` table. Token totals move only when the upstream
  body includes a usable `usage` object.
- **Sandbox testing ([`installer/tess-install.sh`](../installer/tess-install.sh)):** Uses `TESS_TEST=1`, `TESS_HOME`, `TESS_CONFIG`, `TESS_SPOTIFY`, and `TESS_CHANNEL` (`stable` | `beta` | `dev`). See [`.env.example`](../.env.example). A checkout's copy of any installer script refuses to act outside a sandbox — sourcing one does nothing at all — and needs `TESS_REAL_INSTALL=1` before it will run on a real Mac ([#107](https://github.com/Flame119052/tess-music/issues/107)).

## 4. Offline & cloud key backups

- Back up `~/.config/tess-signing/` inside an **AES-256 encrypted `.dmg`** (`hdiutil create -encryption AES-256 -stdinpass ...`).
- Keep copies off the primary Mac (for example: an external drive, a second machine over the local network, and encrypted cloud drive storage), and keep the `.dmg` passphrase separate in a password manager (e.g., Apple Passwords / iCloud Keychain).
- Store machine-specific backup paths and SHA-256 verification records in `.local/secrets-inventory.md` (gitignored, never pushed to GitHub).
