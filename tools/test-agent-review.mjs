// Test reviewer tier, model selection, sandbox prep and the deny-everything agent without GitHub or provider calls.
// Usage: node tools/test-agent-review.mjs
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
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
  extraSkipped,
  failureSummary,
  forkProblem,
  freshestSnapshot,
  headAnswer,
  headFacts,
  headMismatchMessage,
  headReviewProblem,
  installedProviders,
  looksSecret,
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
  resolveReviewers,
  reviewerEnv,
  readSnapshots,
  reviewerCandidates,
  reviewCost,
  reviewCostPercent,
  reviewsToKeep,
  runReviewer,
  sandboxArgv,
  sandboxHome,
  sandboxProblem,
  sanitizeLine,
  skipReason,
  skippedLine,
  snapshot,
  snapshotUsage,
  stripAgentConfig,
  timeoutSeconds,
  tierForPaths,
  snapshotAge,
  snapshotMaxAgeMs,
  usageNote,
  usageProblem,
  usedLine,
  verifyPrHead,
} from './agent-review.mjs';
import { createReviewProxy, proxyReviewerConfig } from './review-proxy.mjs';

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
  const installs = { claude: 'Install Claude Code', codex: 'Install Codex', opencode: 'Install OpenCode' };
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
    assert.match(output, /no reviewer could run/, 'it stopped after making the review copy, not before');
    assert.ok(!/is not a function/.test(output), 'the usage snapshot never shadows snapshot()');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review roles keep the requested model order', () => {
  assert.deepEqual(config.approach, [
    { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  ]);
  assert.deepEqual(config.pr_normal.map((m) => `${m.provider}/${m.model}`), [
    'codex/gpt-6.1-terra',
    'claude/claude-sonnet-5-5',
    'opencode/opencode-go/deepseek-v4.1-flash',
  ], 'normal PRs default to the cheap OpenCode model; GLM-5.3 on OpenCode Go uses that quota up fast');
  assert.ok(config.allowed.opencode.includes('zai-coding-plan/glm-5.3'), 'GLM on the Z.ai coding plan is allowed by tag');
  assert.deepEqual(config.pr_sensitive, config.approach);
  for (const role of ['approach', 'pr_normal', 'pr_sensitive']) {
    for (const m of config[role]) {
      assert.ok(config.allowed[m.provider].includes(m.model), `${role}: ${m.model} is allowed`);
      assert.ok(!m.effort || config.efforts.includes(m.effort), `${role}: ${m.effort} is one of ${config.efforts}`);
    }
  }
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

test('model order follows config and falls through exhausted or missing providers', () => {
  const allCommands = () => true;
  const first = eligibleModels(config.approach, {
    claude: available(20),
    codex: available(10),
  }, allCommands);
  assert.deepEqual(first.map(({ provider, model }) => [provider, model]), [
    ['claude', 'claude-opus-5-5'],
    ['codex', 'gpt-6.1-sol'],
  ]);

  const fallback = eligibleModels(config.approach, {
    claude: available(100),
    codex: available(10),
  }, allCommands);
  assert.deepEqual(fallback.map(({ provider, model }) => [provider, model]), [
    ['codex', 'gpt-6.1-sol'],
  ]);

  const normalFallback = eligibleModels(config.pr_normal, {
    codex: available(100),
    claude: available(5),
  }, (command) => command === 'claude');
  assert.deepEqual(normalFallback.map(({ provider, model }) => [provider, model]), [
    ['claude', 'claude-sonnet-5-5'],
  ]);
});

test('a tag can name the reviewer, within the rules', () => {
  const req = parseRequest('Plan below.\n@tess-review pr provider=codex model=gpt-6.1-terra effort=high\nthanks');
  assert.deepEqual(req, { provider: 'codex', model: 'gpt-6.1-terra', effort: 'high' });
  const normal = resolveReviewers(config, config.pr_normal, req, 'normal');
  assert.deepEqual(normal.models[0], { provider: 'codex', model: 'gpt-6.1-terra', effort: 'high' });
  assert.equal(normal.note, '');
  // sensitive work refuses a lighter model and falls back to the strong defaults
  const sensitive = resolveReviewers(config, config.pr_sensitive, req, 'sensitive');
  assert.deepEqual(sensitive.models, config.pr_sensitive); assert.match(sensitive.note, /sensitive work needs/);
  // unknown models and odd values are refused
  assert.match(resolveReviewers(config, config.pr_normal, { provider: 'codex', model: 'gpt-9' }, 'normal').note, /not in/);
  assert.match(resolveReviewers(config, config.pr_normal, { provider: 'claude', model: 'claude-opus-5-5', effort: 'ultra' }, 'normal').note, /effort/);
  assert.deepEqual(parseRequest('@tess-review pr model=$(touch x)'), {});
  assert.deepEqual(resolveReviewers(config, config.pr_normal, {}, 'normal').models, config.pr_normal);
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
    CODEX_API_KEY: 'codex-key-' + 'c'.repeat(20),
    CURSOR_API_KEY: 'cursor-key-' + 'd'.repeat(20),
    OPENCODE_API_KEY: 'opencode-key-' + 'e'.repeat(20),
    ZHIPU_API_KEY: 'zhipu-key-' + 'f'.repeat(20),
    HOME: '/home/r',
  };
  for (const name of ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'OPENCODE_API_KEY', 'ZHIPU_API_KEY']) {
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
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', CODEX_API_KEY: 'ck', CURSOR_API_KEY: 'cu',
    OPENCODE_API_KEY: 'oc', ZHIPU_API_KEY: 'zp', OTHER: '1',
  };
  assert.deepEqual(Object.keys(reviewerEnv(env, 'claude')).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH', 'TMPDIR']);
  assert.deepEqual(Object.keys(reviewerEnv(env, 'opencode')).sort(),
    ['HOME', 'OPENCODE_API_KEY', 'PATH', 'TMPDIR', 'ZHIPU_API_KEY']);
  for (const provider of ['claude', 'codex', 'cursor', 'opencode']) {
    const keys = Object.keys(reviewerEnv(env, provider));
    assert.ok(!keys.includes('GH_TOKEN') && !keys.includes('GITHUB_TOKEN'), `${provider} gets no GitHub token`);
    // Exactly this provider's keys, and no other provider's. OpenCode has two signed-in connectors of its own.
    assert.deepEqual(keys.filter((key) => key.endsWith('_TOKEN') || key.endsWith('_KEY')).sort(),
      [...providerKeys[provider]].sort(), `${provider} gets only its own keys`);
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
    assert.equal(proxied.CODEX_API_KEY, undefined, 'the Codex key never enters the sandbox');
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

  // Codex has no turn or budget cap, so effort and auto-compaction are its levers, and --json is what reports tokens.
  const codex = cliArgs('codex', 'gpt-6.1-terra', 'medium', '/w', caps);
  assert.ok(codex.includes('model_auto_compact_token_limit=180000'), 'Codex compacts instead of filling its window');
  assert.ok(codex.includes('model_reasoning_effort=medium'));
  assert.ok(codex.includes('--json'), 'Codex reports the tokens a review used');
  assert.ok(codex.includes('--skip-git-repo-check'), 'the review copy has no .git, so Codex has to be told that');

  // Cursor has no cap it can be told about, so the timeout is its only limit and only its own models are allowed.
  assert.deepEqual(config.allowed.cursor, ['composer-2.5'], 'a GPT or Claude model inside Cursor bills prepaid credit');
  assert.equal(flag(cliArgs('cursor', 'composer-2.5', undefined, '/w', caps), '--mode'), 'ask');

  // OpenCode takes its step limit from its agent file, which the runner must copy exactly, so the two numbers must agree.
  const agent = readFileSync(new URL('./opencode-reviewer.md', import.meta.url), 'utf8');
  assert.equal(Number(agent.match(/^steps:\s*(\d+)$/m)?.[1]), caps.opencode.steps,
    'the agent file and agents.json carry the same OpenCode step cap');

  // The caps are in the config, so one edit changes them everywhere, and a config with no caps is still bounded.
  assert.equal(capsFor({}).timeout_s, 600);
  assert.equal(capsFor({}).claude.max_turns, 12);
  assert.equal(capsFor({ caps: { timeout_s: 90 } }).timeout_s, 90);
});

test('a review that runs past its wall clock is killed, named, and the next reviewer runs', () => {
  const caps = capsFor(config);
  assert.equal(timeoutSeconds({ provider: 'codex', model: 'gpt-6.1-sol' }, caps), 600, 'the default is 10 minutes');
  assert.equal(timeoutSeconds({ provider: 'codex', model: 'gpt-6.1-terra' }, caps), 480, 'terra answers in less');
  assert.equal(timeoutSeconds({ provider: 'cursor', model: 'composer-2.5' }, caps), 480);
  assert.equal(timeoutSeconds({ provider: 'claude', model: 'claude-opus-5-5' }, caps), 600);

  const models = [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude', model: 'claude-opus-5-5' }];
  const called = [];
  const result = runReviewer(models, 'prompt', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: () => null,
    caps,
    invoke: (provider) => {
      called.push(provider);
      return provider === 'codex'
        ? { status: null, stdout: '', stderr: '', timedOut: true }
        : { status: 0, text: 'Looks right.\nVerdict: approve', usage: { turns: 4, costUsd: 0.0521, input: 20400, output: 1300 } };
    },
  });
  assert.deepEqual(called, ['codex', 'claude'], 'the killed reviewer did not stop the review');
  assert.equal(result.provider, 'claude');
  assert.match(skippedLine(result), /codex\/gpt-6\.1-sol \(timed out after 600s\)/,
    'the comment says the review hit its limit');
  assert.match(usedLine(result, caps), /\$0\.0521 of its \$0\.6 cap/, 'and what the review that ran actually used');
  assert.match(usedLine(result, caps), /4 turns/);
  assert.match(usedLine(result, caps), /21,700 tokens \(20,400 in, 1,300 out\)/);

  // Every reviewer out of time stops the review with the reason, instead of waiting forever.
  assert.throws(() => runReviewer(models, 'prompt', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: () => null,
    caps,
    invoke: () => ({ timedOut: true }),
  }), /every configured reviewer was skipped: .*timed out after/);

  // A reviewer that reports nothing about its usage adds no line rather than a guess.
  assert.equal(usedLine({ provider: 'cursor', model: 'composer-2.5', usage: null }, caps), '');
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
  const models = [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude', model: 'claude-sonnet-5-5' }];
  const called = [];
  const result = runReviewer(models, 'prompt', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: () => null,
    caps: capsFor(config),
    snapshot: fresh,
    now,
    invoke: (provider) => {
      called.push(provider);
      return { status: 0, text: 'Looks right.\nVerdict: approve' };
    },
  });
  assert.deepEqual(called, ['claude']);
  assert.match(skippedLine(result), /codex\/gpt-6\.1-sol \(fewer than 3 reviews left in its session window\)/);
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

  const models = [codexModel, claudeModel];
  const called = [];
  const result = runReviewer(models, 'prompt', '/w', {
    usageFor: (provider) => (provider === 'codex' ? { windows: [{ kind: 'weekly', usedPercent: 100 }] } : undefined),
    commandAvailable: () => true,
    sandbox: () => null,
    caps: capsFor(config),
    snapshot: codexOnlyPartial,
    now,
    invoke: (provider) => {
      called.push(provider);
      return { status: 0, text: 'Looks right.\nVerdict: approve' };
    },
  });
  assert.deepEqual(called, ['claude'], 'exhausted local codex is still skipped');
  assert.match(skippedLine(result), /codex\/gpt-6\.1-sol \(no usage left in its weekly window\)/);
  assert.equal(usageNote(result), '', 'partially malformed snapshot is not cited');

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

test('a snapshot can never loosen a limit and an exhausted local reading always wins', () => {
  const now = Date.parse('2026-11-15T04:40:00Z');
  const codexModel = { provider: 'codex', model: 'gpt-6.1-sol' };
  const claudeModel = { provider: 'claude', model: 'claude-sonnet-5-5' };
  const models = [codexModel, claudeModel];
  const healthySnapshot = (windows) => ({
    source: 'mac',
    takenAt: now - 60000,
    ageMs: 60000,
    providers: [{ provider: 'codex', instance: 'codex', windows }],
  });

  // 1. Exhausted local reading on the same window kind + healthy snapshot => skipped.
  const sameKindCalled = [];
  const sameKindResult = runReviewer(models, 'prompt', '/w', {
    usageFor: (provider) => (provider === 'codex' ? { windows: [{ kind: 'session', usedPercent: 100 }] } : undefined),
    commandAvailable: () => true,
    sandbox: () => null,
    caps: capsFor(config),
    snapshot: healthySnapshot([{ kind: 'session', leftPercent: 100, resetsAt: '2099-01-01T00:00:00Z' }]),
    now,
    invoke: (provider) => {
      sameKindCalled.push(provider);
      return { status: 0, text: 'Looks right.\nVerdict: approve' };
    },
  });
  assert.deepEqual(sameKindCalled, ['claude']);
  assert.match(skippedLine(sameKindResult), /codex\/gpt-6\.1-sol \(no usage left in its session window\)/);

  // 2. Exhausted local reading on a different window kind + healthy snapshot => skipped.
  const diffKindCalled = [];
  const diffKindResult = runReviewer(models, 'prompt', '/w', {
    usageFor: (provider) => (provider === 'codex' ? { windows: [{ kind: 'weekly', usedPercent: 100 }] } : undefined),
    commandAvailable: () => true,
    sandbox: () => null,
    caps: capsFor(config),
    snapshot: healthySnapshot([{ kind: 'session', leftPercent: 100, resetsAt: '2099-01-01T00:00:00Z' }]),
    now,
    invoke: (provider) => {
      diffKindCalled.push(provider);
      return { status: 0, text: 'Looks right.\nVerdict: approve' };
    },
  });
  assert.deepEqual(diffKindCalled, ['claude']);
  assert.match(skippedLine(diffKindResult), /codex\/gpt-6\.1-sol \(no usage left in its weekly window\)/);

  // 3. Same window kind in both: lower % left wins (tighter local beats looser snapshot, and tighter snapshot beats looser local).
  const tighterLocal = reviewerCandidates([codexModel], {
    usageByProvider: { codex: { windows: [{ kind: 'session', usedPercent: 85 }] } }, // 15% left (< 21% floor for gpt-6.1-sol)
    usageByModel: { 'codex/gpt-6.1-sol': { windows: [{ kind: 'session', usedPercent: 10 }] } }, // 90% left
    caps: capsFor(config),
    now,
  });
  assert.deepEqual(tighterLocal.candidates, []);
  assert.match(tighterLocal.skipped[0].reason, /fewer than 3 reviews left in its session window/);

  const tighterSnapshot = reviewerCandidates([codexModel], {
    usageByProvider: { codex: { windows: [{ kind: 'session', usedPercent: 10 }] } }, // 90% left
    usageByModel: { 'codex/gpt-6.1-sol': { windows: [{ kind: 'session', usedPercent: 85 }] } }, // 15% left
    caps: capsFor(config),
    now,
  });
  assert.deepEqual(tighterSnapshot.candidates, []);
  assert.match(tighterSnapshot.skipped[0].reason, /fewer than 3 reviews left in its session window/);

  // 4. An already-reset local window does not block when the active snapshot is healthy.
  const expiredLocal = reviewerCandidates([codexModel], {
    usageByProvider: { codex: { windows: [{ kind: 'session', usedPercent: 100, resetsAt: '2020-01-01T00:00:00Z' }] } },
    usageByModel: { 'codex/gpt-6.1-sol': { windows: [{ kind: 'session', usedPercent: 20, resetsAt: '2099-01-01T00:00:00Z' }] } },
    caps: capsFor(config),
    now,
  });
  assert.deepEqual(expiredLocal.candidates, [codexModel]);
});

test('malformed or empty snapshot data never crashes selection and falls back to the local hub', () => {
  const now = Date.parse('2026-11-15T04:40:00Z');
  const takenAt = new Date(now - 60000).toISOString();
  const codexModel = { provider: 'codex', model: 'gpt-6.1-sol' };

  // Empty, malformed JSON, wrong top-level types, missing windows, and empty providers all yield null.
  for (const raw of [
    '',
    '   ',
    '{not json',
    'null',
    '[]',
    '"hello"',
    '123',
    JSON.stringify({ version: 1, machine: 'mac', takenAt, providers: 'nope' }),
    JSON.stringify({ version: 1, machine: 'mac', takenAt, providers: [] }),
    JSON.stringify({ version: 1, machine: 'mac', takenAt, providers: [null] }),
    JSON.stringify({ version: 1, machine: 'mac', takenAt, providers: [{ provider: 'codex', instance: 'codex' }] }),
    JSON.stringify({ version: 1, machine: 'mac', takenAt, providers: [{ provider: 'codex', instance: 'codex', windows: 'bad' }] }),
    JSON.stringify({ version: 1, machine: 'mac', takenAt, providers: [{ provider: 'codex', instance: 'codex', windows: [] }] }),
    JSON.stringify({ version: 1, machine: 'mac', takenAt, providers: [{ provider: 'codex', instance: 'codex', windows: [null, { kind: 'session', leftPercent: '100' }] }] }),
  ]) {
    assert.equal(parseSnapshot('USAGE_SNAPSHOT_MAC', raw, now), null, `rejected: ${raw}`);
    assert.equal(freshestSnapshot({ USAGE_SNAPSHOT_MAC: raw }, now), null);
  }

  // Exported snapshotUsage must also reject malformed/empty entries without crashing or bypassing the local hub.
  for (const bad of [
    null,
    {},
    { providers: 'bad' },
    { providers: [null] },
    { providers: [{ provider: 'codex', instance: 'codex' }] },
    { providers: [{ provider: 'codex', instance: 'codex', windows: 'bad' }] },
    { providers: [{ provider: 'codex', instance: 'codex', windows: [] }] },
    { providers: [{ provider: 'codex', instance: 'codex', windows: [null] }] },
    { providers: [{ provider: 'codex', instance: 'codex', windows: [{ kind: 'session', leftPercent: '100' }] }] },
    { providers: [{ provider: 'codex', instance: 'codex', windows: [{ kind: 'session', leftPercent: Number.NaN }] }] },
    { providers: [{ provider: 'codex', instance: 'codex', windows: [{ kind: 'session', leftPercent: 50, resetsAt: 'not-a-date' }] }] },
  ]) {
    assert.equal(snapshotUsage(bad, codexModel), undefined);
  }

  // Regression: a fresh snapshot with providers: [null] or empty windows must NOT bypass an exhausted local hub.
  const models = [codexModel, { provider: 'claude', model: 'claude-sonnet-5-5' }];
  for (const badProviders of [
    [null],
    [{ provider: 'codex', instance: 'codex', windows: [] }],
    [{ provider: 'codex', instance: 'codex', windows: [{ kind: 'session', leftPercent: 'bad' }] }],
  ]) {
    const called = [];
    const result = runReviewer(models, 'prompt', '/w', {
      usageFor: (provider) => (provider === 'codex' ? { windows: [{ kind: 'session', usedPercent: 100 }] } : undefined),
      commandAvailable: () => true,
      sandbox: () => null,
      caps: capsFor(config),
      snapshot: { source: 'mac', takenAt: now - 60000, ageMs: 60000, providers: badProviders },
      now,
      invoke: (provider) => {
        called.push(provider);
        return { status: 0, text: 'Looks right.\nVerdict: approve' };
      },
    });
    assert.deepEqual(called, ['claude'], 'exhausted local codex is still skipped');
    assert.match(skippedLine(result), /codex\/gpt-6\.1-sol \(no usage left in its session window\)/);
    assert.equal(usageNote(result), '', 'invalid snapshot is not cited in the comment');
  }

  // Direct usageProblem / reserveProblem also tolerate malformed window arrays without crashing.
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

test('a real failure is not mistaken for a bad flag, and a skip is never silent', () => {
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

  // the comment says what was skipped, so a dropped flag cannot move every review to the second model unnoticed
  assert.equal(skippedLine({ skipped: [] }), '');
  assert.equal(skippedLine({}), '');
  assert.equal(skippedLine({ skipped: ['opencode/opencode-go/glm-5.3 (rejected a flag)'] }),
    '\nSkipped: opencode/opencode-go/glm-5.3 (rejected a flag)');
  const source = readFileSync(new URL('./agent-review.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/\$\{skippedLine\(result\)\}/g) || []).length, 2, 'both comment paths report a skip');
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
      assert.ok(refused.status === 401 || refused.status === 404, `${attempt.url} → ${refused.status}`);
      assert.ok(!refused.body.includes('sk-ant-oat01-real'), 'a refusal never quotes the key');
    }
    assert.equal(upstream.seen.length, 1, 'a refused call never reaches the provider');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('the sandbox is pointed at the proxy, and the proxy process serves it', async () => {
  const upstream = await fakeUpstream();
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
    assert.deepEqual(settings.removedKeys, ['CODEX_API_KEY', 'OPENAI_API_KEY']);

    const answer = await httpRequest(`${url}/codex/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer codex-review-token' }, body: '{"model":"gpt-6.1-terra"}',
    });
    assert.equal(answer.status, 200);
    assert.equal(upstream.seen[0].url, '/v1/responses');
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
    assert.ok(codex.includes('model_providers.tess_review_proxy.base_url="http://127.0.0.1:1234/codex/v1"'));
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

test('a provider bubblewrap cannot run is skipped, named, and the next reviewer reviews', () => {
  const calls = [];
  const models = [
    { provider: 'codex', model: 'gpt-6.1-terra' },
    { provider: 'claude', model: 'claude-sonnet-5-5' },
  ];
  const result = runReviewer(models, 'prompt', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: (provider) => (provider === 'codex' ? 'bubblewrap is not installed (tools/runner-setup.md)' : null),
    invoke: (provider, model) => { calls.push(`${provider}/${model}`); return { status: 0, stdout: 'fine' }; },
  });
  assert.deepEqual(calls, ['claude/claude-sonnet-5-5'], 'the unsandboxed provider never starts');
  assert.equal(result.provider, 'claude');
  assert.match(skippedLine(result), /codex\/gpt-6.1-terra \(bubblewrap is not installed/,
    'the comment names the provider that could not run');

  // if no provider has a usable sandbox, the review stops loudly and nothing runs bare
  const bare = [];
  assert.throws(() => runReviewer(models, 'prompt', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: () => 'bubblewrap is not installed (tools/runner-setup.md)',
    invoke: (provider) => { bare.push(provider); return { status: 0, stdout: 'x' }; },
  }), /no reviewer could run: codex\/gpt-6.1-terra \(bubblewrap/);
  assert.deepEqual(bare, [], 'no provider ran outside the sandbox');
});

test('a requested reviewer that is filtered out is named, not silently replaced', () => {
  const pick = resolveReviewers(config, config.pr_normal, { provider: 'codex', model: 'gpt-6.1-terra' }, 'normal');
  assert.equal(pick.models[0].provider, 'codex', 'the request comes first');

  const exhausted = runReviewer(pick.models, 'p', '/w', {
    usageFor: (provider) => (provider === 'codex'
      ? { windows: [{ kind: 'session', usedPercent: 100, resetsAt: '2099-01-01T00:00:00Z' }] }
      : undefined),
    commandAvailable: () => true,
    sandbox: () => null,
    invoke: () => ({ status: 0, stdout: 'review text' }),
  });
  assert.equal(exhausted.provider, 'claude', 'the defaults still review');
  assert.match(skippedLine(exhausted), /codex\/gpt-6.1-terra \(no usage left in its session window\)/);

  const missing = runReviewer(pick.models, 'p', '/w', {
    usageFor: () => undefined,
    commandAvailable: (command) => command !== 'codex',
    sandbox: () => null,
    invoke: () => ({ status: 0, stdout: 'review text' }),
  });
  assert.match(skippedLine(missing), /codex\/gpt-6.1-terra \(no local CLI\)/);
  // both comment paths print it
  const source = readFileSync(new URL('./agent-review.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/\$\{skippedLine\(result\)\}/g) || []).length, 2);
});

test('a provider on pace to run out before its reset is skipped, even with plenty left', () => {
  const now = Date.parse('2026-11-15T03:00:00Z');
  // Claude on the morning of 15 Nov: 84% of a week gone, 2.6 days to go. Session-only reading would have spent it dry.
  assert.match(usageProblem({ windows: [
    { kind: 'session', usedPercent: 47, windowDurationMins: 300, resetsAt: '2026-11-15T07:50:00Z' },
    { kind: 'weekly', usedPercent: 84, windowDurationMins: 10080, resetsAt: '2026-11-17T18:00:00Z' },
  ] }, now), /on pace to run out before its weekly reset/);
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
  assert.deepEqual(candidates.map(({ provider }) => provider), ['codex']);
  assert.match(skipped[0].reason, /reserved for Krish's own work/);
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
  const caps = capsFor(config);
  for (const [key, pct] of Object.entries(caps.per_review_pct)) {
    assert.ok(config.cost?.[key], `${key} with a per-review cost is a model the config knows`);
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

test('the pick step chooses one provider and names the ones it skipped', () => {
  const dir = temp();
  const scriptPath = fileURLToPath(new URL('./agent-review.mjs', import.meta.url));
  const run = (args, body, extra = {}) => execFileSync(process.execPath, [scriptPath, 'pick', ...args], {
    input: body,
    encoding: 'utf8',
    env: {
      ...process.env,
      // An empty HOME keeps this machine's real usage hub out of the test.
      HOME: dir,
      GITHUB_OUTPUT: '',
      ...extra,
    },
  }).trim();
  // #93's snapshot shape: one entry per provider instance, `leftPercent` rather than `usedPercent`.
  const exhausted = (...entries) => JSON.stringify({
    version: 1,
    machine: 'mac',
    takenAt: new Date().toISOString(),
    providers: entries.map((entry) => (typeof entry === 'string'
      ? { provider: entry, instance: entry, windows: [{ kind: 'weekly', leftPercent: 0, resetsAt: '2099-01-01T00:00:00Z' }] }
      : entry)),
  });
  const claude = { provider: 'claude', instance: 'claudeAgent', windows: [{ kind: 'weekly', leftPercent: 0, resetsAt: '2099-01-01T00:00:00Z' }] };
  try {
    // With no numbers the first default is chosen, as before.
    assert.equal(run(['pr', 'normal'], '@tess-review pr'), 'provider=codex\nmodel=gpt-6.1-terra\neffort=medium\nskipped=[]');
    // A snapshot can move the choice to the next provider, and the skip is reported.
    const moved = run(['pr', 'normal'], '@tess-review pr', { USAGE_SNAPSHOT_MAC: exhausted('codex') });
    assert.match(moved, /^provider=claude\nmodel=claude-sonnet-5-5/);
    assert.match(moved, /codex\/gpt-6\.1-terra \(no usage left in its weekly window\)/);
    // The tag still decides when it names an allowed reviewer.
    assert.match(run(['approach', 'sensitive'], '@tess-review approach provider=codex model=gpt-6.1-sol'),
      /^provider=codex\nmodel=gpt-6\.1-sol/);
    // Cursor is optional and its CLI is not installed in the job, so a tag naming it falls back and says why.
    const cursorModel = config.allowed.cursor[0];
    const cursor = run(['pr', 'normal'], `@tess-review pr provider=cursor model=${cursorModel}`);
    assert.match(cursor, /^provider=codex/);
    assert.ok(cursor.includes(`cursor/${cursorModel} (its CLI is not installed in this job)`), cursor);
    // Docs-only needs no CLI at all.
    assert.match(run(['pr', 'docs'], '@tess-review pr'), /^provider=none/);
    // When every candidate is out, the job stops before installing or running anything.
    assert.throws(() => run(['approach', 'sensitive'], '@tess-review approach', {
      USAGE_SNAPSHOT_MAC: exhausted(claude, 'codex'),
    }), /no reviewer could run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the reasons the pick step skipped a reviewer reach the posted comment', () => {
  assert.deepEqual(extraSkipped({ REVIEW_SKIPPED: JSON.stringify(['codex/gpt-6.1-terra (no usage left)']) }),
    ['codex/gpt-6.1-terra (no usage left)']);
  assert.deepEqual(extraSkipped({}), []);
  assert.deepEqual(extraSkipped({ REVIEW_SKIPPED: 'not json' }), []);
  const result = runReviewer([{ provider: 'claude', model: 'claude-sonnet-5-5' }], 'p', '/w', {
    usageFor: () => undefined,
    commandAvailable: () => true,
    sandbox: () => null,
    skipped: ['codex/gpt-6.1-terra (no usage left in its weekly window)'],
    invoke: () => ({ status: 0, stdout: 'fine' }),
  });
  assert.match(skippedLine(result), /codex\/gpt-6\.1-terra \(no usage left/);
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
