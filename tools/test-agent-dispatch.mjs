import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
      structuredContent = {
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
      structuredContent = {
        threadId: 'thread-1',
        runId: 'run-1',
        status: 'completed',
        timedOut: false,
        resultRun: { runId: 'run-1', status: 'completed' },
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
