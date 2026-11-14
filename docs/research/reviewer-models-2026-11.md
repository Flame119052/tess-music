# Reviewers we can run headless, November 2026

What each AI coding CLI the owner has connected can actually do as a **read-only reviewer**: run without a person, refuse
to write, stay inside one folder, and sign in from a machine with no browser. Then a table of who should review what.

Written 14 November 2026. Every claim has a link. Where a claim is somebody's opinion, it says **opinion** and quotes
them. This is research, not a change to the review bot: `tools/agent-review.mjs` already uses four of these; the rest are
options we could add.

## The short version

- **Four CLIs do headless read-only cleanly:** Claude Code, Codex, Cursor Agent, OpenCode. Grok, Antigravity, Copilot and
  Cline work with the right flags. Devin and ZCode are awkward. Zed has no such mode.
- **The best reviewer is not the best coder.** Review rewards a model that finds a different bug from the author. Opus
  5.5 and GPT-6.1 Sol are the two strongest and they disagree usefully.
- **Two of the three strongest providers are nearly out of quota** on Krish's hub (Claude session 98%, Codex weekly
  96%). Every role below therefore has a cheap third choice.
- **Cost is not the constraint it looks like.** A full Opus 5.5 review of 12 patches cost $15.40 (measured, below).

## What "read-only reviewer" has to mean

A reviewer reads a diff written by someone else, so the diff is untrusted input. Four things must hold: it prints and
exits; it cannot write or run installs; it stays in the folder it was given; it signs in without a browser.

Folder-limiting is the one most tools get wrong. Claude Code's `--restricted` is the only flag I found built for it: it
confines file tools to the working directories and loads only managed settings
(<https://code.claude.com/docs/en/cli-reference>). Everything else relies on you denying the right tools.

## Claude Code

**Headless.** `claude -p "<prompt>"` prints the answer and exits; non-zero exit means failure
(<https://code.claude.com/docs/en/headless>).

**Read-only, and the best version of it:**

```sh
claude -p --model claude-opus-5-5 --effort high --permission-mode plan \
  --tools "Read,Grep,Glob" --restricted --safe-mode
```

- `--permission-mode plan` is documented alongside `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`
  (<https://code.claude.com/docs/en/cli-reference>).
- `--tools` decides *which tools exist*; `--allowedTools` only pre-approves them, so taking writes away needs `--tools`
  (<https://code.claude.com/docs/en/cli-reference>).
- `--restricted` removes command and code tools unless named in `--tools`, confines file tools to the working
  directories, and refuses `bypassPermissions`. It is documented for "an evaluation harness drives `claude` on a shared
  machine" — our case exactly (<https://code.claude.com/docs/en/cli-reference>).
- `--safe-mode` stops `CLAUDE.md`, skills, plugins, hooks and MCP servers loading, so a PR cannot smuggle instructions
  in through config (<https://code.claude.com/docs/en/cli-reference>).
- `--permission-prompts none` denies anything that would wait for a human, so an unattended run never hangs
  (<https://code.claude.com/docs/en/headless>).

**Sign-in without a browser.** `claude setup-token` prints a one-year OAuth token for `CLAUDE_CODE_OAUTH_TOKEN`, documented
for "CI pipelines and scripts where browser login isn't available"; `ANTHROPIC_API_KEY` also works
(<https://code.claude.com/docs/en/authentication>). `--bare` deliberately does *not* read the OAuth token, so do not
combine the two (<https://code.claude.com/docs/en/authentication>).

**Models.** `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` are the allowlisted ids here
(<https://github.com/Flame119052/tess-music/blob/main/.github/agents.json>). Fable 5.1 exists and is dearer.

**Cost.** Opus 5.5 lists at $4 in / $20 out per million tokens on OpenCode Zen (<https://opencode.ai/docs/zen>). Measured
on 12 patches with 14 planted issues: Opus 5.5 found 8/14 for $15.40, Fable 5.1 7/14 for $66.34, Sonnet 5 2/14 for
$19.15 — **opinion**, one commenter's harness (<https://news.ycombinator.com/item?id=49804160>).

**Review strength.** CodeRabbit's 80-pattern evaluation put Opus 5.5 Standard at 63.8% actionable recall and 38.6%
precision against a 61.3% / 39.3% baseline, and found Max effort did not reliably help
(<https://www.coderabbit.ai/blog/opus-5-5-model-review>). Public benchmarks: Terminal-Bench 4.0 65.15%, Vibe Code v1.1
90.29%, SWE-bench Multimodal 70.21% (<https://vals.ai/models/anthropic_claude-opus-5-5>).

**Opinion, both ways.** "It's the first one that I trust for long running (>1 hour) tasks"
(<https://news.ycombinator.com/item?id=49946567>). And the warning: "I just told Opus 5.5 'Perform a code review on the
current branch'… four of the five line numbers were wrong" (<https://news.ycombinator.com/item?id=49803892>). A bare
"review this" prompt is not enough; the prompt has to name the plan and the check.

## OpenAI Codex CLI

**Headless.** `codex exec "<prompt>"` streams progress to stderr and prints only the final message to stdout
(<https://developers.openai.com/codex/noninteractive>).

**Read-only by default.** "By default, `codex exec` runs in a read-only sandbox" — the cleanest default here
(<https://developers.openai.com/codex/noninteractive>).

```sh
codex exec --model gpt-6.1-sol -c model_reasoning_effort=high \
  --sandbox read-only --ephemeral --ignore-rules -C "$work" -
```

`--ephemeral` avoids writing session files, `--ignore-rules` skips user and project execpolicy rules, `-C` sets the
working directory (<https://developers.openai.com/codex/noninteractive>).

**Sign-in.** `CODEX_API_KEY` for one invocation, with the docs' warning not to set it at job level where repo code can
read it (<https://developers.openai.com/codex/noninteractive>). Interactive machines use `codex login --device-auth`
(<https://developers.openai.com/codex/cli/reference>).

**Models.** `gpt-6.1-sol`, `gpt-6.1-terra`
(<https://github.com/Flame119052/tess-music/blob/main/.github/agents.json>).

**Cost.** On 24 tasks, GPT-6.1 Sol held quality against GPT 6 Sol (9 wins, 10 ties, 5 losses), scored 0.965 against 0.917
on code review, and cost about half as much — roughly $3.01 per task before the saving — **opinion**, one developer's
repo (<https://www.reddit.com/r/codex/comments/1x46r64/>). DeepSWE v1.1: 75.2% high, 73.0% medium, 71.9% xhigh/max
(<https://openai.com/index/introducing-gpt-6-1-sol>).

**Opinion.** "Code review goes to GPT 6.1 Sol. Its review score averages 0.965 against 0.917"
(<https://www.reddit.com/r/codex/comments/1x46r64/>). Against: "Do not trust 6.1 Sol right now!" — quality and quota both
dropped after a reset (<https://www.reddit.com/r/codex/comments/1x8o5oj/>). Treat a fresh model drop as unproven for a
week.

## Cursor Agent CLI

**Headless.** `cursor-agent -p "<prompt>"`, with `--output-format json|stream-json`
(<https://cursor.com/docs/cli/reference/parameters>).

**Read-only.** The docs are blunt: `-p` "Has access to all tools, including write and shell"
(<https://cursor.com/docs/cli/reference/parameters>). So the read-only part is the mode, not the print flag:

```sh
cursor-agent --print --mode ask --model gpt-5.6-sol --workspace "$work" --sandbox enabled --trust "<prompt>"
```

`--mode` takes `plan` or `ask`; `--workspace` pins the folder; `--trust` is required headless or the workspace prompt
blocks the run (<https://cursor.com/docs/cli/reference/parameters>).

**Sign-in.** `CURSOR_API_KEY` or `--api-key` (<https://cursor.com/docs/cli/reference/parameters>). **Models.** `gpt-5.6-sol`
is the allowlisted id here; `agent models` lists the rest (<https://cursor.com/docs/cli/reference/parameters>).

**Cost.** Free / Plus $8 / Premium $30 / Super $100 / Ultra $200. The weekly pool covers only Cursor's own models;
Claude, GPT and Gemini "are never included and bill at API list price on top"
(<https://replicas.dev/resources/cursor-pricing>), plus a $0.25 per million token fee on extra team usage
(<https://pondero.ai/coding/guides/ai-coding-agent-pricing-guide/>).

**Review strength.** No independent code-review benchmark for `gpt-5.6-sol` surfaced. Treat it as a spare, not a default.

## Grok CLI (xAI)

**Headless.** `grok -p "<prompt>"`; `--output-format plain|json|streaming-json`
(<https://docs.x.ai/build/cli/headless-scripting>).

**Read-only.** `--sandbox <PROFILE>`, `--allow`/`--deny` permission rules and `--tools`/`--disallowed-tools` are all
documented (<https://docs.x.ai/build/cli/reference>). The dangerous flag is `--always-approve` (alias `--yolo`), which
approves every tool call — never pass it for a review (<https://docs.x.ai/build/cli/reference>).

```sh
grok -p -m grok-4.7 --effort high --cwd "$work" --sandbox read-only \
  --deny "write*" --disallowed-tools "run_command" --no-auto-update "<prompt>"
```

**Sign-in.** `XAI_API_KEY`, or `grok login --device-auth` for "headless or remote environments"
(<https://docs.x.ai/build/cli/reference>). **Models.** `grok-4.7`, chosen with `-m`
(<https://docs.x.ai/build/cli/reference>).

**Cost.** $2 in / $6 out per million tokens, 500k context (<https://vals.ai/models/grok_grok-4.7>).

**Review strength.** DeepSWE v1.1 71.0% at high, Terminal-Bench 38.0% at xhigh, CursorBench 46.3% at xhigh — a real step
down from the frontier on terminal work (<https://vals.ai/models/grok_grok-4.7>).

**Opinion.** "I think it is good at planning and reviewing. Finds decent bugs and isn't that different from sol
medium/high" (<https://www.reddit.com/r/cursor/comments/1wrktgc/>). Against: "Grok is neither fast, nor cheap. Its
expensive AF relative to its intelligence" (<https://www.reddit.com/r/cursor/comments/1woad6b/>). The recurring complaint
is token burn per review, not the answers (<https://www.reddit.com/r/cursor/comments/1wu9jj0/>).

## OpenCode (DeepSeek, GLM, Kimi, Qwen, MiniMax)

**Headless.** `opencode run "<prompt>"` submits a prompt without the interface, "designed for scripts, CI jobs"
(<https://opencode.ai/docs/cli/>).

**Read-only, two ways.** The built-in `plan` agent "Explores and plans without editing normal project files… shell
commands remain permission-controlled" (<https://opencode.ai/docs/agents/>) — so shell is *not* off. Better, the docs'
own code-review pattern is an agent that denies both:

```md
---
description: Reviews changes for correctness and regressions
mode: subagent
model: anthropic/claude-sonnet-5-5#high
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "*"
    effect: deny
---
```

The last matching rule wins, so order matters (<https://opencode.ai/docs/agents/>).

**Sign-in.** `opencode auth login`, or `OPENCODE_API_KEY` for Zen/Go (<https://opencode.ai/docs/zen>); a CI box can copy
the auth file instead.

**Cost.** Zen is pay-as-you-go at list with no markup; Go is a subscription with a per-model monthly allowance
(<https://replicas.dev/resources/opencode-go-vs-zen>). Per million tokens, in / out (<https://opencode.ai/docs/zen>):

| Model | Zen price | Note |
| --- | --- | --- |
| `deepseek-v4.1-flash` | $0.30 / $1.20, cache read $0.006 | $0.15 / $0.60 on Go off-peak |
| `glm-5.3` | $1.40 / $4.40 | `glm-5.3-flash` $0.15 / $0.50 |
| `kimi-k3` | $3.00 / $15.00 | `kimi-k2.7-code` $0.95 / $4.00 |
| `qwen3.8-max` | $2.00 / $6.00 | `qwen3.8-flash` $0.15 / $0.47 |
| `minimax-m3` | $0.30 / $1.20 | |

Go is $10/month and Go Plus $40, with 5-hour and weekly caps over a per-model dollar allowance
(<https://opencode.ai/docs/go>). DeepSeek's peak hours are 01:00–04:00 and 06:00–10:00 UTC on weekdays, when its price
doubles (<https://replicas.dev/resources/opencode-go-vs-zen>).

**Review strength.** Terminal-Bench 4.0 from Artificial Analysis, 2 November 2026: Kimi K3.1 Pro 67.2%, GLM-5.3 41.9%,
Qwen3.8 Max 38.9%, DeepSeek V4.1 Flash 33.8%, Grok 4.7 25.8% (<https://replicas.dev/resources/opencode-go-vs-zen>). On
repository editing DeepSeek V4.1 Flash 1017 leads the open-weight field at 73.2% against GLM 5.3 at 66.2%, and 92%
cheaper per session than Opus 5.5 — **opinion**, one vendor's runs
(<https://bito.ai/blog/best-open-weight-model-for-coding-kimi-k3-1-pro-glm-5-3-deepseek/>). GLM-5.3 is described by its
maker as state of the art on CyberGym vulnerability discovery (<https://z.ai/blog/glm-5.3>), which matters for security
review.

**Opinion.** For review-shaped work GLM gets the nod: "GLM scored points with me by 1 shotting features and bug fixes
with the actual root cause. Deepseek needed more handholding" (<https://www.reddit.com/r/opencode/comments/1wfqol6/>).
The caution: "the GLM model has a tendency to go into infinite loops… much less suitable for autonomous, unattended
workflows", while the same tester saw "0/25 runs" break repo rules with DeepSeek against "7/25" for GLM (same thread).

## Google Antigravity

**Headless.** `agy -p "<prompt>"`; diagnostics go to stderr so stdout stays clean
(<https://antigravity.google/docs/cli/headless>).

**Read-only.** Headless has no prompt to ask, so tools that would ask are "soft-denied" and the run continues
(<https://antigravity.google/docs/cli/headless>). Be explicit anyway:

```sh
agy -p --model gemini-4-argon-high --effort high --sandbox \
  --output-format json --print-timeout 20m "<prompt>"
```

`--sandbox` enables terminal sandbox restrictions; `--effort` takes `low|medium|high|xhigh|max`
(<https://antigravity.google/docs/cli/headless>). For a hard guarantee, list allowed actions under `permissions.allow`
in `~/.gemini/antigravity-cli/settings.json` and leave writes out. Never pass `--dangerously-skip-permissions` to a
reviewer (<https://antigravity.google/docs/cli/headless>).

**Sign-in — the catch.** "Headless mode uses your cached credentials… In a non-interactive environment with no
terminal… a run that isn't already authenticated exits with an `authentication required` error"
(<https://antigravity.google/docs/cli/headless>). There is **no documented API-key variable**, so CI needs a home
directory pre-seeded with a logged-in profile.

**Models.** Exact slugs from `agy models`: `gemini-4-carbon-high|medium|low`, `gemini-4-argon-high|medium`,
`gemini-4-hydrogen-xhigh|high|medium|low`, `gemini-pro-orchestrator-argon`, `gemini-3.8-flash-high|medium`
(<https://antigravity.google/docs/cli/headless>). Argon needs Google AI Pro or better (<https://antigravity.google/docs/models>).

**Cost and limits.** Free with a weekly refresh; Google AI Pro $19.99/month refreshes every five hours up to a weekly
limit; Ultra $99.99 (5x) or $199.99 (20x). Google publishes no request counts
(<https://antigravity.google/docs/plans>, <https://sessionwatcher.com/guides/antigravity-pricing>).

**Review strength.** Gemini 4 Argon DeepSWE 77.9% against Opus 5.5's 74.2%, but Terminal-Bench 57.4% against 66.4% and
Vibe Code 91.9% against 90.3% (<https://deepmind.google/models/model-cards/gemini-4-argon/>). A reviewer of three real
projects put it "around Opus 5.5" for planning, with "visual blind spots and concurrency edge cases without live
execution feedback" (<https://jgunnink.substack.com/p/gemini-4-argon-early-access-review>).

**Opinion.** "It even identified a critical technical vulnerability that could have caused serious damage"
(<https://www.reddit.com/r/google_antigravity/comments/1xqy3sg/>). Against: a three-task benchmark scored Argon 56.3
against Sol High 92.7 and Opus Medium 87.7, and it "burnt 66% of its WEEKLY quota"
(<https://www.reddit.com/r/GeminiAI/comments/1x89weu/>). Great on a big plan, painful on a small one.

## Cline CLI

**Headless.** Turns on with `--json`, piped stdin, or redirected stdout (<https://docs.cline.bot/cline-cli/getting-started>).

**Read-only.** `-p, --plan` starts in Plan mode; the default is act mode. Also pass `--auto-approve false`, because
auto-approval defaults on and the docs warn autonomous runs "can modify files and run commands without further prompts"
(<https://docs.cline.bot/cline-cli/getting-started>).

```sh
git diff origin/main | cline -p --auto-approve false --json -P anthropic -m claude-sonnet-5-5 "<prompt>"
```

There is **no allow/deny list for shell commands**; blocking them needs a `PreToolUse` hook
(<https://docs.cline.bot/cline-cli/getting-started>). That is a real gap for a reviewer.

**Sign-in.** `cline auth -p <provider> -k <key> -m <model>` works non-interactively, or set `CLINE_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY`; with no provider it defaults to Cline's hosted service
(<https://github.com/cline/cline/blob/main/apps/cli/README.md>). **Models.** Any provider's; default `anthropic/claude-sonnet-5.5`.

**Cost.** The CLI is free; you pay the provider, or a Cline account (<https://www.ayautomate.com/blog/best-ai-coding-assistants>).
**Review strength.** No independent benchmark — it is a wrapper, so quality is the model's.

## GitHub Copilot CLI

**Headless.** `copilot -p "<prompt>"` or pipe a prompt in; `-s` gives clean text
(<https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically>).

**Read-only.** Copilot grants nothing by default — you list what it may use with `--allow-tool`, and the docs say to
"always give minimal permissions". A run that grants only `shell(git:*)` cannot write:

```sh
copilot -p "<prompt>" -s --no-ask-user --allow-tool='shell(git:*)' --model <id>
```

`--no-ask-user` matters because nobody can answer a clarifying question. There is also a built-in `/review` agent for
"the changes on this branch compared to main"
(<https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically>).

**Sign-in.** `COPILOT_GITHUB_TOKEN` is the documented CI route
(<https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically>).

**Cost.** GitHub AI Credits at $0.01 each: Pro $10/month with 1,500, Pro+ $39 with 7,000, Max $100 with 20,000; the CLI
and code review both spend them (<https://github.com/features/copilot/plans>,
<https://datalatte.pro/blog/github-copilot-pricing-plans-and-limits-2026>). Free, Pro and Pro+ interactions may be used
for training unless you opt out (<https://agentsthatwork.ai/compare/coding-agents>) — a reason not to review private work
there. **Review strength.** No independent benchmark; Copilot routes other vendors' models, so pick the model knowingly.

## Devin CLI (Cognition)

**Headless.** `devin -p "<prompt>"` prints and exits; `--prompt-file` loads a long prompt
(<https://docs.devin.ai/cli/reference/commands>).

**Read-only — awkward.** `--permission-mode` accepts `normal`, `accept-edits`, `smart`, `dangerous`, `autonomous`; there
is **no read-only value**. Plan mode is a *profile* reached by `/plan` inside a session, and `devin acp` advertises
`/plan` over the protocol. That profile has "read-only tools (grep, glob, read, todo, ask_user_question,
exit_plan_mode)" (<https://docs.devin.ai/cli/reference/commands>). So headless print works, but headless read-only needs
the ACP path or trust in `--sandbox` plus the prompt. Also, `--print` "cannot show the workspace trust prompt, so it
fails in an untrusted directory" — pass `--respect-workspace-trust false` in scripts
(<https://docs.devin.ai/cli/reference/commands>).

**Sign-in.** `devin auth login`, with `--force-manual-token-flow` for remote/SSH; the ACP server reads `WINDSURF_API_KEY`
(<https://docs.devin.ai/cli/reference/commands>). **Models.** `devin models list`; fuzzy names like `--model opus`, plus
`SWE-1.6 Fast` via `/fast` (<https://docs.devin.ai/cli/reference/commands>).

**Cost.** Free / Pro $20 / Max $200; Teams $80/month plus $40 per full seat, billed in ACUs
(<https://agentsthatwork.ai/compare/coding-agents>). **Review strength.** No public code-review benchmark.

## Z.ai ZCode

**Headless.** `zcode --prompt "..." --cwd <path> --mode plan --json`; there is no `--print`
(<https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/02-cli-reference.md>).

**Read-only — must be stated.** `--mode plan|build|edit|yolo|guarded`, and **`--prompt` defaults to `yolo`**
(<https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/02-cli-reference.md>). A reviewer that forgets
`--mode plan` gets an agent with every permission. This is the most dangerous default in this document.

**No per-run model flag.** The docs say explicitly not to use `--model`, `--max-turns`, `--allowed-tools` or
`--permission-mode` — they are not in the parser; the model comes from configuration
(<https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/02-cli-reference.md>). That makes ZCode a poor fit
for a bot that must pin a model per role. Model config and account login are separate entry points
(<https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/README.md>).

**Cost.** GLM Coding Plan: Lite $12.6–18/month with 10,000 credits a week, Pro $56–80, Max $117.6–168
(<https://z.ai/subscribe>). **Review strength.** GLM-5.3 is the open-weight leader on several coding boards and its maker
claims CyberGym state of the art for vulnerability discovery (<https://z.ai/blog/glm-5.3>) — but the same model is
reachable through OpenCode with a pinnable id, which is the better route for us.

## The ones that cannot do this cleanly, and why

Zed is an editor that *hosts* agents over the Agent Client Protocol and ships no print-and-exit reviewer — useful for a
person, useless for a bot (<https://zed.dev/docs/ai/agents>). The rest fail one property each:

| Tool | What breaks |
| --- | --- |
| **Zed** | No headless print-and-exit CLI at all; it is an ACP host, not an agent (<https://zed.dev/docs/ai/agents>). |
| **Devin CLI** | Print mode has no read-only permission value; the read-only `plan` profile needs `/plan` or ACP (<https://docs.devin.ai/cli/reference/commands>). |
| **ZCode** | `--prompt` defaults to `--mode yolo`, and there is no per-run model flag to pin (<https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/02-cli-reference.md>). |
| **Antigravity** | Works, but only with credentials cached from an interactive login — no documented API-key variable for CI (<https://antigravity.google/docs/cli/headless>). |
| **Cline** | Works, but no shell allow/deny list; blocking commands needs a `PreToolUse` hook (<https://docs.cline.bot/cline-cli/getting-started>). |

## Who reviews what

Rules that shaped this: the reviewer comes from a different provider than the author; the strongest model does not run
twice on one change unless a Mac can break; the third choice must be cheap enough to run on a bad day. Model ids are the
ones this repo already allows (<https://github.com/Flame119052/tess-music/blob/main/.github/agents.json>); the tiers come
from `docs/workflow.md` (<https://github.com/Flame119052/tess-music/blob/main/docs/workflow.md>).

| Role | First choice | Second choice | Third choice |
| --- | --- | --- | --- |
| **Approach review** (is this the right design?) | **claude `claude-opus-5-5`, effort high** — best design judgement, and the only model here with an independent review benchmark behind it | **codex `gpt-6.1-sol`, effort high** — close second, half the cost per task, and a genuinely different reading of a plan | **antigravity `gemini-4-argon-high`, effort high** — strongest planner outside the big two; burns quota, so use when the first two are out |
| **Normal PR** (theme, Tess Mini, tools) | **codex `gpt-6.1-terra`, effort medium** — cheapest strong reviewer, fast, and a different provider from a Claude author | **claude `claude-sonnet-5-5`, effort medium** — good balance when Codex is short of weekly quota | **opencode `glm-5.3`, effort high** — pennies per review and good at root causes, run with the deny-everything agent |
| **Sensitive PR** (installer, patcher, release, rescue, signing) | **claude `claude-opus-5-5`, effort high** — strongest reviewer for a change that can break someone's Mac | **codex `gpt-6.1-sol`, effort high** — the closest thing to a second opinion, and must be the other provider from the author | **opencode `glm-5.3`, effort max** — open-weight leader on vulnerability discovery; a useful third pair of eyes on security |
| **Docs** | **opencode `deepseek-v4.1-flash`, effort medium** — $0.30/$1.20 per million and good enough for prose and links | **codex `gpt-6.1-terra`, effort low** — quick sanity read when OpenCode is not set up | **claude `claude-haiku-5-5`, effort low** — the cheap Claude, if a docs change touches a safety claim |

Two deliberate omissions. **Grok 4.7** reviews better than it codes, but its token burn per review is the worst here and
two threads call it out (<https://www.reddit.com/r/cursor/comments/1wu9jj0/>) — a spare, not a default. **Cursor
`gpt-5.6-sol`** works, but has no review benchmark and bills at list price on top of a subscription.

## What to verify on the runner machines first

1. **Claude:** does `claude -p --restricted --safe-mode --tools "Read,Grep,Glob"` still answer a review? `--restricted`
   removes command tools unless named in `--tools` (<https://code.claude.com/docs/en/cli-reference>), so a reviewer that
   cannot run `git diff` needs the diff piped in on stdin instead.
2. **Antigravity:** whether a copied `~/.gemini` profile is enough on `omarchy`, or whether `agy` demands a fresh login.
3. **OpenCode:** whether a deny-everything reviewer agent beats the built-in `plan` agent, which still allows
   permission-controlled shell (<https://opencode.ai/docs/agents/>).
4. **Every provider:** the usage hub is the real gate. Claude at 98% of its session and Codex at 96% of its week means
   the fallback order in `agents.json` gets exercised often.

## Summary

Read-only headless reviewing is solved by four CLIs — Claude Code, Codex, Cursor and OpenCode — and Claude Code's
`--restricted` plus `--safe-mode` is the only combination that confines a reviewer to a folder and stops a PR smuggling
instructions in through config. Codex is the cleanest default because `codex exec` is read-only unless you say otherwise.
OpenCode is the cheapest credible third provider, with one caveat: its `plan` agent still allows permission-controlled
shell, so a reviewer needs an agent that denies `edit` and `shell` outright. Devin, ZCode, Zed and Antigravity each fail
one of the four properties — ZCode most alarmingly, because `--prompt` starts in `yolo` mode.

For this repo: Opus 5.5 reviews approaches and sensitive PRs, GPT-6.1 Terra reviews normal PRs, and GLM-5.3 or DeepSeek
V4.1 Flash is the cheap third when the big two are out of quota.

Branch: `reviewer-models-research`.
