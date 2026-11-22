// Test the inbox's support endpoint (inbox/worker.js) locally: the real Worker code against a real SQLite database
// built from inbox/schema.sql, driven through env.DB the way Cloudflare's D1 would. No Cloudflare account, no wrangler,
// no network and no deploy.
// Usage: node tools/test-inbox.mjs
// Proves: a report with no token, a wrong token or a revoked token is refused; an approved token stores the report with
// its label; a bad priority, a bad area or a missing title is refused; an oversized body is refused; and there is no way
// to read a support report back over the web. For private invites (#137) it proves the check never names a label or a
// token, a claim mints exactly one working token, and every miss (replay, expiry, revoke, wrong install id) is one
// identical 404.
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
  prepare: (sql) => {
    // A bound statement remembers its own SQL and values so batch() below can run it, the way D1's PreparedStatement
    // does. D1's batch is one transaction; the claim depends on that, so this shim must offer it too.
    const bound = (args) => ({
      sql, args,
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
    });
    return {
      bind: (...args) => bound(args),
      first: async () => query(sql)[0] ?? null,
      all: async () => ({ results: query(sql) }),
      run: async () => {
        const out = execFileSync('sqlite3', [dbFile, `${sql};\nSELECT changes();`], { encoding: 'utf8' }).trim();
        return { meta: { changes: Number(out.split('\n').pop()) || 0 } };
      },
    };
  },
  // One sqlite3 invocation, one transaction: a failed statement rolls the other back, as D1 does. Each statement's
  // changes() is reported in order, because a claim only counts when both statements changed exactly one row.
  batch: async (stmts) => {
    const text = ['BEGIN;', ...stmts.flatMap((s) => [`${subs(s.sql, s.args || [])};`, 'SELECT changes();']), 'COMMIT;'].join('\n');
    const out = execFileSync('sqlite3', ['-bail', dbFile, text], { encoding: 'utf8' }).trim();
    const numbers = out.split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
    return stmts.map((_, i) => ({ meta: { changes: numbers[i] ?? 0 } }));
  },
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

  // 3d. The inbox and the bot clean with one function, so a rule cannot be missing here while it exists there. A home
  // folder is a home folder when it is quoted or names the account after the tilde; a token split by an invisible
  // character is still a token whatever the character is; and the shapes a person pastes by accident — GitHub, AWS,
  // Slack, a JWT, a private key, a phone number — go too.
  const { clean } = await import(join(root, 'support/bot/skills/tess-support/scripts/privacy.mjs'));
  const nastyText = [
    'it stopped at "~/.ssh/id_rsa"', "and '~bob/notes'", 'path=~alice/x', '"/Users/alice/secret"',
    '/users/alice/other', '/var/folders/ab/xy/T/alice', '~bob alone',
    `123456789:\u180e${'Q'.repeat(35)}`, 'sam.whitfield\u180e@example.com',
    `ghp_${'a'.repeat(36)}`, `sk-${'b'.repeat(32)}`, 'AKIA' + 'C'.repeat(16), 'xoxb-1234567890-abcdefghij',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    `tess_${'D'.repeat(64)}`, 'call +1 415 555 0134', 'open file:///Users/carol/Music/a.mp3', 'or 415.555.0199',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
  ].join(' ');
  const deepRes = await worker.fetch(post('/v1/support', good({ title: 'Lyrics drift, second look', words: nastyText, body: nastyText }), { authorization: `Bearer ${token}` }), env());
  assert.equal(deepRes.status, 201, 'a report carrying all of it is still taken');
  const [deep] = query(`SELECT * FROM support_reports WHERE id = ${(await deepRes.json()).id}`);
  assert.equal(deep.words, clean(nastyText), 'what is stored is exactly what the shared rules make of it');
  for (const [what, re] of [
    ['a quoted tilde path', /id_rsa/],
    ['a `~user` path', /bob/],
    ['a home path after an `=`', /alice/],
    ['a quoted absolute home path', /alice/],
    ['a lowercase home folder', /\/users/],
    ['a temp folder that names the account', /alice/],
    ['a token split by an invisible character', /Q{10}/],
    ['an email split by one', /sam\.whitfield|example\.com/],
    ['a GitHub token', /ghp_/],
    ['an `sk-` key', /sk-b/],
    ['an AWS key', /AKIA/],
    ['a Slack token', /xoxb-/],
    ['a JSON Web Token', /eyJhbGciOiJ/],
    ['an uppercase `tess_` token', /tess_D/],
    ['a phone number', /415 555/],
    ['a `file:///` home path', /carol/],
    ['a dotted phone number', /555\.0199/],
    ['a private key', /OPENSSH PRIVATE KEY/],
    ['the invisible character itself', /[\u180e\u034f\ufe0e\u206a]/],
  ]) {
    assert.ok(!re.test([deep.title, deep.words, deep.body].join('\n')), `${what} does not reach the stored report`);
  }
  assert.match(deep.words, /\(token\)/);
  assert.match(deep.words, /\(number\)/);
  assert.equal(clean('Tess 0.2.32 on Spotify 1.2.52.442'), 'Tess 0.2.32 on Spotify 1.2.52.442', 'versions are kept');
  assert.match(deep.words, /\(private|\(token\)/);

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
  assert.equal(await status(rec(bytes, { authorization: `Bearer ${token}`, 'content-type': 'application/pdf' })), 415, 'a file that is neither a video nor a still is refused');
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

  // 7a. A still travels on the same route, in its own object, and does not replace the video.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const still = (body, headers = {}) => new Request(`https://inbox.test/v1/support/recording/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'content-length': String(body.length), authorization: `Bearer ${token}`, ...headers },
    body,
  });
  assert.equal(await status(still(png)), 204, 'a png still is stored');
  assert.equal(query(`SELECT image FROM support_reports WHERE id = ${id}`)[0].image, `support/${id}.png`, 'the report records the still');
  assert.equal(query(`SELECT recording FROM support_reports WHERE id = ${id}`)[0].recording, `support/${id}.mov`, 'the video is still recorded');
  assert.ok(bucket.has(`support/${id}.png`) && bucket.has(`support/${id}.mov`), 'both objects are in the bucket');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(await status(still(jpeg, { 'content-type': 'image/jpeg' })), 204, 'a jpeg still is stored');
  assert.equal(query(`SELECT image FROM support_reports WHERE id = ${id}`)[0].image, `support/${id}.jpg`, 'jpeg is stored as jpg');
  assert.ok(!bucket.has(`support/${id}.png`), 'the previous still is replaced');
  assert.ok(bucket.has(`support/${id}.mov`), 'replacing the still leaves the video');
  const six = Buffer.alloc(6 * 1024 * 1024);
  assert.equal(await status(still(six)), 413, 'a still over 5 MB is refused');
  assert.equal(await status(still(six, { 'content-length': '100' })), 413, 'a 6 MB still behind a 100-byte header is refused');
  assert.equal(query(`SELECT image FROM support_reports WHERE id = ${id}`)[0].image, `support/${id}.jpg`, 'a refused still does not replace the stored one');
  assert.equal(await status(still(png, { authorization: `Bearer ${other}` })), 403, 'a different token cannot attach a still either');
  const recKey = `rec:${shaOf(token).slice(0, 16)}`;
  execFileSync('sqlite3', [dbFile, `UPDATE limits SET n = 10 WHERE k = '${recKey}'`]);
  assert.equal(await status(still(png)), 429, 'a still counts against the same per-token upload budget as a video');
  execFileSync('sqlite3', [dbFile, `UPDATE limits SET n = 1 WHERE k = '${recKey}'`]);

  // 7c. The 50 MB cap is measured on the bytes that arrive, not on the number the request claims. A posting token that
  // says "100 bytes" and then sends 51 MB used to fill the bucket; now it is cut off at the cap.
  const bigRes = await worker.fetch(post('/v1/support', good({ title: 'Lyrics drift and a long recording' }), { authorization: `Bearer ${token}` }), env());
  const bigId = (await bigRes.json()).id;
  const recTo = (body, headers) => new Request(`https://inbox.test/v1/support/recording/${bigId}`, {
    method: 'PUT',
    headers: { 'content-type': 'video/quicktime', authorization: `Bearer ${token}`, ...headers },
    body,
  });
  assert.equal(await status(recTo(Buffer.alloc(51 * 1024 * 1024, 7), { 'content-length': '100' })), 413,
    'a recording of 51 MB behind a 100-byte header is refused');
  assert.ok(!bucket.has(`support/${bigId}.mov`), 'and none of it reaches the bucket');
  assert.equal(query(`SELECT recording FROM support_reports WHERE id = ${bigId}`)[0].recording, null, 'nor the row');
  assert.equal(await status(recTo(Buffer.from('not really a video'), { 'content-length': '1' })), 204,
    'a body that is honestly small is stored, whatever its header says');

  // 8. The sweep deletes a recording once the report is filed — the person's screen is not kept.
  execFileSync('sqlite3', [dbFile, `UPDATE support_reports SET issue = 'https://github.com/Flame119052/tess-music/issues/91', filed_at = ${Date.now()} WHERE id = ${id}`]);
  await worker.scheduled({}, env());
  assert.ok(!bucket.has(`support/${id}.mov`), 'a filed report\'s recording is deleted');
  assert.ok(!bucket.has(`support/${id}.jpg`), 'a filed report\'s still is deleted');
  assert.equal(query(`SELECT recording FROM support_reports WHERE id = ${id}`)[0].recording, null, 'and the row stops pointing at it');
  assert.equal(query(`SELECT image FROM support_reports WHERE id = ${id}`)[0].image, null, 'and it stops pointing at the still');

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

  // 8d. A database that has recordings but no image column still drops the recording. The missing column must not
  // abort the sweep that was already there.
  const mid = join(box, 'no-image.db');
  execFileSync('sqlite3', [mid, `CREATE TABLE reports (id INTEGER PRIMARY KEY, at INTEGER); CREATE TABLE limits (k TEXT PRIMARY KEY, n INTEGER, until INTEGER); CREATE TABLE support_reports (id INTEGER PRIMARY KEY, at INTEGER, issue TEXT, recording TEXT); INSERT INTO support_reports (id, at, issue, recording) VALUES (1, ${Date.now()}, 'https://github.com/Flame119052/tess-music/issues/91', 'support/1.mov');`]);
  const midQuery = (sql) => { const t = execFileSync('sqlite3', ['-json', mid, sql], { encoding: 'utf8' }).trim(); return t ? JSON.parse(t) : []; };
  const midDB = {
    prepare: (sql) => ({
      bind: (...a) => ({
        first: async () => midQuery(subs(sql, a))[0] ?? null,
        all: async () => ({ results: midQuery(subs(sql, a)) }),
        run: async () => { execFileSync('sqlite3', [mid, subs(sql, a)]); return { meta: {} }; },
      }),
      first: async () => midQuery(sql)[0] ?? null,
      all: async () => ({ results: midQuery(sql) }),
      run: async () => { execFileSync('sqlite3', [mid, sql]); return { meta: {} }; },
    }),
  };
  const midBucket = new Map([['support/1.mov', Buffer.from('mov')]]);
  await worker.scheduled({}, {
    DB: midDB, SALT: 'x', LIMIT: { limit: async () => ({ success: true }) }, RESCUE: { get: async () => null },
    SUPPORT: { delete: async (key) => { midBucket.delete(key); } },
  });
  assert.ok(!midBucket.has('support/1.mov'), 'a recording is still deleted when the image column is missing');
  assert.equal(midQuery('SELECT recording FROM support_reports WHERE id = 1')[0].recording, null, 'and the row is cleared');

  // 8e. A still on that same shape of database is refused before anything is stored. The missing column
  // must not leave an orphaned object in the bucket.
  const bare = join(box, 'still-no-image.db');
  execFileSync('sqlite3', [bare, `CREATE TABLE limits (k TEXT PRIMARY KEY, n INTEGER, until INTEGER); CREATE TABLE support_tokens (id INTEGER PRIMARY KEY, label TEXT, sha TEXT, added INTEGER, revoked INTEGER); CREATE TABLE support_reports (id INTEGER PRIMARY KEY, at INTEGER, issue TEXT, recording TEXT, token_id INTEGER); INSERT INTO support_tokens (id, label, sha, added) VALUES (1, 'Krish bot', '${shaOf(token)}', ${Date.now()}); INSERT INTO support_reports (id, at, recording, token_id) VALUES (4, ${Date.now()}, NULL, 1);`]);
  const bareQuery = (sql) => { const t = execFileSync('sqlite3', ['-json', bare, sql], { encoding: 'utf8' }).trim(); return t ? JSON.parse(t) : []; };
  const bareDB = {
    prepare: (sql) => ({
      bind: (...a) => ({
        first: async () => bareQuery(subs(sql, a))[0] ?? null,
        all: async () => ({ results: bareQuery(subs(sql, a)) }),
        run: async () => {
          const out = execFileSync('sqlite3', [bare, `${subs(sql, a)};\nSELECT changes(), last_insert_rowid();`], { encoding: 'utf8' }).trim();
          const [changes, last] = out.split('\n').pop().split('|');
          return { meta: { changes: Number(changes) || 0, last_row_id: Number(last) || 0 } };
        },
      }),
      first: async () => bareQuery(sql)[0] ?? null,
      all: async () => ({ results: bareQuery(sql) }),
      run: async () => { execFileSync('sqlite3', [bare, sql]); return { meta: {} }; },
    }),
  };
  const bareBucket = new Map();
  const bareEnv = {
    DB: bareDB, SALT: 'x', LIMIT: { limit: async () => ({ success: true }) }, RESCUE: { get: async () => null },
    SUPPORT: {
      put: async (key, body) => { bareBucket.set(key, body); },
      delete: async (key) => { bareBucket.delete(key); },
    },
  };
  const bareStill = new Request('https://inbox.test/v1/support/recording/4', {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'content-length': String(png.length), authorization: `Bearer ${token}` },
    body: png,
  });
  assert.equal((await worker.fetch(bareStill, bareEnv)).status, 503, 'a still is refused when the image column is missing');
  assert.equal(bareBucket.size, 0, 'the refused still was still written to R2');

  // 8f. An unfiled still older than 14 days is deleted even though the report itself is kept for 30.
  const agedAt = Date.now() - 15 * 86400 * 1000;
  execFileSync('sqlite3', [dbFile, `INSERT INTO support_reports (at, priority, areas, kind, title, image) VALUES (${agedAt}, 'P2', 'area: theme', 'bug', 'An old still nobody filed', 'support/aged-still.png')`]);
  bucket.set('support/aged-still.png', Buffer.from('old-still'));
  await worker.scheduled({}, env());
  assert.ok(!bucket.has('support/aged-still.png'), 'a 15-day-old unfiled still is deleted');
  assert.equal(query(`SELECT image FROM support_reports WHERE title = 'An old still nobody filed'`)[0].image, null, 'and the row stops pointing at it');

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

  // 10. A private Tess Support invite (#137). The Mac is named only by its 32-hex install id, the database holds only
  // its SHA-256, the check never names a label or a token, and the claim mints one token and then refuses every
  // replay, expiry, revoke and wrong install id with the same answer.
  const invitedInstall = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const invitation = (over = {}) => ({ install: invitedInstall, label: 'Krish Mac', expires: Date.now() + 3600 * 1000, claimed: null, revoked: null, ...over });
  const inviteResponse = (path, body, e = env()) => worker.fetch(post(`/v1/support/invite/${path}`, body), e);
  const tokens = () => count('SELECT COUNT(*) AS n FROM support_tokens');
  const newInvite = (over = {}) => {
    const row = invitation(over);
    execFileSync('sqlite3', [dbFile, `INSERT INTO support_invites (created_at, expires_at, install_hash, label, claimed_at, revoked_at) VALUES (${Date.now()}, ${row.expires}, '${shaOf(row.install)}', '${row.label}', ${row.claimed}, ${row.revoked})`]);
    return query('SELECT MAX(id) AS id FROM support_invites')[0].id;
  };
  const inviteRow = (id) => query(`SELECT * FROM support_invites WHERE id = ${id}`)[0];

  // 10a. No invite: a plain no, and nothing else. A Mac that was never invited cannot tell Tess Support exists.
  const uninvited = await inviteResponse('check', { install: invitedInstall });
  assert.equal(uninvited.status, 200, 'the invite check answers a Mac that was not invited');
  assert.equal(uninvited.headers.get('cache-control'), 'no-store', 'and the answer is never cached');
  assert.deepEqual(await uninvited.json(), { invited: false }, 'with a plain no and no other field');

  // 10b. Only a real install id is worth a database read: an uppercase one, a short one, an empty one or a number is
  // refused before it can be hashed.
  for (const install of ['A'.repeat(32), 'z'.repeat(32), invitedInstall.slice(1), `${invitedInstall}0`, '', 123, null]) {
    assert.equal((await inviteResponse('check', { install })).status, 400, `a check with ${JSON.stringify(install)} is refused`);
    assert.equal((await inviteResponse('claim', { install, invite_id: 1 })).status, 400, `a claim with ${JSON.stringify(install)} is refused`);
  }

  // 10c. Both routes sit behind Cloudflare's limiter, and a refused connection cannot learn anything or mint a token.
  const deniedInvite = env({ LIMIT: { limit: async () => ({ success: false }) } });
  assert.equal((await inviteResponse('check', { install: invitedInstall }, deniedInvite)).status, 429, 'a rate-limited check is refused');
  assert.equal((await inviteResponse('claim', { install: invitedInstall, invite_id: 1 }, deniedInvite)).status, 429, 'a rate-limited claim is refused');

  // 10d. Same shape rules as every other write route.
  assert.equal((await worker.fetch(post('/v1/support/invite/check', { install: invitedInstall }, { 'content-type': 'text/plain' }), env())).status, 415, 'a check that is not JSON is refused');
  assert.equal((await inviteResponse('check', 'not json')).status, 400, 'a check body that does not parse is refused');
  const oversizedInvite = new Request('https://inbox.test/v1/support/invite/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '40' },
    body: JSON.stringify({ install: invitedInstall, pad: 'x'.repeat(4096) }),
  });
  assert.equal((await worker.fetch(oversizedInvite, env())).status, 413, 'a body that lies about its length is cut off and refused');

  // 10e. Invited: a yes and the invite id, and nothing that names the person or holds a token.
  const firstInvite = newInvite();
  const yesRes = await inviteResponse('check', { install: invitedInstall });
  assert.equal(yesRes.status, 200);
  const yes = await yesRes.json();
  assert.deepEqual(yes, { invited: true, invite_id: firstInvite }, 'an invited Mac is told yes and which invite');
  assert.ok(!JSON.stringify(yes).includes('Krish Mac'), 'the invite check never returns the label');
  assert.ok(!JSON.stringify(yes).includes('tess_'), 'and it never returns a token');

  // 10f. A claim from any other Mac is refused, and the invite stays open for the Mac it was made for.
  const wrongInstall = await inviteResponse('claim', { install: 'f'.repeat(32), invite_id: firstInvite });
  assert.equal(wrongInstall.status, 404, 'a claim with the wrong install id is refused');
  assert.equal((await wrongInstall.json()).error, 'not found', 'and says nothing about why');
  assert.equal(inviteRow(firstInvite).claimed_at, null, 'the invite is still open');

  // 10g. The invite id is a positive integer, not a string, a float or a zero.
  for (const invite_id of [0, -1, '2', 1.5, null]) {
    assert.equal((await inviteResponse('claim', { install: invitedInstall, invite_id })).status, 400, `a claim with invite_id ${JSON.stringify(invite_id)} is refused`);
  }

  // 10h. The claim mints one token, stores only its SHA-256, and marks the invite claimed.
  const tokensBefore = tokens();
  const claimed = await inviteResponse('claim', { install: invitedInstall, invite_id: firstInvite });
  assert.equal(claimed.status, 200, 'the invited Mac claims its invite');
  assert.equal(claimed.headers.get('cache-control'), 'no-store', 'the token is never cached');
  const claimedBody = await claimed.json();
  const minted = claimedBody.token;
  assert.match(minted, /^tess_[0-9a-f]{64}$/, 'the claim answers with a tess_ token');
  assert.deepEqual(Object.keys(claimedBody), ['token'], 'and with nothing else');
  assert.equal(tokens(), tokensBefore + 1, 'exactly one token row was written');
  const [tokenRow] = query(`SELECT * FROM support_tokens WHERE sha = '${shaOf(minted)}'`);
  assert.equal(tokenRow.label, 'Krish Mac', 'the token carries the invite label');
  assert.equal(tokenRow.revoked, null, 'and starts active');
  const claimedInvite = inviteRow(firstInvite);
  assert.ok(Number.isInteger(claimedInvite.claimed_at), 'the invite records when it was claimed');
  assert.equal(claimedInvite.token_id, tokenRow.id, 'and which token it minted');

  // 10i. That token is a real one: it posts a support report and is refused nowhere along the way.
  const withToken = await worker.fetch(post('/v1/support', good({ title: 'Invited Mac posts a report' }), { authorization: `Bearer ${minted}` }), env());
  assert.equal(withToken.status, 201, 'the claimed token can post a support report');

  // 10j. Replay is refused with the same answer as every other miss, and mints no second token.
  const replay = await inviteResponse('claim', { install: invitedInstall, invite_id: firstInvite });
  assert.equal(replay.status, 404, 'claiming the same invite twice is refused');
  const replayBody = await replay.text();
  assert.equal(tokens(), tokensBefore + 1, 'a replay mints no token');
  assert.deepEqual(await (await inviteResponse('check', { install: invitedInstall })).json(), { invited: false }, 'and the check stops inviting that Mac');

  // 10k. Expired, revoked, wrong install and replay all answer byte for byte the same, so the route is no oracle.
  const expiredId = newInvite({ expires: Date.now() - 1000 });
  const revokedId = newInvite({ revoked: Date.now() });
  const answers = await Promise.all([
    inviteResponse('claim', { install: invitedInstall, invite_id: expiredId }),
    inviteResponse('claim', { install: invitedInstall, invite_id: revokedId }),
    inviteResponse('claim', { install: 'f'.repeat(32), invite_id: firstInvite + 0 }),
  ]);
  const expiredRes = answers[0];
  assert.equal(expiredRes.status, 404, 'an expired invite is refused');
  assert.equal(answers[1].status, 404, 'a revoked invite is refused');
  assert.equal(answers[2].status, 404, 'a wrong install id is refused');
  assert.deepEqual(await Promise.all(answers.map((r) => r.text())), [replayBody, replayBody, replayBody], 'every miss looks exactly like a replay');
  assert.equal(tokens(), tokensBefore + 1, 'none of them minted a token');
  assert.equal(inviteRow(expiredId).claimed_at, null, 'the expired invite was not marked claimed');
  assert.equal(inviteRow(revokedId).claimed_at, null, 'and the revoked one was not either');

  // 10l. There is no way to read an invite or a token back over the web, and the routes are POST only.
  for (const p of ['/v1/support/invite/check', '/v1/support/invite/claim', '/v1/support/invites']) {
    assert.equal((await worker.fetch(new Request(`https://inbox.test${p}`, { method: 'GET' }), env())).status, 404, `GET ${p} does not exist`);
  }

  // 10m. A Worker deployed before the table exists fails closed (503), and the health inbox is unaffected.
  assert.equal((await worker.fetch(post('/v1/support/invite/check', { install: invitedInstall }), { ...env(), DB: oldDBs })).status, 503, 'the check fails closed on a database without the invite table');
  assert.equal((await worker.fetch(post('/v1/support/invite/claim', { install: invitedInstall, invite_id: 1 }), { ...env(), DB: oldDBs })).status, 503, 'and so does the claim');
  assert.equal((await worker.fetch(post('/v1/support/invite/check', { install: invitedInstall }), { ...env(), DB: undefined })).status, 503, 'and with no database at all');

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
    '  · a recording is refused without an approved token, refused if it is not video or a still or over 50 MB, and can never be read back',
    '  · a png or jpeg still is stored beside the video, refused over 5 MB, and deleted with the recording when the report is filed',
    '  · the 50 MB cap is measured on the bytes that arrive: 51 MB behind a 100-byte header is cut off and not stored',
    '  · a filed report\'s recording is deleted by the sweep',
    '  · another approved token cannot replace a report\'s recording, even with the same label',
    '  · a Worker deployed before the schema still runs the health-report cleanup instead of throwing',
    '  · a title carrying shell syntax is refused at the door',
    '  · the public title list sits behind Cloudflare\'s limiter',
    '  · nothing is stored when Cloudflare\'s own limiter refuses the request',
    '  · two posts that overlap at the per-token cap store one report, not two, and the counter stops at the cap',
    '  · an hour that has run out starts the counter again at one',
    '  · an uninvited Mac gets a plain {"invited":false}, and a malformed install id is refused',
    '  · an invited Mac gets {"invited":true,"invite_id":N} and never the label or a token',
    '  · a claim stores only the SHA-256 of one minted token, and that token posts a real report',
    '  · a replay, an expired invite, a revoked invite and a wrong install id answer byte for byte the same 404',
    '  · no invite or token can be read back over the web, and a missing table fails closed',
    '',
  ].join('\n'));
} finally {
  rmSync(box, { recursive: true, force: true });
}
