# Reviewer setup (GitHub-hosted)

Every `@tess-review` runs as an ordinary GitHub Actions job on `ubuntu-latest`. GitHub-hosted machines are free and
unlimited for this public repository, each review gets a brand-new virtual machine, and the machine is deleted when the
job ends. There are no self-hosted runners, no T3 and no Tailscale in this path (D-66 supersedes D-65).

The `gate` job checks the caller, the request, the **repository the PR head lives in**, and the exact commit first (the
rules live in `tools/agent-gate.sh`, which the tests drive with a fake `gh`). The `review` job then installs the one
reviewer CLI it picked and hands that reviewer only its own provider's key. The checkout is `main`, never the pull
request, and the reviewer reads the change as data.

## Secrets Krish adds (Settings → Secrets and variables → Actions → Secrets)

**Plans only.** Every secret below is a subscription login. The reviewer never uses a pay-per-use API key: a review must
not bill by the token, so `CODEX_API_KEY` and `CURSOR_API_KEY` are gone and must not come back.

| Secret | Which reviewer | Where the value comes from |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude (plan) | Run `claude setup-token` on a machine signed in to the Claude account and paste the token it prints. It is a long-lived headless sign-in (about a year); run it again when it expires. <https://code.claude.com/docs/en/authentication> |
| `CODEX_AUTH_JSON` | Codex (ChatGPT plan) | `node tools/codex-ci-login.mjs` — see below. Never an OpenAI API key. |
| `OPENCODE_API_KEY` | OpenCode Go (plan) | Subscribe to OpenCode Go (or Go Plus) in the OpenCode console, then copy the key. Both the `opencode` and `opencode-go` providers read this one variable. <https://opencode.ai/docs/console/go> |
| `ZHIPU_API_KEY` | OpenCode, Z.ai coding plan only (plan) | The GLM Coding Plan key from the Z.ai console. The `zai-coding-plan` provider reads `ZHIPU_API_KEY` (models.dev). Optional: without it the Z.ai connector is refused by name and OpenCode Go still reviews. |

Each secret is a repository secret, never an environment or a job-level variable: the review step is the only place it
is used, and the workflow gives it a value only when that provider is the one the tag named. `tools/agent-review.mjs`
builds the reviewer's environment from scratch and never passes `GH_TOKEN` or another provider's login to it.

### The Codex plan login (`CODEX_AUTH_JSON`)

Codex's own docs, under "Use ChatGPT-managed auth in CI/CD (advanced)", say exactly this
(<https://developers.openai.com/codex/non-interactive-mode>):

> Treat `~/.codex/auth.json` like a password: it contains access tokens. Don't commit it, paste it into tickets, or share
> it in chat.
>
> Do not use this workflow for public or open-source repositories. If `codex login` is not an option on the runner, seed
> `auth.json` through secure storage, run Codex on the runner so Codex refreshes it in place, and persist the updated file
> between runs.

The caution is about a login reaching code written by someone else. Here the gate refuses a fork's head before any job
holding a secret exists, only an allowlisted account can tag a review, and the login never enters the sandbox at all:
the review process reads it and the proxy adds the access token to the one inference route (D-73). So the plan path is
safe in this repository, and it is what keeps Codex off the OpenAI API bill.

The second half of that caution is why this setup needs a recurring step. The vendor's advice is to persist the refreshed
`auth.json` between runs; a GitHub-hosted workflow cannot write a repository secret, so nothing can persist the rotated
file. Instead the review never starts inside the last 12 hours of the token, and Krish renews it by hand.

A dedicated login, so his own Codex session is never touched:

```sh
node tools/codex-ci-login.mjs          # sign in (device auth) in ~/.config/tess-codex-ci, then upload the secret
node tools/codex-ci-login.mjs --check  # say how long the stored login has left, change nothing
```

The script uses its own `CODEX_HOME` (`~/.config/tess-codex-ci`), so `~/.codex` is never read or written. It refuses a
login that is not `auth_mode: chatgpt`, checks that `codex login status` reports ChatGPT, and uploads the `auth.json` to
the secret with `gh secret set`, on stdin, without printing it.

**Renew it every ~9 days.** The access token inside the login lasts about 10 days. A refresh rotates the refresh token,
and a rotation on the disposable runner would be written to a file that is deleted minutes later, so the review does not
refresh: it refuses to start inside the last 12 hours of the token and says so in the PR comment. Run the command again
before then; `--check` tells you how many days are left. This is the one part of the reviewer setup that needs a
recurring human step.

Set one with the CLI if you prefer:

```sh
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R Flame119052/tess-music
gh secret set CODEX_AUTH_JSON -R Flame119052/tess-music   # prefer node tools/codex-ci-login.mjs
gh secret set OPENCODE_API_KEY -R Flame119052/tess-music
gh secret set ZHIPU_API_KEY -R Flame119052/tess-music
```

## Variables Krish sets (Settings → Secrets and variables → Actions → Variables)

1. **`AGENT_ALLOWLIST`** — the comma-separated GitHub logins allowed to call `@tess-review`. Already set to
   `Flame119052`. A tag from anyone else is ignored.
2. **`USAGE_SNAPSHOT_MAC`, `USAGE_SNAPSHOT_VPS`, `USAGE_SNAPSHOT_OMARCHY`** — optional, and only once
   [#93](https://github.com/Flame119052/tess-music/issues/93) publishes them. Each awake machine writes one plain
   variable with how much of each provider's quota is left; it holds no key, no account name and no balance. The review
   uses the freshest snapshot and ignores anything older than 30 minutes, then falls back to "no numbers, so usable".
   The shape is the publisher's:

   ```json
   {
     "version": 1,
     "machine": "mac",
     "takenAt": "2026-11-15T04:00:00Z",
     "providers": [
       { "provider": "claude", "instance": "claudeAgent",
         "windows": [ { "kind": "session", "leftPercent": 40, "resetsAt": "2026-11-15T07:50:00Z", "pace": "on pace" } ] },
       { "provider": "opencode", "instance": "opencode-go",
         "windows": [ { "kind": "weekly", "leftPercent": 62, "resetsAt": "2026-11-17T18:00:00Z" } ] }
     ]
   }
   ```

   `leftPercent` is the share left; a window's length comes from its kind (`session` 5 hours, `weekly` 7 days). An
   OpenCode model is matched to its own connector (`opencode-go` or `zai-coding-plan`), never to OpenCode as a whole.
   The review comment names the source machine and age, for example `Usage: mac, 5 min old`. A machine added later only
   needs its own `USAGE_SNAPSHOT_<NAME>` variable and a line in the workflow.

## Repository settings

1. **Fork pull requests:** under **Settings → Actions → General**, choose **"Require approval for all outside
   collaborators"**. A fork PR can edit `check.yml`, and approving that run would let it use this repository's workflow
   permissions. The review job itself never runs for a fork PR: the gate (`tools/agent-gate.sh`) asks which repository
   the PR head lives in and refuses anything that is not a branch of this repository, even when an allowlisted maintainer
   tagged it and its CI is green, and the review checks the same rule again before fetching. Never approve a fork run
   whose PR touches `.github/workflows/`.
2. **Release environment:** keep the environment named `release`, with required reviewers and `main` only, for the
   `declare` and `promote` jobs. The review workflow names no signing secret.
3. **Branch protection:** protect `main`, `dev`, `beta` and `stable`; require the `check` status where it applies, block
   force-pushes and deletions, and let only the release workflow bypass it to update channel branches.

## What one review job does

1. Checks out `main` (no credentials kept) and installs Node 22.
2. Lets bubblewrap start, then proves it works (below).
3. `node tools/agent-review.mjs pick <role> <tier>` reads the reviewer the tag named and checks it against the hard rules
   — plans-only list, installed CLI, `strong` for a sensitive change, an `author=` that is known and is not the reviewer's
   own provider, usage, any reserve, and the Codex login's expiry. It prints that provider, model and effort. A tag that
   breaks a rule gets a comment on the pull request and the job stops; it never picks a substitute.
4. Installs only that provider's CLI, at a pinned version.
5. Runs `node tools/agent-review.mjs <role> <number>` with only that provider's login in its environment. The script
   snapshots the change, runs the CLI inside bubblewrap, and posts the review with the `gh` token it keeps away from
   the reviewer. The posted verdict names the commit it read, and the head is checked once more immediately before
   posting, so a push during the review gets a re-tag instead of a verdict about a commit nobody read.
6. A step that runs only when the job has already failed (`if: failure()`) posts one marker comment naming what broke,
   using the same command with `stop` and only the job's own token, so a review that stops without a verdict is never
   silent.

The review job has `timeout-minutes: 30`, and the VM is thrown away afterwards.

## bubblewrap on the hosted machine

Every reviewer CLI runs inside `bubblewrap`, so a diff cannot talk a model into reading the job's files or keys: the
sandbox starts empty and gets only the review copy, the CLI, its runtime, TLS/DNS files, that provider's own config and
sign-in files, and its own key. No reviewer is ever started bare.

Unprivileged user namespaces are what bubblewrap needs, and Ubuntu 24.04 (what `ubuntu-latest` gives us) restricts them
through AppArmor. The job therefore runs:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
sudo apt-get install -y --no-install-recommends bubblewrap
bwrap --unshare-all --share-net --die-with-parent --ro-bind / / -- true
```

That is safe here because the machine exists for one review: it holds only this job's one provider key and a
`GITHUB_TOKEN` that can comment on this repository, and it is deleted afterwards. The last line is the real check. If
user namespaces cannot be enabled, or bubblewrap cannot start, **the job stops and nothing is reviewed**: there is no
switch to run a reviewer unsandboxed.

`--share-net` is deliberate, because the API call needs it. The network is the VM's own: nothing of Krish's runs there,
so an induced shell command can reach the internet and nothing private. On a self-hosted machine this was never true;
that is why this path exists.

To check the same thing on a Mac or a Linux box (for example while changing a CLI's flags):

```sh
bwrap --unshare-all --share-net --die-with-parent --ro-bind / / -- true && echo "sandbox works"
cat /proc/sys/user/max_user_namespaces      # must be greater than 0
```

## Adding a provider

1. Add the CLI install step in `.github/workflows/agent-review.yml`, gated on
   `steps.pick.outputs.provider == '<name>'`, with a pinned version.
2. Add the provider to `installedProviders` in `tools/agent-review.mjs` so the pick step offers it, and add its secret
   name to `providerKeys` there so the reviewer gets that key and the "looks like a key" check covers it.
3. Add the secret in repository settings, named exactly as in `providerKeys`.
4. Add its models to `.github/agents.json` under `allowed`, with a `cost`, and place them in a role list.
5. For OpenCode the `tess-reviewer` agent file is copied from `tools/opencode-reviewer.md` in the install step; the
   review stops if the installed copy differs from the file on `main`. That file also carries OpenCode's step cap
   (`steps: 12`), so a change to the cap reaches the job through this copy.

## Retiring the old self-hosted runners

Do this after this path is merged and one review has run on GitHub's machine. Until then the old runners can still take
a queued job.

1. **Delete the runners in GitHub:** Settings → Actions → Runners → remove `tess-instabox`, `tess-vps` and
   `tess-omarchy`. Their labels (`tess-agent`, `tess-primary`, `tess-backup`) go with them.
2. **`paperclip-vps`** (reach with `ssh vps`) and **`omarchy`**, on each machine:

   ```sh
   systemctl list-units 'actions.runner.*' --all      # the exact name; <machine> is tess-vps or tess-omarchy
   sudo systemctl disable --now 'actions.runner.Flame119052-tess-music.<machine>.service'
   sudo rm -rf '/etc/systemd/system/actions.runner.Flame119052-tess-music.<machine>.service.d'   # the old network drop-in
   sudo systemctl daemon-reload
   sudo rm -rf /home/tess-runner/actions-runner
   sudo userdel -r tess-runner        # also removes its .env, which held the Claude token
   ```

   If that machine instead ran the user service from an earlier setup, as `tess-runner` run
   `systemctl --user disable --now tess-agent-runner` and delete `~/.config/systemd/user/tess-agent-runner.service`.
3. **Instabox:** `instabox port unpublish tess-reviewer 8787`, then `instabox rm tess-reviewer`. The box, its
   `tess-ready` service and its runner all go together.
4. **The wake variable:** `gh variable delete REVIEW_WAKE_URL -R Flame119052/tess-music`.
5. **Keep** `AGENT_ALLOWLIST`, and add the provider secrets above. Once one review has run on `ubuntu-latest`, the old
   machines are no longer part of anything.

[#94](https://github.com/Flame119052/tess-music/issues/94) (restricting what a runner can reach) and
[#95](https://github.com/Flame119052/tess-music/issues/95) (a review stuck behind a paused Instabox) are moot once this
is merged: there is no runner machine and no box to be stuck behind.
