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
const MAX_BODY = 32 * 1024;
// A support report carries the person's words, the bot's diagnosis and the finished write-up, so it is allowed more
// room than a health report while still being bounded.
const MAX_SUPPORT = 48 * 1024;
// A recording of the Spotify window only. Telegram caps an upload at 20 MB, so this is generous; it exists so a stray
// 500 MB file can't land in R2.
const MAX_RECORDING = 50 * 1024 * 1024;
const RECORDING_DAYS = 14;
const DAILY_CAP = 2000;
const KINDS = new Set(['heartbeat', 'problem', 'doctor', 'rescue', 'install']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const AREAS = new Set(['area: theme', 'area: patcher', 'area: installer', 'area: mini', 'area: companion', 'area: release-ci', 'area: docs']);
const ISSUE_KINDS = new Set(['bug', 'enhancement', 'design', 'security', 'testing', 'documentation', 'spec']);
const short = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, n) : null);

async function hit(env, key, max, seconds) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare('SELECT n, until FROM limits WHERE k = ?').bind(key).first();
  if (!row || row.until < now) {
    await env.DB.prepare('INSERT OR REPLACE INTO limits (k, n, until) VALUES (?, 1, ?)').bind(key, now + seconds).run();
    return true;
  }
  if (row.n >= max) return false;
  await env.DB.prepare('UPDATE limits SET n = n + 1 WHERE k = ?').bind(key).run();
  return true;
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

async function report(request, env) {
  if (request.headers.get('content-type') !== 'application/json') return reply(415);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_BODY) return reply(413);
  const { success } = await env.LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || '' });
  if (!success) return reply(429);
  const day = await env.DB.prepare('SELECT n, until FROM limits WHERE k = ?').bind('all').first();
  if (day && day.until > Date.now() / 1000 && day.n >= DAILY_CAP) return reply(429);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply(413);
  let r;
  try { r = JSON.parse(raw); } catch { return reply(400); }
  if (!r || typeof r !== 'object' || !/^[0-9a-f]{32}$/.test(r.install || '') || !KINDS.has(r.kind)) return reply(400);
  // IPs are never stored: only a salted hash, used for the limit and then thrown away when the window ends
  const ip = await sha(`${env.SALT}|${request.headers.get('cf-connecting-ip') || ''}`);
  if (!(await hit(env, `ip:${ip}`, 30, 3600))) return reply(429);
  if (!(await hit(env, `id:${r.install}`, 60, 86400))) return reply(429);
  if (!(await hit(env, 'all', DAILY_CAP, 86400))) return reply(429);
  await env.DB.prepare('INSERT INTO reports (at, install, kind, tess, spotify, macos, status, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(Date.now(), r.install, r.kind, short(r.tess, 40), short(r.spotify, 40), short(r.macos, 40), short(r.status, 2000), short(r.body, 24 * 1024))
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
    who = await env.DB.prepare('SELECT label FROM support_tokens WHERE sha = ? AND revoked IS NULL').bind(sha).first();
  } catch { return reply(503); }
  if (!who) return reply(401);
  if (request.headers.get('content-type') !== 'application/json') return reply(415);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_SUPPORT) return reply(413);
  if (!(await hit(env, `tok:${sha.slice(0, 16)}`, 60, 3600))) return reply(429);
  const raw = await request.text();
  if (raw.length > MAX_SUPPORT) return reply(413);
  let r;
  try { r = JSON.parse(raw); } catch { return reply(400); }
  if (!r || typeof r !== 'object') return reply(400);
  if (!PRIORITIES.has(r.priority)) return reply(400);
  if (!ISSUE_KINDS.has(r.kind)) return reply(400);
  const areas = (Array.isArray(r.areas) ? r.areas : String(r.areas || '').split(','))
    .map((a) => String(a).trim().replace(/^area:\s*/, 'area: ')).filter(Boolean);
  if (!areas.length || areas.length > 3 || areas.some((a) => !AREAS.has(a))) return reply(400);
  if (!short(r.title, 120)) return reply(400);
  if (/[`\u0000]|\$\(/.test(String(r.title))) return reply(400);
  const install = /^[0-9a-f]{32}$/.test(r.install || '') ? r.install : null;
  let row;
  try {
    row = await env.DB.prepare(
      'INSERT INTO support_reports (at, person, install, tess, spotify, macos, priority, areas, kind, title, words, diagnosis, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
    Date.now(), short(who.label, 60), install,
    short(r.tess, 40), short(r.spotify, 40), short(r.macos, 40),
    r.priority, areas.join(', '), r.kind, short(r.title, 120),
      short(r.words, 4000), short(r.diagnosis, 2000), short(r.body, 24 * 1024),
    ).run();
  } catch {
    // Most likely the schema hasn't been applied on this database yet. Say so, rather than leaking a D1 error.
    return reply(503);
  }
  return new Response(JSON.stringify({ ok: true, id: row.meta?.last_row_id ?? null }), {
    status: 201, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
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

// A recording of the person's screen is the one thing here that must never be public, so it can be written and never
// read back: no GET, and the scheduled job deletes it once the report is filed or after 14 days.
async function recording(request, env, id) {
  const { success } = await env.LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || '' });
  if (!success) return reply(429);
  const auth = request.headers.get('authorization') || '';
  const token = /^Bearer (.+)$/i.exec(auth.trim())?.[1] || '';
  if (!token) return reply(401);
  const sha = await shaFull(token);
  let who, row;
  try {
    who = await env.DB.prepare('SELECT label FROM support_tokens WHERE sha = ? AND revoked IS NULL').bind(sha).first();
    if (!/^\d+$/.test(id)) return reply(400);
    row = await env.DB.prepare('SELECT id FROM support_reports WHERE id = ?').bind(Number(id)).first();
  } catch { return reply(503); }
  if (!who) return reply(401);
  if (!row) return reply(404);
  // Uploads are heavier than a JSON post, so they get their own, smaller budget per token.
  if (!(await hit(env, `rec:${sha.slice(0, 16)}`, 10, 3600))) return reply(429);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_RECORDING) return reply(413);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^video\/(mp4|quicktime|x-matroska|webm)$/.test(type)) return reply(415);
  const ext = { 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv' }[type] || 'mp4';
  const key = `support/${id}.${ext}`;
  try {
    await env.SUPPORT.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: type } });
    await env.DB.prepare('UPDATE support_reports SET recording = ? WHERE id = ?').bind(key, Number(id)).run();
  } catch { return reply(503); }
  return reply(204);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/v1/report') return report(request, env);
    if (request.method === 'POST' && pathname === '/v1/support') return support(request, env);
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
    } catch { /* schema not applied yet, or R2 not bound: the health-report cleanup above already ran */ }
    await env.DB.prepare('DELETE FROM limits WHERE until < ?').bind(Math.floor(Date.now() / 1000)).run();
  },
};
