// Test reviewer tier and model selection without GitHub or provider network calls.
// Usage: node tools/test-agent-review.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { claudeTools, eligibleModels, looksSecret, parseRequest, providerHasUsage, resolveReviewers, reviewerEnv, snapshot, tierForPaths } from './agent-review.mjs';
import { existsSync, rmSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../.github/agents.json', import.meta.url), 'utf8'));
const available = (usedPercent) => ({ windows: [{ usedPercent }] });

test('review roles keep the requested model order', () => {
  assert.deepEqual(config.approach, [
    { provider: 'claude', model: 'claude-opus-5-5' },
    { provider: 'codex', model: 'gpt-6.1-sol' },
  ]);
  assert.deepEqual(config.pr_normal, [
    { provider: 'codex', model: 'gpt-6.1-terra' },
    { provider: 'claude', model: 'claude-sonnet-5-5' },
  ]);
  assert.deepEqual(config.pr_sensitive, config.approach);
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

test('the reviewer gets Claude its sign-in but never the GitHub token', () => {
  const env = reviewerEnv({ HOME: '/home/r', PATH: '/bin', GH_TOKEN: 'ghs_x', GITHUB_TOKEN: 'ghs_y', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', OTHER: '1' });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']);
  assert.ok(looksSecret('sk-ant-oat01-' + 'a'.repeat(80)));
});

test('the reviewer reads a throwaway copy with read-only tools only', () => {
  assert.deepEqual(claudeTools.split(','), ['Read', 'Grep', 'Glob']);
  const dir = snapshot('HEAD');
  try {
    assert.ok(existsSync(`${dir}/AGENTS.md`), 'copy has the repo files');
    assert.ok(!existsSync(`${dir}/.git`), 'copy has no .git, so no remote or credentials');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!existsSync(dir), 'copy is deleted after the review');
});
