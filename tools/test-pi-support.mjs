#!/usr/bin/env node
// End-to-end tests for Tess Support on Pi's official standalone binary:
// 1. support/pi/install.sh sandbox (happy path, bad Pi SHA, bad release sig, bad kit SHA, progress JSON, --uninstall).
// 2. Real Pi standalone binary + support/pi/tess-visit.ts (when PI_TEST_BIN is set or /tmp/pi-probe/pi/pi exists):
//    stripped 13-tool surface (no bash/read/write/edit), consent gate (refused before yes, granted on yes, one-shot),
//    privacy scrubbing, inbox POST + still PUT with Bearer token, and session cleanup on tess_handoff.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { createServer } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SH = join(ROOT, 'support/pi/install.sh');

const themeSrc = join(ROOT, 'theme/Tess/src');
const core = readFileSync(join(themeSrc, 'core.js'), 'utf8');
for (const file of ['core.js', 'home.js', 'playlist.js']) {
  assert.doesNotMatch(readFileSync(join(themeSrc, file), 'utf8'), /\bsvg\.outerHTML\s*=/, `${file} must preserve Spotify's SVG nodes`);
}

const artistMatch = core.match(/async function onRoute\(\) \{[\s\S]*?const isArtist = ([^\n]+);/)[1];
const isArtistOverview = runInNewContext(`(path) => ${artistMatch}`);
for (const path of ['/artist/abc', '/artist/abc/']) assert.equal(isArtistOverview(path), true, path);
for (const path of ['/artist/', '/artist/abc/discography/all', '/artist/abc/related', '/artist/abc/featuring', '/artist/abc/appears-on', '/artist/abc/concerts', '/album/abc']) {
  assert.equal(isArtistOverview(path), false, path);
}

const stateSource = core.slice(core.indexOf('  const supHandledCmds ='), core.indexOf('  function consumeSupportEvents'));
const window = { __tessVersion: '0.2.56', innerWidth: 1280, innerHeight: 800 };
const posts = [];
let cache = JSON.stringify({ version: '0.2.55', js: 'x'.repeat(410_000) });
let currentRoute = '/artist/abc';
const { collectSpotifyState, runSupportSpotifyCmd } = runInNewContext(`${stateSource}\n({ collectSpotifyState, runSupportSpotifyCmd })`, {
  window, TextEncoder, setTimeout: (fn) => fn(),
  localStorage: { getItem: () => cache },
  route: () => currentRoute,
  document: {
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: { classList: { contains: () => false } },
  },
  Spicetify: { Platform: { History: { push: (path) => { currentRoute = path; } } } },
  supChatEl: null, closeNP: () => {}, onRoute: () => {},
  supportAPI: async (path, init) => {
    assert.equal(path, '/support/chat/cmd-result');
    assert.equal(init.method, 'POST');
    assert.ok(Buffer.byteLength(init.body) < 4096);
    posts.push(JSON.parse(init.body));
  },
});
assert.equal(collectSpotifyState().tessVersion, '0.2.56');
delete window.__tessVersion;
assert.equal(collectSpotifyState().tessVersion, '0.2.55');
await runSupportSpotifyCmd({ id: 'cmd_1', action: 'state' });
assert.equal(posts[0].result.tessVersion, '0.2.55');
await runSupportSpotifyCmd({ id: 'cmd_2', action: 'navigate', target: 'artist-discography' });
assert.equal(posts[1].result.state.route, '/artist/abc/discography/all');
cache = JSON.stringify({ version: 'v'.repeat(100) });
assert.equal(collectSpotifyState().tessVersion, 'v'.repeat(32));
for (cache of ['not JSON', '{"version":42}', null]) assert.equal(collectSpotifyState().tessVersion, 'dev');
currentRoute = '/' + '🎵'.repeat(4096);
await runSupportSpotifyCmd({ id: 'cmd_3', action: 'state' });
assert.equal(posts[2].result.ok, false);
console.log('PASS theme preserves stock SVGs, limits artist hero to the overview, and posts compact Support results');

const chatSource = core.slice(core.indexOf('  const supHandledCmds ='), core.indexOf('  function closeSupportChat'));
const bubbles = [];
const { consumeSupportEvents, sendSupportMessage } = runInNewContext(
  `${chatSource}\n({ consumeSupportEvents, sendSupportMessage })`,
  {
    supChatEl: {}, supChatSeq: 0, supStreamText: '', supActiveStreamEl: null,
    supChatPoll: null, supLastError: null, supChatSynced: true, supChatResetting: false, supChatResetGen: 0,
    finishToolPill: () => {}, setChatBusy: () => {},
    appendChatBubble: (role, text) => bubbles.push([role, text]),
    supportAPI: async () => ({}), setInterval: () => 1, clearInterval: () => {},
  },
);
function receiveSupportEvents(...events) {
  consumeSupportEvents({ events, busy: false });
  return bubbles.splice(0);
}
const nestedQuotaError = { type: 'error', text: '429: {"error":{"message":"  Daily limit reached.  "}}' };
const quotaError = { type: 'error', text: '429: {"message":"Daily limit reached."}' };
const quotaBubble = ['error', 'Daily limit reached.'];
assert.deepEqual(receiveSupportEvents(nestedQuotaError, quotaError), [quotaBubble]);
assert.deepEqual(receiveSupportEvents(quotaError), [], 'duplicate in the next poll of the same turn');
assert.deepEqual(receiveSupportEvents({ type: 'settled' }, quotaError), [quotaBubble]);
await sendSupportMessage('Try again');
assert.deepEqual(bubbles.splice(0), [['user', 'Try again']]);
assert.deepEqual(receiveSupportEvents(quotaError), [quotaBubble]);

const fallback = 'Something went wrong. Please try again.';
for (const [text, expected] of [
  ['429: {"error":{"message":" "},"message":" Try again at midnight. "}', 'Try again at midnight.'],
  ['429: {"error":{"message":123},"message":{}}', fallback],
  ['429: {"error":}', fallback],
  ['429: {"message":"truncated', fallback],
  ['429: {}', fallback],
  ['429: {"message":"{\\"code\\":429}"}', fallback],
  ['429: ["details"]', fallback],
  ['  Connection lost.  ', 'Connection lost.'],
  [`429: {"message":"${'x'.repeat(250)}"}`, 'x'.repeat(240)],
  ['y'.repeat(250), 'y'.repeat(240)],
]) {
  assert.deepEqual(receiveSupportEvents({ type: 'settled' }, { type: 'error', text }), [['error', expected]]);
}
assert.deepEqual(receiveSupportEvents(quotaError, { type: 'message', text: 'Checking again.' }, quotaError), [
  quotaBubble, ['assistant', 'Checking again.'], quotaBubble,
]);
const completedTurn = [{ ...quotaError, seq: 1 }, { type: 'settled', seq: 2 }];
receiveSupportEvents({ type: 'settled' });
assert.deepEqual(receiveSupportEvents(...completedTurn), [quotaBubble]);
assert.deepEqual(receiveSupportEvents(...completedTurn), [], 'an overlapping poll cannot replay a finished turn');

// Finding 3 (PR #167 review): if reset begins while sendSupportMessage awaits sync, clear busy so the composer never sticks on Stop.
{
  const busyStates = [];
  const ctx = {
    supChatEl: { classList: { contains: () => true } },
    supChatPoll: null, supLastError: null, supChatSynced: false, supChatResetting: false, supChatResetGen: 0,
    supChatSeq: 0, supActiveStreamEl: null, supStreamText: "",
    supChatSync: null,
    appendChatBubble: () => {},
    setChatBusy: (v) => busyStates.push(v),
    openSupportChat: () => {},
    startSupportChatPoll: () => {},
    supportAPI: async () => { ctx.supChatResetting = true; return { busy: false, seq: 1, events: [] }; },
    q: () => null, clearInterval: () => {},
    finishToolPill: () => {}, showToolPill: () => {}, runSupportSpotifyCmd: () => {},
  };
  const { sendSupportMessage: sendDuringReset } = runInNewContext(`${chatSource}\n({ sendSupportMessage })`, ctx);
  await sendDuringReset("Hello");
  assert.deepEqual(busyStates, [true, false], "send overlapping a reset clears busy");
}
{
  const bubbles2 = [];
  const busy2 = [];
  let polled = 0;
  const ctx2 = {
    supChatEl: { classList: { contains: () => true } },
    supChatPoll: null, supLastError: null, supChatSynced: true, supChatResetting: false, supChatResetGen: 0,
    supChatSeq: 0, supActiveStreamEl: null, supStreamText: "", supChatSync: null,
    appendChatBubble: (role, text) => bubbles2.push([role, text]),
    setChatBusy: (v) => busy2.push(v),
    openSupportChat: () => {},
    startSupportChatPoll: () => { polled += 1; },
    supportAPI: async () => { ctx2.supChatResetGen += 1; return null; },
    q: () => null, clearInterval: () => {},
    finishToolPill: () => {}, showToolPill: () => {}, runSupportSpotifyCmd: () => {},
  };
  const { sendSupportMessage: sendAcrossReset } = runInNewContext(`${chatSource}\n({ sendSupportMessage })`, ctx2);
  await sendAcrossReset("Hello");
  assert.deepEqual(bubbles2, [["user", "Hello"]], "completed reset drops stale send error");
  assert.deepEqual(busy2, [true], "completed reset does not clobber newer busy state");
  assert.equal(polled, 0, "completed reset does not start a rogue poll");
}
console.log('PASS theme shows one plain-English error per consecutive retry and clears it for the next turn');

const miniSource = core.slice(core.indexOf('  let miniKey ='), core.indexOf('  function miniURL'));
const supportSource = core.slice(core.indexOf('  let supState ='), core.indexOf('  async function supportFetchStatus'));
const popupSource = core.slice(core.indexOf('  function closeSupportChat'), core.indexOf('  async function openSupportUI'));
const popup = { classList: { add() {} }, querySelectorAll: () => [] };
const newChat = {};
let miniToken = 'mini-1';
let miniSeq = 70;
let miniEvents = [{ ...quotaError, seq: 70 }];
let poll;
const requested = [];
const { openSupportChat, sendSupportMessage: send, synced, cursor } = runInNewContext(
  `let nativeMini = false; const MINI = 'http://localhost'; ${miniSource}\n${supportSource}\n${chatSource}\n${popupSource}
  ({ openSupportChat, sendSupportMessage, synced: () => supChatSync, cursor: () => supChatSeq })`,
  {
    LIFEBUOY_SVG: '', el: () => popup, document: { body: { appendChild() {} } },
    q: (_, selector) => selector === '.tsup-new' ? newChat : {
      addEventListener() {}, querySelectorAll: () => [], classList: { remove() {} },
    },
    finishToolPill: () => {}, setChatBusy: () => {},
    appendChatBubble: (role, text) => bubbles.push([role, text]),
    setTimeout: (fn, ms) => { if (ms === 350) fn(); },
    setInterval: (fn) => { poll = fn; return fn; },
    clearInterval: () => {},
    fetch: async (raw) => {
      const url = new URL(raw);
      const ok = (body) => ({ ok: true, json: async () => body });
      if (url.pathname === '/token') return ok({ k: miniToken });
      if (url.searchParams.get('k') !== miniToken) return { ok: false, status: 404 };
      if (url.pathname === '/support/chat/send') {
        miniEvents.push({ type: 'message', text: 'New reply.', seq: ++miniSeq });
        return ok({ ok: true });
      }
      if (url.pathname === '/support/chat/reset') {
        miniEvents = [{ type: 'reset', seq: ++miniSeq }];
        return ok({ ok: true });
      }
      const after = Number(url.searchParams.get('after'));
      requested.push(after);
      return ok({ seq: miniSeq, busy: false, events: miniEvents.filter((ev) => ev.seq > after) });
    },
  },
);
bubbles.length = 0;
openSupportChat();
await synced();
assert.equal(cursor(), 70, 'opening the chat skips settled history');
assert.deepEqual(bubbles, []);
await send('Hello');
await poll();
assert.deepEqual(bubbles.splice(0), [['user', 'Hello'], ['assistant', 'New reply.']]);

miniToken = 'mini-2';
miniEvents = [];
miniSeq = 4;
await send('After restart');
await poll();
assert.equal(requested.at(-1), 0, 'a new Mini token starts reading its stream at zero');
assert.deepEqual(bubbles.splice(0), [['user', 'After restart'], ['assistant', 'New reply.']]);

await send('After sequence reset');
miniSeq = 1;
miniEvents = [{ type: 'message', text: 'Recovered reply.', seq: 1 }];
requested.length = 0;
await poll();
assert.deepEqual(requested, [5, 0], 'a lower sequence triggers an immediate re-poll');
assert.deepEqual(bubbles.splice(0), [['user', 'After sequence reset'], ['assistant', 'Recovered reply.']]);

await newChat.onclick();
assert.equal(cursor(), 2, 'reset starts from the new sequence');
assert.deepEqual(bubbles, []);
console.log('PASS fresh chat skips settled history and polling recovers on either Mini restart signal');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// --- Part 1: support/pi/install.sh sandbox tests ---
const box = mkdtempSync(join(tmpdir(), 'tess-pi-test-'));
let srv;
try {
  // Build a fake pi.tar.gz and real support-kit.tar.gz
  const fakePiStage = join(box, 'fake-pi-src/pi');
  mkdirSync(fakePiStage, { recursive: true });
  writeFileSync(join(fakePiStage, 'pi'), '#!/bin/sh\necho 1.6.0\n', { mode: 0o755 });
  writeFileSync(join(fakePiStage, 'package.json'), '{"name":"pi","version":"1.6.0"}\n');
  writeFileSync(join(fakePiStage, 'photon_rs_bg.wasm'), 'wasm');
  const fakePiTar = join(box, 'pi-darwin-arm64.tar.gz');
  execFileSync('tar', ['-C', join(box, 'fake-pi-src'), '-czf', fakePiTar, 'pi']);
  const fakePiSha = sha256(readFileSync(fakePiTar));

  const kitStage = join(box, 'kit-src');
  mkdirSync(join(kitStage, 'extensions'), { recursive: true });
  mkdirSync(join(kitStage, 'scripts'), { recursive: true });
  for (const sk of ['tess-support', 'tess-gather', 'tess-evidence', 'tess-handoff']) {
    mkdirSync(join(kitStage, 'skills', sk), { recursive: true });
    cpSync(join(ROOT, `support/mac/skills/${sk}/SKILL.md`), join(kitStage, `skills/${sk}/SKILL.md`));
  }
  cpSync(join(ROOT, 'support/pi/SOUL.md'), join(kitStage, 'SOUL.md'));
  cpSync(join(ROOT, 'support/pi/tess-visit.ts'), join(kitStage, 'extensions/tess-visit.ts'));
  cpSync(join(ROOT, 'support/bot/skills/tess-support/scripts/privacy.mjs'), join(kitStage, 'scripts/privacy.mjs'));
  cpSync(join(ROOT, 'support/bot/skills/tess-support/scripts/triage.mjs'), join(kitStage, 'scripts/triage.mjs'));
  const kitTar = join(box, 'tess-support-kit.tar.gz');
  execFileSync('tar', ['-C', kitStage, '-czf', kitTar, '.']);
  const kitSha = sha256(readFileSync(kitTar));

  let serveKitSha = kitSha;
  const files = {
    '/pi.tar.gz': readFileSync(fakePiTar),
    '/tess-support-kit.tar.gz': readFileSync(kitTar),
  };

  srv = createServer((req, res) => {
    if (req.url === '/dist/components.txt') {
      const addr = srv.address();
      const body = `support-kit ${serveKitSha} http://127.0.0.1:${addr.port}/tess-support-kit.tar.gz src1\nversion 0.2.52\n`;
      res.writeHead(200);
      res.end(body);
      return;
    }
    if (req.url === '/dist/components.sig') {
      res.writeHead(200);
      res.end('valid-sig\n');
      return;
    }
    const buf = files[req.url];
    if (buf) {
      res.writeHead(200, { 'content-length': buf.length });
      res.end(buf);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const makeSandbox = (name, verifyExit = 0) => {
    const dir = join(box, name);
    mkdirSync(join(dir, 'tess/bin/patcher'), { recursive: true });
    mkdirSync(join(dir, 'tess/state'), { recursive: true });
    const verify = join(dir, 'tess/bin/patcher/tess-verify');
    writeFileSync(verify, `#!/bin/sh\nexit ${verifyExit}\n`, { mode: 0o755 });
    return {
      dir,
      tessHome: join(dir, 'tess'),
      verify,
      progress: join(dir, 'tess/state/.support-invite-status'),
    };
  };

  const runInstall = (sb, extraEnv = {}, args = []) =>
    execFileAsync('/bin/sh', [INSTALL_SH, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: sb.dir,
        TMPDIR: box,
        TESS_TEST: '1',
        TESS_ARCH: 'arm64',
        TESS_HOME: sb.tessHome,
        TESS_INBOX: `http://127.0.0.1:${port}`,
        TESS_COMPONENTS_BASE: `http://127.0.0.1:${port}/dist`,
        TESS_PI_URL: `http://127.0.0.1:${port}/pi.tar.gz`,
        TESS_PI_SHA: fakePiSha,
        TESS_SUPPORT_TOKEN: 'tess_0123456789abcdef0123456789abcdef',
        TESS_SUPPORT_PROGRESS_FILE: sb.progress,
        ...extraEnv,
      },
    });

  // 1a. Happy path
  const okSb = makeSandbox('ok');
  await runInstall(okSb);
  const cur = join(okSb.tessHome, 'support/current');
  assert.ok(existsSync(join(cur, 'bin/pi')), 'pi binary installed');
  assert.ok(existsSync(join(cur, 'SOUL.md')), 'SOUL.md installed');
  assert.ok(existsSync(join(cur, 'extensions/tess-visit.ts')), 'tess-visit.ts installed');
  assert.ok(existsSync(join(cur, 'skills/tess-support/SKILL.md')), 'skills auto-installed');
  assert.ok(existsSync(join(cur, 'scripts/privacy.mjs')), 'privacy.mjs installed');
  assert.ok(existsSync(join(cur, 'agent/models.json')), 'models.json written');
  const tokPath = join(okSb.tessHome, 'support/token');
  assert.equal(readFileSync(tokPath, 'utf8').trim(), 'tess_0123456789abcdef0123456789abcdef');
  assert.equal(statSync(tokPath).mode & 0o777, 0o600, 'token file is 0600');
  const prog = JSON.parse(readFileSync(okSb.progress, 'utf8'));
  assert.equal(prog.phase, 'done');
  assert.equal(prog.progress, 1);

  // 1b. Uninstall cleans up cleanly
  await runInstall(okSb, {}, ['--uninstall']);
  assert.ok(!existsSync(join(okSb.tessHome, 'support')), '--uninstall removes support folder');

  // 1c. Bad Pi SHA refused
  const badPi = makeSandbox('bad-pi');
  await assert.rejects(() => runInstall(badPi, { TESS_PI_SHA: '0'.repeat(64) }), /checksum mismatch/);
  assert.ok(!existsSync(join(badPi.tessHome, 'support/current')), 'bad Pi SHA installs nothing');

  // 1d. Bad release signature refused
  const badSig = makeSandbox('bad-sig', 1);
  await assert.rejects(() => runInstall(badSig), /signature check failed/);
  assert.ok(!existsSync(join(badSig.tessHome, 'support/current')), 'bad sig installs nothing');

  // 1e. Bad support-kit SHA refused
  const badKit = makeSandbox('bad-kit');
  serveKitSha = 'f'.repeat(64);
  await assert.rejects(() => runInstall(badKit), /support-kit checksum mismatch/);
  assert.ok(!existsSync(join(badKit.tessHome, 'support/current')), 'bad kit SHA installs nothing');
  serveKitSha = kitSha;

  srv.closeAllConnections?.();
  srv.close();
  srv = null;

  // --- Part 2: Live stripped Pi binary + tess-visit.ts end-to-end test ---
  const piBin = process.env.PI_TEST_BIN || '/tmp/pi-probe/pi/pi';
  if (existsSync(piBin)) {
    const liveDir = join(box, 'live-support');
    mkdirSync(join(liveDir, 'agent'), { recursive: true });
    mkdirSync(join(liveDir, 'cache/sessions'), { recursive: true });
    cpSync(kitStage, liveDir, { recursive: true });

    let sawTools = [];
    let sawBearer = '';
    let postedReport = null;
    let postedStill = null;
    let llmCall = 0;

    const QUESTION_STILL =
      'May I take one still of the Spotify window? It can show your Spotify name, ' +
      'your picture, your friends\' activity, and your playlist names.';

    const fakeWorker = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (req.method === 'POST' && req.url === '/v1/support') {
          postedReport = { auth: req.headers.authorization, body: JSON.parse(raw.toString('utf8')) };
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 42 }));
          return;
        }
        if (req.method === 'PATCH' && req.url === '/v1/support/42') {
          postedReport.amended = JSON.parse(raw.toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id: 42 }));
          return;
        }
        if (req.method === 'PUT' && req.url === '/v1/support/recording/42') {
          postedStill = { auth: req.headers.authorization, type: req.headers['content-type'], bytes: raw.length };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'POST' && req.url === '/v1/support/chat/completions') {
          const json = JSON.parse(raw.toString('utf8'));
          sawBearer = req.headers.authorization || '';
          sawTools = (json.tools || []).map((t) => t.function?.name).sort();
          llmCall++;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const sendChunk = (delta, finish) => {
            const c = { id: `c${llmCall}`, object: 'chat.completion.chunk', created: llmCall, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] };
            res.write(`data: ${JSON.stringify(c)}\n\n`);
          };
          if (llmCall === 1) {
            // Start visit, read skill, attempt still BEFORE consent (must fail!), and ask consent
            sendChunk({ role: 'assistant', tool_calls: [
              { index: 0, id: 't1', type: 'function', function: { name: 'tess_visit_start', arguments: '{}' } },
              { index: 1, id: 't2', type: 'function', function: { name: 'tess_read_skill', arguments: '{"name":"tess-support"}' } },
              { index: 2, id: 't3', type: 'function', function: { name: 'tess_still', arguments: '{}' } },
              { index: 3, id: 't4', type: 'function', function: { name: 'tess_ask_consent', arguments: '{}' } },
            ] }, 'tool_calls');
          } else if (llmCall === 2) {
            // End turn cleanly on the exact consent question
            sendChunk({ role: 'assistant', content: QUESTION_STILL }, 'stop');
          } else if (llmCall === 3) {
            // After user says "yes": capture still (succeeds) and save notes
            sendChunk({ role: 'assistant', tool_calls: [
              { index: 0, id: 't5', type: 'function', function: { name: 'tess_still', arguments: '{}' } },
              { index: 1, id: 't7', type: 'function', function: { name: 'tess_save_note', arguments: JSON.stringify({ kind: 'words', text: 'Lyrics broken for bob@example.com at /Users/bob/Music' }) } },
              { index: 2, id: 't8', type: 'function', function: { name: 'tess_save_note', arguments: JSON.stringify({ kind: 'doctor', text: '  ✓ Tess is in Spotify 1.3.10\n  ✓ ok' }) } },
              { index: 3, id: 't9', type: 'function', function: { name: 'tess_save_note', arguments: JSON.stringify({ kind: 'title', text: 'Lyrics missing on track' }) } },
              { index: 4, id: 't10', type: 'function', function: { name: 'tess_save_note', arguments: JSON.stringify({ kind: 'summary', text: 'Lyrics panel stayed blank.' }) } },
            ] }, 'tool_calls');
          } else if (llmCall === 4) {
            // Try second still (must be refused!) and run triage
            sendChunk({ role: 'assistant', tool_calls: [
              { index: 0, id: 't6', type: 'function', function: { name: 'tess_still', arguments: '{}' } },
              { index: 1, id: 't11', type: 'function', function: { name: 'tess_triage', arguments: JSON.stringify({ also: 'theme' }) } },
            ] }, 'tool_calls');
          } else if (llmCall === 5) {
            sendChunk({ role: 'assistant', tool_calls: [
              { index: 0, id: 't12', type: 'function', function: { name: 'tess_post', arguments: '{}' } },
            ] }, 'tool_calls');
          } else if (llmCall === 6) {
            sendChunk({ role: 'assistant', tool_calls: [
              { index: 0, id: 't14', type: 'function', function: { name: 'tess_amend_report', arguments: JSON.stringify({ append_note: 'Also happens in full screen.' }) } },
            ] }, 'tool_calls');
          } else if (llmCall === 7) {
            sendChunk({ role: 'assistant', tool_calls: [
              { index: 0, id: 't13', type: 'function', function: { name: 'tess_handoff', arguments: '{}' } },
            ] }, 'tool_calls');
          } else {
            sendChunk({ role: 'assistant', content: 'I\'ve written this down for the person who builds Tess.' }, 'stop');
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise((r) => fakeWorker.listen(0, '127.0.0.1', r));
    const wPort = fakeWorker.address().port;

    writeFileSync(join(liveDir, 'agent/models.json'), JSON.stringify({
      providers: {
        'tess-gate': {
          baseUrl: `http://127.0.0.1:${wPort}/v1/support`,
          api: 'openai-completions',
          apiKey: '$TESS_SUPPORT_TOKEN',
          models: [{ id: 'deepseek-v4.1-flash', name: 'Tess Support', input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }, null, 2));

    const pi = spawn(piBin, [
      '--mode', 'rpc',
      '--no-session',
      '--tools', '+grep,+find,+ls,-write,-edit',
      '--no-extensions',
      '--extension', join(liveDir, 'extensions/tess-visit.ts'),
      '--no-mcp',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-approve',
      '--provider', 'tess-gate',
      '--model', 'deepseek-v4.1-flash',
      '--system-prompt', join(liveDir, 'SOUL.md'),
    ], {
      env: {
        PATH: process.env.PATH,
        HOME: join(box, 'live-home'),
        TMPDIR: box,
        PI_CODING_AGENT_DIR: join(liveDir, 'agent'),
        PI_OFFLINE: '1',
        PI_TELEMETRY: '0',
        TESS_TEST: '1',
        TESS_FAKE_CAPTURE: '1',
        TESS_SUPPORT_DIR: liveDir,
        TESS_SESSION_ROOT: join(liveDir, 'cache/sessions'),
        TESS_INBOX: `http://127.0.0.1:${wPort}`,
        TESS_SUPPORT_TOKEN: 'tess_live_tok_abcdef0123456789',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    mkdirSync(join(box, 'live-home'), { recursive: true });

    const toolResults = new Map();
    let settledCount = 0;
    let buf = '';
    const done = new Promise((resolveDone, rejectDone) => {
      const timer = setTimeout(() => rejectDone(new Error('Pi RPC test timed out')), 20000);
      pi.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'tool_execution_end') {
            toolResults.set(ev.toolCallId, ev.result?.content?.[0]?.text || '');
          }
          if (ev.type === 'agent_settled') {
            settledCount++;
            if (settledCount === 1) {
              pi.stdin.write(JSON.stringify({ id: 'p2', type: 'prompt', message: 'sure' }) + '\n');
            } else if (settledCount === 2) {
              clearTimeout(timer);
              resolveDone();
            }
          }
        }
      });
    });

    pi.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message: 'Lyrics are blank' }) + '\n');
    await done;
    pi.kill();
    fakeWorker.closeAllConnections?.();
    fakeWorker.close();

    assert.equal(sawBearer, 'Bearer tess_live_tok_abcdef0123456789');
    assert.deepEqual(sawTools, [
      'bash',
      'find',
      'grep',
      'ls',
      'read',
      'tess_amend_report',
      'tess_ask_consent',
      'tess_ask_consent_video',
      'tess_doctor',
      'tess_guard_log',
      'tess_handoff',
      'tess_open_issues',
      'tess_post',
      'tess_read_skill',
      'tess_record',
      'tess_save_note',
      'tess_spotify_navigate',
      'tess_spotify_state',
      'tess_still',
      'tess_triage',
      'tess_visit_start',
    ], 'standard read-only investigation tools + 16 Tess visit tools are exposed — zero write/edit');

    assert.match(toolResults.get('t3'), /"ok":false.*"ask first/i, 'tess_still refused before consent');
    assert.match(toolResults.get('t5'), /"ok":true.*"spotify\.png"/, 'tess_still succeeds after user yes');
    assert.match(toolResults.get('t6'), /"ok":false.*already spent/i, 'second tess_still refused (one-shot)');
    assert.ok(postedReport, 'report posted to inbox');
    assert.equal(postedReport.auth, 'Bearer tess_live_tok_abcdef0123456789');
    assert.ok(!JSON.stringify(postedReport.body).includes('bob@example.com'), 'email scrubbed before post');
    assert.ok(!JSON.stringify(postedReport.body).includes('/Users/bob'), 'home path scrubbed before post');
    assert.ok(postedReport.amended && postedReport.amended.append_note === 'Also happens in full screen.', 'report amended via PATCH');
    assert.ok(postedStill && postedStill.bytes > 0 && postedStill.type === 'image/png', 'still uploaded to inbox');
    assert.match(toolResults.get('t13'), /"cleaned":true/, 'handoff deleted session folder');
    console.log('pi support live RPC + extension + consent + scrub + post tests passed');
  } else {
    console.log('pi support installer sandbox tests passed (skipped live Pi binary check: binary not present)');
  }
} finally {
  try { srv?.close(); } catch {}
  rmSync(box, { recursive: true, force: true });
}
