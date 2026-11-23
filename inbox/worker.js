// Tess inbox: Macs send health reports here, and it serves the signed rescue order as one more mirror plus a public
// wake serial, so a Mac can notice a new order within a minute instead of waiting for its 6-hour check.
// Security model:
//  - Anyone can POST a report (a public installer can't hold a secret), so a report is only ever stored data: never
//    shown on a page, never run, never trusted. Strict size, shape and rate limits stop flooding.
//  - Nothing can be read back over the web. Reports are read only with the owner's Cloudflare login (tools/reports.mjs).
//  - The rescue order is written only with the owner's Cloudflare login, and Macs run it only if it carries the
//    offline rescue key's signature, so even someone who took over this Worker could not make a Mac run anything.
// Cost: everything here stays inside Cloudflare's free allowances even under a flood. Requests over the per-IP limit
// are refused by Cloudflare's rate limiter before any database work; past the daily total only one row is read per
// request; at most DAILY_CAP reports are stored a day (~6 rows written each), kept 30 days, 24 KB each at most.
import { clean as cleanText, stripInvisible } from '../support/bot/skills/tess-support/scripts/privacy.mjs';

const MAX_BODY = 32 * 1024;
// A support report carries the person's words, the bot's diagnosis and the finished write-up, so it is allowed more
// room than a health report while still being bounded.
const MAX_SUPPORT = 48 * 1024;
// A recording of the Spotify window, and a still of that same window. Telegram caps an upload at 20 MB, so the
// video cap is generous; it exists so a stray 500 MB file can't land in R2. A still is smaller.
const MAX_RECORDING = 50 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
// An invite request is one install id and one number. Anything larger is not this route.
const MAX_INVITE = 2 * 1024;
const RECORDING_DAYS = 14;
const DAILY_CAP = 2000;
// One allowlisted upstream and one model. The client chooses neither: `SUPPORT_UPSTREAM` picks between the two
// OpenCode URLs below and `SUPPORT_MODEL` names the model, both set in wrangler. Any other upstream value fails
// closed. The OpenCode key is a secret, never a var.
const CHAT_UPSTREAMS = {
  zen: 'https://opencode.ai/zen/v1/chat/completions',
  go: 'https://opencode.ai/zen/go/v1/chat/completions',
};
const CHAT_MODEL = 'deepseek-v4.1-flash';
const CHAT_PERSON_REQUESTS = 200;
const CHAT_SHARED_REQUESTS = 600;
const CHAT_PERSON_TOKENS = 1000000;
const CHAT_SHARED_TOKENS = 3000000;
const CHAT_MAX_REQUEST = 8 * 1024 * 1024;
const CHAT_MAX_RESPONSE = 8 * 1024 * 1024;
// A single reply cannot move the token counters by more than this. A larger `usage` is ignored, not written as zero.
const CHAT_MAX_USAGE = 2000000;
// One completion per request. A client that asks for more output than this is clamped, and a withheld or
// disconnected reply with no usage frame is billed this many tokens when the client did not name a smaller cap.
const CHAT_MAX_COMPLETION = 8192;
// Inline images stay. A data URL longer than this, or any image that points at a remote URL, is refused.
const CHAT_MAX_DATA_URL = 4 * 1024 * 1024;
const KINDS = new Set(['heartbeat', 'problem', 'doctor', 'rescue', 'install']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const AREAS = new Set(['area: theme', 'area: patcher', 'area: installer', 'area: mini', 'area: companion', 'area: release-ci', 'area: docs']);
const ISSUE_KINDS = new Set(['bug', 'enhancement', 'design', 'security', 'testing', 'documentation', 'spec']);
// The stored per-IP keys are useless without the salt: an unsalted SHA-256 of an IPv4 address is brute-forceable in
// minutes, so a Worker with no usable secret refuses reports instead of weakening that promise.
const MIN_SALT = 16;
// Nothing every terminal would hide from the person reading a report is stored, and nothing that identifies them: the
// rules are the bot's own, imported from `privacy.mjs` rather than copied, because a copy drifts and the side a rule is
// missing from is the side a stranger uses. The bot can post here without triage ever seeing the text, so this is the
// last gate before a person's words are stored and later filed as a public issue.

// Cut by bytes, not characters: 24K characters of 4-byte characters is 96 KB in the database.
const utf8 = (s) => new TextEncoder().encode(s);
const cut = (s, n) => { const b = utf8(s); return b.length <= n ? s : new TextDecoder().decode(b.slice(0, n)); };
const clean = (v) => cleanText(String(v));
const short = (v, n) => (typeof v === 'string' ? cut(clean(v), n) : null);
// A health report was already filtered on the Mac by installer/redact.sh, and its status and body are machine lines whose
// numbers matter: epoch seconds, byte counts, rescue serials. The phone rule would turn each of those into "(number)", so
// a health report only loses what a terminal would hide. A person's own words (a support report) get the full clean.
const shortHealth = (v, n) => (typeof v === 'string' ? cut(stripInvisible(v), n) : null);

// One statement, not a read and then a write: two requests that arrive together both used to see the same count, both
// pass, and the counter finished one past the cap. The increment is the check here — a row is only touched while its
// window is over or its count is under the cap — and the number of rows D1 says it changed is what decides, so no
// request can spend a count another one already spent.
async function hit(env, key, max, seconds) {
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    `INSERT INTO limits (k, n, until) VALUES (?, 1, ?)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN limits.until <= ? THEN 1 ELSE limits.n + 1 END,
       until = CASE WHEN limits.until <= ? THEN ? ELSE limits.until END
     WHERE limits.until <= ? OR limits.n < ?`,
  ).bind(key, now + seconds, now, now, now + seconds, now, max).run();
  const changes = res?.meta?.changes;
  if (typeof changes === 'number') return changes > 0;
  // A runtime that does not report how many rows changed falls back to reading the row this statement just wrote. The
  // decision has already been made once, atomically, so the worst this costs is an extra read.
  const row = await env.DB.prepare('SELECT n FROM limits WHERE k = ?').bind(key).first();
  return !!row && row.n <= max;
}

// Give back one count from a hit() that must not stand. Used when the shared cap refuses after the person's slot
// was already taken, so a full shared pool does not burn the person's daily requests.
async function unhit(env, key) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE limits SET n = n - 1 WHERE k = ? AND n > 0 AND until > ?').bind(key, now).run();
}

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// A support token is the one thing here that is a secret, so it is stored as its full SHA-256 and never written to a
// log or a response.
async function shaFull(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 204 carries no body at all — passing an empty string throws in any spec-compliant runtime, so the health-report path
// was one deploy away from failing on every report it stored.
const reply = (status, text = '') => new Response(status === 204 || status === 304 ? null : text,
  { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

// A Content-Length is a claim, not a measurement: a client can send a hundred bytes of header and a gigabyte of body.
// The bytes are counted as they arrive and the request is cut off at the cap, so nothing past it is buffered or stored.
// Returns null when the body went past the cap; the caller answers 413 and never sees the bytes.
async function readCapped(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      try { await reader.cancel(); } catch { /* the client may already be gone */ }
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  return bytes;
}

async function report(request, env) {
  // Fail closed, before anything else: with no salt or no database there is no safe place to put a report, so none is
  // taken. A health report is the one request here that writes a hash of a person's IP, and that hash is only useless
  // to an attacker while the salt is long and secret.
  if (typeof env.SALT !== 'string' || env.SALT.length < MIN_SALT) return reply(503);
  if (!env.DB) return reply(503);
  if (request.headers.get('content-type') !== 'application/json') return reply(415);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_BODY) return reply(413);
  const { success } = await env.LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || '' });
  if (!success) return reply(429);
  const day = await env.DB.prepare('SELECT n, until FROM limits WHERE k = ?').bind('all').first();
  if (day && day.until > Date.now() / 1000 && day.n >= DAILY_CAP) return reply(429);
  const bytes = await readCapped(request, MAX_BODY);
  if (!bytes) return reply(413);
  let r;
  try { r = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply(400); }
  if (!r || typeof r !== 'object' || !/^[0-9a-f]{32}$/.test(r.install || '') || !KINDS.has(r.kind)) return reply(400);
  // IPs are never stored: only a salted hash, used for the limit and then thrown away when the window ends
  const ip = await sha(`${env.SALT}|${request.headers.get('cf-connecting-ip') || ''}`);
  if (!(await hit(env, `ip:${ip}`, 30, 3600))) return reply(429);
  if (!(await hit(env, `id:${r.install}`, 60, 86400))) return reply(429);
  if (!(await hit(env, 'all', DAILY_CAP, 86400))) return reply(429);
  await env.DB.prepare('INSERT INTO reports (at, install, kind, tess, spotify, macos, status, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(Date.now(), r.install, r.kind, shortHealth(r.tess, 40), shortHealth(r.spotify, 40), shortHealth(r.macos, 40), shortHealth(r.status, 2000), shortHealth(r.body, 24 * 1024))
    .run();
  return reply(204);
}

// A support report: one approved person's bot hands over everything needed to file an issue, and the owner's side reads
// it later with their Cloudflare login. Nothing is served back — there is deliberately no GET for this path.
//
// Authenticated because, unlike a health report, this carries a person's own words: only a token the owner minted is
// accepted. The token names who it is (its label), so a report can be traced without storing a Telegram id.
async function support(request, env) {
  // Cloudflare's own limiter first, before any database work: a flood of unauthenticated POSTs must not cost a query.
  const { success } = await env.LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || '' });
  if (!success) return reply(429);
  const auth = request.headers.get('authorization') || '';
  const token = /^Bearer (.+)$/i.exec(auth.trim())?.[1] || '';
  if (!token) return reply(401);
  const sha = await shaFull(token);
  let who;
  try {
    who = await env.DB.prepare('SELECT id, label FROM support_tokens WHERE sha = ? AND revoked IS NULL').bind(sha).first();
  } catch { return reply(503); }
  if (!who) return reply(401);
  if (request.headers.get('content-type') !== 'application/json') return reply(415);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_SUPPORT) return reply(413);
  try {
    if (!(await hit(env, `tok:${sha.slice(0, 16)}`, 60, 3600))) return reply(429);
  } catch { return reply(503); }
  const bytes = await readCapped(request, MAX_SUPPORT);
  if (!bytes) return reply(413);
  let r;
  try { r = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply(400); }
  if (!r || typeof r !== 'object') return reply(400);
  if (!PRIORITIES.has(r.priority)) return reply(400);
  if (!ISSUE_KINDS.has(r.kind)) return reply(400);
  const areas = (Array.isArray(r.areas) ? r.areas : String(r.areas || '').split(','))
    .map((a) => String(a).trim().replace(/^area:\s*/, 'area: ')).filter(Boolean);
  if (!areas.length || areas.length > 3 || areas.some((a) => !AREAS.has(a))) return reply(400);
  // Cleaned first, judged second: a zero-width space must not be able to hide `$(` from this check.
  const title = short(r.title, 120);
  if (!title) return reply(400);
  if (/[`]|\$\(/.test(title)) return reply(400);
  const install = /^[0-9a-f]{32}$/.test(r.install || '') ? r.install : null;
  let row;
  try {
    row = await env.DB.prepare(
      'INSERT INTO support_reports (at, person, install, tess, spotify, macos, priority, areas, kind, title, words, diagnosis, body, token_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
    Date.now(), short(who.label, 60), install,
    short(r.tess, 40), short(r.spotify, 40), short(r.macos, 40),
    r.priority, areas.join(', '), r.kind, title,
      short(r.words, 4000), short(r.diagnosis, 2000), short(r.body, 24 * 1024), who.id,
    ).run();
  } catch {
    // Most likely the schema hasn't been applied on this database yet. Say so, rather than leaking a D1 error.
    return reply(503);
  }
  return new Response(JSON.stringify({ ok: true, id: row.meta?.last_row_id ?? null }), {
    status: 201, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Amend a support report that the same token previously filed (PATCH /v1/support/:id).
// Strictly scoped by token_id so a Mac can only update its own unfiled/filed reports, never anyone else's.
async function supportAmend(request, env, id) {
  const { success } = await env.LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || '' });
  if (!success) return reply(429);
  const auth = request.headers.get('authorization') || '';
  const token = /^Bearer (.+)$/i.exec(auth.trim())?.[1] || '';
  if (!token) return reply(401);
  const sha = await shaFull(token);
  let who;
  try {
    who = await env.DB.prepare('SELECT id, label FROM support_tokens WHERE sha = ? AND revoked IS NULL').bind(sha).first();
  } catch { return reply(503); }
  if (!who) return reply(401);
  if (request.headers.get('content-type') !== 'application/json') return reply(415);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_SUPPORT) return reply(413);
  try {
    if (!(await hit(env, `tok:${sha.slice(0, 16)}`, 60, 3600))) return reply(429);
  } catch { return reply(503); }
  const bytes = await readCapped(request, MAX_SUPPORT);
  if (!bytes) return reply(413);
  let r;
  try { r = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply(400); }
  if (!r || typeof r !== 'object') return reply(400);

  let existing;
  try {
    existing = await env.DB.prepare(
      'SELECT id, title, priority, areas, kind, words, diagnosis, body FROM support_reports WHERE id = ? AND token_id = ?',
    ).bind(Number(id), who.id).first();
  } catch { return reply(503); }
  if (!existing) return reply(404);

  const priority = r.priority !== undefined ? (PRIORITIES.has(r.priority) ? r.priority : null) : existing.priority;
  if (!priority) return reply(400);
  const kind = r.kind !== undefined ? (ISSUE_KINDS.has(r.kind) ? r.kind : null) : existing.kind;
  if (!kind) return reply(400);
  let areasText = existing.areas;
  if (r.areas !== undefined) {
    const areas = (Array.isArray(r.areas) ? r.areas : String(r.areas || '').split(','))
      .map((a) => String(a).trim().replace(/^area:\s*/, 'area: ')).filter(Boolean);
    if (!areas.length || areas.length > 3 || areas.some((a) => !AREAS.has(a))) return reply(400);
    areasText = areas.join(', ');
  }
  let title = existing.title;
  if (r.title !== undefined) {
    title = short(r.title, 120);
    if (!title || /[`]|\$\(/.test(title)) return reply(400);
  }
  const diagnosis = r.diagnosis !== undefined ? short(r.diagnosis, 2000) : existing.diagnosis;
  let body = r.body !== undefined ? short(r.body, 24 * 1024) : existing.body;
  if (r.append_note !== undefined) {
    const note = short(r.append_note, 4000);
    if (note) body = short(`${body || ''}\n\n## Follow-up note\n\n${note}`, 24 * 1024);
  }
  try {
    await env.DB.prepare(
      'UPDATE support_reports SET priority = ?, areas = ?, kind = ?, title = ?, diagnosis = ?, body = ? WHERE id = ? AND token_id = ?',
    ).bind(priority, areasText, kind, title, diagnosis, body, Number(id), who.id).run();
  } catch { return reply(503); }
  return new Response(JSON.stringify({ ok: true, id: Number(id) }), {
    status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// --- private Tess Support invites: POST /v1/support/invite/check and /v1/support/invite/claim (#137).
//
// Krish invites one Mac by its 32-hex install id (`node tools/reports.mjs support invite add …`). The database never
// holds that id, only its SHA-256, and never holds a token: the one-time `tess_...` token is minted here at claim time,
// stored hashed in support_tokens, and returned once with `Cache-Control: no-store`.
//
// The check answers yes or no and an id. It does not name the invite's label, so an uninvited Mac (or someone guessing
// install ids) learns nothing. The claim answers the same 404 whether the install id is wrong, the invite expired, it
// was revoked or it was already claimed, so it is not an oracle either.
const INVITE_INSTALL = /^[0-9a-f]{32}$/;

function inviteJson(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Both invite routes share one gate: Cloudflare's limiter first, keyed by a salted hash of the caller when SALT is
// present (the limiter binding does not persist keys), then strict JSON, then a body counted as it arrives so a
// Content-Length cannot lie about its size.
async function inviteGate(request, env) {
  if (!env.DB) return { failed: reply(503) };
  if (!env.LIMIT || typeof env.LIMIT.limit !== 'function') return { failed: reply(503) };
  if (request.headers.get('content-type') !== 'application/json') return { failed: reply(415) };
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_INVITE) return { failed: reply(413) };
  const ip = request.headers.get('cf-connecting-ip') || '';
  const key = typeof env.SALT === 'string' && env.SALT.length >= MIN_SALT ? await shaFull(`${env.SALT}|${ip}`) : ip; // unsalted only when SALT is missing; the limiter binding does not persist keys
  try {
    const { success } = await env.LIMIT.limit({ key });
    if (!success) return { failed: reply(429) };
  } catch { return { failed: reply(503) }; }
  const bytes = await readCapped(request, MAX_INVITE);
  if (!bytes) return { failed: reply(413) };
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { failed: reply(400) }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { failed: reply(400) };
  return { install: body.install, body };
}

async function supportInviteCheck(request, env) {
  const gate = await inviteGate(request, env);
  if (gate.failed) return gate.failed;
  if (typeof gate.install !== 'string' || !INVITE_INSTALL.test(gate.install)) return reply(400);
  let row;
  try {
    row = await env.DB.prepare(
      'SELECT id FROM support_invites WHERE install_hash = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1',
    ).bind(await shaFull(gate.install), Date.now()).first();
  } catch { return reply(503); }
  // Newest pending invite for this Mac: a re-invite does not have to wait for the old one to expire.
  return inviteJson(200, row ? { invited: true, invite_id: row.id } : { invited: false });
}

async function supportInviteClaim(request, env) {
  const gate = await inviteGate(request, env);
  if (gate.failed) return gate.failed;
  if (typeof gate.install !== 'string' || !INVITE_INSTALL.test(gate.install)) return reply(400);
  const id = gate.body.invite_id;
  if (!Number.isSafeInteger(id) || id < 1) return reply(400);
  const installHash = await shaFull(gate.install);
  const raw = `tess_${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const tokenHash = await shaFull(raw);
  const now = Date.now();
  // One window, used by both statements, so the insert and the claim can never disagree about the invite's state.
  const open = 'id = ? AND install_hash = ? AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?';
  let results;
  try {
    // D1 runs a batch as one transaction: the token exists only if it was inserted, and the invite is claimed only if
    // that insert happened and the invite was still open. A crash or a failed statement leaves neither behind.
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO support_tokens (label, sha, added) SELECT label, ?, ? FROM support_invites WHERE ${open}`,
      ).bind(tokenHash, now, id, installHash, now),
      env.DB.prepare(
        `UPDATE support_invites SET claimed_at = ?, token_id = (SELECT id FROM support_tokens WHERE sha = ?)
         WHERE ${open} AND EXISTS (SELECT 1 FROM support_tokens WHERE sha = ?)`,
      ).bind(now, tokenHash, id, installHash, now, tokenHash),
    ]);
  } catch { return reply(503); }
  const took = (r) => r?.meta?.changes === 1;
  if (!Array.isArray(results) || results.length !== 2 || !took(results[0]) || !took(results[1])) {
    if (took(results?.[0])) {
      try { await env.DB.prepare('UPDATE support_tokens SET revoked = ? WHERE sha = ?').bind(now, tokenHash).run(); } catch {}
    }
    return inviteJson(404, { error: 'not found' });
  }
  return inviteJson(200, { token: raw });
}

// The titles of open issues, so a bot can check "is this already known" without a GitHub login. Public on purpose:
// these are public issues already, and no report data is involved. Refreshed by the owner's tooling, never written here.
async function issueTitles(request, env) {
  const { success } = await env.LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || '' });
  if (!success) return reply(429);
  try {
    const rows = await env.DB.prepare('SELECT n, title, updated FROM issue_titles ORDER BY n').all();
    const issues = (rows.results || []).map((r) => ({ n: r.n, title: r.title }));
    return new Response(JSON.stringify({ updated: issues.length ? rows.results[0].updated : null, issues }), {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch { return reply(503); }
}

// A recording or a still of the person's screen must never be public, so either can be written and never
// read back: no GET, and the scheduled job deletes both once the report is filed or after 14 days.
// A still and a video are different objects. Uploading one does not replace the other.
async function recording(request, env, id) {
  const { success } = await env.LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || '' });
  if (!success) return reply(429);
  const auth = request.headers.get('authorization') || '';
  const token = /^Bearer (.+)$/i.exec(auth.trim())?.[1] || '';
  if (!token) return reply(401);
  const sha = await shaFull(token);
  let who, row;
  try {
    who = await env.DB.prepare('SELECT id, label FROM support_tokens WHERE sha = ? AND revoked IS NULL').bind(sha).first();
    if (!/^\d+$/.test(id)) return reply(400);
    row = await env.DB.prepare('SELECT id, recording, issue, token_id FROM support_reports WHERE id = ?').bind(Number(id)).first();
  } catch { return reply(503); }
  if (!who) return reply(401);
  if (!row) return reply(404);
  // Only the token that created this report may attach its recording. Sequential ids are guessable, and a label is not
  // a unique key, so neither is enough on its own.
  if (row.token_id !== who.id) return reply(403);
  // Once the report is an issue, the recording's only job is to be deleted: accepting an upload then would keep a
  // person's screen past the point anyone would look at it.
  if (row.issue) return reply(409);
  // Uploads are heavier than a JSON post, so they get their own, smaller budget per token.
  try {
    if (!(await hit(env, `rec:${sha.slice(0, 16)}`, 10, 3600))) return reply(429);
  } catch { return reply(503); }
  // The header is a cheap refusal for an honest client that is already too big; the body below is the real check.
  const len = Number(request.headers.get('content-length') || 0);
  if (!len) return reply(413);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const image = type === 'image/png' || type === 'image/jpeg';
  const video = /^video\/(mp4|quicktime|x-matroska|webm)$/.test(type);
  if (!image && !video) return reply(415);
  const cap = image ? MAX_IMAGE : MAX_RECORDING;
  if (len > cap) return reply(413);
  const ext = image
    ? (type === 'image/png' ? 'png' : 'jpg')
    : ({ 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv' }[type] || 'mp4');
  const key = `support/${id}.${ext}`;
  let body;
  try { body = await readCapped(request, cap); } catch { return reply(400); }
  if (!body) return reply(413);
  try {
    // The image column is newer than recording. A video upload must keep working on a database that
    // does not have it yet; a still on that database is a 503, not a destroyed video.
    let previous = row.recording;
    if (image) {
      const extra = await env.DB.prepare('SELECT image FROM support_reports WHERE id = ?').bind(Number(id)).first();
      previous = extra?.image || null;
    }
    await env.SUPPORT.put(key, body, { httpMetadata: { contentType: type } });
    // A re-upload with a different extension would otherwise leave the old object orphaned until the lifecycle rule
    // notices; delete it as part of the same write. A still never deletes the video, or the other way around.
    if (previous && previous !== key) await env.SUPPORT.delete(previous);
    if (image) await env.DB.prepare('UPDATE support_reports SET image = ? WHERE id = ?').bind(key, Number(id)).run();
    else await env.DB.prepare('UPDATE support_reports SET recording = ? WHERE id = ?').bind(key, Number(id)).run();
  } catch { return reply(503); }
  return reply(204);
}

// --- support chat: POST /v1/support/chat/completions only.

function chatJson(status, message, type, code, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

// Hermes shows error.message from a refused request, so the person reads this line rather than a bare 401.
// A missing, unknown and revoked token get the same words, so the answer does not say which one it was (D-108).
function chatRefused() {
  return chatJson(401, 'This support code is not active. Ask Krish for a new one.', 'authentication_error', 'invalid_api_key');
}

function secondsUntilUtcMidnight(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

function quotaReached(kind) {
  const resets = secondsUntilUtcMidnight();
  const tokens = kind === 'person_tokens' || kind === 'shared_tokens';
  const message = tokens
    ? "This support chat has reached today's token limit. It resets at 00:00 UTC."
    : "This support chat has reached today's limit. It resets at 00:00 UTC.";
  return new Response(JSON.stringify({
    error: {
      message,
      type: 'usage_limit_reached',
      code: 'terminal_quota_exhausted',
      resets_in_seconds: resets,
      limit_type: kind,
    },
  }), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(resets),
      'x-should-retry': 'false',
    },
  });
}

// A missing or garbage cap var fails closed. An unset var uses the default. Token budget 0 means "do not enforce".
function capValue(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function byteCap(raw, fallback, hard) {
  const n = capValue(raw, fallback);
  if (n === null || n < 1) return null;
  return Math.min(n, hard);
}

function allowedModel(env) {
  const raw = env.SUPPORT_MODEL;
  if (raw === undefined || raw === null || String(raw).trim() === '') return CHAT_MODEL;
  const s = String(raw).trim();
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(s)) return null;
  return s;
}

// Only the two URLs in CHAT_UPSTREAMS are reachable. Unset or blank keeps the Go plan, which is the verified live
// path; an unknown value is null and the route answers 503 before spending a slot. Case and surrounding space are
// forgiven so a hand-typed wrangler var does not take chat down.
function allowedUpstream(env) {
  const raw = env.SUPPORT_UPSTREAM;
  if (raw === undefined || raw === null || String(raw).trim() === '') return CHAT_UPSTREAMS.go;
  return CHAT_UPSTREAMS[String(raw).trim().toLowerCase()] ?? null;
}

function rawPathAndQuery(request) {
  const url = String(request.url || '');
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)(\?[^#]*)?/i.exec(url);
  if (!m) return { path: '', query: '?', encoded: true };
  const path = m[1] || '/';
  let encoded = false;
  try {
    encoded = decodeURIComponent(path) !== path;
  } catch {
    encoded = true;
  }
  return { path, query: m[2] || '', encoded };
}

// Exact POST /v1/support/chat/completions, or a refusal for anything that is trying to be that route. Null means some other route.
function classifySupportChat(request) {
  const raw = rawPathAndQuery(request);
  let pathname = '';
  try { pathname = new URL(request.url).pathname; } catch { return null; }
  const clean = raw.path === '/v1/support/chat/completions' && !raw.query && !raw.encoded
    && !raw.path.split('/').includes('.') && !raw.path.split('/').includes('..');
  if (clean && request.method === 'POST') return 'handle';
  if (clean || raw.path === '/v1/support/chat/completions' || pathname === '/v1/support/chat/completions') return 'refuse';
  return null;
}

function tokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return 0;
  const total = usage.total_tokens;
  if (Number.isSafeInteger(total) && total > 0 && total <= CHAT_MAX_USAGE) return total;
  const inn = Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens
    : (Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : 0);
  const out = Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens
    : (Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : 0);
  const sum = (inn > 0 ? inn : 0) + (out > 0 ? out : 0);
  return Number.isSafeInteger(sum) && sum > 0 && sum <= CHAT_MAX_USAGE ? sum : 0;
}

// The client names whichever model its shipped profile carried, so only the shape is checked. `chatPayload` always
// puts `allowedModel(env)` upstream, so a client value can never choose the model.
function chatBodyOk(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (typeof obj.model !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(obj.model)) return false;
  if (!Array.isArray(obj.messages) || obj.messages.length === 0 || obj.messages.length > 500) return false;
  for (const message of obj.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    if (typeof message.role !== 'string' || !message.role || message.role.length > 32) return false;
    if (message.role.includes('\n') || message.role.includes('\r')) return false;
    const content = message.content;
    const contentOk = content === undefined || content === null || typeof content === 'string' || Array.isArray(content);
    if (!contentOk) return false;
  }
  if ('stream' in obj && typeof obj.stream !== 'boolean') return false;
  return true;
}

function dataUrlOk(url) {
  return typeof url === 'string'
    && url.length <= CHAT_MAX_DATA_URL
    && /^data:/i.test(url)
    && !/[\r\n]/.test(url);
}

function imageUrlOf(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const type = part.type;
  const imagePart = type === 'image_url' || type === 'input_image' || type === 'image';
  if (!imagePart && !Object.prototype.hasOwnProperty.call(part, 'image_url')) return undefined;
  const raw = Object.prototype.hasOwnProperty.call(part, 'image_url') ? part.image_url : part.image;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.url === 'string') return raw.url;
  return '';
}

function messagesHaveRemoteImage(messages) {
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const url = imageUrlOf(part);
      if (url !== undefined && !dataUrlOk(url)) return true;
    }
  }
  return false;
}

function finiteIn(n, lo, hi) {
  return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
}

// Hermes's chat-completions transport sends model, messages, temperature, tools, and max_tokens. A tool
// round-trip keeps tool_calls and tool_call_id on the messages. timeout, extra_body, and reasoning_effort
// are client-side and are not forwarded. n other than 1 is refused: it turns one request into many completions.
function chatPayload(obj, model) {
  if ('n' in obj && obj.n !== 1) return null;
  if (messagesHaveRemoteImage(obj.messages)) return null;
  let maxTokens = null;
  if ('max_tokens' in obj) {
    if (!Number.isSafeInteger(obj.max_tokens) || obj.max_tokens < 1) return null;
    maxTokens = Math.min(obj.max_tokens, CHAT_MAX_COMPLETION);
  }
  if ('temperature' in obj && !finiteIn(obj.temperature, 0, 2)) return null;
  if ('top_p' in obj && !finiteIn(obj.top_p, 0, 1)) return null;
  if ('tools' in obj && !Array.isArray(obj.tools)) return null;
  if ('tool_choice' in obj) {
    const choice = obj.tool_choice;
    if (!(typeof choice === 'string' || (choice && typeof choice === 'object' && !Array.isArray(choice)))) return null;
  }
  if ('stop' in obj) {
    const stop = obj.stop;
    const ok = typeof stop === 'string'
      || (Array.isArray(stop) && stop.length <= 4 && stop.every((item) => typeof item === 'string' && item.length <= 512));
    if (!ok) return null;
  }
  const body = { model, messages: obj.messages };
  if (obj.stream === true) {
    body.stream = true;
    // OpenAI-compatible streams omit usage unless this is set, so the token caps would never move.
    body.stream_options = { include_usage: true };
  } else if (obj.stream === false) {
    body.stream = false;
  }
  if ('temperature' in obj) body.temperature = obj.temperature;
  if ('top_p' in obj) body.top_p = obj.top_p;
  if (maxTokens !== null) body.max_tokens = maxTokens;
  if ('tools' in obj) body.tools = obj.tools;
  if ('tool_choice' in obj) body.tool_choice = obj.tool_choice;
  if ('stop' in obj) body.stop = obj.stop;
  return { body, billTokens: maxTokens ?? CHAT_MAX_COMPLETION };
}

// Adds a parsed usage total. Never writes zero, and a closed window starts at `amount` rather than wiping the row.
async function addUsage(env, key, amount, seconds) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  const now = Math.floor(Date.now() / 1000);
  const until = now + seconds;
  await env.DB.prepare(
    `INSERT INTO limits (k, n, until) VALUES (?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN limits.until <= ? THEN ? ELSE limits.n + ? END,
       until = CASE WHEN limits.until <= ? THEN ? ELSE limits.until END`,
  ).bind(key, amount, until, now, amount, amount, now, until).run();
}

async function tokenBudgetOpen(env, key, max) {
  if (!(max > 0)) return true;
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT n, until FROM limits WHERE k = ?').bind(key).first();
  if (!row || row.until <= now) return true;
  return row.n < max;
}

function containsSecret(text, secrets) {
  return secrets.some((secret) => secret && text.includes(secret));
}

function headerText(value, max) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\r\n]/g, '').trim();
  if (!clean || clean.length > max) return '';
  return clean;
}

// Fresh headers: the client's bearer, cookie, and forwarding headers never ride along. The Go key is set here only.
// OpenCode requires x-opencode-session; a client value that survives headerText wins, and the Worker's per-day
// fallback covers every client that does not send one (Hermes's custom provider does not).
function upstreamHeaders(request, apiKey, stream, fallbackSession) {
  const headers = new Headers();
  headers.set('authorization', `Bearer ${apiKey}`);
  headers.set('content-type', 'application/json');
  headers.set('accept', stream ? 'text/event-stream, application/json' : 'application/json');
  const agent = headerText(request.headers.get('user-agent'), 256);
  if (agent) headers.set('user-agent', agent);
  const session = headerText(request.headers.get('x-opencode-session'), 200) || fallbackSession;
  if (session) headers.set('x-opencode-session', session);
  return headers;
}

function safeContentType(upstream, fallback) {
  const raw = String(upstream.headers.get('content-type') || '').split(/[\r\n]/)[0].trim();
  if (!raw || raw.length > 120 || /[^\w!#$&^.+/=; -]/.test(raw)) return fallback;
  return raw;
}

// Converts a complete non-streaming chat completion JSON object into standard OpenAI SSE `chat.completion.chunk`
// frames so a client expecting a stream receives the same reasoning, content, tool_calls, finish_reason and usage
// when upstream drops streaming connections with zero bytes.
function completionToSse(obj) {
  const choice = Array.isArray(obj?.choices) ? obj.choices[0] : null;
  if (!choice || typeof choice !== 'object') return null;
  const id = typeof obj?.id === 'string' && obj.id ? obj.id : `chatcmpl-${Date.now()}`;
  const created = Number.isSafeInteger(obj?.created) ? obj.created : Math.floor(Date.now() / 1000);
  const model = typeof obj?.model === 'string' && obj.model ? obj.model : CHAT_MODEL;
  const msg = choice.message && typeof choice.message === 'object' ? choice.message : {};
  const finish = typeof choice.finish_reason === 'string' && choice.finish_reason ? choice.finish_reason : 'stop';
  const frames = [];
  const base = { id, object: 'chat.completion.chunk', created, model };
  const push = (delta, finishReason = null, usage = undefined) => {
    const chunk = { ...base, choices: [{ index: 0, finish_reason: finishReason, delta }] };
    if (usage !== undefined) chunk.usage = usage;
    frames.push(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  push({ role: 'assistant', content: '' });
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    push({ reasoning_content: msg.reasoning_content });
  }
  if (typeof msg.content === 'string' && msg.content) {
    push({ content: msg.content });
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    push({
      tool_calls: msg.tool_calls.map((tc, index) => ({
        index,
        id: typeof tc?.id === 'string' ? tc.id : `call_${index}`,
        type: typeof tc?.type === 'string' ? tc.type : 'function',
        function: {
          name: typeof tc?.function?.name === 'string' ? tc.function.name : '',
          arguments: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '',
        },
      })),
    });
  }
  push({}, finish, obj?.usage);
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

// Stream the upstream body through with a byte cap. Usage is read off SSE `data:` lines. A body that does not parse
// leaves the token counters alone. A reply that contains a secret is not forwarded, but its usage is still recorded.
// A client that disconnects is charged the same way: keep reading for the usage frame, then cancel the upstream.
// `fallbackTokens` is the request's clamped max_tokens, used only when no usage frame can be read.
// When upstream closes an SSE stream with zero bytes before emitting anything, `retryEmpty` lets supportChat retry
// upstream transparently (and fall back to a non-streaming completion rendered as SSE) without burning another cap slot.
function streamUpstream(body, maxBytes, secrets, onTokens, options = {}) {
  const fallbackTokens = Number.isSafeInteger(options.fallbackTokens) && options.fallbackTokens > 0 ? options.fallbackTokens : 0;
  const ctx = options.ctx;
  const retryEmpty = typeof options.retryEmpty === 'function' ? options.retryEmpty : null;
  let reader = body.getReader();
  let decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const hold = secrets.reduce((n, secret) => Math.max(n, secret ? secret.length - 1 : 0), 0);
  let pending = '';
  let lineBuf = '';
  let seen = 0;
  let maxTokens = 0;
  let done = false;
  let withheld = false;
  let clientGone = false;
  let emittedAny = false;
  let retriesLeft = retryEmpty ? 2 : 0;
  let chain = Promise.resolve();

  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };

  const note = (text) => {
    lineBuf += text;
    const lines = lineBuf.split(/\r?\n/);
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const tok = tokensFromUsage(JSON.parse(payload)?.usage);
        if (tok > maxTokens) maxTokens = tok;
      } catch { /* a bad line must not change the counters */ }
    }
  };

  const bill = () => (maxTokens > 0 ? maxTokens : ((withheld || clientGone) ? fallbackTokens : 0));

  const finish = async (controller, tokens) => {
    if (done) return;
    done = true;
    try { await reader.cancel(); } catch { /* already finished */ }
    try { await onTokens(tokens); } catch { /* leave the counters alone */ }
    if (controller) {
      try { controller.close(); } catch { /* the client may already be gone */ }
    }
  };

  const take = (value) => {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    const room = maxBytes - seen;
    if (room <= 0) return null;
    const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    seen += slice.byteLength;
    return {
      text: decoder.decode(slice, { stream: true }),
      capped: slice.byteLength < chunk.byteLength,
    };
  };

  const fold = (text) => {
    const inspect = pending + text;
    if (containsSecret(inspect, secrets)) withheld = true;
    note(inspect);
    pending = '';
  };

  const tryRecoverEmpty = async () => {
    while (retriesLeft > 0 && !clientGone && !withheld && !emittedAny) {
      retriesLeft -= 1;
      const useNonStream = retriesLeft === 0;
      let replacement = null;
      try { replacement = await retryEmpty(useNonStream); } catch { replacement = null; }
      if (replacement) {
        try { await reader.cancel(); } catch { /* ignore */ }
        reader = replacement.getReader();
        decoder = new TextDecoder();
        pending = '';
        lineBuf = '';
        return true;
      }
    }
    return false;
  };

  // Read what the client will not see. Stop once a usage total is in hand, or the upstream ends, then bill.
  async function absorb(controller) {
    while (!done && seen < maxBytes) {
      if ((clientGone || withheld) && maxTokens > 0) break;
      let next;
      try { next = await reader.read(); } catch { break; }
      if (next.done) {
        const rest = pending + decoder.decode();
        pending = '';
        if (rest) {
          if (containsSecret(rest, secrets)) withheld = true;
          note(rest);
        }
        break;
      }
      const part = take(next.value);
      if (!part) break;
      fold(part.text);
      if (part.capped) break;
    }
    if (lineBuf.trim()) note('\n');
    await finish(controller, bill());
  }

  return new ReadableStream({
    pull(controller) {
      return exclusive(async () => {
        while (!done && !clientGone) {
          let next;
          try { next = await reader.read(); } catch {
            if (!emittedAny && !withheld && !clientGone && !pending && await tryRecoverEmpty()) continue;
            await finish(controller, maxTokens);
            return;
          }
          if (clientGone) {
            if (!next.done) {
              const part = take(next.value);
              if (part) fold(part.text);
            } else {
              const rest = pending + decoder.decode();
              pending = '';
              if (rest) {
                if (containsSecret(rest, secrets)) withheld = true;
                note(rest);
              }
            }
            await absorb(null);
            return;
          }
          if (next.done) {
            const rest = pending + decoder.decode();
            pending = '';
            if (!rest && !emittedAny && !withheld && await tryRecoverEmpty()) continue;
            if (rest && containsSecret(rest, secrets)) {
              withheld = true;
              note(rest);
              if (lineBuf.trim()) note('\n');
              await finish(controller, bill());
              return;
            }
            if (rest) {
              emittedAny = true;
              note(rest);
              if (lineBuf.trim()) note('\n');
              try { controller.enqueue(encoder.encode(rest)); } catch { /* the client may already be gone */ }
            }
            await finish(controller, bill());
            return;
          }
          const part = take(next.value);
          if (!part) {
            await finish(controller, bill());
            return;
          }
          const inspect = pending + part.text;
          if (containsSecret(inspect, secrets)) {
            withheld = true;
            note(inspect);
            pending = '';
            await absorb(controller);
            return;
          }
          const emit = hold > 0 && inspect.length > hold ? inspect.slice(0, inspect.length - hold) : (hold > 0 ? '' : inspect);
          pending = hold > 0 ? inspect.slice(emit.length) : '';
          if (emit) {
            emittedAny = true;
            note(emit);
            try { controller.enqueue(encoder.encode(emit)); }
            catch {
              clientGone = true;
              await absorb(controller);
              return;
            }
            if (part.capped) await finish(controller, bill());
            return;
          }
          if (part.capped) {
            await finish(controller, bill());
            return;
          }
        }
      });
    },
    cancel() {
      clientGone = true;
      const job = exclusive(async () => {
        if (done) return;
        await absorb(null);
      });
      // The runtime may drop the cancel promise when the client is already gone. waitUntil keeps the
      // isolate alive long enough to read the usage frame and write the counter.
      if (ctx && typeof ctx.waitUntil === 'function') {
        try { ctx.waitUntil(job); } catch { /* the returned promise still finishes the read */ }
      }
      return job;
    },
  });
}

async function supportChat(request, env, ctx) {
  // Chat does not share the reports limiter. A missing binding fails closed rather than borrowing LIMIT.
  if (!env.CHAT_LIMIT || typeof env.CHAT_LIMIT.limit !== 'function') {
    return chatJson(503, 'Support chat is unavailable.', 'server_error', 'unavailable');
  }
  let limited = false;
  try {
    const gate = await env.CHAT_LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || '' });
    limited = !gate?.success;
  } catch { return chatJson(503, 'Support chat is unavailable.', 'server_error', 'unavailable'); }
  if (limited) {
    return chatJson(429, 'Too many support chat requests. Try again in a minute.', 'rate_limit_error', 'rate_limit_exceeded', { 'retry-after': '60' });
  }
  if (!env.DB) return chatJson(503, 'Support chat is unavailable.', 'server_error', 'unavailable');

  const token = /^Bearer (.+)$/i.exec((request.headers.get('authorization') || '').trim())?.[1] || '';
  if (!token) return chatRefused();
  const digest = await shaFull(token);
  let who;
  try {
    who = await env.DB.prepare('SELECT id FROM support_tokens WHERE sha = ? AND revoked IS NULL').bind(digest).first();
  } catch { return chatJson(503, 'Support chat is unavailable.', 'server_error', 'unavailable'); }
  if (!who) return chatRefused();
  // OpenCode requires a session header. This fallback is stable for one person within a UTC day so the upstream can
  // route and cache, and it changes at midnight so it does not link a person across days. `sha()` over the already
  // stored token digest leaks no token bytes, label or sequential row id, and it is never stored here.
  const day = new Date().toISOString().slice(0, 10);
  const fallbackSession = `tess-support-${await sha(`${digest}:${day}`)}`;

  const ctype = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ctype !== 'application/json') return chatJson(415, 'Content-Type must be application/json.', 'invalid_request_error', 'unsupported_media_type');
  const maxReq = byteCap(env.SUPPORT_CHAT_REQUEST_BYTES, CHAT_MAX_REQUEST, CHAT_MAX_REQUEST);
  const maxRes = byteCap(env.SUPPORT_CHAT_RESPONSE_BYTES, CHAT_MAX_RESPONSE, CHAT_MAX_RESPONSE);
  if (maxReq === null || maxRes === null) return chatJson(503, 'Support chat is unavailable.', 'server_error', 'unavailable');
  const claimed = Number(request.headers.get('content-length') || 0);
  if (claimed > maxReq) return chatJson(413, 'The request is too large.', 'invalid_request_error', 'request_too_large');

  const model = allowedModel(env);
  const upstreamUrl = allowedUpstream(env);
  const personRequests = capValue(env.SUPPORT_CHAT_PERSON_REQUESTS, CHAT_PERSON_REQUESTS);
  const sharedRequests = capValue(env.SUPPORT_CHAT_SHARED_REQUESTS, CHAT_SHARED_REQUESTS);
  const personTokens = capValue(env.SUPPORT_CHAT_PERSON_TOKENS, CHAT_PERSON_TOKENS);
  const sharedTokens = capValue(env.SUPPORT_CHAT_SHARED_TOKENS, CHAT_SHARED_TOKENS);
  if (!model || !upstreamUrl || personRequests === null || sharedRequests === null || personTokens === null || sharedTokens === null) {
    return chatJson(503, 'Support chat is unavailable.', 'server_error', 'unavailable');
  }

  const bytes = await readCapped(request, maxReq);
  if (!bytes) return chatJson(413, 'The request is too large.', 'invalid_request_error', 'request_too_large');
  let obj;
  try { obj = JSON.parse(new TextDecoder().decode(bytes)); } catch {
    return chatJson(400, 'The body must be a chat completion.', 'invalid_request_error', 'invalid_json');
  }
  if (!chatBodyOk(obj)) {
    return chatJson(400, 'The body must be a chat completion for the allowed model.', 'invalid_request_error', 'invalid_chat');
  }
  const built = chatPayload(obj, model);
  if (!built) {
    return chatJson(400, 'The body must be a chat completion for the allowed model.', 'invalid_request_error', 'invalid_chat');
  }

  const apiKey = typeof env.OPENCODE_GO_API_KEY === 'string' ? env.OPENCODE_GO_API_KEY : '';
  if (!apiKey) return chatJson(503, 'Support chat is unavailable.', 'server_error', 'unavailable');

  const payload = JSON.stringify(built.body);
  if (utf8(payload).byteLength > maxReq) return chatJson(413, 'The request is too large.', 'invalid_request_error', 'request_too_large');

  const personKey = `chat:p:${digest}`;
  const sharedKey = 'chat:s';
  const personTokenKey = `chat:tp:${digest}`;
  const sharedTokenKey = 'chat:ts';
  const window = secondsUntilUtcMidnight();
  try {
    // The token check is a read and the usage is written after the reply, so the cap is soft by about one
    // reply for each request already in flight. D-103 says so.
    if (!(await tokenBudgetOpen(env, personTokenKey, personTokens))) return quotaReached('person_tokens');
    if (!(await tokenBudgetOpen(env, sharedTokenKey, sharedTokens))) return quotaReached('shared_tokens');
    // Spend both request caps before any upstream call. hit() is one statement, so two requests cannot share the last slot.
    // The person's slot is refunded when the shared cap is the one that refuses.
    if (personRequests < 1 || !(await hit(env, personKey, personRequests, window))) return quotaReached('person');
    if (sharedRequests < 1 || !(await hit(env, sharedKey, sharedRequests, window))) {
      await unhit(env, personKey);
      return quotaReached('shared');
    }
  } catch { return chatJson(503, 'Support chat is unavailable.', 'server_error', 'unavailable'); }
  const secrets = [apiKey, token].filter(Boolean);
  const record = async (amount) => {
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    try {
      if (personTokens > 0) await addUsage(env, personTokenKey, amount, window);
      if (sharedTokens > 0) await addUsage(env, sharedTokenKey, amount, window);
    } catch { /* a failed usage write must not zero the request counters */ }
  };

  let upstream;
  try {
    upstream = await globalThis.fetch(upstreamUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: upstreamHeaders(request, apiKey, built.body.stream === true, fallbackSession),
      body: payload,
    });
  } catch {
    return chatJson(502, 'Support chat could not reach the model.', 'upstream_error', 'upstream_failed');
  }
  // redirect: 'manual' leaves a 3xx as a response. Anything but a 2xx fails closed, and the upstream body is not forwarded.
  if (!upstream || upstream.status < 200 || upstream.status >= 300) {
    try { await upstream?.body?.cancel(); } catch { /* ignore */ }
    return chatJson(502, 'Support chat could not reach the model.', 'upstream_error', 'upstream_failed');
  }

  const fallbackType = built.body.stream === true ? 'text/event-stream' : 'application/json';
  const type = safeContentType(upstream, fallbackType);
  const headers = {
    'content-type': containsSecret(type, secrets) ? fallbackType : type,
    'cache-control': 'no-store',
  };
  if (built.body.stream === true) {
    const retryEmpty = async (useNonStream) => {
      if (!useNonStream) {
        let again;
        try {
          again = await globalThis.fetch(upstreamUrl, {
            method: 'POST',
            redirect: 'manual',
            headers: upstreamHeaders(request, apiKey, true, fallbackSession),
            body: payload,
          });
        } catch { return null; }
        if (!again || again.status < 200 || again.status >= 300 || !again.body) {
          try { await again?.body?.cancel(); } catch { /* ignore */ }
          return null;
        }
        return again.body;
      }
      const nonStreamBody = { ...built.body, stream: false };
      delete nonStreamBody.stream_options;
      let fallback;
      try {
        fallback = await globalThis.fetch(upstreamUrl, {
          method: 'POST',
          redirect: 'manual',
          headers: upstreamHeaders(request, apiKey, false, fallbackSession),
          body: JSON.stringify(nonStreamBody),
        });
      } catch { return null; }
      if (!fallback || fallback.status < 200 || fallback.status >= 300) {
        try { await fallback?.body?.cancel(); } catch { /* ignore */ }
        return null;
      }
      const raw = await readCapped(fallback, maxRes);
      if (!raw) {
        try { await fallback.body?.cancel(); } catch { /* ignore */ }
        return null;
      }
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(raw)); } catch { return null; }
      const sse = completionToSse(parsed);
      if (!sse) return null;
      const bytes = new TextEncoder().encode(sse);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    };
    const readable = streamUpstream(upstream.body || new ReadableStream(), maxRes, secrets, record, {
      fallbackTokens: built.billTokens,
      ctx,
      retryEmpty,
    });
    return new Response(readable, { status: 200, headers });
  }

  const buffered = await readCapped(upstream, maxRes);
  if (!buffered) {
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
    return chatJson(502, 'Support chat could not reach the model.', 'upstream_error', 'upstream_failed');
  }
  const text = new TextDecoder().decode(buffered);
  let usage = 0;
  try { usage = tokensFromUsage(JSON.parse(text)?.usage); } catch { usage = 0; }
  if (containsSecret(text, secrets)) {
    await record(usage > 0 ? usage : built.billTokens);
    return chatJson(502, 'Support chat could not reach the model.', 'upstream_error', 'upstream_failed');
  }
  await record(usage);
  return new Response(buffered, { status: 200, headers });
}

export default {
  async fetch(request, env, ctx) {
    const chat = classifySupportChat(request);
    if (chat === 'handle') return supportChat(request, env, ctx);
    if (chat === 'refuse') {
      const exact = rawPathAndQuery(request).path === '/v1/support/chat/completions' && !rawPathAndQuery(request).query;
      if (exact && request.method !== 'POST') return chatJson(405, 'Only POST is accepted.', 'invalid_request_error', 'method_not_allowed');
      return reply(404);
    }
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/v1/report') return report(request, env);
    if (request.method === 'POST' && pathname === '/v1/support') return support(request, env);
    if (request.method === 'PATCH' && /^\/v1\/support\/\d+$/.test(pathname)) return supportAmend(request, env, pathname.split('/').pop());
    if (request.method === 'POST' && pathname === '/v1/support/invite/check') return supportInviteCheck(request, env);
    if (request.method === 'POST' && pathname === '/v1/support/invite/claim') return supportInviteClaim(request, env);
    if (request.method === 'GET' && pathname === '/v1/issues') return issueTitles(request, env);
    if (request.method === 'PUT' && /^\/v1\/support\/recording\/\d+$/.test(pathname)) return recording(request, env, pathname.split('/').pop());
    if (request.method === 'GET' && (pathname === '/v1/rescue.txt' || pathname === '/v1/rescue.sig')) {
      const v = await env.RESCUE.get(pathname.slice(4));
      return v == null ? reply(404) : reply(200, v);
    }
    // The newest rescue serial, public like the order itself. No install id, no report data. Macs compare it with
    // the last order they ran; the order still has to pass the rescue key's signature before anything happens.
    // D1 is strongly consistent (KV can take ~a minute); KV stays as the fallback for old database schemas.
    if (request.method === 'GET' && pathname === '/v1/wake') {
      try {
        const row = await env.DB.prepare('SELECT serial FROM wake WHERE id = 1').first();
        if (row && Number.isInteger(row.serial)) return reply(200, String(row.serial));
      } catch {}
      const v = await env.RESCUE.get('wake');
      return v == null ? reply(204) : reply(200, v);
    }
    return reply(404);
  },
  // keep 30 days of reports and drop finished rate-limit windows
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM reports WHERE at < ?').bind(Date.now() - 30 * 86400 * 1000).run();
    // Support cleanup last, and in its own try: a Worker deployed before the schema is applied must not stop the
    // health-report cleanup above it. Losing a night of support cleanup is harmless; losing the limits sweep is not.
    try {
      // A filed support report is worth keeping; an unfiled one goes stale like any other report.
      await env.DB.prepare('DELETE FROM support_reports WHERE at < ? AND issue IS NULL').bind(Date.now() - 30 * 86400 * 1000).run();
      // Recordings go as soon as the report is filed, and at 14 days whether or not it was: a person's screen is a
      // liability to keep, and the issue already has what matters. The R2 lifecycle rule is the second belt.
      const cutoff = Date.now() - RECORDING_DAYS * 86400 * 1000;
      const stale = await env.DB.prepare('SELECT id, recording FROM support_reports WHERE recording IS NOT NULL AND (issue IS NOT NULL OR at < ?)').bind(cutoff).all();
      for (const r of stale.results || []) await env.SUPPORT.delete(r.recording);
      await env.DB.prepare('UPDATE support_reports SET recording = NULL WHERE recording IS NOT NULL AND (issue IS NOT NULL OR at < ?)').bind(cutoff).run();
      // Stills use the same 14-day rule. A database that has not added the image column yet still drops recordings.
      try {
        const staleImg = await env.DB.prepare('SELECT id, image FROM support_reports WHERE image IS NOT NULL AND (issue IS NOT NULL OR at < ?)').bind(cutoff).all();
        for (const r of staleImg.results || []) if (r.image) await env.SUPPORT.delete(r.image);
        await env.DB.prepare('UPDATE support_reports SET image = NULL WHERE image IS NOT NULL AND (issue IS NOT NULL OR at < ?)').bind(cutoff).run();
      } catch { /* image column not applied yet */ }
    } catch { /* schema not applied yet, or R2 not bound: the health-report cleanup above already ran */ }
    await env.DB.prepare('DELETE FROM limits WHERE until < ?').bind(Math.floor(Date.now() / 1000)).run();
  },
};
