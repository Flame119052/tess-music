// Test the inbox's support endpoint (inbox/worker.js) locally: the real Worker code against a real SQLite database
// built from inbox/schema.sql, driven through env.DB the way Cloudflare's D1 would. No Cloudflare account, no wrangler,
// no network and no deploy.
// Usage: node tools/test-inbox.mjs
// Proves: a report with no token, a wrong token or a revoked token is refused; an approved token stores the report with
// its label; a bad priority, a bad area or a missing title is refused; an oversized body is refused; and there is no way
// to read a support report back over the web.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const inbox = join(root, 'inbox');
const worker = (await import(join(inbox, 'worker.js'))).default;

const box = mkdtempSync(join(tmpdir(), 'tess-inbox-test-'));
const dbFile = join(box, 'inbox.db');

// The smallest D1 that is still real: every statement goes to sqlite3, so the Worker's own SQL (and schema.sql) is what
// runs. Values are bound the way D1 binds them — as literals, quoted here.
const lit = (v) => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v)
    : `'${String(v).replace(/'/g, "''")}'`);
const subs = (sql, args) => {
  let i = 0;
  return sql.replace(/\?/g, () => lit(args[i++]));
};
const query = (sql) => {
  const text = execFileSync('sqlite3', ['-json', dbFile, sql], { encoding: 'utf8' }).trim();
  return text ? JSON.parse(text) : [];
};
const DB = {
  prepare: (sql) => ({
    bind: (...args) => ({
      first: async () => query(subs(sql, args))[0] ?? null,
      all: async () => ({ results: query(subs(sql, args)) }),
      run: async () => {
        // Same connection, so last_insert_rowid() is the row this statement wrote — a separate sqlite3 process would
        // report 0, which is how D1's own meta.last_row_id would have looked fine in production and broken here.
        // `changes()` is the other half: it is what D1 reports as meta.changes, and the rate limiter decides on it.
        const out = execFileSync('sqlite3', [dbFile, `${subs(sql, args)};\nSELECT changes(), last_insert_rowid();`], { encoding: 'utf8' }).trim();
        const [changes, last] = out.split('\n').pop().split('|');
        return { meta: { changes: Number(changes) || 0, last_row_id: Number(last) || 0 } };
      },
    }),
    first: async () => query(sql)[0] ?? null,
    all: async () => ({ results: query(sql) }),
    run: async () => {
      const out = execFileSync('sqlite3', [dbFile, `${sql};\nSELECT changes();`], { encoding: 'utf8' }).trim();
      return { meta: { changes: Number(out.split('\n').pop()) || 0 } };
    },
  }),
};
// An in-memory stand-in for the R2 bucket: enough to prove what is written and what the sweep deletes.
const bucket = new Map();
const R2 = {
  put: async (key, body) => { bucket.set(key, body); },
  delete: async (key) => { bucket.delete(key); },
  get: async (key) => (bucket.has(key) ? bucket.get(key) : null),
};
const env = (extra = {}) => ({
  DB,
  SALT: 'test-salt',
  LIMIT: { limit: async () => ({ success: true }) },
  RESCUE: { get: async () => null },
  SUPPORT: R2,
  ...extra,
});
const post = (path, body, headers = {}) => new Request(`https://inbox.test${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body))), 'cf-connecting-ip': '203.0.113.7', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const token = 'tok_' + 'a'.repeat(40);
const shaOf = (t) => createHash('sha256').update(t).digest('hex');

const good = (over = {}) => ({
  priority: 'P2',
  kind: 'bug',
  areas: ['area: theme'],
  title: 'Lyrics drift about half a second behind the song',
  words: 'the lyrics are always about half a second behind',
  diagnosis: 'The doctor is clean; the sync offset in theme is the likely cause.',
  body: '## What happened\n\nthe lyrics drift\n',
  tess: '0.1.9', spotify: '1.2.52.442', macos: '26.1',
  install: '4f2a9c1e8b7d0a3f5e6c8b2d1a4f7e90',
  ...over,
});

try {
  execFileSync('sh', ['-c', `sqlite3 "${dbFile}" < "${join(inbox, 'schema.sql')}"`]);
  // Two approved posters, one of whom is later revoked.
  execFileSync('sqlite3', [dbFile, `INSERT INTO support_tokens (label, sha, added) VALUES ('Krish bot', '${shaOf(token)}', ${Date.now()})`]);
  const dead = 'tok_' + 'b'.repeat(40);
  execFileSync('sqlite3', [dbFile, `INSERT INTO support_tokens (label, sha, added, revoked) VALUES ('Old bot', '${shaOf(dead)}', ${Date.now()}, ${Date.now()})`]);

  const status = async (req, e = env()) => (await worker.fetch(req, e)).status;

  // 1. No token, a wrong token, and a revoked token are all refused, and nothing is stored.
  assert.equal(await status(post('/v1/support', good())), 401, 'a report with no token is refused');
  assert.equal(await status(post('/v1/support', good(), { authorization: 'Bearer made-up' })), 401, 'a wrong token is refused');
  assert.equal(await status(post('/v1/support', good(), { authorization: `Bearer ${dead}` })), 401, 'a revoked token is refused');
  assert.equal(query('SELECT COUNT(*) AS n FROM support_reports')[0].n, 0, 'nothing was stored by any refusal');

  // 1a. A health report is refused outright when there is no usable salt. An IPv4 address hashed with a missing or tiny
  // salt can be reversed straight out of the `limits` row it wrote, so the only safe answer is to store nothing.
  const health = (over = {}) => ({
    install: 'b'.repeat(32), kind: 'heartbeat', tess: '0.1.9', spotify: '1.3.9', macos: '26.1', status: 'ok',
    body: 'nothing wrong', ...over,
  });
  const count = (sql) => query(sql)[0].n;
  const ipRows = () => count("SELECT COUNT(*) AS n FROM limits WHERE k LIKE 'ip:%'");
  for (const [why, salt] of [['no salt', undefined], ['an empty salt', ''], ['a 9-character salt', 'test-salt'],
    ['a salt that is not a string', 42]]) {
    assert.equal(await status(post('/v1/report', health()), env({ SALT: salt })), 503, `a health report with ${why} is refused`);
  }
  assert.equal(await status(post('/v1/report', health()), env({ DB: undefined })), 503, 'a health report with no database is refused');
  assert.equal(count('SELECT COUNT(*) AS n FROM reports'), 0, 'none of those reports was stored');
  assert.equal(ipRows(), 0, 'and no unsalted IP hash was written to the limits table');
  assert.equal(await status(post('/v1/report', health()), env({ SALT: 'k'.repeat(32) })), 204, 'a real salt still stores the report');
  assert.equal(count('SELECT COUNT(*) AS n FROM reports'), 1, 'the report is stored once');
  assert.equal(ipRows(), 1, 'and its IP is only ever a salted hash');

  // 2. An approved token stores the report, labelled with who it belongs to.
  const res = await worker.fetch(post('/v1/support', good(), { authorization: `Bearer ${token}` }), env());
  assert.equal(res.status, 201, 'an approved token is accepted');
  const { id } = await res.json();
  assert.ok(Number.isInteger(id) && id > 0, 'and it answers with the row it stored');
  const [row] = query(`SELECT * FROM support_reports WHERE id = ${id}`);
  assert.equal(row.person, 'Krish bot', 'the report records which approved poster sent it');
  assert.equal(row.priority, 'P2');
  assert.equal(row.areas, 'area: theme');
  assert.equal(row.title, 'Lyrics drift about half a second behind the song');
  assert.equal(row.tess, '0.1.9');
  assert.equal(row.spotify, '1.2.52.442', 'a four-part Spotify version is stored as it came');
  assert.equal(row.install, '4f2a9c1e8b7d0a3f5e6c8b2d1a4f7e90', 'the doctor report id rides along');
  assert.equal(row.issue, null, 'and it starts unfiled');

  // 3. The labels are checked where they will be used: a bad priority or a made-up area never reaches the database.
  assert.equal(await status(post('/v1/support', good({ priority: 'urgent' }), { authorization: `Bearer ${token}` })), 400, 'a bad priority is refused');
  assert.equal(await status(post('/v1/support', good({ areas: ['area: vibes'] }), { authorization: `Bearer ${token}` })), 400, 'a made-up area is refused');
  assert.equal(await status(post('/v1/support', good({ kind: 'whatever' }), { authorization: `Bearer ${token}` })), 400, 'a made-up kind is refused');
  assert.equal(await status(post('/v1/support', good({ title: '' }), { authorization: `Bearer ${token}` })), 400, 'a report with no title is refused');
  assert.equal(query('SELECT COUNT(*) AS n FROM support_reports')[0].n, 1, 'none of the bad reports were stored');

  // 3b. The endpoint is the last gate before a person's words become a public issue, and the bot can post here directly
  // without triage ever seeing the text. Personal details and characters that a terminal hides are neutralised on the
  // way in, so what is stored, and what is later filed from it, says what the person meant and nothing they didn't.
  const nasty = good({
    title: 'Ping sam.whitfield@example.com',
    words: 'my Mac is Krishs-MacBook-Pro.local and my key is ~/.ssh/id_rsa',
    diagnosis: 'the doctor log says /Users/alice/secret',
    body: '## What happened\n\n/Users/alice/secret \u202e and \u200b a zero-width space',
    spotify: '/Users/alice/Spotify.app',
    macos: 'Krishs-MacBook-Pro.local',
  });
  const nastyRes = await worker.fetch(post('/v1/support', nasty, { authorization: `Bearer ${token}` }), env());
  assert.equal(nastyRes.status, 201, 'a report carrying personal detail is still taken');
  const [kept] = query(`SELECT * FROM support_reports WHERE id = ${(await nastyRes.json()).id}`);
  const storedText = [kept.title, kept.words, kept.diagnosis, kept.body, kept.spotify, kept.macos].join('\n');
  for (const [what, re] of [
    ['an email', /sam\.whitfield|example\.com/],
    ['a home folder', /alice/],
    ['a tilde path', /id_rsa/],
    ['a computer name', /MacBook|\.local/],
    ['a right-to-left override', /[\u202a-\u202e]/],
    ['a zero-width character', /[\u200b-\u200f\ufeff]/],
  ]) {
    assert.ok(!re.test(storedText), `${what} does not reach the stored report`);
  }
  assert.equal(kept.spotify, '~', 'the Spotify line keeps its place, not the path');

  // 3c. Neutralising happens before the title is judged, so a control character cannot smuggle shell syntax past it.
  assert.equal(await status(post('/v1/support', good({ title: 'Lyrics $\u200b(touch /tmp/x)' }), { authorization: `Bearer ${token}` })), 400,
    'a title that only looks harmless until its zero-width space is stripped is refused');

  // 4. Sizes and shapes are bounded, like the health reports.
  const huge = good({ body: 'x'.repeat(60 * 1024) });
  assert.equal(await status(post('/v1/support', huge, { authorization: `Bearer ${token}` })), 413, 'an oversized body is refused');
  assert.equal(await status(post('/v1/support', 'not json', { authorization: `Bearer ${token}` })), 400, 'a body that is not JSON is refused');
  assert.equal(await status(post('/v1/support', good(), { authorization: `Bearer ${token}`, 'content-type': 'text/plain' })), 415, 'a body that claims to be text is refused');

  // 5. There is no way to read a support report back over the web.
  for (const p of ['/v1/support', '/v1/support/1', '/v1/support_reports']) {
    assert.equal(await status(new Request(`https://inbox.test${p}`, { method: 'GET' })), 404, `GET ${p} does not exist`);
  }

  // 6. The open-issue titles the bot checks before filing: public, cached, and never report data.
  execFileSync('sqlite3', [dbFile, `INSERT INTO issue_titles (n, title, updated) VALUES (61, 'Library: separate Blends and Playlists', ${Date.now()}), (65, 'Full-screen player right side stays blank', ${Date.now()})`]);
  const titlesRes = await worker.fetch(new Request('https://inbox.test/v1/issues', { method: 'GET' }), env());
  assert.equal(titlesRes.status, 200, 'the title list is served');
  const { issues } = await titlesRes.json();
  assert.deepEqual(issues.map((i) => i.n), [61, 65], 'with the open issue numbers');
  assert.ok(issues.every((i) => typeof i.title === 'string'), 'and their titles');
  assert.ok(!JSON.stringify(issues).includes('install'), 'and nothing from a report');

  // 7. A recording can be written but never read back, and only by an approved token.
  const rec = (body, headers = {}) => new Request(`https://inbox.test/v1/support/recording/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'video/quicktime', 'content-length': String(body.length), ...headers },
    body,
  });
  const bytes = Buffer.from('not really a video');
  assert.equal(await status(rec(bytes)), 401, 'a recording with no token is refused');
  assert.equal(await status(rec(bytes, { authorization: `Bearer ${dead}` })), 401, 'a revoked token cannot upload');
  assert.equal(await status(rec(bytes, { authorization: `Bearer ${token}`, 'content-type': 'application/pdf' })), 415, 'a non-video is refused');
  const tooBig = Buffer.alloc(51 * 1024 * 1024);
  assert.equal(await status(rec(tooBig, { authorization: `Bearer ${token}` })), 413, 'a recording over 50 MB is refused');
  assert.equal(await status(rec(bytes, { authorization: `Bearer ${token}` })), 204, 'an approved token stores it');
  assert.equal(query(`SELECT recording FROM support_reports WHERE id = ${id}`)[0].recording, `support/${id}.mov`, 'the report records where it went');
  assert.ok(bucket.has(`support/${id}.mov`), 'and it is in the bucket');
  assert.equal(await status(new Request(`https://inbox.test/v1/support/recording/${id}`, { method: 'GET' })), 404, 'there is no way to read a recording back');

  // 7b. Another approved poster cannot touch this report's recording. Ids are sequential and labels are not unique.
  const other = 'tok_' + 'c'.repeat(40);
  execFileSync('sqlite3', [dbFile, `INSERT INTO support_tokens (label, sha, added) VALUES ('Krish bot', '${shaOf(other)}', ${Date.now()})`]);
  assert.equal(await status(rec(bytes, { authorization: `Bearer ${other}` })), 403, 'a different token cannot replace someone else\'s recording');
  assert.equal(query(`SELECT recording FROM support_reports WHERE id = ${id}`)[0].recording, `support/${id}.mov`, 'and the original is still the one recorded');

  // 8. The sweep deletes a recording once the report is filed — the person's screen is not kept.
  execFileSync('sqlite3', [dbFile, `UPDATE support_reports SET issue = 'https://github.com/Flame119052/tess-music/issues/91', filed_at = ${Date.now()} WHERE id = ${id}`]);
  await worker.scheduled({}, env());
  assert.ok(!bucket.has(`support/${id}.mov`), 'a filed report\'s recording is deleted');
  assert.equal(query(`SELECT recording FROM support_reports WHERE id = ${id}`)[0].recording, null, 'and the row stops pointing at it');

  // 8b. A Worker deployed before inbox/schema.sql is applied must not take the health inbox down with it.
  const oldDb = join(box, 'old-schema.db');
  execFileSync('sqlite3', [oldDb, `CREATE TABLE reports (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, install TEXT, kind TEXT, tess TEXT, spotify TEXT, macos TEXT, status TEXT, body TEXT); CREATE TABLE limits (k TEXT PRIMARY KEY, n INTEGER, until INTEGER); CREATE TABLE wake (id INTEGER PRIMARY KEY, serial INTEGER);`]);
  execFileSync('sqlite3', [oldDb, `INSERT INTO reports (at, install, kind) VALUES (${Date.now() - 40 * 86400 * 1000}, '${'a'.repeat(32)}', 'problem'); INSERT INTO limits (k, n, until) VALUES ('old', 1, 1);`]);
  const oldQuery = (sql) => { const t = execFileSync('sqlite3', ['-json', oldDb, sql], { encoding: 'utf8' }).trim(); return t ? JSON.parse(t) : []; };
  const oldDBs = {
    prepare: (sql) => ({
      bind: (...a) => ({ first: async () => oldQuery(subs(sql, a))[0] ?? null, all: async () => ({ results: oldQuery(subs(sql, a)) }), run: async () => { execFileSync('sqlite3', [oldDb, subs(sql, a)]); return { meta: {} }; } }),
      first: async () => oldQuery(sql)[0] ?? null, all: async () => ({ results: oldQuery(sql) }), run: async () => { execFileSync('sqlite3', [oldDb, sql]); return { meta: {} }; },
    }),
  };
  await worker.scheduled({}, { DB: oldDBs, SALT: 'x', LIMIT: { limit: async () => ({ success: true }) }, RESCUE: { get: async () => null }, SUPPORT: { delete: async () => {} } });
  assert.equal(oldQuery('SELECT COUNT(*) AS n FROM reports')[0].n, 0, 'the health-report cleanup still ran on a database without the support tables');
  assert.equal(oldQuery('SELECT COUNT(*) AS n FROM limits')[0].n, 0, 'and so did the rate-limit cleanup');

  // 8c. A title that would be read as a command is refused at the door. A control byte is not a command, it is noise:
  // it is stripped and the title is kept, so a stray NUL does not cost someone their report.
  for (const nasty of ['Lyrics $(touch /tmp/x)', 'Lyrics `id`']) {
    assert.equal(await status(post('/v1/support', good({ title: nasty }), { authorization: `Bearer ${token}` })), 400, `a title with shell syntax is refused: ${JSON.stringify(nasty)}`);
  }
  const nulRes = await worker.fetch(post('/v1/support', good({ title: 'Lyrics \u0000 null' }), { authorization: `Bearer ${token}` }), env());
  assert.equal(nulRes.status, 201, 'a title with a stray control byte is still taken');
  const nulTitle = query(`SELECT title FROM support_reports WHERE id = ${(await nulRes.json()).id}`)[0].title;
  assert.equal(nulTitle, 'Lyrics  null', 'and the control byte is gone from it');

  // 9. A WAF handler that only guards the old path would let floods through here too, so the limiter is checked.
  const denied = env({ LIMIT: { limit: async () => ({ success: false }) } });
  assert.notEqual(await status(post('/v1/support', good(), { authorization: `Bearer ${token}` }), denied), 201, 'a refused connection stores nothing');
  const titlesDenied = await worker.fetch(new Request('https://inbox.test/v1/issues', { method: 'GET' }), env({ LIMIT: { limit: async () => ({ success: false }) } }));
  assert.equal(titlesDenied.status, 429, 'and the public title list is behind the same limiter');

  // 9b. The per-token cap is one decision, not a read and then a write: two posts that arrive together used to read the
  // same 59, both pass, and both store. That is how a stolen token gets past 60 an hour. The barrier below holds both
  // readers at the point a read-then-write would have them, which is exactly what an overlap looks like — and it never
  // fires once the check and the increment are one statement.
  const raceToken = `tok_${'e'.repeat(40)}`;
  execFileSync('sqlite3', [dbFile, `INSERT INTO support_tokens (label, sha, added) VALUES ('Race bot', '${shaOf(raceToken)}', ${Date.now()})`]);
  const raceKey = `tok:${shaOf(raceToken).slice(0, 16)}`;
  const hour = Math.floor(Date.now() / 1000) + 3600;
  execFileSync('sqlite3', [dbFile, `INSERT OR REPLACE INTO limits (k, n, until) VALUES ('${raceKey}', 59, ${hour})`]);
  let held = null;
  const together = {
    ...DB,
    prepare: (sql) => {
      const base = DB.prepare(sql);
      if (!/SELECT n, until FROM limits WHERE k/.test(sql)) return base;
      return { bind: (key) => ({ first: async () => {
        const value = await base.bind(key).first();
        if (!held) {
          held = {};
          // A safety valve: one reader alone must not hang the run, and one reader alone is already atomic.
          const timer = setTimeout(() => { const h = held; held = null; h.finish?.(); }, 2000);
          await new Promise((finish) => { held.finish = () => { clearTimeout(timer); finish(); }; });
        } else {
          held.finish();
          held = null;
        }
        return value;
      } }) };
    },
  };
  const before = count('SELECT COUNT(*) AS n FROM support_reports');
  const race = await Promise.all([
    worker.fetch(post('/v1/support', good(), { authorization: `Bearer ${raceToken}` }), env({ DB: together })),
    worker.fetch(post('/v1/support', good(), { authorization: `Bearer ${raceToken}` }), env({ DB: together })),
  ]);
  assert.equal(race.filter((r) => r.status === 201).length, 1, 'of two overlapping posts at the cap, exactly one is stored');
  assert.equal(race.filter((r) => r.status === 429).length, 1, 'and the other is refused');
  assert.equal(count('SELECT COUNT(*) AS n FROM support_reports'), before + 1, 'so exactly one row was written');
  assert.equal(query(`SELECT n FROM limits WHERE k = '${raceKey}'`)[0].n, 60, 'and the counter stops at the cap');

  // 9c. A window that has run out starts again at one, without the cap ever being bypassed.
  execFileSync('sqlite3', [dbFile, `UPDATE limits SET n = 60, until = ${Math.floor(Date.now() / 1000) - 10} WHERE k = '${raceKey}'`]);
  assert.equal(await status(post('/v1/support', good(), { authorization: `Bearer ${raceToken}` })), 201, 'an expired hour allows the next report');
  assert.equal(query(`SELECT n FROM limits WHERE k = '${raceKey}'`)[0].n, 1, 'and the window starts again at one');

  console.log('support endpoint: all checks passed\n');
  console.log([
    'checked, against the real Worker and a real SQLite database built from inbox/schema.sql:',
    '  · a health report with no salt, a salt under 16 characters or no database is refused before anything is written',
    '  · no token, a wrong token and a revoked token are all refused, and store nothing',
    '  · an approved token stores the report, labelled with the approved poster it belongs to',
    '  · a bad priority, a made-up area, a made-up kind and a missing title are refused',
    '  · an email, a home folder, a tilde path, a Mac name, a bidi override and a zero-width character are stripped before the report is stored',
    '  · an oversized or non-JSON body is refused, and a text/plain body is refused',
    '  · there is no GET for a support report — reading stays behind the owner\'s Cloudflare login',
    '  · the open-issue title list is served, with no report data in it',
    '  · a recording is refused without an approved token, refused if it is not video or over 50 MB, and can never be read back',
    '  · a filed report\'s recording is deleted by the sweep',
    '  · another approved token cannot replace a report\'s recording, even with the same label',
    '  · a Worker deployed before the schema still runs the health-report cleanup instead of throwing',
    '  · a title carrying shell syntax is refused at the door',
    '  · the public title list sits behind Cloudflare\'s limiter',
    '  · nothing is stored when Cloudflare\'s own limiter refuses the request',
    '  · two posts that overlap at the per-token cap store one report, not two, and the counter stops at the cap',
    '  · an hour that has run out starts the counter again at one',
    '',
  ].join('\n'));
} finally {
  rmSync(box, { recursive: true, force: true });
}
