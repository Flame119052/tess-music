// Test the usage publisher without a real hub or GitHub: the shape it publishes, what it refuses, and how it calls gh.
// Usage: node tools/test-usage-publish.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, parseTessUsage, providerFor, snapshotProblem, variableName } from './usage-publish/publish.mjs';

// Captured from `tess-usage` (no argument) on 15 Nov 2026, with the lines cut to the parts the publisher reads.
const hubText = [
  '- Devin (Cognition-Devin, acpRegistry_devin): Daily [session]: 100% left · resets in 3h 43m (2026-11-15T08:00:00.000Z) · pace: 84.5pp behind even burn, no burn observed; run-out unknown; Weekly (overage) [weekly]: 0% left · resets in 3h 43m (2026-11-15T08:00:00.000Z) · pace: 2.2pp ahead of even burn, 0% left now; Overage balance: $-0.23 USD [other]: 0% left · pace: unknown (window length or reset missing)',
  '- Claude (claudeAgent, claudeAgent): Session [session]: 36% left · resets in 3h 33m (2026-11-15T07:50:00.093Z) · pace: 36.0pp ahead of even burn, runs out in ~2h 4m (before reset; observed history); Weekly [weekly]: 14% left · resets in 2d 13h (2026-11-17T18:00:00.000Z) · pace: 22.8pp ahead of even burn, runs out in ~7h 22m (before reset; observed history); Weekly · Fable [weekly]: 98% left · resets in 2d 13h (2026-11-17T18:00:00.093Z) · pace: 61.2pp behind even burn, no burn observed; run-out unknown',
  '- Codex (codex, codex): Session [session]: 72% left · resets in 3h 31m (2026-11-15T07:48:00.000Z) · pace: 1.5pp behind even burn, runs out in ~4h 49m (after reset; observed history); Weekly [weekly]: 86% left · resets in 6d 6h (2026-11-21T10:39:52.000Z) · pace: 3.5pp ahead of even burn, runs out in ~30h 42m (before reset; observed history)',
  '- Cursor (cursor, cursor): Cursor Models [monthly]: 38% left · resets in 2d 1h (2026-11-17T05:25:18.236Z) · pace: 8.7pp behind even burn, runs out in ~8h 26m (before reset; observed history)',
  '- OpenCode · nvidia (opencode-connector, opencode:nvidia): no usage API adapter; saved connection',
  '- OpenCode · opencode-go (opencode-connector, opencode:opencode-go): Go · 5-hour [session]: 95% left · resets in 3h 24m (2026-11-15T07:40:31.000Z) · pace: 27.1pp behind even burn, runs out in ~33h 49m (after reset; observed history); Go · weekly [weekly]: 50% left · resets in 19h 43m (2026-11-16T00:00:00.000Z) · pace: 38.3pp behind even burn, runs out in ~26h 42m (after reset; observed history)',
  '- Z.ai coding plan (OpenCode / ZCode / ZCode Lite) (opencode-connector, opencode:zai-coding-plan): 5-hour [session]: 50% left · resets in 3h 40m (2026-11-15T07:57:09.696Z) · pace: 23.5pp ahead of even burn, runs out in ~2h 19m (before reset; observed history); Service limit (0/1000) [other]: 100% left · resets in 11h 43m (2026-11-15T16:00:00.000Z) · pace: unknown (window length or reset missing)',
].join('\n');

const temp = () => mkdtempSync(join(tmpdir(), 'tess-usage-publish-'));

test('the snapshot is quota only: windows, what is left, when it resets, and the pace', () => {
  const snapshot = buildSnapshot({ machine: 'mac', takenAt: '2026-11-15T04:40:00.000Z', text: hubText });
  assert.equal(snapshot.machine, 'mac');
  assert.equal(snapshot.takenAt, '2026-11-15T04:40:00.000Z');

  const claude = snapshot.providers.find((entry) => entry.provider === 'claude');
  assert.equal(claude.instance, 'claudeAgent');
  assert.deepEqual(claude.windows.map((w) => [w.kind, w.leftPercent]), [['session', 36], ['weekly', 14], ['weekly', 98]]);
  assert.equal(claude.windows[0].resetsAt, '2026-11-15T07:50:00.093Z');
  assert.match(claude.windows[0].pace, /runs out in ~2h 4m/);
  // A pace sentence with its own semicolon is not a new window, and it stays whole.
  assert.match(claude.windows[2].pace, /no burn observed; run-out unknown$/);

  // Providers a reviewer cannot be are left out, so no balance or plan text is ever published.
  assert.deepEqual(snapshot.providers.map((entry) => entry.instance),
    ['claudeAgent', 'codex', 'cursor', 'opencode-go', 'zai-coding-plan']);
  assert.ok(!JSON.stringify(snapshot).includes('-0.23'), 'no balance');
  assert.ok(!/devin|deepseek|antigravity/i.test(JSON.stringify(snapshot)), 'no other provider');

  // The whole thing is small enough for a repository variable and holds nothing that looks like a credential.
  assert.ok(JSON.stringify(snapshot).length < 4 * 1024);
  assert.equal(snapshotProblem(snapshot), null);
});

test('an OpenCode connector keeps its own pool name, and only those are matched', () => {
  assert.deepEqual(providerFor('opencode:opencode-go'), { provider: 'opencode', instance: 'opencode-go' });
  assert.deepEqual(providerFor('claudeAgent'), { provider: 'claude', instance: 'claudeAgent' });
  assert.deepEqual(providerFor('codex'), { provider: 'codex', instance: 'codex' });
  assert.equal(providerFor('acpRegistry_devin'), null, 'Devin is not a reviewer');
  const parsed = parseTessUsage(hubText);
  assert.equal(parsed.filter((entry) => entry.provider === 'opencode').length, 2, 'one entry per connector');
  assert.equal(parsed.find((entry) => entry.instance === 'opencode-go').windows.length, 2);
});

test('one variable per machine, named after it', () => {
  assert.equal(variableName('mac'), 'USAGE_SNAPSHOT_MAC');
  assert.equal(variableName('paperclip-vps'), 'USAGE_SNAPSHOT_PAPERCLIP_VPS');
});

test('publishing sets that one variable and logs counts, never quota', () => {
  const dir = temp();
  try {
    const hub = join(dir, 'tess-usage');
    writeFileSync(hub, `#!/bin/sh\ncat "${join(dir, 'hub.txt')}"\n`);
    writeFileSync(join(dir, 'hub.txt'), hubText);
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, 'args.txt')}"\ncat > "${join(dir, 'body.json')}"\n`);
    for (const path of [hub, gh]) chmodSync(path, 0o755);

    const publish = () => spawnSync(process.execPath, ['tools/usage-publish/publish.mjs', '--machine', 'vps', '--usage', hub], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    const result = publish();
    assert.equal(result.status, 0, result.stderr);

    const args = readFileSync(join(dir, 'args.txt'), 'utf8').trim().split('\n');
    assert.deepEqual(args, ['variable', 'set', 'USAGE_SNAPSHOT_VPS', '--repo', 'Flame119052/tess-music']);
    const body = JSON.parse(readFileSync(join(dir, 'body.json'), 'utf8'));
    assert.equal(body.machine, 'vps');
    assert.ok(body.takenAt, 'the snapshot says when it was taken');
    assert.ok(body.providers.some((entry) => entry.provider === 'codex'));
    assert.equal(result.stdout, '', 'stdout stays empty, so a timer log has only the one summary line');
    // The summary names the variable and counts, and never a percentage or a token.
    assert.match(result.stderr, /published USAGE_SNAPSHOT_VPS: 5 providers, 10 windows, \d+ bytes/);
    assert.ok(!/\d+%|left in|token/i.test(result.stderr), 'the log says nothing about quota');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the flags the publisher passes are flags this gh really has', () => {
  // A fake `gh` in the test above accepts anything, so the real command's flags are checked against its own --help. This
  // caught `--body-file`, which `gh variable set` does not have: it reads the value from standard input instead.
  const help = spawnSync('gh', ['variable', 'set', '--help'], { encoding: 'utf8' });
  if (help.status !== 0) return; // no gh on this machine: nothing to check
  const source = readFileSync(new URL('./usage-publish/publish.mjs', import.meta.url), 'utf8');
  const flags = [...source.matchAll(/'(--[a-z-]+)'/g)].map((match) => match[1]);
  for (const flag of new Set(flags)) {
    assert.ok(help.stdout.includes(flag), `gh variable set accepts ${flag}`);
  }
  assert.match(help.stdout, /standard input/i, 'which is why the publisher omits --body');
});

test('a hub that fails, or a snapshot that could hold a secret, is never published', () => {
  const dir = temp();
  try {
    const failing = join(dir, 'tess-usage-fail');
    writeFileSync(failing, '#!/bin/sh\necho "hub exploded" >&2\nexit 1\n');
    const publishing = join(dir, 'gh');
    writeFileSync(publishing, `#!/bin/sh\ntouch "${join(dir, 'called')}"\n`);
    for (const path of [failing, publishing]) chmodSync(path, 0o755);

    const run = (args) => spawnSync(process.execPath, ['tools/usage-publish/publish.mjs', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
    }).status;

    assert.equal(run(['--machine', 'vps', '--usage', failing]), 2, 'a failed hub is a failure');
    assert.ok(!existsSync(join(dir, 'called')), 'and nothing is published');

    const leaky = join(dir, 'tess-usage-leaky');
    writeFileSync(leaky, `#!/bin/sh\necho "- Claude (claudeAgent, claudeAgent): Session [session]: 1% left · resets in 1m (2026-11-15T07:50:00Z) · pace: ghp_${'a'.repeat(36)}"\n`);
    chmodSync(leaky, 0o755);
    assert.equal(run(['--machine', 'vps', '--usage', leaky]), 4, 'text that looks like a token stops the publish');
    assert.ok(!existsSync(join(dir, 'called')), 'and nothing is published');

    const empty = join(dir, 'tess-usage-empty');
    writeFileSync(empty, '#!/bin/sh\necho "nothing here"\n');
    chmodSync(empty, 0o755);
    assert.equal(run(['--machine', 'vps', '--usage', empty]), 4, 'an empty snapshot is a failure, not an empty variable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
