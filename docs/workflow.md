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

## Reviewer agents on Krish's machines

- **Who can call them.** Only GitHub accounts in the allowlist (the repo variable `AGENT_ALLOWLIST`, today just `Flame119052`). A tag from anyone else is ignored. Anyone can still open issues and PRs.
- **How the job reaches a machine.** Each machine runs a GitHub self-hosted runner labelled `tess-agent`: the Mac, `omarchy` and `paperclip-vps`. GitHub gives the job to whichever runner is online and idle. Each job checks out a fresh copy of the repo, so the machines need no extra syncing.
- **Picking the model.** `.github/agents.json` lists the reviewer models per role, strongest first. Each runner picks the first one whose provider has usage left, using the local usage hub when it is there, and otherwise falls back down the list.
- **Safety, because the repo is public:**
  - The workflow is triggered only by `issue_comment`, which always runs the workflow file from `main`, never from a PR.
  - The first job runs on GitHub's own machine. It checks the commenter against the allowlist and checks that CI passed on the PR's exact commit. Only then does a job reach a self-hosted runner.
  - The reviewer reads the diff and the files. It never runs, builds or installs anything from the PR.
  - Fork PRs need approval before any workflow runs.
  - The reviewer's own comments carry a marker and never trigger another review.

## How Macs get updates

- **Updater.** It runs every 30 minutes, and also whenever Spotify's files change.
- **Wake check.** Every 5 minutes a tiny check reads two small public files, at no cost to the inbox:
  - the channel's version, which changes when a release is published (that is the webhook-style trigger);
  - the rescue order number.

  If either is newer, it starts the updater or the rescue line straight away.
- **Media playing.** Anything that has to restart Spotify waits until no music is playing. Downloads go ahead anyway.
- **After every update** the doctor checks Tess and Spotify. If the new version broke something, Tess goes back to the last good version and stops retrying that one.
- **The rescue line** can only do its five actions (D-62). The user is told about it and can turn it off (`tess rescue off`, #53).

## CI

- `check.yml` runs on GitHub's macOS machines, which are free for public repos. It's the deterministic gate: the safety check, theme build, patcher build and tests.
- An Instabox cloud machine runs Linux, so it can't build Tess Mini or run the macOS checks. It can only be an extra Linux runner for agents.
