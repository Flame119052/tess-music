#!/usr/bin/env node
// Tess companion — dev server and checks.
//   node tools/companion.mjs serve [port]   serve the companion (default 8137)
//   node tools/companion.mjs check          static, syntax and wiring checks
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'companion');
const THEME = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'theme', 'Tess', 'src', 'dial-pick.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serve(port) {
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(ROOT, '.' + path);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  server.listen(port, () => console.log(`companion on http://127.0.0.1:${port}/`));
}

const fails = [];
const ok = (cond, label) => { console.log(`${cond ? '✔' : '✖'} ${label}`); if (!cond) fails.push(label); };

function pngSize(file) {
  try {
    const b = readFileSync(file);
    return b.length > 24 && b.readUInt32BE(12) === 0x49484452 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  } catch { return null; }
}

function check() {
  for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png']) {
    ok(existsSync(join(ROOT, f)), `file: ${f}`);
  }
  for (const f of ['auth.js', 'api.js', 'aurora.js', 'sync.js', 'remote.js', 'dial.js', 'views.js', 'player.js', 'app.js', 'dial-pick.js']) {
    const p = join(ROOT, 'src', f);
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    ok(r.status === 0, `syntax: src/${f}${r.status ? ' — ' + r.stderr.trim().split('\n')[0] : ''}`);
  }
  const sw = spawnSync(process.execPath, ['--check', join(ROOT, 'sw.js')], { encoding: 'utf8' });
  ok(sw.status === 0, 'syntax: sw.js');

  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8')); } catch {}
  ok(manifest && manifest.display === 'standalone' && manifest.start_url === './', 'manifest: standalone, relative start_url');
  for (const icon of manifest?.icons || []) ok(existsSync(join(ROOT, icon.src)), `manifest icon: ${icon.src}`);

  const apple = pngSize(join(ROOT, 'icons', 'apple-touch-icon.png'));
  ok(apple?.w === 180 && apple?.h === 180, `apple-touch-icon is 180px (${apple ? apple.w + 'x' + apple.h : 'unreadable'})`);
  for (const n of [192, 512]) {
    const s = pngSize(join(ROOT, 'icons', `icon-${n}.png`));
    ok(s?.w === n && s?.h === n, `icon-${n}.png is ${n}px (${s ? s.w + 'x' + s.h : 'unreadable'})`);
  }

  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u));
  for (const ref of refs) ok(existsSync(join(ROOT, ref)), `index references ${ref}`);

  const pick = readFileSync(join(ROOT, 'src', 'dial-pick.js'));
  ok(pick.equals(readFileSync(THEME)), 'dial-pick.js is byte-identical to the theme copy');

  const read = (f) => readFileSync(join(ROOT, f), 'utf8');
  const sources = ['src/auth.js', 'src/api.js', 'src/sync.js', 'src/remote.js', 'src/app.js', 'src/views.js', 'src/dial.js', 'src/player.js', 'src/aurora.js', 'sw.js'].map(read).join('\n');
  ok(!/client_secret/i.test(sources), 'no client secret anywhere');
  ok(!/\bTODO\b|\bFIXME\b/.test(read('index.html') + sources + read('styles.css')), 'no TODOs left behind');
  ok(sources.includes('wss://dealer.spotify.com'), 'dealer push socket wired');
  ok(sources.includes('sdk.scdn.co/spotify-player.js'), 'Web Playback SDK wired for in-app playback');
  ok(sources.includes('activateElement'), 'iOS activateElement after transfer wired');
  ok(sources.includes('setPositionState'), 'lock-screen timeline wired');
  ok(read('src/remote.js').includes("!== '0'"), 'background listening on by default');
  ok(read('src/sync.js').includes('anchor'), 'optimistic anchors in place');

  console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nall checks pass');
  process.exit(fails.length ? 1 : 0);
}

const [, , cmd, arg] = process.argv;
if (cmd === 'serve') serve(Number(arg) || 8137);
else if (cmd === 'check') check();
else { console.log('usage: node tools/companion.mjs serve [port] | check'); process.exit(2); }
