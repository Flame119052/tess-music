// Test the installed tess rescue switch and status command with sandbox folders and a fake launchctl.
// Usage: node tools/test-rescue-control.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = readFileSync(join(root, 'installer', 'tess-install.sh'), 'utf8');
const command = readFileSync(join(root, 'installer', 'tess-command.sh'), 'utf8');
assert.match(installer, /remotely run five Tess actions on this Mac, without asking/);
assert.match(installer, /signed by the owner's offline rescue key/);
assert.match(installer, /rescue off/);

const box = mkdtempSync(join(tmpdir(), 'tess-rescue-control-'));
const tess = join(box, 'Tess');
const state = join(tess, 'state');
const rescue = join(tess, 'rescue');
const agents = join(tess, 'LaunchAgents');
const bin = join(box, 'bin');
const launchLog = join(box, 'launchctl.log');
const loadedRescue = join(box, 'rescue-loaded');
const loadedGuard = join(box, 'guard-loaded');
const spotify = join(box, 'Spotify.app');
const config = join(box, 'config');

try {
  mkdirSync(state, { recursive: true });
  mkdirSync(rescue, { recursive: true });
  mkdirSync(agents, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(tess, 'tess'), command);
  chmodSync(join(tess, 'tess'), 0o755);
  writeFileSync(join(state, 'version'), '1.2.3\n');
  writeFileSync(join(tess, 'updater.env'), `SPOTIFY='${spotify}'\nTESS_CONFIG='${config}'\nTESS_PARTS_CHANNEL='beta'\n`);
  writeFileSync(join(rescue, 'tess-rescue-verify'), 'test rescue verifier\n');
  chmodSync(join(rescue, 'tess-rescue-verify'), 0o755);
  writeFileSync(join(agents, 'music.tess.rescue.plist'), '<plist>music.tess.rescue</plist>\n');
  mkdirSync(join(spotify, 'Contents', 'Resources', 'Apps', 'xpui'), { recursive: true });
  writeFileSync(join(spotify, 'Contents', 'Resources', 'Apps', 'xpui', 'index.html'), 'spicetifyWrapper\n');
  writeFileSync(loadedRescue, '');
  writeFileSync(loadedGuard, '');
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh
echo "$@" >> "$TESS_TEST_BOX/launchctl.log"
case "$1:$2" in
  print:*music.tess.guard) [ -f "$TESS_TEST_BOX/guard-loaded" ] ;;
  print:*music.tess.rescue) [ -f "$TESS_TEST_BOX/rescue-loaded" ] ;;
  bootout:*music.tess.rescue) rm -f "$TESS_TEST_BOX/rescue-loaded" ;;
  disable:*) touch "$TESS_TEST_BOX/rescue-disabled" ;;
  enable:*) rm -f "$TESS_TEST_BOX/rescue-disabled" ;;
  login:*)
    [ -f "$TESS_TEST_BOX/rescue-disabled" ] || [ ! -f "$TESS_LAUNCH_AGENTS/music.tess.rescue.plist" ] || touch "$TESS_TEST_BOX/rescue-loaded"
    exit 0 ;;
  print:*music.tess.wake) exit 1 ;;
  bootstrap:*) touch "$TESS_TEST_BOX/rescue-loaded" ;;
esac
`);
  chmodSync(join(bin, 'launchctl'), 0o755);

  const env = {
    ...process.env,
    TESS_HOME: tess,
    TESS_TEST: '1',
    TESS_LAUNCH_AGENTS: agents,
    TESS_TEST_BOX: box,
    PATH: `${bin}:${process.env.PATH}`,
  };
  const run = (...args) => execFileSync('/bin/sh', [join(tess, 'tess'), ...args], { env, encoding: 'utf8' });
  const fingerprint = createHash('sha256').update('test rescue verifier\n').digest('hex');

  let out = run('status');
  assert.match(out, /Tess 1\.2\.3 \(beta\)/);
  assert.match(out, /Updater: running/);
  assert.match(out, new RegExp(`Rescue: on, running \\(verifier SHA-256 ${fingerprint}\\)`));
  assert.match(out, /Reports: on/);
  assert.match(out, /Wake check: stopped/);

  out = run('rescue', 'off');
  assert.match(out, /rescue line is off/i);
  assert.ok(existsSync(join(tess, 'rescue-off')), 'off marker written');
  assert.ok(!existsSync(loadedRescue), 'rescue agent unloaded');
  assert.match(readFileSync(launchLog, 'utf8'), /bootout .*music\.tess\.rescue/);
  assert.match(run('status'), /Rescue: off/);
  assert.ok(!existsSync(join(agents, 'music.tess.rescue.plist')), 'off removes login plist');
  assert.ok(existsSync(join(box, 'rescue-disabled')), 'off persists in launchd disabled state');
  execFileSync(join(bin, 'launchctl'), ['login'], { env });
  assert.ok(!existsSync(loadedRescue), 'simulated login cannot start old rescue script');

  const packagedRescue = join(tess, 'bin', 'patcher', 'rescue');
  mkdirSync(packagedRescue, { recursive: true });
  writeFileSync(join(packagedRescue, 'tess-rescue-verify'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(packagedRescue, 'rescue.sh'), '#!/bin/zsh\nexit 0\n');
  chmodSync(join(packagedRescue, 'tess-rescue-verify'), 0o755);
  chmodSync(join(packagedRescue, 'rescue.sh'), 0o755);
  writeFileSync(join(tess, 'updater.sh'), readFileSync(join(root, 'installer', 'updater.sh')));
  writeFileSync(join(agents, 'music.tess.rescue.plist'), 'stale login plist');
  execFileSync('/bin/zsh', [join(tess, 'updater.sh')], { env: { ...env, TESS_TEST: '1' }, encoding: 'utf8' });
  assert.ok(existsSync(join(tess, 'rescue-off')), 'update kept the off marker');
  assert.ok(!existsSync(loadedRescue), 'update did not reload rescue');
  assert.ok(!existsSync(join(agents, 'music.tess.rescue.plist')), 'updater removes stale rescue plist');
  assert.match(readFileSync(join(tess, 'guard.log'), 'utf8'), /rescue line stays off/);

  writeFileSync(join(tess, 'reports-off'), '');
  assert.match(run('status'), /Reports: off/);

  writeFileSync(join(rescue, 'rescue.sh'), '#!/bin/zsh\nexit 1\n');
  chmodSync(join(rescue, 'rescue.sh'), 0o755);
  assert.throws(() => run('rescue', 'on'), /Command failed/);
  assert.ok(existsSync(join(tess, 'rescue-off')), 'failed adoption stays off');
  assert.ok(!existsSync(loadedRescue), 'failed adoption does not start agent');
  writeFileSync(join(rescue, 'rescue.sh'), '#!/bin/zsh\nexit 0\n');
  mkdirSync(join(tess, '.installing'));
  writeFileSync(join(tess, 'updater.sh'), '#!/bin/zsh\necho unexpected-update >&2; exit 99\n');
  out = run('rescue', 'on');
  assert.match(out, /rescue line is on/i);
  assert.match(out, /including one sent while it was off/);
  assert.ok(!existsSync(join(box, 'rescue-disabled')), 'on enables launchd job');
  assert.ok(!existsSync(join(tess, 'rescue-off')), 'off marker removed');
  assert.ok(existsSync(loadedRescue), 'rescue agent loaded despite updater lock');
  execFileSync('/usr/bin/plutil', ['-lint', join(agents, 'music.tess.rescue.plist')]);
  assert.equal(readFileSync(join(rescue, 'tess-rescue-verify'), 'utf8'), 'test rescue verifier\n', 'ordinary update preserves independent rescue verifier');
  assert.match(readFileSync(launchLog, 'utf8'), /bootstrap .*music\.tess\.rescue\.plist/);

  console.log('rescue control tests passed (notice, off/on persistence, status fingerprint)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
