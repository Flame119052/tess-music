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
for (const name of ['README.md', 'installer/README.md', 'SECURITY.md']) {
  const text = readFileSync(join(root, name), 'utf8');
  assert.match(text, /before 13 Nov 2026/, `${name} names the older rescue scripts`);
  assert.match(text, /any script/, `${name} says an older order can run a script`);
}
assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /Application\\ Support\/Tess\/tess rescue off/);
assert.match(readFileSync(join(root, 'installer/README.md'), 'utf8'), /Application\\ Support\/Tess\/tess rescue off/);
assert.match(installer, /remotely run five Tess actions on this Mac, without asking/);
assert.match(installer, /signed by the owner's offline rescue key/);
assert.match(installer, /older Tess rescue line/);
assert.match(installer, /can run any script on this Mac as you, without asking/);
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
  assert.doesNotMatch(out, /Rescue format: older/);

  out = run('rescue', 'off');
  assert.match(out, /rescue line is off/i);
  assert.ok(existsSync(join(tess, 'rescue-off')), 'off marker written');
  assert.ok(!existsSync(loadedRescue), 'rescue agent unloaded');
  assert.match(readFileSync(launchLog, 'utf8'), /bootout .*music\.tess\.rescue/);
  const offStatus = run('status');
  assert.match(offStatus, /Rescue: off \(verifier SHA-256/);
  assert.doesNotMatch(offStatus, /still loaded/);
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

  writeFileSync(join(tess, 'rescue-off'), '');
  writeFileSync(loadedRescue, '');
  writeFileSync(join(agents, 'music.tess.rescue.plist'), '<plist>music.tess.rescue</plist>\n');
  const stillLoaded = run('status');
  assert.match(stillLoaded, /Rescue: off, but the agent is still loaded; run: tess rescue off/);
  assert.match(stillLoaded, new RegExp(`verifier SHA-256 ${fingerprint}`));
  assert.match(stillLoaded, /Rescue format: older \(a signed order can run any script as you/);
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 22\n');
  chmodSync(join(bin, 'curl'), 0o755);
  writeFileSync(join(tess, 'doctor.sh'), readFileSync(join(root, 'installer', 'doctor.sh')));
  chmodSync(join(tess, 'doctor.sh'), 0o755);
  const doctorOut = execFileSync('/bin/zsh', [join(tess, 'doctor.sh')], { env, encoding: 'utf8' });
  assert.match(doctorOut, /stopped the rescue line you turned off/);
  assert.ok(!existsSync(loadedRescue), 'doctor unloads a rescue agent that is still running while off');
  assert.ok(!existsSync(join(agents, 'music.tess.rescue.plist')), 'doctor removes the rescue login plist while off');
  assert.ok(existsSync(join(box, 'rescue-disabled')), 'doctor disables the rescue job while off');
  const stopped = run('status');
  assert.match(stopped, /Rescue: off \(verifier SHA-256/);
  assert.doesNotMatch(stopped, /still loaded/);

  rmSync(loadedRescue, { force: true });
  rmSync(join(box, 'rescue-disabled'), { force: true });
  writeFileSync(join(tess, 'rescue-off'), '');
  writeFileSync(join(agents, 'music.tess.rescue.plist'), 'leftover plist\n');
  const unloaded = execFileSync('/bin/zsh', [join(tess, 'doctor.sh')], { env, encoding: 'utf8' });
  assert.match(unloaded, /removed the rescue line's login file/);
  assert.doesNotMatch(unloaded, /stopped the rescue line you turned off/);
  assert.ok(!existsSync(join(agents, 'music.tess.rescue.plist')), 'doctor removes a rescue login plist that is not loaded');
  assert.ok(existsSync(join(box, 'rescue-disabled')), 'doctor disables rescue even when the job is not loaded');

  rmSync(join(rescue, 'tess-rescue-verify'));
  rmSync(join(tess, 'rescue-off'), { force: true });
  const missing = run('status');
  assert.match(missing, /Rescue: not installed/);
  assert.doesNotMatch(missing, /Rescue: on/);
  writeFileSync(join(tess, 'rescue-off'), '');
  const missingOff = run('status');
  assert.match(missingOff, /Rescue: not installed/);
  assert.doesNotMatch(missingOff, /Rescue: off \(/);

  const predicate = readFileSync(join(root, 'installer', 'doctor.sh'), 'utf8').match(/real_launchctl\(\) \{[^}]+\}/);
  assert.ok(predicate, 'doctor defines the sandbox launchctl guard');
  const predict = (path) => execFileSync('/bin/sh', ['-c', `
${predicate[0]}
if ! real_launchctl && launchctl print "gui/1/music.tess.rescue"; then echo CALLED; else echo SKIPPED; fi
`], { env: { ...env, TESS_TEST: '1', PATH: path }, encoding: 'utf8' });
  const probeBin = join(box, 'probe-bin');
  mkdirSync(probeBin);
  writeFileSync(join(probeBin, 'launchctl'), '#!/bin/sh\necho "$@"\nexit 0\n');
  chmodSync(join(probeBin, 'launchctl'), 0o755);
  assert.match(predict(`/bin:${probeBin}`), /SKIPPED/, 'TESS_TEST does not call /bin/launchctl');
  const called = predict(`${probeBin}:/bin`);
  assert.match(called, /print gui\/1\/music.tess.rescue/, 'a fake launchctl is still used in the sandbox');
  assert.match(called, /CALLED/);

  console.log('rescue control tests passed (notice, off/on persistence, status fingerprint, loaded-while-off, sandbox launchctl)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
