// Test installer/wake.sh with fake curl and launchctl; no network, real Tess folder or real LaunchAgent is touched.
// Usage: node tools/test-wake.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const box = mkdtempSync(join(tmpdir(), 'tess-wake-test-'));
const tess = join(box, 'Tess');
const state = join(tess, 'state');
const rescue = join(tess, 'rescue');
const bin = join(box, 'bin');
const curlLog = join(box, 'curl.log');
const launchLog = join(box, 'launchctl.log');
const manifest = join(box, 'manifest.json');
const order = join(box, 'rescue.txt');

try {
  mkdirSync(state, { recursive: true });
  mkdirSync(rescue, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(root, 'installer', 'wake.sh'), join(tess, 'wake.sh'));
  chmodSync(join(tess, 'wake.sh'), 0o755);
  writeFileSync(join(tess, 'updater.env'), "TESS_PARTS_CHANNEL='beta'\n");
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
echo "$@" >> "$TESS_CURL_LOG"
[ "$TESS_CURL_FAIL" = 1 ] && exit 22
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */beta/dist/manifest.json) cp "$TESS_MANIFEST" "$out" ;;
  */rescue/rescue.txt) cp "$TESS_ORDER" "$out" ;;
  *) exit 22 ;;
esac
`);
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> "$TESS_LAUNCH_LOG"\n`);
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'launchctl'), 0o755);

  const baseEnv = {
    ...process.env,
    TESS_HOME: tess,
    TESS_CURL_LOG: curlLog,
    TESS_LAUNCH_LOG: launchLog,
    TESS_MANIFEST: manifest,
    TESS_ORDER: order,
    PATH: `${bin}:${process.env.PATH}`,
  };
  const run = (extra = {}) => execFileSync('/bin/zsh', [join(tess, 'wake.sh')], { env: { ...baseEnv, ...extra }, encoding: 'utf8' });
  const lines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
  const kicks = () => lines(launchLog).filter((line) => line.startsWith('kickstart '));
  const reset = ({ published = '1.2.3', installed = '1.2.3', serial = 5, done = 5 } = {}) => {
    writeFileSync(manifest, JSON.stringify({ version: published }) + '\n');
    writeFileSync(order, `tess-rescue 2\nserial ${serial}\n`);
    writeFileSync(join(state, 'version'), `${installed}\n`);
    writeFileSync(join(rescue, 'serial'), `${done}\n`);
    rmSync(curlLog, { force: true });
    rmSync(launchLog, { force: true });
    rmSync(join(tess, 'rescue-off'), { force: true });
    rmSync(join(tess, '.installing'), { force: true });
    rmSync(join(state, '.wake-network-failed'), { force: true });
  };

  reset();
  run();
  assert.deepEqual(kicks(), [], 'no change is quiet');
  assert.equal(lines(curlLog).length, 2, 'reads exactly two files');
  assert.match(lines(curlLog)[0], /raw\.githubusercontent\.com\/Flame119052\/tess-music\/beta\/dist\/manifest\.json/);
  assert.match(lines(curlLog)[1], /raw\.githubusercontent\.com\/Flame119052\/tess-music\/rescue\/rescue\.txt/);
  assert.ok(lines(curlLog).every((line) => !line.includes('api.github.com') && !line.includes('janus.ing')), 'raw GitHub only');

  reset({ published: '1.2.4' });
  run();
  assert.ok(kicks().some((line) => line.endsWith('music.tess.guard')), 'new version wakes updater');

  reset({ serial: 6 });
  run();
  assert.ok(kicks().some((line) => line.endsWith('music.tess.rescue')), 'new serial wakes rescue');

  reset({ serial: 6 });
  writeFileSync(join(tess, 'rescue-off'), '');
  run();
  assert.ok(!kicks().some((line) => line.endsWith('music.tess.rescue')), 'rescue off suppresses rescue wake');

  reset({ published: '1.2.4', serial: 6 });
  run({ TESS_CURL_FAIL: '1' });
  assert.deepEqual(kicks(), [], 'network failure starts nothing');
  assert.ok(existsSync(join(state, '.wake-network-failed')), 'network failure starts backoff');
  const attempted = lines(curlLog).length;
  run();
  assert.equal(lines(curlLog).length, attempted, 'backoff skips another network attempt');

  reset({ published: '1.2.4', serial: 6 });
  writeFileSync(join(tess, '.installing'), '');
  run();
  assert.equal(lines(curlLog).length, 0, 'updater lock suppresses reads');
  assert.deepEqual(kicks(), [], 'updater lock suppresses wakeups');

  const plistRun = spawnSync('/bin/zsh', [join(tess, 'wake.sh'), '--plist'], { env: baseEnv, encoding: 'utf8' });
  assert.equal(plistRun.status, 0, plistRun.stderr);
  assert.match(plistRun.stdout, /<key>StartInterval<\/key><integer>300<\/integer>/);
  const plist = join(box, 'music.tess.wake.plist');
  writeFileSync(plist, plistRun.stdout);
  const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);

  const spotify = join(box, 'Spotify.app');
  mkdirSync(join(spotify, 'Contents', 'Resources', 'Apps', 'xpui'), { recursive: true });
  writeFileSync(join(spotify, 'Contents', 'Resources', 'Apps', 'xpui', 'index.html'), 'spicetifyWrapper\n');
  writeFileSync(join(tess, 'updater.env'), `SPOTIFY='${spotify}'\nTESS_CONFIG='${join(box, 'config')}'\nTESS_PARTS_CHANNEL='beta'\n`);
  copyFileSync(join(root, 'installer', 'updater.sh'), join(tess, 'updater.sh'));
  rmSync(join(tess, '.installing'), { force: true });
  execFileSync('/bin/zsh', [join(tess, 'updater.sh')], { env: { ...baseEnv, TESS_TEST: '1' }, encoding: 'utf8' });
  const installedPlist = join(tess, 'LaunchAgents', 'music.tess.wake.plist');
  assert.ok(existsSync(installedPlist), 'updater installs wake LaunchAgent in sandbox');
  assert.match(readFileSync(installedPlist, 'utf8'), /<integer>300<\/integer>/);

  console.log('wake tests passed (no change, version, serial, off, network backoff, lock, 5-minute agent)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
