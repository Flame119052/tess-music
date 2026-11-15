#!/usr/bin/env node
// Watch GitHub for the review tags this machine owns, check them with the rules the GitHub job uses, and open each one
// as a T3 thread on this machine.
//
// Usage: node tools/review-watch/watch.mjs            one tick; a timer runs it every couple of minutes
//        node tools/review-watch/watch.mjs check      report what this machine needs; starts nothing
//
// Why a pull: GitHub-hosted jobs cannot reach Krish's machines, and the self-hosted runners that once could are gone
// (D-66). A watcher on the machine polls GitHub for tags that name `machine=<this machine>`, so there is no inbound
// access, no runner, and no T3 credential for GitHub to hold. The thread is started by this machine's own `t3` command
// talking to its own local server; nothing signs in from outside.
//
// The rules are not copied here. A tag is judged by `tools/agent-review.mjs` — the same parser, allowlist check, tier,
// author rule, plans-only list, usage and reserve — and this file only adds where a tag runs and how a thread is
// opened. Installing the timer is the owner's step, not a merge (README.md beside this file).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authorProvider,
  capsFor,
  docsOnlyComment,
  headMismatchMessage,
  issueText,
  linkedIssueNumber,
  machineOf,
  marker,
  noRoomComment,
  parseRequest,
  refusalComment,
  reviewPrompt,
  reviewRefusalText,
  reviewUsage,
  tagLine,
  tagProblem,
  tierForPaths,
  watcherMachines,
  headFacts,
  requestProblem,
} from '../agent-review.mjs';

export const stateVersion = 1;

// A tag posted before the watcher first ran is not replayed: installing a watcher must never start reviews of old
// conversations. Ten minutes is enough to cover a tag written while the install was being finished.
export const firstLookbackMs = 10 * 60 * 1000;

// The review's own limits, bounded the way the GitHub job bounds one: this is a tuning knob for how many review threads
// one machine runs at once, not a per-provider allowance rule.
export const defaults = {
  slots: 2,
  slotWaitMs: 30 * 60 * 1000,
  slotStaleMs: 120 * 60 * 1000,
  lockStaleMs: 30 * 60 * 1000,
  tickLimit: 100,
};

// T3's provider instance id, which is not always the review CLI's name: Claude's instance is `claudeAgent`. A machine
// may override any of these in its config, and `check` prints the mapping so it is visible before a review needs it.
export const t3Providers = { claude: 'claudeAgent', codex: 'codex', opencode: 'opencode' };

export const configPath = () => join(homedir(), '.config/tess-review-watch/config.json');
export const defaultRepoPath = () => join(homedir(), '.local/share/tess-review-watch/src');
export const defaultStateDir = () => join(homedir(), '.local/state/tess-review-watch');

const envValue = (env, name) => {
  const value = env[name]?.trim();
  return value || '';
};

// Everything machine-specific comes from one 0600 file, with the environment able to override it for a one-off run.
// There is no credential here: `gh` and `t3` use the sign-ins this machine already has.
export function readConfig(env = process.env, file = configPath()) {
  let stored = {};
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file} is not readable JSON: ${error.message}`);
    }
  }
  const machine = (envValue(env, 'TESS_REVIEW_MACHINE') || stored.machine || '').toLowerCase();
  if (!watcherMachines.includes(machine)) {
    throw new Error(`set "machine" in ${file} to one of ${watcherMachines.join(', ')} (a review never runs on vps: docs/workflow.md)`);
  }
  const repo = envValue(env, 'TESS_REVIEW_REPO') || stored.repo || 'Flame119052/tess-music';
  const repoPath = envValue(env, 'TESS_REVIEW_REPO_PATH') || stored.repoPath || defaultRepoPath();
  const stateDir = envValue(env, 'TESS_REVIEW_STATE_DIR') || stored.stateDir || defaultStateDir();
  const slots = Number(envValue(env, 'TESS_REVIEW_SLOTS') || stored.slots || defaults.slots);
  if (!Number.isInteger(slots) || slots < 1 || slots > 8) throw new Error('slots must be a whole number from 1 to 8');
  return {
    machine,
    repo,
    repoPath,
    stateDir,
    slots,
    slotWaitMs: Number(envValue(env, 'TESS_REVIEW_SLOT_WAIT_MINUTES') || 0) * 60 * 1000 || stored.slotWaitMs || defaults.slotWaitMs,
    slotStaleMs: Number(envValue(env, 'TESS_REVIEW_SLOT_STALE_MINUTES') || 0) * 60 * 1000 || stored.slotStaleMs || defaults.slotStaleMs,
    // A fallback only, for a machine whose token cannot read the repository variable: the variable stays the one list.
    allowlist: Array.isArray(stored.allowlist) ? stored.allowlist : [],
    providers: { ...t3Providers, ...(stored.providers || {}) },
    statePath: join(stateDir, 'state.json'),
    slotDir: join(stateDir, 'slots'),
    lockPath: join(stateDir, 'tick.lock'),
    update: stored.update !== false,
  };
}

export function readState(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state?.version !== stateVersion) return { version: stateVersion, cursor: '', seen: [], tags: {} };
    return {
      version: stateVersion,
      cursor: typeof state.cursor === 'string' ? state.cursor : '',
      seen: Array.isArray(state.seen) ? state.seen : [],
      tags: state.tags && typeof state.tags === 'object' ? state.tags : {},
    };
  } catch {
    return { version: stateVersion, cursor: '', seen: [], tags: {} };
  }
}

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

// The tag line says which review a comment asks for; anything before the `@` on that line is ordinary prose.
export function tagRole(body) {
  const line = tagLine(body);
  const match = line.match(/^@tess-review (approach|pr)(?:\s|$)/);
  return match ? match[1] : '';
}

// A pull request or issue number out of the comment's `issue_url`, which is what the comments API answers with.
export function issueNumberOf(issueUrl) {
  const match = String(issueUrl || '').match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

// The newest `check.yml` run for one commit decides whether CI has passed on it. A run that is still going, or one with
// any conclusion other than success, is not a pass.
export function ciConclusion(runs) {
  const sorted = [...(Array.isArray(runs) ? runs : [])]
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return sorted.at(-1)?.conclusion || '';
}

// The one guard every pull-request review passes here as well as in the workflow: this repository's own head, at the
// commit CI passed. A watcher reads the same commit, on a machine that holds keys, so a fork is refused for the same
// reason.
export function targetProblem({ role, pull, repo, conclusion }) {
  if (role !== 'pr') return null;
  const head = headFacts(pull, repo);
  if (head.problem) return { code: 'fork-pr', reason: head.problem };
  if (conclusion !== 'success') {
    return { code: 'ci-not-passed', reason: `CI on ${head.sha} is ${conclusion || 'not reported'}` };
  }
  return null;
}

// --- slots ------------------------------------------------------------------------------------------------------------
// A machine runs at most `slots` reviews at once, so a burst of tags cannot start a pile of provider runs. A slot is a
// directory, claimed atomically by `mkdir`; its owner record says which thread holds it. A slot whose record is older
// than any review could possibly run is reclaimed, or one killed tick would block this machine for good.

export function claimSlot(directory, owner, { slots = defaults.slots, now = Date.now(), staleMs = defaults.slotStaleMs } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  reclaimStaleSlots(directory, { slots, now, staleMs });
  for (let index = 1; index <= slots; index += 1) {
    const path = join(directory, `slot-${index}`);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ ...owner, claimedAt: new Date(now).toISOString() }), { mode: 0o600 });
    return path;
  }
  return null;
}

export function releaseSlot(path) {
  if (path) rmSync(path, { recursive: true, force: true });
}

export function slotState(directory, { slots = defaults.slots } = {}) {
  return Array.from({ length: slots }, (_, index) => {
    const path = join(directory, `slot-${index + 1}`);
    try {
      return { path, owner: JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) };
    } catch {
      return existsSync(path) ? { path, owner: null } : null;
    }
  }).filter(Boolean);
}

export function reclaimStaleSlots(directory, { slots = defaults.slots, now = Date.now(), staleMs = defaults.slotStaleMs } = {}) {
  const reclaimed = [];
  for (const slot of slotState(directory, { slots })) {
    const claimedAt = Date.parse(slot.owner?.claimedAt || '');
    const age = Number.isFinite(claimedAt) ? now - claimedAt : Infinity;
    if (age < staleMs) continue;
    releaseSlot(slot.path);
    reclaimed.push(slot.path);
  }
  return reclaimed;
}

// The tick's own lock. A timer that fires while the last tick is still launching threads skips this one instead of
// reading the same comments twice.
export function acquireLock(path, { now = Date.now(), staleMs = defaults.lockStaleMs } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path, { mode: 0o700 });
    return path;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let age = 0;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      age = 0;
    }
    if (age < staleMs) return null;
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { mode: 0o700 });
    return path;
  }
}

// --- the thread -------------------------------------------------------------------------------------------------------

// The prompt the thread gets: the same review instructions the GitHub job gives, the same owner's focus, and the one
// write it is allowed to make. A T3 thread runs with the machine's own rights, so this is where the read-only promise is
// made explicit — the sandbox that enforces it on GitHub's machines does not exist here.
export function reviewThreadMessage({
  role, number, sha, tier, machine, provider, model, focus, issue, approach, diff, repo, projectPath,
}) {
  const subject = role === 'pr' ? `pull request #${number}` : `issue #${number}`;
  const posting = role === 'pr'
    ? `gh pr comment ${number} --repo ${repo} --body-file -`
    : `gh issue comment ${number} --repo ${repo} --body-file -`;
  return [
    `Review Tess Music ${subject} on this machine. This thread is the review: it reads and reports; it changes nothing.`,
    '',
    reviewPrompt(role, { issue, approach, diff, focus }),
    '',
    'YOUR COPY OF THE CODE',
    `The worktree this thread started in is ${role === 'pr' ? `the exact commit ${sha}` : 'main'}, taken from ${projectPath}.`,
    'Read the diff above against that code, and cite the path and line of anything you find.',
    '',
    'STAY READ-ONLY',
    'Do not edit, add, commit, push, delete, merge, release or promote anything. Do not run, build or install anything',
    'from the change. Do not approve or request changes on GitHub. Your only write is the one review comment below.',
    '',
    'POST THE REVIEW',
    `Post it as one comment on ${subject}, with the body on standard input:`,
    `  ${posting}`,
    ...(role === 'pr' ? [
      '',
      `Before posting, ask GitHub which commit is the head now: gh api repos/${repo}/pulls/${number} --jq .head.sha`,
      `If it is not ${sha}, do not review it. Post this instead, starting with the marker line:`,
      `  ${marker}`,
      `  The pull request head moved after the tag (${sha} → the new head). Tag again once CI passes.`,
      '',
      '  Verdict: changes needed',
    ] : []),
    '',
    'The comment starts exactly like this:',
    `  ${marker}`,
    ...(role === 'pr' ? [`  Reviewed: ${sha}`, `  Tier: ${tier}`] : []),
    `  Reviewer: ${provider} / ${model}`,
    `  Machine: ${machine}`,
    '',
    ...(focus ? ['The owner\'s focus from the tag follows, so a reader can see what was asked for.', ''] : []),
    'then your findings, then one last line, exactly `Verdict: approve` or `Verdict: changes needed`.',
    `Keep the marker as the first line: it is what stops your review from starting another review.`,
  ].join('\n');
}

// How the local T3 server is asked for a thread: the project folder, the message on stdin (a diff is far too big for
// an argument), the reviewer exactly as the tag named it, and a worktree at the reviewed commit so nothing of the
// owner's checkout is touched.
export function t3LaunchArgs({ projectPath, provider, model, title, branch, base }) {
  return ['thread', 'start', projectPath, '-', '--title', title, '--provider', provider, '--model', model,
    '--worktree', base, '--branch', branch, '--json'];
}

// `t3 thread start --json` prints the new thread; the shape is accepted in its two spellings rather than guessed, and a
// plain id from an older CLI is found by shape.
export function parseThreadId(stdout) {
  const text = String(stdout || '').trim();
  try {
    const parsed = JSON.parse(text);
    const id = parsed?.threadId || parsed?.id;
    if (typeof id === 'string' && id) return id;
  } catch {
    // Not JSON: fall through to the id's shape.
  }
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (match) return match[0];
  throw new Error('t3 thread start printed no thread id');
}

export function threadTitle({ role, number, model }) {
  return `${role === 'pr' ? `Review PR #${number}` : `Approach review for #${number}`} with ${model}`;
}

export function threadBranch({ role, number, commentId }) {
  return `tess-review-${role}-${number}-${commentId}`;
}

// The body a refusal gets. Fixed codes use the fixed words the workflow posts; a rule refusal (a model that is not on
// the plans-only list, the author's own provider, a window with no room) uses the same comment the GitHub path posts,
// so the two doors say the same thing about the same rule.
export function refusalBody({ code, reason, provider = '', model = '', resetsAt = null, noRoom = false, runUrl = '', now = Date.now() }) {
  if (noRoom) return noRoomComment({ reasons: [reason], earliestResetMs: resetsAt, now });
  if (code) return reviewRefusalText(code, { runUrl });
  return refusalComment({ reason, provider, model, resetsAt });
}

// --- one tick ---------------------------------------------------------------------------------------------------------

const byCreated = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));

// The decision for one tag, with everything that needs the outside world passed in, so a test can drive every branch
// without a network, a machine or a thread. Returns what happened, never throws for a refusal.
export function handleTag({ config, request, comment, now, allowlist, io, state }) {
  const body = String(comment.body || '');
  const role = tagRole(body);
  const number = issueNumberOf(comment.issue_url);
  if (!role || !number) return { outcome: 'skip', why: 'not a review tag on a pull request or issue' };
  if (!allowlist.includes(comment.user?.login || '')) return { outcome: 'skip', why: 'the commenter is not allowlisted' };
  if (machineOf(request) !== config.machine) return { outcome: 'skip', why: 'another machine' };

  const shape = tagProblem(request);
  if (shape) return { outcome: 'refuse', code: shape.code, reason: shape.reason, number, role };

  const pull = role === 'pr' ? io.pull(config, number) : null;
  // Read the head first: a missing or fork head is refused without asking GitHub about CI for a commit that is not ours.
  const head = role === 'pr' ? headFacts(pull, config.repo) : { sha: '', problem: '' };
  const conclusion = role === 'pr' && !head.problem ? io.ci(config, head.sha) : '';
  const target = targetProblem({ role, pull, repo: config.repo, conclusion });
  if (target) return { outcome: 'refuse', code: target.code, reason: target.reason, number, role };

  const issue = io.issue(config, number);
  const authorBody = authorProvider((role === 'pr' ? pull?.body : issue?.body) || '');
  const tier = role === 'pr' ? tierForPaths(io.files(config, number)) : 'sensitive';
  // A docs-only change needs no reviewer anywhere: the same verdict the hosted path posts, naming the commit it read.
  if (tier === 'docs') {
    return { outcome: 'post', number, role, body: docsOnlyComment(headFacts(pull, config.repo).sha) };
  }
  const agentConfig = io.agentConfig(config);
  const verdict = requestProblem(agentConfig, request, {
    tier,
    author: request.author,
    authorBody,
    usage: io.usage(request, now),
    caps: capsFor(agentConfig),
    now,
    machine: config.machine,
  });
  if (!verdict.model) {
    return {
      outcome: 'refuse',
      code: verdict.code || '',
      reason: verdict.reason,
      resetsAt: verdict.resetsAt ?? null,
      noRoom: Boolean(verdict.noRoom),
      provider: request.provider || '',
      model: request.model || '',
      number,
      role,
    };
  }

  const queuedAt = Date.parse(comment.created_at || '') || now;
  const slot = claimSlot(config.slotDir, { commentId: comment.id, number, role }, {
    slots: config.slots, now, staleMs: config.slotStaleMs,
  });
  if (!slot) {
    if (now - queuedAt < config.slotWaitMs) return { outcome: 'pending', number, role, queuedAt };
    return { outcome: 'refuse', code: 'slots-busy', reason: `all ${config.slots} slots are busy`, number, role };
  }

  try {
    const base = role === 'pr' ? io.fetchHead(config, number) : 'main';
    if (role === 'pr' && base !== headFacts(pull, config.repo).sha) {
      releaseSlot(slot);
      return { outcome: 'post', number, role, body: headMismatchMessage(headFacts(pull, config.repo).sha, base) };
    }
    const message = reviewThreadMessage({
      role,
      number,
      sha: base,
      tier,
      machine: config.machine,
      provider: verdict.model.provider,
      model: verdict.model.model,
      focus: request.prompt || '',
      issue: issueText(issue),
      approach: role === 'pr'
        ? io.approach(config, number, issue)
        : body,
      diff: role === 'pr' ? io.diff(config, number) : '',
      repo: config.repo,
      projectPath: config.repoPath,
    });
    const args = t3LaunchArgs({
      projectPath: config.repoPath,
      provider: config.providers[verdict.model.provider] || verdict.model.provider,
      model: verdict.model.model,
      title: threadTitle({ role, number, model: verdict.model.model }),
      branch: threadBranch({ role, number, commentId: comment.id }),
      base,
    });
    const threadId = io.launch(config, args, message);
    writeFileSync(join(slot, 'owner.json'), JSON.stringify({
      commentId: comment.id, number, role, threadId, claimedAt: new Date(now).toISOString(),
    }), { mode: 0o600 });
    return { outcome: 'launch', number, role, slot, threadId, request: verdict.model, tier };
  } catch (error) {
    releaseSlot(slot);
    return { outcome: 'refuse', code: 'launch-failed', reason: error?.message || String(error), number, role };
  }
}

// One run of the watcher. `io` is the only way this touches the world, so the tests drive it with a fake one.
export function tick({ config, now = Date.now(), io, log = () => {} }) {
  const state = readState(config.statePath);
  // Finish the bookkeeping before anything new starts: a settled thread frees its slot, and a slot nobody can still
  // hold is reclaimed so this machine cannot stop reviewing after one killed tick.
  const threads = io.threads(config);
  const settled = new Set((Array.isArray(threads) ? threads : []).filter((thread) => thread?.settled).map((thread) => thread.threadId));
  for (const [id, entry] of Object.entries(state.tags)) {
    if (entry.status !== 'running') continue;
    if (entry.threadId && settled.has(entry.threadId)) {
      releaseSlot(entry.slot);
      entry.status = 'done';
      log(`thread ${entry.threadId} for #${entry.number} finished`);
    }
  }
  reclaimStaleSlots(config.slotDir, { slots: config.slots, now, staleMs: config.slotStaleMs });

  const allowlist = io.allowlist(config);
  if (!allowlist.length) {
    log('no allowlist: set the AGENT_ALLOWLIST repository variable, or the allowlist in the config file');
    writeState(config.statePath, state);
    return { launched: [], refused: [], pending: 0 };
  }
  const lock = acquireLock(config.lockPath, { now, staleMs: config.lockStaleMs });
  if (!lock) {
    log('the previous tick is still running; skipping this one');
    return { launched: [], refused: [], pending: 0 };
  }
  const result = { launched: [], refused: [], pending: 0 };

  try {
    // A tag that waited for a slot last time goes first; it has already been checked, so re-checking is only what changed
    // it: its facts are read again, because a review may take minutes and the pull request may have moved.
    const pending = Object.entries(state.tags)
      .filter(([, entry]) => entry.status === 'pending')
      .sort((a, b) => a[1].queuedAt - b[1].queuedAt);
    const fresh = [];
    const since = state.cursor || new Date(now - firstLookbackMs).toISOString();
    const comments = io.comments(config, since);
    for (const comment of comments) {
      if (String(comment.body || '').includes(marker)) continue;
      if (state.seen.includes(comment.id)) continue;
      if (!tagRole(comment.body)) continue;
      if (!allowlist.includes(comment.user?.login || '')) continue;
      fresh.push(comment);
    }

    const work = [
      ...pending.map(([id, entry]) => ({ id, entry, comment: entry.comment })),
      ...fresh.map((comment) => ({ id: comment.id, entry: null, comment })),
    ].sort((a, b) => byCreated(a.comment, b.comment)).slice(0, defaults.tickLimit);

    for (const { id, entry, comment } of work) {
      if (!comment) continue;
      const request = parseRequest(comment.body);
      const outcome = handleTag({ config, request, comment, now, allowlist, io, state });
      if (outcome.outcome === 'skip') {
        markSeen(state, id);
        continue;
      }
      if (outcome.outcome === 'pending') {
        state.tags[id] = {
          status: 'pending', number: outcome.number, role: outcome.role,
          queuedAt: outcome.queuedAt, comment,
        };
        result.pending += 1;
        continue;
      }
      markSeen(state, id);
      if (outcome.outcome === 'post') {
        io.post(config, outcome.number, outcome.body);
        state.tags[id] = { status: 'done', number: outcome.number, role: outcome.role };
        continue;
      }
      if (outcome.outcome === 'refuse') {
        const body = refusalBody({ ...outcome, now });
        io.post(config, outcome.number, body);
        state.tags[id] = {
          status: 'refused', number: outcome.number, role: outcome.role, code: outcome.code || 'rule',
        };
        result.refused.push({ number: outcome.number, code: outcome.code || 'rule', reason: outcome.reason });
        log(`refused #${outcome.number}: ${outcome.reason || outcome.code}`);
        continue;
      }
      state.tags[id] = {
        status: 'running', number: outcome.number, role: outcome.role, slot: outcome.slot,
        threadId: outcome.threadId, tier: outcome.tier,
      };
      result.launched.push({ number: outcome.number, threadId: outcome.threadId });
      log(`started thread ${outcome.threadId} for #${outcome.number} (${outcome.request.provider} / ${outcome.request.model})`);
    }

    const newest = comments.at(-1);
    const cursor = [state.cursor, newest?.updated_at || newest?.created_at || ''].filter(Boolean).sort().at(-1) || state.cursor;
    if (cursor) state.cursor = cursor;
    // Seen ids are bounded: the cursor already stops old comments being read again, and the file is 0600 on this machine.
    if (state.seen.length > 500) state.seen = state.seen.slice(-500);
    const tags = Object.entries(state.tags);
    if (tags.length > 200) {
      state.tags = Object.fromEntries(tags.filter(([, entry]) => entry.status === 'pending' || entry.status === 'running')
        .concat(tags.filter(([, entry]) => entry.status !== 'pending' && entry.status !== 'running').slice(-50)));
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
    writeState(config.statePath, state);
  }
  return result;
}

export function markSeen(state, id) {
  if (!state.seen.includes(id)) state.seen.push(id);
}

// --- the world --------------------------------------------------------------------------------------------------------

// `gh`, `git` and `t3` as this machine already has them signed in. No token is passed in and none is stored: the
// watcher uses the owner's own sign-ins, which is also why installing it is the owner's step.
export function createIo({ env = process.env, run = execFileSync } = {}) {
  const exec = (command, args, options = {}) => run(command, args, {
    encoding: 'utf8', env, maxBuffer: 30 * 1024 * 1024, ...options,
  });
  const gh = (args, input) => String(exec('gh', args, input ? { input } : {})).trim();
  const json = (args) => JSON.parse(gh(args) || 'null');
  const git = (repoPath, args) => String(exec('git', ['-C', repoPath, ...args])).trim();
  return {
    // The same list the workflow gate reads. The config's own list is a fallback for a token that cannot read the
    // variable; if both are empty the tick stops before starting anything.
    allowlist(config) {
      try {
        const value = json(['api', `repos/${config.repo}/actions/variables/AGENT_ALLOWLIST`])?.value;
        return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
      } catch {
        return config.allowlist;
      }
    },
    // Every issue and pull-request comment on the repository since the cursor, in time order. One read per page, which is
    // what a poll every couple of minutes costs on an idle repository.
    comments(config, since) {
      const out = [];
      for (let page = 1; page <= 10; page += 1) {
        const query = `repos/${config.repo}/issues/comments?per_page=100&sort=created&direction=asc&page=${page}`
          + (since ? `&since=${encodeURIComponent(since)}` : '');
        const batch = json(['api', query]) || [];
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
    },
    pull: (config, number) => json(['api', `repos/${config.repo}/pulls/${number}`]),
    issue: (config, number) => json(['api', `repos/${config.repo}/issues/${number}`]),
    files: (config, number) => gh(['api', `repos/${config.repo}/pulls/${number}/files`, '--paginate', '--jq', '.[].filename'])
      .split('\n').filter(Boolean),
    ci(config, sha) {
      const runs = json(['api', `repos/${config.repo}/actions/workflows/check.yml/runs?head_sha=${sha}&event=pull_request&per_page=100`]);
      return ciConclusion(runs?.workflow_runs);
    },
    diff: (config, number) => gh(['pr', 'diff', String(number), '-R', config.repo]),
    // The approach comment the pull request is judged against: the newest `@tess-review approach` tag on its linked issue.
    approach(config, number, issue) {
      const linked = linkedIssueNumber(issue?.body);
      if (!linked) return '(no linked approach comment found)';
      const comments = json([`api`, `repos/${config.repo}/issues/${linked}/comments?per_page=100`]) || [];
      const tagged = comments.filter((comment) => tagRole(comment.body) === 'approach');
      return tagged.length ? tagged.at(-1).body : '(no linked approach comment found)';
    },
    post: (config, number, body) => gh(['issue', 'comment', String(number), '-R', config.repo, '--body-file', '-'], body),
    threads(config) {
      return JSON.parse(String(exec('t3', ['thread', 'list', '--project', config.repoPath, '--json'])) || '[]');
    },
    usage: (request, now) => reviewUsage(request, { env, now }),
    // The pull request's head, fetched into the watcher's own clone so the thread can be based on exactly that commit.
    fetchHead(config, number) {
      git(config.repoPath, ['fetch', '--quiet', '--depth=1', 'origin', `pull/${number}/head`]);
      return git(config.repoPath, ['rev-parse', 'FETCH_HEAD']);
    },
    launch(config, args, message) {
      return parseThreadId(String(exec('t3', args, { input: message })));
    },
    agentConfig: (config) => JSON.parse(git(config.repoPath, ['show', 'origin/main:.github/agents.json'])),
    // The clone is the watcher's own, so keeping it on main is safe: it holds no work of anyone's.
    updateSource(config) {
      if (!config.update) return 'no update';
      // The refspec is explicit: `git fetch origin main` would only move FETCH_HEAD, and the rules this watcher reads
      // come from `origin/main`. The clone is this watcher's own, so a hard reset here touches no one's work.
      git(config.repoPath, ['fetch', '--quiet', '--depth=1', 'origin', 'main:refs/remotes/origin/main']);
      git(config.repoPath, ['reset', '--hard', '--quiet', 'origin/main']);
      return 'updated';
    },
  };
}

// --- commands ---------------------------------------------------------------------------------------------------------

function check(config, io) {
  const lines = [];
  const problems = [];
  const ok = (name, detail = '') => lines.push(`ok    ${name}${detail ? `: ${detail}` : ''}`);
  const bad = (name, detail) => {
    problems.push(`${name}: ${detail}`);
    lines.push(`FAIL  ${name}: ${detail}`);
  };
  ok('machine', config.machine);
  ok('repository', config.repo);
  if (!existsSync(join(config.repoPath, '.git'))) {
    bad('checkout', `${config.repoPath} is not a git clone; see tools/review-watch/README.md`);
  } else {
    ok('checkout', config.repoPath);
  }
  try {
    io.agentConfig(config);
    ok('rules', 'origin/main:.github/agents.json is readable');
  } catch (error) {
    bad('rules', `cannot read .github/agents.json from origin/main (${error.message})`);
  }
  const allowlist = io.allowlist(config);
  if (allowlist.length) ok('allowlist', allowlist.join(', '));
  else bad('allowlist', 'the AGENT_ALLOWLIST repository variable is unreadable and the config has no fallback list');
  try {
    io.threads(config);
    ok('t3', 'the local server answered t3 thread list');
  } catch (error) {
    bad('t3', `the local T3 server did not answer (${error.message}); start T3 on this machine`);
  }
  ok('providers', Object.entries(config.providers).map(([provider, instance]) => `${provider}→${instance}`).join(', '));
  ok('slots', `${config.slots}, state in ${config.stateDir}`);
  console.log(lines.join('\n'));
  if (problems.length) {
    console.error(`\n${problems.length} problem(s). Nothing was started.`);
    return 1;
  }
  console.log('\nReady. Install the timer (tools/review-watch/README.md) or run this by hand.');
  return 0;
}

function main() {
  const command = process.argv[2] || 'tick';
  let config;
  try {
    config = readConfig();
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const io = createIo();
  if (command === 'check') return check(config, io);
  if (command !== 'tick') {
    console.error('usage: node tools/review-watch/watch.mjs [tick|check]');
    return 2;
  }
  try {
    const update = io.updateSource(config);
    if (update === 'updated') console.error('watcher code updated from origin/main');
  } catch (error) {
    // A stale copy of the rules is not a reason to skip a review; the rules it has are still the ones it was installed
    // with, and the GitHub job checks the same tag.
    console.error(`could not update the watcher's checkout: ${error.message}`);
  }
  try {
    const result = tick({ config, io, log: (line) => console.error(line) });
    console.error(`tick: ${result.launched.length} launched, ${result.refused.length} refused, ${result.pending} waiting`);
    return 0;
  } catch (error) {
    // A failed tick posts nothing: the tag is not marked seen, so the next tick tries it again with the same rules.
    console.error(`tick failed: ${error.message}`);
    return 1;
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
