// Sandbox updater tests: signed part success, blocked/failed Spotify writes, rollback/no-retry, and playing deferral.
// Usage: node tools/test-updater.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const boxes = [];
const sha = (text) => createHash('sha256').update(text).digest('hex');

function sandbox({ stock = false, fresh = false, realDoctor = false } = {}) {
  const box = mkdtempSync(join(tmpdir(), 'tess-updater-test-'));
  boxes.push(box);
  const tess = join(box, 'Tess');
  const state = join(tess, 'state');
  const bin = join(box, 'fake-bin');
  const spotify = join(box, 'Spotify.app');
  const apps = join(spotify, 'Contents', 'Resources', 'Apps');
  const config = join(box, 'config');
  const fixtures = join(box, 'fixtures');
  for (const dir of [state, bin, apps, config, fixtures, join(tess, 'bin', 'patcher')]) mkdirSync(dir, { recursive: true });

  writeFileSync(join(spotify, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.3.9.2055</string></dict></plist>
`);
  if (stock) {
    writeFileSync(join(apps, 'xpui.spa'), 'stock Spotify interface\n');
  } else {
    mkdirSync(join(apps, 'xpui', 'extensions'), { recursive: true });
    writeFileSync(join(apps, 'xpui', 'index.html'), 'spicetifyWrapper\n');
    writeFileSync(join(apps, 'xpui', 'extensions', 'theme.js'), 'TESS_BASELINE\n');
    writeFileSync(join(apps, 'xpui', 'user.css'), 'old css\n');
  }

  writeFileSync(join(tess, 'updater.sh'), readFileSync(join(root, 'installer', 'updater.sh')));
  writeFileSync(join(tess, 'wake.sh'), readFileSync(join(root, 'installer', 'wake.sh')));
  chmodSync(join(tess, 'updater.sh'), 0o755);
  chmodSync(join(tess, 'wake.sh'), 0o755);
  writeFileSync(join(tess, 'updater.env'), `SPOTIFY='${spotify}'\nTESS_CONFIG='${config}'\nTESS_PARTS_CHANNEL='beta'\n`);
  writeFileSync(join(tess, 'doctor.sh'), realDoctor ? readFileSync(join(root, 'installer', 'doctor.sh')) : `#!/bin/zsh
echo "$1" >> "$TESS_DOCTOR_LOG"
if [ "$1" = --validate ] && [ -f "$TESS_REJECT" ] && grep -q "new installer" "$TESS_HOME/installer.sh"; then exit 1; fi
if [ "$1" = --report ]; then touch "$TESS_REPORTED"; fi
exit 0
`);
  chmodSync(join(tess, 'doctor.sh'), 0o755);
  writeFileSync(join(tess, 'installer.sh'), 'old installed installer\n');
  chmodSync(join(tess, 'installer.sh'), 0o755);
  if (!fresh) writeFileSync(join(state, 'installer'), `${sha('old installed installer\n')}\n`);
  writeFileSync(join(state, '.heartbeat'), '');

  writeFileSync(join(tess, 'bin', 'patcher', 'tess-verify'), '#!/bin/sh\n[ "$TESS_VERIFY_FAIL" = 1 ] && exit 1\nexit 0\n');
  writeFileSync(join(tess, 'bin', 'patcher', 'tess-patcher'), `#!/bin/zsh
APPS="$TESS_TEST_SPOTIFY/Contents/Resources/Apps"
case "$*" in
  *can-write*) exit "\${TESS_CAN_WRITE:-0}" ;;
  *"backup apply"*)
    echo apply >> "$TESS_PATCHER_LOG"
    stage="$APPS.tess-fake"; rm -rf "$stage"; mkdir -p "$stage/xpui/extensions"
    echo spicetifyWrapper > "$stage/xpui/index.html"
    echo TESS_BASELINE > "$stage/xpui/extensions/theme.js"
    if [ "$TESS_APPLY_FAIL" = 1 ]; then
      echo partial > "$stage/xpui/index.html"
      rm -rf "$APPS"; mv "$stage" "$APPS"; exit 1
    fi
    rm -rf "$APPS"; mv "$stage" "$APPS"; exit 0 ;;
  *" -v"*|-v) exit 0 ;;
  *config*) exit 0 ;;
esac
exit 0
`);
  chmodSync(join(tess, 'bin', 'patcher', 'tess-verify'), 0o755);
  chmodSync(join(tess, 'bin', 'patcher', 'tess-patcher'), 0o755);

  writeFileSync(join(bin, 'pmset'), '#!/bin/sh\n[ "$TESS_PLAYING" = 1 ] && echo \'pid 42(Spotify): PreventUserIdleSystemSleep named: "Spotify playing audio"\'\n');
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\necho "$@" >> "$TESS_LAUNCH_LOG"\nexit 0\n');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
echo "$@" >> "$TESS_CURL_LOG"
[ "$TESS_LIST_FAIL" = 1 ] && exit 22
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    *://*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *components.txt*) cp "$TESS_COMPONENTS" "$out" ;;
  *components.sig*) cp "$TESS_SIGNATURE" "$out" ;;
  test://installer) cp "$TESS_ASSET" "$out" ;;
  *) exit 22 ;;
esac
`);
  for (const name of ['pmset', 'launchctl', 'curl']) chmodSync(join(bin, name), 0o755);

  const asset = '#!/bin/sh\necho new installer\n';
  const assetSha = sha(asset);
  writeFileSync(join(fixtures, 'installer.sh'), asset);
  writeFileSync(join(fixtures, 'components.txt'), `installer ${assetSha} test://installer test-source\nversion 9.9.9\n`);
  writeFileSync(join(fixtures, 'components.sig'), 'test-signature\n');

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TESS_TEST: '1',
    TESS_HOME: tess,
    TESS_CONFIG: config,
    TESS_TEST_SPOTIFY: spotify,
    TESS_FORCE: '1',
    TESS_COMPONENTS: join(fixtures, 'components.txt'),
    TESS_SIGNATURE: join(fixtures, 'components.sig'),
    TESS_ASSET: join(fixtures, 'installer.sh'),
    TESS_CURL_LOG: join(box, 'curl.log'),
    TESS_DOCTOR_LOG: join(box, 'doctor.log'),
    TESS_PATCHER_LOG: join(box, 'patcher.log'),
    TESS_LAUNCH_LOG: join(box, 'launchctl.log'),
    TESS_REJECT: join(box, 'reject'),
    TESS_REPORTED: join(box, 'reported'),
  };
  const run = (extra = {}) => execFileSync('/bin/zsh', [join(tess, 'updater.sh')], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { box, tess, state, spotify, apps, config, fixtures, env, asset, assetSha, run };
}

try {
  {
    const s = sandbox({ realDoctor: true });
    s.run();
    assert.equal(readFileSync(join(s.tess, 'installer.sh'), 'utf8'), s.asset, 'signed part installed');
    assert.equal(readFileSync(join(s.tess, 'installer.last-good'), 'utf8'), 'old installed installer\n');
    assert.equal(readFileSync(join(s.state, 'installer'), 'utf8').trim(), s.assetSha);
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /installer: updated/);
    const guard = readFileSync(join(s.tess, 'LaunchAgents', 'music.tess.guard.plist'), 'utf8');
    assert.match(guard, /<integer>1800<\/integer>/);
    assert.match(guard, /<key>WatchPaths<\/key>/);
  }

  {
    const s = sandbox({ fresh: true });
    rmSync(join(s.tess, 'installer.sh'));
    s.run();
    assert.equal(readFileSync(join(s.tess, 'installer.sh'), 'utf8'), s.asset, 'fresh state installs part');
    assert.ok(existsSync(join(s.tess, 'LaunchAgents', 'music.tess.wake.plist')), 'fresh state installs wake agent');
  }

  {
    const s = sandbox();
    writeFileSync(join(s.tess, 'doctor.sh'), '#!/bin/zsh\nexit 1\n');
    s.run();
    assert.equal(readFileSync(join(s.tess, 'installer.sh'), 'utf8'), s.asset, 'pre-existing health failure does not ban good part');
    assert.ok(!existsSync(join(s.state, `bad-installer-${s.assetSha}`)));
  }

  {
    const s = sandbox();
    const command = readFileSync(join(root, 'installer', 'tess-command.sh'), 'utf8');
    writeFileSync(join(s.fixtures, 'installer.sh'), command);
    writeFileSync(join(s.fixtures, 'components.txt'), `command ${sha(command)} test://installer source\n`);
    s.run();
    assert.equal(readFileSync(join(s.tess, 'tess'), 'utf8'), command, 'existing Mac receives signed command');
    assert.match(execFileSync('/bin/sh', [join(s.tess, 'tess'), 'status'], { env: s.env, encoding: 'utf8' }), /Wake check:/);
  }

  {
    const s = sandbox({ stock: true });
    s.run({ TESS_CAN_WRITE: '3' });
    assert.equal(readFileSync(join(s.apps, 'xpui.spa'), 'utf8'), 'stock Spotify interface\n', 'blocked write leaves Spotify stock');
    assert.ok(!existsSync(join(s.box, 'patcher.log')), 'blocked write never applies');
    assert.ok(existsSync(join(s.state, '.asked-1.3.9.2055')), 'blocked state recorded once');
  }

  {
    const s = sandbox({ stock: true });
    s.run({ TESS_APPLY_FAIL: '1' });
    assert.equal(readFileSync(join(s.apps, 'xpui.spa'), 'utf8'), 'stock Spotify interface\n', 'failed apply restores complete stock Apps');
    assert.ok(!existsSync(join(s.apps, 'xpui')), 'partial Apps removed');
  }

  {
    const s = sandbox();
    writeFileSync(join(s.box, 'reject'), '');
    const before = readFileSync(join(s.tess, 'installer.sh'), 'utf8');
    s.run();
    assert.equal(readFileSync(join(s.tess, 'installer.sh'), 'utf8'), before, 'doctor rejection restores last good');
    assert.ok(existsSync(join(s.state, `bad-installer-${s.assetSha}`)), 'bad part marked');
    assert.ok(existsSync(join(s.box, 'reported')), 'rollback reported');
    const downloads = () => readFileSync(join(s.box, 'curl.log'), 'utf8').split('\n').filter((line) => line.includes('test://installer')).length;
    const firstDownloads = downloads();
    rmSync(join(s.box, 'reject'));
    s.run();
    assert.equal(downloads(), firstDownloads, 'known bad sha is not downloaded or retried');
    assert.equal(readFileSync(join(s.tess, 'installer.sh'), 'utf8'), before);
  }

  {
    const s = sandbox({ stock: true });
    s.run({ TESS_TEST_SPOTIFY_RUNNING: '1', TESS_PLAYING: '1' });
    assert.ok(!existsSync(join(s.box, 'patcher.log')), 'playing defers Spotify apply');
    assert.ok(!existsSync(join(s.state, '.reapply-tried-1.3.9.2055')), 'playing does not consume the retry');
    assert.equal(readFileSync(join(s.tess, 'installer.sh'), 'utf8'), s.asset, 'downloads continue while playing');
    s.run({ TESS_TEST_SPOTIFY_RUNNING: '1', TESS_PLAYING: '0' });
    assert.match(readFileSync(join(s.apps, 'xpui', 'index.html'), 'utf8'), /spicetifyWrapper/, 'idle run applies Tess');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /Spotify restarted \(test\)/);
  }

  {
    const s = sandbox();
    s.run({ TESS_LIST_FAIL: '1' });
    assert.ok(existsSync(join(s.state, '.parts-list-reported')), 'list failure report is rate-limited');
    assert.ok(existsSync(join(s.box, 'reported')), 'list failure reported');
    const reports = () => readFileSync(join(s.box, 'doctor.log'), 'utf8').split('\n').filter((line) => line === '--report').length;
    const first = reports();
    s.run({ TESS_LIST_FAIL: '1' });
    assert.equal(reports(), first, 'list failure reports only once a day');
  }

  {
    const s = sandbox();
    s.run({ TESS_VERIFY_FAIL: '1' });
    assert.ok(existsSync(join(s.state, '.parts-list-reported')), 'signature failure report is rate-limited');
    assert.ok(existsSync(join(s.box, 'reported')), 'signature failure reported');
  }

  console.log('updater tests passed (success, fresh, blocked, failed swap, rollback/no-retry, playing/idle, list reports)');
} finally {
  for (const box of boxes) rmSync(box, { recursive: true, force: true });
}
