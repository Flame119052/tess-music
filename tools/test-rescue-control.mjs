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
const command = installer.match(/cat > "\$HOME_TESS\/tess" <<'EOF'\n([\s\S]*?)\nEOF\nchmod \+x "\$HOME_TESS\/tess"/)?.[1];
assert.ok(command, 'installed tess command found');
assert.match(installer, /limited to five actions: check, update, repair, restore Spotify, or uninstall Tess/);
assert.match(installer, /signed by the owner's offline rescue key/);
assert.match(installer, /rescue off/);

const box = mkdtempSync(join(tmpdir(), 'tess-rescue-control-'));
const tess = join(box, 'Tess');
const state = join(tess, 'state');
const rescue = join(tess, 'rescue');
const agents = join(box, 'LaunchAgents');
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
  bootstrap:*) touch "$TESS_TEST_BOX/rescue-loaded" ;;
esac
`);
  chmodSync(join(bin, 'launchctl'), 0o755);

  const env = {
    ...process.env,
    TESS_HOME: tess,
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

  out = run('rescue', 'off');
  assert.match(out, /rescue line is off/i);
  assert.ok(existsSync(join(tess, 'rescue-off')), 'off marker written');
  assert.ok(!existsSync(loadedRescue), 'rescue agent unloaded');
  assert.match(readFileSync(launchLog, 'utf8'), /bootout .*music\.tess\.rescue/);
  assert.match(run('status'), /Rescue: off/);

  const packagedRescue = join(tess, 'bin', 'patcher', 'rescue');
  mkdirSync(packagedRescue, { recursive: true });
  writeFileSync(join(packagedRescue, 'tess-rescue-verify'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(packagedRescue, 'rescue.sh'), '#!/bin/zsh\nexit 0\n');
  chmodSync(join(packagedRescue, 'tess-rescue-verify'), 0o755);
  chmodSync(join(packagedRescue, 'rescue.sh'), 0o755);
  writeFileSync(join(tess, 'updater.sh'), readFileSync(join(root, 'installer', 'updater.sh')));
  execFileSync('/bin/zsh', [join(tess, 'updater.sh')], { env: { ...env, TESS_TEST: '1' }, encoding: 'utf8' });
  assert.ok(existsSync(join(tess, 'rescue-off')), 'update kept the off marker');
  assert.ok(!existsSync(loadedRescue), 'update did not reload rescue');
  assert.match(readFileSync(join(tess, 'guard.log'), 'utf8'), /rescue line stays off/);

  writeFileSync(join(tess, 'reports-off'), '');
  assert.match(run('status'), /Reports: off/);

  out = run('rescue', 'on');
  assert.match(out, /rescue line is on/i);
  assert.ok(!existsSync(join(tess, 'rescue-off')), 'off marker removed');
  assert.ok(existsSync(loadedRescue), 'rescue agent loaded');
  assert.match(readFileSync(launchLog, 'utf8'), /bootstrap .*music\.tess\.rescue\.plist/);

  console.log('rescue control tests passed (notice, off/on persistence, status fingerprint)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
