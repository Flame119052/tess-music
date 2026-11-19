// One real support chat turn from a sandboxed Mac profile, through a local copy of the support gate, to a fake model.
// Then the token is revoked and the next turn is refused before the model is called.
// Usage: node tools/test-support-mac-chat.mjs [--gate=wrangler|node]
//   wrangler (default): inbox/worker.js in `wrangler dev --local` (workerd, local D1 only). The token is minted, watched
//     and revoked with tools/reports.mjs on that local database (TESS_D1_LOCAL), the commands the runbook gives Krish.
//   node: the same Worker module behind node:http with a sqlite3 database and the same SQL. No npm download, so CI runs it.
// No Hermes binary is run (CI has none, and the one on Krish's Mac could not import its Python packages on 19 Nov).
// The turn is the request Hermes's chat_completions transport sends: POST <providers.tess-gate.base_url>/chat/completions,
// the bearer from key_env, stream with stream_options.include_usage, a system and a user message, and tools.
// Network: 127.0.0.1 only. The real home, the real Spotify and the live inbox are never touched.
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const inbox = join(root, 'inbox');
const reports = join(root, 'tools/reports.mjs');
const install = join(root, 'support/mac/install.mjs');
const chat = join(root, 'support/mac/chat.mjs');
const { d1Args, mintSql, revokeSql, usageSql } = await import(reports);

const gateArg = process.argv.find((a) => a.startsWith('--gate='));
const mode = gateArg ? gateArg.slice('--gate='.length) : 'wrangler';
if (!['wrangler', 'node'].includes(mode)) { console.error('usage: node tools/test-support-mac-chat.mjs [--gate=wrangler|node]'); process.exit(2); }

const KEY = `oc-go-test-${'k'.repeat(40)}`;
const UPSTREAM = 'https://opencode.ai/zen/go/v1/chat/completions';
const LABEL = 'Ada test Mac';
const REFUSED = 'This support code is not active. Ask Krish for a new one.';
const box = mkdtempSync(join(tmpdir(), 'tess-mac-chat-'));
const persist = join(box, 'd1');
const hermesHome = join(box, 'hermes');
const personHome = join(box, 'home');
mkdirSync(personHome);
// The person's shell has node and the system tools, and no hermes, so install.mjs copies the profile.
const personPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
const sha = (t) => createHash('sha256').update(t).digest('hex');
const vars = Object.fromEntries([...readFileSync(join(inbox, 'wrangler.toml'), 'utf8').split(/^\[vars\]$/m)[1].split(/^\[/m)[0]
  .matchAll(/^([A-Z_]+) = "([^"]*)"$/gm)].map((m) => [m[1], m[2]]));

const readBody = async (stream) => {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
};
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const until = async (label, fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
const run = (args, env, opts = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

// The fake OpenCode Go. A streamed reply sends one delta and holds the rest until the client says it has that delta,
// so a gate that buffered the whole reply would hang here instead of passing.
const up = { calls: [], releasedByClient: false, release: null };
const upstream = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/release') {
    up.releasedByClient = true;
    up.release?.();
    res.end('ok');
    return;
  }
  const body = (await readBody(req)).toString('utf8');
  if (req.method !== 'POST' || req.url !== '/zen/go/v1/chat/completions') { res.writeHead(404).end(); return; }
  up.calls.push({ headers: req.headers, body });
  const asked = JSON.parse(body);
  if (asked.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello from ' } }] })}\n\n`);
    await new Promise((resolve) => {
      const giveUp = setTimeout(resolve, 15000);
      up.release = () => { clearTimeout(giveUp); resolve(); };
    });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'the support gate.' }, finish_reason: 'stop' }] })}\n\n`);
    if (asked.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Hi, this is the gate.' } }], usage: { total_tokens: 11 } }));
});

// What Hermes sends, read from the installed profile rather than from constants here.
const client = join(box, 'hermes-turn.mjs');
writeFileSync(client, `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const prof = join(process.env.HERMES_HOME, 'profiles', 'tess-support');
const cfg = readFileSync(join(prof, 'config.yaml'), 'utf8');
const provider = cfg.split(/^providers:/m)[1].split(/^\\S/m)[0];
const base = provider.match(/base_url:\\s*(\\S+)/)[1];
const keyEnv = provider.match(/key_env:\\s*(\\S+)/)[1];
const model = cfg.split(/^model:/m)[1].match(/^\\s+default:\\s*(\\S+)/m)[1];
const dot = Object.fromEntries(readFileSync(join(prof, '.env'), 'utf8').split('\\n').filter((l) => l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const url = base.replace(/\\$\\{(\\w+)\\}/g, (_, n) => dot[n] || '').replace(/\\/$/, '') + '/chat/completions';
const res = await fetch(url, {
  method: 'POST',
  redirect: 'manual',
  headers: { authorization: 'Bearer ' + dot[keyEnv], 'content-type': 'application/json', accept: 'application/json',
    'user-agent': 'OpenAI/Python 2.8.0', 'x-stainless-lang': 'python' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'system', content: 'You are Tess Support.' }, { role: 'user', content: process.argv[2] }],
    tools: [{ type: 'function', function: { name: 'tess_save_note', description: 'Save a note for this visit',
      parameters: { type: 'object', properties: { kind: { type: 'string' }, text: { type: 'string' } }, required: ['kind', 'text'] } } }],
    stream: true,
    stream_options: { include_usage: true },
  }),
});
const out = { url, status: res.status };
if (!res.ok) {
  const text = await res.text();
  // Hermes builds its error text from error.message in the body (agent/api_error_summary.py), else the bare status.
  try { out.message = JSON.parse(text).error.message; } catch { out.message = 'HTTP ' + res.status; }
  out.raw = text;
  console.log(JSON.stringify(out));
  process.exit(3);
}
const reader = res.body.getReader();
const dec = new TextDecoder();
let raw = '';
let buf = '';
out.content = '';
out.released = false;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = dec.decode(value, { stream: true });
  raw += text;
  buf += text;
  const lines = buf.split('\\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const frame = JSON.parse(line.slice(6));
    if (frame.usage) out.usage = frame.usage;
    const piece = frame.choices?.[0]?.delta?.content;
    if (piece) out.content += piece;
    if (piece && !out.released) {
      out.released = true;
      await fetch(process.env.TEST_RELEASE_URL, { method: 'POST' });
    }
  }
}
out.raw = raw;
console.log(JSON.stringify(out));
`);

// --- the two gates
let gate = '';
let wranglerChild = null;
let wranglerLog = '';
let nodeGate = null;
let sqliteFile = '';
const realFetch = globalThis.fetch;
const createdWranglerDir = !existsSync(join(inbox, '.wrangler'));

const sql = {
  // The local database, through the same statements tools/reports.mjs runs.
  rows: (text) => {
    if (mode === 'node') {
      const out = execFileSync('sqlite3', ['-json', '-cmd', '.timeout 5000', sqliteFile, text], { encoding: 'utf8' }).trim();
      return out ? JSON.parse(out) : [];
    }
    const args = d1Args(text, { TESS_D1_LOCAL: persist });
    assert.ok(args.includes('--local') && args.includes(persist) && !args.includes('--remote'), 'a local query is local');
    return JSON.parse(execFileSync('npx', args, { cwd: inbox, env: wranglerEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
  },
};

function wranglerEnv() {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: join(box, 'xdg'), TESS_D1_LOCAL: persist };
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CLOUDFLARE_API_KEY']) delete env[k];
  return env;
}

const reportsCli = (...args) => {
  // The fence: the arguments reports.mjs builds from this environment are local before it is run at all.
  const env = wranglerEnv();
  const built = d1Args('SELECT 1', env);
  assert.ok(built.includes('--local') && built.includes('--persist-to') && built.includes(persist), 'reports.mjs is local');
  assert.equal(built.includes('--remote'), false, 'reports.mjs would have used the live database');
  return execFileSync(process.execPath, [reports, ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
};

async function startNodeGate(fakeUrl) {
  const worker = (await import(join(inbox, 'worker.js'))).default;
  sqliteFile = join(box, 'inbox.db');
  execFileSync('sh', ['-c', 'sqlite3 "$1" < "$2"', 'sh', sqliteFile, join(inbox, 'schema.sql')]);
  const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const subs = (text, args) => { let i = 0; return text.replace(/\?/g, () => lit(args[i++])); };
  const runSql = (text) => execFileSync('sqlite3', ['-cmd', '.timeout 5000', sqliteFile, `${text};\nSELECT changes(), last_insert_rowid();`], { encoding: 'utf8' }).trim();
  const result = (out) => { const [c, l] = out.split('\n').pop().split('|'); return { meta: { changes: Number(c) || 0, last_row_id: Number(l) || 0 } }; };
  const DB = {
    prepare: (text) => ({
      bind: (...args) => ({
        first: async () => sql.rows(subs(text, args))[0] ?? null,
        all: async () => ({ results: sql.rows(subs(text, args)) }),
        run: async () => result(runSql(subs(text, args))),
      }),
      first: async () => sql.rows(text)[0] ?? null,
      run: async () => result(runSql(text)),
    }),
  };
  const env = {
    ...vars,
    DB,
    OPENCODE_GO_API_KEY: KEY,
    LIMIT: { limit: async () => ({ success: true }) },
    CHAT_LIMIT: { limit: async () => ({ success: true }) },
    RESCUE: { get: async () => null },
  };
  globalThis.fetch = (url, init) => {
    if (String(url) !== UPSTREAM) throw new Error(`test gate: outbound fetch refused: ${url}`);
    return realFetch(fakeUrl, init);
  };
  nodeGate = createServer((req, res) => serve(req, res).catch((err) => {
    // A crash in the gate is a test failure with its reason, not a hung client.
    console.error(`node gate: ${err.stack || err}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }));
  const serve = async (req, res) => {
    const body = await readBody(req);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    headers.set('cf-connecting-ip', '127.0.0.1');
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const jobs = [];
    const response = await worker.fetch(request, env, { waitUntil: (p) => jobs.push(p) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
    await Promise.all(jobs);
  };
  return listen(nodeGate);
}

async function startWranglerGate(fakeUrl) {
  const gateDir = join(box, 'gate');
  mkdirSync(gateDir);
  const live = readFileSync(join(inbox, 'wrangler.toml'), 'utf8');
  // The real bindings and vars, under another name, with no route, so the database id (and the local file) is the same.
  const toml = live
    .replace(/^name = "tess-inbox"$/m, 'name = "tess-inbox-local-test"')
    .replace(/^main = "worker.js"$/m, 'main = "entry.js"')
    .replace(/^routes = .*$/m, '')
    .replace(/^workers_dev = .*$/m, '');
  assert.ok(toml.includes('main = "entry.js"') && !/^routes/m.test(toml), 'the scratch config has no live route');
  writeFileSync(join(gateDir, 'wrangler.toml'), toml);
  // The entry is the Worker itself. Only its one upstream URL is sent to the fake; any other outbound fetch throws.
  writeFileSync(join(gateDir, 'entry.js'), `import worker from ${JSON.stringify(join(inbox, 'worker.js'))};
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = url instanceof Request ? url.url : String(url);
  if (u !== ${JSON.stringify(UPSTREAM)}) throw new Error('test gate: outbound fetch refused: ' + u);
  return realFetch(${JSON.stringify(fakeUrl)}, init);
};
export default worker;
`);
  const schemaArgs = ['--no-install', 'wrangler', 'd1', 'execute', 'tess-inbox', '--local', '--persist-to', persist, '--file', join(inbox, 'schema.sql'), '--yes'];
  execFileSync('npx', schemaArgs, { cwd: inbox, env: wranglerEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await freePort();
  const inspector = await freePort();
  wranglerChild = spawn('npx', ['--no-install', 'wrangler', 'dev', '--local', '--config', join(gateDir, 'wrangler.toml'),
    '--persist-to', persist, '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector),
    '--var', `OPENCODE_GO_API_KEY:${KEY}`, '--show-interactive-dev-session=false', '--log-level', 'warn'],
  { cwd: gateDir, env: wranglerEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  wranglerChild.stdout.on('data', (c) => { wranglerLog += c; });
  wranglerChild.stderr.on('data', (c) => { wranglerLog += c; });
  try {
    await until('wrangler dev to answer', async () => {
      if (wranglerChild.exitCode !== null) throw new Error(`wrangler dev exited\n${wranglerLog}`);
      try { return (await realFetch(`http://127.0.0.1:${port}/v1/not-a-route`)).status === 404; } catch { return false; }
    }, 90000);
  } catch (err) {
    throw new Error(`${err.message}\n${wranglerLog.slice(-2000)}`);
  }
  return port;
}

const stopWrangler = async () => {
  if (!wranglerChild || wranglerChild.exitCode !== null) return;
  // workerd is a grandchild; the whole group goes, or it keeps the port.
  try { process.kill(-wranglerChild.pid, 'SIGTERM'); } catch { /* already gone */ }
  const gone = await Promise.race([new Promise((r) => wranglerChild.once('close', () => r(true))), new Promise((r) => setTimeout(() => r(false), 5000))]);
  if (!gone) try { process.kill(-wranglerChild.pid, 'SIGKILL'); } catch { /* already gone */ }
};
process.on('SIGINT', async () => { await stopWrangler(); rmSync(box, { recursive: true, force: true }); process.exit(130); });

const usage = async () => {
  const rows = sql.rows(usageSql());
  const person = rows.find((r) => r.who === LABEL) || {};
  const everyone = rows.find((r) => r.who === '(everyone)') || {};
  return { requests: person.requests ?? 0, tokens: person.tokens ?? 0, revoked: person.revoked ?? null,
    sharedRequests: everyone.requests ?? 0, sharedTokens: everyone.tokens ?? 0 };
};
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const shown = [];
try {
  const upPort = await listen(upstream);
  const fakeUrl = `http://127.0.0.1:${upPort}/zen/go/v1/chat/completions`;
  const gatePort = mode === 'wrangler' ? await startWranglerGate(fakeUrl) : await startNodeGate(fakeUrl);
  gate = `http://127.0.0.1:${gatePort}`;

  // 1. Mint a token for one person, the way Krish does.
  let token;
  if (mode === 'wrangler') {
    const minted = reportsCli('support', 'token', 'add', LABEL);
    token = (minted.match(/^(tess_[0-9a-f]{64})$/m) || [])[1];
    assert.ok(token, 'reports.mjs printed a token');
    assert.match(minted, /shown once and only its hash is stored/);
  } else {
    token = `tess_${createHash('sha256').update(String(Math.random())).digest('hex')}`;
    sql.rows(`${mintSql(LABEL, token)} RETURNING id`);
  }
  assert.equal(sql.rows(`SELECT sha FROM support_tokens WHERE label = '${LABEL}'`)[0].sha, sha(token), 'only the hash is stored');
  shown.push(`minted a token for "${LABEL}" (${mode === 'wrangler' ? 'node tools/reports.mjs support token add, local D1' : 'the same INSERT, sqlite3'})`);

  // 2. Install the profile into a scratch HERMES_HOME, pointed at the local gate.
  const installed = await run([install], {
    PATH: personPath, HOME: personHome, TMPDIR: box, HERMES_HOME: hermesHome, TESS_TEST: '1', TESS_SUPPORT_TOKEN: token, TESS_INBOX: gate,
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout, 'via copy\n', 'no hermes on the person PATH, so the profile was copied');
  const profile = join(hermesHome, 'profiles', 'tess-support');
  assert.equal(readFileSync(join(profile, '.env'), 'utf8'), `TESS_SUPPORT_TOKEN=${token}\nTESS_INBOX=${gate}\n`);
  shown.push(`installed the profile into a scratch HERMES_HOME with TESS_TEST=1, TESS_INBOX=${gate}`);

  const personEnv = { PATH: personPath, HOME: personHome, HERMES_HOME: hermesHome, TESS_TEST: '1', TEST_RELEASE_URL: `http://127.0.0.1:${upPort}/release` };

  // 3. One streamed turn, shaped like Hermes's.
  const turn = await run([client, 'The lyrics are two seconds late'], personEnv);
  assert.equal(turn.status, 0, `${turn.stdout}${turn.stderr}`);
  const t1 = JSON.parse(turn.stdout);
  assert.equal(t1.url, `${gate}/v1/support/chat/completions`, 'the profile base plus /chat/completions is the gate route');
  assert.equal(t1.status, 200);
  assert.equal(t1.content, 'Hello from the support gate.');
  assert.equal(t1.released, true, 'the client read the first delta before the upstream sent the rest');
  assert.equal(up.releasedByClient, true, 'the reply streamed through the gate, not buffered');
  assert.equal(t1.usage?.total_tokens, 23);
  assert.equal(up.calls.length, 1, 'one turn, one upstream call');
  const c1 = up.calls[0];
  assert.equal(c1.headers.authorization, `Bearer ${KEY}`, "the upstream got Krish's key");
  assert.equal(c1.body.includes(token) || JSON.stringify(c1.headers).includes(token), false, 'the person token went upstream');
  const sent = JSON.parse(c1.body);
  assert.equal(sent.model, 'deepseek-v4.1-flash');
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.equal(sent.tools[0].function.name, 'tess_save_note', 'Hermes tools reach the model');
  assert.equal(sent.messages[1].content, 'The lyrics are two seconds late');
  shown.push(`streamed turn: "${t1.content}" (first delta reached the client before the upstream finished), ${t1.usage.total_tokens} tokens`);

  // 4. The per-person cap counted that turn. The token total is written when the stream ends, so wait for it.
  const after1 = await until('the token total', async () => { const u = await usage(); return u.tokens === 23 ? u : null; });
  assert.deepEqual(after1, { requests: 1, tokens: 23, revoked: null, sharedRequests: 1, sharedTokens: 23 });
  if (mode === 'wrangler') {
    const watched = reportsCli('support', 'usage');
    assert.match(watched, new RegExp(`^${LABEL}\\s+1 of ${vars.SUPPORT_CHAT_PERSON_REQUESTS} requests\\s+23 of ${vars.SUPPORT_CHAT_PERSON_TOKENS} tokens\\s+active$`, 'm'));
    assert.match(watched, new RegExp(`^\\(everyone\\)\\s+1 of ${vars.SUPPORT_CHAT_SHARED_REQUESTS} requests\\s+23 of ${vars.SUPPORT_CHAT_SHARED_TOKENS} tokens$`, 'm'));
    shown.push(`node tools/reports.mjs support usage →\n      ${watched.trim().split('\n').slice(1).join('\n      ')}`);
  } else {
    shown.push(`usage rows (support usage SQL): ${LABEL} 1 request, 23 tokens; everyone 1 request, 23 tokens`);
  }

  // 5. The profile's own one-shot check (support/mac/chat.mjs) on the same gate: a plain reply, counted too.
  const plain = await run([chat, 'is the gate up'], personEnv);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).choices[0].message.content, 'Hi, this is the gate.');
  assert.equal(up.calls.length, 2);
  assert.equal(up.calls[1].headers.authorization, `Bearer ${KEY}`);
  const after2 = await until('the second turn', async () => { const u = await usage(); return u.tokens === 34 ? u : null; });
  assert.equal(after2.requests, 2);
  shown.push('support/mac/chat.mjs: plain reply, 2 requests and 34 tokens counted');

  // 6. Krish's key is nowhere on the person's side: not in the profile, not in anything the gate sent back.
  for (const f of walk(hermesHome)) assert.equal(readFileSync(f, 'utf8').includes(KEY), false, `${f} holds the key`);
  for (const out of [turn.stdout, turn.stderr, plain.stdout, plain.stderr, installed.stdout, installed.stderr]) {
    assert.equal(out.includes(KEY), false, 'the person saw the key');
  }
  assert.equal(Object.values(personEnv).some((v) => v.includes(KEY)), false);
  shown.push(`the key reached the upstream on both calls; it is in none of the ${walk(hermesHome).length} profile files or any reply`);

  // 7. Revoke, then the next turn is refused with words the person can act on, and the upstream is not called.
  if (mode === 'wrangler') {
    assert.match(reportsCli('support', 'token', 'revoke', LABEL), /stops working on the next request/);
  } else {
    sql.rows(`${revokeSql(LABEL)} RETURNING id`);
  }
  assert.ok((await usage()).revoked, 'the token row is revoked');
  const calls = up.calls.length;
  const refused = await run([client, 'still late'], personEnv);
  assert.equal(refused.status, 3);
  const t3 = JSON.parse(refused.stdout);
  assert.equal(t3.status, 401);
  assert.equal(t3.message, REFUSED, 'the gate answers a revoked code with the line Hermes puts in its error');
  const plainRefused = await run([chat, 'still late'], personEnv);
  assert.equal(plainRefused.status, 1);
  assert.equal(plainRefused.stderr.trim(), 'The support token was refused. Ask for a new one. Nothing else was sent.');
  assert.equal(up.calls.length, calls, 'a revoked token reached the upstream');
  const after3 = await usage();
  assert.equal(after3.requests, 2, 'a refused turn spent a request');
  assert.equal(after3.tokens, 34, 'a refused turn spent tokens');
  for (const out of [refused.stdout, plainRefused.stderr]) assert.equal(out.includes(KEY) || out.includes(token), false);
  shown.push(`revoked: next turn → 401 "${t3.message}"; chat.mjs → "${plainRefused.stderr.trim()}"; upstream calls stay at ${calls}`);
  if (mode === 'wrangler') shown.push(`node tools/reports.mjs support tokens → ${reportsCli('support', 'tokens').trim()}`);
} catch (err) {
  if (wranglerLog) console.error(`--- wrangler dev output\n${wranglerLog.slice(-3000)}`);
  throw err;
} finally {
  globalThis.fetch = realFetch;
  await stopWrangler();
  nodeGate?.close();
  upstream.close();
  rmSync(box, { recursive: true, force: true });
  if (createdWranglerDir && existsSync(join(inbox, '.wrangler'))) rmSync(join(inbox, '.wrangler'), { recursive: true, force: true });
}

console.log(`support mac chat (${mode} gate): all checks passed\n`);
for (const line of shown) console.log(`  · ${line}`);
console.log('');
