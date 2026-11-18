// The inbox Worker, driven directly: no network, no Cloudflare account, an in-memory stand-in for D1.
// Proves the health-report path still works, and that the Worker fails closed without its salt, measures the body in
// bytes, and cannot be pushed past a limit by requests that arrive together.
// Run: node tools/test-inbox.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const box = mkdtempSync(join(tmpdir(), 'tess-inbox-test-'));

// The Worker is loaded where it lives: it imports the shared privacy rules by a relative path, which a copy elsewhere
// would break. Node reads its ES module syntax without a "type": "module" package.
const worker = (await import(pathToFileURL(join(root, 'inbox', 'worker.js')).href)).default;

// The statements the Worker runs, and nothing else: an unexpected query fails the test instead of passing silently.
function database() {
  const db = {
    limits: new Map(),
    reports: [],
    wake: null,
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim();
      const stmt = {
        args: [],
        bind(...a) { stmt.args = a; return stmt; },
        async first() {
          const [k] = stmt.args;
          if (q === 'SELECT n FROM limits WHERE k = ?') return db.limits.has(k) ? { n: db.limits.get(k).n } : null;
          if (q === 'SELECT n, until FROM limits WHERE k = ?') return db.limits.get(k) || null;
          if (q === 'SELECT serial FROM wake WHERE id = 1') return db.wake == null ? null : { serial: db.wake };
          throw new Error(`unexpected query: ${q}`);
        },
        async run() {
          if (q.startsWith('INSERT INTO limits')) {
            const [k, until, now, , until2] = stmt.args;
            const row = db.limits.get(k);
            if (!row || row.until <= now) db.limits.set(k, { n: 1, until });
            else db.limits.set(k, { n: row.n + 1, until: until2 ?? row.until });
            return { success: true };
          }
          if (q.startsWith('INSERT INTO reports')) {
            const [at, install, kind, tess, spotify, macos, status, body] = stmt.args;
            db.reports.push({ id: db.reports.length + 1, at, install, kind, tess, spotify, macos, status, body });
            return { success: true };
          }
          if (q.startsWith('DELETE FROM reports')) {
            const [before] = stmt.args;
            db.reports = db.reports.filter((r) => r.at >= before);
            return { success: true };
          }
          if (q.startsWith('DELETE FROM limits')) {
            const [now] = stmt.args;
            for (const [k, v] of db.limits) if (v.until < now) db.limits.delete(k);
            return { success: true };
          }
          throw new Error(`unexpected statement: ${q}`);
        },
        async all() { throw new Error(`unexpected all(): ${q}`); },
      };
      return stmt;
    },
  };
  return db;
}

const SALT = 'a'.repeat(32);
const makeEnv = (db, { salt = SALT, limited = true, kv = {} } = {}) => ({
  DB: db,
  SALT: salt,
  RESCUE: { async get(k) { return k in kv ? kv[k] : null; } },
  LIMIT: { async limit() { return { success: limited }; } },
});

const IP = '203.0.113.7';
const report = (install = 'a'.repeat(32), kind = 'heartbeat', extra = {}) => ({ install, kind, tess: '0.2.22', spotify: '1.3.9', macos: '15.1', status: 'ok', body: 'hello', ...extra });

const post = (payload, { env, ip = IP, contentType = 'application/json', length } = {}) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  // A real client sends the byte length; one test sends the character count instead, which is the bug being checked.
  const headers = { 'content-type': contentType, 'cf-connecting-ip': ip, 'content-length': String(length ?? new TextEncoder().encode(body).length) };
  return worker.fetch(new Request('https://inbox.test/v1/report', { method: 'POST', headers, body }), env);
};

try {
  // 1. the health-report path still works: one report in, one row stored
  {
    const db = database();
    const res = await post(report(), { env: makeEnv(db) });
    assert.equal(res.status, 204, 'a normal report is accepted');
    assert.equal(db.reports.length, 1, 'exactly one row is written');
    const row = db.reports[0];
    assert.equal(row.install, 'a'.repeat(32));
    assert.equal(row.kind, 'heartbeat');
    assert.equal(row.tess, '0.2.22');
    assert.equal(row.body, 'hello');
  }
  // 1b. a health report's machine numbers survive the inbox: the Mac filtered it already, and a timestamp or a byte
  // count read as a phone number would make the report useless
  {
    const db = database();
    const status = 'ok since 1763452800, free 123456789012 bytes, rescue serial 2026111801';
    const res = await post({ ...report(), status, body: status }, { env: makeEnv(db) });
    assert.equal(res.status, 204);
    assert.equal(db.reports[0].status, status, 'a health status keeps its numbers');
    assert.equal(db.reports[0].body, status, 'a health body keeps its numbers');
    assert.ok(db.limits.get('all'), 'the daily total is counted');
  }

  // 2. no salt, or a salt too short to be one: refuse and store nothing
  for (const salt of [undefined, '', 'short']) {
    const db = database();
    const env = makeEnv(db);
    if (salt === undefined) delete env.SALT; else env.SALT = salt;
    const res = await post(report(), { env });
    assert.equal(res.status, 503, `no usable salt (${String(salt)}) refuses`);
    assert.equal(db.reports.length, 0, 'nothing is stored without a salt');
    assert.equal(db.limits.size, 0, 'no limit row is written without a salt');
  }

  // 2b. no database at all: refuse rather than throw
  {
    const res = await post(report(), { env: { SALT: SALT, RESCUE: { async get() { return null; } }, LIMIT: { async limit() { return { success: true }; } } } });
    assert.equal(res.status, 503, 'a Worker without its database refuses');
  }

  // 3. the size limit is measured in bytes, not UTF-16 units: 18K characters, 36K bytes
  {
    const db = database();
    const big = '𝄞'.repeat(9000);
    assert.equal(big.length, 18000, 'the body is 18K UTF-16 units …');
    assert.equal(new TextEncoder().encode(big).length, 36000, '… but 36K bytes');
    const res = await post(report(undefined, undefined, { body: big }), { env: makeEnv(db), length: big.length });
    assert.equal(res.status, 413, 'a body over 32 KB of bytes is refused');
    assert.equal(db.reports.length, 0, 'nothing is stored');
  }

  // 3b. the stored body is cut by bytes too: 28 KB of bytes must not arrive as 28 KB in the database
  {
    const db = database();
    const body = '𝄞'.repeat(7000); // 7000 characters, 28000 bytes
    const res = await post(report(undefined, undefined, { body }), { env: makeEnv(db) });
    assert.equal(res.status, 204);
    const stored = new TextEncoder().encode(db.reports[0].body).length;
    assert.ok(stored <= 24 * 1024, `the stored body is at most 24 KB of bytes (got ${stored})`);
    assert.ok(stored > 20 * 1024, `the stored body is not cut short unnecessarily (got ${stored})`);
  }

  // 3c. nothing that hides itself from the person reading a report is stored: a bidi override could reorder a line so
  // an honest path reads as a different one, and zero-width characters and C1 controls are invisible in a terminal
  {
    const db = database();
    const hidden = 'chr\u202eesruo\u2066c\u200b\u2069\u0007\u009b\u200d\ufeff\u2060!';
    const res = await post(report(undefined, undefined, { status: 'ok\u202e', body: hidden, tess: '\u200b0.2.22' }), { env: makeEnv(db) });
    assert.equal(res.status, 204, 'the report is still accepted');
    const row = db.reports[0];
    const left = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
    for (const what of ['body', 'status', 'tess']) assert.ok(!left.test(row[what]), `the stored ${what} keeps nothing invisible`);
    assert.equal(row.body, 'chresruoc!', 'the visible text is kept, in order');
    assert.equal(row.status, 'ok', 'the status line has no override left');
    assert.equal(row.tess, '0.2.22', 'a zero-width character does not survive in a version string');
  }

  // 4. concurrent reports cannot slip past the per-IP limit: 40 at once against a cap of 30
  {
    const db = database();
    const env = makeEnv(db);
    const results = await Promise.all(Array.from({ length: 40 }, () => post(report(), { env })));
    const accepted = results.filter((r) => r.status === 204).length;
    assert.equal(accepted, 30, `exactly the cap is accepted (got ${accepted})`);
    assert.equal(db.reports.length, 30, 'exactly the cap is stored');
    const later = await post(report(), { env });
    assert.equal(later.status, 429, 'a later report in the same hour is refused');
  }

  // 5. the daily total refuses new reports once it is full
  {
    const db = database();
    db.limits.set('all', { n: 2000, until: Math.floor(Date.now() / 1000) + 3600 });
    const res = await post(report(), { env: makeEnv(db) });
    assert.equal(res.status, 429);
    assert.equal(db.reports.length, 0);
  }

  // 6. Cloudflare's own limiter is still consulted first
  {
    const db = database();
    const res = await post(report(), { env: makeEnv(db, { limited: false }) });
    assert.equal(res.status, 429);
    assert.equal(db.reports.length, 0);
  }

  // 7. shape checks are unchanged
  for (const [name, payload, contentType, want] of [
    ['not JSON', 'hello', 'application/json', 400],
    ['wrong content type', report(), 'text/plain', 415],
    ['unknown kind', report(undefined, 'shell'), 'application/json', 400],
    ['install id not a Tess id', report('nope'), 'application/json', 400],
  ]) {
    const db = database();
    const res = await post(payload, { env: makeEnv(db), contentType });
    assert.equal(res.status, want, `${name} is refused with ${want}`);
    assert.equal(db.reports.length, 0, `${name} stores nothing`);
  }

  // 8. the rescue files and the public wake serial still answer
  {
    const db = database();
    const env = makeEnv(db, { kv: { 'rescue.txt': 'order', 'rescue.sig': 'sig', wake: '41' } });
    const get = (p) => worker.fetch(new Request(`https://inbox.test${p}`), env);
    assert.equal(await (await get('/v1/rescue.txt')).text(), 'order');
    assert.equal(await (await get('/v1/rescue.sig')).text(), 'sig');
    assert.equal((await get('/v1/rescue.txt')).headers.get('cache-control'), 'no-store');
    assert.equal((await get('/v1/rescue.other')).status, 404);
    assert.equal(await (await get('/v1/wake')).text(), '41', 'the wake serial falls back to KV');
    db.wake = 42;
    assert.equal(await (await get('/v1/wake')).text(), '42', 'the database wins when it has a serial');
    delete env.RESCUE;
    const empty = makeEnv(database());
    assert.equal((await worker.fetch(new Request('https://inbox.test/v1/wake'), empty)).status, 204, 'no order, no wake');
  }

  // 9. the daily cleanup keeps 30 days and drops finished windows
  {
    const db = database();
    const now = Date.now();
    db.reports.push({ at: now - 31 * 86400 * 1000, install: 'b'.repeat(32), kind: 'heartbeat' });
    db.reports.push({ at: now, install: 'c'.repeat(32), kind: 'heartbeat' });
    db.limits.set('old', { n: 3, until: Math.floor(now / 1000) - 10 });
    db.limits.set('live', { n: 3, until: Math.floor(now / 1000) + 600 });
    await worker.scheduled({}, { DB: db });
    assert.equal(db.reports.length, 1, 'a report older than 30 days is deleted');
    assert.ok(!db.limits.has('old'), 'a finished window is deleted');
    assert.ok(db.limits.has('live'), 'a live window is kept');
  }

  console.log('inbox tests passed (health report stores; no salt 503; bytes counted; bidi and zero-width stripped; 30 of 40 concurrent; shape checks; rescue and wake)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
