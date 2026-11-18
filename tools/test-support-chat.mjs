// The support chat gate (POST /v1/support/chat) against a fake upstream. The Worker runs as it does in production;
// only global fetch is replaced, and only after the gates that must not open a socket.
// Usage: node tools/test-support-chat.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const inbox = join(root, 'inbox');
const worker = (await import(join(inbox, 'worker.js'))).default;
const workerSrc = readFileSync(join(inbox, 'worker.js'), 'utf8');

const box = mkdtempSync(join(tmpdir(), 'tess-chat-test-'));
const dbFile = join(box, 'inbox.db');
const KEY = `oc-go-${'k'.repeat(48)}`;
const TOKEN = `tess_${'a'.repeat(48)}`;
const REVOKED = `tess_${'b'.repeat(48)}`;
const UPSTREAM = 'https://opencode.ai/zen/go/v1/chat/completions';
const MODEL = 'deepseek-v4.1-flash';

const lit = (v) => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v)
    : `'${String(v).replace(/'/g, "''")}'`);
const subs = (sql, args) => {
  let i = 0;
  return sql.replace(/\?/g, () => lit(args[i++]));
};
const sqlite = (sql, json = false) => execFileSync(
  'sqlite3',
  [...(json ? ['-json'] : []), '-cmd', '.timeout 5000', dbFile, sql],
  { encoding: 'utf8' },
);
const query = (sql) => {
  const text = sqlite(sql, true).trim();
  return text ? JSON.parse(text) : [];
};
const DB = {
  prepare: (sql) => ({
    bind: (...args) => ({
      first: async () => query(subs(sql, args))[0] ?? null,
      all: async () => ({ results: query(subs(sql, args)) }),
      run: async () => {
        const out = sqlite(`${subs(sql, args)};\nSELECT changes(), last_insert_rowid();`).trim();
        const [changes, last] = out.split('\n').pop().split('|');
        return { meta: { changes: Number(changes) || 0, last_row_id: Number(last) || 0 } };
      },
    }),
    first: async () => query(sql)[0] ?? null,
    run: async () => {
      const out = sqlite(`${sql};\nSELECT changes();`).trim();
      return { meta: { changes: Number(out.split('\n').pop()) || 0 } };
    },
  }),
};

let rescueReads = 0;
const calls = [];
const realFetch = globalThis.fetch;
let upstreamImpl = async () => jsonReply({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 } });

const shaOf = (t) => createHash('sha256').update(t).digest('hex');
const env = (extra = {}) => ({
  DB,
  SALT: 'test-salt-test-salt',
  LIMIT: { limit: async () => ({ success: true }) },
  RESCUE: { get: async () => { rescueReads += 1; return null; } },
  OPENCODE_GO_API_KEY: KEY,
  SUPPORT_MODEL: MODEL,
  SUPPORT_CHAT_PERSON_REQUESTS: '80',
  SUPPORT_CHAT_SHARED_REQUESTS: '400',
  SUPPORT_CHAT_PERSON_TOKENS: '300000',
  SUPPORT_CHAT_SHARED_TOKENS: '2000000',
  ...extra,
});

const chatBody = (over = {}) => ({ model: MODEL, messages: [{ role: 'user', content: 'lyrics are late' }], ...over });
const req = (path, { method = 'POST', body = chatBody(), headers = {}, token = TOKEN } = {}) => {
  const payload = body === undefined || body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const h = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    'cf-connecting-ip': '203.0.113.9',
    cookie: 'session=should-not-forward',
    'x-forwarded-for': '198.51.100.4',
    'x-api-key': 'client-supplied-key',
    'user-agent': 'Hermes/0.22.6',
    'x-opencode-session': 'support:visit-1',
    ...headers,
  };
  if (token) h.authorization = `Bearer ${token}`;
  return new Request(`https://inbox.test${path}`, { method, headers: h, body: method === 'GET' ? undefined : payload });
};

function jsonReply(obj, status = 200, type = 'application/json') {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': type } });
}

function installFetch() {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return upstreamImpl(url, init);
  };
}

const limitOf = (key) => query(`SELECT n, until FROM limits WHERE k = '${key}'`)[0] ?? null;
const clearCaps = () => execFileSync('sqlite3', [dbFile, "DELETE FROM limits WHERE k LIKE 'chat:%'"]);

const logs = [];
const origLog = console.log;
const origErr = console.error;
const origInfo = console.info;
const origWarn = console.warn;
for (const [method, orig] of [['log', origLog], ['error', origErr], ['info', origInfo], ['warn', origWarn]]) {
  console[method] = (...args) => {
    logs.push(args.map(String).join(' '));
    orig.apply(console, args);
  };
}

try {
  execFileSync('sh', ['-c', `sqlite3 "${dbFile}" < "${join(inbox, 'schema.sql')}"`]);
  const now = Date.now();
  execFileSync('sqlite3', [dbFile, `INSERT INTO support_tokens (label, sha, added) VALUES ('Ada', '${shaOf(TOKEN)}', ${now})`]);
  execFileSync('sqlite3', [dbFile, `INSERT INTO support_tokens (label, sha, added, revoked) VALUES ('Old', '${shaOf(REVOKED)}', ${now}, ${now})`]);
  installFetch();

  const chatBlock = workerSrc.slice(workerSrc.indexOf('// --- support chat'), workerSrc.indexOf('export default'));
  assert.ok(chatBlock.includes('async function supportChat'), 'the chat route is in its own block');
  assert.ok(!chatBlock.includes('RESCUE'), 'the chat block does not read the rescue binding');
  assert.ok(!chatBlock.includes('rescue.pem'), 'the chat block does not name the rescue key');
  assert.equal(workerSrc.includes(KEY), false, 'the test key is not in the Worker source');

  // A good token streams a chunked reply, and both cap rows move. The handler returns before the upstream body ends.
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const enc = new TextEncoder();
  upstreamImpl = async () => new Response(new ReadableStream({
    async pull(controller) {
      await blocked;
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
      controller.enqueue(enc.encode('data: {"usage":{"total_tokens":17}}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  calls.length = 0;
  const pending = worker.fetch(req('/v1/support/chat', { body: chatBody({ stream: true }) }), env());
  const raced = await Promise.race([
    pending.then((res) => res),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 400)),
  ]);
  assert.notEqual(raced, 'blocked', 'a stream is returned without buffering the upstream body');
  release();
  const streamed = raced;
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
  const streamedText = await streamed.text();
  assert.match(streamedText, /Hello/);
  assert.match(streamedText, /\[DONE\]/);
  assert.equal(streamedText.includes(KEY), false);
  assert.equal(streamedText.includes(TOKEN), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, UPSTREAM);
  assert.equal(calls[0].init.redirect, 'manual');
  const sent = new Headers(calls[0].init.headers);
  assert.equal(sent.get('authorization'), `Bearer ${KEY}`);
  assert.equal(sent.get('cookie'), null);
  assert.equal(sent.get('x-forwarded-for'), null);
  assert.equal(sent.get('x-api-key'), null);
  assert.equal(sent.get('user-agent'), 'Hermes/0.22.6');
  assert.equal(sent.get('x-opencode-session'), 'support:visit-1');
  assert.equal(calls[0].init.body.includes(TOKEN), false);
  assert.equal(JSON.parse(calls[0].init.body).model, MODEL);
  const person = limitOf(`chat:p:${shaOf(TOKEN)}`);
  const tokens = limitOf(`chat:tp:${shaOf(TOKEN)}`);
  const shared = limitOf('chat:s');
  assert.equal(person.n, 1, 'the per-person request cap moved');
  assert.equal(shared.n, 1, 'the shared request cap moved');
  assert.equal(tokens.n, 17, 'the token budget took the reported usage');
  assert.ok(person.until > Math.floor(Date.now() / 1000));

  // A non-streaming reply is returned whole, and its usage is added on top of the stream.
  upstreamImpl = async () => jsonReply({ choices: [{ message: { content: 'plain' } }], usage: { total_tokens: 9 } });
  calls.length = 0;
  const plain = await worker.fetch(req('/v1/support/chat'), env());
  assert.equal(plain.status, 200);
  const plainBody = await plain.json();
  assert.equal(plainBody.choices[0].message.content, 'plain');
  assert.equal(JSON.stringify(plainBody).includes(KEY), false);
  assert.equal(limitOf(`chat:tp:${shaOf(TOKEN)}`).n, 26);

  // A revoked token, a missing token, a second model, a GET, a query, a dot segment, and a non-chat body never call upstream.
  const silent = async (label, request) => {
    const before = calls.length;
    const res = await worker.fetch(request, env());
    assert.equal(calls.length, before, `${label} opened an upstream socket`);
    return res;
  };
  const revoked = await silent('revoked token', req('/v1/support/chat', { token: REVOKED }));
  assert.equal(revoked.status, 401);
  assert.equal(await revoked.text(), '');
  const missing = await silent('missing token', req('/v1/support/chat', { token: '' }));
  assert.equal(missing.status, 401);
  assert.equal(await missing.text(), '');
  const wrong = await silent('second model', req('/v1/support/chat', { body: chatBody({ model: 'gpt-4o' }) }));
  assert.equal(wrong.status, 400);
  const get = await silent('GET', req('/v1/support/chat', { method: 'GET', body: null }));
  assert.equal(get.status, 405);
  const query = await silent('query string', req('/v1/support/chat?x=1'));
  assert.equal(query.status, 404);
  // Request (and the Worker runtime) resolves ".." before the handler. A path that still carries an encoded
  // slash or dot is not the one allowed route, and a sibling path is not either.
  const dots = await silent('encoded dot segment', req('/v1/support/chat%2f%2e%2e'));
  assert.equal(dots.status, 404);
  const other = await silent('other path', req('/v1/support/other'));
  assert.equal(other.status, 404);
  const shaped = await silent('non-chat body', req('/v1/support/chat', { body: { hello: 'there' } }));
  assert.equal(shaped.status, 400);
  const textBody = await silent('non-json body', req('/v1/support/chat', { body: 'not-json' }));
  assert.equal(textBody.status, 400);

  // Over the request cap: the fake upstream sees nothing.
  clearCaps();
  const until = Math.floor(Date.now() / 1000) + 3600;
  execFileSync('sqlite3', [dbFile, `INSERT INTO limits (k, n, until) VALUES ('chat:p:${shaOf(TOKEN)}', 1, ${until})`]);
  calls.length = 0;
  const capped = await worker.fetch(req('/v1/support/chat'), env({ SUPPORT_CHAT_PERSON_REQUESTS: '1' }));
  assert.equal(capped.status, 429);
  assert.equal(calls.length, 0, 'an over-cap request opened an upstream socket');
  const cappedBody = await capped.json();
  assert.equal(cappedBody.error.type, 'usage_limit_reached');
  assert.equal(cappedBody.error.code, 'terminal_quota_exhausted');
  assert.match(cappedBody.error.message, /00:00 UTC/);
  assert.equal(JSON.stringify(cappedBody).includes(KEY), false);
  assert.equal(JSON.stringify(cappedBody).includes(TOKEN), false);
  assert.equal(limitOf(`chat:p:${shaOf(TOKEN)}`).n, 1, 'a refused request does not spend another slot');

  clearCaps();
  execFileSync('sqlite3', [dbFile, `INSERT INTO limits (k, n, until) VALUES ('chat:s', 2, ${until})`]);
  calls.length = 0;
  const sharedCap = await worker.fetch(req('/v1/support/chat'), env({ SUPPORT_CHAT_SHARED_REQUESTS: '2' }));
  assert.equal(sharedCap.status, 429);
  assert.equal(calls.length, 0, 'a shared-cap request opened an upstream socket');

  // A malformed upstream body does not reset the token counter.
  clearCaps();
  upstreamImpl = async () => jsonReply({ choices: [{ message: { content: 'counted' } }], usage: { total_tokens: 40 } });
  const seeded = await worker.fetch(req('/v1/support/chat'), env());
  assert.equal(seeded.status, 200);
  await seeded.text();
  assert.equal(limitOf(`chat:tp:${shaOf(TOKEN)}`).n, 40);
  const requestsBefore = limitOf(`chat:p:${shaOf(TOKEN)}`).n;
  upstreamImpl = async () => new Response('this is not json', { status: 200, headers: { 'content-type': 'application/json' } });
  const broken = await worker.fetch(req('/v1/support/chat'), env());
  assert.equal(broken.status, 200);
  assert.equal(await broken.text(), 'this is not json');
  assert.equal(limitOf(`chat:tp:${shaOf(TOKEN)}`).n, 40, 'a malformed upstream body reset the token counter');
  assert.ok(limitOf(`chat:p:${shaOf(TOKEN)}`).n >= requestsBefore, 'a malformed upstream body lowered the request counter');

  // The key is on the upstream request and never in the response, even when upstream echoes it.
  upstreamImpl = async () => new Response(`the key is ${KEY} and the token is ${TOKEN}`, {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  calls.length = 0;
  const leaked = await worker.fetch(req('/v1/support/chat'), env());
  const leakedText = await leaked.text();
  assert.equal(leaked.status, 502);
  assert.equal(leakedText.includes(KEY), false);
  assert.equal(leakedText.includes(TOKEN), false);
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), `Bearer ${KEY}`);
  assert.equal(limitOf(`chat:tp:${shaOf(TOKEN)}`).n, 40, 'a secret-bearing body did not rewrite the token counter');

  upstreamImpl = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`data: ${KEY}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const leakedStream = await worker.fetch(req('/v1/support/chat', { body: chatBody({ stream: true }) }), env());
  const leakedStreamText = await leakedStream.text();
  assert.equal(leakedStreamText.includes(KEY), false, 'a streamed key reached the client');

  // Two requests at the last slot: one spends it, the other is refused, and upstream sees one call.
  clearCaps();
  calls.length = 0;
  let upstreamHits = 0;
  upstreamImpl = async () => {
    upstreamHits += 1;
    return jsonReply({ choices: [{ message: { content: 'one' } }], usage: { total_tokens: 3 } });
  };
  const pairEnv = env({ SUPPORT_CHAT_PERSON_REQUESTS: '1', SUPPORT_CHAT_SHARED_REQUESTS: '10' });
  const [first, second] = await Promise.all([
    worker.fetch(req('/v1/support/chat'), pairEnv),
    worker.fetch(req('/v1/support/chat'), pairEnv),
  ]);
  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 429]);
  assert.equal(upstreamHits, 1, 'both parallel requests reached upstream');
  assert.equal(calls.length, 1);
  await first.text();
  await second.text();
  assert.equal(limitOf(`chat:p:${shaOf(TOKEN)}`).n, 1);

  // Fail closed: no key, no database, upstream throw. None of these is a successful chat.
  calls.length = 0;
  const noKey = await worker.fetch(req('/v1/support/chat'), env({ OPENCODE_GO_API_KEY: '' }));
  assert.equal(noKey.status, 503);
  assert.equal(calls.length, 0);
  const noDb = await worker.fetch(req('/v1/support/chat'), env({ DB: undefined }));
  assert.equal(noDb.status, 503);
  assert.equal(calls.length, 0);
  upstreamImpl = async () => { throw new Error(`upstream down ${KEY}`); };
  const down = await worker.fetch(req('/v1/support/chat'), env());
  assert.equal(down.status, 502);
  assert.equal((await down.text()).includes(KEY), false);

  assert.equal(rescueReads, 0, 'chat handling read the rescue binding');
  assert.equal(logs.some((line) => line.includes(KEY) || line.includes(TOKEN)), false, 'a log line contained a secret');

  // The existing support post route is still the report endpoint.
  const support = await worker.fetch(req('/v1/support', { body: { title: 'nope' }, token: '' }), env());
  assert.equal(support.status, 401);
  assert.equal(calls.filter((c) => c.url === UPSTREAM).length, calls.length);
} finally {
  globalThis.fetch = realFetch;
  console.log = origLog;
  console.error = origErr;
  console.info = origInfo;
  console.warn = origWarn;
  rmSync(box, { recursive: true, force: true });
}

console.log('support chat gate ok');
