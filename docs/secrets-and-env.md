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

## 4. Offline & cloud key backups

- Back up `~/.config/tess-signing/` inside an **AES-256 encrypted `.dmg`** (`hdiutil create -encryption AES-256 -stdinpass ...`).
- Keep copies off the primary Mac (for example: an external drive, a second machine over the local network, and encrypted cloud drive storage), and keep the `.dmg` passphrase separate in a password manager (e.g., Apple Passwords / iCloud Keychain).
- Store machine-specific backup paths and SHA-256 verification records in `.local/secrets-inventory.md` (gitignored, never pushed to GitHub).
