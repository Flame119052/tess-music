@AGENTS.md

# Claude-specific notes

- Everything in `AGENTS.md` applies. Read `DESIGN.md` before any change to how Tess looks or moves,
  `docs/architecture.md` before touching the installer, updater, patcher or release flow, and
  `docs/secrets-and-env.md` before touching signing, env vars, CI secrets, or Cloudflare Worker config.
- Claude Code's tool output is not seen by Krish: report results in your reply, with the evidence (numbers,
  screenshots, test output).
- Krish works across several threads. Start a thread by reading `docs/status.md` and the GitHub issue you were given;
  end it by commenting the evidence on that issue and updating `docs/status.md` if state changed.
- Prefer the repo's tools (`tools/hot.mjs`, `tools/cdp.mjs`, `tools/bench.mjs`, `tools/cpu-ab.mjs`) over ad-hoc
  scripts; if you write a useful new one, add it to `tools/` with a usage line at the top.
