# Reviewer runner setup

The reviewer workflow is safe only when its runner is a dedicated, unprivileged user with no `sudo` access. The
GitHub-hosted `gate` job checks the caller and PR checks first. The self-hosted runner checks out `main` only and reads
PR changes through `gh pr diff`; it must never build or run PR code.

The `@tess-agent` dispatcher is a second, different runner: another user, another label, and its own home directory.
Its setup and boundaries are at the end of this page. Nothing that runs as `tess-runner` may read the dispatcher's
credential.

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
   `@tess-review` and `@tess-agent`.
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
   that it has the `tess-agent` label. The dispatcher runner carries `tess-dispatch` instead, runs as its own user,
   and must not be in the same runner group as anything else.

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

## One-time `@tess-agent` dispatcher setup

The dispatcher is separate from the read-only reviewer, and it must stay separate: it holds a credential that can
start full T3 threads on the machines that keep Tess's signing and rescue keys.

**Its own user, never `tess-runner`.** Create a dedicated, unprivileged account, `tess-dispatch`, with no `sudo`
rights and a home directory only it can read (`chmod 700`, owner `tess-dispatch`). No reviewer runner, no other job,
and no shared installation directory may use that account. Run exactly two GitHub runner instances as it and give
both the `tess-dispatch` label. They may share a host with the reviewer, but each Actions runner needs its own
installation directory and service. Both must inherit the same private slot directory. GitHub leaves a third job
queued while the two instances are busy; the slots are a second cap if another runner is registered by mistake.

**The job hook is what makes that boundary real.** A same-repository pull request can add a workflow with
`runs-on: [self-hosted, tess-dispatch]` and read everything a job on that runner can read. Fork approval does not
cover branches in this repository, and a `fix` thread can push one. So each instance's `.env` sets the runner's
job-started hook, which refuses every job that is not an `issue_comment` run of the dispatch workflow from `main`:

```sh
cp tools/runner-hook.sh ~tess-dispatch/.local/bin/tess-dispatch-hook.sh
```

Then set this value in `~tess-dispatch/actions-runner/.env` (mode 600) and restart both services:

```dotenv
ACTIONS_RUNNER_HOOK_JOB_STARTED=/home/tess-dispatch/.local/bin/tess-dispatch-hook.sh
```

Check it after any change, including a runner upgrade: run any other workflow by hand (a `workflow_dispatch`, or a
`pull_request` from this repository) and confirm its job fails to start with `tess-dispatch: refusing this job` in
the runner log. The hook fails closed, so a missing event name refuses too. `node tools/test-agent-dispatch.mjs`
covers the hook's decisions.

On the Mac, turn on linked environments and link Instabox, `paperclip-vps`, and `omarchy`. Make sure this repository
is a T3 project on each target. The Mac itself is the fourth target, and `omarchy` the second default. `paperclip-vps`
and the Mac are used only when the tag names them. Sign `gh` in on each target so the started thread can post its
marked result and, for `fix`, push its branch.

The dispatcher signs in to the Mac's HTTPS `/mcp` address as an outside OAuth client. Use an OAuth-capable MCP client
on the dispatcher host to start that sign-in, approve it once in T3 with your own pairing code, and choose an access
ceiling that can start the intended threads. A plain environment token, T3 Connect relay token, provider login, or
GitHub token does not work. This repository does not register the OAuth client and must never receive the pairing
code. The approval lasts 30 days; repeat the outside-agent sign-in when it expires.

Keep the OAuth-issued credential in a file only `tess-dispatch` can read, not in the job environment: the runner
copies its `.env` into every job it starts, and a process listing shows a job's environment. Only the routing values
go in `~tess-dispatch/actions-runner/.env` (mode 600):

```sh
mkdir -p -m 700 ~tess-dispatch/.config/tess-agent-dispatch
printf '%s\n' '<OAuth-issued outside-agent access token>' > ~tess-dispatch/.config/tess-agent-dispatch/credential
chmod 600 ~tess-dispatch/.config/tess-agent-dispatch/credential
```

```dotenv
TESS_T3_MCP_URL=https://<mac-environment-address>/mcp
TESS_T3_MCP_CREDENTIAL_FILE=/home/tess-dispatch/.config/tess-agent-dispatch/credential
TESS_AGENT_SLOT_DIR=/home/tess-dispatch/.local/state/tess-agent-dispatch
TESS_AGENT_SLOTS=2

TESS_T3_INSTABOX_ENVIRONMENT_ID=<T3 environment id>
TESS_T3_INSTABOX_PROJECT_ID=<Tess project id there>
TESS_T3_VPS_ENVIRONMENT_ID=<T3 environment id>
TESS_T3_VPS_PROJECT_ID=<Tess project id there>
TESS_T3_OMARCHY_ENVIRONMENT_ID=<T3 environment id>
TESS_T3_OMARCHY_PROJECT_ID=<Tess project id there>
TESS_T3_MAC_ENVIRONMENT_ID=<Mac T3 environment id; optional because the endpoint reports it>
TESS_T3_MAC_PROJECT_ID=<Tess project id on the Mac>
```

`TESS_T3_MCP_OAUTH_TOKEN` still works for a quick trial, but a file is preferred for the reason above. Never put any
of it in this repository or a GitHub secret.

Use the T3 environment and project IDs shown by T3; labels are not stable identifiers. `TESS_AGENT_SLOTS` is the
number of live threads this lane allows (default 2, at most 8). Restart both runner services after changing `.env`.

Before the first tag, run the read-only preflight as `tess-dispatch` on the dispatcher host. It proves the sign-in and
the machine IDs and starts nothing:

```sh
set -a; . ~tess-dispatch/actions-runner/.env; set +a
node tools/agent-dispatch.mjs check
```

Every line should say `ready` or `not configured`, never `unreachable` for a machine you meant to use.

Each occupied slot contains `owner.json` with the GitHub comment, the machine it went to, and the launch retry key. A
slot normally disappears after `t3_thread_wait` confirms the thread and all of its delegated work settled. If a
network failure leaves one behind, find that thread in T3 by its `Tess <task>: #<number>` title and GitHub comment,
then confirm it completed or stop it. Remove that one slot directory only after reconciliation. Never clear all slots
just to make the queue move.

When dispatch refuses a request, the person who wrote the tag is told on the issue or pull request: a fixed reason
plus a link to the run. The text comes from `refusalReasons` in `tools/agent-dispatch.mjs`, never from an error
message, so nothing the runner learned can be published. A tag from an account outside `AGENT_ALLOWLIST` stays
silent on purpose.
