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
// request; at most DAILY_CAP reports are stored a day (~6 rows written each), kept 30 days, 24 KB of bytes each at most.
const MAX_BODY = 32 * 1024;
const MAX_STORE = 24 * 1024;
const DAILY_CAP = 2000;
const KINDS = new Set(['heartbeat', 'problem', 'doctor', 'rescue', 'install']);
// The stored per-IP keys are only useless without the salt: an unsalted SHA-256 of an IPv4 address is brute-forceable
// in minutes. A Worker with no usable secret refuses reports instead of weakening that promise.
const MIN_SALT = 16;
const utf8 = (s) => new TextEncoder().encode(s);
// Cut by bytes, not by characters: 24K characters of 4-byte characters is 96 KB in the database.
const cut = (s, n) => { const b = utf8(s); return b.length <= n ? s : new TextDecoder().decode(b.slice(0, n)); };
// Nothing every terminal would hide from the person reading a report is stored: C0 and C1 controls, the bidi overrides
// and marks (they can reorder a line so an honest path reads as something else), zero-width joiners and the byte-order
// mark, and the invisible operators. Anyone can post here, and tools/reports.mjs prints these values to a terminal.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const short = (v, n) => (typeof v === 'string' ? cut(v.replace(INVISIBLE, ''), n) : null);

async function hit(env, key, max, seconds) {
  const now = Math.floor(Date.now() / 1000);
  // The count is written by one statement, so two requests that arrive together cannot both read the same number and
  // pass: the increment is the check, and the row it just wrote is what decides.
  await env.DB.prepare(
    `INSERT INTO limits (k, n, until) VALUES (?, 1, ?)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN limits.until <= ? THEN 1 ELSE limits.n + 1 END,
       until = CASE WHEN limits.until <= ? THEN ? ELSE limits.until END`,
  ).bind(key, now + seconds, now, now, now + seconds).run();
  const row = await env.DB.prepare('SELECT n FROM limits WHERE k = ?').bind(key).first();
  return !!row && row.n <= max;
}

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// A 204 carries no body at all (a Response with one is invalid), so the empty reply passes null rather than "".
const reply = (status, text = '') => new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

async function report(request, env) {
  // Fail closed, before anything else: no salt or no database means no safe place to put a report, so none is taken.
  if (typeof env.SALT !== 'string' || env.SALT.length < MIN_SALT) return reply(503);
  if (!env.DB) return reply(503);
  if (request.headers.get('content-type') !== 'application/json') return reply(415);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_BODY) return reply(413);
  const { success } = await env.LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || '' });
  if (!success) return reply(429);
  const day = await env.DB.prepare('SELECT n, until FROM limits WHERE k = ?').bind('all').first();
  if (day && day.until > Date.now() / 1000 && day.n >= DAILY_CAP) return reply(429);
  const raw = await request.text();
  if (utf8(raw).length > MAX_BODY) return reply(413);
  let r;
  try { r = JSON.parse(raw); } catch { return reply(400); }
  if (!r || typeof r !== 'object' || !/^[0-9a-f]{32}$/.test(r.install || '') || !KINDS.has(r.kind)) return reply(400);
  // IPs are never stored: only a salted hash, used for the limit and then thrown away when the window ends
  const ip = await sha(`${env.SALT}|${request.headers.get('cf-connecting-ip') || ''}`);
  if (!(await hit(env, `ip:${ip}`, 30, 3600))) return reply(429);
  if (!(await hit(env, `id:${r.install}`, 60, 86400))) return reply(429);
  if (!(await hit(env, 'all', DAILY_CAP, 86400))) return reply(429);
  await env.DB.prepare('INSERT INTO reports (at, install, kind, tess, spotify, macos, status, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(Date.now(), r.install, r.kind, short(r.tess, 40), short(r.spotify, 40), short(r.macos, 40), short(r.status, 2000), short(r.body, MAX_STORE))
    .run();
  return reply(204);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/v1/report') return report(request, env);
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
    await env.DB.prepare('DELETE FROM limits WHERE until < ?').bind(Math.floor(Date.now() / 1000)).run();
  },
};
