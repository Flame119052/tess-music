// Test reviewer tier and model selection without GitHub or provider network calls.
// Usage: node tools/test-agent-review.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { eligibleModels, providerHasUsage, tierForPaths } from './agent-review.mjs';

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
