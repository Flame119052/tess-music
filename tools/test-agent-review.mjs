// Test reviewer tier, model selection, sandbox prep and the deny-everything agent without GitHub or provider calls.
// Usage: node tools/test-agent-review.mjs
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  headMismatchMessage,
  looksSecret,
  parseClaudeOutput,
  parseCodexOutput,
  parseRequest,
  providerHasUsage,
  reserveProblem,
  reservationEnd,
  resolveReviewers,
  reviewerEnv,
  reviewerCandidates,
  reviewCost,
  reviewCostPercent,
  reviewsToKeep,
  runReviewer,
  sandboxArgv,
  sandboxHome,
  sandboxProblem,
  skipReason,
  skippedLine,
  snapshot,
  stripAgentConfig,
  timeoutSeconds,
  tierForPaths,
  usageProblem,
  usedLine,
  verifyPrHead,
} from './agent-review.mjs';

const config = JSON.parse(readFileSync(new URL('../.github/agents.json', import.meta.url), 'utf8'));
const agentFile = new URL('../tools/opencode-reviewer.md', import.meta.url);
const agentText = readFileSync(agentFile, 'utf8');
const available = (usedPercent) => ({ windows: [{ usedPercent }] });
// stays true when the failure is about the runner (a flag, a usage limit) rather than about the change
const retries = (result) => skipReason(result) !== null;
const temp = () => mkdtempSync(join(tmpdir(), 'tess-test-'));

// Run the workflow's machine-picking step for real, with fake `curl` and `sleep` in front of PATH, using the same shell
// options GitHub Actions uses for `run:` blocks (`bash --noprofile --norc -eo pipefail`).
function pickMachine({ wakeUrl, readyBody = '', curlFails = false, curlExit = 0, readyOnTry = 1, countCalls = false, expectUrl }) {
  const workflow = readFileSync(new URL('../.github/workflows/agent-review.yml', import.meta.url), 'utf8').split('\n');
  const stepLines = workflow.filter((line) => line.trim() === '- name: Pick the reviewer machine (Instabox first, then the VPS or omarchy)');
  assert.equal(stepLines.length, 1, 'the workflow has exactly one machine-picking step');
  const start = workflow.findIndex((line) => line.trim() === '- name: Pick the reviewer machine (Instabox first, then the VPS or omarchy)');
  assert.ok(start > 0, 'the workflow still has the machine step');
  const runAt = workflow.findIndex((line, i) => i > start && line.trim() === 'run: |');
  assert.ok(workflow.slice(start, runAt).some((line) => line.trim() === "if: steps.gate.outputs.allowed == 'true'"),
    'the Instabox wake probe only runs after the gate allows the caller');
  const indent = workflow[runAt].search(/\S/);
  const script = [];
  for (const line of workflow.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    script.push(line.slice(indent + 2));
  }

  const dir = mkdtempSync(join(tmpdir(), 'tess-machine-'));
  try {
    const out = join(dir, 'output');
    writeFileSync(out, '');
    // The fake curl records the arguments it was given, so the test checks the URL the workflow actually asks for, not
    // just the answer it gets back. One line per call, which also drives the "wakes on a later try" case.
    const calls = join(dir, 'calls');
    writeFileSync(join(dir, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n` + (curlFails
      ? 'exit 7\n'
      : `[ "$(wc -l < '${calls}')" -ge ${readyOnTry} ] && printf '%s' '${readyBody}'\nprintf '|200'\nexit ${curlExit}\n`));
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'curl'), 0o755);
    chmodSync(join(dir, 'sleep'), 0o755);
    const env = { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: out, HOME: dir };
    if (wakeUrl !== undefined) env.WAKE_URL = wakeUrl;
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script.join('\n')], { env, stdio: 'pipe' });
    const result = readFileSync(out, 'utf8').trim();
    if (expectUrl) {
      const asked = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
      assert.ok(asked.length > 0, 'the step asked the wake URL something');
      for (const line of asked) assert.ok(line.endsWith(` ${expectUrl}`), `asked for ${line}, wanted ...${expectUrl}`);
    }
    if (!countCalls) return result;
    return { result, calls: existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no wake URL keeps the old behaviour: any tess-agent runner', () => {
  assert.equal(pickMachine({}), 'runs_on=["self-hosted","tess-agent"]');
  assert.equal(pickMachine({ wakeUrl: '' }), 'runs_on=["self-hosted","tess-agent"]');
});

test('only the exact ready answer pins the job to Instabox', () => {
  const pinned = 'runs_on=["self-hosted","tess-agent","tess-primary"]';
  // REVIEW_WAKE_URL is the box's host (the step adds /ready itself), so a value without a path is the real shape.
  assert.equal(pickMachine({ wakeUrl: 'https://box.example', readyBody: 'tess-ready', expectUrl: 'https://box.example/ready' }), pinned);
  // A trailing slash must not turn the request into //ready, and a platform's 200 "starting…" page is not ready.
  assert.equal(pickMachine({ wakeUrl: 'https://box.example/', readyBody: 'tess-ready', expectUrl: 'https://box.example/ready' }), pinned);
  const backup = 'runs_on=["self-hosted","tess-agent","tess-backup"]';
  assert.equal(pickMachine({ wakeUrl: 'https://box.example', readyBody: 'starting…', expectUrl: 'https://box.example/ready' }), backup);
  assert.equal(pickMachine({ wakeUrl: 'https://box.example', curlFails: true, expectUrl: 'https://box.example/ready' }), backup);
  // Trailing newlines are not trimmed into a match, and a curl that fails after printing the ready text doesn't count.
  assert.equal(pickMachine({ wakeUrl: 'https://box.example', readyBody: 'tess-ready\n\n' }), backup);
  assert.equal(pickMachine({ wakeUrl: 'https://box.example', readyBody: 'tess-ready', curlExit: 7 }), backup);
});

test('a box that wakes on a later try still gets the job, and the check gives up after 12 tries', () => {
  const late = pickMachine({ wakeUrl: 'https://box.example', readyBody: 'tess-ready', readyOnTry: 3, countCalls: true });
  assert.deepEqual(late, { result: 'runs_on=["self-hosted","tess-agent","tess-primary"]', calls: 3 });
  const never = pickMachine({ wakeUrl: 'https://box.example', curlFails: true, countCalls: true });
  assert.deepEqual(never, { result: 'runs_on=["self-hosted","tess-agent","tess-backup"]', calls: 12 });
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

    // And if the PR moves between FETCH_HEAD and `gh pr diff`, it still refuses before snapshotting or running a model.
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
  printf 'cafebabe\\n'
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
    HOME: '/home/r',
  };
  for (const name of ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'OPENCODE_API_KEY']) {
    assert.ok(containsHeldSecret(`the environment had ${env[name]} in it`, env), name);
  }
  assert.ok(!containsHeldSecret('Looks fine. The swap keeps a checked copy.', env));
  // the check is about the job's own keys, not about guessing what a key looks like
  assert.ok(!containsHeldSecret('GLM is cheap and DeepSeek is cheaper', env));
  // values too short to be a key are ignored, so a common word cannot block every review
  assert.ok(!containsHeldSecret('the token is abc', { GH_TOKEN: 'abc' }));
  assert.ok(!containsHeldSecret('nothing held', {}));
});

test('the reviewer gets only its own provider key, never the GitHub token', () => {
  const env = {
    HOME: '/home/r', PATH: '/bin', TMPDIR: '/tmp', GH_TOKEN: 'ghs_x', GITHUB_TOKEN: 'ghs_y',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', CODEX_API_KEY: 'ck', CURSOR_API_KEY: 'cu', OPENCODE_API_KEY: 'oc',
    OTHER: '1',
  };
  assert.deepEqual(Object.keys(reviewerEnv(env, 'claude')).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH', 'TMPDIR']);
  assert.deepEqual(Object.keys(reviewerEnv(env, 'opencode')).sort(), ['HOME', 'OPENCODE_API_KEY', 'PATH', 'TMPDIR']);
  for (const provider of ['claude', 'codex', 'cursor', 'opencode']) {
    const keys = Object.keys(reviewerEnv(env, provider));
    assert.ok(!keys.includes('GH_TOKEN') && !keys.includes('GITHUB_TOKEN'), `${provider} gets no GitHub token`);
    assert.equal(keys.filter((key) => key.endsWith('_TOKEN') || key.endsWith('_KEY')).length, 1, `${provider} gets one key`);
  }
  // no provider means no key at all, rather than every key
  assert.deepEqual(Object.keys(reviewerEnv(env, 'nobody')).sort(), ['HOME', 'PATH', 'TMPDIR']);
  assert.ok(looksSecret('sk-ant-oat01-' + 'a'.repeat(80)));
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

// Address arithmetic for the drop-in below, kept here rather than in tools/ because nothing else needs it.
function addressBits(text) {
  if (!text.includes(':')) {
    const parts = text.split('.').map(Number);
    assert.equal(parts.length, 4, `bad IPv4 address ${text}`);
    return { family: 4, width: 32, value: parts.reduce((acc, part) => (acc << 8n) | BigInt(part), 0n) };
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = text.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  assert.equal(groups.length, 8, `bad IPv6 address ${text}`);
  return { family: 6, width: 128, value: groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group || '0', 16)), 0n) };
}

function networkOf(text) {
  const [address, bits] = text.split('/');
  const parsed = addressBits(address);
  const width = bits === undefined ? parsed.width : Number(bits);
  return { family: parsed.family, width, text, value: parsed.value >> BigInt(parsed.width - width) };
}

// `outer` holds all of `range`: same family, at least as wide, and the same leading bits.
const covers = (outer, range) => outer.family === range.family && outer.width <= range.width
  && (range.value >> BigInt(range.width - outer.width)) === outer.value;

// The network boundary is the runner service, not a CLI flag, so it covers Claude and every other provider at once.
// bubblewrap keeps the host network namespace on purpose, because the review's API call needs it: an untrusted diff
// that talks a model into running a shell command must still reach only its provider. On paperclip-vps the rest of the
// namespace is Paperclip's PostgreSQL, its services and the Tincan relay.
test('the runner network drop-in refuses the machine and its local networks', () => {
  const conf = readFileSync(new URL('./runner/network.conf', import.meta.url), 'utf8');
  const lines = conf.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  assert.equal(lines.shift(), '[Service]', 'it is a drop-in for the runner service, not a whole unit');
  for (const line of lines) {
    assert.match(line, /^IPAddress(Allow|Deny)=/, `a drop-in sets these two keys and nothing else: ${line}`);
  }
  const values = (key) => lines.filter((line) => line.startsWith(`${key}=`))
    .flatMap((line) => line.slice(key.length + 1).split(/\s+/).filter(Boolean));

  const deny = values('IPAddressDeny').map(networkOf);
  for (const required of ['127.0.0.0/8', '::1/128', '169.254.0.0/16', 'fe80::/10', '224.0.0.0/4', 'ff00::/8',
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fc00::/7']) {
    const range = networkOf(required);
    assert.ok(deny.some((entry) => covers(entry, range)), `${required} is refused`);
  }

  // The allow list is the only hole, so it holds single addresses and only a local resolver: never a range, never a
  // LAN address, never something that could carry a service.
  const allow = values('IPAddressAllow').map(networkOf);
  assert.ok(allow.length, 'DNS itself must still resolve, or no provider can be reached');
  for (const entry of allow) {
    assert.equal(entry.width, entry.family === 4 ? 32 : 128, `${entry.text} is one address, not a range`);
    assert.ok(covers(networkOf('127.0.0.0/8'), entry) || covers(networkOf('::1/128'), entry),
      `${entry.text} is a loopback address`);
  }
  // Ubuntu's systemd-resolved answers on this stub, so the shipped file has to let it through.
  assert.ok(allow.some((entry) => entry.family === 4 && entry.value === addressBits('127.0.0.53').value),
    'the systemd-resolved stub is allowed');

  // The setup page says where the file goes, how to tell what is really in force, and both ways DNS is set up.
  const setup = readFileSync(new URL('./runner-setup.md', import.meta.url), 'utf8');
  assert.match(setup, /tools\/runner\/network\.conf/, 'the setup page names the file');
  assert.match(setup, /actions\.runner\.[^\s`]*\.service\.d/, 'and the unit folder it goes in');
  assert.match(setup, /127\.0\.0\.1:5432/, 'the doc checks a local service stays unreachable');
  assert.match(setup, /169\.254\.169\.254/, 'and the cloud metadata address');
  assert.match(setup, /systemd-resolved/, 'the doc handles the resolved stub');
  assert.match(setup, /Arch|omarchy/, 'and the Arch case, where the resolver is usually the router');
  assert.match(setup, /approves|approve/, 'and says applying it to a machine is the owner\'s decision');
});

test("an npm-installed CLI starts: its package folder and its own Node are bound", () => {
  const dir = temp();
  try {
    const pkg = join(dir, 'node_modules', '@openai', 'codex');
    const bin = join(pkg, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex.js'), '#!/usr/bin/env node\n// entry point\n');
    const nodeDir = join(dir, 'node');
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, 'node'), 'x');

    const sandbox = sandboxArgv('codex', '/work', ['exec', '-'], {
      home: '/home/r', commandPath: join(bin, 'codex.js'), nodePath: join(nodeDir, 'node'),
    });
    const binds = sandbox.args.flatMap((arg, index) =>
      arg === '--ro-bind' ? [sandbox.args[index + 1]] : []);
    assert.ok(binds.includes(pkg), 'the whole package is bound, not just its entry file');
    assert.ok(binds.includes(nodeDir), "the CLI's own Node is bound, even outside /usr");
    assert.ok(sandbox.path.startsWith(`${nodeDir}:`), 'and that Node leads PATH, because the entry asks for `node`');
    assert.equal(sandbox.args.at(-3), join(bin, 'codex.js'), 'the entry point is still started by absolute path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
