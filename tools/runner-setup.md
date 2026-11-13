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
   could edit `check.yml` to run on `[self-hosted, tess-agent]`.
3. **Release environment:** create an environment named `release`, add required reviewers, and allow only `main`.
   The `declare` and `promote` jobs use this environment. Until reviewers are added it does **not** pause anything
   (GitHub creates it on first use with no rules). Move `TESS_SIGNING_KEY` and `TESS_MIRROR_KEY` from repository
   secrets into this environment so only approved jobs can read them.
4. **Branch protection:** protect `main`, `dev`, `beta`, and `stable`; require the `check` status where applicable,
   block force-pushes and deletions, and grant only the release workflow the bypass needed to update channel branches.
5. **Runner access:** keep the runner repository-scoped (or in a runner group limited to this repository) and confirm
   that it has the `tess-agent` label.
