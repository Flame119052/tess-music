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
//
// Two limits are enforced here rather than promised in a prompt, because a T3 thread runs with the owner's own
// permissions (#105 review):
//
// 1. Nothing a pull request controls reaches a thread that is not held to T3's strictest runtime mode. The thread is
//    opened with a fixed line that contains no diff, issue, focus or file, its runtime mode is read back from T3, and
//    only then is the review itself sent. A project left at `full-access` gets a refusal comment, not the review.
// 2. The thread posts nothing. It answers with its review as the last message; this watcher — plain code, no model —
//    takes that text, checks its shape, and posts it with the owner's `gh`. A review written by a hijacked thread is
//    then at worst a bad review, never a comment, a merge or a push made in the owner's name.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

export const stateVersion = 2;

// A tag posted before the watcher first ran is not replayed: installing a watcher must never start reviews of old
// conversations. Ten minutes is enough to cover a tag written while the install was being finished.
export const firstLookbackMs = 10 * 60 * 1000;

// A seen comment is remembered long enough that no replay of it can ever look like a new tag. Age is the only thing
// that forgets one, never a count: dropping the oldest ids would make an old, edited tag new again (#105 review).
export const seenWindowMs = 30 * 24 * 60 * 60 * 1000;

// The only T3 runtime mode a review may run in. T3 maps this to each provider's strictest setting — a read-only
// sandbox with no network for Codex, a per-tool approval for Claude — and a thread's mode is the one limit this
// machine can actually enforce, so a project set to anything wider is refused rather than reviewed (#105 review).
export const reviewMode = 'approval-required';

// The reply the gate thread is asked for. It is fixed text, so nothing a pull request controls is ever the thing a
// misconfigured thread reads.
export const gateReply = 'TESS REVIEW GATE READY';

// The first message a review thread gets: fixed words, no pull request text, so the mode can be read back before
// anything untrusted arrives.
export const gateMessage = [
  'This is the Tess Music review gate. Nothing from a pull request has been sent to this thread yet.',
  '',
  'Do not read any file, run any command, or use any tool.',
  `Answer with exactly this one line and nothing else: ${gateReply}`,
].join('\n');

// A review is a comment, so it has a ceiling like any comment. A longer reply is cut by GitHub or refused by it, and
// either way the reviewer's words would not be what a reader sees.
export const reviewMessageLimit = 60 * 1000;

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

// The state of one machine: the newest comment time it has read, the comment ids it has already judged, and one entry
// for every tag it has acted on. Version 1 remembered only ids, with no age, so a truncated list could replay a tag.
export function readState(path) {
  const empty = { version: stateVersion, cursor: '', seen: [], tags: {} };
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    const tags = state?.tags && typeof state.tags === 'object' ? state.tags : {};
    const seen = Array.isArray(state?.seen)
      ? state.seen.flatMap((entry) => {
        if (entry && typeof entry === 'object' && entry.id !== undefined) {
          return [{ id: entry.id, at: typeof entry.at === 'string' ? entry.at : '' }];
        }
        // Version 1 kept a bare id and no time. It is kept, dated from now, so nothing it remembered runs again.
        return entry === undefined ? [] : [{ id: entry, at: new Date().toISOString() }];
      })
      : [];
    return {
      version: stateVersion,
      cursor: typeof state?.cursor === 'string' ? state.cursor : '',
      seen,
      tags,
    };
  } catch {
    return empty;
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
// directory, claimed atomically by `mkdir`; its owner record says which thread holds it. A slot is only given back when
// its thread is gone or when a tick died before a thread existed: a live thread keeps its slot however long it runs,
// because giving the slot back early would run more reviews than the cap allows (#105 review).

export function claimSlot(directory, owner, { slots = defaults.slots, now = Date.now(), staleMs = defaults.slotStaleMs, live = new Set() } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  reclaimStaleSlots(directory, { slots, now, staleMs, live });
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

// `live` is every thread this machine's T3 server still knows. A slot whose thread is in it is kept, settled or not:
// a settled thread frees its slot through the state entry, not through a timer, so the cap and the threads agree.
export function reclaimStaleSlots(directory, { slots = defaults.slots, now = Date.now(), staleMs = defaults.slotStaleMs, live = new Set() } = {}) {
  const reclaimed = [];
  // A slot claimed a moment ago belongs to a thread this tick is still opening, so age alone never sweeps it.
  const floor = Math.max(staleMs, 60 * 1000);
  for (const slot of slotState(directory, { slots })) {
    const threadId = slot.owner?.threadId;
    if (threadId && live.has(threadId)) continue;
    const claimedAt = Date.parse(slot.owner?.claimedAt || '');
    const age = Number.isFinite(claimedAt) ? now - claimedAt : Infinity;
    if (age < floor) continue;
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
// output it makes. A T3 thread runs with the machine's own rights, so this file never asks it to write anything with
// them: the review comment is the thread's last message, and this watcher posts it.
export function reviewThreadMessage({
  role, number, sha, tier, machine, provider, model, focus, issue, approach, diff, repo, projectPath,
}) {
  const subject = role === 'pr' ? `pull request #${number}` : `issue #${number}`;
  const header = [
    marker,
    ...(role === 'pr' ? [`Reviewed: ${sha}`, `Tier: ${tier}`] : []),
    `Reviewer: ${provider} / ${model}`,
    `Machine: ${machine}`,
  ];
  return [
    `Review Tess Music ${subject} on this machine. This thread is the review: it reads and reports. You post nothing.`,
    'The watcher that opened this thread takes your final reply, checks it, and posts it as the review comment.',
    '',
    reviewPrompt(role, { issue, approach, diff, focus }),
    '',
    'YOUR COPY OF THE CODE',
    `The worktree this thread started in is ${role === 'pr' ? `the exact commit ${sha}` : 'main'}, taken from ${projectPath}.`,
    'Read the diff above against that code, and cite the path and line of anything you find.',
    '',
    'WHAT THIS THREAD MAY DO',
    `This thread runs in T3's \`${reviewMode}\` mode, the strictest this machine has: the provider is held to a read-only`,
    'sandbox (Codex, which also loses the network) or to asking the owner before each command (Claude). Do not try to get',
    'around either, and do not read anything outside the worktree. Do not edit, add, commit, push, delete, merge, release',
    'or promote anything. Do not run, build or install anything from the change. Do not comment, approve or request',
    'changes on GitHub: you have no way to, and a review that tries is not posted.',
    '',
    'HOW TO ANSWER',
    'Your final reply is the comment. Start it with this line, then the header, then your findings, and end with one last',
    'line that is exactly `Verdict: approve` or `Verdict: changes needed`. Nothing before the marker, nothing after the',
    'verdict: a reply of any other shape is not posted, and the pull request is told the review came back unreadable.',
    '',
    ...header.map((line) => `  ${line}`),
    '',
    ...(focus ? ['The owner\'s focus from the tag is in the instructions above, so a reader can see what was asked for.', ''] : []),
    `Keep the marker as the first line: it is what stops your review from starting another review.`,
    '',
    `The watcher posts this to ${repo} ${role === 'pr' ? `pull request #${number}` : `issue #${number}`} after it checks the`,
    'commit has not moved. If it has, the pull request gets a short note instead and this review is dropped.',
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

// The comment id is in the title and in the branch, so a tick that died after `t3 thread start` but before the state
// write finds the thread it made instead of starting a second one (#105 review).
export function threadTitle({ role, number, model, commentId }) {
  const what = role === 'pr' ? `Review PR #${number}` : `Approach review for #${number}`;
  return commentId === undefined ? `${what} with ${model}` : `${what} with ${model} (comment ${commentId})`;
}

export function threadBranch({ role, number, commentId }) {
  return `tess-review-${role}-${number}-${commentId}`;
}

// The body a refusal gets. Tags the GitHub gate refuses use its fixed words; the codes only this machine produces say
// what to change here. A rule refusal (a model that is not on the plans-only list, the author's own provider, a window
// with no room) uses the same comment the GitHub path posts, so the two doors say the same thing about the same rule.
export const watcherRefusals = {
  'not-read-only': 'this machine cannot run the review read-only yet, so nothing was reviewed. T3 opened the thread at a wider runtime mode than `approval-required`, and a review is only sent to a thread that cannot write, push or reach the network. Set this repository\'s T3 project to the `approval-required` default runtime mode, then tag again (tools/review-watch/README.md → Limits).',
  'effort-not-honored': 'a T3 thread on this machine cannot be told an effort: `t3 thread start` takes a provider and a model only, and this review would have run at the model\'s own default without saying so. Nothing ran. Tag again without `effort=` on this machine, or use `machine=github`, where the effort is passed to the reviewer\'s own CLI.',
  'review-unreadable': 'the review came back in a shape this machine will not post: it must start with the review marker, name the commit it read, and end with one `Verdict:` line, and it must fit in one comment. Nothing was posted from it. The thread is on this machine for the owner to read.',
  'review-thread-lost': 'the review thread this machine opened is gone (deleted, or the T3 server no longer knows it), so the review was never posted. Nothing was reviewed. Tag again.',
};

export function refusalBody({ code, reason, provider = '', model = '', resetsAt = null, noRoom = false, runUrl = '', now = Date.now() }) {
  if (noRoom) return noRoomComment({ reasons: [reason], earliestResetMs: resetsAt, now });
  if (code && Object.hasOwn(watcherRefusals, code)) {
    return [marker, '', 'Review not run.', '', `Why: ${watcherRefusals[code]}`, '', `Code: ${code}`].join('\n');
  }
  if (code) return reviewRefusalText(code, { runUrl });
  return refusalComment({ reason, provider, model, resetsAt });
}

// --- the review, before it is posted ----------------------------------------------------------------------------------

// Why a thread's reply cannot be posted, or null when it can. Everything here is shape, not opinion: a hijacked review
// that writes anything else is dropped instead of being posted in the owner's name (#105 review).
export function reviewCommentProblem(text, { sha, role }) {
  const body = String(text || '').trim();
  if (!body) return 'the thread answered with nothing';
  if (body.length > reviewMessageLimit) return `the reply is ${body.length} characters, over the ${reviewMessageLimit} a comment can carry`;
  const lines = body.split(/\r?\n/);
  if (lines[0].trim() !== marker) return 'the reply does not start with the review marker';
  if (role === 'pr' && !lines.some((line) => line.trim() === `Reviewed: ${sha}`)) {
    return `the reply does not name the commit it read (${sha})`;
  }
  const last = [...lines].reverse().find((line) => line.trim());
  if (!/^Verdict: (approve|changes needed)$/.test(last.trim())) return 'the reply does not end with one Verdict line';
  return null;
}

// The last thing the thread said. A settled thread's newest assistant message is its review; the gate reply is older,
// so it can never be mistaken for one.
export function lastAssistantText(messages) {
  const said = (Array.isArray(messages) ? messages : []).filter((message) => message?.role === 'assistant');
  return said.at(-1)?.text || '';
}

// A thread opened at a wider mode is stopped before anything untrusted reaches it. T3 reports the thread's own mode, so
// this is read from the server, not assumed from the tag or from a project setting nobody checked.
export function threadModeProblem(thread) {
  if (!thread) return 'the thread is not on this machine any more';
  if (thread.runtimeMode !== reviewMode) {
    return `the review thread runs at \`${thread.runtimeMode || '(unknown)'}\`, not \`${reviewMode}\``;
  }
  return null;
}

// --- one tick ---------------------------------------------------------------------------------------------------------

const byCreated = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));

// What a tag is allowed to become, with the world passed in so a test can drive every branch without a network, a
// machine or a thread. Returns a decision; starting the thread is `startReview`, below.
export function judgeTag({ config, request, comment, now, allowlist, io }) {
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
    return { outcome: 'post', number, role, body: docsOnlyComment(head.sha) };
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
  // The one setting a thread on this machine cannot carry. Saying nothing here is what the last version did, and a
  // review then ran at whatever the provider chose (#105 review).
  if (request.effort) {
    return {
      outcome: 'refuse', code: 'effort-not-honored', number, role,
      reason: `effort=${request.effort} cannot be passed to a T3 thread on this machine`,
    };
  }
  return {
    outcome: 'start', number, role, tier, head: head.sha, base: pull?.base?.sha || '', issue, pull,
    request: verdict.model, queuedAt: Date.parse(comment.created_at || '') || now,
  };
}

// One review, from the slot to the thread, in the one order that survives a tick dying at any point: the intent is
// written first, the thread's id is written the moment T3 prints it, and a thread that already exists for this comment
// is adopted instead of started again (#105 review).
export function startReview({ config, state, id, comment, decision, now, io, threads, log = () => {} }) {
  const branch = threadBranch({ role: decision.role, number: decision.number, commentId: comment.id });
  const title = threadTitle({ role: decision.role, number: decision.number, model: decision.request.model, commentId: comment.id });
  // The commit is fetched again immediately before the thread is opened: a review is only ever of the commit CI passed,
  // and a push in the minutes since the tag gets a note instead of a thread.
  let base = decision.head;
  if (decision.role === 'pr') {
    base = io.fetchHead(config, decision.number);
    if (base !== decision.head) {
      return { outcome: 'post', number: decision.number, role: decision.role, body: headMismatchMessage(decision.head, base) };
    }
  }
  const slot = claimSlot(config.slotDir, { commentId: comment.id, number: decision.number, role: decision.role }, {
    slots: config.slots, now, staleMs: config.slotStaleMs,
    live: new Set((Array.isArray(threads) ? threads : []).map((thread) => thread?.threadId)),
  });
  if (!slot) {
    if (now - decision.queuedAt < config.slotWaitMs) return { outcome: 'pending', number: decision.number, role: decision.role, queuedAt: decision.queuedAt };
    return { outcome: 'refuse', code: 'slots-busy', reason: `all ${config.slots} slots are busy`, number: decision.number, role: decision.role };
  }
  const entry = {
    status: 'intent', number: decision.number, role: decision.role, commentId: comment.id,
    tier: decision.tier, provider: decision.request.provider, model: decision.request.model,
    head: decision.head, base: decision.base || '', branch, slot, queuedAt: decision.queuedAt,
    claimedAt: new Date(now).toISOString(), comment,
  };
  state.tags[id] = entry;
  writeState(config.statePath, state);
  try {
    const known = (Array.isArray(threads) ? threads : []).find((thread) => thread?.title === title);
    if (known) {
      entry.threadId = known.threadId;
      entry.status = 'gate';
      writeOwner(slot, entry);
      log(`adopted thread ${known.threadId} for #${decision.number}, from an earlier tick`);
      writeState(config.statePath, state);
      return { outcome: 'adopt', number: decision.number, role: decision.role, threadId: known.threadId };
    }
    const launch = launchArgsFor({ config, decision, comment, branch, title });
    const threadId = io.launch(config, launch.args, launch.message);
    entry.threadId = threadId;
    entry.status = 'gate';
    // The slot names its thread as soon as there is one: that is what keeps it out of the stale sweep while it runs.
    writeOwner(slot, entry);
    writeState(config.statePath, state);
    return { outcome: 'launch', number: decision.number, role: decision.role, threadId };
  } catch (error) {
    releaseSlot(slot);
    delete state.tags[id];
    return { outcome: 'refuse', code: 'launch-failed', reason: error?.message || String(error), number: decision.number, role: decision.role };
  }
}

// The slot's own record: which review it is holding, and which thread. A slot without a thread is a tick that died
// between claiming it and starting one, which is the only case a timer may reclaim.
export function writeOwner(slot, entry) {
  writeFileSync(join(slot, 'owner.json'), JSON.stringify({
    commentId: entry.commentId, number: entry.number, role: entry.role,
    threadId: entry.threadId, claimedAt: entry.claimedAt,
  }), { mode: 0o600 });
}

export function launchArgsFor({ config, decision, comment, branch, title }) {
  return {
    args: t3LaunchArgs({
      projectPath: config.repoPath,
      provider: config.providers[decision.request.provider] || decision.request.provider,
      model: decision.request.model,
      title,
      branch,
      base: decision.head,
    }),
    message: gateMessage,
  };
}

// The review message, built from the validated commit rather than from a pull request number, so a push between the CI
// check and the read cannot change what the reviewer reads (#105 review).
export function reviewMessageFor({ config, entry, io, comment }) {
  const role = entry.role;
  const number = entry.number;
  const issue = io.issue(config, number);
  return reviewThreadMessage({
    role,
    number,
    sha: entry.head,
    tier: entry.tier,
    machine: config.machine,
    provider: entry.provider,
    model: entry.model,
    focus: parseRequest(String(comment?.body || '')).prompt || '',
    issue: issueText(issue),
    approach: role === 'pr' ? io.approach(config, number, issue) : String(comment?.body || ''),
    diff: role === 'pr' ? io.diff(config, entry.base || '', entry.head) : '',
    repo: config.repo,
    projectPath: config.repoPath,
  });
}

// Everything a running review needs between ticks. One function so a tick and the next one behave the same after a
// crash: read the thread, hold it to the mode gate, send the review once, post the answer once.
export function reconcileTag({ config, state, id, entry, threads, io, now, log = () => {} }) {
  const out = { outcome: 'wait' };
  let thread;
  try {
    thread = io.thread(config, entry.threadId);
  } catch {
    releaseSlot(entry.slot);
    state.tags[id] = { status: 'refused', number: entry.number, role: entry.role, code: 'review-thread-lost' };
    io.post(config, entry.number, refusalBody({ code: 'review-thread-lost', now }));
    log(`thread ${entry.threadId} for #${entry.number} is gone; the slot is free`);
    return { outcome: 'refuse', number: entry.number, code: 'review-thread-lost' };
  }
  const mode = threadModeProblem(thread.thread);
  if (mode) {
    releaseSlot(entry.slot);
    state.tags[id] = { status: 'refused', number: entry.number, role: entry.role, code: 'not-read-only' };
    io.post(config, entry.number, refusalBody({ code: 'not-read-only', now }));
    log(`refused #${entry.number}: ${mode}`);
    return { outcome: 'refuse', number: entry.number, code: 'not-read-only' };
  }
  if (entry.status !== 'review') {
    // The gate reply may still be running; `send` queues the review behind it, which is what a watched review wants.
    const message = reviewMessageFor({ config, entry, io, comment: entry.comment });
    io.send(config, entry.threadId, message);
    entry.status = 'review';
    entry.reviewSentAt = new Date(now).toISOString();
    writeState(config.statePath, state);
    log(`sent the review to thread ${entry.threadId} for #${entry.number}`);
    return { outcome: 'sent', number: entry.number, threadId: entry.threadId };
  }
  const settledAt = Date.parse(thread.thread?.settledAt || '');
  const sentAt = Date.parse(entry.reviewSentAt || '');
  if (!thread.thread?.settled || !Number.isFinite(settledAt) || !(settledAt >= sentAt)) {
    return out;
  }
  // The thread has finished the review. Its answer is a comment only if it has the shape every review has.
  const text = lastAssistantText(thread.messages);
  const problem = reviewCommentProblem(text, { sha: entry.head, role: entry.role });
  const link = thread.thread?.link ? `\n\nThread: ${thread.thread.link}` : '';
  try {
    if (problem) {
      io.post(config, entry.number, [refusalBody({ code: 'review-unreadable', now }), link].join(''));
      state.tags[id] = { status: 'refused', number: entry.number, role: entry.role, code: 'review-unreadable' };
      log(`thread ${entry.threadId} answered #${entry.number} in a shape that cannot be posted: ${problem}`);
    } else {
      // The comment is only posted for the commit the review read. A push during the review gets a note, not a verdict.
      if (entry.role === 'pr') {
        const head = headFacts(io.pull(config, entry.number), config.repo).sha;
        if (head !== entry.head) {
          io.post(config, entry.number, headMismatchMessage(entry.head, head));
          state.tags[id] = { status: 'refused', number: entry.number, role: entry.role, code: 'head-moved' };
          releaseSlot(entry.slot);
          log(`#${entry.number} moved from ${entry.head} to ${head}; the review was not posted`);
          return { outcome: 'refuse', number: entry.number, code: 'head-moved' };
        }
      }
      io.post(config, entry.number, text.trim());
      state.tags[id] = { status: 'done', number: entry.number, role: entry.role, threadId: entry.threadId };
      log(`posted the review of #${entry.number} from thread ${entry.threadId}`);
    }
    releaseSlot(entry.slot);
    writeState(config.statePath, state);
    return { outcome: problem ? 'refuse' : 'post', number: entry.number, threadId: entry.threadId };
  } catch (error) {
    // A comment that could not be posted keeps its slot: the next tick tries again, and a review is never lost silently.
    log(`could not post the review of #${entry.number}: ${error.message}`);
    return { outcome: 'wait' };
  }
}

// One run of the watcher. `io` is the only way this touches the world, so the tests drive it with a fake one.
export function tick({ config, now = Date.now(), io, log = () => {} }) {
  const state = readState(config.statePath);
  const result = { launched: [], refused: [], posted: [], pending: 0 };
  const threads = io.threads(config);
  const list = Array.isArray(threads) ? threads : [];
  const live = new Set(list.map((thread) => thread?.threadId));

  // One tick at a time, including the bookkeeping: a review posted twice because two ticks both saw it settled is the
  // same mistake as two threads for one tag.
  const lock = acquireLock(config.lockPath, { now, staleMs: config.lockStaleMs });
  if (!lock) {
    log('the previous tick is still running; skipping this one');
    return result;
  }

  try {
    // Finish what earlier ticks started before anything new begins: a review that is ready is posted, a thread opened
    // at a wider mode is refused, and a slot whose thread is gone is reclaimed.
    for (const [id, entry] of Object.entries(state.tags)) {
      if (!['intent', 'gate', 'review'].includes(entry.status)) continue;
      if (!entry.threadId) {
        // A tick died between the intent and the thread's id. If T3 has the thread anyway, adopt it; otherwise this tag
        // never started, and starting it now would be a second launch for one comment.
        const adopted = adoptByTitle({ config, entry, list, io, state, id, log });
        if (!adopted) continue;
      }
      const reconciled = reconcileTag({ config, state, id, entry, threads: list, io, now, log });
      if (reconciled.outcome === 'sent') result.launched.push({ number: reconciled.number, threadId: reconciled.threadId });
      if (reconciled.outcome === 'post') result.posted.push({ number: reconciled.number, threadId: reconciled.threadId });
      if (reconciled.outcome === 'refuse') {
        result.refused.push({ number: reconciled.number, code: reconciled.code, reason: watcherRefusals[reconciled.code] || reconciled.code });
      }
    }
    reclaimStaleSlots(config.slotDir, { slots: config.slots, now, staleMs: config.slotStaleMs, live });

    const allowlist = io.allowlist(config);
    if (!allowlist.length) {
      log('no allowlist: set the AGENT_ALLOWLIST repository variable, or the allowlist in the config file');
      return result;
    }
    // A tag that waited for a slot last time goes first; its facts are read again, because a review may take minutes and
    // the pull request may have moved.
    const pending = Object.entries(state.tags)
      .filter(([, entry]) => entry.status === 'pending')
      .sort((a, b) => a[1].queuedAt - b[1].queuedAt);
    const fresh = [];
    const since = state.cursor || new Date(now - firstLookbackMs).toISOString();
    const comments = io.comments(config, since);
    const seen = new Set(state.seen.map((entry) => String(entry.id)));
    for (const comment of comments) {
      if (String(comment.body || '').includes(marker)) continue;
      if (seen.has(String(comment.id))) continue;
      if (!tagRole(comment.body)) continue;
      if (!allowlist.includes(comment.user?.login || '')) continue;
      fresh.push(comment);
    }

    // One entry per comment id: a pending copy and a fresh copy of the same comment are one tag, not two (#105 review).
    const work = new Map();
    for (const [id, entry] of pending) work.set(String(id), { id, entry, comment: entry.comment });
    for (const comment of fresh) work.set(String(comment.id), { ...(work.get(String(comment.id)) || {}), id: comment.id, comment });
    const ordered = [...work.values()]
      .filter((item) => item.comment)
      .sort((a, b) => byCreated(a.comment, b.comment))
      .slice(0, defaults.tickLimit);

    for (const { id, entry, comment: listed } of ordered) {
      // A tag this tick has already adopted or sent is not started again below: the tag is one request, however many
      // times it is read.
      const inFlight = state.tags[String(id)];
      if (inFlight && ['intent', 'gate', 'review'].includes(inFlight.status)) continue;
      // The comment is read again from GitHub the moment it is acted on: a tag deleted or edited after it was queued is
      // not the tag that was judged, so it does not launch (#105 review).
      const current = rereadComment({ config, io, id, listed, state, log, now });
      if (!current) continue;
      const request = parseRequest(current.body);
      const decision = judgeTag({ config, request, comment: current, now, allowlist, io });
      if (decision.outcome === 'skip') {
        markSeen(state, id, now);
        continue;
      }
      if (decision.outcome === 'pending') {
        state.tags[String(id)] = {
          status: 'pending', number: decision.number, role: decision.role,
          queuedAt: decision.queuedAt, comment: current,
        };
        result.pending += 1;
        continue;
      }
      if (decision.outcome === 'post') {
        markSeen(state, id, now);
        io.post(config, decision.number, decision.body);
        state.tags[String(id)] = { status: 'done', number: decision.number, role: decision.role };
        result.posted.push({ number: decision.number });
        continue;
      }
      if (decision.outcome === 'refuse') {
        markSeen(state, id, now);
        io.post(config, decision.number, refusalBody({ ...decision, now }));
        state.tags[String(id)] = { status: 'refused', number: decision.number, role: decision.role, code: decision.code || 'rule' };
        result.refused.push({ number: decision.number, code: decision.code || 'rule', reason: decision.reason });
        log(`refused #${decision.number}: ${decision.reason || decision.code}`);
        continue;
      }
      markSeen(state, id, now);
      const started = startReview({
        config, state, id: String(id), comment: current, decision, now, io, threads: list, log,
      });
      if (started.outcome === 'pending') {
        // The slot was taken between the claim and here: wait, and keep the comment for the next tick.
        state.tags[String(id)] = {
          status: 'pending', number: started.number, role: started.role,
          queuedAt: started.queuedAt, comment: current,
        };
        result.pending += 1;
        continue;
      }
      if (started.outcome === 'post') {
        io.post(config, started.number, started.body);
        state.tags[String(id)] = { status: 'refused', number: started.number, role: started.role, code: 'head-moved' };
        result.refused.push({ number: started.number, code: 'head-moved' });
        continue;
      }
      if (started.outcome === 'refuse') {
        io.post(config, started.number, refusalBody({ ...started, now }));
        state.tags[String(id)] = { status: 'refused', number: started.number, role: started.role, code: started.code };
        result.refused.push({ number: started.number, code: started.code, reason: started.reason });
        log(`refused #${started.number}: ${started.reason || started.code}`);
        continue;
      }
      const entry = state.tags[String(id)];
      writeState(config.statePath, state);
      const reconciled = reconcileTag({ config, state, id: String(id), entry, threads: list, io, now, log });
      if (reconciled.outcome === 'sent' || reconciled.outcome === 'wait') {
        result.launched.push({ number: decision.number, threadId: entry.threadId });
        log(`started thread ${entry.threadId} for #${decision.number} (${decision.request.provider} / ${decision.request.model})`);
      }
      if (reconciled.outcome === 'refuse') {
        result.refused.push({ number: reconciled.number, code: reconciled.code });
      }
    }

    const newest = comments.at(-1);
    const cursor = [state.cursor, newest?.updated_at || newest?.created_at || ''].filter(Boolean).sort().at(-1) || state.cursor;
    if (cursor) state.cursor = cursor;
    pruneSeen(state, { now });
    const tags = Object.entries(state.tags);
    if (tags.length > 200) {
      const inFlight = (entry) => ['pending', 'intent', 'gate', 'review'].includes(entry.status);
      state.tags = Object.fromEntries(tags.filter(([, entry]) => inFlight(entry))
        .concat(tags.filter(([, entry]) => !inFlight(entry)).slice(-50)));
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
    writeState(config.statePath, state);
  }
  return result;
}

// An entry whose thread id was never written: T3 may still have started the thread before the tick died, and the title
// carries the comment id, so it can be found again. Without it the slot is released and the tag is answered, once.
export function adoptByTitle({ config, entry, list, io, state, id, log = () => {} }) {
  const title = threadTitle({ role: entry.role, number: entry.number, model: entry.model, commentId: entry.commentId });
  const known = (Array.isArray(list) ? list : []).find((thread) => thread?.title === title);
  if (known) {
    entry.threadId = known.threadId;
    entry.status = 'gate';
    writeOwner(entry.slot, entry);
    writeState(config.statePath, state);
    log(`adopted thread ${known.threadId} for #${entry.number}, recorded without an id`);
    return true;
  }
  releaseSlot(entry.slot);
  state.tags[id] = { status: 'refused', number: entry.number, role: entry.role, code: 'launch-failed' };
  io.post(config, entry.number, refusalBody({ code: 'launch-failed' }));
  log(`#${entry.number} was recorded but never started; tag again`);
  return false;
}

// The comment as GitHub has it now, or null when it must not be acted on: gone, edited, from another account, or not
// readable at all. A tag that changed while it waited is judged again as a fresh comment, never as its old self.
function rereadComment({ config, io, id, listed, state, log, now = Date.now() }) {
  let current;
  try {
    current = io.comment(config, id);
  } catch (error) {
    markSeen(state, id, now);
    delete state.tags[String(id)];
    log(`#${id} could not be read again (${error.message}); nothing was started for it`);
    return null;
  }
  if (!current || String(current.id) !== String(id)) {
    markSeen(state, id, now);
    delete state.tags[String(id)];
    log(`#${id} is gone from GitHub; nothing was started for it`);
    return null;
  }
  if (current.user?.login !== listed?.user?.login || String(current.body || '') !== String(listed.body || '')) {
    // An edited tag is a new request. Forget the old id, and hand back the new words so they are judged now: the cursor
    // has already moved past this comment, so waiting for the next poll would lose it.
    state.seen = state.seen.filter((entry) => String(entry.id) !== String(id));
    delete state.tags[String(id)];
    log(`#${id} was edited after it was queued; it is judged as it reads now`);
    return { ...current };
  }
  return current;
}

export function markSeen(state, id, now = Date.now()) {
  if (state.seen.some((entry) => String(entry.id) === String(id))) return;
  state.seen.push({ id, at: new Date(now).toISOString() });
}

// Old ids are forgotten by age, never by count: a count would drop the oldest id first and let an old, edited tag look
// new again (#105 review).
export function pruneSeen(state, { now = Date.now() } = {}) {
  const cursor = Date.parse(state.cursor || '');
  const cutoff = (Number.isFinite(cursor) ? cursor : now) - seenWindowMs;
  state.seen = state.seen.filter((entry) => {
    const at = Date.parse(entry.at || '');
    return Number.isFinite(at) ? at >= cutoff : false;
  });
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
    // One comment, as it is now. This is what a launch is decided on: a tag deleted or edited after it was queued must
    // not run on its old words.
    comment: (config, id) => json(['api', `repos/${config.repo}/issues/comments/${id}`]),
    pull: (config, number) => json(['api', `repos/${config.repo}/pulls/${number}`]),
    issue: (config, number) => json(['api', `repos/${config.repo}/issues/${number}`]),
    files: (config, number) => gh(['api', `repos/${config.repo}/pulls/${number}/files`, '--paginate', '--jq', '.[].filename'])
      .split('\n').filter(Boolean),
    ci(config, sha) {
      const runs = json(['api', `repos/${config.repo}/actions/workflows/check.yml/runs?head_sha=${sha}&event=pull_request&per_page=100`]);
      return ciConclusion(runs?.workflow_runs);
    },
    // The diff between the commit CI passed and its base, not the pull request's current diff: a push after the CI check
    // must not change what the reviewer reads (#105 review).
    diff(config, base, head) {
      if (!base || !head) return gh(['pr', 'diff', String(head || ''), '-R', config.repo]);
      return gh(['api', `repos/${config.repo}/compare/${base}...${head}`, '-H', 'Accept: application/vnd.github.diff']);
    },
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
    // One thread with its latest messages: the runtime mode this machine gave it, whether it has settled, and what it
    // said last.
    thread(config, threadId) {
      return JSON.parse(String(exec('t3', ['thread', 'show', String(threadId), '--json', '--messages', '10'])) || '{}');
    },
    // The review itself, sent only after the thread's mode has been read back. A busy thread queues it.
    send: (config, threadId, message) => String(exec('t3', ['thread', 'send', String(threadId), '-'], { input: message })).trim(),
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
  // Not a provider setting and not a promise in a prompt: a review is only sent to a thread T3 reports at this mode, and
  // the project's own default runtime mode is what T3 gives every thread it opens here.
  ok('mode', `${reviewMode} (set this repository's T3 project to it; a wider thread is refused, never reviewed)`);
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
    console.error(`tick: ${result.launched.length} launched, ${result.posted.length} posted, ${result.refused.length} refused, ${result.pending} waiting`);
    return 0;
  } catch (error) {
    console.error(`tick failed: ${error.message}`);
    return 1;
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
