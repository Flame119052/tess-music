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
3. **Approach review.** For changes that need one (see tiers below), the agent tags the reviewer in that comment (`@tess-review approach`). A reviewer agent runs on one of Krish's machines, reads the issue and the plan, and replies **approve** or **changes needed**.
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

**How to choose.** Before tagging:
1. Check usage with the usage tool (`provider_usage` in T3; it reads the same hub the runners read). Skip any provider near its limit.
2. Pick using this table.

| The work | Stage | Reviewer | Effort |
| --- | --- | --- | --- |
| Docs only | PR | none (CI is the review) | — |
| Small theme/tool change, one file, clear check | PR | lighter: `codex gpt-6.1-terra` or `claude claude-sonnet-5-5` | low–medium |
| Bigger theme work, several files, new behaviour | approach | strong | medium |
|  | PR | lighter | medium–high |
| Sensitive (installer, updater, rescue, inbox, patcher, release, signing) | approach and PR | strong only: `claude claude-opus-5-5` or `codex gpt-6.1-sol` | high |
| Security fixes, or anything that can stop Spotify working | approach and PR | strong, and a *different* provider from the one that wrote it | high–max |

**Rules.**
- Don't use the strongest model at both stages unless the work is sensitive.
- The reviewer should come from a different provider than the agent that wrote the change, so it doesn't share the same blind spots.
- Only models listed under `allowed` in `.github/agents.json` are accepted. Sensitive work must use one listed under `strong`. If the request breaks a rule, or that provider has no usage left, the runner falls back to the defaults for that role and says so in its comment.
- Leaving the choice out is fine: the defaults are the first model with usage left in that role's list.
- Only allowlisted accounts can tag. Krish can use the same syntax himself.

## Reviewer agents on Krish's machines

- **Who can call them.** Only GitHub accounts in the allowlist (the repo variable `AGENT_ALLOWLIST`, today just `Flame119052`). A tag from anyone else is ignored. Anyone can still open issues and PRs.
- **Where runners may live.** Only on machines that hold no Tess keys: `omarchy` and `paperclip-vps`. Krish's Mac keeps the signing and rescue keys, and a reviewer reading an outside diff could be tricked into printing files it can read. A Mac runner is allowed only under a separate macOS user that can't read Krish's home folder. As a second guard, the reviewer refuses to post any text that looks like a key or token.
- **How the job reaches a machine.** Each runner machine runs a GitHub self-hosted runner labelled `tess-agent` (see the line above for which machines). GitHub gives the job to whichever runner is online and idle. Each job checks out a fresh copy of the repo, so the machines need no extra syncing.
- **Picking the model.** `.github/agents.json` lists the reviewer models per role, strongest first. Each runner picks the first one whose provider has usage left, using the local usage hub when it is there, and otherwise falls back down the list.
- **Safety, because the repo is public:**
  - The workflow is triggered only by `issue_comment`, which always runs the workflow file from `main`, never from a PR.
  - The first job runs on GitHub's own machine. It checks the commenter against the allowlist and checks that CI passed on the PR's exact commit. Only then does a job reach a self-hosted runner.
  - The reviewer reads the diff and the files. It never runs, builds or installs anything from the PR.
  - Fork PRs need approval before any workflow runs.
  - The reviewer's own comments carry a marker and never trigger another review.

## How Macs get updates

- **Updater.** It runs every 30 minutes, and also whenever Spotify's files change.
- **Wake check.** Every 5 minutes a tiny check reads public files, at no cost to the inbox. It reads the channel's version, which changes when a release is published (that is the webhook-style trigger). It also reads the rescue order number, unless the user turned the rescue line off. A failure to read one does not skip the other on that attempt. If either is newer, it starts the updater or the rescue line straight away.
- **Media playing.** Anything that has to restart Spotify waits until no music is playing. Downloads go ahead anyway.
- **After every update** the doctor checks Tess and Spotify. If the new version broke something, Tess goes back to the last good version and stops retrying that one.
- **The rescue line** can only do its five actions (D-62). The user is told about it and can turn it off (`tess rescue off`, #53).

## CI

- `check.yml` runs on GitHub's macOS machines, which are free for public repos. It's the deterministic gate: the safety check, theme build, patcher build and tests.
- An Instabox cloud machine runs Linux, so it can't build Tess Mini or run the macOS checks. It can only be an extra Linux runner for agents.
