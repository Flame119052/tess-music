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
  --labels tess-agent,tess-backup \
  --unattended \
  --replace
```

The Instabox default runner uses `--labels tess-agent,tess-primary` instead (see the Instabox section below). The
workflow sends a review to `tess-primary` when the box answers ready and to `tess-backup` when it doesn't, so a runner
missing its label waits in the queue until GitHub's 24-hour expiry. The labels on a runner already registered can be
changed in **Settings → Actions → Runners**; the ones set up on 14 Nov carry them already.

Install and authenticate at least one reviewer CLI listed in `.github/agents.json`. The runner also needs `git`,
GitHub CLI (`gh`), and Node.js 22. Do not put provider tokens in the repository or the service file.

## macOS user service

Only on a Mac that holds no Tess keys, or under a separate macOS user that can't read the owner's home folder
(`~/.config/tess-signing/` holds the signing and rescue keys; a reviewer reading an outside diff could be talked into
printing any file it can read). The default reviewer machine is the Instabox box `tess-reviewer`; `omarchy` and
`paperclip-vps` are the backups.

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

## Linux user service (a machine without the network filter)

The runners on `omarchy` and `paperclip-vps` are the **system** service GitHub's own setup made (`config.sh`, then
`./svc.sh install tess-runner`), named `actions.runner.Flame119052-tess-music.<name>.service`. A system service is what
lets the network filter in [`tools/runner/network.conf`](runner/network.conf) apply to the whole job; a user unit cannot
attach it, so a machine set up the way below reviews without that boundary.

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
   that it has the `tess-agent` label plus `tess-primary` on the Instabox default or `tess-backup` on the VPS and
   omarchy. A job whose label no runner carries waits 24 hours and then fails. The dispatcher runner carries
   `tess-dispatch` instead, runs as its own user, and must not be in the same runner group as anything else.

## What a runner machine has (set up 14 Nov on `omarchy` and `paperclip-vps`, reachable via `ssh vps`)

- A `tess-runner` account with no `sudo` rights. The runner lives in `~/actions-runner` and runs as the
  `actions.runner.Flame119052-tess-music.<name>` system service, as that user.
- In `~tess-runner/.local/bin`, installed from the official releases with checked hashes: `claude` and `gh`.
- Claude signs in with a long-lived code from `claude setup-token`, which only works through the
  `CLAUDE_CODE_OAUTH_TOKEN` variable. It sits in the runner's `.env` (mode 600). `config.sh` rewrites `.env` and
  `.path`, so set both again after re-registering, then restart the service. The reviewer passes only this one variable
  on from the job; `GH_TOKEN` never reaches it.
- Krish's Mac makes the registration token and sends it over SSH standard input (`ssh vps` for `paperclip-vps`), so the token never sits in a file or in
  an agent's instructions.

## Network: the provider's API and nothing else

A review reads an untrusted diff, and text in a diff can talk a model into running a shell command. bubblewrap keeps the
host network namespace on purpose, because the API call needs it, so the network boundary lives one level up: on the
runner service. Every process a job starts inherits it, which is why one file covers Claude and every other provider.

On `paperclip-vps` the rest of that namespace is Paperclip's PostgreSQL, its services and the Tincan relay. The drop-in
in [`tools/runner/network.conf`](runner/network.conf) refuses loopback, link-local, multicast, the three private IPv4
ranges, Tailscale's `100.64.0.0/10`, the cloud metadata address (`169.254.169.254`, inside `169.254.0.0/16`) and IPv6
unique-local. It allows one local address: the DNS stub. Public addresses stay reachable, because that is the API call.

**Installing it is a root action on that machine, so it is a separate step the owner approves.** This repository only
carries the file. It applies to the system service GitHub's `config.sh`/`svc.sh` created, not to a `systemctl --user`
unit: a user unit cannot attach the filter.

```sh
systemctl cat 'actions.runner.*'                 # the exact unit name, one per runner
sudo mkdir -p /etc/systemd/system/actions.runner.Flame119052-tess-music.<name>.service.d
sudo install -m 644 tools/runner/network.conf \
  /etc/systemd/system/actions.runner.Flame119052-tess-music.<name>.service.d/network.conf
sudo systemctl daemon-reload
sudo systemctl restart 'actions.runner.Flame119052-tess-music.<name>.service'
```

`IPAddressDeny` needs cgroup v2 and a systemd that can attach the filter (both current). Check once:
`stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`.

**DNS, which is the one thing that breaks.** The filter applies to the resolver address the machine really uses:

- **Ubuntu** (22.04 and later, Desktop and Server): `systemd-resolved` is on and `/etc/resolv.conf` points at the stub.
  `grep nameserver /etc/resolv.conf` prints `127.0.0.53`, which the file already allows. Nothing to do.
- **Arch / `omarchy`:** `systemd-resolved` is not enabled by default; NetworkManager writes the router's address there
  instead, and that address is inside a refused range. Two ways: turn it on (`sudo systemctl enable --now
  systemd-resolved`, then point `/etc/resolv.conf` at `/run/systemd/resolve/stub-resolv.conf`), which keeps this file
  unchanged; or add that one address as `IPAddressAllow=` with a comment saying why. Prefer the first: the second opens
  the router on every port, where the resolver needs only port 53. Check with `grep nameserver /etc/resolv.conf` and
  `resolvectl status`.

**Checking it**, inside the runner's own cgroup (a plain shell on the machine proves nothing, the filter is per cgroup):

```sh
# what the unit actually has
systemctl show 'actions.runner.Flame119052-tess-music.<name>.service' -p IPAddressDeny -p IPAddressAllow

# the same policy in a throwaway unit, so the checks below are honest without waiting for a review. The lists are read
# out of the file itself, so this cannot drift from what the runner will get.
DENY=$(sed -n 's/^IPAddressDeny=//p' tools/runner/network.conf | xargs)
ALLOW=$(sed -n 's/^IPAddressAllow=//p' tools/runner/network.conf | xargs)
run() { sudo systemd-run --quiet --collect --wait --pipe --unit="tess-net-check-$$" \
  --property="IPAddressDeny=$DENY" --property="IPAddressAllow=$ALLOW" "$@"; }

# a public provider API works (any answer, even a 4xx, means the connection was made)
run curl -sS --max-time 10 -o /dev/null https://api.anthropic.com/ && echo "provider API: reachable"
# and the machine's own services are not, on paperclip-vps and on omarchy alike
run curl -sS --max-time 5 http://127.0.0.1:5432/ && echo "BAD: a local service answered"
run curl -sS --max-time 5 http://169.254.169.254/ && echo "BAD: the metadata address answered"
```

The two `BAD` lines must print nothing: the exit status is non-zero because the connect was refused, which is the
result being checked. Do the same for each provider the machine reviews with (`api.openai.com`, `opencode.ai`, the
Cursor endpoint). After the restart, `journalctl -u actions.runner.Flame119052-tess-music.<name> -n 50` shows whether
jobs still start; if one does not, the journal says why — check it before allowing anything back.

## bubblewrap: the read-only boundary (required)

Every reviewer CLI runs inside `bubblewrap`, so a diff cannot talk a model into running a shell command that reads the
runner, the job's environment, or another provider's files. A machine without a working sandbox refuses that provider
with a skip reason and the next reviewer runs; no reviewer is ever started bare.

```sh
sudo apt install bubblewrap        # Debian/Ubuntu; on Arch: sudo pacman -S bubblewrap
bwrap --version
```

Unprivileged user namespaces must be on. Check on the runner machine, as `tess-runner`:

```sh
cat /proc/sys/user/max_user_namespaces            # must be greater than 0
sysctl kernel.unprivileged_userns_clone           # 1 on Debian/Ubuntu; a missing key on 12+ means they are allowed
bwrap --unshare-all --share-net --die-with-parent --ro-bind / / -- true && echo "sandbox works"
```

If the last line fails with a namespace error, the kernel setting is off or the install cannot unshare for that account.
Fixing it needs root, so the machine's owner does it; until then that machine only reviews with a provider that can run.
Each sandbox gets the review copy, the CLI and its runtime, all read-only, plus a throwaway `HOME` holding only that
provider's own config and sign-in files mounted at the paths the CLI looks in (`~/.codex` for Codex,
`~/.config/opencode` and `~/.local/share/opencode/auth.json` for OpenCode), the network for the API call, and only its
own key in the environment. `~/actions-runner`, the job's environment, and other providers' folders are not in it. A
Node-based CLI also gets its own `node` folder when Node was installed per user (nvm, for example), so an npm install
works without exposing the rest of the home folder.

## Adding another reviewer provider to a runner

Install the CLI under `tess-runner` (in `~/.local/bin`), sign it in as that user, and pass only its key through the
runner's `.env` (`CODEX_API_KEY`, `CURSOR_API_KEY` or `OPENCODE_API_KEY`; the reviewer passes on its own provider's key
and nothing else). For OpenCode, also copy `tools/opencode-reviewer.md` to
`~tess-runner/.config/opencode/agents/tess-reviewer.md`. Without it the `tess-reviewer` agent doesn't exist and `opencode
run` would fall back to its default agent, which can run shell; with a copy that differs from `main` the runner would
widen the reviewer's rights. So the review checks the file before it starts and stops with a clear message instead of
running either way. Update the copy whenever that file changes on `main`. Then restart the runner service. A provider
with no CLI on the machine is simply skipped.

GLM through the **Z.ai coding plan** is an OpenCode provider, not a separate CLI: sign the connector in as `tess-runner`
(`opencode auth login`, choosing the Z.ai coding plan) and `zai-coding-plan/glm-5.3` works by tag. It bills the Z.ai
subscription instead of OpenCode Go's per-model allowance, which GLM empties quickly. It is not a default, so a runner
without the connector still reviews everything else.

## The Instabox reviewer (default machine, set up 14 Nov)

- Box `tess-reviewer`, made with `--no-vault` so none of Krish's Instabox secrets reach a box that reads outside code.
  It pauses itself after 30 idle minutes (the free plan's fixed setting) and costs nothing while paused.
- Same setup as the other runners: a `tess-runner` user, the sandbox and a cap (3 cores, 6 GB, as the box does nothing
  else), and the workspace wiped after every job. Its runner carries the extra label `tess-primary`; the VPS and omarchy
  carry `tess-backup`.
- `tess-ready.service` runs as `nobody` with a 64 MB cap and answers `GET /ready` on port 8787. It replies 200 with the
  exact body `tess-ready` only while the runner is active and no `Runner.Worker` job is running, so a job is never pinned
  to a box that is still starting, busy or paused; every other case gets a different status or body. Its source is one
  `python3` file, `/usr/local/lib/tess-ready.py`, started by `tess-ready.service`; it uses only the standard library and
  asks `systemctl` and `pgrep`. The port is published; its URL is the repo variable `REVIEW_WAKE_URL`. Requesting it is what wakes the
  paused box, and it reveals nothing but ready or not ready.
- The workflow waits up to 12 requests of up to 5 s with 5 s pauses between them, under 2 minutes, for that answer, then sends the job to
  `tess-backup`. The `review` job carries `timeout-minutes: 30`, so a box that freezes mid-job fails the review instead
  of holding the queue. It does not cover a job still waiting in the queue: if the box pauses (or a second tag takes it)
  between answering ready and picking the job up, the job waits for it, up to GitHub's 24-hour limit. If that is ever
  seen, cancel the run and tag again; the next check sends it to a backup.
- The 30-minute pause counts idle time as Instabox defines it. A review that runs longer than that could be paused
  mid-job; if that is ever seen, the fix is the `timeout-minutes` failure above plus a second wake, not a longer pause.
- **Before setting `REVIEW_WAKE_URL`:** make sure both guards are already in place so Instabox never receives an
  unapproved fork PR or an unverified commit — (1) **"Require approval for all outside collaborators"** is turned on
  under **Settings → Actions → General**, and (2) the `REVIEW_HEAD_SHA` check in
  [`.github/workflows/agent-review.yml`](../.github/workflows/agent-review.yml) and
  [`tools/agent-review.mjs`](agent-review.mjs) is merged on `main`.
- To retire it: `instabox port unpublish tess-reviewer 8787`, remove the runner in GitHub, then `instabox rm tess-reviewer`.

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
TESS_AGENT_SLOT_WAIT_MINUTES=60

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
number of live threads this lane allows (default 2, at most 8). `TESS_AGENT_SLOT_WAIT_MINUTES` is how long a tag
waits for a free slot before it is answered "slots busy" (default 60, at most 120, and always inside the job's
360-minute limit). Restart both runner services after changing `.env`.

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

Two cases clean themselves up. A tag that finds every slot taken waits for `TESS_AGENT_SLOT_WAIT_MINUTES` (an hour by
default) and then answers "slots busy", so a stuck slot cannot leave the tag unanswered. A slot held by a job that
cannot still exist — GitHub kills a dispatch job after 360 minutes and a killed job keeps its slot — is reclaimed
once it is more than seven hours old, and the reclaim is written into the job log. A thread that outlives its job is
still running at that point only if something is badly wrong; if you see a reclaim logged while you know a thread is
live, reconcile it in T3 and raise this in the issue.

When dispatch refuses a request, the person who wrote the tag is told on the issue or pull request: a fixed reason
plus a link to the run. The text comes from `refusalReasons` in `tools/agent-dispatch.mjs`, never from an error
message, so nothing the runner learned can be published. A tag from an account outside `AGENT_ALLOWLIST` stays
silent on purpose.
