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
3. **Approach review.** For changes that need one (see tiers below), the agent tags the reviewer in that comment (`@tess-review approach`). By default a reviewer agent runs on a fresh GitHub-hosted Linux machine (an ordinary GitHub Actions job, free for this public repo); `machine=mac` or `machine=omarchy` runs it as a T3 thread on that machine instead. It reads the issue and the plan, and replies **approve** or **changes needed**.
4. **PR.** The change lands as a pull request into `main`, with `(#issue)` in its title.
5. **Checks.** CI (`check.yml`: safety gate, builds, tests) must pass. No AI reviewer runs on a PR whose checks haven't passed.
6. **PR review.** The agent tags `@tess-review pr`, naming the reviewer and the author as below. The reviewer reads the diff against the approved plan and the issue's check, and posts a review.
7. **Merge.** Krish merges. That builds dev, and Krish's Mac gets it.
8. **Release.** When Krish declares a release, everything merged since the last beta becomes the next beta. When it's clean, he promotes it to stable.

## How much review a change needs (tiers)

The tier comes from the paths the PR touches. `tools/agent-review.mjs` works it out, so nobody has to judge.

| Tier | Touches | Approach review | PR review | Krish |
| --- | --- | --- | --- | --- |
| **docs** | only `docs/`, `*.md`, issue templates | no | no (CI only) | merges |
| **normal** | theme, Tess Mini, tools | no | yes, lighter model | merges |
| **sensitive** | `installer/`, `inbox/`, `patcher/`, `support/`, `.github/`, `tools/release.mjs`, `tools/promote.mjs`, `tools/rescue.mjs`, `tools/check-safety.sh`, signing, rescue | yes, strong model | yes, strong model | reviews and merges |

**Which model reviews what:**
- The **strong model** reviews the approach, because a wrong design is the costliest mistake.
- A **lighter model** reviews normal PRs against the approved plan.
- Sensitive work gets the strong model at both steps.

So no change runs the strongest model twice unless it can break someone's Mac.

## Choosing a reviewer (the agent that tags does this)

**The agent decides; the job only checks and runs.** The agent that writes the approach comment, or that opens a pull
request, looks at usage, weighs it, and names the reviewer in the tag. The hosted job installs that one CLI, checks the
choice against the hard rules, and refuses loudly rather than quietly using a different model. There is no default and
no fallback: a review runs the model that was asked for, or it does not run.

```
@tess-review approach provider=opencode model=zai-coding-plan/glm-5.3 effort=high author=codex
@tess-review pr provider=codex model=gpt-6.1-terra effort=medium author=opencode
```

`author=` is the provider that wrote the change (`claude`, `codex`, `opencode`, `antigravity`, or `none` when a person
wrote it). **The tag must name it**, because the tag is the only trusted statement of authorship: a pull request's own
`Made by` line is written by the same agent whose work is being reviewed, so it can only ever cause a refusal (when it
disagrees with the tag), never grant a review.

The line after the tag says why, in one sentence, so a reader can see the reasoning without opening a dashboard:

```
@tess-review pr provider=opencode model=zai-coding-plan/glm-5.3 effort=high author=codex
GLM-5.3 on the Z.ai plan: 71% of its week left, resets Tuesday, and the change was written by Codex.
```

The tag also says **where** the review runs, and may add **what to look at**:

```
@tess-review pr provider=codex model=gpt-6.1-sol effort=high author=opencode
@tess-review pr provider=opencode model=opencode-go/deepseek-v4.1-flash author=codex machine=mac prompt="focus on the installer fallback"
```

| Option | What it means |
| --- | --- |
| `provider=`, `model=`, `effort=` | the reviewer that runs. The job runs that model or refuses; it never picks a different one. |
| `author=` | the provider that wrote the change (`claude`, `codex`, `opencode`, `antigravity`, or `none` for a person). It is the allowlisted account's attestation, and the reviewer must come from a different provider. |
| `machine=` | where the review runs: `github` (the default), `mac`, `omarchy`, or `vps` (refused, see below). |
| `prompt="…"` | the owner's focus for this review, 400 characters at most. It adds attention; it is never permission to skip a rule, and a longer one is refused rather than cut. |

**The rotation (D-107).** Reviews rotate through Claude Opus 5.5, GPT Sol and Gemini 4 Neon, in that order, each on
the provider with the most usage left and the soonest reset. A review never uses the model that wrote the change: that
round skips to the next model. Gemini 4 Neon runs in this job on `machine=github` with full access inside the sandbox (D-109).

### Where a review runs: `machine=`

- **`machine=github`**, or no `machine=` at all: today's path. A fresh GitHub-hosted Linux VM per review, bubblewrap
  around the reviewer, and only that reviewer's provider login on it (below).
- **`machine=mac` / `machine=omarchy`**: the review opens as a **T3 thread on that machine**, so Krish can watch or
  steer it while it runs. GitHub's job reads the tag, checks it, and stops after posting `Review queued for mac`; a small
  watcher on the machine polls for tags that name it, checks them with the same rules, and starts the thread with
  `t3 thread start`. The thread answers with the review as its last message and **the watcher posts it**, with the
  marker, the commit it read and a verdict, after confirming the pull request still points at that commit. Setup, the
  timer and its one-time check are in [`tools/review-watch/README.md`](../tools/review-watch/README.md); installing it is
  Krish's step, not a merge.
- **`machine=vps`** is refused, in fixed words: T3 on `paperclip-vps` runs as root beside Paperclip, so Tess agents do
  not run there through T3 (see "Which machine does what").
- **`provider=antigravity` on `mac` or `omarchy`** is refused in one line: Krish chose the GitHub path. Gemini 4 Neon
  runs in the GitHub job (D-107, D-109).

What the machine path enforces, before any pull-request text reaches a thread (D-77, D-78):

- **The thread's runtime mode.** The watcher opens the thread with one fixed line that contains nothing from the pull
  request, reads the mode T3 reports back, and only sends the diff, the issue and the focus when it is
  `approval-required` — T3's strictest setting, which is a real read-only, no-network sandbox for Codex and a per-tool
  approval for Claude. A project left at any wider mode is refused with a comment naming the setting, never reviewed. The
  project's default runtime mode is set to `approval-required` once, when the watcher is installed.
- **The copy the thread reads.** Not the pull request's checkout: the reviewed commit is unpacked into the same stripped
  copy the GitHub job makes — agent settings, instruction files at any depth and every link removed — before the thread
  exists, so an `AGENTS.md` in the change cannot brief the reviewer. The reviewed commit itself is fetched into a scratch
  repository that is not the project, and deleted before the thread starts, so the copy's object store has never held it
  and `git show <sha>:AGENTS.md` fails there. The copy is deleted with the review, branch and objects too. A review also
  waits for T3 to finish checking that copy out, because the changed files are read from it.
- **When a review is finished.** T3's own end of the run (`idle`, `completed`, or an ended status), checked against the
  run `t3 thread send` started — not the sidebar's `settled`, which is days of quiet. The mode is read again on the way
  out, and the answer is posted only if its shape is a review and it holds no key.
- **Who posts.** The thread has no way to write: it is never told how to comment or merge, `gh` is not part of its job,
  and its answer is read, checked for the marker, the commit and one verdict line, and posted by the watcher. A hijacked
  thread can produce a bad review; it cannot comment, push, merge or release in Krish's name.
- **The same rules as GitHub.** The allowlist, the fork refusal, CI green on the exact head, the tier, the plans-only
  list, the author rule, usage and reserve are decided by the same `tools/agent-review.mjs`, so a tag cannot be refused
  on one path and allowed on the other. A refusal on a machine is posted as a comment too, in the same fixed words or
  the same rule comment.
- **The tag as it reads now.** Every tag is fetched again by id right before it runs: one deleted after it was queued
  does nothing, and one edited after it was queued is judged on its new words. A launch is recorded before and after
  `t3 thread start` and keyed to the comment, so a tick that dies half-way adopts its thread instead of making a second.

Two things the machine path still is not. It is not a second sandbox around the owner's account: a T3 thread runs as
Krish's user, the read-only sandbox has no network and no writes, and files outside the worktree stay readable — which is
why `machine=github` stays the default and the Mac is named only when he wants to watch. And `effort=` cannot be passed
to a thread, so a tag that names one is refused on those machines rather than run at an effort nobody chose (leave it
out, or use `machine=github`). `t3 thread start` takes no token limit either, so a machine review has none and its
comment says `Cap: none on this path`; the bound is the same `timeout_s` the GitHub job runs a reviewer under.

**Plans only.** Every model on the list runs on one of Krish's subscriptions or a free tier he already uses — the Claude
plan, the ChatGPT plan, the OpenCode Go plan, the Z.ai coding plan, OpenCode Zen free, Nvidia NIM, Sarvam, or the
Google plan. No per-token API key is used, ever: a review must never bill by the token. `GEMINI_API_KEY` and
Application Default Credentials are not a way in. Krish confirmed Sarvam is a free/subscription plan (D-112). OpenCode
Zen's free models may keep prompts for training; that is accepted because this repository and its pull request diffs
are public.

**What the agent checks before tagging:**
1. **Usage on its own machine.** `provider_usage` and `provider_pick` in the T3 usage tool, or `~/.local/bin/tess-usage`
   on Krish's machines. They show the **session (5-hour)** and **weekly** windows, the share left in each, the pace, and
   when each renews. Those numbers are the same ones the job later reads from the quota-only snapshots.
2. **The plan the model bills.** OpenCode splits into separate allowances, and the model id names the connector:
   `opencode-go/*` (`OPENCODE_API_KEY`), `zai-coding-plan/*` (`ZHIPU_API_KEY`), `nvidia/*` (`NVIDIA_API_KEY`),
   `sarvam/*` (`SARVAM_API_KEY`), and `opencode/*` (Zen free, no key — only the four named free models). One can be
   empty while another is full, so name the connector in the model, as the examples do.
3. **The weight.** `caps.per_review_pct` in [`agents.json`](../.github/agents.json) is the share of a 5-hour window one
   review of that model takes: 0.1 for DeepSeek V4.1 Flash, 0.2 for GLM-5.3-Flash, 1 for GLM-5.3 on Z.ai, 3 for
   `gpt-6.1-terra`, 7 for `gpt-6.1-sol`, and a cautious 10 for Claude, which reports no numbers of its own. The
   Zen-free, Nvidia, Sarvam, and extra Go / Z.ai models use a cautious share in that table until a window is measured,
   and they are not in `strong`.
4. **Pace, not just what is left.** On the morning of 15 Nov, Claude had 59% of its session left but only 16% of its
   week, with two days to run; Codex had 93% of its session and 89% of its week. Only one was safe to spend that morning,
   and the session number alone would have picked the wrong one. Skip a provider on pace to run out before its reset.
5. **Time to reset.** A window that resets in an hour is cheaper to spend than one that resets in three days. When two
   choices are otherwise equal, take the one whose window is about to refresh.
6. **Krish's reserves.** `reserve` in `agents.json` holds quota back per provider, with a plain `note` and an optional
   `until` date. A provider inside its reserve is not a candidate until the date passes.
7. **The strength the tier needs.** A sensitive change needs a model in `strong`: GLM-5.3 on the Z.ai plan,
   `gpt-6.1-sol` on the ChatGPT plan, or Claude Opus. Everything else may use a cheaper model.
8. **A different provider from the author.** DeepSeek writes most of the fixes here. A reviewer from the same provider
   shares the author's blind spots, so work out which provider wrote it and say so in the tag with `author=`. Then pick a
   reviewer from another one. The job enforces this from `author=`, not from the pull request text.

**What the job checks, and what it refuses.** A tag is refused, with a marker comment on the pull request, when:
- it names no `provider=` and `model=` (the comment says which shape to use);
- the model is not in `allowed` — which is the plans-only list, so an API-key model cannot be reached;
- the job does not install that CLI;
- the change is sensitive and the model is not in `strong`;
- it names no `author=`, names one that is not a known provider, or names the reviewer's own provider;
- the pull request's `Made by` line (in any shape: `Made by: …` or a `## Made by` heading) names a provider that
  disagrees with `author=`;
- a usage snapshot shows that window used up, fewer than three reviews left in its 5-hour window, or inside a `reserve` (pace is the tagging agent's call, not a refusal);
- the OpenCode model needs a connector key that is missing (`OPENCODE_API_KEY`, `ZHIPU_API_KEY`, `NVIDIA_API_KEY`, or
  `SARVAM_API_KEY`), or the model prefix is not one of those connectors; `opencode/*` free models need none;
- the Codex plan login is missing or inside its last 12 hours (a scheduled job renews it; see below);
- the Antigravity plan login is missing, or it is not the Google-plan file;
- `provider=antigravity` is tagged for `mac` or `omarchy` (Krish chose the GitHub path);
- the tag names a machine that is not `github`, `mac` or `omarchy` — including `vps`, which is refused with its reason;
- a `prompt=` is longer than 400 characters, empty, or the tag has an option a tag does not take (`tier=`, `machine=pc`),
  or a quote that is never closed;
- a tag for `mac` or `omarchy` names an `effort=`, which `t3 thread start` cannot carry — the same tag without it runs at
  the model's own default, and `machine=github` passes the effort to the reviewer's CLI.

The refusal names the reason and, for usage, the exact reset time in UTC plus how far away it is, so the next tag can be
a good one. **Nothing is substituted.** A review that does not run is better than a review by a model nobody chose, so
the tagging agent re-tags after reading the refusal. A reviewer that fails mid-run (a cap, a usage limit, a timeout) is
reported the same way, in a comment, and the job stops there. So is a failure nobody planned for — a CLI that crashes, a
proxy that will not start, a GitHub read that fails — because a job that stops without a word leaves the tagging agent
waiting: the script posts one marker comment naming what broke (never a secret) and exits non-zero, and the review job
has a last step that does the same for failures outside the script, such as installing the CLI.

**One file holds the rules.** [`.github/agents.json`](../.github/agents.json) is the only place with model names, the
plans-only list, what one review costs, the hard caps, and any quota kept back. Its role lists (`approach`, `pr_normal`,
`pr_sensitive`) are **pools, not a priority**: they say which models a role may use, and the order means nothing. This
page explains how to read it and when to change it; it does not repeat the values.

| Field | What it decides |
| --- | --- |
| `approach`, `pr_normal`, `pr_sensitive` | the models a role may use; the order says nothing |
| `allowed` | every model a tag may name; the plans-only list |
| `strong` | the models sensitive work may use |
| `efforts` | the effort words a tag may ask for |
| `cost` | what one review costs: `light` (pennies), `medium` (worth a thought), `heavy` (a visible bite out of a weekly pool) |
| `caps` | the hard limit on one review: wall clock, turns, dollars, steps, and the share of a 5-hour window each model is assumed to use |
| `reserve` | quota kept back per provider, as the % left per window kind, with a plain `note` and an optional `until` date |
| `notes` | dated, temporary facts, such as a model with its own pool; not rules |

Which model is good at what comes from the providers' own docs, review benchmarks, and what developers said on X,
Hacker News and Reddit in Sep–Nov 2026. Sources are in [`docs/research/reviewer-models-2026-11.md`](research/reviewer-models-2026-11.md).

**Left out on purpose:**
- **Grok 4.7:** reviews well but uses by far the most tokens per review.
- **Zed:** hosts other agents and has no command-line reviewer of its own.
- **Devin:** has no read-only mode when run without a person.
- **ZCode:** starts with every permission on when run without a person.
- **Cline:** can't block shell commands without a hook.
- **Copilot:** possible later.
- **Cursor:** its own models come from a weekly pool, but a Claude or GPT model inside Cursor bills prepaid credit at
  API list price from the first request. Leaving it out keeps the plans-only rule true without a footnote.
**Antigravity is in the GitHub job (D-107, D-109).** `gemini-4-neon` runs on the Google plan. On a Linux machine with no
D-Bus session (a GitHub VM, and an SSH session on the Dell) agy 1.5.12 keeps that login in one file,
`~/.gemini/antigravity-cli/antigravity-oauth-token`, instead of the OS keyring. `node tools/agy-ci-login.mjs` on the
Dell produces the file. The job redeems the refresh token before bubblewrap, mounts only a short-lived access-token
file, and deletes that file when the run ends. The refresh token is never written to disk and never enters the
sandbox. The CLI runs with `--dangerously-skip-permissions` so a tool call does not wait for a person, and does not
pass `--mode plan`. A tag for `mac` or `omarchy` is refused: Krish chose the GitHub path.

Every reviewer runs inside a real boundary, whichever provider it is. Each CLI starts inside **bubblewrap** (`bwrap`,
unprivileged, with `--unshare-all --share-net --die-with-parent`) in an empty filesystem where only these are bound,
read-only: the review copy, the CLI and its runtime (`/usr`, `/lib*`, `/etc/ssl`, `/etc/resolv.conf`), and that
provider's own config and sign-in files, mounted **inside** the throwaway `HOME` at the paths its CLI looks in
(`~/.codex` for Codex, `~/.config/opencode` and `~/.local/share/opencode/auth.json` for OpenCode,
and for Antigravity a temp file mounted at `~/.gemini/antigravity-cli/antigravity-oauth-token`) — a mount at the
job's real home is invisible once `HOME` changes. Antigravity's mounted file is an access token minted for this run.
The refresh token stays in the job process, in memory, and is not in that file. It gets only its own key in the
environment, and `GH_TOKEN` is removed before the reviewer starts. A machine without `bubblewrap`, or with user
namespaces switched off, refuses that provider with a skip reason and tries the next one: no reviewer is run bare.
`--share-net` is deliberate, because the API call needs it, and the network is the review VM's own: that machine is
created for this one review and holds this review's login and a `GITHUB_TOKEN` that can comment on this repo, so a
command a diff talks a model into running can reach the internet. For Antigravity that includes the access token in
the mounted file. The token lasts about an hour. A review that quotes it is refused, which stops the public comment,
not the network send.

On top of that, each CLI is told to stay read-only:
- Claude: `--restricted --safe-mode` with only the Read, Grep and Glob tools.
- Codex: `--sandbox read-only --ephemeral --ignore-rules --skip-git-repo-check`, with project document loading off
  (`project_doc_max_bytes=0`). That flag limits the shell commands the model may ask for; the boundary above is what
  stops it reading the job's files. The git check has to be skipped because the review copy is a `git archive`, with no
  `.git` in it.
- Cursor: `--mode ask --sandbox enabled`.
- OpenCode: the `tess-reviewer` agent (`tools/opencode-reviewer.md`), which denies everything except reading, and denies
  `external_directory` so reads stop at the review copy. The installed copy must match that file on `main` exactly, or the
  review stops instead of running under wider rules. The runner also copies `tools/opencode-config.json` to
  `~/.config/opencode/opencode.json`. That file must match byte for byte, and the folder may contain only `opencode.json`
  and `agents/tess-reviewer.md`, so a stray `opencode.jsonc` or `config.json` cannot widen the reviewer. The json holds
  `$schema` and `providers` only (Nvidia's `headerTimeout`, and Sarvam with `{env:SARVAM_API_KEY}`), never an agent, a
  permission, a plugin, or a literal key. Both files are sensitive work: a PR that changes either gets the strong
  reviewer, never "docs only".
- Antigravity (D-107): `--dangerously-skip-permissions`, so the CLI does not stop and ask. The review copy and the
  access-token file are read-only, `GH_TOKEN` is not in the environment, and only this job posts the review. Those
  mounts do not stop the reviewer from reading the access token or sending it out. The refresh token is not in the
  sandbox. `--mode plan` is not passed.

Any agent settings shipped inside a PR (`.opencode`, `.cursor`, `.claude` and the like) are removed from the review copy
first, at any depth and in any letter case, together with the PR's own `AGENTS.md` and `CLAUDE.md`: a reviewer reads a PR
as data, never as instructions. A file that is a link is removed too, because a link can point at the job's own files
(the diff already shows where a link pointed).

A review only ever reads a branch of **this** repository. The gate refuses a fork's head by asking which repository the
head lives in, not merely by checking that CI passed, so a maintainer tagging a green fork PR does not hand a fork
author's diff to a reviewer holding a provider key; a deleted or unknown head repository is refused the same way. The
review checks the same rule again before it fetches anything.

Before a review is posted it is refused if its text contains the value of any key the job holds, `GH_TOKEN` included,
or a string inside the stored Antigravity login, or the access token just minted —
as the key is, and base64'd, hex'd, percent-encoded, or split over lines, which is what a diff would ask for if it were
trying to slip a key past the check. Google access tokens (`ya29.`) and refresh tokens (`1//0`) are refused by shape
as well. A failed reviewer is different: its own output is untrusted, so the log gets one
redacted line of its stderr (never its stdout, which is the review text) instead of the whole stream.

Every posted verdict names the commit it read (`Reviewed: <sha>`), and the head is checked one last time immediately
before posting. A push during a ten-minute review therefore costs a re-tag instead of attaching an approval to a commit
nobody read.

### Every review has a hard cap

A review must never take a large share of an allowance, so each one is bounded before it starts. The numbers are in
`.github/agents.json` under `caps`; one edit changes them everywhere, and the test checks the ones each CLI accepts.

| Provider | What stops a review | Notes |
| --- | --- | --- |
| Claude | `--max-turns 12`, `--max-budget-usd` (60 cents for Opus, 30 for Sonnet), `--output-format json` | `--max-turns` is real but hidden from `--help` in 2.1.x. The dollar figure is a client-side estimate of API list prices, not the plan's own meter, so it is a guardrail beside the turn cap. The JSON result is what lets the comment say the turns, dollars and tokens a review used. |
| Codex | `-c model_reasoning_effort=…`, `-c model_auto_compact_token_limit=64000`, `-c features.rollout_budget.*`, `--json` stream monitor | `features.rollout_budget.limit_tokens=200000` (with `enforce_limit=true` and `reminder_at_remaining_tokens=[50000]`) asks Codex to budget its rollout, and the `--json` stream monitor is the hard enforcement that kills any run crossing `caps.codex.max_tokens` (200,000) immediately and refuses it with a comment. Compaction at 64k tokens keeps multi-turn context lean. |
| Cursor | the 480 s timeout, `--mode ask`, `--sandbox enabled` | Not offered today (see "Left out on purpose"). Only Cursor's own models (Composer) would be allowed, because a Claude or GPT model inside Cursor bills prepaid credit from the first request. |
| OpenCode | `steps: 12` in the `tess-reviewer` agent file | On the last step OpenCode drops the tools and asks for a summary, which is the review. The agent file must match `tools/opencode-reviewer.md` exactly, and the test keeps its number equal to `caps.opencode.steps`. |
| Antigravity | `--print-timeout` set to the same wall clock, prompt on stdin as stream-json | No separate turn cap. The prompt is not one command-line argument, because Linux caps a single argument at 128 KiB. The CLI is told to auto-approve its own tools (D-107). Bubblewrap hides the runner's files; it does not keep the access token from being read. |
| **All of them** | a 600 s wall clock (480 s for `gpt-6.1-terra` and GLM-5.3-Flash) | The process is killed at the limit, bubblewrap takes its children with it, and the posted comment says so: `codex/gpt-6.1-sol timed out after 600s`. The job then stops instead of running a different model. |

A review's wall clock and its share of a window are different things: the timeout stops a stuck or runaway run, while
`caps.per_review_pct` decides whether there is enough left to start one (three reviews kept in hand). A CLI that stops
because of one of these caps is reported in a comment and the job stops there, because a review that ran out of turns
or tokens says nothing about the change and the agent that chose the reviewer has to choose again.

**Prompt size and expected per-review cost:**
- PR reviews inline the compacted diff (omitting truly generated build outputs such as `theme/Tess/theme.js`, `theme/Tess/user.css`, `*.map`, lockfiles, and binary assets by name, while giving sensitive omitted paths such as `patcher/prebuilt/**` a `SENSITIVE` notice with bounded excerpts and forbidding approval on unseen truncated content, and capping normal file diffs at 16 KB / 64 KB total) plus the changed files (up to 16 KB per file / 64 KB total, using hunk excerpts when a modified file is larger) and tell the reviewer to read from those first rather than scanning the repo. The full snapshot remains read-only in the sandbox when an external caller or contract must be checked.
- With prompt compaction and the 200k-token Codex cap, a typical PR review uses ~25k–100k tokens (~1–4% of a 5-hour window on `gpt-6.1-sol`), and even a worst-case capped run stays at or below 200k tokens (~7% on `gpt-6.1-sol`, matching PR #76's uncompacted 779,470-token outlier being cut to a hard ceiling).
- The measured shares, as a share of a 5-hour window: `gpt-6.1-sol` 7, `gpt-6.1-terra` 3, `opencode-go/glm-5.3` 4,
  `opencode-go/glm-5.3-flash` 0.2, `opencode-go/deepseek-v4.1-flash` 0.1, and a cautious 1 for `zai-coding-plan/glm-5.3`
  and 0.2 for `zai-coding-plan/glm-5.3-flash` carried over from the OpenCode Go measurements until a Z.ai window has been
  watched. Claude reports no numbers of its own, so it keeps the cautious 10%. The models added in D-112 (Zen free,
  Nvidia NIM, Sarvam, and the extra Go and Z.ai ids) have cautious unmeasured shares in `agents.json`, use the default
  600 s timeout, and stay out of `strong`.

**Rules.**
- Don't use the strongest model at both stages unless the work is sensitive.
- The reviewer must come from a different provider than the agent that wrote the change, so it doesn't share the same blind spots. The tag states the author with `author=`, and the job refuses a tag that leaves it out, names an unknown provider, names the reviewer's own, or disagrees with the PR's `Made by` line. A tag is the only place authorship counts.
- Usage comes first: exhausted usage or reserved quota is a refusal; pace is weighed by the tagging agent, not enforced by the job, and the comment names when there is room again.
- Only models listed under `allowed` in `.github/agents.json` are accepted, and that list is plans-only. Sensitive work must use one listed under `strong`. A tag that breaks a rule is refused with a comment; nothing is substituted.
- Naming the reviewer is required. A tag without `provider=` and `model=` is refused, because the job does not choose.
- Only allowlisted accounts can tag. Krish can use the same syntax himself.

### How to update this

Everything below is one edit to `.github/agents.json`, then `node tools/test-agent-review.mjs`, then a PR. The test
checks that every allowed model has a cost weight and a plan, that every role pool names an allowed model with a valid
effort, that `strong` names allowed models, that the caps name allowed models, that the OpenCode step cap matches the
agent file, that no retired API-key secret is used anywhere, and that every note stays dated.

- **A new model came out.** Add it to `allowed` for its provider, give it a `cost` and, once measured, a
  `caps.per_review_pct`, then put it in the role pools where it may be used, or nowhere (allowed by tag only). Add it to
  `strong` only if sensitive work may use it. **Only if it bills a subscription:** a model reached with a per-token key
  does not go in this file at all.
- **A provider changed its limits.** Nothing to edit: the usage hub reads the limits by itself. The share of a 5-hour
  window one review is assumed to take is `caps.per_review_pct`, per model, in `.github/agents.json`; a model with no
  entry falls back to a cautious 10% in `tools/agent-review.mjs`, changed only with a measured cost per review to point
  at.
- **Change what one review may spend.** Edit `caps` in `.github/agents.json`: `timeout_s` and `timeout_s_by_model` (the
  wall clock), `claude.max_turns` and `claude.max_budget_usd`, `codex.auto_compact_token_limit` and `codex.max_tokens`,
  and `opencode.steps`.
  `opencode.steps` must equal `steps:` in `tools/opencode-reviewer.md`, because that file is what the runner copies and
  the test compares the two. The runner also copies `tools/opencode-config.json`; copy both files again on any machine
  that runs OpenCode reviews. Then run
  `node tools/test-agent-review.mjs` and say in the PR what MADE the old number wrong (a run that hit it, or a measured
  cost), so the change is not just a preference.
- **Reserve quota for something else.** Add an entry under `reserve`, for example
  `"claude": { "weekly": 30, "note": "Krish's own work", "until": "2026-11-20" }`. The provider counts as out of usage
  once its % left falls to that number, and the reservation lifts by itself after the `until` day. Delete the entry, or
  the whole block, to reserve nothing.
- **Stop using a model.** Remove it from the role pools and from `allowed`, and drop its `caps.per_review_pct` and its
  `cost`, unless you are keeping both as the measured record of why it is out. Sensitive work must keep at least two
  strong models across `approach` and `pr_sensitive`, so a tier is never left with one reviewer.

## Reviewer agents on GitHub's machines

- **Who can call them.** Only GitHub accounts in the allowlist (the repo variable `AGENT_ALLOWLIST`, today just `Flame119052`). A tag from anyone else is ignored. Anyone can still open issues and PRs.
- **Where they run.** A standard GitHub Actions job on `ubuntu-latest`: one fresh virtual machine per review, deleted when the job ends. GitHub-hosted Linux machines are free and unlimited for this public repository, so there is no runner to keep online, no box to wake, and no machine of Krish's in the path (D-66). Nothing of Krish's is on the VM: no signing or rescue keys, no Paperclip, no other job's secrets. A tag with `machine=mac` or `machine=omarchy` never reaches the review job: the gate reads it, the notice job posts `Review queued for mac`, and that machine's own watcher opens the review as a T3 thread (above).
- **What reads the tag first.** The `gate` job runs `tools/agent-gate.sh` from `main` and answers in one place: the caller, the machine, the pull request's own head, CI on that commit, and the tier. A refusal is a fixed code, and the `notice` job posts the fixed words for it — never a script's message, which could carry a path or a key. An account that is not allowlisted still gets nothing at all.
- **What the VM holds.** Only the chosen reviewer's plan login and a `GITHUB_TOKEN` that can comment on this repository. The tag's choice is checked first (`node tools/agent-review.mjs pick ...`), then that one provider's CLI is installed at a pinned version, and only that provider's login is given to the step. A review can never hold a second provider's login. For Claude and Codex the login stays in the review process and the sandbox gets a per-review token instead (`tools/review-proxy.mjs`, D-69, D-73); that proxy forwards only the one inference route its pinned CLI was measured to call and answers everything else with a 403, so the token is not a way to reach the rest of what the login can do. OpenCode keeps only the one connector key for the model prefix (`opencode-go/` → `OPENCODE_API_KEY`, `zai-coding-plan/` → `ZHIPU_API_KEY`, `nvidia/` → `NVIDIA_API_KEY`, `sarvam/` → `SARVAM_API_KEY`), and a Zen free `opencode/*` model gets none. The script checks the same map again and refuses an unknown prefix or a missing key. The agent file cannot read that key from inside the copy. `GH_TOKEN` is on the step so the review can be posted, and the script removes it before the reviewer process starts.
- **Which model runs.** The tag says. The pick step only checks the choice — plans-only list, the job's installed CLIs, `strong` for a sensitive change, a different provider from the author, usage and any reserve — and refuses anything that breaks a rule with a comment on the pull request. Usage comes from [#93](https://github.com/Flame119052/tess-music/issues/93)'s quota-only snapshots, one repository variable per machine (`USAGE_SNAPSHOT_MAC`, `_VPS`, `_OMARCHY`): the freshest under 30 minutes wins, and it is read beside the local hub; with none fresh, "no numbers" counts as usable, and the CLI's own refusal is reported in a comment. Those numbers are a check on the agent's choice, never a way for the job to pick for it.
- **Safety, because the repo is public:**
  - The workflow is triggered only by `issue_comment`, which always runs the workflow file from `main`, never from a PR.
  - The first job runs on GitHub's own machine. It checks the commenter against the allowlist and checks that CI passed on the PR's exact commit. Only then does the review job start.
  - Fork PRs never reach the review job, so they never get a secret. Approval is still required before any workflow runs for an outside collaborator.
  - The reviewer reads the diff and the files. It never runs, builds or installs anything from the PR.
  - The reviewer's own comments carry a marker and never trigger another review; so do the queue notice and every refusal, so none of them can start another review.
  - A machine's watcher reads only what this repository's workflow publishes anyway (comments, the pull request, its CI), checks every tag with the same rules before starting anything, and never accepts inbound connections. It holds no credential of its own: `gh` and `t3` use that machine's own sign-ins.

## Codex login refresh

GitHub Actions renews `CODEX_AUTH_JSON` on a schedule (`.github/workflows/codex-refresh.yml`, D-111). The job runs every four days, and it can also be started by hand. It exchanges the stored refresh token, checks the new access token was issued by `https://auth.openai.com` and still has at least a day of life, then writes the login back as the same secret. The token that writes secrets is `CODEX_SECRET_ROTATOR_TOKEN`: a fine-grained personal access token scoped only to Actions (read) and Secrets (read and write) on `Flame119052/tess-music`. The review workflow never receives it.

Do not run `node tools/codex-ci-login.mjs` while that schedule is on. The copy in `~/.config/tess-codex-ci` goes stale at the first cloud rotation. Its access token can still show days of life, and uploading it replaces the live secret with a dead refresh token. Run that script only after the `codex-refresh` schedule is turned off, and only when the scheduled refresh itself is broken.

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
| Krish's Mac | Holds the signing and rescue keys. Runs the real Spotify on `dev`. Krish's own commands. The T3 threads. The review watcher, when it is installed, opens a `machine=mac` tag as a T3 thread. | Hosts a GitHub runner. Holds secrets in the repo or in an external drive's `.env`. Reviews a diff nobody here trusts: that is GitHub's job. |
| GitHub's Linux machines | Every review (`agent-review.yml`): a fresh `ubuntu-latest` VM per review, holding only that review's one provider key and a comment-scoped `GITHUB_TOKEN`. | Gets a fork PR, a second provider's key, or any Tess key. |
| GitHub's macOS machines | CI (`check.yml`) and every build and signature (`release.yml`). They are the only place the signing secrets are used. | Runs code from a fork PR without Krish's approval. |
| `paperclip-vps` (reach with `ssh vps`), `omarchy` | Paperclip on the VPS; an agent scratch machine on omarchy. `omarchy` may run the review watcher (`machine=omarchy`). | Holds a Tess key. Hosts a reviewer runner. Runs the watcher on the VPS: `machine=vps` is refused. |
| Instabox | Optional Linux scratch box for an agent. | Holds a Tess key. Builds Tess, which needs macOS. Hosts a reviewer runner. |

**`paperclip-vps` runs Paperclip first. Tess work there must never slow it down or touch it.**
- **No Tess agent edits, restarts or reads Paperclip.** That covers `/srv/paperclip`, its PostgreSQL database, its services, and the Tincan relay. Nothing for Tess is installed system-wide there. Reviews no longer run there at all: they moved to GitHub's machines (D-66), which also retires the runner network filter.
- **No builds or tests run on the VPS.** Heavy work goes to GitHub's machines or `omarchy`.
- **Tess agents don't run on the VPS through T3 Code.** T3 runs as root there, so any agent it starts has root power next to Paperclip. Claude refuses full access as root, and we leave that check on. Tess agent work goes to Krish's Mac or `omarchy`. Moving T3 on the VPS to a normal account is a separate decision for Krish. A review tag that says `machine=vps` is refused for exactly this reason, in fixed words, and no watcher is installed there.

## How Macs get updates

- **Updater.** It runs every 30 minutes, and also whenever Spotify's files change.
- **Wake check.** Every 5 minutes a tiny check reads public files, at no cost to the inbox. It reads the channel's version, which changes when a release is published (that is the webhook-style trigger). It also reads the rescue order number, unless the user turned the rescue line off. A failure to read one does not skip the other on that attempt. If either is newer, it starts the updater or the rescue line straight away.
- **Media playing.** Anything that has to restart Spotify waits until no music is playing. Downloads go ahead anyway.
- **After every update** the doctor checks Tess and Spotify. If the new version broke something, Tess goes back to the last good version and stops retrying that one.
- **The rescue line** on a current install can only do its five actions (D-62). Scripts installed before 13 Nov 2026 can still run a signed script; repair says so. The user can turn it off (`tess rescue off`, #53).

## CI

- `check.yml` runs on GitHub's macOS machines, which are free for public repos. It's the deterministic gate: the safety check, theme build, patcher build and tests.
- `agent-review.yml` runs a review on a fresh GitHub-hosted Linux machine, also free for this public repo. One VM per review, deleted afterwards; it can't build Tess Mini or run the macOS checks, which is `check.yml`'s job.
