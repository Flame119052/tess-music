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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SH = join(ROOT, 'support/pi/install.sh');

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
    mkdirSync(join(dir, 'tess/bin'), { recursive: true });
    mkdirSync(join(dir, 'tess/state'), { recursive: true });
    const verify = join(dir, 'tess/bin/tess-verify');
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
        TESS_VERIFY: sb.verify,
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
              pi.stdin.write(JSON.stringify({ id: 'p2', type: 'prompt', message: 'yes' }) + '\n');
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
      'tess_still',
      'tess_triage',
      'tess_visit_start',
    ], 'standard read-only investigation tools + 14 Tess visit tools are exposed — zero write/edit');

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
