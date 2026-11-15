# How work moves: issue → approach → PR → dev → beta → stable

This is the owner's process for every change to Tess (D-63, #71). Agents and people both follow it.

## The three channels

| Channel | Who has it | What it is |
| --- | --- | --- |
| `dev` | Krish's Mac only | Live `main`. Every merged PR builds here automatically. |
| `beta` | Anyone on beta | Made when Krish **declares a release**: every PR merged since the last beta, in one build. |
| `stable` | Everyone else | That beta build, after its bugs are fixed and Krish **promotes** it. |

Only `beta` and `stable` are public. The release workflow does it:
- `release` builds `main` to dev.
- `declare` copies dev to beta and writes the release notes from the merged PRs.
- `promote` copies beta to stable.

## The path for one change

1. **Issue.** Every change starts as an issue. It says the goal, the check, and what blocks it.
2. **Approach.** The agent picking up the issue posts its plan as a comment: what changes, which files, how it will be checked.
3. **Approach review.** For changes that need one (see tiers below), the agent tags the reviewer in that comment (`@tess-review approach`). A reviewer agent runs on a self-hosted runner on one of the reviewer machines (Instabox, or whichever backup is idle), reads the issue and the plan, and replies **approve** or **changes needed**.
4. **PR.** The change lands as a pull request into `main`, with `(#issue)` in its title.
5. **Checks.** CI (`check.yml`: safety gate, builds, tests) must pass. No AI reviewer runs on a PR whose checks haven't passed.
6. **PR review.** The agent tags `@tess-review pr`. The reviewer reads the diff against the approved plan and the issue's check, and posts a review.
7. **Merge.** Krish merges. That builds dev, and Krish's Mac gets it.
8. **Release.** When Krish declares a release, everything merged since the last beta becomes the next beta. When it's clean, he promotes it to stable.

## How much review a change needs (tiers)

The tier comes from the paths the PR touches. `tools/agent-review.mjs` works it out, so nobody has to judge.

| Tier | Touches | Approach review | PR review | Krish |
| --- | --- | --- | --- | --- |
| **docs** | only `docs/`, `*.md`, issue templates | no | no (CI only) | merges |
| **normal** | theme, Tess Mini, tools | no | yes, lighter model | merges |
| **sensitive** | `installer/`, `inbox/`, `patcher/`, `.github/`, `tools/release.mjs`, `tools/promote.mjs`, `tools/rescue.mjs`, `tools/check-safety.sh`, signing, rescue | yes, strong model | yes, strong model | reviews and merges |

**Which model reviews what:**
- The **strong model** reviews the approach, because a wrong design is the costliest mistake.
- A **lighter model** reviews normal PRs against the approved plan.
- Sensitive work gets the strong model at both steps.

So no change runs the strongest model twice unless it can break someone's Mac.

## Choosing a reviewer (the agent asking does this)

The agent that writes the approach comment or opens the PR picks who reviews it, and puts the choice in the tag:

```
@tess-review approach provider=claude model=claude-opus-5-5 effort=high
@tess-review pr provider=codex model=gpt-6.1-terra effort=medium
```

**One file holds what changes.** [`.github/agents.json`](../.github/agents.json) is the only place with model names,
their order per role, what a tag may ask for, what one review costs, and any quota kept back. This page explains how to
read it and when to change it; it does not repeat the values.

| Field | What it decides |
| --- | --- |
| `approach`, `pr_normal`, `pr_sensitive` | the models tried for that role, first to last |
| `allowed` | every model a tag may name |
| `strong` | the models sensitive work may use |
| `efforts` | the effort words a tag may ask for |
| `cost` | what one review costs: `light` (pennies), `medium` (worth a thought), `heavy` (a visible bite out of a weekly pool) |
| `caps` | the hard limit on one review: wall clock, turns, dollars, steps, and the share of a 5-hour window each model is assumed to use |
| `reserve` | quota kept back per provider, as the % left per window kind, with a plain `note` and an optional `until` date |
| `notes` | dated, temporary facts, such as a model with its own pool; not rules |

**The runner picks by itself.** It tries the role's list from the top and skips a candidate, naming it and the reason in
the posted comment, when:
- its CLI is not installed on that machine;
- a usage window is already used up (a window that has reset no longer counts);
- it is **on pace to run out before its reset**, even with usage left — Claude at 84% of a week with two days to go;
- fewer than three reviews are left in its 5-hour window (each model has its own per-review share in `caps`, so a cheap
  model still runs when a heavy one would not);
- it is inside a `reserve` amount that has not expired;
- the machine has no working `bubblewrap` sandbox (see below).

A requested reviewer that is filtered out is named in the comment too, never silently replaced. Usage the hub has no
numbers for is treated as usable, and the CLI's own error then moves the runner on, which the comment also names.

**What the agent still checks by hand, before tagging.** The runner knows usage; it does not know what the change is
worth.
1. **Open `provider_usage` in T3** — the tool that reads the same hub the runners read. It shows the **session (5-hour)**
   and **weekly** windows, the share left in each, and when each renews.
2. **Read the pace, not just what is left.** On the morning of 15 Nov, Claude had 59% of its session left but only 16% of
   its week, with two days to run; Codex had 93% of its session and 89% of its week. Only one was safe to spend that
   morning, and the session numbers alone would have picked the wrong one.
3. **Spend to the size of the change.** One review per stage, and a second only after a fix changed something a reviewer
   would read differently. `caps` and `cost` say what a review takes, and every review now has a hard cap (below).
4. **Then pick from the role's list**, skipping anything you just ruled out.

Some pools are separate, and a provider's `notes` in the config say which: a model with its own weekly pool leaves the
shared pool alone, and a connector that bills on top of a subscription costs more than the weight alone suggests.

Which model is good at what comes from the providers' own docs, review benchmarks, and what developers said on X,
Hacker News and Reddit in Sep–Nov 2026. Sources are in [`docs/research/reviewer-models-2026-11.md`](research/reviewer-models-2026-11.md).

**Left out on purpose:**
- **Grok 4.7:** reviews well but uses by far the most tokens per review.
- **Zed:** hosts other agents and has no command-line reviewer of its own.
- **Devin:** has no read-only mode when run without a person.
- **ZCode:** starts with every permission on when run without a person.
- **Cline:** can't block shell commands without a hook.
- **Copilot:** possible later.
- **Antigravity:** can't sign in on a server yet.

Every reviewer runs inside a real boundary, whichever provider it is. Each CLI starts inside **bubblewrap** (`bwrap`,
unprivileged, with `--unshare-all --share-net --die-with-parent`) in an empty filesystem where only these are bound,
read-only: the review copy, the CLI and its runtime (`/usr`, `/lib*`, `/etc/ssl`, `/etc/resolv.conf`), and that
provider's own config and sign-in files, mounted **inside** the throwaway `HOME` at the paths its CLI looks in
(`~/.codex` for Codex, `~/.config/opencode` and `~/.local/share/opencode/auth.json` for OpenCode) — a mount at the
runner's real home is invisible once `HOME` changes. It gets only its own key in the environment. It cannot see
`~/actions-runner`, the job's other keys, or another provider's folder. A machine without `bubblewrap`, or with user
namespaces switched off, refuses that provider with a skip reason and tries the next one: no reviewer is run bare.
`--share-net` is deliberate, because the API call needs it, so the **network** is limited one level up: the
`actions.runner.*` service carries [`tools/runner/network.conf`](../tools/runner/network.conf), which refuses loopback,
link-local, multicast, every private range, Tailscale and the cloud metadata address, and allows only the local DNS stub.
One file therefore covers Claude and every other provider, and a command a diff talks a model into running reaches its
own API and nothing else on the machine.

On top of that, each CLI is told to stay read-only:
- Claude: `--restricted --safe-mode` with only the Read, Grep and Glob tools.
- Codex: `--sandbox read-only --ephemeral --ignore-rules --skip-git-repo-check`, with project document loading off
  (`project_doc_max_bytes=0`). That flag limits the shell commands the model may ask for; the boundary above is what
  stops it reading the runner. The git check has to be skipped because the review copy is a `git archive`, with no
  `.git` in it.
- Cursor: `--mode ask --sandbox enabled`.
- OpenCode: the `tess-reviewer` agent (`tools/opencode-reviewer.md`), which denies everything except reading, and denies
  `external_directory` so reads stop at the review copy. The runner's copy must match that file on `main` exactly, or the
  review stops instead of running under wider rules. That file is sensitive work: a PR that changes it gets the strong
  reviewer, never "docs only".

Any agent settings shipped inside a PR (`.opencode`, `.cursor`, `.claude` and the like) are removed from the review copy
first, at any depth and in any letter case, together with the PR's own `AGENTS.md` and `CLAUDE.md`: a reviewer reads a PR
as data, never as instructions. A file that is a link is removed too, because a link can point at the runner's own files
(the diff already shows where a link pointed). Before a review is posted, it is also refused if its text contains the
value of any key the job holds, `GH_TOKEN` included.

### Every review has a hard cap

A review must never take a large share of an allowance, so each one is bounded before it starts. The numbers are in
`.github/agents.json` under `caps`; one edit changes them everywhere, and the test checks the ones each CLI accepts.

| Provider | What stops a review | Notes |
| --- | --- | --- |
| Claude | `--max-turns 12`, `--max-budget-usd` (60 cents for Opus, 30 for Sonnet), `--output-format json` | `--max-turns` is real but hidden from `--help` in 2.1.x. The dollar figure is a client-side estimate of API list prices, not the plan's own meter, so it is a guardrail beside the turn cap. The JSON result is what lets the comment say the turns, dollars and tokens a review used. |
| Codex | `-c model_reasoning_effort=…`, `-c model_auto_compact_token_limit=180000`, `--json` | Codex has no turn or budget cap in `exec` mode. Compaction at 180k tokens keeps one review inside the context it started with, and `--json` reports the tokens used, which the comment then states. |
| Cursor | the 480 s timeout, `--mode ask`, `--sandbox enabled` | Cursor offers no cap it can be told about, so time is the only limit. Only Cursor's own models (Composer) are allowed: a Claude or GPT model inside Cursor bills prepaid credit from the first request. |
| OpenCode | `steps: 12` in the `tess-reviewer` agent file | On the last step OpenCode drops the tools and asks for a summary, which is the review. The agent file must match `tools/opencode-reviewer.md` exactly, and the test keeps its number equal to `caps.opencode.steps`. |
| **All of them** | a 600 s wall clock (480 s for `gpt-6.1-terra` and Cursor) | The process is killed at the limit, bubblewrap takes its children with it, and the posted comment names it: `Skipped: codex/gpt-6.1-sol (timed out after 600s)`. |

A review's wall clock and its share of a window are different things: the timeout stops a stuck or runaway run, while
`caps.per_review_pct` decides whether there is enough left to start one (three reviews kept in hand). A CLI that stops
because of one of these caps is a skip like any other: the next reviewer runs and the comment says `hit its cap`, because
a review that ran out of turns says nothing about the change.
Measured so far,
as a share of a 5-hour window: `gpt-6.1-sol` 7, `gpt-6.1-terra` 3, `opencode-go/glm-5.3` 4,
`opencode-go/glm-5.3-flash` 0.2, `opencode-go/deepseek-v4.1-flash` 0.1. Claude reports no numbers of its own, so it keeps
the cautious 10% fallback. A model with no figure therefore behaves exactly as before.

**Rules.**
- Don't use the strongest model at both stages unless the work is sensitive.
- The reviewer should come from a different provider than the agent that wrote the change, so it doesn't share the same blind spots.
- Usage comes before preference, and the runner applies it: exhausted usage, a provider on pace to run out, or reserved quota all skip it before it starts.
- Only models listed under `allowed` in `.github/agents.json` are accepted. Sensitive work must use one listed under `strong`. If the request breaks a rule, the runner falls back to the defaults for that role and says so in its comment.
- Leaving the choice out is fine: the defaults are the first model in that role's list that can run.
- Only allowlisted accounts can tag. Krish can use the same syntax himself.

### How to update this

Everything below is one edit to `.github/agents.json`, then `node tools/test-agent-review.mjs`, then a PR. The test
checks that every allowed model has a cost weight, that every default is an allowed model with a valid effort, that the
caps name allowed models, that the OpenCode step cap matches the agent file, and that every note stays dated.

- **A new model came out.** Add it to `allowed` for its provider, give it a `cost` and, once measured, a
  `caps.per_review_pct`, then put it where it should be tried: a role list, or nowhere (allowed by tag only). Add it to
  `strong` only if sensitive work may use it.
- **A provider changed its limits.** Nothing to edit: the usage hub reads the limits by itself. The share of a 5-hour
  window one review is assumed to take is `caps.per_review_pct`, per model, in `.github/agents.json`; a model with no
  entry falls back to a cautious 10% in `tools/agent-review.mjs`, changed only with a measured cost per review to point
  at.
- **Change what one review may spend.** Edit `caps` in `.github/agents.json`: `timeout_s` and `timeout_s_by_model` (the
  wall clock), `claude.max_turns` and `claude.max_budget_usd`, `codex.auto_compact_token_limit`, and `opencode.steps`.
  `opencode.steps` must equal `steps:` in `tools/opencode-reviewer.md`, because that file is what the runner copies and
  the test compares the two; copy the file again on any machine that runs OpenCode reviews. Then run
  `node tools/test-agent-review.mjs` and say in the PR what MADE the old number wrong (a run that hit it, or a measured
  cost), so the change is not just a preference.
- **Reserve quota for something else.** Add an entry under `reserve`, for example
  `"claude": { "weekly": 30, "note": "Krish's own work", "until": "2026-11-20" }`. The provider counts as out of usage
  once its % left falls to that number, and the reservation lifts by itself after the `until` day. Delete the entry, or
  the whole block, to reserve nothing.
- **Stop using a model.** Remove it from the role lists and from `allowed`, and drop its `caps.per_review_pct` and its
  `cost`, unless you are keeping both as the measured record of why it is out. Sensitive work must keep at least the two
  strong models in `approach` and `pr_sensitive`.

## Reviewer agents on the reviewer machines

- **Who can call them.** Only GitHub accounts in the allowlist (the repo variable `AGENT_ALLOWLIST`, today just `Flame119052`). A tag from anyone else is ignored. Anyone can still open issues and PRs.
- **Where runners may live.** Only on machines that hold no Tess keys: the Instabox box `tess-reviewer` (the default), and the VPS `paperclip-vps` and `omarchy` (backups). Instabox is a third-party host, so it gets no vault and holds no Tess keys: only the reviewer's Claude login token, its GitHub runner credentials and, during a job, that job's `GITHUB_TOKEN` (D-65). Krish's Mac keeps the signing and rescue keys, and a reviewer reading an outside diff could be tricked into printing files it can read. A Mac runner is allowed only under a separate macOS user that can't read Krish's home folder. As a second guard, the reviewer refuses to post any text that looks like a key or token.
- **How the job reaches a machine.** Each runner machine runs a GitHub self-hosted runner labelled `tess-agent`, and the job is pinned by label: the Instabox runner is also `tess-primary`, the two backups are `tess-backup`. A `gate` step wakes the paused Instabox box through its public `/ready` page and waits up to 2 minutes for it to answer `tess-ready` (which it only does when its runner is active and idle); if it doesn't, the job is given the `tess-backup` label and GitHub gives it to whichever backup runner is online and idle. If the box pauses (or another review takes it) between answering ready and picking the job up, cancel the run and tag again so the next check routes to a backup. Each job checks out a fresh copy of the repo, so the machines need no extra syncing.
- **Picking the model.** `.github/agents.json` lists the reviewer models per role, default first. Each runner takes the first one that has a local CLI, enough usage (both windows and pace), no unexpired reservation, and a working `bubblewrap` sandbox, and names everything it skipped in the comment. Usage comes from the local hub; a provider with no numbers is treated as usable.
- **Safety, because the repo is public:**
  - The workflow is triggered only by `issue_comment`, which always runs the workflow file from `main`, never from a PR.
  - The first job runs on GitHub's own machine. It checks the commenter against the allowlist and checks that CI passed on the PR's exact commit. Only then does a job reach a self-hosted runner.
  - The reviewer reads the diff and the files. It never runs, builds or installs anything from the PR.
  - Fork PRs need approval before any workflow runs.
  - The reviewer's own comments carry a marker and never trigger another review.

## Where work happens: branches, worktrees and machines

These rules come from mistakes made while setting this up: agents started from the wrong branch, `git pull` failed, and copies of one PR were left on several machines.

**GitHub is the one source of truth.**
- `main` is dev.
- `beta` and `stable` are written only by the release workflow (`declare`, `promote`). Nobody pushes them by hand.
- Anything that isn't pushed doesn't exist for the next agent.

**The checkouts on Krish's Mac:**

| Checkout | What it's for | Rule |
| --- | --- | --- |
| `/Volumes/DellSSD/Spotify Wrapper` | T3 Code's project root. Every T3 thread and worktree starts here. | Always on `main`, always clean. Nobody edits in it. |
| `~/Developer/tess-music` | Krish's own commands: `rescue.mjs` (the rescue key is only on this Mac), `reports.mjs`, hot-reloading the theme. | Always on `main`. `.build/channel` inside it is a tool-managed copy of `beta`; leave it alone. |
| `~/.t3/worktrees/Spotify Wrapper/*` | Worktrees T3 makes for agents. | T3 removes them. Remove one by hand only if it is clean and pushed. |
| `~/Developer/tess-wt/<branch>` | Worktrees made by hand. | Removed when the PR merges or closes. |

**One piece of work is one issue, one branch, one worktree, one agent.**
- **Name branches after the work,** e.g. `updates-wake-hardening` or `support-bot`.
- **Start from `origin/main`.** Run `git fetch` first. The only exception is work that must build on an open PR: start from that PR's branch, and say so in your PR.
- **Never start from whatever the project root happens to have checked out.** This is how a branch ended up carrying another PR's commits.
- **Updating:** `git fetch origin` then `git merge --ff-only origin/main`. A plain `git pull` fails here with "Cannot fast-forward to multiple branches".
- **A PR that conflicts with `main`:** rebase it, rerun its tests, and push with `--force-with-lease`. Never use a bare `--force`.
- **An open PR belongs to the agent that opened it** for as long as that agent's thread is alive. For example, the support-bot agent owns `support-bot` (#85).
  - Everyone else, including the reviewer and other agents, comments on the PR and doesn't push to its branch.
  - If the owner's thread is gone, you may add commits. Leave a PR comment saying what you added and who you are.
- **Reviewers only comment.** A reviewer agent never pushes, approves, merges or edits a branch.
- **Only Krish merges,** unless he names a PR and says to merge it. Merges use a merge commit, so each PR's commits stay visible. Never squash a PR another agent is still reading.
- **Stacked work:** if your PR needs another open PR, start from that PR's branch, say "stacked on #N" in your PR, and rebase onto `main` once #N merges.
- **Merge order matters when PRs touch the same files.** The later PR rebases after the earlier one merges. It never copies the earlier PR's commits, with one exception: a fix that unblocks CI. If you copy that, say so in a comment.
- **Leftovers:** a local branch that is pushed or merged gets deleted. One with unpushed commits stays until Krish says otherwise.
- **No plans, notes or scratch files in the repo.** Keep them in your session's scratch folder. A merged PR and its issue are the record.

**Which machine does what:**

| Machine | Does | Never |
| --- | --- | --- |
| Krish's Mac | Holds the signing and rescue keys. Runs the real Spotify on `dev`. Krish's own commands. The T3 threads. | Hosts a GitHub runner. Holds secrets in the repo or in an external drive's `.env`. |
| `paperclip-vps` (reach with `ssh vps`), `omarchy` | The backup reviewer runners (`tess-agent`, `tess-backup`), used whenever Instabox isn't ready. Each job gets a fresh checkout, so nothing on them needs syncing. | Holds a Tess key. Runs the runner as root. |
| GitHub's macOS machines | CI (`check.yml`) and every build and signature (`release.yml`). They are the only place the signing secrets are used. | Runs code from a fork PR without Krish's approval. |
| Instabox | The default reviewer runner (`tess-agent`, `tess-primary`), made with `--no-vault` so it holds no Tess keys: only the reviewer's Claude login token, its runner credentials, and a job's `GITHUB_TOKEN` while one runs. A review wakes it through its public `/ready` page and waits up to 2 minutes before falling back to a backup. | Holds a Tess key. Builds Tess, which needs macOS. Runs the runner as root. |

**`paperclip-vps` runs Paperclip first. Tess work there must never slow it down or touch it.**
- **The reviewer runner** runs as `tess-runner`, with no admin rights and a hard cap: 1 CPU core and 1.5 GB of memory, at the lowest priority for CPU and disk. If it runs out, the review fails; Paperclip doesn't. `omarchy` has the same setup with a 2 GB cap.
- **No Tess agent edits, restarts or reads Paperclip.** That covers `/srv/paperclip`, its PostgreSQL database, its services, and the Tincan relay. Nothing for Tess is installed system-wide there. Everything lives in `~tess-runner`. The runner's network drop-in is the guard: a review cannot open a connection to any local address, so a diff cannot talk a model into reaching Paperclip even if it gets a shell command run.
- **No builds or tests run on the VPS,** only reviews, which read code. Heavy work goes to GitHub's machines or `omarchy`.
- **Tess agents don't run on the VPS through T3 Code.** T3 runs as root there, so any agent it starts has root power next to Paperclip. Claude refuses full access as root, and we leave that check on. Tess agent work goes to Krish's Mac or `omarchy`. Moving T3 on the VPS to a normal account is a separate decision for Krish.

## How Macs get updates

- **Updater.** It runs every 30 minutes, and also whenever Spotify's files change.
- **Wake check.** Every 5 minutes a tiny check reads public files, at no cost to the inbox. It reads the channel's version, which changes when a release is published (that is the webhook-style trigger). It also reads the rescue order number, unless the user turned the rescue line off. A failure to read one does not skip the other on that attempt. If either is newer, it starts the updater or the rescue line straight away.
- **Media playing.** Anything that has to restart Spotify waits until no music is playing. Downloads go ahead anyway.
- **After every update** the doctor checks Tess and Spotify. If the new version broke something, Tess goes back to the last good version and stops retrying that one.
- **The rescue line** on a current install can only do its five actions (D-62). Scripts installed before 13 Nov 2026 can still run a signed script; repair says so. The user can turn it off (`tess rescue off`, #53).

## CI

- `check.yml` runs on GitHub's macOS machines, which are free for public repos. It's the deterministic gate: the safety check, theme build, patcher build and tests.
- An Instabox cloud machine runs Linux, so it can't build Tess Mini or run the macOS checks. It is the default reviewer runner for agents, and nothing else.
