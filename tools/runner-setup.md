# Reviewer runner setup

The reviewer workflow is safe only when its runner is a dedicated, unprivileged user with no `sudo` access. The
GitHub-hosted `gate` job checks the caller and PR checks first. The self-hosted runner checks out `main` only and reads
PR changes through `gh pr diff`; it must never build or run PR code.

## Register one runner

In the repository, open **Settings → Actions → Runners → New self-hosted runner** and follow GitHub's download steps
for the machine. Put the runner in a directory owned by the dedicated user, then configure it with the temporary token
shown by GitHub:

```sh
./config.sh \
  --url https://github.com/Flame119052/tess-music \
  --token "$RUNNER_TOKEN" \
  --name "tess-agent-$(hostname -s)" \
  --labels tess-agent \
  --unattended \
  --replace
```

Install and authenticate at least one reviewer CLI listed in `.github/agents.json`. The runner also needs `git`,
GitHub CLI (`gh`), and Node.js 22. Do not put provider tokens in the repository or the service file.

## macOS user service

Only on a Mac that holds no Tess keys, or under a separate macOS user that can't read the owner's home folder
(`~/.config/tess-signing/` holds the signing and rescue keys; a reviewer reading an outside diff could be talked into
printing any file it can read). The preferred runners are `omarchy` and `paperclip-vps`.

Use a LaunchAgent, not a system LaunchDaemon. Replace `/absolute/path/to/actions-runner` below with the runner
directory:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>music.tess.agent-runner</string>
  <key>ProgramArguments</key>
  <array><string>/absolute/path/to/actions-runner/run.sh</string></array>
  <key>WorkingDirectory</key><string>/absolute/path/to/actions-runner</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/absolute/path/to/actions-runner/runner.log</string>
  <key>StandardErrorPath</key><string>/absolute/path/to/actions-runner/runner.log</string>
</dict>
</plist>
```

Save it as `~/Library/LaunchAgents/music.tess.agent-runner.plist`, then load it while signed in:

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/music.tess.agent-runner.plist
```

## Linux user service

Create `~/.config/systemd/user/tess-agent-runner.service`, replacing the two absolute paths:

```ini
[Unit]
Description=Tess reviewer GitHub Actions runner
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/actions-runner
ExecStart=/absolute/path/to/actions-runner/run.sh
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now tess-agent-runner.service
```

Keeping a user service running after logout requires linger; that is an owner/admin choice and is not part of this
setup.

## Repository settings Krish must set

1. **Actions variable:** set `AGENT_ALLOWLIST` to the comma-separated GitHub logins allowed to call
   `@tess-review`.
2. **Fork pull requests — before registering any runner:** under **Settings → Actions → General**, choose
   **"Require approval for all outside collaborators"**. The default only stops first-time contributors, and a fork PR
   could edit `check.yml` to run on `[self-hosted, tess-agent]`. On a personal repo this approval is the only thing
   stopping that, so never approve a fork run whose PR touches `.github/workflows/`. (Set on 14 Nov.)
3. **Release environment:** create an environment named `release`, add required reviewers, and allow only `main`.
   The `declare` and `promote` jobs use this environment. Until reviewers are added it does **not** pause anything
   (GitHub creates it on first use with no rules). Set on 14 Nov: reviewer Flame119052, `main` only. The signing and
   mirror keys are still repository secrets, because the dev build uses them on every merge. Moving them needs a
   separate `build` environment for the dev job and a new tess-releases deploy key (there is no local copy of the
   mirror key), which is tracked as its own issue. The agent-review workflow never names a secret.
4. **Branch protection:** protect `main`, `dev`, `beta`, and `stable`; require the `check` status where applicable,
   block force-pushes and deletions, and grant only the release workflow the bypass needed to update channel branches.
5. **Runner access:** keep the runner repository-scoped (or in a runner group limited to this repository) and confirm
   that it has the `tess-agent` label.

## What a runner machine has (set up 14 Nov on `omarchy` and `paperclip-vps`)

- A `tess-runner` account with no `sudo` rights. The runner lives in `~/actions-runner` and runs as the
  `actions.runner.Flame119052-tess-music.<name>` system service, as that user.
- In `~tess-runner/.local/bin`, installed from the official releases with checked hashes: `claude` and `gh`.
- Claude signs in with a long-lived code from `claude setup-token`, which only works through the
  `CLAUDE_CODE_OAUTH_TOKEN` variable. It sits in the runner's `.env` (mode 600). `config.sh` rewrites `.env` and
  `.path`, so set both again after re-registering, then restart the service. The reviewer passes only this one variable
  on from the job; `GH_TOKEN` never reaches it.
- Krish's Mac makes the registration token and sends it over SSH standard input, so the token never sits in a file or in
  an agent's instructions.

## Adding another reviewer provider to a runner

Install the CLI under `tess-runner` (in `~/.local/bin`), sign it in as that user, and pass only its key through the
runner's `.env` (`CODEX_API_KEY`, `CURSOR_API_KEY` or `OPENCODE_API_KEY`; the reviewer passes on its own provider's key
and nothing else). For OpenCode, also copy `tools/opencode-reviewer.md` to
`~tess-runner/.config/opencode/agents/tess-reviewer.md`. Without it the `tess-reviewer` agent doesn't exist and `opencode
run` would fall back to its default agent, which can run shell; with a copy that differs from `main` the runner would
widen the reviewer's rights. So the review checks the file before it starts and stops with a clear message instead of
running either way. Update the copy whenever that file changes on `main`. Then restart the runner service. A provider
with no CLI on the machine is simply skipped.
