// Test reviewer tier, model selection, sandbox prep and the deny-everything agent without GitHub or provider calls.
// Usage: node tools/test-agent-review.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  agentConfig,
  assertReviewerAgent,
  claudeTools,
  cliArgs,
  containsHeldSecret,
  eligibleModels,
  looksSecret,
  parseRequest,
  providerHasUsage,
  reserveProblem,
  reservationEnd,
  resolveReviewers,
  reviewerEnv,
  reviewerCandidates,
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
  tierForPaths,
  usageProblem,
} from './agent-review.mjs';

const config = JSON.parse(readFileSync(new URL('../.github/agents.json', import.meta.url), 'utf8'));
const agentFile = new URL('../tools/opencode-reviewer.md', import.meta.url);
const agentText = readFileSync(agentFile, 'utf8');
const available = (usedPercent) => ({ windows: [{ usedPercent }] });
// stays true when the failure is about the runner (a flag, a usage limit) rather than about the change
const retries = (result) => skipReason(result) !== null;
const temp = () => mkdtempSync(join(tmpdir(), 'tess-test-'));

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

  // one provider's own config only, never another provider's
  const codex = sandboxArgv('codex', work, [], options);
  assert.ok(codex.args.includes(`${home}/.codex`), 'codex sees its own sign-in state');
  assert.ok(!codex.args.some((arg) => arg.includes('.config/opencode')), 'codex does not see OpenCode files');
  const opencode = sandboxArgv('opencode', work, [], options);
  assert.ok(opencode.args.includes(`${home}/.config/opencode`), 'opencode sees its agent file');
  assert.ok(!opencode.args.includes(`${home}/.codex`), 'opencode does not see Codex files');
  const claude = sandboxArgv('claude', work, [], options);
  assert.ok(!claude.args.some((arg) => arg.includes('.codex') || arg.includes('.config/opencode')),
    'Claude sees neither other provider');

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
  const setup = readFileSync(new URL('./runner-setup.md', import.meta.url), 'utf8');
  assert.match(setup, /bubblewrap/, 'the runner setup asks for bubblewrap');
  assert.match(setup, /user namespaces/i, 'and shows how to check user namespaces');
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
