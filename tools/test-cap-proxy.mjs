// Tests for support/cap-proxy/proxy.mjs (the isolated daily-cap and API-key proxy).
// No network, no real keys. Starts a loopback mock upstream and real proxy instances / child processes.
// Usage: node tools/test-cap-proxy.mjs
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  createCapProxy,
  extractTelegramUserId,
  extractTokensFromUsage,
  matchCapRoute,
  validateUpstreamUrl,
} from '../support/cap-proxy/proxy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PROXY_SCRIPT = join(root, 'support/cap-proxy/proxy.mjs');
const box = mkdtempSync(join(tmpdir(), 'tess-cap-proxy-test-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMockUpstream() {
  const seen = [];
  let mode = 'json';
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (mode === 'json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 300, completion_tokens: 200 },
        }));
      } else if (mode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"total_tokens":600}}\n\n');
        res.end('data: [DONE]\n\n');
      } else if (mode === 'malformed-json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{not valid json at all');
      } else if (mode === 'malformed-sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {broken\n\n');
        res.write('data: {"usage":{"total_tokens":-999}}\n\n');
        res.end('not even sse');
      } else if (mode === 'html-502') {
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end('<html><body>Bad Gateway</body></html>');
      } else if (mode === 'bad-usage') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', usage: { total_tokens: 'NaN', prompt_tokens: -5, completion_tokens: 1.5 } }));
      } else if (mode === 'drop') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        req.socket?.destroy();
        res.destroy();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/zen/go/v1`,
        seen,
        setMode: (m) => { mode = m; },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function sendHttp({ port, socketPath, method = 'POST', path = '/v1/chat/completions', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        ...(socketPath ? { socketPath } : { hostname: '127.0.0.1', port }),
        method,
        path,
        headers: {
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sendRawHttp(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(rawRequest);
    });
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
}

async function spawnProxyProcess(env) {
  const readyFile = join(box, `ready-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: {
      PATH: process.env.PATH,
      TESS_TEST: '1',
      TESS_CAP_READY_FILE: readyFile,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (existsSync(readyFile)) {
      const url = readFileSync(readyFile, 'utf8').trim();
      if (url) {
        return {
          url,
          port: Number(new URL(url).port),
          stop: () => new Promise((done) => {
            child.once('exit', done);
            child.kill('SIGTERM');
          }),
        };
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`proxy exited early (${child.exitCode}): ${stderr}`);
    }
    await sleep(25);
  }
  child.kill('SIGKILL');
  throw new Error(`proxy timed out starting: ${stderr}`);
}

try {
  // 1. Pure helper unit checks.
  assert.deepEqual(matchCapRoute('POST', '/v1/chat/completions'), {
    method: 'POST',
    path: '/v1/chat/completions',
    upstreamSuffix: '/chat/completions',
  });
  for (const [m, p] of [
    ['GET', '/v1/chat/completions'],
    ['DELETE', '/v1/chat/completions'],
    ['POST', '/v1/models'],
    ['POST', '/v1/files'],
    ['POST', '/v1/responses'],
    ['POST', '/v1/chat/completions?beta=true'],
    ['POST', '/v1/chat/completions#frag'],
    ['POST', '/v1/../v1/chat/completions'],
    ['POST', '/v1//chat/completions'],
    ['POST', '/v1/chat%2fcompletions'],
    ['POST', '/v1\\chat\\completions'],
    ['POST', 'https://opencode.ai/v1/chat/completions'],
  ]) {
    assert.equal(matchCapRoute(m, p), null, `refuses ${m} ${p}`);
  }

  assert.deepEqual(
    extractTelegramUserId({ 'x-opencode-session': 'agent:main:telegram:dm:900000001' }, {}),
    { ok: true, userId: '900000001' },
  );
  assert.deepEqual(
    extractTelegramUserId({ 'x-tess-user-id': '123456789' }, {}),
    { ok: true, userId: '123456789' },
  );
  assert.equal(extractTelegramUserId({ 'x-tess-user-id': '../etc' }, {}).ok, false);
  assert.equal(extractTokensFromUsage({ prompt_tokens: 10, completion_tokens: 20 }), 30);
  assert.equal(extractTokensFromUsage({ total_tokens: 99, prompt_tokens: 10 }), 99);
  assert.equal(extractTokensFromUsage({ total_tokens: -5 }), 0);
  assert.equal(extractTokensFromUsage({ total_tokens: 'bad' }), 0);

  assert.throws(() => validateUpstreamUrl('https://user:pass@opencode.ai/zen/go/v1', { allowAnyUpstream: true }));
  assert.throws(() => validateUpstreamUrl('https://evil.example/v1', { allowAnyUpstream: false }));
  assert.doesNotThrow(() => validateUpstreamUrl('https://opencode.ai/zen/go/v1', { allowAnyUpstream: false }));

  const upstream = await startMockUpstream();
  const realKey = 'real_opencode_go_key_secret_xyz';
  const proxyToken = 'tess-cap-local-proxy-token-abc';
  const stateDir = join(box, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = join(stateDir, 'daily-cap.json');

  // Refuse non-loopback listen hosts.
  await assert.rejects(() => createCapProxy({
    apiKey: realKey,
    token: proxyToken,
    upstream: upstream.url,
    allowAnyUpstream: true,
    listenHost: '0.0.0.0',
    listenPort: 0,
    statePath: stateFile,
  }), /loopback/);

  // 2. Route, host, method, and header stripping checks against a live proxy.
  const proxy = await createCapProxy({
    apiKey: realKey,
    token: proxyToken,
    upstream: upstream.url,
    allowAnyUpstream: true,
    listenHost: '127.0.0.1',
    listenPort: 0,
    statePath: stateFile,
    replyCap: 10,
    userCap: 5,
    todayOverride: '2026-11-18',
  });
  const port = proxy.port;

  try {
    const validBody = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] });
    const authHeaders = {
      authorization: `Bearer ${proxyToken}`,
      'content-type': 'application/json',
      'x-opencode-session': 'agent:main:telegram:dm:900000001',
      'x-tess-user-id': '900000001',
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-host': 'evil.com',
    };

    // Missing / wrong proxy token -> 401.
    const noAuth = await sendHttp({ port, body: validBody, headers: { 'content-type': 'application/json' } });
    assert.equal(noAuth.status, 401);
    const badAuth = await sendHttp({ port, body: validBody, headers: { authorization: `Bearer ${realKey}`, 'content-type': 'application/json' } });
    assert.equal(badAuth.status, 401);

    // Other methods / paths -> 403.
    for (const [m, p] of [
      ['GET', '/v1/chat/completions'],
      ['DELETE', '/v1/chat/completions'],
      ['POST', '/v1/models'],
      ['POST', '/v1/files'],
      ['POST', '/v1/chat/completions?debug=1'],
    ]) {
      const res = await sendHttp({ port, method: m, path: p, headers: authHeaders, body: validBody });
      assert.equal(res.status, 403, `expected 403 for ${m} ${p}`);
    }

    // Raw socket tests: path tricks, absolute-form URL, non-loopback Host, CONNECT, Upgrade -> 403.
    for (const [label, raw] of [
      ['dot segment', `POST /v1/../v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${proxyToken}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`],
      ['percent slash', `POST /v1/chat%2fcompletions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${proxyToken}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`],
      ['absolute-form URL', `POST http://opencode.ai/v1/chat/completions HTTP/1.1\r\nHost: opencode.ai\r\nAuthorization: Bearer ${proxyToken}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`],
      ['evil Host header', `POST /v1/chat/completions HTTP/1.1\r\nHost: opencode.ai\r\nAuthorization: Bearer ${proxyToken}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`],
      ['CONNECT tunnel', `CONNECT opencode.ai:443 HTTP/1.1\r\nHost: opencode.ai:443\r\n\r\n`],
      ['Upgrade header', `GET /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`],
    ]) {
      const rawResp = await sendRawHttp(port, raw);
      assert.match(rawResp, /^HTTP\/1\.1 403 /, `raw request refused (${label})`);
    }
    assert.equal(upstream.seen.length, 0, 'no refused request ever reached upstream');

    // Allowed request forwards to exact upstream path with real API key & stripped identity headers.
    const okRes = await sendHttp({ port, headers: authHeaders, body: validBody });
    assert.equal(okRes.status, 200);
    assert.equal(upstream.seen.length, 1);
    const fwd = upstream.seen[0];
    assert.equal(fwd.method, 'POST');
    assert.equal(fwd.url, '/zen/go/v1/chat/completions');
    assert.equal(fwd.headers.authorization, `Bearer ${realKey}`);
    assert.ok(!fwd.headers.authorization.includes(proxyToken));
    assert.equal(fwd.headers.host, new URL(upstream.url).host);
    assert.equal(fwd.headers['x-opencode-session'], 'agent:main:telegram:dm:900000001');
    assert.equal(fwd.headers['x-tess-user-id'], undefined);
    assert.equal(fwd.headers['x-forwarded-for'], undefined);
    assert.equal(fwd.headers['x-forwarded-host'], undefined);
  } finally {
    await proxy.close();
  }

  // 3. Caps persist across real proxy restarts, per-person + total + token budget, UTC rollover, malformed upstream.
  const procStateDir = join(box, 'proc-state');
  mkdirSync(procStateDir, { recursive: true, mode: 0o700 });
  const capEnvFile = join(box, 'tess-cap.env');
  writeFileSync(capEnvFile, [
    `OPENCODE_GO_API_KEY=${realKey}`,
    `TESS_CAP_PROXY_TOKEN=${proxyToken}`,
    `TESS_CAP_UPSTREAM=${upstream.url}`,
    `TESS_CAP_LISTEN_HOST=127.0.0.1`,
    `TESS_CAP_LISTEN_PORT=0`,
    `TESS_DAILY_REPLY_CAP=3`,
    `TESS_DAILY_USER_CAP=2`,
    `TESS_DAILY_TOKEN_CAP=0`,
  ].join('\n') + '\n', { mode: 0o600 });

  const procBaseEnv = {
    TESS_CAP_ENV_FILE: capEnvFile,
    STATE_DIRECTORY: procStateDir,
    TESS_CAP_TODAY: '2026-11-18',
  };

  upstream.seen.length = 0;
  let p1 = await spawnProxyProcess(procBaseEnv);
  try {
    const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'help' }] });
    const reqA = { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json', 'x-opencode-session': 'agent:main:telegram:dm:111111111' };
    assert.equal((await sendHttp({ port: p1.port, headers: reqA, body })).status, 200);
    assert.equal((await sendHttp({ port: p1.port, headers: reqA, body })).status, 200);
  } finally {
    await p1.stop();
  }

  // Restart proxy: user A's 2/2 count survives restart -> 3rd request is blocked with 429 before hitting upstream.
  let p2 = await spawnProxyProcess(procBaseEnv);
  try {
    const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'help' }] });
    const reqA = { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json', 'x-opencode-session': 'agent:main:telegram:dm:111111111' };
    const reqB = { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json', 'x-opencode-session': 'agent:main:telegram:dm:222222222' };
    const hitUser = await sendHttp({ port: p2.port, headers: reqA, body });
    assert.equal(hitUser.status, 429);
    const hitUserJson = JSON.parse(hitUser.text);
    assert.equal(hitUserJson.error.code, 'terminal_quota_exhausted');
    assert.equal(hitUserJson.error.limit_type, 'user');
    assert.match(hitUserJson.error.message, /00:00 UTC/);
    assert.equal(upstream.seen.length, 2, 'per-person cap hit never reached upstream');

    // User B takes slot 3/3.
    assert.equal((await sendHttp({ port: p2.port, headers: reqB, body })).status, 200);
    assert.equal(upstream.seen.length, 3);
  } finally {
    await p2.stop();
  }

  // Restart again: total cap 3/3 blocks both User B and unauthenticated-tg-id requests.
  let p3 = await spawnProxyProcess(procBaseEnv);
  try {
    const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'help' }] });
    const reqB = { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json', 'x-opencode-session': 'agent:main:telegram:dm:222222222' };
    const reqAnon = { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' };
    const hitGlobal = await sendHttp({ port: p3.port, headers: reqB, body });
    assert.equal(hitGlobal.status, 429);
    assert.equal(JSON.parse(hitGlobal.text).error.limit_type, 'global');
    const hitAnon = await sendHttp({ port: p3.port, headers: reqAnon, body });
    assert.equal(hitAnon.status, 429);
    assert.equal(upstream.seen.length, 3, 'global cap hit never reached upstream');
  } finally {
    await p3.stop();
  }

  // Next UTC day resets cleanly, SSE/JSON tokens count toward token budget, and malformed upstream never resets counters.
  const procStateFile = join(procStateDir, 'daily-cap.json');
  let p4 = await spawnProxyProcess({
    ...procBaseEnv,
    TESS_CAP_TODAY: '2026-11-19',
    TESS_DAILY_REPLY_CAP: '20',
    TESS_DAILY_USER_CAP: '20',
    TESS_DAILY_TOKEN_CAP: '1000',
  });
  try {
    const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'help' }] });
    const reqA = { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json', 'x-opencode-session': 'agent:main:telegram:dm:111111111' };

    // 1. JSON response adds 500 tokens.
    upstream.setMode('json');
    assert.equal((await sendHttp({ port: p4.port, headers: reqA, body })).status, 200);
    await sleep(30);
    let snap = JSON.parse(readFileSync(procStateFile, 'utf8'));
    assert.equal(snap.replies, 1);
    assert.equal(snap.tokens, 500);
    assert.equal(snap.users['111111111'], 1);

    // 2. Malformed upstream responses (bad JSON, bad SSE, HTML 502, invalid usage, abrupt drop) do NOT reset counters.
    for (const badMode of ['malformed-json', 'malformed-sse', 'html-502', 'bad-usage', 'drop']) {
      upstream.setMode(badMode);
      try {
        await sendHttp({ port: p4.port, headers: reqA, body });
      } catch {
        // drop mode may reset the client socket cleanly or prematurely.
      }
      await sleep(30);
      const afterBad = JSON.parse(readFileSync(procStateFile, 'utf8'));
      assert.equal(afterBad.date, '2026-11-19', `${badMode} keeps date`);
      assert.ok(afterBad.replies > snap.replies, `${badMode} never resets replies`);
      assert.equal(afterBad.tokens, 500, `${badMode} never corrupts or resets tokens`);
      assert.ok(afterBad.users['111111111'] > snap.users['111111111'], `${badMode} keeps user count`);
      snap = afterBad;
    }

    // 3. SSE stream adds 600 tokens -> total 1100 >= 1000 token budget -> next call blocked with 429.
    upstream.setMode('sse');
    const sseRes = await sendHttp({ port: p4.port, headers: reqA, body });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.text, /\[DONE\]/);
    await sleep(40);
    const hitTok = await sendHttp({ port: p4.port, headers: reqA, body });
    assert.equal(hitTok.status, 429);
    assert.equal(JSON.parse(hitTok.text).error.limit_type, 'token');
  } finally {
    await p4.stop();
  }

  // 4. Bot-user isolation simulation + symlink/corrupt state fail closed without overwriting target.
  const lockedStateDir = join(box, 'cap-owned-state');
  mkdirSync(lockedStateDir, { recursive: true, mode: 0o700 });
  const lockedStateFile = join(lockedStateDir, 'daily-cap.json');
  writeFileSync(lockedStateFile, JSON.stringify({ date: '2026-11-19', replies: 5, tokens: 0, users: {} }) + '\n', { mode: 0o600 });

  // Simulate what `tess-support` sees when `tess-cap/.env` (0600) and `/var/lib/tess-cap` (0700) are owned by `tess-cap`:
  // when running as an unprivileged UID, 0o000 simulates foreign-user access denial on both read and write.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    chmodSync(lockedStateFile, 0o000);
    chmodSync(lockedStateDir, 0o000);
    chmodSync(capEnvFile, 0o000);
    try {
      assert.throws(() => readFileSync(lockedStateFile, 'utf8'), /EACCES|EPERM/, 'bot user cannot read counter');
      assert.throws(() => writeFileSync(lockedStateFile, '{"date":"x"}'), /EACCES|EPERM/, 'bot user cannot reset counter');
      assert.throws(() => readFileSync(capEnvFile, 'utf8'), /EACCES|EPERM/, 'bot user cannot read OPENCODE_GO_API_KEY');
      assert.throws(() => writeFileSync(capEnvFile, 'hacked'), /EACCES|EPERM/, 'bot user cannot overwrite cap env');
    } finally {
      chmodSync(lockedStateDir, 0o700);
      chmodSync(lockedStateFile, 0o600);
      chmodSync(capEnvFile, 0o600);
    }
  }
  assert.equal(JSON.parse(readFileSync(lockedStateFile, 'utf8')).replies, 5, 'counter remained intact');

  // Symlinked state file or corrupt JSON fails closed (503) and leaves sentinel target untouched.
  const sentinel = join(box, 'sentinel.txt');
  writeFileSync(sentinel, 'do-not-overwrite');
  const failDir = join(box, 'fail-closed');
  mkdirSync(failDir, { recursive: true, mode: 0o700 });
  const symState = join(failDir, 'daily-cap.json');
  symlinkSync(sentinel, symState);

  upstream.setMode('json');
  const pFailSym = await createCapProxy({
    apiKey: realKey,
    token: proxyToken,
    upstream: upstream.url,
    allowAnyUpstream: true,
    listenHost: '127.0.0.1',
    listenPort: 0,
    statePath: symState,
    todayOverride: '2026-11-19',
  });
  try {
    const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] });
    const r = await sendHttp({ port: pFailSym.port, headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' }, body });
    assert.equal(r.status, 503);
    assert.equal(readFileSync(sentinel, 'utf8'), 'do-not-overwrite');
  } finally {
    await pFailSym.close();
  }

  const badState = join(failDir, 'corrupt.json');
  writeFileSync(badState, '{corrupt json');
  const pFailBad = await createCapProxy({
    apiKey: realKey,
    token: proxyToken,
    upstream: upstream.url,
    allowAnyUpstream: true,
    listenHost: '127.0.0.1',
    listenPort: 0,
    statePath: badState,
    todayOverride: '2026-11-19',
  });
  try {
    const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] });
    const r = await sendHttp({ port: pFailBad.port, headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' }, body });
    assert.equal(r.status, 503);
    assert.equal(readFileSync(badState, 'utf8'), '{corrupt json', 'corrupt state is never overwritten or reset');
  } finally {
    await pFailBad.close();
  }

  // 5. Optional Unix socket mode works with strict route allowlist.
  const sockPath = join(box, 'cap.sock');
  const sockState = join(box, 'sock-state.json');
  const pSock = await createCapProxy({
    apiKey: realKey,
    token: proxyToken,
    upstream: upstream.url,
    allowAnyUpstream: true,
    socketPath: sockPath,
    socketMode: 0o660,
    statePath: sockState,
    todayOverride: '2026-11-19',
  });
  try {
    assert.equal(statSync(sockPath).mode & 0o777, 0o660);
    const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] });
    const okSock = await sendHttp({ socketPath: sockPath, headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' }, body });
    assert.equal(okSock.status, 200);
    const badSock = await sendHttp({ socketPath: sockPath, method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${proxyToken}` } });
    assert.equal(badSock.status, 403);
  } finally {
    await pSock.close();
    await upstream.close();
  }

  console.log('cap-proxy: all checks passed');
} finally {
  rmSync(box, { recursive: true, force: true });
}
