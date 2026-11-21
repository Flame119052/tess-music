// Test reviewer tier, model selection, sandbox prep and the deny-everything agent without GitHub or provider calls.
// Usage: node tools/test-agent-review.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  agentConfig,
  assertReviewerAgent,
  budgetUsd,
  claudeTools,
  cliArgs,
  capsFor,
  containsHeldSecret,
  eligibleModels,
  failureComment,
  failureSummary,
  formatUtcTime,
  formatRelativeTime,
  earliestReset,
  forkProblem,
  freshestSnapshot,
  headAnswer,
  headFacts,
  headMismatchMessage,
  headReviewProblem,
  installedProviders,
  looksSecret,
  machineOf,
  noRoomComment,
  parseClaudeOutput,
  parseCodexOutput,
  parseRequest,
  parseSnapshot,
  pinnedReviewer,
  postVerdict,
  providerHasUsage,
  providerKeys,
  proxiedProviders,
  startReviewProxy,
  redactText,
  reserveProblem,
  reservationEnd,
  requestProblem,
  refusalComment,
  authorChoices,
  authorProvider,
  antigravityAuth,
  antigravityMachineReason,
  antigravityTokenRelative,
  codexAuth,
  credentialProblem,
  antigravityStdin,
  describeAntigravityLogin,
  forgetMintedSecrets,
  invokeReviewerCli,
  mintAntigravityAccess,
  parseAntigravityOutput,
  readAntigravityOAuthClient,
  withAntigravityAccess,
  writeAntigravityAccess,
  retiredKeyNames,
  reviewerEnv,
  readSnapshots,
  reviewerCandidates,
  queuedComment,
  reviewCost,
  reviewCostPercent,
  reviewMachines,
  reviewPrompt,
  reviewRefusals,
  reviewRefusalText,
  reviewUsage,
  reviewsToKeep,
  runReviewer,
  sandboxArgv,
  sandboxHome,
  sandboxProblem,
  sanitizeLine,
  skipReason,
  snapshot,
  snapshotUsage,
  stripAgentConfig,
  timeoutSeconds,
  tagProblem,
  tagPromptMax,
  tierForPaths,
  watcherMachines,
  snapshotAge,
  snapshotMaxAgeMs,
  usageNote,
  usageProblem,
  usedLine,
  verifyPrHead,
} from './agent-review.mjs';
import * as agentReview from './agent-review.mjs';
import { proxyProviders, proxyRoutes } from './review-proxy.mjs';
import { createReviewProxy, maxProxyBodyBytes, matchProxyRoute, proxyReviewerConfig } from './review-proxy.mjs';

const config = JSON.parse(readFileSync(new URL('../.github/agents.json', import.meta.url), 'utf8'));
const agentFile = new URL('../tools/opencode-reviewer.md', import.meta.url);
const agentText = readFileSync(agentFile, 'utf8');
const available = (usedPercent) => ({ windows: [{ usedPercent }] });
// stays true when the failure is about the runner (a flag, a usage limit) rather than about the change
const retries = (result) => skipReason(result) !== null;
const temp = () => mkdtempSync(join(tmpdir(), 'tess-test-'));

// The review job runs on a fresh GitHub-hosted machine, and only the CLI for the reviewer it picked is installed.
// These tests read the real workflow so the retired self-hosted path cannot creep back in unnoticed.
const workflowText = () => readFileSync(new URL('../.github/workflows/agent-review.yml', import.meta.url), 'utf8');

function jobBlock(name) {
  const lines = workflowText().split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start > 0, `the workflow has a ${name} job`);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  \S/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

function stepBlock(job, name) {
  const lines = job.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `the workflow has a "${name}" step`);
  const base = lines[start].search(/\S/);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && lines[i].search(/\S/) <= base) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

test('the review runs on a fresh GitHub-hosted machine, never a self-hosted runner', () => {
  const text = workflowText();
  const review = jobBlock('review');
  assert.match(review, /runs-on: ubuntu-latest/, 'the review job is a standard GitHub-hosted job');
  assert.match(review, /timeout-minutes: 30/, 'a stuck job fails instead of holding a machine');
  assert.match(review, /if: needs\.gate\.outputs\.allowed == 'true'/, 'the gate decides before anything runs');
  assert.match(jobBlock('gate'), /runs-on: ubuntu-latest/);

  // The whole self-hosted path is retired: labels, the Instabox wake probe and its variable.
  for (const gone of ['self-hosted', 'tess-agent', 'tess-primary', 'tess-backup', 'REVIEW_WAKE_URL', '/ready', 'runs_on']) {
    assert.ok(!text.includes(gone), `${gone} is gone from the workflow`);
  }
});

test('only the chosen reviewer\'s CLI is installed, at a pinned version', () => {
  const review = jobBlock('review');
  const installs = {
    claude: 'Install Claude Code', codex: 'Install Codex', opencode: 'Install OpenCode', antigravity: 'Install Antigravity',
  };
  for (const [provider, step] of Object.entries(installs)) {
    const block = stepBlock(review, step);
    assert.match(block, new RegExp(`if: steps\\.pick\\.outputs\\.provider == '${provider}'`),
      `${step} only runs when ${provider} was picked`);
    assert.match(block, /@\d+\.\d+\.\d+/, `${step} pins the CLI version`);
  }
  // Everything else is a standard runner tool: node, and bubblewrap checked before a reviewer can start.
  const sandbox = stepBlock(review, 'Let bubblewrap start its sandbox');
  assert.match(sandbox, /kernel\.apparmor_restrict_unprivileged_userns=0/,
    'Ubuntu 24.04 lets unprivileged user namespaces through before bubblewrap starts');
  assert.match(sandbox, /bwrap --unshare-all/, 'the job proves the sandbox really starts');
});

test('the review step holds one provider key and never a second provider\'s', () => {
  const review = jobBlock('review');
  assert.ok(!/^    env:/m.test(review), 'the job sets no environment that every step inherits');
  const run = stepBlock(review, 'Run read-only reviewer');
  for (const [provider, names] of Object.entries(providerKeys)) {
    for (const name of names) {
      const line = run.split('\n').find((entry) => entry.trim().startsWith(`${name}:`));
      if (!installedProviders.includes(provider)) {
        assert.ok(!line, `${name} is not wired: ${provider} is optional`);
        continue;
      }
      assert.ok(line, `${name} is on the review step`);
      assert.match(line, new RegExp(`provider == '${provider}'`), `${name} is only passed when ${provider} is picked`);
    }
  }
  assert.match(run, /GH_TOKEN: \$\{\{ github\.token \}\}/, 'the job can post the comment');
  assert.match(run, /node tools\/agent-review\.mjs/, 'the script itself strips GH_TOKEN before the reviewer starts');
});

test('review refuses when the PR head moved after the CI gate or gated SHA is missing', () => {
  assert.equal(headMismatchMessage('abc123', 'abc123'), null);
  const moved = headMismatchMessage('abc123', 'def456');
  assert.match(moved, /abc123 → def456/);
  assert.match(moved, /Verdict: changes needed/);

  const posted = [];
  assert.equal(verifyPrHead('', () => 'def456', (msg) => posted.push(msg)), null);
  assert.equal(verifyPrHead('abc123', () => 'def456', (msg) => posted.push(msg)), null);
  assert.equal(posted.length, 2);
  assert.match(posted[0], /none → def456/);
  assert.match(posted[1], /abc123 → def456/);
  assert.equal(verifyPrHead('abc123', () => 'abc123', (msg) => posted.push(msg)), 'abc123');
  assert.equal(posted.length, 2);

  // Also verify the real workflow passes REVIEW_HEAD_SHA and `agent-review.mjs` refuses before reading the diff.
  const workflow = readFileSync(new URL('../.github/workflows/agent-review.yml', import.meta.url), 'utf8');
  assert.match(workflow, /REVIEW_HEAD_SHA:\s*\$\{\{\s*needs\.gate\.outputs\.head_sha\s*\}\}/);

  const scriptPath = fileURLToPath(new URL('./agent-review.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'tess-head-'));
  try {
    const commentOut = join(dir, 'comment');
    writeFileSync(join(dir, 'git'), `#!/bin/sh
case "$*" in
  *" rev-parse FETCH_HEAD"*) printf 'cafebabe\\n' ;;
  *) exit 0 ;;
esac
`);
    writeFileSync(join(dir, 'gh'), `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/issues/89" ]; then
  printf '{"number":89,"title":"t","html_url":"https://example.invalid/89","body":""}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/pulls/89" ]; then
  printf '{"head":{"sha":"cafebabe","repo":{"full_name":"Flame119052/tess-music","fork":false}}}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  cat > '${commentOut}'
  exit 0
fi
exit 99
`);
    chmodSync(join(dir, 'git'), 0o755);
    chmodSync(join(dir, 'gh'), 0o755);
    execFileSync(process.execPath, [scriptPath, 'pr', '89'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REVIEW_HEAD_SHA: 'deadbeef' },
      stdio: 'pipe',
    });
    const postedBody = readFileSync(commentOut, 'utf8');
    assert.match(postedBody, /deadbeef → cafebabe/);
    assert.match(postedBody, /Verdict: changes needed/);

    // And a head that already disagrees with the gate stops the run before anything is fetched, snapshotted or reviewed.
    writeFileSync(join(dir, 'git'), `#!/bin/sh
case "$*" in
  *" rev-parse FETCH_HEAD"*) printf 'deadbeef\\n' ;;
  *" archive "*) exit 98 ;;
  *) exit 0 ;;
esac
`);
    writeFileSync(join(dir, 'gh'), `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/issues/89" ]; then
  printf '{"number":89,"title":"t","html_url":"https://example.invalid/89","body":""}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/pulls/89/files" ]; then
  printf 'tools/agent-review.mjs\\n'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
  printf 'diff --git a/x b/x\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/pulls/89" ]; then
  printf '{"head":{"sha":"cafebabe","repo":{"full_name":"Flame119052/tess-music","fork":false}}}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  cat > '${commentOut}'
  exit 0
fi
exit 99
`);
    chmodSync(join(dir, 'git'), 0o755);
    chmodSync(join(dir, 'gh'), 0o755);
    execFileSync(process.execPath, [scriptPath, 'pr', '89'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REVIEW_HEAD_SHA: 'deadbeef' },
      stdio: 'pipe',
    });
    const raceBody = readFileSync(commentOut, 'utf8');
    assert.match(raceBody, /deadbeef → cafebabe/);
    assert.match(raceBody, /Verdict: changes needed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an approach review reaches the review-copy snapshot without shadowing it', () => {
  // `main` calls snapshot('HEAD') for the copy; a usage snapshot variable with the same name once hid that function, so
  // this drives the real script far enough to call it. The fake CLIs are absent on PATH, so it stops at "no reviewer".
  const dir = temp();
  const scriptPath = fileURLToPath(new URL('./agent-review.mjs', import.meta.url));
  try {
    writeFileSync(join(dir, 'git'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(dir, 'gh'), `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/issues/42" ]; then
  printf '{"number":42,"title":"t","html_url":"https://example.invalid/42","body":""}'
  exit 0
fi
exit 99
`);
    chmodSync(join(dir, 'git'), 0o755);
    chmodSync(join(dir, 'gh'), 0o755);
    let error;
    try {
      execFileSync(process.execPath, [scriptPath, 'approach', '42'], {
        env: { ...process.env, HOME: dir, PATH: `${dir}:/usr/bin:/bin` },
        stdio: 'pipe',
      });
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error, 'the run has to stop somewhere');
    const output = `${error.stderr || ''}${error.stdout || ''}${error.message || ''}`;
    assert.match(output, /names no reviewer/, 'it stopped after making the review copy, not before');
    assert.ok(!/is not a function/.test(output), 'the usage snapshot never shadows snapshot()');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the role pools say what may be used, not what wins, and every model is on a plan', () => {
  // The order means nothing: the tag chooses. What matters is that each pool holds only allowed models, and that every
  // allowed model can be reached only through a subscription login.
  for (const role of ['approach', 'pr_normal', 'pr_sensitive']) {
    assert.ok(config[role].length >= 2, `${role} offers a choice`);
    for (const m of config[role]) {
      assert.ok(config.allowed[m.provider].includes(m.model), `${role}: ${m.model} is allowed`);
      assert.ok(!m.effort || config.efforts.includes(m.effort), `${role}: ${m.effort} is one of ${config.efforts}`);
      assert.ok(config.cost[`${m.provider}/${m.model}`], `${role}: ${m.model} has a cost weight`);
    }
  }
  // Sensitive work has GLM-5.3 on the Z.ai plan, Codex sol on the ChatGPT plan, and Claude Opus to choose from.
  for (const strong of ['zai-coding-plan/glm-5.3', 'gpt-6.1-sol', 'claude-opus-5-5']) {
    assert.ok(config.strong.includes(strong), `${strong} is strong`);
  }
  for (const role of ['approach', 'pr_sensitive']) {
    assert.ok(config[role].some((m) => config.strong.includes(m.model)), `${role} can use a strong model`);
  }
  // The cheap end is still offered for ordinary work, including both GLM routes that live on separate plans.
  const normal = config.pr_normal.map((m) => `${m.provider}/${m.model}`);
  for (const cheap of ['opencode/opencode-go/deepseek-v4.1-flash', 'opencode/zai-coding-plan/glm-5.3-flash']) {
    assert.ok(normal.includes(cheap), `${cheap} is offered for a normal change`);
  }
  assert.ok(!normal.includes('claude/claude-opus-5-5'), 'normal work does not default to the heaviest Claude model');
});

test('docs-only paths use CI review', () => {
  assert.equal(tierForPaths(['docs/workflow.md', 'README.md', '.github/ISSUE_TEMPLATE/bug.md']), 'docs');
});

test('ordinary product and tool paths are normal', () => {
  assert.equal(tierForPaths(['theme/Tess/src/core.js', 'tools/build.mjs']), 'normal');
  assert.equal(tierForPaths(['theme/Tess/src/core.js', 'docs/rescue.md']), 'normal');
  assert.equal(tierForPaths([]), 'normal');
});

test('release, workflow, installer, inbox, patcher, signing, and rescue paths are sensitive', () => {
  for (const path of [
    '.github/workflows/check.yml',
    'installer/updater.sh',
    'support/setup.sh',
    'inbox/worker.js',
    'patcher/src/cmd/swap.go',
    'tools/release.mjs',
    'tools/promote.mjs',
    'tools/check-safety.sh',
    'tools/rescue.mjs',
    'config/signing-key.txt',
  ]) {
    assert.equal(tierForPaths([path]), 'sensitive', path);
  }
});

test('one sensitive path makes a mixed PR sensitive', () => {
  assert.equal(tierForPaths(['docs/workflow.md', 'theme/Tess/src/core.js', '.github/agents.json']), 'sensitive');
});

test("a PR that only loosens the reviewer's own permissions is sensitive", () => {
  assert.equal(tierForPaths(['tools/opencode-reviewer.md']), 'sensitive');
  assert.equal(tierForPaths(['tools/opencode-reviewer.md', 'docs/workflow.md']), 'sensitive');
});

test('unknown usage is eligible and any exhausted window blocks a provider', () => {
  assert.equal(providerHasUsage(undefined), true);
  assert.equal(providerHasUsage({ windows: [] }), true);
  assert.equal(providerHasUsage({ windows: [{ usedPercent: 99 }, { usedPercent: 20 }] }), true);
  assert.equal(providerHasUsage({ windows: [{ usedPercent: 10 }, { usedPercent: 100 }] }), false);
  assert.equal(providerHasUsage({ windows: [{ usedPercent: 100, resetsAt: '2020-01-01T00:00:00Z' }] }), true);
});

test('a tag names the reviewer, and only a hard rule can refuse it', () => {
  const now = Date.parse('2026-11-15T06:30:00Z');
  const honoured = requestProblem(config, { provider: 'codex', model: 'gpt-6.1-terra', effort: 'high' }, { author: 'opencode', now });
  assert.deepEqual(honoured.model, { provider: 'codex', model: 'gpt-6.1-terra', effort: 'high' }, 'the job runs what the tag named');

  // A sensitive change needs a strong model, and GLM-5.3 on the Z.ai plan is one: this is the case that used to be
  // blocked by Claude and Codex being short of room.
  assert.match(requestProblem(config, { provider: 'claude', model: 'claude-sonnet-5-5' }, { tier: 'sensitive', author: 'codex' }).reason, /strong model/);
  assert.ok(requestProblem(config, { provider: 'opencode', model: 'zai-coding-plan/glm-5.3' }, { tier: 'sensitive', author: 'codex' }).model);

  // No model named: refused, because the job does not choose.
  assert.match(requestProblem(config, {}, {}).reason, /names no reviewer/);
  assert.match(requestProblem(config, { provider: 'codex' }, {}).reason, /names no reviewer/);

  // Not on the plans-only list, including anything reached with an API key.
  assert.match(requestProblem(config, { provider: 'codex', model: 'gpt-9' }, {}).reason, /plans-only list/);
  assert.match(requestProblem(config, { provider: 'cursor', model: 'composer-2.5' }, {}).reason, /plans-only list/);
  for (const retired of retiredKeyNames) assert.ok(!Object.keys(providerKeys).some((p) => providerKeys[p].includes(retired)), retired);
  for (const provider of Object.keys(config.allowed)) {
    assert.ok(config.plans[provider], `${provider} names the plan it bills`);
  }

  // A CLI this job does not install, an effort word it does not know.
  assert.match(requestProblem(config, { provider: 'codex', model: 'gpt-6.1-sol' }, { installed: ['claude'] }).reason, /does not install/);
  assert.match(requestProblem(config, { provider: 'codex', model: 'gpt-6.1-terra', effort: 'ultra' }, {}).reason, /effort must be/);

  // The author's own provider, read from the pull request, is refused.
  assert.match(requestProblem(config, { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' }, { author: 'opencode' }).reason, /same provider/);

  // A window with nothing left, and a reserved one, are refusals that carry the moment there is room again.
  const empty = requestProblem(config, { provider: 'codex', model: 'gpt-6.1-sol' }, {
    now,
    author: 'opencode',
    usage: { windows: [{ kind: 'weekly', usedPercent: 100, resetsAt: '2026-11-16T09:00:00Z' }] },
  });
  assert.match(empty.reason, /no usage left/);
  assert.equal(empty.resetsAt, Date.parse('2026-11-16T09:00:00Z'));
  const reserved = requestProblem(config, { provider: 'claude', model: 'claude-opus-5-5' }, {
    now,
    author: 'opencode',
    reserve: { weekly: 30, note: "Krish's own work" },
    usage: { windows: [{ kind: 'weekly', usedPercent: 85, resetsAt: '2026-11-17T09:00:00Z' }] },
  });
  assert.match(reserved.reason, /reserved for Krish's own work/);
  assert.equal(reserved.resetsAt, Date.parse('2026-11-17T09:00:00Z'));

  // A Codex login that cannot last a review is a refusal like any other.
  assert.match(requestProblem(config, { provider: 'codex', model: 'gpt-6.1-sol' }, { credential: 'the stored Codex login expired' }).reason, /expired/);
});

test('a refusal is said in a comment, and never becomes another model', () => {
  const now = Date.parse('2026-11-15T06:30:00Z');
  const resetsAt = Date.parse('2026-11-15T09:10:00Z');
  const body = refusalComment({ reason: 'codex/gpt-6.1-sol has no usage left in its weekly window', provider: 'codex', model: 'gpt-6.1-sol', resetsAt, now });
  assert.ok(body.startsWith('<!-- tess-review-bot -->'), 'the marker keeps it from triggering another review');
  assert.match(body, /codex \/ gpt-6\.1-sol was refused/);
  assert.match(body, /Why: codex\/gpt-6\.1-sol has no usage left/);
  assert.match(body, /2026-11-15 09:10 UTC/, 'the reset time is UTC and exact');
  assert.match(body, /in 2h 40m/, 'and how far away it is');
  assert.match(body, /does not substitute another model/);
  // Without a reset time it still refuses, and says nothing it cannot know.
  const bare = refusalComment({ reason: 'no model named', provider: '', model: '', resetsAt: null, now });
  assert.match(bare, /Review not run\./);
  assert.ok(!/resets at/.test(bare));
});

test('the Codex plan login is refused when it is missing or near its expiry', () => {
  const now = Date.parse('2026-11-15T06:00:00Z');
  const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
  const login = (accessToken, accountId = 'acct-1') => JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: accessToken, account_id: accountId, refresh_token: 'r' },
    last_refresh: '2026-11-14T00:00:00Z',
  });
  const hours = (n) => now + n * 60 * 60 * 1000;

  // Good: ten days of access token, which is what a plan login really carries.
  const good = codexAuth(login(jwt(Math.floor(hours(240) / 1000))), now);
  assert.equal(good.accessToken, jwt(Math.floor(hours(240) / 1000)));
  assert.equal(good.accountId, 'acct-1');
  assert.equal(credentialProblem('codex', { CODEX_AUTH_JSON: login(jwt(Math.floor(hours(240) / 1000))) }), null);

  // Inside the 12-hour margin the review would be racing the expiry, so it refuses now with a reason that says what to do.
  const near = codexAuth(login(jwt(Math.floor(hours(6) / 1000))), now);
  assert.match(near.problem, /expires in about 6h/);
  assert.match(near.problem, /codex-ci-login/);
  const expired = codexAuth(login(jwt(Math.floor(hours(-1) / 1000))), now);
  assert.match(expired.problem, /expired at/);

  // Missing, malformed, an API key instead of a plan login, an opaque token, and a login with no account id all refuse.
  assert.match(codexAuth('', now).problem, /CODEX_AUTH_JSON is empty/);
  assert.match(codexAuth('{not json', now).problem, /not readable JSON/);
  assert.match(codexAuth(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }), now).problem, /no access token/);
  assert.match(codexAuth(login('not-a-jwt'), now).problem, /no readable expiry/);
  assert.match(codexAuth(login(jwt(Math.floor(hours(240) / 1000)), ''), now).problem, /no account id/);
  // Only Codex has a login that can expire; the other providers answer with their own CLI.
  assert.equal(credentialProblem('claude', {}), null);
});

test('a no-room comment names the reset time in UTC and in plain time', () => {
  const now = Date.parse('2026-11-15T06:30:00Z');
  const resetsAt = Date.parse('2026-11-15T09:10:00Z');
  const body = noRoomComment({ reasons: ['codex/gpt-6.1-sol (no usage left in its weekly window)'], earliestResetMs: resetsAt, now });
  assert.ok(body.startsWith('<!-- tess-review-bot -->'));
  assert.match(body, /No reviewer had room to run\./);
  assert.match(body, /codex\/gpt-6\.1-sol \(no usage left/);
  assert.match(body, /Earliest window reset: 2026-11-15 09:10 UTC \(in 2h 40m\)/);
  assert.match(body, /Tag again after that time\./);
  assert.equal(formatUtcTime(resetsAt), '2026-11-15 09:10 UTC');
  assert.equal(formatRelativeTime(resetsAt, now), 'in 2h 40m');
  assert.equal(earliestReset([{ resetsAt: '2026-11-15T09:10:00Z' }, { resetsAt: '2026-11-15T07:45:00Z' }], now),
    Date.parse('2026-11-15T07:45:00Z'));
  assert.match(noRoomComment({ reasons: [], now }), /Tag again once a reviewer has usage available\./);
});

test('the author is read from every authorship shape this repository really uses', () => {
  // The one-line form the docs and most PRs use, plain and bold.
  assert.equal(authorProvider('Made by: DeepSeek V4.1 Flash in OpenCode\n\nbody'), 'opencode');
  assert.equal(authorProvider('**Made by:** Claude Opus 5.5'), 'claude');
  assert.equal(authorProvider('- Made by: Codex gpt-6.1-terra'), 'codex');
  assert.equal(authorProvider('Made by: Gemini 4 in Antigravity'), 'antigravity');
  // The template's `## Made by` heading with the sentence under it, which is what this repository's own PRs use.
  assert.equal(authorProvider('## Made by\n\nDeepSeek V4.1 Flash in OpenCode\n'), 'opencode');
  assert.equal(authorProvider('### Made by\nCodex gpt-6.1-sol'), 'codex');
  assert.equal(authorProvider('## Made by\r\n\r\nClaude Opus 5.5 in Claude Code\r\n'), 'claude');
  // The section ends at the next heading, so a later mention of another agent is not read as the author.
  assert.equal(authorProvider('## Made by\n\nDeepSeek V4.1 Flash in OpenCode\n\n## Checklist\nCodex reviewed it'), 'opencode');
  // The real template: its `## Made by` hint is an HTML comment, which is instruction rather than an author, and the
  // section is empty until somebody fills it in.
  const template = readFileSync(new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8');
  assert.equal(authorProvider(template), '', 'an unfilled template names no author');
  assert.equal(authorProvider(`${template}\nDeepSeek V4.1 Flash in OpenCode\n`), 'opencode', 'a filled one does');
  // Nothing to read: no marker, an empty marker, a sentence naming nobody, or one naming two providers. A reviewer the
  // text cannot name is never a reason to allow anything (see the guard test below).
  for (const body of ['no line at all', '', '## Made by\n\n', 'Made by:', 'Made by: someone', 'Made by: Claude Opus in OpenCode']) {
    assert.equal(authorProvider(body), '', JSON.stringify(body));
  }
});

test('Antigravity is a GitHub reviewer on the Google plan, and a machine tag is refused in one line', () => {
  const neon = { provider: 'antigravity', model: 'gemini-4-neon', effort: 'high', machine: 'github' };
  const onGitHub = requestProblem(config, neon, { author: 'claude', machine: 'github' });
  assert.deepEqual(onGitHub.model, { provider: 'antigravity', model: 'gemini-4-neon', effort: 'high' },
    'machine=github runs the model the tag named');
  for (const machine of ['mac', 'omarchy']) {
    const refused = requestProblem(config, { ...neon, machine }, { author: 'claude', machine });
    assert.equal(refused.reason, antigravityMachineReason, machine);
    assert.equal(refused.model, undefined);
  }
  assert.match(requestProblem(config, { ...neon, author: 'antigravity' }, { author: 'antigravity', machine: 'github' }).reason, /same provider/);
  assert.match(credentialProblem('antigravity', {}), /AGY_OAUTH_TOKEN is empty/);
  assert.match(antigravityAuth('{"api_key":"x","access_token":"y"}').problem, /not a Google plan login/);
  assert.match(antigravityAuth('{"type":"service_account","client_email":"a@b.c","access_token":"y"}').problem, /not a Google plan login/);
  assert.equal(antigravityAuth('{"access_token":"plan-access","refresh_token":"plan-refresh"}').ok, true);

  const args = cliArgs('antigravity', 'gemini-4-neon', 'high', '/w');
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--input-format') && args.includes('stream-json'));
  assert.ok(!args.includes('--mode') && !args.includes('--sandbox'), 'plan mode and the CLI sandbox are not passed');
  assert.equal(args.at(-2), '-p');
  assert.equal(args.at(-1), '', 'the prompt is not an argument');
  const resultLine = (result) => JSON.stringify({ event: 'result', result });
  const parsed = parseAntigravityOutput([
    JSON.stringify({ event: 'init', session: 's' }),
    resultLine({ status: 'SUCCESS', response: 'Verdict: approve', num_turns: 2,
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }),
  ].join('\n'));
  assert.equal(parsed.text, 'Verdict: approve');
  assert.equal(parsed.usage.total, 7);
  // Only one completed result is a review; an unfinished run never becomes a verdict.
  for (const [why, out] of [
    ['an init line that says approve', JSON.stringify({ event: 'init', response: 'Verdict: approve' })],
    ['plain text', 'notice: Verdict: approve'],
    ['a flat object with no result event', JSON.stringify({ status: 'SUCCESS', response: 'Verdict: approve' })],
    ['two results', [resultLine({ status: 'SUCCESS', response: 'Verdict: approve' }),
      resultLine({ status: 'SUCCESS', response: 'Verdict: changes needed' })].join('\n')],
    ['a result with no status', resultLine({ response: 'Verdict: approve' })],
    ['a successful result with an empty response', resultLine({ status: 'SUCCESS', response: '  ' })],
    ['no output', ''],
  ]) {
    const r = parseAntigravityOutput(out);
    assert.equal(r.text, '', `${why} was taken as a review`);
    assert.ok(r.errorText, `${why} gave no reason`);
  }

  const home = temp();
  try {
    const dest = writeAntigravityAccess(home, {
      accessToken: 'ya29.' + 'a'.repeat(24),
      tokenType: 'Bearer',
      expiry: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(dest, join(home, antigravityTokenRelative));
    const written = readFileSync(dest, 'utf8');
    assert.equal(written.includes('refresh_token'), false);
    const sandbox = sandboxArgv('antigravity', '/work', ['-p', ''], {
      home, exists: () => true, commandPath: `${home}/.local/bin/agy`, nodePath: `${home}/.local/bin/node`,
    });
    const at = sandbox.args.indexOf(dest);
    assert.equal(sandbox.args[at - 1], '--ro-bind', 'the access file is mounted read-only');
    assert.ok(!sandbox.args.some((arg) => String(arg).includes('.codex') || String(arg).includes('opencode')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const env = {
    HOME: '/home/r', PATH: '/bin', GH_TOKEN: 'ghs_x', AGY_OAUTH_TOKEN: '{"refresh_token":"plan-refresh-secret"}',
  };
  const cleaned = reviewerEnv(env, 'antigravity');
  assert.equal(cleaned.AGY_OAUTH_TOKEN, undefined, 'the file is mounted; the secret is not also an environment variable');
  assert.equal(cleaned.GH_TOKEN, undefined);
  assert.ok(containsHeldSecret(`the review quoted ${env.AGY_OAUTH_TOKEN}`, env));

  const bin = fileURLToPath(new URL('./agy-ci-login.mjs', import.meta.url));
  const scratch = temp();
  try {
    const missing = spawnSync(process.execPath, [bin, '--check'], {
      env: { ...process.env, TESS_AGY_CI_HOME: scratch }, encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout, /none yet/);
    mkdirSync(join(scratch, '.gemini/antigravity-cli'), { recursive: true });
    writeFileSync(join(scratch, antigravityTokenRelative), '{"refresh_token":"plan-refresh-secret"}');
    const ok = spawnSync(process.execPath, [bin, '--check'], {
      env: { ...process.env, TESS_AGY_CI_HOME: scratch, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
    });
    assert.notEqual(ok.status, 0, 'a check without the agy binary fails closed');
    assert.ok(!`${ok.stdout}\n${ok.stderr}`.includes('plan-refresh-secret'), 'the check does not print the token');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the Google sign-in client is read from the agy binary, and a binary without the anchors fails closed', () => {
  const idAnchor = 'classification.deprecated_as_an_error';
  const secretAnchor = 'v1beta/models/%s:generateContent';
  const id = ['1234567890123', '-', 'a'.repeat(32), '.apps.', 'googleusercontent.com'].join('');
  const secret = ['GOC', 'SPX-', 'b'.repeat(28)].join('');
  const bin = Buffer.from(`noise ${idAnchor}${id} mid ${secretAnchor}${secret}https://next`);
  assert.deepEqual(readAntigravityOAuthClient(bin), { id, secret });
  assert.throws(() => readAntigravityOAuthClient(Buffer.from('no client here')), /no readable Google sign-in client/);
  assert.throws(() => readAntigravityOAuthClient(Buffer.concat([bin, bin])), /no readable Google sign-in client/);
  assert.throws(
    () => readAntigravityOAuthClient(Buffer.from(`${idAnchor}not-a-client ${secretAnchor}${secret}`)),
    /no readable Google sign-in client/,
  );
});

test('a quote of the refresh token, the access token, or an error echo is refused or redacted', () => {
  const refresh = '1//0' + 'r'.repeat(24);
  const access = 'ya29.' + 'a'.repeat(24);
  const odd = 'refresh-' + 'q'.repeat(20);
  const env = {
    AGY_OAUTH_TOKEN: JSON.stringify({
      refresh_token: refresh,
      access_token: access,
      id_token: 'id-' + 'i'.repeat(16),
      note: odd,
    }),
  };
  assert.ok(containsHeldSecret(refresh, env), 'the refresh token alone is held');
  assert.ok(containsHeldSecret(access, env), 'the access token alone is held');
  assert.ok(containsHeldSecret(odd, env), 'a long string in the login is held');
  assert.equal(looksSecret(odd), false);
  assert.ok(looksSecret(refresh));
  assert.ok(looksSecret(access));
  const stray = 'ya29.' + 'z'.repeat(24);
  assert.equal(redactText(`saw ${stray}`, {}).includes(stray), false);
  const echoed = parseAntigravityOutput(JSON.stringify({
    event: 'result',
    result: { status: 'ERROR', response: refresh, error: '' },
  }));
  const summary = failureSummary({ stderr: echoed.errorText }, env);
  assert.equal(summary.includes(refresh), false, summary);
  assert.match(summary, /\[redacted\]/);
  const accessEcho = parseAntigravityOutput(JSON.stringify({ status: 'ERROR', error: access }));
  const accessSummary = failureSummary({ stderr: accessEcho.errorText }, env);
  assert.equal(accessSummary.includes(access), false, accessSummary);
});

test('the access file has no refresh token, the temp dir is deleted, and the runner home is untouched', async () => {
  forgetMintedSecrets();
  const home = temp();
  const runner = temp();
  writeFileSync(join(home, 'keep'), 'home');
  const refresh = '1//0' + 'e'.repeat(24);
  const access = 'ya29.' + 'd'.repeat(24);
  let seen = '';
  let dirDuring = '';
  try {
    await withAntigravityAccess({
      env: { AGY_OAUTH_TOKEN: JSON.stringify({ refresh_token: refresh }), HOME: home },
      runnerTemp: runner,
      oauthClient: { id: 'client-for-test', secret: 'secret-for-test' },
      fetch: async () => ({ ok: true, json: async () => ({ access_token: access, expires_in: 3600, token_type: 'Bearer' }) }),
    }, async (dir) => {
      dirDuring = dir;
      seen = readFileSync(join(dir, antigravityTokenRelative), 'utf8');
      assert.equal(existsSync(join(home, '.gemini')), false);
    });
    assert.equal(seen.includes('refresh_token'), false);
    assert.equal(seen.includes(refresh), false);
    assert.ok(seen.includes(access));
    assert.equal(existsSync(dirDuring), false);
    assert.equal(readdirSync(runner).some((name) => name.startsWith('tess-agy-')), false);
    assert.equal(existsSync(join(home, '.gemini')), false);
    assert.ok(containsHeldSecret(access, {}), 'the minted access token is held');
  } finally {
    forgetMintedSecrets();
    rmSync(home, { recursive: true, force: true });
    rmSync(runner, { recursive: true, force: true });
  }
});

test('check reports scopes and expiry and does not return the token', async () => {
  const access = 'ya29.' + 'k'.repeat(24);
  const info = await describeAntigravityLogin(JSON.stringify({ refresh_token: '1//0' + 'm'.repeat(24) }), {
    oauthClient: { id: 'client-for-test', secret: 'secret-for-test' },
    now: () => 0,
    fetch: async (url) => {
      if (String(url).includes('tokeninfo')) {
        return { ok: true, json: async () => ({ scope: 'openid email', exp: 1_800_000_000 }) };
      }
      return { ok: true, json: async () => ({ access_token: access, expires_in: 3600, token_type: 'Bearer' }) };
    },
  });
  assert.deepEqual(info.scopes, ['openid', 'email']);
  assert.equal(info.expiry, new Date(1_800_000_000 * 1000).toISOString());
  assert.equal(JSON.stringify(info).includes(access), false);
  await assert.rejects(
    mintAntigravityAccess(JSON.stringify({ refresh_token: '1//0' + 'm'.repeat(24) }), { agyPath: '/no/such/agy' }),
    /no readable Google sign-in client/,
  );
});

test('a prompt over 128 KiB is sent on stdin, not as an argument', async () => {
  forgetMintedSecrets();
  const home = temp();
  const runner = temp();
  const prompt = 'P'.repeat((128 * 1024) + 50);
  const refresh = '1//0' + 's'.repeat(24);
  let args = [];
  let stdin = '';
  let mounted = '';
  try {
    await invokeReviewerCli('antigravity', 'gemini-4-neon', prompt, 'high', home, {
      env: { AGY_OAUTH_TOKEN: JSON.stringify({ refresh_token: refresh }), HOME: home },
      runnerTemp: runner,
      home,
      oauthClient: { id: 'client-for-test', secret: 'secret-for-test' },
      proxy: null,
      fetch: async () => ({
        ok: true,
        json: async () => ({ access_token: 'ya29.' + 'p'.repeat(24), expires_in: 60, token_type: 'Bearer' }),
      }),
      spawnChild(command, argv) {
        args = argv;
        const source = argv.find((arg) => String(arg).startsWith(runner) && String(arg).includes('antigravity-oauth-token'));
        mounted = readFileSync(source, 'utf8');
        const child = new EventEmitter();
        child.stdin = {
          write() { return true; },
          end(chunk) { stdin = String(chunk || ''); },
          on() {},
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdout.setEncoding = () => {};
        child.stderr.setEncoding = () => {};
        child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.emit('data', `${JSON.stringify({
            event: 'result',
            result: { status: 'SUCCESS', response: 'Verdict: approve', num_turns: 1, usage: { total_tokens: 2 } },
          })}\n`);
          child.emit('close', 0, null);
        });
        assert.equal(command, 'bwrap');
        return child;
      },
    });
    assert.equal(mounted.includes('refresh_token'), false);
    assert.equal(mounted.includes(refresh), false);
    assert.ok(args.every((arg) => !String(arg).includes(prompt.slice(0, 40))));
    assert.ok(args.includes('-p') && args[args.indexOf('-p') + 1] === '');
    assert.equal(stdin, antigravityStdin(prompt));
    assert.ok(Buffer.byteLength(stdin) > 128 * 1024);
    assert.equal(existsSync(join(home, '.gemini')), false);
    assert.equal(readdirSync(runner).some((name) => name.startsWith('tess-agy-')), false);
  } finally {
    forgetMintedSecrets();
    rmSync(home, { recursive: true, force: true });
    rmSync(runner, { recursive: true, force: true });
  }
});

test('the different-provider rule is a guard: only the tag attests the author, and text can only refuse', () => {
  const now = Date.parse('2026-11-15T06:30:00Z');
  const deepseek = { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' };
  const terra = { provider: 'codex', model: 'gpt-6.1-terra' };
  const reason = (request, context) => requestProblem(config, request, { now, ...context }).reason || '';
  const runs = (request, context) => Boolean(requestProblem(config, request, { now, ...context }).model);

  // The tag is the trusted metadata; a tag that does not attest the author is refused, however clear the PR body is.
  assert.match(reason(deepseek, {}), /author=/);
  assert.match(reason(deepseek, { authorBody: 'opencode' }), /author=/);
  assert.match(reason(deepseek, { author: 'claud' }), /not one of/);

  // This PR's own shape — `## Made by` and then the sentence — is read now, so the case the review reproduced is refused.
  const headingBody = '## Made by\n\nDeepSeek V4.1 Flash in OpenCode\n\n## Checklist\n- [x] check-safety';
  assert.equal(authorProvider(headingBody), 'opencode');
  assert.match(reason(deepseek, { author: 'opencode', authorBody: authorProvider(headingBody) }), /same provider/);

  // A different provider runs, and the author's own provider never does, whichever way round it is.
  assert.ok(runs(deepseek, { author: 'codex' }));
  assert.ok(runs(terra, { author: 'opencode' }));
  assert.match(reason(terra, { author: 'codex' }), /same provider/);
  // A person wrote the change: no provider shares its blind spots.
  assert.ok(runs(deepseek, { author: 'none' }));

  // The pull request text can only ever add a refusal: a body that disagrees with the tag is refused, while a body that
  // agrees, says nothing, or names two providers changes nothing the tag already decided.
  assert.match(reason(terra, { author: 'codex', authorBody: 'opencode' }), /disagree/);
  assert.match(reason(terra, { author: 'opencode', authorBody: 'claude' }), /disagree/);
  assert.ok(runs(terra, { author: 'opencode', authorBody: 'opencode' }));
  assert.ok(runs(terra, { author: 'opencode', authorBody: '' }));
  // An ambiguous body (two providers in one sentence) names no author, so it adds nothing either way.
  assert.ok(runs(terra, { author: 'opencode', authorBody: authorProvider('Made by: Claude Opus in OpenCode') }));

  // The words `author=` may take are a fixed list, because a typo (`author=claud`) would otherwise quietly allow the
  // provider it was meant to exclude. The tag parser reads it like the other fields.
  assert.deepEqual(authorChoices, ['claude', 'codex', 'opencode', 'antigravity', 'none']);
  assert.equal(parseRequest('@tess-review pr provider=codex model=gpt-6.1-terra author=opencode').author, 'opencode');
});

test('review text that looks like a key or token is never posted', () => {
  assert.ok(looksSecret('here: -----BEGIN PRIVATE KEY-----\nMC4CAQ'));
  assert.ok(looksSecret('token ghp_' + 'a'.repeat(36)));
  assert.ok(looksSecret('x'.repeat(10) + 'A'.repeat(130)));
  assert.ok(!looksSecret('Looks fine. The swap keeps a checked copy.\nVerdict: approve'));
});

test('a review that quotes a key the job holds is never posted', () => {
  const env = {
    GH_TOKEN: 'ghs_' + 'a'.repeat(36),
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-' + 'b'.repeat(40),
    CODEX_AUTH_JSON: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'codex-access-' + 'c'.repeat(20) } }),
    OPENCODE_API_KEY: 'opencode-key-' + 'e'.repeat(20),
    ZHIPU_API_KEY: 'zhipu-key-' + 'f'.repeat(20),
    HOME: '/home/r',
  };
  for (const name of ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_AUTH_JSON', 'OPENCODE_API_KEY', 'ZHIPU_API_KEY']) {
    assert.ok(containsHeldSecret(`the environment had ${env[name]} in it`, env), name);
  }
  assert.ok(!containsHeldSecret('Looks fine. The swap keeps a checked copy.', env));
  // the check is about the job's own keys, not about guessing what a key looks like
  assert.ok(!containsHeldSecret('GLM is cheap and DeepSeek is cheaper', env));
  // values too short to be a key are ignored, so a common word cannot block every review
  assert.ok(!containsHeldSecret('the token is abc', { GH_TOKEN: 'abc' }));
  assert.ok(!containsHeldSecret('nothing held', {}));
});

test('the reviewer gets only its own provider keys, never the GitHub token', () => {
  const env = {
    HOME: '/home/r', PATH: '/bin', TMPDIR: '/tmp', GH_TOKEN: 'ghs_x', GITHUB_TOKEN: 'ghs_y',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', CODEX_AUTH_JSON: '{"tokens":{"access_token":"ck"}}',
    OPENCODE_API_KEY: 'oc', ZHIPU_API_KEY: 'zp', OTHER: '1',
  };
  assert.deepEqual(Object.keys(reviewerEnv(env, 'claude')).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH', 'TMPDIR']);
  assert.deepEqual(Object.keys(reviewerEnv(env, 'opencode')).sort(),
    ['HOME', 'OPENCODE_API_KEY', 'PATH', 'TMPDIR', 'ZHIPU_API_KEY']);
  for (const provider of ['claude', 'codex', 'opencode']) {
    const keys = Object.keys(reviewerEnv(env, provider));
    assert.ok(!keys.includes('GH_TOKEN') && !keys.includes('GITHUB_TOKEN'), `${provider} gets no GitHub token`);
    // Exactly this provider's keys, and no other provider's. OpenCode has two signed-in connectors of its own. A proxied
    // provider is checked below: its login never enters the sandbox at all.
    if (!proxiedProviders.includes(provider)) {
      assert.deepEqual(keys.filter((key) => key.endsWith('_TOKEN') || key.endsWith('_KEY')).sort(),
        [...providerKeys[provider]].sort(), `${provider} gets only its own keys`);
    }
    for (const [other, otherKeys] of Object.entries(providerKeys)) {
      if (other === provider) continue;
      for (const key of otherKeys) assert.ok(!keys.includes(key), `${provider} never gets ${other}'s ${key}`);
    }
  }
  // no provider means no key at all, rather than every key
  assert.deepEqual(Object.keys(reviewerEnv(env, 'nobody')).sort(), ['HOME', 'PATH', 'TMPDIR']);
  assert.ok(looksSecret('sk-ant-oat01-' + 'a'.repeat(80)));

  // Behind the proxy the key is not in the sandbox at all, under any name: the CLI gets the proxy and a token that dies
  // with the job. This is the provider a diff *can* reach, because its tool list has no shell but its environment was
  // one flag away from being readable.
  const proxy = { url: 'http://127.0.0.1:9', token: 'per-review-token' };
  for (const provider of proxiedProviders) {
    const proxied = reviewerEnv(env, provider, proxy);
    assert.equal(proxied.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the Claude key never enters the sandbox');
    assert.equal(proxied.CODEX_AUTH_JSON, undefined, 'the Codex plan login never enters the sandbox');
    assert.equal(JSON.stringify(proxied).includes('sk-ant-oat01-x'), false);
    assert.equal(JSON.stringify(proxied).includes('ck'), false);
    assert.ok(!Object.keys(proxied).some((key) => providerKeys[provider].includes(key)));
    assert.equal(proxied.HOME, '/home/r', 'the sandbox still gets a home and a PATH');
  }
  assert.equal(reviewerEnv(env, 'claude', proxy).ANTHROPIC_AUTH_TOKEN, 'per-review-token');
  assert.equal(reviewerEnv(env, 'claude', proxy).ANTHROPIC_BASE_URL, 'http://127.0.0.1:9/claude');
  assert.equal(reviewerEnv(env, 'codex', proxy).TESS_REVIEW_TOKEN, 'per-review-token');
});

test('the reviewer reads a throwaway copy with read-only tools only', () => {
  assert.deepEqual(claudeTools.split(','), ['Read', 'Grep', 'Glob']);
  const dir = snapshot('HEAD');
  try {
    assert.ok(existsSync(`${dir}/tools/agent-review.mjs`), 'copy has the repo files');
    assert.ok(!existsSync(`${dir}/.git`), 'copy has no .git, so no remote or credentials');
    assert.ok(!existsSync(`${dir}/AGENTS.md`), 'copy carries no AGENTS.md for the reviewer to obey');
    assert.ok(!existsSync(`${dir}/CLAUDE.md`), 'copy carries no CLAUDE.md either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!existsSync(dir), 'copy is deleted after the review');
});

test('agent settings and instructions are stripped at any depth', () => {
  for (const name of ['.opencode', '.cursor', '.claude', 'opencode.json', 'AGENTS.md', 'CLAUDE.md']) {
    assert.ok(agentConfig.includes(name), name);
  }
  const dir = temp();
  try {
    for (const path of ['sub/.cursor/rules/review.mdc', 'sub/AGENTS.md', 'deep/er/.claude/settings.json',
      'opencode.json', 'sub/opencode.json', 'CLAUDE.md', 'notes/keep.md', 'tools/build.mjs', 'sub/AGENTS.md.lock']) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), 'x');
    }
    stripAgentConfig(dir);
    for (const gone of ['sub/.cursor', 'sub/AGENTS.md', 'deep/er/.claude', 'opencode.json', 'sub/opencode.json', 'CLAUDE.md']) {
      assert.ok(!existsSync(join(dir, gone)), `${gone} is removed`);
    }
    assert.ok(existsSync(join(dir, 'notes/keep.md')), 'ordinary files stay');
    assert.ok(existsSync(join(dir, 'tools/build.mjs')), 'code stays');
    assert.ok(existsSync(join(dir, 'sub/AGENTS.md.lock')), 'only the exact names are removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a link out of the copy is removed, and its target is left alone', () => {
  const dir = temp();
  const outside = temp();
  try {
    writeFileSync(join(outside, '.env'), 'CODEX_API_KEY=held');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    symlinkSync(join(outside, '.env'), join(dir, 'notes.txt'));
    symlinkSync('/etc/hosts', join(dir, 'sub/hosts'));

    stripAgentConfig(dir);

    // readdir, not existsSync: a dangling link reports as missing either way
    const top = readdirSync(dir);
    const sub = readdirSync(join(dir, 'sub'));
    assert.ok(!top.includes('notes.txt'), 'a link to the runner .env is removed');
    assert.ok(!sub.includes('hosts'), 'a link to any outside file is removed');
    assert.equal(readFileSync(join(outside, '.env'), 'utf8'), 'CODEX_API_KEY=held', 'the target is never touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('agent files in any letter case are removed at any depth', () => {
  const dir = temp();
  try {
    for (const path of ['sub/Agents.md', 'sub/claude.md', 'sub/opencode.json', 'deep/.github/copilot-instructions.md',
      'deep/copilot-instructions.md', 'docs/workflow.md', 'theme/Tess/src/core.js']) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), 'x');
    }

    stripAgentConfig(dir);

    for (const gone of ['sub/Agents.md', 'sub/claude.md', 'sub/opencode.json', 'deep/.github/copilot-instructions.md',
      'deep/copilot-instructions.md']) {
      assert.ok(!readdirSync(join(dir, gone, '..')).includes(gone.split('/').at(-1)), `${gone} is removed`);
    }
    assert.ok(existsSync(join(dir, 'docs/workflow.md')), 'ordinary docs stay');
    assert.ok(existsSync(join(dir, 'theme/Tess/src/core.js')), 'code stays');
    assert.ok(agentConfig.includes('copilot-instructions.md'), 'the copilot file is matched by name, not by path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each CLI is told the effort and the folder in the way its own flags accept', () => {
  const opencode = cliArgs('opencode', 'opencode-go/glm-5.3', 'high');
  assert.deepEqual(opencode.slice(0, 3), ['run', '--agent', 'tess-reviewer']);
  assert.ok(opencode.includes('opencode-go/glm-5.3#high'), 'the variant rides on the model id');
  assert.ok(!opencode.includes('--variant'), 'opencode run has no --variant flag');
  assert.deepEqual(cliArgs('opencode', 'opencode-go/kimi-k3'), ['run', '--agent', 'tess-reviewer', '--model', 'opencode-go/kimi-k3', '--archived']);

  const codex = cliArgs('codex', 'gpt-6.1-sol', 'high', '/w');
  assert.ok(codex.includes('model_reasoning_effort=high'));
  assert.ok(codex.includes('project_doc_max_bytes=0'), 'a PR cannot feed Codex its own AGENTS.md');
  assert.ok(codex.includes('read-only') && codex.includes('/w'));

  const claude = cliArgs('claude', 'claude-opus-5-5', 'high');
  assert.ok(claude.includes('--effort') && claude.includes('Read,Grep,Glob') && claude.includes('--restricted'));

  assert.throws(() => cliArgs('nobody', 'm'), /unsupported review provider/);
});

test('every review carries a hard cap, spelled the way its CLI takes it', () => {
  const caps = capsFor(config);
  const flag = (args, name) => args[args.indexOf(name) + 1];

  // Claude 2.1.x: --max-turns is real but hidden from --help, and --max-budget-usd is an estimate of API list prices.
  const opus = cliArgs('claude', 'claude-opus-5-5', 'high', '/w', caps);
  assert.equal(flag(opus, '--max-turns'), '12', 'a review stops after 12 turns');
  assert.equal(flag(opus, '--max-budget-usd'), '0.6', 'Opus gets a 60 cent guardrail');
  assert.equal(flag(cliArgs('claude', 'claude-sonnet-5-5', 'medium', '/w', caps), '--max-budget-usd'), '0.3',
    'Sonnet gets 30 cents');
  assert.deepEqual(opus.slice(opus.indexOf('--output-format'), opus.indexOf('--output-format') + 2), ['--output-format', 'json'],
    'the JSON result is what reports the turns and dollars a review used');

  // Codex gets a lower auto-compact threshold plus a hard rollout token cap (both via rollout_budget and the --json stream).
  const codex = cliArgs('codex', 'gpt-6.1-terra', 'medium', '/w', caps);
  assert.ok(codex.includes('model_auto_compact_token_limit=64000'), 'Codex compacts at 64k instead of waiting until 180k');
  assert.ok(codex.includes('features.rollout_budget.enabled=true'), 'Codex rollout budget feature is enabled');
  assert.ok(codex.includes('features.rollout_budget.enforce_limit=true'), 'Codex rollout budget is enforced');
  assert.ok(codex.includes('features.rollout_budget.limit_tokens=200000'), 'Codex rollout budget carries max_tokens');
  assert.ok(codex.includes('features.rollout_budget.reminder_at_remaining_tokens=[50000]'), 'Codex rollout budget warns before the cap');
  assert.ok(codex.includes('model_reasoning_effort=medium'));
  assert.ok(codex.includes('--json'), 'Codex reports the tokens a review used');
  assert.ok(codex.includes('--skip-git-repo-check'), 'the review copy has no .git, so Codex has to be told that');
  assert.equal(caps.codex.max_tokens, 200000);

  // Cursor is not offered: a Claude or GPT model inside it bills prepaid credit from the first request, which breaks the
  // plans-only rule, and the job installs no Cursor CLI anyway.
  assert.equal(config.allowed.cursor, undefined, 'Cursor is not on the plans-only list');

  // OpenCode takes its step limit from its agent file, which the runner must copy exactly, so the two numbers must agree.
  const agent = readFileSync(new URL('./opencode-reviewer.md', import.meta.url), 'utf8');
  assert.equal(Number(agent.match(/^steps:\s*(\d+)$/m)?.[1]), caps.opencode.steps,
    'the agent file and agents.json carry the same OpenCode step cap');

  // The caps are in the config, so one edit changes them everywhere, and a config with no caps is still bounded.
  assert.equal(capsFor({}).timeout_s, 600);
  assert.equal(capsFor({}).claude.max_turns, 12);
  assert.equal(capsFor({ caps: { timeout_s: 90 } }).timeout_s, 90);
});

test('a review that runs past its wall clock is killed, named, and never rerouted', () => {
  const caps = capsFor(config);
  assert.equal(timeoutSeconds({ provider: 'codex', model: 'gpt-6.1-sol' }, caps), 600, 'the default is 10 minutes');
  assert.equal(timeoutSeconds({ provider: 'codex', model: 'gpt-6.1-terra' }, caps), 480, 'terra answers in less');
  assert.equal(timeoutSeconds({ provider: 'opencode', model: 'zai-coding-plan/glm-5.3-flash' }, caps), 480);
  assert.equal(timeoutSeconds({ provider: 'claude', model: 'claude-opus-5-5' }, caps), 600);

  // One named reviewer, and only that one. A timeout kills it and stops the review with a reason a comment can carry;
  // it does not quietly start a second model that nobody chose.
  const called = [];
  let refusal;
  try {
    runReviewer([{ provider: 'codex', model: 'gpt-6.1-sol' }], 'prompt', '/w', {
      usageFor: () => undefined,
      commandAvailable: () => true,
      sandbox: () => null,
      caps,
      invoke: (provider) => { called.push(provider); return { status: null, stdout: '', stderr: '', timedOut: true }; },
    });
  } catch (error) {
    refusal = error;
  }
  assert.deepEqual(called, ['codex'], 'no other model ran');
  assert.match(refusal.message, /timed out after 600s/);
  assert.equal(refusal.refusal.provider, 'codex');
  assert.match(refusal.refusal.reason, /timed out after 600s/);

  // A review that runs reports what it used, and that line is the only extra detail the comment adds.
  const done = runReviewer([{ provider: 'claude', model: 'claude-opus-5-5' }], 'prompt', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: () => null,
    caps,
    invoke: () => ({ status: 0, text: 'Looks right.\nVerdict: approve', usage: { turns: 4, costUsd: 0.0521, input: 20400, output: 1300 } }),
  });
  assert.equal(done.provider, 'claude');
  assert.match(usedLine(done, caps), /\$0\.0521 of its \$0\.6 cap/, 'what the review that ran actually used');
  assert.match(usedLine(done, caps), /4 turns/);
  assert.match(usedLine(done, caps), /21,700 tokens \(20,400 in, 1,300 out\)/);

  // A reviewer that reports nothing about its usage adds no line rather than a guess.
  assert.equal(usedLine({ provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', usage: null }, caps), '');
});

test('a review is priced per model, so a cheap one can run on a nearly empty window', () => {
  const caps = capsFor(config);
  const cost = (provider, model) => reviewCost({ provider, model }, caps);
  const session = (usedPercent) => ({ windows: [{ kind: 'session', usedPercent }] });

  assert.equal(cost('codex', 'gpt-6.1-sol'), 7);
  assert.equal(cost('codex', 'gpt-6.1-terra'), 3);
  assert.equal(cost('opencode', 'opencode-go/deepseek-v4.1-flash'), 0.1);
  assert.equal(cost('claude', 'claude-opus-5-5'), reviewCostPercent,
    'Claude reports no quota, so it keeps the cautious 10% and the old three-review floor');

  // 80% of the session used leaves 20%: enough for terra (3% a review) and not for sol (7% a review).
  assert.match(usageProblem(session(80), Date.now(), cost('codex', 'gpt-6.1-sol')), /fewer than 3 reviews left/);
  assert.equal(usageProblem(session(80), Date.now(), cost('codex', 'gpt-6.1-terra')), null);
  // Near-empty: only the cheapest reviewer is left, and it is still allowed to run.
  assert.match(usageProblem(session(99.5), Date.now(), cost('codex', 'gpt-6.1-sol')), /fewer than 3 reviews left/);
  assert.equal(usageProblem(session(99.5), Date.now(), cost('opencode', 'opencode-go/deepseek-v4.1-flash')), null);

  // And selection uses those numbers: on 20% left the heavy Codex model is skipped by name, deepseek is kept.
  const models = [
    { provider: 'codex', model: 'gpt-6.1-sol' },
    { provider: 'codex', model: 'gpt-6.1-terra' },
    { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
  ];
  const { candidates, skipped } = reviewerCandidates(models, {
    usageByProvider: { codex: session(80), opencode: session(80) },
    caps,
  });
  assert.deepEqual(candidates.map((m) => m.model), ['gpt-6.1-terra', 'opencode-go/deepseek-v4.1-flash']);
  assert.match(skipped[0].reason, /fewer than 3 reviews left in its session window/);
  // Without the config's numbers nothing changes: the old 10% floor still applies.
  assert.match(usageProblem(session(80), Date.now(), reviewCost({ provider: 'codex', model: 'gpt-6.1-sol' })),
    /fewer than 3 reviews left/);
});

test('what a review used is read from the output the CLI actually prints', () => {
  // Captured from codex-cli 0.167.0 (`codex exec --json`) on 15 Nov 2026: one agent_message item and a turn.completed
  // line carrying the tokens. Anything that is not JSON on stdout is noise and is skipped.
  const codexStream = [
    '2026-11-15T04:28:50.069465Z ERROR codex_models_manager::manager: failed to refresh available models',
    '{"type":"thread.started","thread_id":"01a1dd76"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"ignored config"}}',
    'not json at all',
    '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Looks right.\\nVerdict: approve"}}',
    '{"type":"turn.completed","usage":{"input_tokens":25351,"cached_input_tokens":0,"output_tokens":5}}',
  ].join('\n');
  const codex = parseCodexOutput(codexStream);
  assert.equal(codex.text, 'Looks right.\nVerdict: approve', 'the review is the agent message, not the event stream');
  assert.deepEqual(codex.usage, { input: 25351, output: 5, cached: 0 });

  // Claude 2.1.x with --output-format json: one result object with the review, the turns and the estimated dollars.
  const claude = parseClaudeOutput(JSON.stringify({
    type: 'result',
    result: 'Looks right.\nVerdict: approve',
    num_turns: 6,
    total_cost_usd: 0.0431,
    usage: { input_tokens: 21400, output_tokens: 1200, cache_read_input_tokens: 9000 },
  }));
  assert.equal(claude.text, 'Looks right.\nVerdict: approve');
  assert.deepEqual(claude.usage, { turns: 6, costUsd: 0.0431, input: 21400, output: 1200, cached: 9000 });

  // An older CLI that answers in plain text is still a review, and claims no numbers rather than inventing them.
  assert.deepEqual(parseClaudeOutput('Verdict: approve'), { text: 'Verdict: approve', usage: null });
  assert.deepEqual(parseCodexOutput('Verdict: approve'), { text: 'Verdict: approve', usage: null });
  // A stream with events but no agent message falls back to the raw text, so a review is never dropped.
  assert.equal(parseCodexOutput('{"type":"turn.completed"}').text, '{"type":"turn.completed"}');
});

test('the freshest snapshot from any machine decides, and one older than half an hour is ignored', () => {
  const now = Date.parse('2026-11-15T04:40:00Z');
  const snapshot = (machine, minutesAgo, sessionLeft) => JSON.stringify({
    version: 1,
    machine,
    takenAt: new Date(now - minutesAgo * 60000).toISOString(),
    providers: [
      { provider: 'codex', instance: 'codex', windows: [
        { kind: 'session', leftPercent: sessionLeft, resetsAt: '2026-11-15T07:48:00Z' },
      ] },
    ],
  });
  const env = {
    USAGE_SNAPSHOT_MAC: snapshot('mac', 45, 90),
    USAGE_SNAPSHOT_VPS: snapshot('vps', 5, 5),
    USAGE_SNAPSHOT_OMARCHY: '{not json',
  };
  const fresh = freshestSnapshot(env, now);
  assert.equal(fresh.source, 'vps', 'the Mac has published, but its copy is too old to trust');
  assert.equal(fresh.ageMs, 5 * 60000);
  assert.equal(readSnapshots(env, now).length, 2, 'a broken snapshot is skipped, not fatal');

  // 5% left in a 5-hour window is fewer than three reviews for a 7%-a-review model, so it is skipped by name and the
  // fallback reviewer runs. The comment names the machine and the age, so nobody has to guess where the numbers came from.
  // 5% left in a 5-hour window is fewer than three reviews for a 7%-a-review model, so the named model is refused and
  // the refusal carries the window that empties it.
  const sol = { provider: 'codex', model: 'gpt-6.1-sol' };
  const refused = requestProblem(config, sol, { usage: snapshotUsage(fresh, sol), caps: capsFor(config), author: 'opencode', now });
  assert.match(refused.reason, /fewer than 3 reviews left in its session window/);

  // A model the snapshot has room for runs, and the comment cites the machine and the age it read.
  const result = runReviewer([{ provider: 'claude', model: 'claude-sonnet-5-5' }], 'prompt', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: () => null,
    caps: capsFor(config),
    snapshot: fresh,
    now,
    invoke: () => ({ status: 0, text: 'Looks right.\nVerdict: approve' }),
  });
  assert.equal(usageNote(result), '\nUsage: vps, 5 min old');

  // Nothing fresh: no snapshot at all, so the local hub decides exactly as before.
  assert.equal(freshestSnapshot({ USAGE_SNAPSHOT_MAC: snapshot('mac', 31, 90) }, now), null);
  assert.equal(freshestSnapshot({}, now), null);
  assert.equal(usageNote({}), '', 'a review with no snapshot carries no line');

  // The freshest wins whatever order the variables come in.
  const both = { USAGE_SNAPSHOT_MAC: snapshot('mac', 29, 90), USAGE_SNAPSHOT_OMARCHY: snapshot('omarchy', 1, 90) };
  assert.equal(freshestSnapshot(both, now).source, 'omarchy');
  // A snapshot whose timestamp cannot be read is ignored rather than trusted.
  assert.equal(freshestSnapshot({ USAGE_SNAPSHOT_MAC: JSON.stringify({ machine: 'mac', providers: [] }) }, now), null);
});

test('a snapshot names the pool an OpenCode model really spends, and the hub fills in anything it lacks', () => {
  const now = Date.parse('2026-11-15T04:40:00Z');
  const snapshot = {
    source: 'mac',
    takenAt: now - 60000,
    ageMs: 60000,
    providers: [
      { provider: 'opencode', instance: 'opencode-go', windows: [
        { kind: 'weekly', leftPercent: 50, resetsAt: '2099-01-01T00:00:00Z' },
      ] },
    ],
  };
  const go = snapshotUsage(snapshot, { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' });
  assert.equal(go.windows[0].usedPercent, 50, 'what is left becomes what was used, the way the hub reports it');
  assert.equal(go.windows[0].windowDurationMins, 10080, 'a kind has a length, so the pace rule still works');
  // The Z.ai connector is a different pool: a snapshot with no entry for it leaves that model to the local hub.
  assert.equal(snapshotUsage(snapshot, { provider: 'opencode', model: 'zai-coding-plan/glm-5.3' }), undefined);

  // So a model the snapshot does not cover still runs when the hub is healthy, while one the snapshot says is empty is skipped.
  const models = [
    { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
    { provider: 'opencode', model: 'zai-coding-plan/glm-5.3' },
  ];
  const emptyGoSnapshot = {
    source: 'mac',
    takenAt: now - 60000,
    ageMs: 60000,
    providers: [
      { provider: 'opencode', instance: 'opencode-go', windows: [
        { kind: 'weekly', leftPercent: 0, resetsAt: '2099-01-01T00:00:00Z' },
      ] },
    ],
  };
  const { candidates, skipped } = reviewerCandidates(models, {
    usageByModel: { 'opencode/opencode-go/deepseek-v4.1-flash': snapshotUsage(emptyGoSnapshot, models[0]) },
    usageByProvider: { opencode: { windows: [{ kind: 'session', usedPercent: 10 }] } },
    caps: capsFor(config),
    now,
  });
  assert.deepEqual(candidates.map((model) => model.model), ['zai-coding-plan/glm-5.3'],
    'the connector the snapshot does not name is judged by the healthy hub, not by its empty sibling');
  assert.match(skipped[0].reason, /no usage left in its weekly window/);
  assert.equal(skipped[0].model, 'opencode-go/deepseek-v4.1-flash');

  // An exhausted local reading still wins even if the snapshot says that connector has quota left.
  const blockedByHub = reviewerCandidates(models, {
    usageByModel: { 'opencode/opencode-go/deepseek-v4.1-flash': snapshotUsage(snapshot, models[0]) },
    usageByProvider: { opencode: { windows: [{ kind: 'session', usedPercent: 100 }] } },
    caps: capsFor(config),
    now,
  });
  assert.deepEqual(blockedByHub.candidates, [], 'an exhausted local reading always wins');
  assert.equal(blockedByHub.skipped.length, 2);
});

test('reader validates the allowlist schema and drops anything outside it', () => {
  const now = Date.parse('2026-11-15T04:40:00Z');
  const takenAt = new Date(now - 60000).toISOString();

  // Unknown top-level, provider, window, and pace fields are stripped; invalid providers (including any provider with
  // even one invalid window) are dropped completely.
  const mixed = JSON.stringify({
    version: 1,
    machine: 'mac',
    takenAt,
    extraTop: 'alice@example.com',
    providers: [
      null,
      'not-an-object',
      { provider: 'devin', instance: 'devin', windows: [{ kind: 'session', leftPercent: 90 }] },
      { provider: 'opencode', instance: 'alice@example.com', windows: [{ kind: 'session', leftPercent: 90 }] },
      {
        provider: 'codex',
        instance: 'codex',
        label: 'acct-alice',
        windows: [
          null,
          { kind: 'custom', leftPercent: 50 },
          { kind: 'session', leftPercent: 105 },
          { kind: 'session', leftPercent: -5 },
          { kind: 'session', leftPercent: '80' },
          { kind: 'session', leftPercent: 40, resetsAt: 'alice@example.com' },
          { kind: 'session', leftPercent: 70, resetsAt: '2026-11-15T07:48:00Z' },
        ],
      },
      {
        provider: 'claude',
        instance: 'claudeAgent',
        label: 'acct-alice',
        windows: [
          {
            kind: 'session',
            leftPercent: 70,
            resetsAt: '2026-11-15T07:48:00Z',
            label: 'Plan Pro',
            pace: { deltaPp: 12.5, runsOutInMins: 60, note: 'secret' },
          },
        ],
      },
    ],
  });
  const parsed = parseSnapshot('USAGE_SNAPSHOT_MAC', mixed, now);
  assert.ok(parsed);
  assert.equal(parsed.source, 'mac');
  assert.equal(parsed.providers.length, 1, 'codex with invalid windows is dropped; valid claude survives');
  assert.deepEqual(parsed.providers[0], {
    provider: 'claude',
    instance: 'claudeAgent',
    windows: [
      {
        kind: 'session',
        leftPercent: 70,
        resetsAt: '2026-11-15T07:48:00.000Z',
        pace: { deltaPp: 12.5, runsOutInMins: 60 },
      },
    ],
  });
  assert.ok(!JSON.stringify(parsed).includes('alice'), 'free text never survives into parsed snapshot');
  assert.ok(!JSON.stringify(parsed).includes('Plan Pro'), 'labels never survive');
  assert.ok(!JSON.stringify(parsed).includes('secret'), 'extra pace fields never survive');

  // Invalid machine, version, or takenAt causes the whole snapshot to be rejected.
  const validProviders = [{ provider: 'codex', instance: 'codex', windows: [{ kind: 'session', leftPercent: 80 }] }];
  assert.equal(parseSnapshot('USAGE_SNAPSHOT_MAC', JSON.stringify({ version: 1, machine: 'laptop', takenAt, providers: validProviders }), now), null);
  assert.equal(parseSnapshot('USAGE_SNAPSHOT_MAC', JSON.stringify({ version: 1, takenAt, providers: validProviders }), now), null, 'missing machine is not guessed from variable name');
  assert.equal(parseSnapshot('USAGE_SNAPSHOT_MAC', JSON.stringify({ version: 2, machine: 'mac', takenAt, providers: validProviders }), now), null);
  assert.equal(parseSnapshot('USAGE_SNAPSHOT_MAC', JSON.stringify({ version: 1, machine: 'mac', takenAt: '2026-02-30T00:00:00Z', providers: validProviders }), now), null);
});

test('one bad window plus one good window ignores the snapshot for that provider and falls back to local usage', () => {
  const now = Date.parse('2026-11-15T04:40:00Z');
  const takenAt = new Date(now - 60000).toISOString();
  const codexModel = { provider: 'codex', model: 'gpt-6.1-sol' };
  const claudeModel = { provider: 'claude', model: 'claude-sonnet-5-5' };

  // Mixed good + bad windows on Codex alongside a valid Claude entry: Codex fails closed while Claude stays usable.
  const mixedRaw = JSON.stringify({
    version: 1,
    machine: 'mac',
    takenAt,
    providers: [
      {
        provider: 'codex',
        instance: 'codex',
        windows: [
          { kind: 'session', leftPercent: 100, resetsAt: '2099-01-01T00:00:00Z' },
          { kind: 'weekly', leftPercent: 'broken' },
        ],
      },
      {
        provider: 'claude',
        instance: 'claudeAgent',
        windows: [{ kind: 'session', leftPercent: 80 }],
      },
    ],
  });
  const parsed = parseSnapshot('USAGE_SNAPSHOT_MAC', mixedRaw, now);
  assert.ok(parsed);
  assert.equal(snapshotUsage(parsed, codexModel), undefined, 'codex snapshot is rejected because one window is invalid');
  assert.equal(snapshotUsage(parsed, claudeModel)?.windows[0].usedPercent, 20, 'other valid providers still work');

  // If the only provider in the snapshot has one good and one bad window, the whole snapshot is ignored and
  // selection falls back to the local hub reading (here, weekly exhausted).
  const codexOnlyPartial = {
    source: 'mac',
    takenAt: now - 60000,
    ageMs: 60000,
    providers: [
      {
        provider: 'codex',
        instance: 'codex',
        windows: [
          { kind: 'session', leftPercent: 100, resetsAt: '2099-01-01T00:00:00Z' },
          { kind: 'weekly', leftPercent: 'broken' },
        ],
      },
    ],
  };
  assert.equal(parseSnapshot('USAGE_SNAPSHOT_MAC', JSON.stringify({ version: 1, machine: 'mac', takenAt, providers: codexOnlyPartial.providers }), now), null);
  assert.equal(snapshotUsage(codexOnlyPartial, codexModel), undefined);

  // The local hub's exhausted weekly window refuses the named model, and the partially malformed snapshot is never cited.
  const refused = requestProblem(config, codexModel, {
    usage: { windows: [{ kind: 'weekly', usedPercent: 100 }] },
    snapshot: codexOnlyPartial,
    author: 'opencode',
    now,
  });
  assert.match(refused.reason, /no usage left in its weekly window/);
  assert.equal(usageNote({ snapshot: null }), '', 'partially malformed snapshot is not cited');

  // Without a local reading, a partial malformed snapshot (e.g. 0% left good window + broken window) is still ignored.
  const emptyGoodPlusBad = {
    source: 'mac',
    takenAt: now - 60000,
    ageMs: 60000,
    providers: [
      {
        provider: 'codex',
        instance: 'codex',
        windows: [
          { kind: 'session', leftPercent: 0 },
          { kind: 'weekly', leftPercent: 'broken' },
        ],
      },
    ],
  };
  const noLocalCalls = [];
  runReviewer([codexModel], 'prompt', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: () => null,
    caps: capsFor(config),
    snapshot: emptyGoodPlusBad,
    now,
    invoke: (provider) => {
      noLocalCalls.push(provider);
      return { status: 0, text: 'Looks right.\nVerdict: approve' };
    },
  });
  assert.deepEqual(noLocalCalls, ['codex'], 'with no local reading, a bad+good snapshot falls back to today behaviour');
});

// What happens to one named model: it runs, or it is refused with a reason a comment can carry. The job has no third
// option, so every test below reads it this way.
const outcome = (model, deps = {}) => {
  try {
    const result = runReviewer([model], 'prompt', '/w', {
      usageFor: () => undefined,
      commandAvailable: () => true,
      sandbox: () => null,
      caps: capsFor(config),
      invoke: () => ({ status: 0, text: 'Looks right.\nVerdict: approve' }),
      ...deps,
    });
    return { ran: true, result };
  } catch (error) {
    return { ran: false, reason: error.refusal?.reason || error.message };
  }
};

test('a snapshot can never loosen a limit and an exhausted local reading always wins', () => {
  const now = Date.parse('2026-11-15T04:40:00Z');
  const codexModel = { provider: 'codex', model: 'gpt-6.1-sol' };
  const healthySnapshot = (windows) => ({
    source: 'mac',
    takenAt: now - 60000,
    ageMs: 60000,
    providers: [{ provider: 'codex', instance: 'codex', windows }],
  });
  const healthy = healthySnapshot([{ kind: 'session', leftPercent: 100, resetsAt: '2099-01-01T00:00:00Z' }]);

  // The local hub says the session is gone while the snapshot says it is full: the tighter reading wins.
  const sameKind = outcome(codexModel, {
    usageFor: () => ({ windows: [{ kind: 'session', usedPercent: 100 }] }),
    snapshot: healthy,
    now,
  });
  assert.equal(sameKind.ran, false);
  assert.match(sameKind.reason, /no usage left in its session window/);

  // The same, with the exhausted window on a different kind from the snapshot's: still refused.
  const diffKind = outcome(codexModel, {
    usageFor: () => ({ windows: [{ kind: 'weekly', usedPercent: 100 }] }),
    snapshot: healthy,
    now,
  });
  assert.equal(diffKind.ran, false);
  assert.match(diffKind.reason, /no usage left in its weekly window/);

  // A healthy local reading and an exhausted snapshot is refused too: a snapshot in use is never a way past a limit.
  const snapshotOnly = outcome(codexModel, {
    usageFor: () => undefined,
    snapshot: healthySnapshot([{ kind: 'session', leftPercent: 0, resetsAt: '2026-11-15T09:00:00Z' }]),
    now,
  });
  assert.equal(snapshotOnly.ran, false);
  assert.match(snapshotOnly.reason, /no usage left in its session window/);
});

test('malformed or empty snapshot data never crashes a check and falls back to the local hub', () => {
  const now = Date.parse('2026-11-15T04:40:00Z');
  const codexModel = { provider: 'codex', model: 'gpt-6.1-sol' };
  // Nothing in these snapshots is usable, so each one is dropped and the local reading decides.
  for (const badProviders of [
    [null],
    [{ provider: 'codex', instance: 'codex', windows: [] }],
    [{ provider: 'codex', instance: 'codex', windows: [{ kind: 'session', leftPercent: 'bad' }] }],
  ]) {
    assert.equal(snapshotUsage({ providers: badProviders }, codexModel), undefined);
    const refused = outcome(codexModel, {
      usageFor: () => ({ windows: [{ kind: 'session', usedPercent: 100 }] }),
      snapshot: { source: 'mac', takenAt: now - 60000, ageMs: 60000, providers: badProviders },
      now,
    });
    assert.equal(refused.ran, false, 'an exhausted local hub still refuses');
    assert.match(refused.reason, /no usage left in its session window/);
  }

  // With no local reading and an unusable snapshot, the model is usable: no numbers counts as usable, as before.
  const unknown = outcome(codexModel, {
    usageFor: () => undefined,
    snapshot: { source: 'mac', takenAt: now - 60000, ageMs: 60000, providers: [null] },
    now,
  });
  assert.equal(unknown.ran, true);
  assert.equal(usageNote(unknown.result), '', 'invalid snapshot is not cited in the comment');

  // The rules themselves tolerate malformed windows instead of throwing.
  assert.equal(usageProblem({ windows: [null, { usedPercent: Number.NaN }] }, now), null);
  assert.equal(reserveProblem({ windows: [null] }, { session: 10 }, now), null);
});

test('an unknown flag or variant tries the next reviewer instead of failing the review', () => {
  assert.ok(retries({ status: 1, stderr: 'error: unknown option --variant' }));
  assert.ok(retries({ status: 2, stderr: "unexpected argument '--variant' found" }));
  assert.ok(retries({ status: 1, stderr: 'invalid variant: high' }));
  assert.ok(retries({ status: 1, stderr: 'Rate limit reached for this model' }));
  assert.ok(!retries({ status: 1, stderr: 'model not found: gpt-9' }));
  assert.ok(!retries({ status: 0, stdout: 'Verdict: approve' }));
});

test('a real failure is not mistaken for a bad flag, and a refusal is never silent', () => {
  // stdout carries the review text: a crash message quoted there is not the CLI complaining about our flags
  assert.ok(!retries({ status: 1, stdout: 'the author writes: invalid variant: high', stderr: '' }));
  // a Node spawn error (EINVAL) used to match "invalid argument" and quietly skip a reviewer
  assert.ok(!retries({ status: 1, stderr: 'Error: spawn EINVAL: invalid argument' }));
  assert.equal(skipReason({ status: 1, stderr: 'model not found: gpt-9' }), null, 'a typo in the config stays loud');
  assert.equal(skipReason({ status: 1, stderr: '' }), null, 'an empty failure is a real failure');

  // checked on OpenCode 2.2.6: an effort the model does not have is refused with this wording
  assert.ok(retries({ status: 1, stderr: 'Error: Variant unavailable for opencode-go/glm-5.3: medium' }));
  assert.equal(skipReason({ status: 1, stderr: 'Error: Variant unavailable for opencode-go/glm-5.3: medium' }),
    'rejected a flag');
  assert.equal(skipReason({ status: 1, stderr: 'Rate limit reached for this model' }), 'usage limit');

  // A cap we set is a skip, not a failure: the review moves to the next reviewer and the comment says why.
  assert.equal(skipReason({ status: 1, stderr: 'Error: Exceeded USD budget (0.6)' }), 'hit its cap');
  assert.equal(skipReason({ status: 1, stderr: 'Claude Code hit the maximum number of turns' }), 'hit its cap');
  assert.equal(skipReason({ status: 1, stderr: 'error_max_turns: the review ran out of turns' }), 'hit its cap');
  assert.equal(skipReason({ status: 1, stderr: 'model not found: gpt-9' }), null, 'a typo in the config stays loud');

  // A Claude result that is really an error carries no review, so it is never posted as one.
  const capped = parseClaudeOutput(JSON.stringify({
    type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 12,
    result: 'Claude Code hit the maximum number of turns', total_cost_usd: 0.21, usage: { input_tokens: 90000, output_tokens: 4000 },
  }));
  assert.equal(capped.text, '', 'the complaint is not the review');
  assert.match(capped.errorText, /error_max_turns/);
  assert.equal(capped.usage.turns, 12);

  // A refusal is the only way a review that did not happen is reported, and it is always a comment with the reason.
  const refusedBody = refusalComment({ reason: 'codex/gpt-6.1-sol hit its cap', provider: 'codex', model: 'gpt-6.1-sol' });
  assert.ok(refusedBody.startsWith('<!-- tess-review-bot -->'));
  assert.match(refusedBody, /hit its cap/);
  const source = readFileSync(new URL('./agent-review.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/postRefusal\(/g) || []).length >= 4, true, 'pick and review both announce a refusal');
});


test('the effort a tag asks for rides the way the provider accepts it', () => {
  // OpenCode 2.2.6: `--model provider/model#variant`, and the variant list comes from the model (glm-5.3 and
  // deepseek-v4.1-flash take low, high and max; kimi-k3 takes only max), so an untested variant is refused, not ignored.
  assert.deepEqual(cliArgs('opencode', 'opencode-go/deepseek-v4.1-flash', 'high').slice(3),
    ['--model', 'opencode-go/deepseek-v4.1-flash#high', '--archived']);
  assert.deepEqual(cliArgs('opencode', 'opencode-go/deepseek-v4.1-flash'),
    ['run', '--agent', 'tess-reviewer', '--model', 'opencode-go/deepseek-v4.1-flash', '--archived'],
    'no effort means no variant, rather than a #undefined');
});

test('OpenCode refuses to run unless the installed agent matches the repo copy', () => {
  const dir = temp();
  try {
    const installed = join(dir, 'tess-reviewer.md');
    assert.throws(() => assertReviewerAgent(installed, agentFile), /missing/);
    writeFileSync(installed, `${agentText}\n   - action: shell\n     resource: "*"\n     effect: allow\n`);
    assert.throws(() => assertReviewerAgent(installed, agentFile), /differs/);
    writeFileSync(installed, agentText);
    assert.doesNotThrow(() => assertReviewerAgent(installed, agentFile));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the OpenCode agent denies everything outside reading the copy', () => {
  const rules = [...agentText.matchAll(/- action: "?([^"\n]+?)"?\s*\n\s*resource: "?([^"\n]*?)"?\s*\n\s*effect: (\w+)/g)]
    .map(([, action, resource, effect]) => ({ action, resource, effect }));
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' }, 'the first rule denies everything');
  assert.ok(!rules.some((rule) => rule.effect === 'allow' && ['edit', 'shell', 'write', 'patch'].includes(rule.action)),
    'nothing may write or run');
  assert.ok(rules.some((rule) => rule.action === 'external_directory' && rule.resource === '*' && rule.effect === 'deny'),
    'reads outside the copy are blocked before the read rule');
  assert.ok(rules.some((rule) => rule.action === 'read' && rule.resource === '/*' && rule.effect === 'deny'),
    'an outside path again, in case the external_directory rule is ever weakened');
});

// Every reviewer is wrapped the same way, so the boundary is a fact about the runner, not a promise in a prompt. The
// snapshot is the only folder from the job that is bound in; the runner's home is not, apart from the one config folder
// the provider itself needs.
// The review proxy, driven for real: the child process starts, the sandbox's token is what it accepts, the provider's key
// is what it adds, and nothing else gets through. A fake upstream stands in for the provider, so this runs with no key and
// no network.
const httpRequest = (url, options = {}) => new Promise((resolve, reject) => {
  const client = url.startsWith('https:') ? https : http;
  const req = client.request(url, options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  if (options.body) req.write(options.body);
  req.end();
});

async function fakeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((done) => server.close(done)) };
}

test('the review proxy adds the key and refuses everything that is not this review', async () => {
  const upstream = await fakeUpstream();
  const proxy = await createReviewProxy({ provider: 'claude', key: 'sk-ant-oat01-real', token: 'this-review', upstream: upstream.url });
  try {
    // The call the CLI would make: the token stands in the Authorization header, the path keeps its provider prefix.
    const ok = await httpRequest(`${proxy.url}/claude/v1/messages`, {
      method: 'POST', headers: { authorization: 'Bearer this-review', 'content-type': 'application/json' }, body: '{"a":1}',
    });
    assert.equal(ok.status, 200);
    assert.equal(upstream.seen.length, 1, 'the request reached the upstream');
    assert.equal(upstream.seen[0].url, '/v1/messages', 'the provider prefix is stripped, the path is not rewritten');
    assert.equal(upstream.seen[0].headers.authorization, 'Bearer sk-ant-oat01-real', 'the real key is added here');
    assert.equal(upstream.seen[0].body, '{"a":1}', 'the body is passed through untouched');

    // No token, another review's token, and a route outside the provider all stop before the upstream sees anything.
    for (const attempt of [
      { url: `${proxy.url}/claude/v1/messages`, headers: {} },
      { url: `${proxy.url}/claude/v1/messages`, headers: { authorization: 'Bearer someone-else' } },
      { url: `${proxy.url}/openai/v1/responses`, headers: { authorization: 'Bearer this-review' } },
    ]) {
      const refused = await httpRequest(attempt.url, { headers: attempt.headers });
      assert.ok(refused.status === 401 || refused.status === 403, `${attempt.url} → ${refused.status}`);
      assert.ok(!refused.body.includes('sk-ant-oat01-real'), 'a refusal never quotes the key');
    }
    assert.equal(upstream.seen.length, 1, 'a refused call never reaches the provider');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// A raw socket, because a test has to be able to write a request line Node's own client would rewrite or never send: an
// absolute-form URL, a CONNECT, a fragment, a dot segment, an encoded slash.
const rawRequest = (port, requestLine, extraHeaders = '') => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\n${extraHeaders}Connection: close\r\n\r\n`);
  });
  let data = '';
  socket.setTimeout(5000, () => { socket.destroy(); resolve({ status: 0, body: data }); });
  socket.on('data', (chunk) => { data += chunk; });
  socket.on('end', () => {
    const status = Number((data.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);
    resolve({ status, body: data });
  });
  socket.on('error', reject);
});

// The route list is not a guess: it is what the pinned CLIs were seen to send, measured against a logging upstream.
test('the proxy allows only the requests the pinned CLIs were measured to make', () => {
  assert.deepEqual(proxyRoutes.claude, [{ method: 'POST', path: '/v1/messages', query: ['beta'] }]);
  // On the ChatGPT plan the CLI appends `/responses` to the base URL it is given, and the proxy sends that to
  // chatgpt.com/backend-api/codex/responses: the plan backend, not the API. Verified against the real backend.
  assert.deepEqual(proxyRoutes.codex, [{ method: 'POST', path: '/responses', query: [] }]);
  assert.equal(proxyProviders.codex.upstream, 'https://chatgpt.com/backend-api/codex');
  assert.equal(proxyProviders.codex.accountHeader, 'chatgpt-account-id');
  assert.equal(maxProxyBodyBytes, 10 * 1024 * 1024, 'a review body is capped at 10 MB');
});

// Codex on the ChatGPT plan: the proxy carries the access token and the account id, and nothing else of the login.
test('a Codex plan review reaches the plan backend with the account id, and no other route', async () => {
  const upstream = await fakeUpstream();
  const proxy = await createReviewProxy({
    provider: 'codex', key: 'chatgpt-access-token', token: 'this-review', upstream: upstream.url, accountId: 'acct-123',
  });
  try {
    const answer = await httpRequest(`${proxy.url}/codex/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer this-review',
        'chatgpt-account-id': 'a-different-account',
        'content-type': 'application/json',
      },
      body: '{"model":"gpt-6.1-sol"}',
    });
    assert.equal(answer.status, 200);
    assert.equal(upstream.seen[0].url, '/responses', 'the plan backend path, not the API');
    assert.equal(upstream.seen[0].headers.authorization, 'Bearer chatgpt-access-token', 'the real access token is added here');
    assert.equal(upstream.seen[0].headers['chatgpt-account-id'], 'acct-123', 'the account id comes from the login, not the client');
    assert.equal(upstream.seen[0].headers.originator, 'codex_cli_rs', 'the backend wants an originator');
    // Everything else the login could do - list files, delete a response, the account route - is refused.
    for (const url of [`${proxy.url}/codex/responses/delete`, `${proxy.url}/codex/files`, `${proxy.url}/codex/wham/accounts/check`]) {
      const refused = await httpRequest(url, { method: 'POST', headers: { authorization: 'Bearer this-review' }, body: '{}' });
      assert.equal(refused.status, 403, url);
    }
    assert.equal(upstream.seen.length, 1, 'no refused call reached the backend');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// The reviewer's token is a way to make one inference call, not a way to use everything the provider's key can reach.
// The loopback proxy forwards the real key to the routes above and refuses the rest with a 403, without forwarding.
test('the review proxy forwards the injected key to inference routes and refuses every other request', async () => {
  const upstream = await fakeUpstream();
  const proxy = await createReviewProxy({ provider: 'claude', key: 'sk-ant-oat01-real', token: 'this-review', upstream: upstream.url });
  const port = Number(new URL(proxy.url).port);
  const auth = { authorization: 'Bearer this-review' };
  try {
    // What the CLI sends is what gets through: the path and the one query key it was seen to send, with the real key.
    const allowed = await httpRequest(`${proxy.url}/claude/v1/messages?beta=true`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"model":"x"}',
    });
    assert.equal(allowed.status, 200);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0].url, '/v1/messages?beta=true', 'the path and its query reach the provider unchanged');
    assert.equal(upstream.seen[0].headers.authorization, 'Bearer sk-ant-oat01-real', 'the real key is added here');

    // Another method, and another path, are refused: the DELETE the reviewer reproduced, a read, a management route.
    for (const attempt of [
      { method: 'DELETE', url: `${proxy.url}/claude/v1/files/file-123` },
      { method: 'DELETE', url: `${proxy.url}/claude/v1/messages` },
      { method: 'GET', url: `${proxy.url}/claude/v1/messages` },
      { method: 'GET', url: `${proxy.url}/claude/v1/models` },
      { method: 'POST', url: `${proxy.url}/claude/v1/files` },
      { method: 'POST', url: `${proxy.url}/claude/v1/messages/batches` },
      { method: 'POST', url: `${proxy.url}/claude/v1/messages/count_tokens` },
    ]) {
      const answer = await httpRequest(attempt.url, { method: attempt.method, headers: auth, body: '{"a":1}' });
      assert.equal(answer.status, 403, `${attempt.method} ${attempt.url} → ${answer.status}`);
      assert.ok(!answer.body.includes('sk-ant-oat01-real'), 'a refusal never quotes the key');
    }
    assert.equal(upstream.seen.length, 1, 'no refused call reached the provider');

    // Every way a request line can look like the allowed path without being it, written as raw bytes so the client
    // cannot tidy it up first.
    for (const line of [
      'POST /claude/v1/messages/../files/file-123 HTTP/1.1',
      'POST /claude/v1/../v1/files HTTP/1.1',
      'POST /claude/v1/messages/..%2ffiles HTTP/1.1',
      'POST /claude/v1/messages%2f..%2ffiles HTTP/1.1',
      'POST /claude/v1/%2e%2e/v1/files HTTP/1.1',
      'POST /claude//v1/messages HTTP/1.1',
      'POST /claude/v1/messages%00 HTTP/1.1',
      'POST /claude/v1/messages/ HTTP/1.1',
      'POST /claude/v1/MESSAGES HTTP/1.1',
      'POST /claude/v1/messages?beta=true&path=/v1/files HTTP/1.1',
      'POST /claude/v1/messages?/v1/files HTTP/1.1',
      'POST /claude/v1/messages#/v1/files HTTP/1.1',
      'POST http://127.0.0.1:9/claude/v1/messages HTTP/1.1',
      'CONNECT api.openai.com:443 HTTP/1.1',
    ]) {
      const answer = await rawRequest(port, line, 'Authorization: Bearer this-review\r\nContent-Length: 2\r\n\r\n');
      assert.equal(answer.status, 403, `${line} → ${answer.status}`);
    }
    assert.equal(upstream.seen.length, 1, 'a path trick or a tunnel never reached the provider');

    // A credential the request brings is dropped, and the host is the proxy's, never one from the request or its headers.
    const smuggled = await httpRequest(`${proxy.url}/claude/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'this-review', 'proxy-authorization': 'Bearer sk-attacker', host: 'api.openai.com' },
      body: '{}',
    });
    assert.equal(smuggled.status, 200);
    const seen = upstream.seen[upstream.seen.length - 1];
    assert.equal(seen.headers.authorization, 'Bearer sk-ant-oat01-real', 'the real key replaces whatever was offered');
    assert.equal(seen.headers['x-api-key'], undefined, 'a client-supplied key is dropped');
    assert.equal(seen.headers['proxy-authorization'], undefined, 'a client-supplied proxy credential is dropped');
    assert.notEqual(seen.headers.host, 'api.openai.com', 'the upstream host comes from the proxy, not the request');
    assert.ok(!JSON.stringify(seen.headers).includes('sk-attacker'), 'nothing the client offered as a key travels');

    // A body past the cap is refused before it is read.
    const huge = await httpRequest(`${proxy.url}/claude/v1/messages`, {
      method: 'POST', headers: { ...auth, 'content-length': String(maxProxyBodyBytes + 1) }, body: '{}',
    });
    assert.equal(huge.status, 413, 'an oversized request is refused');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('the sandbox is pointed at the proxy, and the proxy process serves it', async () => {  const upstream = await fakeUpstream();
  const dir = temp();
  // The real child process the review starts, with the real ready file: this is the path a review takes on the runner.
  const config = { provider: 'codex', key: 'sk-codex-real-key', token: 'codex-review-token', upstream: upstream.url };
  const configPath = join(dir, 'proxy.json');
  const readyPath = join(dir, 'proxy.url');
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./review-proxy.mjs', import.meta.url)),
    '--config', configPath, '--ready', readyPath], { stdio: 'ignore' });
  try {
    const started = Date.now();
    while (!existsSync(readyPath)) {
      await new Promise((done) => setTimeout(done, 25));
      assert.ok(Date.now() - started < 5000, 'the proxy reported its address');
    }
    const url = readFileSync(readyPath, 'utf8').trim();
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/, 'it listens on loopback only');

    // What the CLI is told: an endpoint on the proxy, and the token in place of the key. The key itself is nowhere.
    const settings = proxyReviewerConfig('codex', url, 'codex-review-token');
    assert.ok(!JSON.stringify(settings).includes('sk-codex-real-key'), 'the key is not in what the sandbox is given');
    assert.ok(settings.args.some((arg) => arg.includes(`base_url="http://127.0.0.1:`)));
    assert.ok(settings.args.some((arg) => arg === 'model_providers.tess_review_proxy.env_key="TESS_REVIEW_TOKEN"'));
    assert.deepEqual(settings.removedKeys, ['CODEX_AUTH_JSON', 'CODEX_API_KEY', 'OPENAI_API_KEY']);

    const answer = await httpRequest(`${url}/codex/responses`, {
      method: 'POST', headers: { authorization: 'Bearer codex-review-token' }, body: '{"model":"gpt-6.1-terra"}',
    });
    assert.equal(answer.status, 200);
    assert.equal(upstream.seen[0].url, '/responses');
    assert.equal(upstream.seen[0].headers.authorization, 'Bearer sk-codex-real-key');
  } finally {
    child.kill('SIGKILL');
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the review proxy is started only where a key actually has to be kept out, and the CLI is configured for it', () => {
  const env = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-real', CODEX_API_KEY: 'sk-codex-real', OPENCODE_API_KEY: 'oc' };
  const calls = [];
  const fakeSpawn = (command, args) => { calls.push({ command, args }); return { kill: () => {} }; };
  const dir = temp();
  try {
    // OpenCode keeps its own key: its agent file denies every read outside the copy, so there is nothing to proxy it to.
    assert.equal(startReviewProxy('opencode', { env, dir, spawnChild: fakeSpawn }), null);
    // No key, no proxy: a review with no credential fails where the direct one would work, and nothing is leaked either way.
    assert.equal(startReviewProxy('codex', { env: { PATH: '/bin' }, dir, spawnChild: fakeSpawn }), null);

    // With a key the child is started with the config path, and a proxy that never reports an address stops the review
    // instead of quietly running the CLI with the key in its environment.
    assert.throws(() => startReviewProxy('claude', {
      env, dir, spawnChild: fakeSpawn, timeoutMs: 0, sleep: () => {},
    }), /never sees its key in the sandbox/);
    assert.equal(calls.length, 1, 'the proxy process was started');

    // The argv each CLI gets: Claude through the gateway variables, Codex through `-c` provider overrides.
    const proxy = { url: 'http://127.0.0.1:1234', token: 'tok' };
    const claude = cliArgs('claude', 'claude-opus-5-5', '', '/w', capsFor(config), proxy);
    assert.ok(claude.includes('--tools') && claude.includes(claudeTools), 'the read-only tool list is unchanged');
    const codex = cliArgs('codex', 'gpt-6.1-terra', 'high', '/w', capsFor(config), proxy);
    assert.ok(codex.includes('model_providers.tess_review_proxy.base_url="http://127.0.0.1:1234/codex"'));
    assert.ok(codex.includes('model_provider="tess_review_proxy"'));
    assert.ok(!JSON.stringify(codex).includes('sk-codex-real'), 'the key is not on the command line');
    // Without a proxy the argv is exactly what it was, ten arguments shorter: the direct path still works where a proxy
    // does not apply, and it never grew a flag nobody tested.
    const direct = cliArgs('codex', 'gpt-6.1-terra', 'high', '/w', capsFor(config));
    assert.ok(!JSON.stringify(direct).includes('tess_review_proxy'));
    assert.ok(direct.includes('--skip-git-repo-check') && direct.includes('exec'));
    assert.equal(codex.length, direct.length + 10, 'five `-c key=value` pairs are the whole proxy change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every reviewer runs inside bubblewrap with only the copy and its own config', () => {
  const binds = (args) => args.flatMap((arg, index) =>
    ['--ro-bind', '--bind'].includes(arg) ? [{ mode: arg, from: args[index + 1], to: args[index + 2] }] : []);
  const work = '/scratch/tess-review-abc';
  const home = '/home/tess-runner';
  const options = { home, exists: () => true, commandPath: `${home}/.local/bin/codex`, nodePath: `${home}/.local/bin/node` };

  for (const provider of ['claude', 'codex', 'cursor', 'opencode']) {
    const sandbox = sandboxArgv(provider, work, ['--help'], options);
    assert.equal(sandbox.command, 'bwrap', `${provider} is run by bubblewrap, never bare`);
    for (const flag of ['--unshare-all', '--share-net', '--die-with-parent', '--new-session']) {
      assert.ok(sandbox.args.includes(flag), `${provider}: ${flag}`);
    }
    // read-only, and the working folder: a reviewer cannot write to the copy it is reviewing
    assert.ok(binds(sandbox.args).some((bind) => bind.mode === '--ro-bind' && bind.from === work && bind.to === work),
      `${provider}: the snapshot is bound read-only`);
    assert.equal(sandbox.args[sandbox.args.indexOf('--chdir') + 1], work, `${provider}: starts in the copy`);
    assert.equal(sandbox.args[sandbox.args.indexOf('--tmpfs') + 1], '/tmp', `${provider}: a throwaway /tmp`);
    assert.equal(sandbox.args[sandbox.args.indexOf(sandboxHome) - 1], '--tmpfs', `${provider}: a throwaway HOME`);
    assert.equal(sandbox.home, sandboxHome);
    // the binary is bound and started by its own path, because the job's PATH points at folders the sandbox does not have
    assert.ok(binds(sandbox.args).some((bind) => bind.from === `${home}/.local/bin`), `${provider}: the CLI is bound`);
    assert.equal(sandbox.args.at(-2), `${home}/.local/bin/codex`, `${provider}: the CLI is started by absolute path`);
    assert.ok(!sandbox.args.some((arg) => String(arg).includes('actions-runner')), `${provider}: the runner is not visible`);
    assert.ok(!sandbox.args.some((arg) => String(arg).includes('tess-signing')), `${provider}: the signing keys are not visible`);
  }

  // One provider's own config only, never another provider's. It is mounted *inside* the throwaway HOME, at the path
  // the CLI looks in, because HOME is what each CLI reads: a mount at the runner's real home is invisible to it.
  const inside = (bind) => bind.from.startsWith(`${home}/`) && bind.to === `${sandboxHome}/${bind.from.slice(home.length + 1)}`;
  const codex = sandboxArgv('codex', work, [], options);
  assert.ok(binds(codex.args).some((bind) => bind.from === `${home}/.codex` && inside(bind)),
    'codex finds its own sign-in state where it looks for it');
  assert.ok(!codex.args.some((arg) => arg.includes('.config/opencode')), 'codex does not see OpenCode files');
  const opencode = sandboxArgv('opencode', work, [], options);
  assert.ok(binds(opencode.args).some((bind) => bind.from === `${home}/.config/opencode` && inside(bind)),
    'opencode finds its agent file where it looks for it');
  assert.ok(binds(opencode.args).some((bind) => bind.from === `${home}/.local/share/opencode/auth.json` && inside(bind)),
    'and its sign-in, which sits in its data folder');
  assert.ok(!opencode.args.includes(`${home}/.codex`), 'opencode does not see Codex files');
  const claude = sandboxArgv('claude', work, [], options);
  assert.ok(!claude.args.some((arg) => arg.includes('.codex') || arg.includes('.config/opencode')),
    'Claude sees neither other provider');

  // Nothing of a provider's is mounted at its real path: every bind from the runner's home lands inside the throwaway
  // HOME, so the only paths a review can read are the copy and its own config. The CLI itself is the one exception.
  for (const provider of ['claude', 'codex', 'cursor', 'opencode']) {
    const argv = sandboxArgv(provider, work, [], options).args;
    const homeTmpfs = argv.findIndex((arg, index) => arg === '--tmpfs' && argv[index + 1] === sandboxHome);
    assert.ok(homeTmpfs >= 0, `${provider}: the throwaway home is a tmpfs`);
    for (const bind of binds(argv)) {
      // bwrap applies its arguments in order, so the tmpfs has to come first or it hides what was mounted into it
      if (bind.to.startsWith(`${sandboxHome}/`)) {
        assert.ok(argv.indexOf(bind.from) > homeTmpfs, `${provider}: ${bind.to} is mounted after the home it lives in`);
      }
      if (!bind.from.startsWith(`${home}/`) || bind.from === `${home}/.local/bin`) continue;
      assert.ok(bind.to.startsWith(`${sandboxHome}/`),
        `${provider}: ${bind.from} is mounted inside the throwaway home, not at ${bind.to}`);
    }
  }

  // nothing is started outside the sandbox: the old code called the provider's command directly
  const source = readFileSync(new URL('./agent-review.mjs', import.meta.url), 'utf8');
  assert.ok(!/spawnSync\(providerDetails\[/.test(source), 'the CLI is only ever started through bubblewrap');
});

test('a runner without user namespaces refuses every provider instead of running unsandboxed', () => {
  assert.match(sandboxProblem({ bwrapAvailable: false }), /bubblewrap is not installed/);
  assert.match(sandboxProblem({ bwrapAvailable: true, probe: 'bubblewrap cannot start a sandbox here' }),
    /cannot start a sandbox/);
  assert.equal(sandboxProblem({ bwrapAvailable: true, probe: null }), null);
});

test('a provider whose sandbox cannot start is refused, and nothing ever runs bare', () => {
  const calls = [];
  const refused = outcome({ provider: 'codex', model: 'gpt-6.1-terra' }, {
    usageFor: () => undefined,
    sandbox: () => 'bubblewrap is not installed (tools/runner-setup.md)',
    invoke: (provider, model) => { calls.push(`${provider}/${model}`); return { status: 0, stdout: 'fine' }; },
  });
  assert.deepEqual(calls, [], 'the unsandboxed provider never starts');
  assert.equal(refused.ran, false);
  assert.match(refused.reason, /bubblewrap is not installed/, 'the refusal names what is missing');
  // There is no path where a reviewer starts outside the sandbox and no path where another model steps in.
  assert.equal(sandboxProblem({ bwrapAvailable: false }), 'bubblewrap is not installed (tools/runner-setup.md)');
});

test('a requested reviewer that cannot run is refused by name, never replaced', () => {
  const named = { provider: 'codex', model: 'gpt-6.1-terra' };
  const exhausted = outcome(named, {
    usageFor: () => ({ windows: [{ kind: 'session', usedPercent: 100, resetsAt: '2099-01-01T00:00:00Z' }] }),
  });
  assert.equal(exhausted.ran, false, 'the default does not review in its place');
  assert.match(exhausted.reason, /no usage left in its session window/);

  const missing = outcome(named, { commandAvailable: (command) => command !== 'codex' });
  assert.equal(missing.ran, false);
  assert.match(missing.reason, /no local CLI/);

  // A refusal from the CLI itself is refused too, and it names the model that was asked for.
  const capped = outcome({ provider: 'claude', model: 'claude-opus-5-5' }, {
    invoke: () => ({ status: 1, stderr: 'Error: Exceeded USD budget (0.6)' }),
  });
  assert.equal(capped.ran, false);
  assert.match(capped.reason, /hit its cap/);
});

test('pace alone never blocks a review: the tagging agent weighs it, the job only enforces hard limits', () => {
  const now = Date.parse('2026-11-15T03:00:00Z');
  // Claude on the morning of 15 Nov: 84% of a week gone, 2.6 days to go. Session-only reading would have spent it dry.
  assert.equal(usageProblem({ windows: [
    { kind: 'session', usedPercent: 47, windowDurationMins: 300, resetsAt: '2026-11-15T07:50:00Z' },
    { kind: 'weekly', usedPercent: 84, windowDurationMins: 10080, resetsAt: '2026-11-17T18:00:00Z' },
  ] }, now), null);
  // the same provider just after its weekly reset is fine again
  assert.equal(usageProblem({ windows: [
    { kind: 'weekly', usedPercent: 0, windowDurationMins: 10080, resetsAt: '2026-11-22T18:00:00Z' },
  ] }, now), null);
  // comfortably ahead of the clock: 15% after two days of a week
  assert.equal(usageProblem({ windows: [
    { kind: 'weekly', usedPercent: 15, windowDurationMins: 10080, resetsAt: '2026-11-20T03:00:00Z' },
  ] }, now), null);
  // an exhausted window is out until it resets
  assert.match(usageProblem({ windows: [{ kind: 'weekly', usedPercent: 100, resetsAt: '2099-01-01T00:00:00Z' }] }),
    /no usage left in its weekly window/);
  assert.equal(usageProblem({ windows: [{ kind: 'weekly', usedPercent: 100, resetsAt: '2020-01-01T00:00:00Z' }] }), null);
  // the 5-hour window keeps about three reviews in hand
  assert.equal(reviewCostPercent * reviewsToKeep, 30);
  assert.match(usageProblem({ windows: [{ kind: 'session', usedPercent: 75 }] }), /fewer than 3 reviews left/);
  assert.equal(usageProblem({ windows: [{ kind: 'session', usedPercent: 70 }] }), null);
  // a hub with nothing to read is not a reason to refuse, and the CLI still reports a real limit
  assert.equal(usageProblem(undefined), null);
  assert.equal(usageProblem({ windows: [{ kind: 'weekly' }] }), null);
  assert.equal(providerHasUsage(undefined), true);
});

test('reserved quota holds a provider back until its date, and no block means none is kept', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const usage = (usedPercent) => ({ windows: [
    { kind: 'weekly', usedPercent, resetsAt: '2026-11-20T00:00:00Z' },
  ] });
  // 25% left, 30% reserved for the owner's own work
  assert.match(reserveProblem(usage(75), { weekly: 30, note: "Krish's own work", until: '2026-11-20' }, now),
    /reserved for Krish's own work \(30% of its weekly window is held back\)/);
  // above the reserved amount, and a provider with no block
  assert.equal(reserveProblem(usage(50), { weekly: 30 }, now), null);
  assert.equal(reserveProblem(usage(75), undefined, now), null);
  assert.equal(reserveProblem(usage(75), {}, now), null);
  // the date ends it automatically, on the day after
  assert.equal(reserveProblem(usage(75), { weekly: 30, until: '2026-11-10' }, now), null);
  assert.match(reserveProblem(usage(75), { weekly: 30, until: '2026-11-15' }, now), /reserved/,
    'a date keeps the reservation through that whole day');
  assert.match(reserveProblem(usage(75), { weekly: 30, until: '2026-11-16' }, now + 24 * 60 * 60 * 1000), /reserved/,
    'still held the day it runs to');
  assert.equal(reserveProblem(usage(75), { weekly: 30, until: '2026-11-16' }, now + 2 * 24 * 60 * 60 * 1000), null,
    'and free the next day');
  assert.equal(reservationEnd('nonsense'), null, 'a date we cannot read does not hold quota back forever');

  // and selection honours it, before pace and everything else
  const { candidates, skipped } = reviewerCandidates(config.approach, {
    usageByProvider: { claude: usage(75), codex: usage(10) },
    reserve: { claude: { weekly: 30, note: "Krish's own work" } },
    now,
  });
  const providers = candidates.map(({ provider }) => provider);
  assert.ok(!providers.includes('claude'), 'a reserved provider is not a candidate');
  assert.ok(providers.includes('codex'), 'the one with room still is');
  assert.ok(skipped.some(({ provider, reason }) => provider === 'claude' && /reserved for Krish's own work/.test(reason)),
    'and the reservation is named, not silent');
});

test('the config is the one place the changeable facts live', () => {
  for (const [provider, models] of Object.entries(config.allowed)) {
    for (const model of models) {
      assert.ok(['light', 'medium', 'heavy'].includes(config.cost?.[`${provider}/${model}`]),
        `${provider}/${model} has a cost weight in agents.json`);
    }
  }
  for (const role of ['approach', 'pr_normal', 'pr_sensitive']) {
    for (const { provider, model } of config[role]) {
      assert.ok(config.cost[`${provider}/${model}`], `${role}: ${model} is weighed`);
    }
  }
  // dated, temporary facts, not rules
  assert.ok(Array.isArray(config.notes) && config.notes.length, 'notes are a list');
  for (const note of config.notes) {
    assert.match(note.date, /^\d{4}-\d{2}-\d{2}$/, 'every note is dated');
    assert.ok(note.note && note.note.length > 20, 'every note says something');
  }
  // the docs point at the config, and the runner setup says what the sandbox needs
  const workflow = readFileSync(new URL('../docs/workflow.md', import.meta.url), 'utf8');
  assert.match(workflow, /How to update this/, 'there is a short guide for changing the choice');
  assert.match(workflow, /\.github\/agents\.json/, 'the guide points at the config');
  assert.match(workflow, /bubblewrap/, 'the docs say every reviewer runs inside bubblewrap');
  // the caps are in the config and in one table, so a reader can see what bounds a review without opening the code
  assert.match(workflow, /Every review has a hard cap/, 'the docs explain the caps');
  assert.match(workflow, /600 s wall clock/, 'the docs name the wall clock');
  assert.match(workflow, /Change what one review may spend/, 'and how to change a cap');
  // The two rules a reader must not have to guess: plans only, and the tagging agent chooses.
  assert.match(workflow, /Plans only\./, 'the docs say every reviewer runs on a plan');
  assert.match(workflow, /The agent decides; the job only checks and runs/, 'the docs say who chooses');
  assert.match(workflow, /Nothing is substituted/, 'and that a refusal never becomes another model');
  assert.equal((workflow.match(/default first|falls back to the defaults/g) || []).length, 0,
    'no leftover text about a fixed order or defaults');
  assert.match(workflow, /Antigravity/, 'the docs say why Antigravity is not a reviewer');
  const caps = capsFor(config);
  for (const [key, pct] of Object.entries(caps.per_review_pct)) {
    // A model kept only as the measured record of why it is out has no cost weight, but the config still names it.
    assert.ok(config.cost?.[key] || config.notes.some((note) => note.note.includes(key.split('/').at(-1))),
      `${key} with a per-review cost is a model the config knows`);
    assert.ok(typeof pct === 'number' && pct > 0, `${key} has a positive per-review cost`);
  }
  for (const [key, seconds] of Object.entries(caps.timeout_s_by_model)) {
    const [provider, ...rest] = key.split('/');
    assert.ok((config.allowed[provider] || []).includes(rest.join('/')), `${key} with its own timeout is allowed`);
    assert.ok(seconds > 0 && seconds <= caps.timeout_s, `${key} times out no later than the default`);
  }
  for (const model of config.allowed.claude) {
    assert.equal(typeof budgetUsd({ model }, caps), 'number', `${model} has a dollar cap`);
  }
  // a model nobody measured keeps the old cautious cost, so the cap can only tighten what already worked
  assert.equal(reviewCost({ provider: 'claude', model: 'claude-opus-5-5' }, caps), 10);
  const setup = readFileSync(new URL('./runner-setup.md', import.meta.url), 'utf8');
  assert.match(setup, /bubblewrap/, 'the runner setup asks for bubblewrap');
  assert.match(setup, /user namespaces/i, 'and shows how to check user namespaces');
  // Plans only, in every place a secret could be named: the config, the workflow and the setup page.
  const workflowFile = readFileSync(new URL('../.github/workflows/agent-review.yml', import.meta.url), 'utf8');
  assert.match(workflowFile, /CODEX_AUTH_JSON/);
  assert.match(setup, /CODEX_AUTH_JSON/);
  for (const retired of retiredKeyNames) {
    assert.ok(!workflowFile.includes(retired), `${retired} is not in the review workflow`);
  }
  // every allowed provider is a subscription the config names
  for (const provider of Object.keys(config.allowed)) {
    assert.ok(config.plans?.[provider], `${provider} has a plan`);
  }
});

test('the review runs exactly the reviewer whose CLI the job installed', () => {
  assert.deepEqual(pinnedReviewer(config, {
    REVIEW_PROVIDER: 'codex', REVIEW_MODEL: 'gpt-6.1-terra', REVIEW_EFFORT: 'high',
  }), { provider: 'codex', model: 'gpt-6.1-terra', effort: 'high' });
  assert.equal(pinnedReviewer(config, {}), null, 'no pin means the normal selection runs');
  assert.equal(pinnedReviewer(config, { REVIEW_PROVIDER: 'none' }), null, 'docs-only installs nothing');
  // The environment is still checked against the rules, not trusted.
  assert.throws(() => pinnedReviewer(config, { REVIEW_PROVIDER: 'codex', REVIEW_MODEL: 'gpt-9' }), /not in/);
  assert.throws(() => pinnedReviewer(config, { REVIEW_PROVIDER: 'nobody', REVIEW_MODEL: 'x' }), /not in/);
});

test('the pick step runs the model the tag named, and refuses anything the rules do not allow', () => {
  const dir = temp();
  const scriptPath = fileURLToPath(new URL('./agent-review.mjs', import.meta.url));
  const comments = join(dir, 'comments.log');
  // A fake `gh`: the pick step only reads the pull request and posts a refusal. Every posted comment lands in a file so
  // the test can read exactly what a maintainer would see.
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
if [ "$1" = "api" ]; then
  [ "$GH_API_FAIL" = "1" ] && exit 1
  printf '{"number":1,"title":"t","body":"%s","html_url":"https://example.invalid/1"}' "$GH_PR_BODY"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  cat >> "$GH_COMMENT_LOG"
  printf '\\n---\\n' >> "$GH_COMMENT_LOG"
  exit 0
fi
exit 99
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const run = (args, body, extra = {}) => execFileSync(process.execPath, [scriptPath, 'pick', ...args], {
    input: body,
    encoding: 'utf8',
    // An empty HOME keeps this machine's real usage hub out of the test.
    env: { ...process.env, HOME: dir, GITHUB_OUTPUT: '', PATH: `${dir}:${process.env.PATH}`, ...extra },
  }).trim();
  const refuse = (args, body, extra = {}) => {
    let error;
    try {
      run(args, body, extra);
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error, 'a refused tag stops the job');
    assert.equal(error.status, 1);
    return { output: `${error.stderr || ''}${error.stdout || ''}`, posted: existsSync(comments) ? readFileSync(comments, 'utf8') : '' };
  };
  const snapshot = (...entries) => JSON.stringify({
    version: 1,
    machine: 'mac',
    takenAt: new Date().toISOString(),
    providers: entries.map((entry) => (typeof entry === 'string'
      ? { provider: entry, instance: entry, windows: [{ kind: 'weekly', leftPercent: 0, resetsAt: '2099-01-01T00:00:00Z' }] }
      : entry)),
  });
  const withNumber = { REVIEW_NUMBER: '1', GITHUB_REPOSITORY: 'Flame119052/tess-music', GH_TOKEN: 'x', GH_COMMENT_LOG: comments };

  try {
    // The tag names the reviewer: that is the model the job installs and runs. Nothing else is consulted.
    assert.equal(run(['pr', 'normal'], '@tess-review pr provider=codex model=gpt-6.1-terra effort=high author=opencode'),
      'provider=codex\nmodel=gpt-6.1-terra\neffort=high\nskipped=[]');

    // No model named: refused with a comment that says what to write. The job does not choose.
    const unnamed = refuse(['pr', 'normal'], '@tess-review pr', withNumber);
    assert.match(unnamed.posted, /<!-- tess-review-bot -->/);
    assert.match(unnamed.posted, /Why: the tag names no reviewer/);
    assert.match(unnamed.posted, /does not substitute another model/);

    // A model that is not on the plans-only list is refused, not rerouted to a default.
    rmSync(comments, { force: true });
    const notAllowed = refuse(['pr', 'normal'], '@tess-review pr provider=cursor model=composer-2.5', withNumber);
    assert.match(notAllowed.posted, /plans-only list/);
    assert.ok(!/provider=codex/.test(notAllowed.output), 'no substitute was reported as the choice');

    // A sensitive change with a light model is refused, and the comment names what is strong enough.
    const weak = refuse(['pr', 'sensitive'], '@tess-review pr provider=claude model=claude-sonnet-5-5', withNumber);
    assert.match(weak.posted, /strong model/);
    assert.match(weak.posted, /zai-coding-plan\/glm-5\.3/);

    // The author's own provider is refused, read from the tag's attestation and checked against the PR's Made by line.
    const sameAuthor = refuse(['pr', 'normal'], '@tess-review pr provider=opencode model=opencode-go/deepseek-v4.1-flash author=opencode', {
      ...withNumber, GH_PR_BODY: 'Made by: DeepSeek V4.1 Flash in OpenCode',
    });
    assert.match(sameAuthor.posted, /same provider/);

    // This PR's own authorship shape — the template's `## Made by` heading and the sentence under it — is the case that
    // used to slip past an empty parse. It is refused now.
    const heading = refuse(['pr', 'normal'], '@tess-review pr provider=opencode model=opencode-go/deepseek-v4.1-flash author=opencode', {
      ...withNumber, GH_PR_BODY: '## Made by\\n\\nDeepSeek V4.1 Flash in OpenCode\\n\\n## Checklist\\n- [x] safety',
    });
    assert.match(heading.posted, /same provider/);

    // A tag that does not attest the author is refused even when the PR body reads perfectly: the body is text its own
    // author can edit, so it is never a permission.
    const unattested = refuse(['pr', 'normal'], '@tess-review pr provider=codex model=gpt-6.1-terra', {
      ...withNumber, GH_PR_BODY: 'Made by: DeepSeek V4.1 Flash in OpenCode',
    });
    assert.match(unattested.posted, /author=/);

    // A body that disagrees with the tag stops the review: one of the two is wrong, so neither is trusted.
    const disagree = refuse(['pr', 'normal'], '@tess-review pr provider=codex model=gpt-6.1-terra author=codex', {
      ...withNumber, GH_PR_BODY: 'Made by: DeepSeek V4.1 Flash in OpenCode',
    });
    assert.match(disagree.posted, /disagree/);

    // A GitHub read that fails leaves no body to check. That never relaxes the rule: the same-provider tag is still
    // refused, and a tag naming a different provider still runs.
    const fetchFailedSame = refuse(['pr', 'normal'], '@tess-review pr provider=opencode model=opencode-go/deepseek-v4.1-flash author=opencode', {
      ...withNumber, GH_API_FAIL: '1',
    });
    assert.match(fetchFailedSame.posted, /same provider/);
    assert.equal(run(['pr', 'normal'], '@tess-review pr provider=codex model=gpt-6.1-terra author=opencode', {
      ...withNumber, GH_API_FAIL: '1',
    }), 'provider=codex\nmodel=gpt-6.1-terra\neffort=\nskipped=[]');

    // A window with nothing left refuses, and the comment says when it resets.
    rmSync(comments, { force: true });
    const empty = refuse(['pr', 'normal'], '@tess-review pr provider=codex model=gpt-6.1-terra author=opencode', {
      ...withNumber, USAGE_SNAPSHOT_MAC: snapshot('codex'),
    });
    assert.match(empty.posted, /no usage left in its weekly window/);
    // A usage refusal reuses #100's no-room comment: it says when the window clears, in UTC and in plain time.
    assert.match(empty.posted, /No reviewer had room to run\./);
    assert.match(empty.posted, /Earliest window reset: 2099-01-01 00:00 UTC/);

    // A sensitive review on GLM-5.3 through the Z.ai plan is the case that used to be blocked by Claude and Codex
    // being short of room.
    const glm = run(['approach', 'sensitive'], '@tess-review approach provider=opencode model=zai-coding-plan/glm-5.3 effort=high author=codex', {
      ...withNumber, GH_PR_BODY: 'Made by: Codex gpt-6.1-terra',
    });
    assert.match(glm, /^provider=opencode\nmodel=zai-coding-plan\/glm-5\.3/);

    // Docs-only needs no CLI at all.
    assert.match(run(['pr', 'docs'], '@tess-review pr'), /^provider=none/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an npm-installed CLI starts: the packages it loads and its own Node are bound", () => {
  const dir = temp();
  try {
    // Codex's entry point is a launcher, and the binary it runs comes from a sibling platform package. Binding only the
    // package it sits in would leave the launcher unable to find its binary inside the sandbox.
    const nodeModules = join(dir, 'node_modules');
    const pkg = join(nodeModules, '@openai', 'codex');
    const native = join(nodeModules, '@openai', 'codex-linux-x64');
    const bin = join(pkg, 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(native, 'vendor', 'x86_64-unknown-linux-musl', 'bin'), { recursive: true });
    writeFileSync(join(bin, 'codex.js'), '#!/usr/bin/env node\n// entry point\n');
    writeFileSync(join(native, 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex'), 'x');
    const nodeDir = join(dir, 'node');
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, 'node'), 'x');

    const sandbox = sandboxArgv('codex', '/work', ['exec', '-'], {
      home: '/home/r', commandPath: join(bin, 'codex.js'), nodePath: join(nodeDir, 'node'),
    });
    const binds = sandbox.args.flatMap((arg, index) =>
      arg === '--ro-bind' ? [sandbox.args[index + 1]] : []);
    assert.ok(binds.includes(nodeModules), 'the install tree is bound, so the launcher finds its sibling package');
    assert.ok(!binds.includes(pkg) || binds.includes(nodeModules), 'the package sits inside that tree');
    assert.ok(binds.includes(nodeDir), "the CLI's own Node is bound, even outside /usr");
    assert.ok(sandbox.path.startsWith(`${nodeDir}:`), 'and that Node leads PATH, because the entry asks for `node`');
    assert.equal(sandbox.args.at(-3), join(bin, 'codex.js'), 'the entry point is still started by absolute path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate entries for one provider are merged, so an exhausted window in the second still counts', () => {
  const now = Date.parse('2026-11-15T04:40:00Z');
  const raw = JSON.stringify({
    version: 1,
    machine: 'mac',
    takenAt: '2026-11-15T04:39:00Z',
    providers: [
      { provider: 'codex', instance: 'codex', windows: [{ kind: 'session', leftPercent: 100, resetsAt: '2099-01-01T00:00:00Z' }] },
      { provider: 'codex', instance: 'codex', windows: [{ kind: 'session', leftPercent: 0, resetsAt: '2099-01-01T00:00:00Z' }] },
    ],
  });
  const snap = parseSnapshot('USAGE_SNAPSHOT_MAC', raw, now);
  assert.ok(snap, 'a snapshot with a duplicate provider still parses');
  assert.equal(snap.providers.length, 1);
  assert.equal(snap.providers[0].windows.length, 2);
  const called = [];
  runReviewer([{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude', model: 'claude-sonnet-5-5' }], 'prompt', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: () => null,
    caps: capsFor(config),
    snapshot: snap,
    now,
    invoke: (provider) => { called.push(provider); return { status: 0, text: 'Looks right.\nVerdict: approve' }; },
  });
  assert.deepEqual(called, ['claude']);
});

// The gate runs the rules from `tools/agent-gate.sh` with a fake `gh`, so the fork boundary is a tested fact rather than
// something a reader has to trust in YAML. `gh` answers a pull request with the JSON GitHub really sends and the gate
// reads it in Node: a `--jq` filter mocked at the shell is exactly how `fork: false` once became "not ours" while every
// test still passed.
const gateScript = fileURLToPath(new URL('./agent-gate.sh', import.meta.url));

function runGate({ answers = {}, env = {} } = {}) {
  const dir = temp();
  const out = join(dir, 'out');
  const log = join(dir, 'calls');
  const { issue = '', issueUrl = '', pull = '', ci = '', files = '' } = answers;
  try {
    writeFileSync(join(dir, 'gh'), `#!/bin/sh
printf '%s\\n' "$2" >> '${log}'
case "$2" in
  *"/issues/"*) if [ "$3" = "--jq" ]; then printf '%s' '${issueUrl}'; else printf '%s' '${issue}'; fi ;;
  # The two filters that remain in the gate (the file list and the CI conclusion) have no false/no-value trap in them;
  # the one that did has moved into the gate's own Node code, where a fake gh cannot hide it.
  *"/files") printf '%s' '${files}' ;;
  *"/pulls/"*) printf '%s' '${pull}' ;;
  *"/actions/"*) if [ "$3" = "--jq" ]; then printf '%s' '${ci}'; else printf '{"workflow_runs":[{"conclusion":"%s"}]}' '${ci}'; fi ;;
  *) exit 99 ;;
esac
exit 0
`);
    chmodSync(join(dir, 'gh'), 0o755);
    execFileSync('bash', [gateScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        REPOSITORY: 'Flame119052/tess-music',
        ISSUE_NUMBER: '7',
        AGENT_ALLOWLIST: ' Flame119052 , someone ',
        COMMENTER: 'Flame119052',
        COMMENT_BODY: '@tess-review pr',
        ...env,
      },
    });
    const text = readFileSync(out, 'utf8');
    const values = Object.fromEntries(text.trim().split('\n').map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    values.calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return values;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// GitHub's own answer for the head, not a pre-cut TSV: the gate parses it, so a `false` that jq would swallow is a
// `false` here too.
const prHead = (sha = 'abc123') => JSON.stringify({ head: { sha, repo: { full_name: 'Flame119052/tess-music', fork: false } } });
const prComment = {
  issue: '{"number":7,"pull_request":{"url":"https://api.github.com/repos/x/y/pulls/7"}}',
  issueUrl: 'https://api.github.com/repos/x/y/pulls/7',
};

test('a normal pull request of this repository is allowed, and only a fork is refused', () => {
  // The bug this covers: `(.head.repo.fork // true)` read a real `fork: false` as missing, so every ordinary PR was
  // refused and no review could ever run. A same-repository PR must pass on its own merits.
  const grown = runGate({ answers: { ...prComment, pull: prHead(), ci: 'success', files: 'theme/Tess/src/core.js\n' } });
  assert.equal(grown.allowed, 'true', 'a same-repository head with green CI is reviewed');
  assert.equal(grown.head_sha, 'abc123', 'the review reads the commit the gate checked');
  assert.ok(!/fork/i.test(grown.allowed), 'a non-fork is not held to the fork rule');
});

test('the gate lets an allowlisted tag through only for this repository\'s own green commit', () => {
  const allowed = runGate({ answers: { ...prComment, pull: prHead(), ci: 'success', files: 'theme/Tess/src/core.js\n' } });
  assert.deepEqual({ allowed: allowed.allowed, role: allowed.role, head_sha: allowed.head_sha, tier: allowed.tier },
    { allowed: 'true', role: 'pr', head_sha: 'abc123', tier: 'normal' });
  assert.equal(allowed.number, '7');

  // A docs-only PR still runs no CLI, but it is still a PR of this repository.
  assert.equal(runGate({ answers: { ...prComment, pull: prHead(), ci: 'success', files: 'docs/workflow.md\n' } }).tier, 'docs');

  // An approach review reads main, not a branch, so no pull request has to exist.
  const approach = runGate({ env: { COMMENT_BODY: '@tess-review approach' } });
  assert.deepEqual({ allowed: approach.allowed, role: approach.role, tier: approach.tier },
    { allowed: 'true', role: 'approach', tier: 'sensitive' });
  assert.equal(approach.calls, '', 'an approach review asks GitHub nothing about a pull request');
});

test('a fork head is refused at the gate, so its content never reaches the job holding a key', () => {
  // An allowlisted maintainer tagged a fork PR whose CI is green: the fork author still wrote the diff, so no review.
  const fork = runGate({
    answers: { ...prComment, ci: 'success', pull: JSON.stringify({ head: { sha: 'abc123', repo: { full_name: 'outside/tess-music', fork: true } } }) },
  });
  assert.equal(fork.allowed, 'false');
  assert.equal(fork.head_sha, '', 'a refused tag leaves no commit for the review job to pick up');

  // A deleted or missing head repository, no `fork` flag at all, a null flag, and a fork flag that says true all refuse:
  // the rule needs a positive `fork: false` from this repository, so an absent answer fails closed.
  const heads = [
    { head: { sha: 'abc123', repo: null } },
    { head: { sha: 'abc123' } },
    { head: { sha: 'abc123', repo: { full_name: 'Flame119052/tess-music' } } },
    { head: { sha: 'abc123', repo: { full_name: 'Flame119052/tess-music', fork: null } } },
    { head: { sha: 'abc123', repo: { full_name: 'Flame119052/tess-music', fork: true } } },
    { head: { sha: 'abc123', repo: { full_name: 'Flame119052/tess-music', fork: 'false' } } },
    { head: { repo: { full_name: 'Flame119052/tess-music', fork: false } } },
  ];
  for (const head of heads) {
    assert.equal(runGate({ answers: { ...prComment, pull: JSON.stringify(head), ci: 'success' } }).allowed, 'false',
      JSON.stringify(head));
  }

  // Everything else that used to refuse still refuses.
  assert.equal(runGate({ answers: { ...prComment, pull: prHead(), ci: 'failure' } }).allowed, 'false', 'red CI');
  assert.equal(runGate({ answers: { issue: '{"number":7}', issueUrl: '' } }).allowed, 'false', 'a plain issue is not a PR');
  assert.equal(runGate({ env: { COMMENTER: 'stranger' } }).allowed, 'false', 'the caller is not on the allowlist');
  const stranger = runGate({ env: { COMMENTER: 'stranger' } });
  assert.equal(stranger.calls, '', 'a stranger\'s comment reads nothing');
  assert.equal(runGate({ env: { COMMENT_BODY: '@tess-review pr\n<!-- tess-review-bot -->' } }).allowed, 'false',
    'the bot never re-triggers itself');
  assert.equal(runGate({ env: { COMMENT_BODY: 'lgtm' } }).allowed, 'false', 'no tag, no review');
});

test('the workflow gate runs the tested script instead of its own copy of the rules', () => {
  const gate = jobBlock('gate');
  assert.match(gate, /run: bash tools\/agent-gate\.sh/, 'the gate job runs the script the tests drive');
  assert.ok(!/gh api/.test(gate), 'the rules are not also written in YAML, where a test cannot reach them');
  assert.match(gate, /GH_TOKEN: \$\{\{ github\.token \}\}/, 'the gate can read the PR and its CI');
});

test('a fork head is refused inside the review as well as at the gate', () => {
  const repo = 'Flame119052/tess-music';
  assert.equal(forkProblem({ full_name: repo, fork: false }, repo), null);
  assert.match(forkProblem({ full_name: 'outside/tess-music', fork: true }, repo), /outside\/tess-music/);
  assert.match(forkProblem({ full_name: repo, fork: true }, repo), /fork/, 'a fork flag wins over a matching name');
  assert.match(forkProblem(null, repo), /missing or was deleted/, 'a deleted head repository fails closed');
  assert.match(forkProblem({ full_name: repo }, repo), /fork/, 'an unknown flag fails closed too');

  // The gate's own parse of GitHub's answer: the same-repository head it must allow, and every shape it must refuse.
  assert.deepEqual(headFacts({ head: { sha: 'abc123', repo: { full_name: repo, fork: false } } }, repo),
    { sha: 'abc123', problem: '' }, 'a real fork: false is a review, not a refusal');
  assert.equal(headAnswer(headFacts({ head: { sha: 'abc123', repo: { full_name: repo, fork: false } } }, repo)),
    'review abc123\n');
  assert.equal(headAnswer(headFacts({ head: { sha: 'abc123', repo: { full_name: repo, fork: true } } }, repo)),
    'refuse abc123\n', 'a fork is refused, and its sha is still named in the log');
  assert.match(headFacts(null, repo).problem, /missing or was deleted/, 'an empty answer fails closed');
  assert.match(headFacts({ head: { repo: { full_name: repo, fork: false } } }, repo).problem, /no head commit/);

  const facts = { head: { sha: 'abc123', repo: { full_name: 'outside/tess-music', fork: true } } };
  const message = headReviewProblem(facts, repo, 'abc123');
  assert.match(message, /did not run/);
  assert.match(message, /Verdict: changes needed/, 'a refused review never reads as an approval');
});

test('a verdict names the commit it read and is never posted for a newer head', () => {
  const repo = 'Flame119052/tess-music';
  const gated = 'abc123';
  const factsFor = (sha) => ({ head: { sha, repo: { full_name: repo, fork: false } } });
  const posts = [];

  // The head moved while the reviewer was reading: the verdict is dropped and the refusal is posted instead.
  const moved = postVerdict({
    gated, repo, facts: factsFor('def456'), post: (message) => posts.push(message), body: () => 'VERDICT BODY',
  });
  assert.equal(moved, null);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /abc123 → def456/);
  assert.ok(!posts.includes('VERDICT BODY'), 'no verdict is attached to a commit nobody read');

  // A fork head is refused at posting time too.
  posts.length = 0;
  assert.equal(postVerdict({
    gated, repo, facts: { head: { sha: gated, repo: { full_name: 'outside/tess-music', fork: true } } },
    post: (message) => posts.push(message), body: () => 'VERDICT BODY',
  }), null);
  assert.match(posts[0], /did not run/);

  // Unchanged head: the verdict is posted, and it says which commit that was.
  posts.length = 0;
  assert.equal(postVerdict({
    gated, repo, facts: factsFor(gated), post: (message) => posts.push(message), body: (sha) => `Reviewed: ${sha}\nVERDICT BODY`,
  }), gated);
  assert.match(posts[0], /Reviewed: abc123/);
});

test('a push during the review turns a docs-only approval into a refusal', () => {
  // The real script, the real docs-only path, with GitHub answering a different head the second time it is asked.
  const dir = temp();
  const scriptPath = fileURLToPath(new URL('./agent-review.mjs', import.meta.url));
  const commentOut = join(dir, 'comment');
  const asks = join(dir, 'asks');
  const fakePr = (dir, second) => `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/issues/89" ]; then
  printf '{"number":89,"title":"t","html_url":"https://example.invalid/89","body":""}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/pulls/89/files" ]; then
  printf 'docs/workflow.md\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/pulls/89" ]; then
  n=$(cat '${asks}' 2>/dev/null || printf 0)
  n=$((n + 1))
  printf '%s' "$n" > '${asks}'
  if [ "$n" -ge 2 ]; then sha='${second}'; else sha='deadbeef'; fi
  printf '{"head":{"sha":"%s","repo":{"full_name":"Flame119052/tess-music","fork":false}}}' "$sha"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  cat > '${commentOut}'
  exit 0
fi
exit 99
`;
  try {
    writeFileSync(join(dir, 'git'), '#!/bin/sh\nprintf \'deadbeef\\n\'\n');
    writeFileSync(join(dir, 'gh'), fakePr(dir, 'cafebabe'));
    chmodSync(join(dir, 'git'), 0o755);
    chmodSync(join(dir, 'gh'), 0o755);
    execFileSync(process.execPath, [scriptPath, 'pr', '89'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REVIEW_HEAD_SHA: 'deadbeef' },
      stdio: 'pipe',
    });
    const moved = readFileSync(commentOut, 'utf8');
    assert.match(moved, /deadbeef → cafebabe/);
    assert.match(moved, /Verdict: changes needed/);
    assert.ok(!/approve/.test(moved), 'the approval is never posted for the newer commit');

    // A head that stays put is approved, and the approval names the commit.
    rmSync(asks, { force: true });
    rmSync(commentOut, { force: true });
    writeFileSync(join(dir, 'gh'), fakePr(dir, 'deadbeef'));
    chmodSync(join(dir, 'gh'), 0o755);
    execFileSync(process.execPath, [scriptPath, 'pr', '89'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REVIEW_HEAD_SHA: 'deadbeef' },
      stdio: 'pipe',
    });
    const approved = readFileSync(commentOut, 'utf8');
    assert.match(approved, /Reviewed: deadbeef/);
    assert.match(approved, /Verdict: approve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a held key is caught split, encoded or wrapped, and a failed reviewer never logs its output', () => {
  const key = `oc-go-${'Zx9'.repeat(10)}`;
  const env = { OPENCODE_API_KEY: key, HOME: '/home/r' };
  const half = `${key.slice(0, 8)}\n  ${key.slice(8, 20)} ${key.slice(20)}`;
  const shapes = [
    key,
    half,
    Buffer.from(key).toString('base64'),
    Buffer.from(key).toString('base64').replace(/=+$/, ''),
    Buffer.from(key).toString('hex'),
    encodeURIComponent(key),
  ];
  for (const shape of shapes) assert.ok(containsHeldSecret(`here: ${shape}`, env), shape);
  assert.ok(!containsHeldSecret('GLM is cheap and DeepSeek is cheaper', env));
  assert.ok(!containsHeldSecret('the token is abc', { OPENCODE_API_KEY: 'abc' }), 'a short value is not a key');

  // Cleaning a log line takes the key out in each of those shapes.
  for (const shape of [half, Buffer.from(key).toString('base64'), Buffer.from(key).toString('hex')]) {
    const clean = redactText(`warning: ${shape} rejected`, env);
    assert.ok(!clean.includes(key.slice(0, 8)), clean);
    assert.match(clean, /\[redacted\]/);
  }
  // Colours and control codes never reach a log, and the line is capped.
  assert.equal(sanitizeLine('\u001b[31mboom\u001b[0m\u0000\u0007 now'), 'boom now');
  const long = failureSummary({ stderr: `x ${'y'.repeat(400)}` }, env);
  assert.ok(long.length <= 201, long.length);

  // A failure keeps one redacted line of stderr, and never the stdout the diff could have dictated.
  const summary = failureSummary({ status: 3, stderr: `bad key ${key}\nsecond line`, stdout: 'SECRET REVIEW TEXT' }, env);
  assert.ok(!summary.includes(key), summary);
  assert.match(summary, /bad key/);
  assert.ok(!summary.includes('SECRET REVIEW TEXT'));

  let thrown;
  try {
    runReviewer([{ provider: 'codex', model: 'gpt-6.1-terra' }], 'p', '/w', {
      usageFor: () => undefined,
      commandAvailable: () => true,
      sandbox: () => null,
      invoke: () => ({ status: 1, stderr: `auth failed for ${key}`, stdout: 'SECRET REVIEW TEXT' }),
      env,
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'a real failure still fails loudly');
  assert.ok(!thrown.message.includes(key), thrown.message);
  assert.ok(!thrown.message.includes('SECRET REVIEW TEXT'), thrown.message);
  assert.match(thrown.message, /auth failed for/, 'the one line that helps is kept');
});

test('a CLI or proxy that fails unexpectedly is still a refusal a comment can carry', () => {
  const key = `sk-live-${'Qw7'.repeat(10)}`;
  const env = { GH_TOKEN: key, HOME: '/home/r' };
  const codexModel = { provider: 'codex', model: 'gpt-6.1-sol' };
  const attempt = (invoke) => {
    try {
      runReviewer([codexModel], 'p', '/w', {
        usageFor: () => undefined,
        commandAvailable: () => true,
        sandbox: () => null,
        caps: capsFor(config),
        invoke,
        env,
      });
      return null;
    } catch (error) {
      return error;
    }
  };

  // Exit 1 with a message that is not a cap, a usage limit or a bad flag: before, this was a bare Error, so the caller
  // posted nothing and the agent that tagged waited for a review that never came.
  const exited = attempt(() => ({ status: 1, stderr: 'unexpected backend failure' }));
  assert.ok(exited.refusal, 'a real failure carries a refusal, so the caller posts it');
  assert.equal(exited.refusal.failure, true);
  assert.equal(exited.refusal.provider, 'codex');
  assert.equal(exited.refusal.model, 'gpt-6.1-sol');
  assert.match(exited.refusal.reason, /unexpected backend failure/);

  // The proxy is started inside the same call and can throw before any CLI runs (no address, no start). That is the same
  // refusal rather than an unlabelled crash.
  const proxy = attempt(() => { throw new Error('the codex review proxy did not start'); });
  assert.ok(proxy.refusal, 'a proxy that cannot start is a refusal too');
  assert.equal(proxy.refusal.failure, true);
  assert.match(proxy.refusal.reason, /proxy did not start/);
  // An invoke that returns nothing at all is a failure, not a crash on `result.timedOut`.
  const empty = attempt(() => undefined);
  assert.ok(empty.refusal);

  // No secret reaches the comment: the one stderr line is redacted exactly as the log line is.
  const leaky = attempt(() => ({ status: 2, stderr: `auth failed for ${key}` }));
  assert.ok(leaky.refusal);
  assert.ok(!leaky.refusal.reason.includes(key), 'a held key never reaches the refusal reason');
  assert.match(leaky.refusal.reason, /\[redacted\]/);
});

test('a stopped review leaves one marker comment that says what failed', () => {
  const body = failureComment({ reason: 'codex/gpt-6.1-sol could not review: unexpected backend failure' });
  assert.ok(body.startsWith('<!-- tess-review-bot -->'), 'the marker keeps it from triggering another review');
  assert.match(body, /stopped before it posted a verdict/);
  assert.match(body, /Why: codex\/gpt-6\.1-sol could not review: unexpected backend failure\./);
  assert.match(body, /Nothing was substituted/);
  assert.ok(!/Verdict:/.test(body), 'a failure is not a verdict about the change');
});

test('a run that fails after the gate posts the stop comment and exits non-zero', () => {
  const dir = temp();
  const scriptPath = fileURLToPath(new URL('./agent-review.mjs', import.meta.url));
  const comments = join(dir, 'comments.log');
  // Every GitHub call fails: the run dies inside the script, where only a guard can post anything.
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
if [ "$1" = "api" ]; then exit 1; fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  cat >> "$GH_COMMENT_LOG"
  printf '\\n---\\n' >> "$GH_COMMENT_LOG"
  exit 0
fi
exit 99
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const env = {
    ...process.env,
    HOME: dir,
    PATH: `${dir}:${process.env.PATH}`,
    GITHUB_REPOSITORY: 'Flame119052/tess-music',
    GH_TOKEN: 'x',
    GH_COMMENT_LOG: comments,
  };
  const failed = (args, extra = {}) => {
    let error;
    try {
      execFileSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...env, ...extra } });
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error, `${args.join(' ')} still fails`);
    assert.equal(error.status, 1, `${args.join(' ')} exits non-zero`);
    return existsSync(comments) ? readFileSync(comments, 'utf8') : '';
  };

  try {
    // An unexpected crash in the review itself: the top-level guard turns it into the marker comment.
    const crashed = failed(['pr', '101'], { RUNNER_TEMP: join(dir, 'runner-temp-pr') });
    assert.match(crashed, /<!-- tess-review-bot -->/);
    assert.match(crashed, /stopped before it posted a verdict/);
    assert.match(crashed, /Why: /);

    // The workflow's own failure step, which covers everything the script cannot: one command, no provider secret.
    rmSync(comments, { force: true });
    const runnerTemp = join(dir, 'runner-temp');
    mkdirSync(runnerTemp, { recursive: true });
    const stopped = failed(['stop', "installing the reviewer's CLI failed"], { REVIEW_NUMBER: '101', RUNNER_TEMP: runnerTemp });
    assert.match(stopped, /<!-- tess-review-bot -->/);
    assert.match(stopped, /stopped before it posted a verdict/);
    assert.match(stopped, /Why: installing the reviewer's CLI failed/);

    // One failure, one comment: a step that already posted one leaves a marker, and the failure step then says nothing.
    rmSync(comments, { force: true });
    failed(['stop', 'a second failure in the same job'], { REVIEW_NUMBER: '101', RUNNER_TEMP: runnerTemp });
    assert.equal(existsSync(comments), false, 'the same failure is not commented twice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the review step checks the tag\'s author too, and a missing attestation is refused there as well', () => {
  const dir = temp();
  const scriptPath = fileURLToPath(new URL('./agent-review.mjs', import.meta.url));
  const commentOut = join(dir, 'comment');
  const event = join(dir, 'event.json');
  writeFileSync(join(dir, 'git'), `#!/bin/sh
case "$*" in
  *" rev-parse FETCH_HEAD"*) printf 'cafebabe\\n' ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/issues/101" ]; then
  printf '{"number":101,"title":"t","html_url":"https://example.invalid/101","body":""}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/pulls/101/files" ]; then
  printf 'tools/agent-review.mjs\\n'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/Flame119052/tess-music/pulls/101" ]; then
  printf '{"number":101,"title":"t","body":"## Made by\\\\n\\\\nDeepSeek V4.1 Flash in OpenCode","head":{"sha":"cafebabe","repo":{"full_name":"Flame119052/tess-music","fork":false}}}'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  cat > '${commentOut}'
  exit 0
fi
exit 99
`);
  chmodSync(join(dir, 'git'), 0o755);
  chmodSync(join(dir, 'gh'), 0o755);
  const run = (tag) => {
    writeFileSync(event, JSON.stringify({ comment: { body: tag } }));
    rmSync(commentOut, { force: true });
    execFileSync(process.execPath, [scriptPath, 'pr', '101'], {
      env: {
        ...process.env,
        HOME: dir,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'Flame119052/tess-music',
        GITHUB_EVENT_PATH: event,
        REVIEW_HEAD_SHA: 'cafebabe',
        REVIEW_PROVIDER: 'opencode',
        REVIEW_MODEL: 'opencode-go/deepseek-v4.1-flash',
        GH_TOKEN: 'x',
      },
      stdio: 'pipe',
    });
    return existsSync(commentOut) ? readFileSync(commentOut, 'utf8') : '';
  };

  try {
    // The second door reads the same tag the pick step did: a tag without `author=` is refused here too, and the refusal
    // names the field that is missing.
    assert.match(run('@tess-review pr provider=opencode model=opencode-go/deepseek-v4.1-flash'), /author=/);
    // And the tag's own author, checked against the PR's Made by line, refuses this provider.
    assert.match(run('@tess-review pr provider=opencode model=opencode-go/deepseek-v4.1-flash author=opencode'), /same provider/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the review workflow has a failure step that comments, and it holds no provider secret', () => {
  const review = jobBlock('review');
  const step = stepBlock(review, 'Comment when the review stops short');
  assert.match(step, /if: failure\(\)/, 'it runs only when an earlier step failed');
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/, 'the job token, nothing more');
  assert.match(step, /agent-review\.mjs stop/, 'the tested script posts the comment');
  for (const names of Object.values(providerKeys)) {
    for (const name of names) assert.ok(!step.includes(name), `${name} is never on the failure step`);
  }
});

test('the review comment puts Used and Usage on separate lines and prints one Verdict line (#103)', () => {
  const caps = capsFor(config);
  const { formatReviewComment, verdictFor } = agentReview;
  assert.equal(typeof formatReviewComment, 'function', 'formatReviewComment is exported');

  // The exact shape that broke on PR #76: Used + Usage glued together, and `Verdict: changes needed.` duplicated.
  const comment = formatReviewComment({
    role: 'pr',
    sha: '3668e7eab1419df116674d0ee152608049c2ef73',
    tier: 'sensitive',
    caps,
    result: {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      text: [
        '- **Critical — `installer/install.sh`:** unsigned fallback.',
        '',
        'The script prints `Verdict: approve` when valid.',
        '',
        'Verdict: changes needed.',
      ].join('\n'),
      usage: { input: 24000, output: 800 },
      snapshot: { source: 'vps', ageMs: 2 * 60000 },
    },
  });

  const lines = comment.split('\n');
  assert.ok(lines.includes('Used: 24,800 tokens (24,000 in, 800 out)'), 'Used sits on its own line');
  assert.ok(lines.includes('Usage: vps, 2 min old'), 'Usage sits on the next line, never glued onto Used');
  assert.ok(!/Used:[^\n]+Usage:/.test(comment), 'Used and Usage are separated by a newline');
  assert.equal(lines.filter((line) => /^\s*[*_`]*Verdict\s*:/i.test(line)).length, 1, 'exactly one Verdict line is printed');
  assert.equal(lines.at(-1), 'Verdict: changes needed');
  assert.match(comment, /The script prints `Verdict: approve` when valid\./, 'inline prose mentioning Verdict is preserved');

  // Bold, exclamation marks, trailing spaces, and approach comments all normalize to one clean Verdict line.
  for (const rawEnding of ['**Verdict: approve.**', 'Verdict: approve!', '- Verdict: approve.', 'Verdict: changes needed.\n\nVerdict: approve.']) {
    const formatted = formatReviewComment({
      role: 'approach',
      caps,
      result: {
        provider: 'claude',
        model: 'claude-opus-5-5',
        effort: 'high',
        text: `Finding or summary.\n\n${rawEnding}\n`,
        usage: { turns: 3, costUsd: 0.04, input: 10000, output: 400 },
        snapshot: { source: 'mac', ageMs: 60000 },
      },
    });
    const verdictLines = formatted.split('\n').filter((line) => /^\s*[*_`]*Verdict\s*:/i.test(line));
    assert.equal(verdictLines.length, 1, `single Verdict line for ${JSON.stringify(rawEnding)}`);
    assert.equal(verdictFor(`Summary.\n\n${rawEnding}`), rawEnding.includes('approve') ? 'approve' : 'changes needed');
    assert.match(formatted, /\nUsed: 3 turns · \$0\.0400 of its \$0\.6 cap · 10,400 tokens \(10,000 in, 400 out\)\nUsage: mac, 1 min old\n/);
  }
});

test('a comment can carry the lines a machine review needs, and the key refusal is written once (#105)', () => {
  const caps = capsFor(config);
  const { formatReviewComment, secretRefusal, marker } = agentReview;
  const comment = formatReviewComment({
    role: 'pr',
    sha: '30db62c',
    tier: 'normal',
    caps,
    notes: ['Machine: mac', 'Cap: none on this path'],
    result: { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', text: 'Finding.\n\nVerdict: approve' },
  });
  const lines = comment.split('\n');
  assert.equal(lines[0], marker);
  assert.deepEqual(lines.slice(0, 6), [
    marker, 'Reviewed: 30db62c', 'Tier: normal',
    'Reviewer: opencode / opencode-go/deepseek-v4.1-flash', 'Machine: mac', 'Cap: none on this path',
  ]);
  assert.equal(lines.at(-1), 'Verdict: approve');
  // The refusal a review holding a key gets, shared by both paths so they cannot drift apart.
  assert.ok(secretRefusal.startsWith(marker));
  assert.match(secretRefusal, /its text contained a key or token/);
});

test('large PR diffs omit generated build outputs by name, flag sensitive omitted paths with bounded excerpts, and pass changed files inline (#103)', () => {
  const { compactDiff, buildPrContext, reviewPrompt } = agentReview;
  assert.equal(typeof compactDiff, 'function', 'compactDiff is exported');
  assert.equal(typeof buildPrContext, 'function', 'buildPrContext is exported');
  assert.equal(typeof reviewPrompt, 'function', 'reviewPrompt is exported');

  const dir = temp();
  try {
    mkdirSync(join(dir, 'installer'), { recursive: true });
    mkdirSync(join(dir, 'tools'), { recursive: true });
    mkdirSync(join(dir, 'theme/Tess'), { recursive: true });
    mkdirSync(join(dir, 'patcher/prebuilt/spicetify-2.46.4/jsHelper'), { recursive: true });

    writeFileSync(join(dir, 'installer/install.sh'), '#!/bin/sh\necho "updated"\n');
    writeFileSync(join(dir, 'tools/new-helper.mjs'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'theme/Tess/theme.js'), 'new bundle\n');
    writeFileSync(join(dir, 'theme/Tess/user.css'), 'body{}\n');
    writeFileSync(join(dir, 'theme/Tess/theme.js.map'), `{"mappings":"${'A'.repeat(40000)}"}`);
    // A large modified file (>16 KB) so the prompt extracts hunk context instead of dumping the whole file.
    const bigLines = Array.from({ length: 600 }, (_, i) => `// padding line ${i + 1}: ${'a'.repeat(40)}`);
    bigLines[299] = 'export const changedAnchor = true;';
    writeFileSync(join(dir, 'tools/big.mjs'), `${bigLines.join('\n')}\n`);
    writeFileSync(join(dir, 'patcher/prebuilt/spicetify-2.46.4/css-map.json'), `{"k":"${'v'.repeat(50000)}"}`);

    const rawDiff = [
      `diff --git a/patcher/prebuilt/spicetify-2.46.4/css-map.json b/patcher/prebuilt/spicetify-2.46.4/css-map.json\nnew file mode 100644\nindex 000..111\n--- /dev/null\n+++ b/patcher/prebuilt/spicetify-2.46.4/css-map.json\n@@ -0,0 +1 @@\n+{"k":"${'v'.repeat(50000)}"}`,
      `diff --git a/theme/Tess/theme.js.map b/theme/Tess/theme.js.map\nnew file mode 100644\n--- /dev/null\n+++ b/theme/Tess/theme.js.map\n@@ -0,0 +1 @@\n+{"mappings":"${'A'.repeat(40000)}"}`,
      'diff --git a/theme/Tess/theme.js b/theme/Tess/theme.js\nindex 111..222 100644\n--- a/theme/Tess/theme.js\n+++ b/theme/Tess/theme.js\n@@ -1 +1 @@\n-old\n+new bundle',
      'diff --git a/theme/Tess/user.css b/theme/Tess/user.css\nindex 111..222 100644\n--- a/theme/Tess/user.css\n+++ b/theme/Tess/user.css\n@@ -1 +1 @@\n-oldcss\n+newcss',
      'diff --git a/installer/install.sh b/installer/install.sh\nindex 111..222 100755\n--- a/installer/install.sh\n+++ b/installer/install.sh\n@@ -1,2 +1,2 @@\n #!/bin/sh\n-echo "old"\n+echo "updated"',
      'diff --git a/tools/new-helper.mjs b/tools/new-helper.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/tools/new-helper.mjs\n@@ -0,0 +1 @@\n+export const x = 1;',
      'diff --git a/tools/big.mjs b/tools/big.mjs\nindex 111..222 100644\n--- a/tools/big.mjs\n+++ b/tools/big.mjs\n@@ -299,2 +299,2 @@\n-export const changedAnchor = false;\n+export const changedAnchor = true;',
    ].join('\n');

    const compacted = compactDiff(rawDiff);
    assert.ok(!compacted.text.includes('AAAAAAAA'), 'non-sensitive sourcemap payload is omitted from prompt diff');
    assert.ok(!compacted.text.includes('+new bundle'), 'built theme bundle diff is omitted from prompt diff');
    assert.ok(!compacted.text.includes('+newcss'), 'built user.css diff is omitted from prompt diff');
    assert.match(compacted.text, /theme\/Tess\/theme\.js.*omitted/, 'omission notice lists theme.js by name');
    assert.match(compacted.text, /theme\/Tess\/user\.css.*omitted/, 'omission notice lists user.css by name');
    assert.match(compacted.text, /theme\/Tess\/theme\.js\.map.*omitted/, 'omission notice lists *.map by name');
    assert.match(compacted.text, /SENSITIVE.*patcher\/prebuilt\/spicetify-2\.46\.4\/css-map\.json/, 'sensitive prebuilt path gets a SENSITIVE notice');
    assert.ok(!compacted.text.includes('generated/vendored'), 'sensitive prebuilt path is never dismissed as generated/vendored');
    assert.ok(compacted.text.includes('vvvvvvvv'), 'sensitive prebuilt path includes a bounded diff excerpt');
    assert.ok(compacted.text.length < 25000, `sensitive excerpt stays bounded (${compacted.text.length} chars)`);
    assert.match(compacted.text, /echo "updated"/, 'real code diffs stay intact');

    const context = buildPrContext({
      issue: '#103',
      approach: 'approach text',
      diff: rawDiff,
      files: [
        'patcher/prebuilt/spicetify-2.46.4/css-map.json',
        'theme/Tess/theme.js.map',
        'theme/Tess/theme.js',
        'theme/Tess/user.css',
        'installer/install.sh',
        'tools/new-helper.mjs',
        'tools/big.mjs',
      ],
      work: dir,
    });
    const prompt = reviewPrompt('pr', context);
    assert.match(prompt, /CHANGED FILES/, 'prompt lists and supplies changed files');
    assert.match(prompt, /--- installer\/install\.sh/, 'small modified file is included inline');
    assert.ok(!prompt.includes('--- tools/new-helper.mjs'), 'newly added file already shown in full in diff is not duplicated');
    assert.match(prompt, /tools\/big\.mjs.*excerpt|--- tools\/big\.mjs/, 'large modified file provides hunk-centered context');
    assert.match(prompt, /export const changedAnchor = true;/, 'changed anchor line is included in hunk excerpt');
    assert.ok(!prompt.includes('padding line 1:'), 'far-away lines of a large modified file are omitted to save tokens');
    assert.match(prompt, /working copy.*read-only|available read-only/i, 'rest of repo stays available read-only if needed');
    assert.ok(prompt.length < 35000, `compacted prompt stays small (${prompt.length} chars) instead of 90k+`);

    // Oversized single-file diff & total diff budget are both bounded cleanly.
    const hugeRealDiff = [
      `diff --git a/tools/a.mjs b/tools/a.mjs\nindex 1..2 100644\n--- a/tools/a.mjs\n+++ b/tools/a.mjs\n@@ -1 +1 @@\n+${'line\n'.repeat(6000)}`,
      `diff --git a/tools/b.mjs b/tools/b.mjs\nindex 1..2 100644\n--- a/tools/b.mjs\n+++ b/tools/b.mjs\n@@ -1 +1 @@\n+const ok = 1;`,
    ].join('\n');
    const bounded = compactDiff(hugeRealDiff, { maxFileBytes: 2048, maxTotalBytes: 3000 });
    assert.ok(bounded.text.length < 4000, 'diff obeys per-file and total byte caps');
    assert.match(bounded.text, /truncated.*tools\/a\.mjs/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a PR whose only change is in patcher/prebuilt/ gets a SENSITIVE notice with a bounded excerpt and truncation rules', () => {
  const { buildPrContext, reviewPrompt } = agentReview;
  const dir = temp();
  try {
    const rel = 'patcher/prebuilt/spicetify-2.46.4/jsHelper/spicetifyWrapper.js';
    mkdirSync(join(dir, 'patcher/prebuilt/spicetify-2.46.4/jsHelper'), { recursive: true });
    const lines = Array.from({ length: 400 }, (_, i) => `const line${i + 1} = "${'x'.repeat(50)}";`);
    lines[0] = 'const changedFirstLine = "SENSITIVE_EXCERPT_HEAD";';
    lines[399] = 'const changedTailLine = "SENSITIVE_TAIL_UNSEEN";';
    writeFileSync(join(dir, rel), `${lines.join('\n')}\n`);

    const diff = [
      `diff --git a/${rel} b/${rel}`,
      'index 1111111..2222222 100644',
      `--- a/${rel}`,
      `+++ b/${rel}`,
      '@@ -1,2 +1,2 @@',
      '-const changedFirstLine = "OLD";',
      '+const changedFirstLine = "SENSITIVE_EXCERPT_HEAD";',
      '@@ -399,2 +399,2 @@',
      '-const changedTailLine = "OLD_TAIL";',
      ...lines.slice(1).map((l) => `+${l}`),
    ].join('\n');

    const context = buildPrContext({
      issue: '#104',
      approach: 'approach text',
      diff,
      files: [rel],
      work: dir,
    });
    const prompt = reviewPrompt('pr', context);

    assert.match(prompt, /SENSITIVE/, 'notice is marked SENSITIVE');
    assert.ok(!prompt.includes('generated/vendored'), 'never silently omitted as generated/vendored');
    assert.ok(prompt.includes('SENSITIVE_EXCERPT_HEAD'), 'bounded excerpt includes the start of the diff');
    assert.ok(!prompt.includes('SENSITIVE_TAIL_UNSEEN'), 'oversized diff body stays bounded');
    assert.match(prompt, /\d[\d,]* bytes omitted/i, 'reports byte count of the omitted rest');
    assert.match(prompt, /must (?:inspect|look at)/i, 'tells the reviewer it must look at it');
    assert.match(prompt, /read the full file in the (?:read-only )?snapshot/i, 'tells the reviewer it may read the full file in the snapshot');
    assert.match(prompt, /truncated[\s\S]*must not approve on content (?:you|it) did not see|must not approve on (?:content you did not see|unseen content)/i,
      'prompt rules forbid approving on unseen truncated content');
    assert.match(prompt, /must (?:explicitly )?state.*truncated|say so/i,
      'prompt rules require stating when an excerpt is truncated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skipReason, fence-aware verdicts, and diff --git splitting handle review edge cases', () => {
  const { compactDiff, cleanReviewBody, verdictFor } = agentReview;

  // Low #1: agent_message text mentioning rollout_budget or a flag error about it is not mislabelled as hit its cap.
  const agentMsgAboutRollout = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Reviewed rollout_budget and budget_limited handling.' } }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'upstream socket closed' } }),
  ].join('\n');
  assert.equal(skipReason({ status: 1, stdout: agentMsgAboutRollout, stderr: 'upstream socket closed' }), null,
    'agent_message prose mentioning rollout_budget is not mislabelled as hit its cap');
  assert.equal(skipReason({ status: 1, stderr: 'unknown option features.rollout_budget' }), 'rejected a flag',
    'rejected rollout_budget flag is not mislabelled as hit its cap');
  assert.notEqual(skipReason({ status: 1, stderr: 'invalid config key features.rollout_budget' }), 'hit its cap',
    'unrelated rollout_budget config error is not mislabelled as hit its cap');
  assert.equal(skipReason({ status: 1, stderr: 'Error: rollout_budget exceeded after 200000 tokens' }), 'hit its cap',
    'real rollout_budget error still maps to hit its cap');

  // Low #2: verdictFor and cleanReviewBody ignore Verdict lines inside fenced code blocks.
  const fencedReview = [
    'Found a bug in the test fixture:',
    '',
    '```diff',
    '-old',
    '+Verdict: approve',
    '```',
    '',
    '~~~markdown',
    'Verdict: approve',
    '~~~',
    '',
    'Please fix the bug.',
    '',
    'Verdict: changes needed',
  ].join('\n');
  assert.equal(verdictFor(fencedReview), 'changes needed');
  const cleaned = cleanReviewBody(fencedReview);
  assert.ok(cleaned.includes('+Verdict: approve'), 'Verdict inside ``` fence is preserved in review body');
  assert.ok(cleaned.includes('~~~markdown\nVerdict: approve\n~~~'), 'Verdict inside ~~~ fence is preserved in review body');
  assert.ok(!/\nVerdict: changes needed\s*$/.test(cleaned), 'trailing standalone Verdict outside fences is stripped');

  const onlyFencedVerdict = [
    'Quoted fixture:',
    '```',
    'Verdict: approve',
    '```',
    'Missing real verdict.',
  ].join('\n');
  assert.equal(verdictFor(onlyFencedVerdict), 'changes needed', 'fenced Verdict: approve alone cannot approve');

  // Low #3: a diff --git line inside a hunk or fixture without a git header does not split the file section.
  const nestedPatchDiff = [
    'diff --git a/tools/fixture.txt b/tools/fixture.txt',
    'index 111..222 100644',
    '--- a/tools/fixture.txt',
    '+++ b/tools/fixture.txt',
    '@@ -1,3 +1,3 @@',
    ' header',
    'diff --git a/theme/Tess/theme.js b/theme/Tess/theme.js',
    '+added line after stray diff --git',
    'diff --git a/theme/Tess/theme.js b/theme/Tess/theme.js',
    'index 333..444 100644',
    '--- a/theme/Tess/theme.js',
    '+++ b/theme/Tess/theme.js',
    '@@ -1 +1 @@',
    '-old',
    '+new bundle',
  ].join('\n');
  const splitCompacted = compactDiff(nestedPatchDiff);
  assert.ok(!splitCompacted.text.includes('(unknown file)'), 'stray diff --git inside a hunk does not create an (unknown file) section');
  assert.ok(splitCompacted.text.includes('+added line after stray diff --git'), 'content after stray diff --git stays in tools/fixture.txt');
  assert.ok(!splitCompacted.text.includes('+new bundle'), 'real subsequent theme/Tess/theme.js section is still split and omitted');
});

test('Codex multi-turn usage is summed and streaming past max_tokens aborts with a cap refusal (#103)', async () => {
  const { streamCommand, runReviewerAsync } = agentReview;
  assert.equal(typeof streamCommand, 'function', 'streamCommand is exported');
  assert.equal(typeof runReviewerAsync, 'function', 'runReviewerAsync is exported');

  // Multiple turn.completed events sum up instead of discarding earlier turns.
  const multiTurn = parseCodexOutput([
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Draft"}}',
    '{"type":"turn.completed","usage":{"input_tokens":80000,"cached_input_tokens":10000,"output_tokens":400}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Final.\\nVerdict: approve"}}',
    '{"type":"turn.completed","usage":{"input_tokens":70000,"cached_input_tokens":50000,"output_tokens":600}}',
  ].join('\n'));
  assert.equal(multiTurn.text, 'Final.\nVerdict: approve');
  assert.deepEqual(multiTurn.usage, { input: 150000, output: 1000, cached: 60000 });

  // A child process that streams JSON usage lines past maxTokens is killed immediately instead of running further turns.
  const dir = temp();
  try {
    const fakeCli = join(dir, 'fake-codex.mjs');
    const markerFile = join(dir, 'continued');
    writeFileSync(fakeCli, `
      import { writeFileSync } from 'node:fs';
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120000, output_tokens: 500 } }));
      setTimeout(() => {
        console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 90000, output_tokens: 500 } }));
      }, 40);
      setTimeout(() => {
        writeFileSync(${JSON.stringify(markerFile)}, 'should-not-run');
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Too late\\nVerdict: approve' } }));
        process.exit(0);
      }, 300);
    `);

    const streamed = await streamCommand(process.execPath, [fakeCli], {
      provider: 'codex',
      maxTokens: 200000,
      timeout: 5000,
    });
    assert.equal(streamed.hitTokenCap, true, 'streamCommand stops as soon as cumulative tokens pass 200k');
    assert.equal(streamed.timedOut, false, 'a token-cap abort is not mislabelled as a wall-clock timeout');
    assert.equal(existsSync(markerFile), false, 'the child process was killed before continuing past the cap');
    assert.equal(skipReason(streamed), 'hit its cap');

    // runReviewerAsync surfaces a token-cap abort as a refusal naming the cap, never as a verdict.
    let refused;
    try {
      await runReviewerAsync([{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }], 'prompt', '/w', {
        usageFor: () => undefined,
        commandAvailable: () => true,
        sandbox: () => null,
        caps: capsFor(config),
        invoke: async () => streamed,
      });
    } catch (error) {
      refused = error;
    }
    assert.ok(refused?.refusal, 'an over-cap run throws a refusal for a PR comment');
    assert.match(refused.refusal.reason, /hit its cap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A tag now says where the review runs (`machine=`) and may add the owner's focus (`prompt="…"`). The example below is
// the one Krish wrote when he decided this, and the parser has to read it exactly as he meant it.
const krishTag = '@tess-review pr provider=codex model=gpt-6.1-sol effort=high author=opencode machine=github prompt="focus on the installer fallback"';

test('a tag names where it runs and what to look at, and quoting on the tag line is read, not guessed', () => {
  assert.deepEqual(parseRequest(krishTag), {
    provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', author: 'opencode',
    machine: 'github', prompt: 'focus on the installer fallback',
  });
  // A tag that says nothing about the machine keeps the meaning it had before the option existed.
  assert.equal(machineOf(parseRequest('@tess-review pr provider=codex model=gpt-6.1-sol')), 'github');
  assert.equal(machineOf({}), 'github');
  assert.equal(machineOf({ machine: 'MAC' }), 'mac', 'the value is compared in one letter case');

  // A comment typed in GitHub's web form ends its lines with CRLF; a parser that keeps the `\r` breaks the last option.
  assert.equal(parseRequest('@tess-review pr provider=codex model=gpt-6.1-sol author=opencode\r\n\r\nwhy: x').author, 'opencode');
  assert.equal(parseRequest('@tess-review pr\r\nprovider=codex model=gpt-6.1-sol').provider, undefined,
    'options belong on the tag line, as docs/workflow.md says');

  // A mistyped option is refused, never ignored: ignoring `author=claud` would allow the provider it was meant to exclude.
  assert.match(parseRequest('@tess-review pr provider=codex model=gpt-6.1-sol tier=docs').problem, /not an option/);
  assert.match(parseRequest('@tess-review pr provider=codex provider=claude').problem, /given twice/);
  assert.match(parseRequest('@tess-review pr prompt="never closed').problem, /never closed/);
  // Prose on the tag line is not an option, and does not become one.
  assert.deepEqual(parseRequest('@tess-review pr because the plan changed provider=codex model=gpt-6.1-sol'),
    { provider: 'codex', model: 'gpt-6.1-sol' });
});

test('a tag may choose a machine, and only the machines a review can run on', () => {
  for (const machine of ['github', 'mac', 'omarchy']) {
    assert.equal(tagProblem({ machine }), null, `${machine} is a review machine`);
  }
  assert.deepEqual(watcherMachines, ['mac', 'omarchy'], 'a watcher runs on the machines a GitHub job cannot reach');

  // The VPS is named only so it can be refused with its reason: T3 runs as root there, beside Paperclip.
  const vps = tagProblem({ machine: 'vps' });
  assert.equal(vps.code, 'machine-vps');
  assert.match(vps.reason, /root/);
  assert.match(vps.reason, /Paperclip/);
  assert.equal(tagProblem({ machine: 'instabox' }).code, 'invalid-options', 'a retired machine is not quietly rerouted');

  // The prompt is the owner's focus, so it is length-capped and kept on one line; a bad one is refused, not trimmed.
  assert.equal(tagProblem({ prompt: 'x'.repeat(tagPromptMax) }), null);
  assert.equal(tagProblem({ prompt: 'x'.repeat(tagPromptMax + 1) }).code, 'invalid-options');
  assert.match(tagProblem({ prompt: '  ' }).reason, /empty/);
  assert.equal(reviewMachines.length, 4, 'every machine is named in one list');
});

test('a tag for another machine never runs on GitHub, and a queued tag says where it went', () => {
  const request = { provider: 'codex', model: 'gpt-6.1-sol', author: 'opencode', machine: 'mac' };
  const refused = requestProblem(config, request, { author: 'opencode' });
  assert.equal(refused.code, 'wrong-machine');
  assert.match(refused.reason, /machine=mac/);
  // The same tag, read by the Mac's watcher, is accepted.
  assert.deepEqual(requestProblem(config, request, { author: 'opencode', machine: 'mac' }).model,
    { provider: 'codex', model: 'gpt-6.1-sol' });
  // A tag with no machine still runs on GitHub.
  assert.ok(requestProblem(config, { provider: 'codex', model: 'gpt-6.1-sol', author: 'opencode' }, { author: 'opencode' }).model);

  const queued = queuedComment({ machine: 'mac', provider: 'codex', model: 'gpt-6.1-sol' });
  assert.ok(queued.startsWith('<!-- tess-review-bot -->'), 'the bot marker keeps it from starting anything');
  assert.match(queued, /queued for `mac` with codex \/ gpt-6\.1-sol/);
  assert.match(queued, /Nothing runs on GitHub's machines/);

  // Every refusal the workflow or a watcher can post has fixed words: a script message is never put on a public issue.
  for (const code of ['invalid-options', 'machine-vps', 'fork-pr', 'ci-not-passed', 'not-a-pull-request', 'slots-busy', 'launch-failed']) {
    const text = reviewRefusalText(code);
    assert.ok(text.startsWith('<!-- tess-review-bot -->'), `${code} carries the marker`);
    assert.match(text, /Review not run\./);
    assert.ok(reviewRefusals[code], `${code} has words`);
  }
  assert.match(reviewRefusalText('machine-vps'), /paperclip-vps/);
  assert.match(reviewRefusalText('machine-vps'), /Nothing ran/);
  assert.match(reviewRefusalText('fork-pr'), /fork/);
  assert.match(reviewRefusalText('nonsense-code'), /was not accepted/, 'an unknown code still refuses in words');
});

test("the owner's focus is extra attention, never permission to skip a rule", () => {
  const focused = reviewPrompt('pr', {
    issue: 'ISSUE', approach: 'APPROACH', diff: 'DIFF', focus: 'focus on the installer fallback',
  });
  assert.match(focused, /OWNER'S FOCUS/);
  assert.match(focused, /focus on the installer fallback/);
  assert.match(focused, /never permission to ignore the rules/);
  // The rules and the required verdict line are still there, and the focus sits above the material it is about.
  assert.match(focused, /End with exactly one line: Verdict: approve OR Verdict: changes needed\./);
  assert.ok(focused.indexOf('OWNER\'S FOCUS') < focused.indexOf('PULL REQUEST DIFF'), 'focus is read before the diff');
  const plain = reviewPrompt('approach', { issue: 'ISSUE', approach: 'APPROACH' });
  assert.ok(!/OWNER'S FOCUS/.test(plain), 'no focus, no section');
});

test('the gate routes a tag to the machine it names, and refuses the rest with a code', () => {
  const answers = { ...prComment, pull: prHead(), ci: 'success', files: 'theme/Tess/src/core.js\n' };
  const mac = runGate({ answers, env: { COMMENT_BODY: `${krishTag.replace('machine=github', 'machine=mac')}` } });
  assert.deepEqual({ allowed: mac.allowed, machine: mac.machine, refusal: mac.refusal, head: mac.head_sha },
    { allowed: 'true', machine: 'mac', refusal: '', head: 'abc123' }, 'a Mac tag is checked here and runs there');

  // A tag with no machine is the GitHub job, exactly as before.
  assert.equal(runGate({ answers, env: { COMMENT_BODY: '@tess-review pr provider=codex model=gpt-6.1-sol author=opencode' } }).machine, 'github');
  assert.equal(runGate({ answers, env: { COMMENT_BODY: '@tess-review pr' } }).machine, 'github');

  // An approach review has no pull request, so it never asks GitHub about one, and still routes.
  const approach = runGate({ env: { COMMENT_BODY: '@tess-review approach machine=omarchy provider=codex model=gpt-6.1-sol author=opencode' } });
  assert.deepEqual({ allowed: approach.allowed, machine: approach.machine, calls: approach.calls },
    { allowed: 'true', machine: 'omarchy', calls: '' });

  // Refusals carry the fixed code the notice job posts, and never a key or a path.
  const vps = runGate({ answers, env: { COMMENT_BODY: '@tess-review pr machine=vps provider=codex model=gpt-6.1-sol author=opencode' } });
  assert.equal(vps.allowed, 'false');
  assert.equal(vps.refusal, 'machine-vps');
  assert.equal(runGate({ answers, env: { COMMENT_BODY: '@tess-review pr machine=nowhere' } }).refusal, 'invalid-options');
  assert.equal(runGate({ answers, env: { COMMENT_BODY: `@tess-review pr prompt="${'x'.repeat(tagPromptMax + 1)}"` } }).refusal, 'invalid-options');
  assert.equal(runGate({ answers, env: { COMMENT_BODY: '@tess-review pr tier=docs' } }).refusal, 'invalid-options');

  // The hard rules still hold for a tag that asks for a machine, because that machine reads the same commit.
  const fork = runGate({ answers: {
    ...prComment,
    pull: JSON.stringify({ head: { sha: 'abc123', repo: { full_name: 'outside/tess-music', fork: true } } }),
    ci: 'success',
  }, env: { COMMENT_BODY: '@tess-review pr machine=mac' } });
  assert.deepEqual({ allowed: fork.allowed, refusal: fork.refusal, head: fork.head_sha }, { allowed: 'false', refusal: 'fork-pr', head: '' });
  assert.equal(runGate({ answers: { ...prComment, pull: prHead(), ci: 'failure' }, env: { COMMENT_BODY: '@tess-review pr machine=mac' } }).refusal, 'ci-not-passed');
  assert.equal(runGate({ answers: { ...prComment, pull: prHead(), ci: '' }, env: { COMMENT_BODY: '@tess-review pr machine=mac' } }).refusal, 'ci-not-passed');

  // `pr` on a plain issue is answered, because the account is allowlisted and asking is what happened.
  const notPr = runGate({ answers: { issue: '{"number":7}', issueUrl: '' }, env: { COMMENT_BODY: '@tess-review pr machine=mac' } });
  assert.deepEqual({ allowed: notPr.allowed, refusal: notPr.refusal }, { allowed: 'false', refusal: 'not-a-pull-request' });

  // A stranger is still silent: their comment is read by nothing and answered by nothing.
  const strangerMac = runGate({ answers, env: { COMMENT_BODY: '@tess-review pr machine=mac', COMMENTER: 'stranger' } });
  assert.deepEqual({ allowed: strangerMac.allowed, refusal: strangerMac.refusal, calls: strangerMac.calls },
    { allowed: 'false', refusal: '', calls: '' });
});

test('the workflow runs a review only for machine=github, and answers the other tags', () => {
  const review = jobBlock('review');
  assert.match(review, /machine == 'github'/, 'a tag for another machine never starts this job');
  const gate = jobBlock('gate');
  assert.match(gate, /machine: \$\{\{ steps\.gate\.outputs\.machine \}\}/);
  assert.match(gate, /refusal: \$\{\{ steps\.gate\.outputs\.refusal \}\}/);

  const notice = jobBlock('notice');
  assert.match(notice, /issues: write/, 'the notice job can comment');
  assert.match(notice, /needs\.gate\.outputs\.refusal != ''/, 'a refusal is posted');
  assert.match(notice, /agent-review\.mjs refuse "\$REVIEW_REFUSAL"/, 'the fixed words are the tested ones');
  assert.match(stepBlock(notice, 'Say where the review is queued'), /agent-review\.mjs queued/);
  assert.match(stepBlock(notice, 'Say where the review is queued'), /REVIEW_MACHINE: \$\{\{ needs\.gate\.outputs\.machine \}\}/);
  for (const names of Object.values(providerKeys)) {
    for (const name of names) assert.ok(!notice.includes(name), `${name} is never in the notice job`);
  }
  // A tag that runs on GitHub gets no notice, and the one that runs elsewhere gets no refusal.
  assert.match(notice, /needs\.gate\.outputs\.allowed == 'true' && needs\.gate\.outputs\.machine != 'github'/);
});
