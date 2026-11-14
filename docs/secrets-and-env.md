# Secrets & Environment Handling

How Tess Music stores, loads, and backs up secrets across **local development**, **GitHub Actions (CI/CD)**, and **Cloudflare (`inbox/`)** without ever committing sensitive material to Git.

## 1. Where secrets live

| Secret | Local (Mac) | Cloud (CI / Worker) | Purpose |
| --- | --- | --- | --- |
| Release key (Ed25519) | `~/.config/tess-signing/private.pem` | GitHub Actions `TESS_SIGNING_KEY` | Signs `theme.js`, `user.css`, and `components.txt` |
| Code-signing identity | `~/.config/tess-signing/codesign.p12` + `codesign.pass` | GitHub Actions `TESS_CODESIGN_P12` + `TESS_CODESIGN_PASS` | Signs `tess-patcher`, `tess-verify`, and Tess Mini with `"Tess Music"` |
| Mirror deploy key | *(uses local `gh` / git auth)* | GitHub Actions `TESS_MIRROR_KEY` | Pushes builds to `Flame119052/tess-releases` |
| Rescue key (Ed25519) | `~/.config/tess-signing/rescue.pem` (**Mac only**) | **Never in GitHub / CI** | Signs emergency rescue orders via [`tools/rescue.mjs`](../tools/rescue.mjs) |
| Inbox IP hash salt | `inbox/.dev.vars` (if running locally) | Cloudflare Worker secret `SALT` | Salts hashed IPs in [`inbox/worker.js`](../inbox/worker.js) |
| Cloudflare auth | `npx wrangler@4 login` session | Cloudflare dashboard / API | Deploys `inbox/` and reads D1/KV reports |

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
- **Sandbox testing ([`installer/tess-install.sh`](../installer/tess-install.sh)):** Uses `TESS_TEST=1`, `TESS_HOME`, `TESS_CONFIG`, `TESS_SPOTIFY`, and `TESS_CHANNEL` (`stable` | `beta` | `dev`). See [`.env.example`](../.env.example).
- **Support bot ([`support/`](../support/README.md), D-65, D-66):** Runs on Krish's server, not on anyone's Mac, and
  holds four values in `~/.hermes/profiles/tess-support/.env` at mode 600: `TELEGRAM_BOT_TOKEN`, `TESS_OWNER_ID`,
  `TESS_SUPPORT_TOKEN` (its inbox posting token) and `TESS_INBOX`. It has **no GitHub token at all** — filing happens
  with Krish's own Cloudflare and GitHub logins on his machine. [`support/setup.sh`](../support/setup.sh) writes them
  from values he passes; none is committed, printed back, or sent to a person's machine.
- **Support recordings (R2):** bucket `tess-support`, bound as `SUPPORT` in `inbox/wrangler.toml`. Written by the
  Worker, never served back, deleted when the report is filed or at 14 days. Set the bucket's lifecycle rule to 14 days
  as the second belt; the object names are `support/<report id>.<ext>`.
- **Support posting tokens (inbox):** minted by `node tools/reports.mjs support token add "<label>"` and stored in D1
  as a plain SHA-256, never as the token. Revoke with `support token revoke "<label>"`. The page for what may be
  written where is here, not in the repo, because the hashes live with the reports.

## 4. Offline & cloud key backups

- Back up `~/.config/tess-signing/` inside an **AES-256 encrypted `.dmg`** (`hdiutil create -encryption AES-256 -stdinpass ...`).
- Keep copies off the primary Mac (for example: an external drive, a second machine over the local network, and encrypted cloud drive storage), and keep the `.dmg` passphrase separate in a password manager (e.g., Apple Passwords / iCloud Keychain).
- Store machine-specific backup paths and SHA-256 verification records in `.local/secrets-inventory.md` (gitignored, never pushed to GitHub).
