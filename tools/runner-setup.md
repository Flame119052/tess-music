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

<<<<<<< HEAD
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
- `tess-ready.service` (user `nobody`, 64 MB) answers `GET /ready` on port 8787 with 200 when the runner is up. The port
  is published; its URL is the repo variable `REVIEW_WAKE_URL`. Requesting it is what wakes the paused box. It reveals
  nothing but ready or not ready.
- To retire it: `instabox port unpublish tess-reviewer 8787`, remove the runner in GitHub, then `instabox rm tess-reviewer`.
