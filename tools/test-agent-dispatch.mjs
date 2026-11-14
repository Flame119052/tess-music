import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildLaunchRequest,
  claimSlot,
  parseRequest,
  readConfig,
  releaseSlot,
  resolveMachine,
  run,
} from './agent-dispatch.mjs';

function context(overrides = {}) {
  return {
    repository: 'Flame119052/tess-music',
    number: 88,
    commentId: '1234',
    url: 'https://github.com/Flame119052/tess-music/issues/88',
    isPr: false,
    prHeadRef: undefined,
    ...overrides,
  };
}

function runnerEnv(endpoint, slotDir, overrides = {}) {
  return {
    HOME: tmpdir(),
    TESS_T3_MCP_URL: endpoint,
    TESS_T3_MCP_OAUTH_TOKEN: 'oauth-issued-test-token',
    TESS_AGENT_SLOT_DIR: slotDir,
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
  let initialized = false;
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
      response.setHeader('content-type', 'application/json');
      response.setHeader('mcp-session-id', 'mock-session');
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
      initialized = true;
      response.writeHead(202).end();
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer oauth-issued-test-token');
    assert.equal(request.headers['mcp-session-id'], 'mock-session');
    const { name, arguments: args } = body.params;
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
    const structuredContent = name === 't3_thread_launch'
      ? {
        threadId: 'thread-1',
        runId: 'run-1',
        link: 'https://t3.example/thread-1',
        projectId: args.projectId,
        modelSelection: args.modelSelection,
        status: 'running',
      }
      : {
        threadId: 'thread-1',
        runId: 'run-1',
        status: 'completed',
        timedOut: false,
        resultRun: { runId: 'run-1', status: 'completed' },
      };
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
  assert.deepEqual(target, { machine: 'vps', projectId: 'p2', environmentId: 'e2' });
  assert.throws(() => resolveMachine({
    projects: { instabox: 'p1' },
    environments: { instabox: 'e1' },
  }, {
    environmentId: 'local',
    links: [{ environmentId: 'e1', status: 'unreachable' }],
  }, 'instabox'), /unreachable/);
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
    context({ isPr: true, prHeadRef: 'repair-player' }),
    { machine: 'mac', environmentId: 'env-m', projectId: 'project-m' },
  );
  assert.equal(fix.workspaceStrategy.baseRef, 'repair-player');
  assert.equal(fix.interactionMode, undefined);
});

test('two durable slots cap dispatch and a freed slot admits the queue', async () => {
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mock MCP handshake launches on the first reachable machine and releases its slot', async () => {
  const mock = await mockMcp();
  const slotDir = mkdtempSync(join(tmpdir(), 'tess-agent-run-'));
  try {
    await run(runnerEnv(mock.endpoint, slotDir));
    assert.equal(mock.initialized(), true);
    const launch = mock.calls.find(({ body }) => body.params?.name === 't3_thread_launch');
    assert.equal(launch.body.params.arguments.environmentId, 'env-vps');
    assert.equal(launch.body.params.arguments.projectId, 'project-vps');
    assert.match(launch.body.params.arguments.message, /Paperclip comes first/);
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
