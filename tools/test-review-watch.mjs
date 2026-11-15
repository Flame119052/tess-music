// Test the watcher that turns an allowlisted GitHub tag into a T3 review thread on this machine, without GitHub, T3 or a
// provider ever being called. `io` is the one seam: every test drives the real decision code with a fake world.
// Usage: node tools/test-review-watch.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseRequest } from './agent-review.mjs';
import {
  acquireLock,
  claimSlot,
  firstLookbackMs,
  handleTag,
  readConfig,
  refusalBody,
  reviewThreadMessage,
  slotState,
  t3LaunchArgs,
  t3Providers,
  tick,
  parseThreadId,
  threadBranch,
  threadTitle,
  markSeen,
} from './review-watch/watch.mjs';

const agentConfig = JSON.parse(readFileSync(new URL('../.github/agents.json', import.meta.url), 'utf8'));
const temp = () => mkdtempSync(join(tmpdir(), 'tess-watch-test-'));

function watcherConfig(overrides = {}) {
  const dir = temp();
  return {
    dir,
    config: {
      machine: 'mac',
      repo: 'Flame119052/tess-music',
      repoPath: dir,
      stateDir: dir,
      slots: 2,
      slotWaitMs: 30 * 60 * 1000,
      slotStaleMs: 120 * 60 * 1000,
      lockStaleMs: 30 * 60 * 1000,
      allowlist: [],
      providers: t3Providers,
      statePath: join(dir, 'state.json'),
      slotDir: join(dir, 'slots'),
      lockPath: join(dir, 'tick.lock'),
      update: false,
      ...overrides,
    },
  };
}

const comment = (overrides = {}) => ({
  id: 1001,
  body: '@tess-review pr provider=opencode model=opencode-go/deepseek-v4.1-flash effort=high author=codex machine=mac',
  created_at: '2026-11-15T10:00:00Z',
  updated_at: '2026-11-15T10:00:00Z',
  user: { login: 'Flame119052' },
  issue_url: 'https://api.github.com/repos/Flame119052/tess-music/issues/95',
  ...overrides,
});

const pull = (overrides = {}) => ({
  number: 95,
  body: '## Made by\n\nGPT-6.1 Sol in Codex',
  head: { sha: 'abc123', repo: { full_name: 'Flame119052/tess-music', fork: false } },
  ...overrides,
});

// The whole outside world, faked. Each call is recorded so a test can say what the watcher did, not only what it meant.
function fakeIo(overrides = {}) {
  const calls = { posted: [], launched: [], commentReads: [], since: [] };
  let thread = 0;
  const io = {
    allowlist: () => ['Flame119052'],
    comments: (config, since) => {
      calls.commentReads.push(since);
      calls.since.push(since);
      return calls.comments || [];
    },
    pull: () => pull(),
    issue: () => ({ number: 95, title: 'A change', html_url: 'https://example.invalid/95', body: 'Closes #71' }),
    files: () => ['theme/Tess/src/core.js'],
    ci: () => 'success',
    diff: () => 'diff --git a/x b/x',
    approach: () => '@tess-review approach provider=codex model=gpt-6.1-sol author=opencode',
    post: (config, number, body) => calls.posted.push({ number, body }),
    threads: () => [],
    usage: () => undefined,
    fetchHead: () => 'abc123',
    launch: (config, args, message) => {
      thread += 1;
      calls.launched.push({ args, message });
      return `thread-${thread}`;
    },
    agentConfig: () => agentConfig,
    updateSource: () => 'no update',
    ...overrides,
  };
  return { io, calls };
}

function runTick(config, io, { now = Date.parse('2026-11-15T10:01:00Z') } = {}) {
  return tick({ config, io, now, log: () => {} });
}

test('a tag for this machine starts one thread, and every other comment is left alone', () => {
  const { config, dir } = watcherConfig();
  const { io, calls } = fakeIo();
  calls.comments = [
    comment({ id: 1, body: '@tess-review pr provider=codex model=gpt-6.1-sol author=opencode machine=github' }),
    comment({ id: 2, body: '@tess-review pr provider=codex model=gpt-6.1-sol author=opencode machine=omarchy' }),
    comment({ id: 3, user: { login: 'stranger' } }),
    comment({ id: 4, body: '<!-- tess-review-bot -->\nReview not run.' }),
    comment({ id: 5, body: 'just a thought, no tag' }),
    comment({ id: 6, body: '@tess-review pr provider=opencode model=opencode-go/deepseek-v4.1-flash effort=high author=codex machine=mac\r\nfocus: the loader\r\n' }),
    comment({ id: 7, body: '@tess-review approach provider=codex model=gpt-6.1-sol author=opencode machine=mac', issue_url: 'https://api.github.com/repos/Flame119052/tess-music/issues/71' }),
  ];

  try {
    const result = runTick(config, io);
    assert.equal(result.launched.length, 2, 'only the two tags this machine owns started threads');
    assert.equal(result.refused.length, 0);
    assert.equal(calls.posted.length, 0);
    assert.deepEqual(result.launched.map((entry) => entry.number), [95, 71]);

    // The first run looks back ten minutes, never further: installing a watcher must not replay old conversations.
    assert.equal(Date.parse(calls.since[0]), Date.parse('2026-11-15T10:01:00Z') - firstLookbackMs);

    // The same comments read again on the next tick start nothing: the ids are remembered.
    const again = runTick(config, io, { now: Date.parse('2026-11-15T10:03:00Z') });
    assert.equal(again.launched.length, 0);
    assert.equal(calls.launched.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tag that breaks a rule is answered in the same words the GitHub job uses, and starts nothing', () => {
  const { config, dir } = watcherConfig();
  const cases = [
    [comment({ id: 11, body: '@tess-review pr provider=codex model=gpt-6.1-sol author=codex machine=mac' }), /same provider/],
    [comment({ id: 12, body: '@tess-review pr provider=codex model=gpt-9 author=opencode machine=mac' }), /plans-only list/],
    [comment({ id: 13, body: '@tess-review pr provider=codex model=gpt-6.1-sol author=opencode machine=mac effort=ultra' }), /effort must be/],
    [comment({ id: 14, body: '@tess-review pr provider=codex model=gpt-6.1-sol machine=mac' }), /author/],
    [comment({ id: 16, body: '@tess-review pr provider=codex model=gpt-6.1-sol author=opencode machine=mac nope=1' }), /was not accepted/],
  ];
  try {
    for (const [entry, expected] of cases) {
      const { io, calls } = fakeIo();
      calls.comments = [entry];
      const result = runTick(config, io);
      assert.equal(result.launched.length, 0, `${entry.id} started nothing`);
      assert.equal(calls.posted.length, 1, `${entry.id} was answered once`);
      assert.equal(calls.posted[0].number, 95);
      assert.ok(calls.posted[0].body.startsWith('<!-- tess-review-bot -->'), `${entry.id} carries the marker`);
      assert.match(calls.posted[0].body, expected, `${entry.id} says why`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a watcher answers only its own machine: the VPS and the other machine are the gate\'s to refuse', () => {
  const { config, dir } = watcherConfig();
  try {
    for (const machine of ['vps', 'omarchy', 'github']) {
      const { io, calls } = fakeIo();
      calls.comments = [comment({ id: 15, body: `@tess-review pr provider=codex model=gpt-6.1-sol author=opencode machine=${machine}` })];
      const result = runTick(config, io);
      assert.deepEqual({ launched: result.launched.length, posted: calls.posted.length }, { launched: 0, posted: 0 },
        `a tag for machine=${machine} is not this watcher's`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a docs-only change is approved by CI here too, without spending a reviewer', () => {
  const { config, dir } = watcherConfig();
  const { io, calls } = fakeIo({ files: () => ['docs/workflow.md', 'AGENTS.md'] });
  calls.comments = [comment({ id: 25 })];
  try {
    const result = runTick(config, io);
    assert.equal(result.launched.length, 0, 'no thread, no provider run');
    assert.equal(calls.launched.length, 0);
    assert.match(calls.posted[0].body, /Reviewed: abc123/);
    assert.match(calls.posted[0].body, /docs-only: CI is the review/);
    assert.match(calls.posted[0].body, /Verdict: approve/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fork or a red commit is refused here too, because this machine reads the same commit', () => {
  const { config, dir } = watcherConfig();
  try {
    const fork = fakeIo({ pull: () => pull({ head: { sha: 'abc123', repo: { full_name: 'outside/tess-music', fork: true } } }) });
    fork.calls.comments = [comment()];
    assert.equal(runTick(config, fork.io).launched.length, 0);
    assert.match(fork.calls.posted[0].body, /from a fork/);
    assert.match(fork.calls.posted[0].body, /Review not run/);

    let id = 20;
    for (const ci of ['failure', 'in_progress', '']) {
      id += 1;
      const red = fakeIo({ ci: () => ci });
      red.calls.comments = [comment({ id })];
      const outcome = runTick(config, red.io);
      assert.equal(outcome.launched.length, 0, `CI ${ci || '(none)'} is not a pass`);
      assert.match(red.calls.posted[0].body, /CI has not passed/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the thread is started with the reviewer the tag named, at the commit CI passed, and told how to post', () => {
  const { config, dir } = watcherConfig();
  const { io, calls } = fakeIo();
  calls.comments = [comment({
    id: 31,
    body: '@tess-review pr provider=claude model=claude-opus-5-5 effort=high author=codex machine=mac prompt="focus on the installer fallback"',
  })];
  try {
    runTick(config, io);
    assert.equal(calls.launched.length, 1);
    const { args, message } = calls.launched[0];
    assert.deepEqual(args, [
      'thread', 'start', config.repoPath, '-',
      '--title', 'Review PR #95 with claude-opus-5-5',
      '--provider', 'claudeAgent', '--model', 'claude-opus-5-5',
      '--worktree', 'abc123', '--branch', 'tess-review-pr-95-31', '--json',
    ]);

    // The prompt carries the rules, the owner's focus, the read-only promise, and the exact comment to post.
    assert.match(message, /You are the Tess Music reviewer/);
    assert.match(message, /OWNER'S FOCUS/);
    assert.match(message, /focus on the installer fallback/);
    assert.match(message, /STAY READ-ONLY/);
    assert.match(message, /gh pr comment 95 --repo Flame119052\/tess-music --body-file -/);
    assert.match(message, /<!-- tess-review-bot -->/);
    assert.match(message, /Reviewed: abc123/);
    assert.match(message, /Tier: normal/);
    assert.match(message, /Reviewer: claude \/ claude-opus-5-5/);
    assert.match(message, /Machine: mac/);
    assert.match(message, /If it is not abc123/);
    assert.match(message, /Verdict: changes needed/);

    // The slot records which thread holds it, so a later tick can free it when the thread settles.
    const slots = slotState(config.slotDir, { slots: 2 });
    assert.equal(slots.length, 1);
    assert.equal(slots[0].owner.threadId, 'thread-1');
    assert.equal(slots[0].owner.number, 95);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a head that moved before the thread started is never reviewed, and the slot is given back', () => {
  const { config, dir } = watcherConfig();
  const { io, calls } = fakeIo({ fetchHead: () => 'def456' });
  calls.comments = [comment({ id: 41 })];
  try {
    const result = runTick(config, io);
    assert.equal(result.launched.length, 0);
    assert.equal(calls.launched.length, 0);
    assert.match(calls.posted[0].body, /head moved after the CI check \(abc123 → def456\)/);
    assert.match(calls.posted[0].body, /Verdict: changes needed/);
    assert.deepEqual(slotState(config.slotDir, { slots: 2 }), [], 'a refused review holds no slot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one machine runs a bounded number of reviews, and a waiting tag keeps its place', () => {
  const { config, dir } = watcherConfig({ slots: 1 });
  const { io, calls } = fakeIo();
  calls.comments = [comment({ id: 51 }), comment({ id: 52, created_at: '2026-11-15T10:00:30Z', updated_at: '2026-11-15T10:00:30Z' })];
  try {
    const first = runTick(config, io);
    assert.equal(first.launched.length, 1, 'the slot cap is the first tag\'s place');
    assert.equal(first.pending, 1, 'the second waits its turn instead of starting or being refused');
    assert.equal(calls.posted.length, 0, 'a tag that is still waiting is not answered yet');

    // Its thread settles: the slot is freed and the waiting tag starts on the next tick, with no second tag needed.
    const settled = fakeIo({ threads: () => [{ threadId: 'thread-1', settled: true }] });
    const second = runTick(config, settled.io, { now: Date.parse('2026-11-15T10:03:00Z') });
    assert.equal(second.launched.length, 1);
    assert.deepEqual(second.launched.map((entry) => entry.number), [95]);
    assert.equal(settled.calls.launched.length, 1);
    assert.equal(readJSON(config.statePath).tags['51'].status, 'done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tag that waits past its patience is told the lane is busy, not left silent', () => {
  const { config, dir } = watcherConfig({ slots: 1, slotWaitMs: 0 });
  const { io, calls } = fakeIo();
  calls.comments = [comment({ id: 61 }), comment({ id: 62, created_at: '2026-11-15T10:00:30Z', updated_at: '2026-11-15T10:00:30Z' })];
  try {
    const result = runTick(config, io);
    assert.equal(result.launched.length, 1);
    assert.equal(result.refused.length, 1);
    assert.match(calls.posted[0].body, /every review slot on this machine is busy/);
    assert.match(calls.posted[0].body, /Nothing ran/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tick that fires while the last one is still working does nothing at all', () => {
  const { config, dir } = watcherConfig();
  const { io, calls } = fakeIo();
  calls.comments = [comment({ id: 71 })];
  try {
    mkdirSync(config.lockPath, { recursive: true });
    const skipped = runTick(config, io);
    assert.deepEqual(skipped.launched, []);
    assert.equal(calls.commentReads.length, 0, 'GitHub is not even read while another tick holds the lock');
    assert.equal(calls.launched.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a slot left by a killed tick is reclaimed, and a live one is kept', () => {
  const { config, dir } = watcherConfig({ slots: 1, slotStaleMs: 60 * 60 * 1000 });
  const now = Date.parse('2026-11-15T12:00:00Z');
  try {
    const live = claimSlot(config.slotDir, { commentId: 81 }, { slots: 1, now: now - 10 * 60 * 1000, staleMs: 60 * 60 * 1000 });
    assert.ok(live);
    assert.equal(claimSlot(config.slotDir, { commentId: 82 }, { slots: 1, now, staleMs: 60 * 60 * 1000 }), null);
    // Two hours later nothing can still be holding it, so the machine reviews again instead of stopping for good.
    assert.ok(claimSlot(config.slotDir, { commentId: 83 }, { slots: 1, now: now + 2 * 60 * 60 * 1000, staleMs: 60 * 60 * 1000 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a no-room refusal keeps the reset time the GitHub path would show', () => {
  const body = refusalBody({
    noRoom: true,
    reason: 'mac/opencode-go/deepseek-v4.1-flash has fewer than 3 reviews left in its session window',
    resetsAt: Date.parse('2026-11-15T14:00:00Z'),
    now: Date.parse('2026-11-15T12:00:00Z'),
  });
  assert.ok(body.startsWith('<!-- tess-review-bot -->'));
  assert.match(body, /No reviewer had room to run/);
  assert.match(body, /2026-11-15 14:00 UTC/);
});

test('the watcher is configured by machine, and refuses to run as a machine a review may not use', () => {
  const dir = temp();
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ machine: 'omarchy' }));
    assert.equal(readConfig({}, file).machine, 'omarchy');
    // The environment wins for a one-off run, and the value is read in one letter case.
    assert.equal(readConfig({ TESS_REVIEW_MACHINE: 'MAC', TESS_REVIEW_SLOTS: '3' }, file).slots, 3);
    writeFileSync(file, JSON.stringify({ machine: 'vps' }));
    assert.throws(() => readConfig({}, file), /never runs on vps/);
    writeFileSync(file, JSON.stringify({}));
    assert.throws(() => readConfig({}, file), /set "machine"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pieces of a launch are small and checked: branch, title, and the thread id the CLI prints', () => {
  assert.equal(threadBranch({ role: 'pr', number: 95, commentId: 1234 }), 'tess-review-pr-95-1234');
  assert.equal(threadTitle({ role: 'pr', number: 95, model: 'gpt-6.1-sol' }), 'Review PR #95 with gpt-6.1-sol');
  assert.equal(threadTitle({ role: 'approach', number: 71, model: 'gpt-6.1-sol' }), 'Approach review for #71 with gpt-6.1-sol');
  assert.equal(parseThreadId('{"threadId":"9b158617-62f3-4a91-af5c-88e41b302bd5"}'), '9b158617-62f3-4a91-af5c-88e41b302bd5');
  assert.equal(parseThreadId('{"id":"abc"}'), 'abc');
  assert.equal(parseThreadId('thread 72424ec0-1111-2222-3333-444455556666 ready'), '72424ec0-1111-2222-3333-444455556666');
  assert.throws(() => parseThreadId('nothing here'), /no thread id/);
  // The prompt names the approach review as a comment on the issue, not a pull request.
  const approach = reviewThreadMessage({
    role: 'approach', number: 71, sha: 'main', tier: 'sensitive', machine: 'mac',
    provider: 'codex', model: 'gpt-6.1-sol', focus: '', issue: 'ISSUE', approach: 'PLAN', diff: '', repo: 'Flame119052/tess-music', projectPath: '/tmp/x',
  });
  assert.match(approach, /gh issue comment 71 --repo Flame119052\/tess-music --body-file -/);
  assert.ok(!/Reviewed:/.test(approach), 'an approach review names no commit, because it reads main');
});

test('the lock is a directory, so it cannot be left half-written', () => {
  const dir = temp();
  const now = Date.now();
  try {
    const lock = join(dir, 'tick.lock');
    assert.equal(acquireLock(lock, { now }), lock);
    assert.equal(acquireLock(lock, { now: now + 1000 }), null, 'a live lock is respected');
    assert.equal(acquireLock(lock, { now: now + 60 * 60 * 1000 }), lock, 'an abandoned lock is taken over');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('everything a tag needs is read from the same rules the GitHub job reads', () => {
  const { config, dir } = watcherConfig();
  const { io } = fakeIo();
  try {
    const request = parseRequest(comment().body);
    const outcome = handleTag({
      config,
      request,
      comment: comment({ id: 91 }),
      now: Date.parse('2026-11-15T10:01:00Z'),
      allowlist: ['Flame119052'],
      io,
      state: { seen: [] },
    });
    assert.equal(outcome.outcome, 'launch');
    assert.deepEqual(outcome.request, { provider: 'opencode', model: 'opencode-go/deepseek-v4.1-flash', effort: 'high' });
    assert.equal(outcome.tier, 'normal');
    // A tag naming a machine a review may not use is refused by the shared tag rule, not by a second copy of it.
    const vps = handleTag({
      config,
      request: parseRequest('@tess-review pr provider=codex model=gpt-6.1-sol author=opencode machine=vps'),
      comment: comment({ id: 92 }),
      now: Date.parse('2026-11-15T10:01:00Z'),
      allowlist: ['Flame119052'],
      io,
      state: { seen: [] },
    });
    // The gate owns that refusal: a Mac's watcher never answers a tag for another machine or a refused one.
    assert.equal(vps.outcome, 'skip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a comment is remembered by id, so a repeated read cannot start a second review', () => {
  const state = { version: 1, cursor: '', seen: [], tags: {} };
  markSeen(state, 5);
  markSeen(state, 5);
  assert.deepEqual(state.seen, [5]);
  assert.ok(existsSync, 'the module loads');
});

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
