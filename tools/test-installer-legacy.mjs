// Older promoted channels must remain installable when newer optional parts are absent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const withCommand = process.argv.includes('--command');
const box = mkdtempSync(join(tmpdir(), 'tess-legacy-install-'));
try {
  const home = join(box, 'home'), fixtures = join(box, 'fixtures'), bin = join(box, 'bin');
  const tess = join(home, 'Tess'), config = join(home, 'config');
  const source = join(box, 'fake-source.app'), spotify = join(box, 'Spotify.app');
  for (const dir of [home, fixtures, bin, join(source, 'Contents/Resources/Apps'), join(source, 'Contents/MacOS'), join(home, 'Library/Application Support/Spotify'), join(fixtures, 'p'), join(fixtures, 'theme/Tess')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, 'Library/Application Support/Spotify/prefs'), '');
  writeFileSync(join(source, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.3.9.2055</string></dict></plist>');
  writeFileSync(join(source, 'Contents/Resources/Apps/xpui.spa'), 'fake stock Spotify');
  cpSync(source, spotify, { recursive: true });
  const script = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };
  script(join(fixtures, 'p/tess-verify'), '#!/bin/sh\nexit 0\n');
  script(join(fixtures, 'p/tess-patcher'), `#!/bin/sh
case "$*" in
  *"backup apply"*) mkdir -p "$TESS_SPOTIFY/Contents/Resources/Apps/xpui"; echo spicetifyWrapper > "$TESS_SPOTIFY/Contents/Resources/Apps/xpui/index.html" ;;
esac
exit 0
`);
  writeFileSync(join(fixtures, 'theme/Tess/theme.js'), 'TESS_BASELINE');
  execFileSync('tar', ['-czf', join(fixtures, 'patcher.tgz'), '-C', join(fixtures, 'p'), '.']);
  execFileSync('tar', ['-czf', join(fixtures, 'theme.tgz'), '-C', join(fixtures, 'theme'), 'Tess']);
  writeFileSync(join(fixtures, 'updater.sh'), readFileSync(join(root, 'installer/updater.sh')));
  const parts = [['patcher', 'patcher.tgz'], ['theme', 'theme.tgz'], ['updater', 'updater.sh']];
  if (withCommand) {
    writeFileSync(join(fixtures, 'command.sh'), readFileSync(join(root, 'installer/tess-command.sh')));
    parts.push(['command', 'command.sh']);
  }
  writeFileSync(join(fixtures, 'components.txt'), parts.map(([n, f]) => `${n} ${createHash('sha256').update(readFileSync(join(fixtures, f))).digest('hex')} test://${f} source`).join('\n') + '\nversion 1.0.0\n');
  writeFileSync(join(fixtures, 'components.sig'), 'fixture-signature');
  script(join(bin, 'curl'), `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; *://*) url=$1; shift ;; *) shift ;; esac; done
case "$url" in
  *components.txt*) cp "$FIXTURES/components.txt" "$out" ;;
  *components.sig*) cp "$FIXTURES/components.sig" "$out" ;;
  test://*) cp "$FIXTURES/\${url#test://}" "$out" ;;
  *) exit 22 ;;
esac
`);
  script(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n');
  script(join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n');
  const output = execFileSync('/bin/sh', [join(root, 'installer/tess-install.sh')], { env: { ...process.env, HOME: home, TESS_TEST: '1', TESS_HOME: tess, TESS_CONFIG: config, TESS_SPOTIFY: spotify, FIXTURES: fixtures, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.match(output, /Test install.*finished/);
  assert.match(output, /remotely.*without asking/);
  assert.match(readFileSync(join(spotify, 'Contents/Resources/Apps/xpui/index.html'), 'utf8'), /spicetifyWrapper/);
  for (const part of ['installer', 'uninstall', 'wake', ...(withCommand ? [] : ['command'])]) assert.ok(!existsSync(join(tess, 'state', part)), `${part} absent, no false installed state`);
  assert.equal(readFileSync(join(tess, 'tess'), 'utf8'), readFileSync(join(root, 'installer/tess-command.sh'), 'utf8'), 'installer installs signed command');
  assert.equal(readFileSync(join(source, 'Contents/Resources/Apps/xpui.spa'), 'utf8'), 'fake stock Spotify');
  const env = { ...process.env, HOME: home, TESS_TEST: '1', TESS_HOME: tess, TESS_CONFIG: config, TESS_SPOTIFY: spotify, FIXTURES: fixtures, PATH: `${bin}:${process.env.PATH}` };
  const repair = execFileSync('/bin/sh', [join(tess, 'tess'), 'repair'], { env, encoding: 'utf8' });
  assert.match(repair, /Test install.*finished/);
  const uninstall = execFileSync('/bin/sh', [join(tess, 'tess'), 'uninstall'], { env, encoding: 'utf8' });
  assert.match(uninstall, /Spotify is back to normal/);
  assert.ok(!existsSync(tess), 'tess uninstall removes TESS_HOME');
  assert.ok(!existsSync(config), 'tess uninstall removes sandbox config');
  console.log('legacy repair and uninstall actually ran in sandbox; TESS_HOME removed');
  if (withCommand) console.log('signed command sandbox install passed');
  else console.log('legacy channel sandbox install passed (copied fake Spotify; list contains only patcher/theme/updater; installer/uninstall/wake/command absent; remote rescue notice shown)');
} finally { rmSync(box, { recursive: true, force: true }); }
