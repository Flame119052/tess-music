// Tests installer/wake.sh against a local inbox and a fake launchctl, so the real Tess folder, the real rescue agent
// and the network are never touched. Run: node tools/test-rescue-wake.mjs
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), 'tess-wake-test-'));
const tess = join(sandbox, 'Tess');
const bin = join(sandbox, 'bin');
const launchLog = join(sandbox, 'launchctl.log');
const ran = join(sandbox, 'ran');
const wakeTried = join(tess, 'rescue', 'wake-tried');
const serial = join(tess, 'rescue', 'serial');

let wake = null;
let broken = false;
const urls = [];
const server = createServer((req, res) => {
  urls.push(req.url);
  if (req.url !== '/v1/wake') { res.writeHead(404); res.end(); return; }
  if (broken) { res.writeHead(500); res.end(); return; }
  if (wake == null) { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`${wake}\n`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const inbox = `http://127.0.0.1:${server.address().port}`;

mkdirSync(join(tess, 'rescue'), { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(serial, '1\n');
writeFileSync(join(tess, 'rescue', 'rescue.sh'), `#!/bin/zsh\necho ran >> "${ran}"\n`);
chmodSync(join(tess, 'rescue', 'rescue.sh'), 0o755);
copyFileSync(join(root, 'installer', 'wake.sh'), join(tess, 'wake.sh'));
chmodSync(join(tess, 'wake.sh'), 0o755);
writeFileSync(join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> "${launchLog}"\nif [ "$1" = print ] && [ -f "${sandbox}/notloaded" ]; then exit 1; fi\nexit 0\n`);
chmodSync(join(bin, 'launchctl'), 0o755);

const env = { ...process.env, TESS_HOME: tess, TESS_INBOX: inbox, PATH: `${bin}:${process.env.PATH}` };
// execFile, not spawnSync: the fake inbox lives in this process and its event loop must keep running.
const run = () => new Promise((resolve) => execFile('/bin/zsh', [join(tess, 'wake.sh')], { env, timeout: 30000 },
  (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })));
const reset = (wakeValue = null) => {
  wake = wakeValue; broken = false; urls.length = 0;
  rmSync(launchLog, { force: true });
  rmSync(ran, { force: true });
  rmSync(wakeTried, { force: true });
  rmSync(join(sandbox, 'notloaded'), { force: true });
  rmSync(join(tess, '.installing'), { force: true });
  rmSync(join(tess, 'rescue', 'wake.log'), { force: true });
  writeFileSync(serial, '1\n');
};
const kicks = () => existsSync(launchLog) ? readFileSync(launchLog, 'utf8').split('\n').filter((l) => l.startsWith('kickstart ')).length : 0;
const age = (path, minutes) => { const t = new Date(Date.now() - minutes * 60000); utimesSync(path, t, t); };

try {
  // 1. no order: one cheap request, nothing started
  reset(null);
  let r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(kicks(), 0);
  assert.deepEqual(urls, ['/v1/wake']);

  // 2. the serial this Mac already has: no start
  reset(1);
  r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(kicks(), 0);

  // 3. a newer serial: the rescue agent is started once, and the wake line names the order
  reset(2);
  r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(kicks(), 1);
  assert.match(readFileSync(launchLog, 'utf8'), /kickstart gui\/\d+\/music\.tess\.rescue/);
  assert.match(readFileSync(join(tess, 'rescue', 'wake.log'), 'utf8'), /order 2 is out/);
  assert.equal(readFileSync(wakeTried, 'utf8').trim(), '2');

  // 4. the same serial a second later: no hammering
  r = await run();
  assert.equal(kicks(), 1);

  // 5. a stuck order is retried after 15 minutes, not every minute
  age(wakeTried, 16);
  r = await run();
  assert.equal(kicks(), 2);

  // 6. once the Mac has the order, a stale wake value is quiet again
  reset(2);
  writeFileSync(serial, '2\n');
  r = await run();
  assert.equal(kicks(), 0);

  // 7. the inbox is down: quiet, exit 0, no start
  reset(2);
  broken = true;
  r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(kicks(), 0);

  // 8. a malformed value cannot start anything
  reset('not-a-number');
  r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(kicks(), 0);

  // 9. the installer/updater is working: wait
  reset(2);
  writeFileSync(join(tess, '.installing'), '');
  r = await run();
  assert.equal(kicks(), 0);
  // ...unless that lock is stale (the updater treats 30 minutes as abandoned)
  age(join(tess, '.installing'), 31);
  r = await run();
  assert.equal(kicks(), 1);

  // 10. no rescue agent loaded: run the signed rescue line directly instead of losing the order
  reset(3);
  writeFileSync(join(sandbox, 'notloaded'), '');
  r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(kicks(), 0);
  assert.ok(existsSync(ran), 'rescue.sh should have run directly');

  // 11. the plist is valid and is the one agent definition both the installer and updater use
  reset(null);
  const plistRun = spawnSync('/bin/zsh', [join(tess, 'wake.sh'), '--plist'], { encoding: 'utf8', env });
  assert.equal(plistRun.status, 0, plistRun.stderr);
  const plist = join(sandbox, 'music.tess.wake.plist');
  writeFileSync(plist, plistRun.stdout);
  const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  assert.match(plistRun.stdout, /<string>music\.tess\.wake<\/string>/);
  assert.match(plistRun.stdout, /<integer>300<\/integer>/);
  assert.match(plistRun.stdout, new RegExp(`<string>${tess.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/wake\\.sh</string>`));

  // 12. the updater installs the same agent from wake.sh (sandbox mode, so it never touches the real launchd)
  mkdirSync(join(sandbox, 'Spotify.app'), { recursive: true });
  copyFileSync(join(root, 'installer', 'updater.sh'), join(tess, 'updater.sh'));
  const uenv = { ...env, TESS_TEST: '1', TESS_CONFIG: join(sandbox, 'conf'), TESS_SPOTIFY: join(sandbox, 'Spotify.app'), SPOTIFY: join(sandbox, 'Spotify.app') };
  const u = await new Promise((resolve) => execFile('/bin/zsh', [join(tess, 'updater.sh')], { env: uenv, timeout: 60000 },
    (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })));
  assert.equal(u.status, 0, u.stderr);
  const updaterPlist = join(tess, 'LaunchAgents', 'music.tess.wake.plist');
  assert.ok(existsSync(updaterPlist), 'updater should write the wake agent in sandbox mode');
  const ulint = spawnSync('plutil', ['-lint', updaterPlist], { encoding: 'utf8' });
  assert.equal(ulint.status, 0, ulint.stdout + ulint.stderr);
  assert.match(readFileSync(updaterPlist, 'utf8'), new RegExp(`<string>${tess.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/wake\\.sh</string>`));
  assert.match(readFileSync(join(tess, 'guard.log'), 'utf8'), /wake agent installed \(test\)/);

  console.log('rescue wake tests passed');
} finally {
  server.close();
  rmSync(sandbox, { recursive: true, force: true });
}
