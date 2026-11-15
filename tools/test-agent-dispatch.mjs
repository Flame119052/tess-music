import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildLaunchRequest,
  claimSlot,
  parseRequest,
  readConfig,
  releaseSlot,
  resolveMachine,
  run,
} from './agent-dispatch.mjs';
import * as dispatch from './agent-dispatch.mjs';

const hook = fileURLToPath(new URL('runner-hook.sh', import.meta.url));
const dispatchScript = fileURLToPath(new URL('agent-dispatch.mjs', import.meta.url));
const workflowFile = fileURLToPath(new URL('../.github/workflows/agent-dispatch.yml', import.meta.url));

function context(overrides = {}) {
  return {
    repository: 'Flame119052/tess-music',
    number: 88,
    commentId: '1234',
    url: 'https://github.com/Flame119052/tess-music/issues/88',
    isPr: false,
    prHeadRef: undefined,
    prHeadSha: undefined,
    ...overrides,
  };
}

function runnerEnv(endpoint, slotDir, overrides = {}) {
  return {
    HOME: tmpdir(),
    TESS_T3_MCP_URL: endpoint,
    TESS_T3_MCP_OAUTH_TOKEN: 'oauth-issued-test-token',
    TESS_AGENT_SLOT_DIR: slotDir,
    TESS_T3_INSTABOX_ENVIRONMENT_ID: 'env-instabox',
    TESS_T3_INSTABOX_PROJECT_ID: 'project-instabox',
    TESS_T3_OMARCHY_ENVIRONMENT_ID: 'env-omarchy',
    TESS_T3_OMARCHY_PROJECT_ID: 'project-omarchy',
    TESS_T3_VPS_ENVIRONMENT_ID: 'env-vps',
    TESS_T3_VPS_PROJECT_ID: 'project-vps',
    TESS_T3_MAC_PROJECT_ID: 'project-mac',
    COMMENT_BODY: '@tess-agent review provider=claude model=claude-opus-5-5 effort=high',
    COMMENT_ID: '1234',
    ISSUE_NUMBER: '88',
    IS_PR: 'false',
    REPOSITORY: 'Flame119052/tess-music',
    SUBJECT_URL: 'https://github.com/Flame119052/tess-music/issues/88',
    ...overrides,
  };
}

async function mockMcp(options = {}) {
  const calls = [];
  let initialized = 0;
  let timedOutWaits = options.waitTimedOut || 0;
  let expiries = options.waitExpiries || 0;
  let linksExpiries = options.linksExpiries || 0;
  let waitCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ body, headers: request.headers });
    if (body.method === 'initialize') {
      initialized += 1;
      if (options.rejectReconnect && initialized > 1) {
        response.writeHead(401, { 'content-type': 'text/plain' }).end('expired oauth token');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.setHeader('mcp-session-id', `mock-session-${initialized}`);
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'mock-t3', version: '1' },
        },
      }));
      return;
    }
    if (body.method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer oauth-issued-test-token');
    assert.equal(request.headers['mcp-session-id'], `mock-session-${initialized}`);
    const { name, arguments: args } = body.params;
    options.onCall?.(name);
    if (name === 't3_environment_links') {
      if (options.linksHttpError) {
        response.writeHead(options.linksHttpError.status, { 'content-type': 'text/plain' })
          .end(options.linksHttpError.body);
        return;
      }
      if (linksExpiries > 0) {
        linksExpiries -= 1;
        response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no such session' }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          structuredContent: {
            environmentId: 'env-mac',
            links: [
              { environmentId: 'env-instabox', label: 'Instabox', status: 'unreachable' },
              { environmentId: 'env-omarchy', label: 'omarchy', status: 'reachable' },
              { environmentId: 'env-vps', label: 'paperclip-vps', status: 'reachable' },
            ],
          },
        },
      }));
      return;
    }
    if (name === 't3_thread_launch' && options.loseLaunchReply) {
      request.socket.destroy();
      return;
    }
    if (name === 't3_thread_launch' && options.launchFailure) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          isError: true,
          structuredContent: { error: { _tag: 'ThreadLaunchError' } },
          content: [{ type: 'text', text: 'Thread launch failed.' }],
        },
      }));
      return;
    }
    if (name === 't3_thread_wait') {
      waitCalls += 1;
      // Each expiry ends one session; the reconnected call answers normally, as a real server would.
      if (expiries > 0 && waitCalls % 2 === 1) {
        expiries -= 1;
        response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no such session' }));
        return;
      }
    }
    let structuredContent;
    if (name === 't3_thread_launch') {
      structuredContent = options.launchStructured ?? {
        threadId: 'thread-1',
        runId: 'run-1',
        link: 'https://t3.example/thread-1',
        projectId: args.projectId,
        modelSelection: args.modelSelection,
        status: 'running',
      };
    } else if (timedOutWaits > 0) {
      timedOutWaits -= 1;
      structuredContent = { threadId: 'thread-1', runId: 'run-1', status: 'running', timedOut: true };
    } else {
      const waitStatus = options.waitResultStatus || 'completed';
      structuredContent = {
        threadId: 'thread-1',
        runId: 'run-1',
        status: waitStatus,
        timedOut: false,
        resultRun: { runId: 'run-1', status: waitStatus },
      };
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: { structuredContent },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    initialized: () => initialized,
    call: (name) => calls.filter(({ body }) => body.params?.name === name),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// The refusal codes are set inside the workflow's own gate step, so the test runs that exact script with a fake `gh`
// and the real `jq`, and reads `$GITHUB_OUTPUT` the way GitHub reads it: the last value of a key wins.
function gateRun(scenario) {
  const lines = readFileSync(workflowFile, 'utf8').split('\n');
  const step = lines.findIndex((line) => line.trim() === '- name: Check caller, request, and CI');
  assert.notEqual(step, -1, 'the gate step is missing from .github/workflows/agent-dispatch.yml');
  const runAt = lines.findIndex((line, index) => index > step && line.trim() === 'run: |');
  assert.notEqual(runAt, -1, 'the gate step has no shell script');
  const indent = lines[runAt].search(/\S/);
  const body = [];
  for (let index = runAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    body.push(line.slice(Math.min(line.length, indent + 2)));
  }
  const directory = mkdtempSync(join(tmpdir(), 'tess-gate-'));
  const gh = join(directory, 'gh');
  const output = join(directory, 'github-output');
  writeFileSync(gh, [
    '#!/bin/sh',
    'case "$2" in',
    `  */actions/workflows/*) printf '%s' "$RUN_CONCLUSION" ;;`,
    `  */pulls/*) printf '%s' "$PULL_JSON" ;;`,
    `  */issues/*) printf '%s' "$ISSUE_JSON" ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(gh, 0o755);
  const result = spawnSync('bash', ['-c', body.join('\n')], {
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      AGENT_ALLOWLIST: 'Flame119052',
      COMMENTER: 'Flame119052',
      ISSUE_NUMBER: '90',
      REPOSITORY: 'Flame119052/tess-music',
      COMMENT_BODY: '@tess-agent review',
      RUN_CONCLUSION: 'success',
      ...scenario,
    },
    encoding: 'utf8',
  });
  const written = {};
  for (const line of readFileSync(output, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) written[line.slice(0, at)] = line.slice(at + 1);
  }
  rmSync(directory, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, outputs: written };
}

test('the gate refuses a fork pull request and CI that has not passed, and the tag is answered', () => {
  const issue = JSON.stringify({
    html_url: 'https://github.com/Flame119052/tess-music/pull/90',
    pull_request: { url: 'https://api.github.com/repos/Flame119052/tess-music/pulls/90' },
  });
  const own = JSON.stringify({
    head: { ref: 'tess-agent-dispatch', repo: { full_name: 'Flame119052/tess-music' }, sha: 'a1b2c3d4e5' },
  });
  const fork = JSON.stringify({
    head: { ref: 'patch-1', repo: { full_name: 'someone-else/tess-music' }, sha: 'a1b2c3d4e5' },
  });
  const base = { ISSUE_JSON: issue, PULL_JSON: own };

  const forked = gateRun({ ...base, PULL_JSON: fork });
  assert.equal(forked.status, 0, forked.stderr);
  assert.equal(forked.outputs.refusal, 'fork-pr');
  assert.equal(forked.outputs.allowed, 'false');

  const failed = gateRun({ ...base, RUN_CONCLUSION: 'failure' });
  assert.equal(failed.outputs.refusal, 'ci-not-passed');
  assert.equal(failed.outputs.allowed, 'false');

  // No check run at all on the head commit has not passed either.
  const missing = gateRun({ ...base, RUN_CONCLUSION: '' });
  assert.equal(missing.outputs.refusal, 'ci-not-passed');

  const ok = gateRun(base);
  assert.equal(ok.outputs.allowed, 'true');
  assert.equal(ok.outputs.refusal, '');
  assert.equal(ok.outputs.pr_head_sha, 'a1b2c3d4e5');

  // A stranger and a marked bot comment stay silent on purpose: no thread and no reply.
  const stranger = gateRun({ ...base, COMMENTER: 'someone-else' });
  assert.equal(stranger.outputs.allowed, 'false');
  assert.equal(stranger.outputs.refusal, '');
  const bot = gateRun({ ...base, COMMENT_BODY: '<!-- tess-review-bot -->\n@tess-agent review' });
  assert.equal(bot.outputs.allowed, 'false');
  assert.equal(bot.outputs.refusal, '');
});

test('parses the tag and rejects incomplete or unknown choices', () => {
  assert.deepEqual(
    parseRequest('@tess-agent fix machine=paperclip-vps provider=codex model=gpt-6 effort=max'),
    { task: 'fix', machine: 'vps', provider: 'codex', model: 'gpt-6', effort: 'max' },
  );
  assert.throws(() => parseRequest('@tess-agent review provider=claude'), /given together/);
  assert.throws(() => parseRequest('@tess-agent review machine=toaster'), /machine must be/);
  assert.throws(() => parseRequest(`@tess-agent review\n${'<!-- tess-review-bot -->'}`), /marked/);
  assert.throws(() => parseRequest('@tess-agent reviewx'), /no @tess-agent/);
});

test('a tag in a comment with Windows line endings still parses', () => {
  // GitHub's web form sends \r\n. The gate's awk accepts such a line, so the dispatcher must read it too.
  assert.deepEqual(
    parseRequest('@tess-agent review machine=omarchy\r\nthanks'),
    { task: 'review', machine: 'omarchy' },
  );
  assert.deepEqual(
    parseRequest('please look\r\n@tess-agent fix provider=codex model=gpt-6.1-sol\r\nthank you\r\n'),
    { task: 'fix', provider: 'codex', model: 'gpt-6.1-sol' },
  );
});

test('runner configuration accepts only HTTPS or loopback MCP endpoints', () => {
  assert.throws(() => readConfig({
    HOME: '/home/runner',
    TESS_T3_MCP_URL: 'http://10.0.0.4:3773/mcp',
    TESS_T3_MCP_OAUTH_TOKEN: 'oauth-token',
  }), /HTTPS or loopback/);
  assert.equal(readConfig({
    HOME: '/home/runner',
    TESS_T3_MCP_URL: 'https://mac.example/mcp',
    TESS_T3_MCP_OAUTH_TOKEN: 'oauth-token',
  }).endpoint, 'https://mac.example/mcp');
});

test('the slot directory and cap are read from the runner, never guessed', () => {
  const base = { TESS_T3_MCP_URL: 'https://mac.example/mcp', TESS_T3_MCP_OAUTH_TOKEN: 'oauth-token' };
  assert.equal(readConfig({ ...base, HOME: '/home/tess-dispatch' }).slotDir,
    '/home/tess-dispatch/.local/state/tess-agent-dispatch');
  assert.equal(readConfig({ ...base, HOME: '/home/x', TESS_AGENT_SLOTS: '3' }).slots, 3);
  assert.throws(() => readConfig({ ...base, HOME: '/home/x', TESS_AGENT_SLOTS: 'lots' }), /TESS_AGENT_SLOTS/);
  assert.throws(() => readConfig(base), /HOME/);
  assert.equal(readConfig({ ...base, HOME: '/home/x', TESS_AGENT_SLOT_DIR: '  ' }).slotDir,
    '/home/x/.local/state/tess-agent-dispatch');
  // The queue's patience has a default and a ceiling, so a wait can never outlast the job's own six-hour limit.
  assert.equal(readConfig({ ...base, HOME: '/home/x' }).slotWaitMs, 60 * 60 * 1000);
  assert.equal(readConfig({ ...base, HOME: '/home/x', TESS_AGENT_SLOT_WAIT_MINUTES: '15' }).slotWaitMs,
    15 * 60 * 1000);
  assert.throws(() => readConfig({ ...base, HOME: '/home/x', TESS_AGENT_SLOT_WAIT_MINUTES: '0' }),
    /TESS_AGENT_SLOT_WAIT_MINUTES/);
  assert.throws(() => readConfig({ ...base, HOME: '/home/x', TESS_AGENT_SLOT_WAIT_MINUTES: '600' }),
    /TESS_AGENT_SLOT_WAIT_MINUTES/);
});

test('the credential can come from a private file instead of the job environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-cred-'));
  try {
    const file = join(directory, 'credential');
    dispatch.writeCredential(file, 'oauth-from-file');
    assert.equal(readConfig({
      HOME: directory,
      TESS_T3_MCP_URL: 'https://mac.example/mcp',
      TESS_T3_MCP_CREDENTIAL_FILE: file,
    }).token, 'oauth-from-file');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('default routing never chooses the Mac or paperclip-vps on its own', () => {
  const config = {
    projects: { instabox: 'p1', vps: 'p2', omarchy: 'p3', mac: 'p4' },
    environments: { instabox: 'e1', vps: 'e2', omarchy: 'e3', mac: undefined },
  };
  const links = {
    environmentId: 'mac-endpoint',
    links: [
      { environmentId: 'e1', status: 'unreachable' },
      { environmentId: 'e2', status: 'reachable' },
      { environmentId: 'mac-endpoint', status: 'reachable' },
    ],
  };
  // An untrusted issue must not reach a machine that holds keys or runs Paperclip without someone naming it.
  assert.throws(() => resolveMachine(config, links), /no configured T3 machine is reachable/);
  assert.deepEqual(resolveMachine(config, links, 'vps'), { machine: 'vps', projectId: 'p2', environmentId: 'e2' });
  assert.deepEqual(resolveMachine(config, links, 'mac'), { machine: 'mac', projectId: 'p4', environmentId: 'mac-endpoint' });
});

test('default routing skips unconfigured and unreachable machines in order', () => {
  const target = resolveMachine({
    projects: { instabox: 'p1', vps: 'p2', omarchy: 'p3', mac: 'p4' },
    environments: { instabox: 'e1', vps: 'e2', omarchy: 'e3', mac: undefined },
  }, {
    environmentId: 'local',
    links: [
      { environmentId: 'e1', status: 'unreachable' },
      { environmentId: 'e2', status: 'reachable' },
      { environmentId: 'e3', status: 'reachable' },
    ],
  });
  assert.deepEqual(target, { machine: 'omarchy', projectId: 'p3', environmentId: 'e3' });
  assert.throws(() => resolveMachine({
    projects: { instabox: 'p1' },
    environments: { instabox: 'e1' },
  }, {
    environmentId: 'local',
    links: [{ environmentId: 'e1', status: 'unreachable' }],
  }, 'instabox'), /unreachable/);
});

test('a pull request dispatch works on the commit CI passed', () => {
  assert.throws(() => dispatch.eventContext({
    REPOSITORY: 'Flame119052/tess-music',
    ISSUE_NUMBER: '90',
    COMMENT_ID: '1',
    SUBJECT_URL: 'https://github.com/Flame119052/tess-music/pull/90',
    IS_PR: 'true',
    PR_HEAD_REF: 'tess-agent-dispatch',
  }), /PR_HEAD_SHA/);

  const pr = context({ isPr: true, prHeadRef: 'tess-agent-dispatch', prHeadSha: 'a1b2c3d4e5' });
  const launch = buildLaunchRequest(
    parseRequest('@tess-agent fix'),
    pr,
    { machine: 'omarchy', environmentId: 'env-o', projectId: 'project-o' },
  );
  assert.match(launch.message, /a1b2c3d4e5/);
  assert.match(launch.message, /if the PR head has moved/i);
});

test('launch shape uses plan mode and provider options, with the PR head only for a fix', () => {
  const target = { machine: 'omarchy', environmentId: 'env-o', projectId: 'project-o' };
  const review = buildLaunchRequest(
    parseRequest('@tess-agent review provider=grok model=grok-4.7 effort=high'),
    context(),
    target,
  );
  assert.deepEqual(review.modelSelection, {
    instanceId: 'grok',
    model: 'grok-4.7',
    options: { effort: 'high' },
  });
  assert.equal(review.interactionMode, 'plan');
  assert.deepEqual(review.workspaceStrategy, {
    type: 'worktree',
    baseRef: 'main',
    branch: 'tess-agent-review-88-1234',
    startFromOrigin: true,
  });

  const fix = buildLaunchRequest(
    parseRequest('@tess-agent fix machine=mac'),
    context({ isPr: true, prHeadRef: 'repair-player', prHeadSha: 'deadbeef' }),
    { machine: 'mac', environmentId: 'env-m', projectId: 'project-m' },
  );
  assert.equal(fix.workspaceStrategy.baseRef, 'repair-player');
  assert.equal(fix.interactionMode, undefined);
  assert.equal(fix.workspaceStrategy.startFromOrigin, true);
});

test('the slot cap is durable, configurable, and a freed slot admits the queue', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-slots-'));
  try {
    const first = await claimSlot(directory, { id: 1 }, { attempts: 1 });
    const second = await claimSlot(directory, { id: 2 }, { attempts: 1 });
    await assert.rejects(claimSlot(directory, { id: 3 }, { attempts: 1 }), /occupied/);
    releaseSlot(first);
    const third = await claimSlot(directory, { id: 3 }, { attempts: 1 });
    assert.equal(third, first);
    releaseSlot(second);
    releaseSlot(third);
    for (let index = 0; index < 3; index += 1) await claimSlot(directory, { id: index }, { attempts: 1, slots: 3 });
    await assert.rejects(claimSlot(directory, { id: 4 }, { attempts: 1, slots: 3 }), /occupied/);
    assert.equal(readdirSync(directory).length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a slot whose job can no longer be running is reclaimed, a live one is kept', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-stale-'));
  try {
    const dead = join(directory, 'slot-1');
    const live = join(directory, 'slot-2');
    mkdirSync(dead, { recursive: true, mode: 0o700 });
    mkdirSync(live, { recursive: true, mode: 0o700 });
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(dead, 'owner.json'), JSON.stringify({ claimedAt: eightHoursAgo, commentId: '1' }));
    writeFileSync(join(live, 'owner.json'), JSON.stringify({ claimedAt: new Date().toISOString(), commentId: '2' }));
    // The job that claimed slot-1 was killed at its 360-minute limit, so nothing can still be holding it.
    const claimed = await claimSlot(directory, { claimedAt: new Date().toISOString(), commentId: '3' },
      { slots: 2, attempts: 1 });
    assert.equal(claimed, dead);
    assert.equal(JSON.parse(readFileSync(join(claimed, 'owner.json'), 'utf8')).commentId, '3');
    await assert.rejects(claimSlot(directory, { commentId: '4' }, { slots: 2, attempts: 1 }), /occupied/);
    assert.equal(JSON.parse(readFileSync(join(live, 'owner.json'), 'utf8')).commentId, '2');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a slot with no owner record expires only after the same age, so a claim in progress is never taken', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-orphan-'));
  try {
    const orphan = join(directory, 'slot-1');
    mkdirSync(orphan, { recursive: true, mode: 0o700 });
    // Fresh: the directory exists before its owner record is written, so this may simply be mid-claim.
    await assert.rejects(claimSlot(directory, { commentId: '1' }, { attempts: 1, slots: 1 }), /occupied/);
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
    utimesSync(orphan, eightHoursAgo, eightHoursAgo);
    const claimed = await claimSlot(directory, { claimedAt: new Date().toISOString(), commentId: '2' },
      { attempts: 1, slots: 1 });
    assert.equal(claimed, orphan);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a busy lane waits a bounded time, then records the slots-busy reason for the person who tagged', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-busy-'));
  const slotDir = join(directory, 'slots');
  const refusalFile = join(directory, 'refusal.json');
  mkdirSync(join(slotDir, 'slot-1'), { recursive: true });
  mkdirSync(join(slotDir, 'slot-2'), { recursive: true });
  const mock = await mockMcp();
  let polls = 0;
  const wait = async () => {
    polls += 1;
    // An unbounded wait ties up one of two runner instances until GitHub cancels the job, and a cancelled job
    // posts nothing. A hundred and fifty polls is far more than the one-hour budget needs.
    if (polls > 150) throw new Error('claimSlot waited without a limit');
  };
  try {
    await assert.rejects(
      run(runnerEnv(mock.endpoint, slotDir, { REFUSAL_FILE: refusalFile }), fetch, { wait }),
      /occupied/,
    );
    assert.equal(polls, 119);
    assert.deepEqual(JSON.parse(readFileSync(refusalFile, 'utf8')), { reason: 'slots-busy' });
    assert.equal(mock.call('t3_thread_launch').length, 0);
  } finally {
    await mock.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a slot claimed moments ago is never reclaimed, even by a queue that waits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-fresh-'));
  try {
    const fresh = join(directory, 'slot-1');
    mkdirSync(fresh, { recursive: true, mode: 0o700 });
    writeFileSync(join(fresh, 'owner.json'), JSON.stringify({ claimedAt: new Date().toISOString(), commentId: '1' }));
    await assert.rejects(claimSlot(directory, { commentId: '2' }, { attempts: 1, slots: 1 }), /occupied/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a slot is not left behind when its owner record cannot be written', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-owner-'));
  try {
    const failure = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    await assert.rejects(
      claimSlot(directory, { commentId: '1' }, {
        attempts: 1,
        writeOwner: () => { throw failure; },
      }),
      /no space left/,
    );
    // A directory with no owner record can be reconciled by nobody, so it must not survive a failed claim.
    assert.deepEqual(readdirSync(directory), []);
    const claimed = await claimSlot(directory, { claimedAt: new Date().toISOString(), commentId: '2' },
      { attempts: 1 });
    assert.equal(claimed, join(directory, 'slot-1'));
    releaseSlot(claimed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mock MCP handshake launches on the first default machine and releases its slot', async () => {
  const mock = await mockMcp();
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-run-'));
  try {
    await run(runnerEnv(mock.endpoint, slotDir));
    assert.equal(mock.initialized(), 1);
    const [launch] = mock.call('t3_thread_launch');
    assert.equal(launch.body.params.arguments.environmentId, 'env-omarchy');
    assert.equal(launch.body.params.arguments.projectId, 'project-omarchy');
    assert.doesNotMatch(launch.body.params.arguments.message, /Paperclip comes first/);
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('a named VPS thread carries the Paperclip limits in its first prompt', async () => {
  const mock = await mockMcp();
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-vps-'));
  try {
    await run(runnerEnv(mock.endpoint, slotDir, { COMMENT_BODY: '@tess-agent review machine=paperclip-vps' }));
    const [launch] = mock.call('t3_thread_launch');
    assert.equal(launch.body.params.arguments.environmentId, 'env-vps');
    const message = launch.body.params.arguments.message;
    assert.match(message, /Paperclip comes first/);
    assert.match(message, /\/srv\/paperclip/);
    assert.match(message, /no builds or long tests/i);
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('a lost launch reply keeps the slot for manual reconciliation', async () => {
  const mock = await mockMcp({ loseLaunchReply: true });
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-lost-'));
  try {
    await assert.rejects(run(runnerEnv(mock.endpoint, slotDir)));
    assert.deepEqual(readdirSync(slotDir), ['slot-1']);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('each wait returns before the fetch timeout, so a long thread keeps its slot', async () => {
  const mock = await mockMcp({ waitTimedOut: 2 });
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-wait-'));
  try {
    await run(runnerEnv(mock.endpoint, slotDir));
    const waits = mock.call('t3_thread_wait');
    assert.equal(waits.length, 3);
    for (const wait of waits) {
      assert.ok(wait.body.params.arguments.timeoutMs <= 4 * 60 * 1000,
        `wait asked for ${wait.body.params.arguments.timeoutMs} ms, which Node's fetch abandons after 300 s`);
    }
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('an expired MCP session reconnects and keeps waiting instead of leaving the slot', async () => {
  const mock = await mockMcp({ waitExpiries: 1 });
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-expire-'));
  try {
    await run(runnerEnv(mock.endpoint, slotDir));
    assert.equal(mock.initialized(), 2);
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('a thread longer than several MCP sessions still finishes and frees its slot', async () => {
  // Each expiry ends one session. A six-hour job outlives more than the per-expiry reconnect budget.
  const mock = await mockMcp({ waitExpiries: 5, waitTimedOut: 4 });
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-sessions-'));
  try {
    await run(runnerEnv(mock.endpoint, slotDir));
    assert.equal(mock.initialized(), 6);
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('the machine is chosen after the slot is claimed, so the answer is never stale', async () => {
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-order-'));
  let slotsAtLinks;
  const mock = await mockMcp({ onCall: (name) => { if (name === 't3_environment_links') slotsAtLinks = readdirSync(slotDir); } });
  try {
    await run(runnerEnv(mock.endpoint, slotDir));
    assert.deepEqual(slotsAtLinks, ['slot-1']);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('a launch result that carries a tag is a success, not a refusal, so its thread keeps the slot', async () => {
  // T3 tags failures only. If a success value ever carried a tag, reading it as a refusal would free a slot for a
  // thread that is still running and break the two-thread cap.
  const mock = await mockMcp({
    launchStructured: {
      _tag: 'LaunchResult',
      threadId: 'thread-1',
      runId: 'run-1',
      link: 'https://t3.example/thread-1',
      projectId: 'project-omarchy',
      status: 'running',
    },
  });
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-tagged-'));
  try {
    await run(runnerEnv(mock.endpoint, slotDir));
    assert.equal(mock.call('t3_thread_wait').length, 1);
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('a launch result with no thread id keeps its slot, because the thread may exist', async () => {
  const mock = await mockMcp({ launchStructured: { status: 'running' } });
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-noid-'));
  try {
    await assert.rejects(run(runnerEnv(mock.endpoint, slotDir)), /no threadId/);
    assert.deepEqual(readdirSync(slotDir), ['slot-1']);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('a launch T3 itself refused frees its slot, because no thread exists', async () => {
  const mock = await mockMcp({ launchFailure: true });
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-refused-'));
  try {
    await assert.rejects(run(runnerEnv(mock.endpoint, slotDir)), /Thread launch failed/);
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('a refused request records a fixed reason the workflow can post on the issue', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-refusal-'));
  const refusalFile = join(directory, 'refusal.json');
  const slotDir = join(directory, 'slots');
  try {
    await assert.rejects(
      run(runnerEnv('http://127.0.0.1:1/mcp', slotDir, {
        COMMENT_BODY: '@tess-agent review machine=toaster',
        REFUSAL_FILE: refusalFile,
      })),
      /machine must be/,
    );
    assert.deepEqual(JSON.parse(readFileSync(refusalFile, 'utf8')), { reason: 'invalid-options' });

    mkdirSync(join(slotDir, 'slot-1'), { recursive: true });
    mkdirSync(join(slotDir, 'slot-2'), { recursive: true });
    const mock = await mockMcp();
    await assert.rejects(
      run(runnerEnv(mock.endpoint, slotDir, { REFUSAL_FILE: refusalFile }), fetch, { attempts: 1 }),
      /occupied/,
    );
    assert.deepEqual(JSON.parse(readFileSync(refusalFile, 'utf8')), { reason: 'slots-busy' });
    await mock.close();
    assert.equal(mock.call('t3_thread_launch').length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a refusal comment starts with the marker, states a fixed reason, and links the run', () => {
  const runUrl = 'https://github.com/Flame119052/tess-music/actions/runs/123';
  const text = dispatch.refusalComment('machine-unreachable', runUrl);
  assert.match(text, /^<!-- tess-review-bot -->/);
  assert.match(text, /did not run/);
  assert.match(text, /machine/);
  assert.ok(text.includes(runUrl));
  // Only the known reasons are printable: no error text, path or token from the runner can reach the comment.
  const fallback = dispatch.refusalComment('../../etc/passwd tok_live_abc', runUrl);
  assert.equal(fallback.includes('tok_live_abc'), false);
  assert.equal(fallback.includes('passwd'), false);
  assert.match(fallback, /a thread may already have run/);
});

test('the preflight check reports machines without starting a thread', async () => {
  const mock = await mockMcp();
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-check-'));
  const lines = [];
  try {
    assert.equal(typeof dispatch.check === 'function', true);
    await dispatch.check(runnerEnv(mock.endpoint, slotDir), fetch, (line) => lines.push(line));
    const report = lines.join('\n');
    assert.match(report, /instabox: unreachable/);
    assert.match(report, /omarchy: ready/);
    assert.match(report, /vps: ready/);
    assert.match(report, /mac: ready \(only when named\)/);
    assert.match(report, /2 of 2 slots free/);
    assert.equal(mock.call('t3_thread_launch').length, 0);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('the dispatcher runner hook admits only this workflow on issue comments from main', () => {
  const runHook = (env) => spawnSync('sh', [hook], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  const allowed = {
    GITHUB_EVENT_NAME: 'issue_comment',
    GITHUB_WORKFLOW_REF: 'Flame119052/tess-music/.github/workflows/agent-dispatch.yml@refs/heads/main',
  };
  assert.equal(runHook(allowed).status, 0);
  assert.equal(runHook({ ...allowed, GITHUB_EVENT_NAME: 'pull_request' }).status, 1);
  assert.equal(runHook({ ...allowed, GITHUB_EVENT_NAME: 'workflow_dispatch' }).status, 1);
  assert.equal(runHook({
    ...allowed,
    GITHUB_WORKFLOW_REF: 'Flame119052/tess-music/.github/workflows/agent-dispatch.yml@refs/heads/tess-agent-dispatch',
  }).status, 1);
  assert.equal(runHook({
    ...allowed,
    GITHUB_WORKFLOW_REF: 'Flame119052/tess-music/.github/workflows/check.yml@refs/heads/main',
  }).status, 1);
  assert.equal(runHook({}).status, 1);
});

test('a session that expires during a slot wait reconnects before reading machine links', async () => {
  const mock = await mockMcp({ linksExpiries: 1 });
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-wait-links-'));
  const slotDir = join(directory, 'slots');
  const refusalFile = join(directory, 'refusal.json');
  const occupied = join(slotDir, 'slot-1');
  mkdirSync(occupied, { recursive: true, mode: 0o700 });
  writeFileSync(join(occupied, 'owner.json'), JSON.stringify({ claimedAt: new Date().toISOString(), commentId: '1' }));
  try {
    await run(runnerEnv(mock.endpoint, slotDir, {
      TESS_AGENT_SLOTS: '1',
      REFUSAL_FILE: refusalFile,
    }), fetch, {
      wait: async () => {
        rmSync(occupied, { recursive: true, force: true });
      },
    });
    assert.equal(mock.initialized(), 2);
    assert.equal(mock.call('t3_environment_links').length, 2);
    assert.equal(mock.call('t3_thread_launch').length, 1);
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    await mock.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a sign-in failure when reconnecting after a slot wait records sign-in and frees the slot', async () => {
  const mock = await mockMcp({ linksExpiries: 1, rejectReconnect: true });
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-wait-signin-'));
  const slotDir = join(directory, 'slots');
  const refusalFile = join(directory, 'refusal.json');
  try {
    await assert.rejects(
      run(runnerEnv(mock.endpoint, slotDir, { REFUSAL_FILE: refusalFile })),
      /sign-in failed after the slot wait/,
    );
    assert.deepEqual(JSON.parse(readFileSync(refusalFile, 'utf8')), { reason: 'sign-in' });
    assert.deepEqual(readdirSync(slotDir), []);
  } finally {
    await mock.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a slot retained after a lost launch reply is never reclaimed by age', async () => {
  const mock = await mockMcp({ loseLaunchReply: true });
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-retained-'));
  try {
    await assert.rejects(run(runnerEnv(mock.endpoint, slotDir, { TESS_AGENT_SLOTS: '1' })));
    const retainedOwner = JSON.parse(readFileSync(join(slotDir, 'slot-1', 'owner.json'), 'utf8'));
    assert.equal(retainedOwner.retained, true);

    const eightHoursLater = Date.now() + 8 * 60 * 60 * 1000;
    await assert.rejects(
      claimSlot(slotDir, { claimedAt: new Date(eightHoursLater).toISOString(), commentId: 'next' }, {
        slots: 1,
        attempts: 1,
        now: () => eightHoursLater,
      }),
      /occupied/,
    );
    const stillOwner = JSON.parse(readFileSync(join(slotDir, 'slot-1', 'owner.json'), 'utf8'));
    assert.equal(stillOwner.commentId, '1234');
    assert.equal(stillOwner.retained, true);
  } finally {
    await mock.close();
    rmSync(slotDir, { recursive: true, force: true });
  }
});

test('stale slot reclaim is serialized under reclaim.lock so two instances cannot double-claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-reclaim-lock-'));
  try {
    const slot = join(directory, 'slot-1');
    const lock = join(directory, 'reclaim.lock');
    mkdirSync(slot, { recursive: true, mode: 0o700 });
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(slot, 'owner.json'), JSON.stringify({ claimedAt: eightHoursAgo, commentId: 'stale' }));
    mkdirSync(lock, { mode: 0o700 });

    // While another instance holds reclaim.lock, this instance must not delete or take slot-1.
    await assert.rejects(
      claimSlot(directory, { claimedAt: new Date().toISOString(), commentId: 'competing' }, {
        slots: 1,
        attempts: 1,
      }),
      /occupied/,
    );
    assert.equal(JSON.parse(readFileSync(join(slot, 'owner.json'), 'utf8')).commentId, 'stale');

    // Once the other instance replaces slot-1 and releases reclaim.lock, the fresh claim stays protected.
    writeFileSync(join(slot, 'owner.json'), JSON.stringify({ claimedAt: new Date().toISOString(), commentId: 'winner' }));
    rmSync(lock, { recursive: true, force: true });
    await assert.rejects(
      claimSlot(directory, { claimedAt: new Date().toISOString(), commentId: 'competing' }, {
        slots: 1,
        attempts: 1,
      }),
      /occupied/,
    );
    assert.equal(JSON.parse(readFileSync(join(slot, 'owner.json'), 'utf8')).commentId, 'winner');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runCliSubprocess(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dispatchScript], { env, encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('public run logs print only thread ID and refusal code while full errors go to a mode-600 private log', async () => {
  const okMock = await mockMcp();
  const okDir = mkdtempSync(join(tmpdir(), 'tess-agent-log-ok-'));
  const failMock = await mockMcp({
    linksHttpError: { status: 500, body: 'secret-mac-host.internal-leak' },
  });
  const failDir = mkdtempSync(join(tmpdir(), 'tess-agent-log-fail-'));
  const failSlots = join(failDir, 'slots');
  const refusalFile = join(failDir, 'refusal.json');
  try {
    const okRun = await runCliSubprocess({ ...runnerEnv(okMock.endpoint, okDir), PATH: process.env.PATH });
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.match(okRun.stdout, /T3 thread thread-1 settled with status completed/);
    assert.equal(okRun.stdout.includes('https://t3.example/thread-1'), false);

    const failRun = await runCliSubprocess({
      ...runnerEnv(failMock.endpoint, failSlots, { REFUSAL_FILE: refusalFile }),
      PATH: process.env.PATH,
    });
    assert.equal(failRun.status, 1);
    assert.match(failRun.stderr, /tess-agent dispatch stopped: dispatch-failed/);
    assert.equal(failRun.stderr.includes('secret-mac-host.internal-leak'), false);
    assert.equal(failRun.stderr.includes('127.0.0.1'), false);
    assert.equal(failRun.stderr.includes('MCP HTTP 500'), false);

    const errorLog = join(failSlots, 'last-error.log');
    assert.equal(statSync(errorLog).mode & 0o777, 0o600);
    assert.match(readFileSync(errorLog, 'utf8'), /secret-mac-host\.internal-leak/);
    assert.deepEqual(JSON.parse(readFileSync(refusalFile, 'utf8')), { reason: 'dispatch-failed' });
  } finally {
    await okMock.close();
    await failMock.close();
    rmSync(okDir, { recursive: true, force: true });
    rmSync(failDir, { recursive: true, force: true });
  }
});

test('default routing refuses a mistyped environment ID pointing at the Mac or VPS', () => {
  const links = {
    environmentId: 'mac-endpoint',
    links: [
      { environmentId: 'e-instabox', status: 'unreachable' },
      { environmentId: 'e-vps', status: 'reachable' },
      { environmentId: 'mac-endpoint', status: 'reachable' },
    ],
  };
  assert.throws(() => resolveMachine({
    projects: { instabox: 'p1', vps: 'p2', omarchy: 'p3', mac: 'p4' },
    environments: { instabox: 'e-instabox', vps: 'e-vps', omarchy: 'mac-endpoint', mac: 'mac-endpoint' },
  }, links), /no configured T3 machine is reachable/);

  assert.throws(() => resolveMachine({
    projects: { instabox: 'p1', vps: 'p2', omarchy: 'p3', mac: 'p4' },
    environments: { instabox: 'e-instabox', vps: 'e-vps', omarchy: 'e-vps', mac: 'mac-endpoint' },
  }, links), /no configured T3 machine is reachable/);
});

test('a settled thread that did not complete records thread-failed with non-misleading notice text', async () => {
  const mock = await mockMcp({ waitResultStatus: 'failed' });
  const directory = mkdtempSync(join(tmpdir(), 'tess-agent-thread-failed-'));
  const slotDir = join(directory, 'slots');
  const refusalFile = join(directory, 'refusal.json');
  try {
    await assert.rejects(
      run(runnerEnv(mock.endpoint, slotDir, { REFUSAL_FILE: refusalFile })),
      /ended with status failed/,
    );
    assert.deepEqual(readdirSync(slotDir), []);
    assert.deepEqual(JSON.parse(readFileSync(refusalFile, 'utf8')), { reason: 'thread-failed' });
    const notice = dispatch.refusalComment('thread-failed', 'https://github.com/Flame119052/tess-music/actions/runs/99');
    assert.match(notice, /^<!-- tess-review-bot -->/);
    assert.match(notice, /@tess-agent did not finish:/);
    assert.equal(notice.includes('did not run'), false);
  } finally {
    await mock.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
