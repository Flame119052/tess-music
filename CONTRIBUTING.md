# Contributing to Tess Music

Thanks for wanting to help with Tess Music. Before writing code or opening an issue, read these three files:

1. [`AGENTS.md`](AGENTS.md) — rules that never break (safe folder swap, sandbox testing, secrets, privacy), repo map, dev loop, and how every change is verified with proof.
2. [`DESIGN.md`](DESIGN.md) — design principles, Liquid Glass tokens, motion rules, and performance budget.
3. [`docs/triage.md`](docs/triage.md) — how issues are sorted by priority (`P0`–`P3`), area (`area:*`), type, status, and phase milestone.

## Reporting bugs or suggesting changes

- **Security vulnerabilities:** do **not** open a public issue. Use [GitHub Security Advisories](https://github.com/Flame119052/tess-music/security/advisories/new) (see [`SECURITY.md`](SECURITY.md)).
- **Bugs & feature ideas:** use the [issue forms](https://github.com/Flame119052/tess-music/issues/new/choose) and pick the right area (`theme`, `patcher`, `installer`, `mini`, `companion`, `release-ci`, `docs`).

## Local checks before sending changes

```sh
tools/check-safety.sh
node tools/build.mjs && node --check theme/Tess/theme.js && node --check theme/loader/loader.js
node tools/test-dial-pick.mjs
cd patcher && go test ./src/cmd/ && go vet ./src/cmd/
```

See [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) for the full checklist and proof expectations.
