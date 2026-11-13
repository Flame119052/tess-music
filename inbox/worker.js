// Tess inbox: Macs send health reports here, and it serves the signed rescue order as one more mirror.
// Security model:
//  - Anyone can POST a report (a public installer can't hold a secret), so a report is only ever stored data: never
//    shown on a page, never run, never trusted. Strict size, shape and rate limits stop flooding.
//  - Nothing can be read back over the web. Reports are read only with the owner's Cloudflare login (tools/reports.mjs).
//  - The rescue order is written only with the owner's Cloudflare login, and Macs run it only if it carries the
//    offline rescue key's signature, so even someone who took over this Worker could not make a Mac run anything.
const MAX_BODY = 64 * 1024;
const KINDS = new Set(['heartbeat', 'problem', 'doctor', 'rescue', 'install']);
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

const reply = (status, text = '') => new Response(text, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

async function report(request, env) {
  if (request.headers.get('content-type') !== 'application/json') return reply(415);
  const len = Number(request.headers.get('content-length') || 0);
  if (!len || len > MAX_BODY) return reply(413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply(413);
  let r;
  try { r = JSON.parse(raw); } catch { return reply(400); }
  if (!r || typeof r !== 'object' || !/^[0-9a-f]{32}$/.test(r.install || '') || !KINDS.has(r.kind)) return reply(400);
  // IPs are never stored: only a salted hash, used for the limit and then thrown away when the window ends
  const ip = await sha(`${env.SALT}|${request.headers.get('cf-connecting-ip') || ''}`);
  if (!(await hit(env, `ip:${ip}`, 30, 3600))) return reply(429);
  if (!(await hit(env, `id:${r.install}`, 60, 86400))) return reply(429);
  if (!(await hit(env, 'all', 20000, 86400))) return reply(429);
  await env.DB.prepare('INSERT INTO reports (at, install, kind, tess, spotify, macos, status, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(Date.now(), r.install, r.kind, short(r.tess, 40), short(r.spotify, 40), short(r.macos, 40), short(r.status, 2000), short(r.body, 56 * 1024))
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
    return reply(404);
  },
  // keep 90 days of reports and drop finished rate-limit windows
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM reports WHERE at < ?').bind(Date.now() - 90 * 86400 * 1000).run();
    await env.DB.prepare('DELETE FROM limits WHERE until < ?').bind(Math.floor(Date.now() / 1000)).run();
  },
};
