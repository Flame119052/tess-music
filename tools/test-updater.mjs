// Sandbox updater tests: signed part success, blocked/failed Spotify writes, rollback/no-retry, and playing deferral.
// Also the private Tess Support invite (#137): an uninvited Mac does nothing, Not now is remembered, a timeout retries,
// a bad signature or download refuses before the invite is claimed, and Install verifies, claims once, and runs the
// installer with the token in its environment only.
// And the Liquid Glass card for that invite (#148): the signed `invite` part installs to bin/tess-invite and rolls back
// if the doctor rejects it, the updater uses it when it is there (exit 0 install, 1 not now, 2 not answered; progress,
// done and failed on its status file) and never hands it a token, and a Mac without it keeps the plain dialogs.
// Usage: node tools/test-updater.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const boxes = [];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const INSTALL_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SUPPORT_TOKEN = `tess_${'e'.repeat(64)}`;

function sandbox({ stock = false, fresh = false, realDoctor = false, tessName = 'Tess', denyDitto = false } = {}) {
  const box = mkdtempSync(join(tmpdir(), 'tess-updater-test-'));
  boxes.push(box);
  const tess = join(box, tessName);
  const state = join(tess, 'state');
  const bin = join(box, 'fake-bin');
  const spotify = join(box, 'Spotify.app');
  const apps = join(spotify, 'Contents', 'Resources', 'Apps');
  const config = join(box, 'config');
  const fixtures = join(box, 'fixtures');
  for (const dir of [state, bin, apps, config, fixtures, join(tess, 'bin', 'patcher')]) mkdirSync(dir, { recursive: true });

  writeFileSync(join(spotify, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.spotify.client</string><key>CFBundleShortVersionString</key><string>1.3.9.2055</string></dict></plist>
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
  // A known id, so an invite for this Mac can be made in a test (#137).
  writeFileSync(join(tess, 'install-id'), INSTALL_ID);
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

  writeFileSync(join(tess, 'bin', 'patcher', 'tess-verify'), `#!/bin/sh
[ "$TESS_VERIFY_FAIL" = 1 ] && exit 1
case "$1" in
  *support-install.sh) [ "$TESS_VERIFY_INSTALL_FAIL" = 1 ] && exit 1 ;;
esac
exit 0
`);
  writeFileSync(join(tess, 'bin', 'patcher', 'tess-patcher'), `#!/bin/zsh
APPS="$TESS_TEST_SPOTIFY/Contents/Resources/Apps"
case "$*" in
  *can-write*) exit "\${TESS_CAN_WRITE:-0}" ;;
  # The same checked swap the Go patcher does: copy beside Apps, check it, switch with two renames.
  *"swap-apps"*)
    [ -n "$TESS_SWAP_EXIT" ] && { echo "tess-patcher: macOS denied the copy" >&2; exit "$TESS_SWAP_EXIT"; }
    [ "$TESS_SWAP_FAIL" = 1 ] && exit 1
    dest=$2; src=$3
    [ -d "$src" ] || exit 1
    old="$dest.tess-old"; new="$dest.tess-new"
    if [ ! -d "$dest" ] && [ -d "$old" ]; then mv "$old" "$dest" || exit 1; fi
    rm -rf "$new"; mkdir -p "$new" || exit 3
    cp -R "$src"/. "$new"/ || { rm -rf "$new"; exit 1; }
    { [ -s "$new/xpui.spa" ] || [ -s "$new/xpui/index.html" ]; } || { rm -rf "$new"; exit 1; }
    rm -rf "$old"
    if [ -d "$dest" ]; then mv "$dest" "$old" || { rm -rf "$new"; exit 1; }; fi
    mv "$new" "$dest" || { [ -d "$old" ] && mv "$old" "$dest"; rm -rf "$new"; exit 1; }
    rm -rf "$old"; exit 0 ;;
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
  writeFileSync(join(bin, 'open'), '#!/bin/sh\necho "$@" >> "$TESS_OPEN_LOG"\nexit 0\n');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
echo "$@" >> "$TESS_CURL_LOG"
[ "$TESS_LIST_FAIL" = 1 ] && exit 22
out=""; url=""; fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -w) fmt=$2; shift 2 ;;
    *://*) url=$1; shift ;;
    *) shift ;;
  esac
done
# <body> <status>: the body goes where -o points, and -w '%{http_code}' prints the status, as curl does.
send() {
  if [ -n "$out" ]; then printf '%s' "$1" > "$out"; else printf '%s' "$1"; fi
  [ "$fmt" = '%{http_code}' ] && printf '%s' "$2"
  return 0
}
case "$url" in
  *components.txt*) cp "$TESS_COMPONENTS" "$out" ;;
  *components.sig*) cp "$TESS_SIGNATURE" "$out" ;;
  */v1/support/invite/check)
    [ "$TESS_INVITE_CHECK_FAIL" = 1 ] && exit 22
    send "\${TESS_INVITE_CHECK_JSON-{\\"invited\\":false}}" 200 ;;
  */v1/support/invite/claim)
    # A network miss is an exit code, not a status: it must never look like an answer.
    [ "$TESS_INVITE_CLAIM_FAIL" = 1 ] && exit 22
    send "\${TESS_INVITE_CLAIM_JSON-{\\"error\\":\\"not found\\"}}" "\${TESS_INVITE_CLAIM_STATUS:-200}" ;;
  *support-install.sig)
    [ "$TESS_SUPPORT_ASSET_FAIL" = 1 ] && exit 22
    cp "$TESS_SUPPORT_SIG" "$out" ;;
  *support-install.sh)
    [ "$TESS_SUPPORT_ASSET_FAIL" = 1 ] && exit 22
    cp "$TESS_SUPPORT_INSTALL" "$out" ;;
  *dist/manifest.json) send '{"version":"10.0.0"}' 200 ;;
  test://doctor) cp "$TESS_DOCTOR_ASSET" "$out" ;;
  test://installer) cp "$TESS_ASSET" "$out" ;;
  test://invite) cp "$TESS_INVITE_ASSET" "$out" ;;
  *) exit 22 ;;
esac
`);
  for (const name of ['pmset', 'launchctl', 'curl', 'open']) chmodSync(join(bin, name), 0o755);
  if (denyDitto) {
    // macOS App Management, as the kernel enforces it for a script launchd started under /bin/zsh: /usr/bin/ditto
    // may not create anything inside Spotify.app. Copying *out* of Spotify is allowed, which is what the staging does.
    writeFileSync(join(bin, 'ditto'), `#!/bin/sh
last=""
for a in "$@"; do case "$a" in -*) ;; *) last=$a ;; esac; done
case "$last" in
  "$TESS_TEST_SPOTIFY"/Contents/Resources/*)
    echo "ditto: $last: Operation not permitted" >&2
    echo "$last" >> "$TESS_DITTO_LOG"
    exit 71 ;;
esac
exec /usr/bin/ditto "$@"
`);
    chmodSync(join(bin, 'ditto'), 0o755);
  }

  const asset = '#!/bin/sh\necho new installer\n';
  const assetSha = sha(asset);
  const supportInstall = `#!/bin/sh
printf '%s' "\${TESS_SUPPORT_TOKEN-}" > "$TESS_INSTALL_TOKEN_OUT"
printf '%s' "$*" > "$TESS_INSTALL_ARGV_OUT"
[ -n "\${TESS_INSTALL_SLEEP-}" ] && sleep "$TESS_INSTALL_SLEEP"
exit "\${TESS_INSTALL_EXIT:-0}"
`;
  const supportInstallSha = sha(supportInstall);
  writeFileSync(join(fixtures, 'installer.sh'), asset);
  writeFileSync(join(fixtures, 'components.txt'), `installer ${assetSha} test://installer test-source\nversion 9.9.9\nsupport-install ${supportInstallSha}\n`);
  writeFileSync(join(fixtures, 'components.sig'), 'test-signature\n');
  // The signed Tess Support installer (real one: support/mac/install.sh). The sandbox stands in for it with a stub that
  // records the token it was handed, so the test can prove how it arrived.
  writeFileSync(join(fixtures, 'support-install.sh'), supportInstall);
  writeFileSync(join(fixtures, 'support-install.sig'), 'support-signature\n');

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
    TESS_DITTO_LOG: join(box, 'ditto.log'),
    TESS_REJECT: join(box, 'reject'),
    TESS_REPORTED: join(box, 'reported'),
    // The invite check and the support installer (#137). The inbox here is the fake curl's own address, so a sandbox
    // can never reach the real Worker.
    TESS_INBOX: 'test://inbox',
    TESS_SUPPORT_CONFIG: join(box, 'hermes', 'profiles', 'tess-support', 'config.yaml'),
    TESS_SUPPORT_INSTALL: join(fixtures, 'support-install.sh'),
    TESS_SUPPORT_SIG: join(fixtures, 'support-install.sig'),
    TESS_INSTALL_TOKEN_OUT: join(box, 'support-token.out'),
    TESS_INSTALL_ARGV_OUT: join(box, 'support-argv.out'),
    TESS_OPEN_LOG: join(box, 'open.log'),
  };
  const run = (extra = {}) => execFileSync('/bin/zsh', [join(tess, 'updater.sh')], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { box, tess, state, spotify, apps, config, fixtures, env, asset, assetSha, run };
}

try {
  const doctorCalls = (s) => {
    const file = join(s.box, 'doctor.log');
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  };
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
    // A Tess folder whose name carries & and < still has to produce launchd files macOS can read (SEC-19).
    const s = sandbox({ tessName: 'Tom & Jerry <Tess>' });
    s.run();
    for (const name of ['music.tess.guard.plist', 'music.tess.wake.plist']) {
      const pl = join(s.tess, 'LaunchAgents', name);
      assert.ok(existsSync(pl), `${name} was written for a folder name with & and <`);
      const xml = readFileSync(pl, 'utf8');
      assert.match(xml, /&amp;/, `${name} escapes &`);
      assert.match(xml, /&lt;/, `${name} escapes <`);
      execFileSync('/usr/bin/plutil', ['-lint', pl]);
    }
    // The same escaping for an AppleScript string, which would otherwise end the notification early.
    const asEsc = readFileSync(join(root, 'installer', 'updater.sh'), 'utf8').match(/^as_esc\(\) \{.*\}$/m);
    assert.ok(asEsc, 'updater defines as_esc');
    assert.equal(execFileSync('/bin/sh', ['-c', `${asEsc[0]}\nas_esc 'Spotify 1.3.9 "beta" \\ ok'`], { encoding: 'utf8' }),
      'Spotify 1.3.9 \\"beta\\" \\\\ ok');
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
    writeFileSync(join(s.tess, 'uninstall.sh'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(s.fixtures, 'installer.sh'), command);
    writeFileSync(join(s.fixtures, 'components.txt'), `command ${sha(command)} test://installer source\n`);
    s.run();
    assert.equal(readFileSync(join(s.tess, 'tess'), 'utf8'), command, 'existing Mac receives signed command');
    assert.match(execFileSync('/bin/sh', [join(s.tess, 'tess'), 'status'], { env: s.env, encoding: 'utf8' }), /Wake check:/);
  }

  {
    // installer, uninstall and the command can arrive together. If the installer download fails, the command
    // must stay uninstalled and unrecorded, or the Mac keeps a tess whose installer.sh is missing until a later
    // parts list happens to change the command's sha.
    const s = sandbox();
    rmSync(join(s.tess, 'installer.sh'));
    const command = '#!/bin/sh\necho tess-command\n';
    const installer = '#!/bin/sh\necho new installer\n';
    const uninstall = '#!/bin/sh\necho new uninstall\n';
    writeFileSync(join(s.fixtures, 'command.sh'), command);
    writeFileSync(join(s.fixtures, 'new-installer.sh'), installer);
    writeFileSync(join(s.fixtures, 'uninstall.sh'), uninstall);
    writeFileSync(join(s.fixtures, 'components.txt'), [
      `installer ${sha(installer)} test://new-installer source`,
      `uninstall ${sha(uninstall)} test://uninstall source`,
      `command ${sha(command)} test://command source`,
      '',
    ].join('\n'));
    writeFileSync(join(s.box, 'fake-bin', 'curl'), `#!/bin/sh
echo "$@" >> "$TESS_CURL_LOG"
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
  test://new-installer) [ -f "$TESS_INSTALLER_FAIL" ] && exit 22; cp "$TESS_INSTALLER_ASSET" "$out" ;;
  test://uninstall) cp "$TESS_UNINSTALL_ASSET" "$out" ;;
  test://command) cp "$TESS_COMMAND_ASSET" "$out" ;;
  *) exit 22 ;;
esac
`);
    chmodSync(join(s.box, 'fake-bin', 'curl'), 0o755);
    const fail = join(s.box, 'installer-fail');
    writeFileSync(fail, '');
    const extra = {
      TESS_INSTALLER_FAIL: fail,
      TESS_INSTALLER_ASSET: join(s.fixtures, 'new-installer.sh'),
      TESS_UNINSTALL_ASSET: join(s.fixtures, 'uninstall.sh'),
      TESS_COMMAND_ASSET: join(s.fixtures, 'command.sh'),
    };
    s.run(extra);
    assert.ok(!existsSync(join(s.tess, 'installer.sh')), 'a failed installer download leaves the script missing');
    assert.equal(readFileSync(join(s.tess, 'uninstall.sh'), 'utf8'), uninstall, 'the uninstall part in the same update still installs');
    assert.ok(!existsSync(join(s.tess, 'tess')), 'the command is held back while installer.sh is missing');
    assert.ok(!existsSync(join(s.state, 'command')), 'the held-back command sha is not recorded');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /command: waiting for installer\/uninstall parts/);
    rmSync(fail);
    s.run(extra);
    assert.equal(readFileSync(join(s.tess, 'installer.sh'), 'utf8'), installer, 'the next run installs the installer');
    assert.equal(readFileSync(join(s.tess, 'tess'), 'utf8'), command, 'the next run installs the command once both scripts exist');
    assert.equal(readFileSync(join(s.state, 'command'), 'utf8').trim(), sha(command), 'the command sha is recorded only once it is installed');
  }

  {
    const s = sandbox({ stock: true });
    s.run({ TESS_CAN_WRITE: '3' });
    assert.equal(readFileSync(join(s.apps, 'xpui.spa'), 'utf8'), 'stock Spotify interface\n', 'blocked write leaves Spotify stock');
    assert.ok(!existsSync(join(s.box, 'patcher.log')), 'blocked write never applies');
    assert.ok(existsSync(join(s.state, '.asked-1.3.9.2055')), 'blocked state recorded once');
    assert.ok(doctorCalls(s).includes('--auto'), 'a blocked Spotify write still asks the doctor to repair Spotify');
  }

  {
    const s = sandbox({ stock: true });
    s.run({ TESS_APPLY_FAIL: '1' });
    assert.equal(readFileSync(join(s.apps, 'xpui.spa'), 'utf8'), 'stock Spotify interface\n', 'failed apply restores complete stock Apps');
    assert.ok(!existsSync(join(s.apps, 'xpui')), 'partial Apps removed');
  }

  {
    const s = sandbox();
    const newDoctor = '#!/bin/zsh\nexit 1\n';
    const installer = '#!/bin/sh\necho new installer\n';
    writeFileSync(join(s.fixtures, 'doctor.sh'), newDoctor);
    writeFileSync(join(s.fixtures, 'installer.sh'), installer);
    writeFileSync(join(s.fixtures, 'components.txt'), `doctor ${sha(newDoctor)} test://doctor source\ninstaller ${sha(installer)} test://installer source\n`);
    writeFileSync(join(s.tess, 'doctor.sh'), '#!/bin/zsh\nexit 0\n');
    s.run({ TESS_DOCTOR_ASSET: join(s.fixtures, 'doctor.sh') });
    assert.equal(readFileSync(join(s.tess, 'doctor.sh'), 'utf8'), newDoctor, 'a stricter doctor is not rolled back against the previous doctor');
    assert.ok(!existsSync(join(s.state, `bad-doctor-${sha(newDoctor)}`)), 'a stricter doctor is not banned');
    assert.equal(readFileSync(join(s.tess, 'installer.sh'), 'utf8'), installer, 'later parts use the new doctor as the baseline');
    assert.ok(!existsSync(join(s.state, `bad-installer-${sha(installer)}`)), 'a pre-existing doctor failure does not ban the next part');
  }

  {
    const s = sandbox();
    const src = join(s.tess, 'bin', 'patcher', 'rescue');
    mkdirSync(src);
    writeFileSync(join(src, 'tess-rescue-verify'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(src, 'rescue.sh'), '#!/bin/zsh\nexit 0\n');
    chmodSync(join(src, 'tess-rescue-verify'), 0o755);
    chmodSync(join(src, 'rescue.sh'), 0o755);
    s.run();
    assert.ok(!existsSync(join(s.tess, 'rescue', 'rescue.sh')), 'updater does not add a rescue line the notice never described');
    writeFileSync(join(s.state, 'rescue-notice-shown'), '');
    s.run();
    assert.equal(readFileSync(join(s.tess, 'rescue', 'rescue.sh'), 'utf8'), '#!/bin/zsh\nexit 0\n', 'updater may restore a rescue line after the notice');
    assert.ok(!existsSync(join(s.state, 'rescue-notice-pending')), 'a Mac that was already told is not told again');
    s.run();
    assert.ok(!existsSync(join(s.state, 'rescue-notice-pending')), 'a later update does not mark a Mac that was already told');
  }

  {
    // The line is already on the Mac and rescue-notice-shown is absent: this person was never told.
    // The updater marks that once. A test run does not pop a notification; status prints it, records
    // that it was shown, and the next update does not mark it again.
    const s = sandbox();
    const src = join(s.tess, 'bin', 'patcher', 'rescue');
    const dst = join(s.tess, 'rescue');
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    const script = '#!/bin/zsh\ngrep -qx "tess-rescue 2" >/dev/null 2>&1 || true\nexit 0\n';
    const verify = '#!/bin/sh\nexit 0\n';
    for (const dir of [src, dst]) {
      writeFileSync(join(dir, 'rescue.sh'), script);
      writeFileSync(join(dir, 'tess-rescue-verify'), verify);
      chmodSync(join(dir, 'rescue.sh'), 0o755);
      chmodSync(join(dir, 'tess-rescue-verify'), 0o755);
    }
    const popped = join(s.box, 'popup');
    writeFileSync(join(s.box, 'fake-bin', 'osascript'), `#!/bin/sh\ntouch ${JSON.stringify(popped)}\nexit 0\n`);
    chmodSync(join(s.box, 'fake-bin', 'osascript'), 0o755);
    const updater = readFileSync(join(root, 'installer', 'updater.sh'), 'utf8');
    assert.match(updater, /notify "This Mac has an older Tess rescue line:/);
    assert.match(updater, /notify "Tess's maintainer can remotely run five Tess actions/);
    s.run();
    assert.ok(existsSync(join(s.state, 'rescue-notice-pending')), 'a Mac that has the line and was never told is marked');
    assert.ok(!existsSync(join(s.state, 'rescue-notice-shown')), 'the test run has not shown the notice yet');
    assert.ok(!existsSync(popped), 'a test run does not pop the notice up');
    writeFileSync(join(s.tess, 'tess'), readFileSync(join(root, 'installer', 'tess-command.sh')));
    chmodSync(join(s.tess, 'tess'), 0o755);
    const status = () => execFileSync('/bin/sh', [join(s.tess, 'tess'), 'status'], { env: s.env, encoding: 'utf8' });
    const first = status();
    assert.match(first, /Rescue notice: Tess's maintainer can remotely run five Tess actions on this Mac, without asking/);
    assert.match(first, /This notice is shown once/);
    assert.ok(!existsSync(join(s.state, 'rescue-notice-pending')), 'status clears the marker once it has printed the notice');
    assert.ok(existsSync(join(s.state, 'rescue-notice-shown')), 'status records that this Mac was told');
    assert.doesNotMatch(status(), /Rescue notice:/, 'status shows the notice once');
    s.run();
    assert.ok(!existsSync(join(s.state, 'rescue-notice-pending')), 'a later update does not mark a Mac that was already told');
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

  {
    const s = sandbox();
    rmSync(join(s.tess, 'bin/patcher/tess-patcher'));
    execFileSync('go', ['build', '-o', join(s.tess, 'bin/patcher/tess-patcher'), '.'], { cwd: join(root, 'patcher') });
    const prefs = join(s.box, 'prefs'), backup = join(s.box, 'backup');
    mkdirSync(backup);
    writeFileSync(join(backup, 'xpui.spa'), 'sandbox backup');
    writeFileSync(prefs, 'app.last-launched-version=1.3.9.2055\n');
    const originalConfig = `[Setting]\nspotify_path=${join(s.spotify, 'Contents/Resources')}\nprefs_path=${prefs}\ncurrent_theme=Tess\ncolor_scheme=base\ninject_css=1\ninject_theme_js=1\nreplace_colors=1\n[Backup]\nversion=1.3.9.2055\n`;
    writeFileSync(join(s.config, 'config-xpui.ini'), originalConfig);
    const theme = join(s.fixtures, 'Tess');
    mkdirSync(theme);
    writeFileSync(join(theme, 'theme.js'), 'TESS_BASELINE new theme');
    writeFileSync(join(theme, 'user.css'), 'body { color: red; }');
    writeFileSync(join(theme, 'color.ini'), '[base]\ntext=123456\n');
    const archive = join(s.fixtures, 'theme.tgz');
    execFileSync('tar', ['-czf', archive, '-C', s.fixtures, 'Tess']);
    writeFileSync(join(s.fixtures, 'components.txt'), `theme ${sha(readFileSync(archive))} test://installer source\n`);
    s.run({ TESS_ASSET: archive, SPICETIFY_STATE: backup });
    assert.match(readFileSync(join(s.apps, 'xpui/colors.css'), 'utf8'), /18, ?52, ?86|123456/);
    assert.equal(JSON.parse(readFileSync(join(s.apps, 'xpui/spicetify-config.json'), 'utf8')).schemes.base.text, '123456');
    assert.match(readFileSync(join(s.apps, 'xpui/extensions/theme.js'), 'utf8'), /new theme/);
    assert.equal(readFileSync(join(s.config, 'config-xpui.ini'), 'utf8'), originalConfig, 'staged refresh preserves live config');
    console.log('theme update ran real patcher refresh on staged sandbox; colors and config generated');
  }

  {
    // #108: a theme swap that tess-patcher cannot do leaves Spotify exactly as it was and is not recorded as installed.
    const s = sandbox();
    const theme = join(s.fixtures, 'Tess');
    mkdirSync(theme);
    writeFileSync(join(theme, 'theme.js'), 'TESS_BASELINE staged theme');
    writeFileSync(join(theme, 'user.css'), 'body { color: red; }');
    const archive = join(s.fixtures, 'theme.tgz');
    execFileSync('tar', ['-czf', archive, '-C', s.fixtures, 'Tess']);
    writeFileSync(join(s.fixtures, 'components.txt'), `theme ${sha(readFileSync(archive))} test://installer source\n`);
    s.run({ TESS_ASSET: archive, TESS_SWAP_FAIL: '1' });
    assert.equal(readFileSync(join(s.apps, 'xpui/extensions/theme.js'), 'utf8'), 'TESS_BASELINE\n', 'a failed swap left Spotify exactly as it was');
    assert.ok(!existsSync(join(s.state, 'theme')), 'a failed swap is not recorded as installed');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /theme: checked Spotify swap failed/);
    assert.ok(!existsSync(`${s.apps}.tess-old`) && !existsSync(`${s.apps}.tess-new`), 'a failed swap left nothing behind');
  }

  {
    // #108: the background helper made its copy with /usr/bin/ditto, which macOS App Management denies when launchd
    // starts a script under /bin/zsh, so every background theme update failed. tess-patcher swap-apps makes the same
    // checked copy inside the signed binary, which is allowed, and the theme reaches Spotify.
    const s = sandbox({ denyDitto: true });
    rmSync(join(s.tess, 'bin/patcher/tess-patcher'));
    execFileSync('go', ['build', '-o', join(s.tess, 'bin/patcher/tess-patcher'), '.'], { cwd: join(root, 'patcher') });
    const prefs = join(s.box, 'prefs'), backup = join(s.box, 'backup');
    mkdirSync(backup);
    writeFileSync(join(backup, 'xpui.spa'), 'sandbox backup');
    writeFileSync(prefs, 'app.last-launched-version=1.3.9.2055\n');
    writeFileSync(join(s.config, 'config-xpui.ini'), `[Setting]\nspotify_path=${join(s.spotify, 'Contents/Resources')}\nprefs_path=${prefs}\ncurrent_theme=Tess\ncolor_scheme=base\ninject_css=1\ninject_theme_js=1\nreplace_colors=1\n[Backup]\nversion=1.3.9.2055\n`);
    const theme = join(s.fixtures, 'Tess');
    mkdirSync(theme);
    writeFileSync(join(theme, 'theme.js'), 'TESS_BASELINE background theme');
    writeFileSync(join(theme, 'user.css'), 'body { color: blue; }');
    writeFileSync(join(theme, 'color.ini'), '[base]\ntext=654321\n');
    const archive = join(s.fixtures, 'theme.tgz');
    execFileSync('tar', ['-czf', archive, '-C', s.fixtures, 'Tess']);
    writeFileSync(join(s.fixtures, 'components.txt'), `theme ${sha(readFileSync(archive))} test://installer source\n`);
    // the sandbox really does refuse that write, or this case proves nothing
    let denied = false;
    try {
      execFileSync('ditto', [theme, join(s.apps, 'should-not-exist')], { env: s.env, stdio: 'pipe' });
    } catch {
      denied = true;
    }
    assert.ok(denied, 'the sandbox denies ditto a write inside Spotify.app');
    assert.ok(!existsSync(join(s.apps, 'should-not-exist')), 'the denied copy left nothing');
    rmSync(join(s.box, 'ditto.log'), { force: true }); // from here on, only the updater's own calls are recorded
    s.run({ TESS_ASSET: archive, SPICETIFY_STATE: backup });
    assert.match(readFileSync(join(s.apps, 'xpui/extensions/theme.js'), 'utf8'), /background theme/, 'the theme update reached Spotify while ditto was denied');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /theme: updated/);
    assert.equal(readFileSync(join(s.state, 'theme'), 'utf8').trim(), sha(readFileSync(archive)), 'the theme sha is recorded only after the swap');
    assert.ok(!existsSync(join(s.box, 'ditto.log')), 'the update itself never called ditto inside Spotify.app');
    assert.ok(!existsSync(`${s.apps}.tess-old`) && !existsSync(`${s.apps}.tess-new`), 'no swap leftovers');
    console.log('theme update succeeded with ditto denied inside Spotify.app (#108)');
  }

  {
    // A repair that fails has to say why: the doctor used to throw away both the patcher's own line and its exit code,
    // so a blocked swap read as "nothing happened". A block must read as a block. (Grok review, #110.)
    const s = sandbox({ realDoctor: true });
    rmSync(s.apps, { recursive: true, force: true });
    mkdirSync(s.apps, { recursive: true });
    const copy = join(s.tess, 'original-1.3.9.2055');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'xpui.spa'), "Spotify's own interface\n");
    const out = execFileSync('/bin/zsh', [join(s.tess, 'doctor.sh'), 'check'],
      { env: { ...s.env, TESS_SWAP_EXIT: '3' }, encoding: 'utf8' });
    assert.match(out, /macOS denied the copy/, "the doctor shows the patcher's own line");
    assert.match(out, /macOS is blocking tess-patcher/, 'a blocked swap is named as App Management');
    assert.equal(readFileSync(join(copy, 'xpui.spa'), 'utf8'), "Spotify's own interface\n", 'the safety copy is untouched');
    console.log('doctor repair names why a swap failed (#110)');
  }

  {
    // Parts owned by other tools (like Tess Support's `record` helper) appear in components.txt
    // but must be skipped by the Spotify updater without downloading or calling doctor --auto.
    const s = sandbox();
    writeFileSync(join(s.fixtures, 'components.txt'), [
      `installer ${s.assetSha} test://installer test-source`,
      `record ${'a'.repeat(64)} test://record-should-not-fetch test-source`,
      'version 9.9.9',
      '',
    ].join('\n'));
    s.run();
    const curlLog = readFileSync(join(s.box, 'curl.log'), 'utf8');
    assert.equal(curlLog.includes('record-should-not-fetch'), false, 'unknown part was not downloaded');
    assert.equal(existsSync(join(s.state, 'record')), false, 'unknown part was not recorded in state');
    const doctorLog = existsSync(join(s.box, 'doctor.log')) ? readFileSync(join(s.box, 'doctor.log'), 'utf8') : '';
    assert.equal(doctorLog.includes('--auto'), false, 'unknown part did not trigger doctor --auto');
  }

  {
    // #137: an uninvited Mac is never told Tess Support exists. One check, a plain no, and nothing else — the request
    // carries only its own install id, and no installer is downloaded or run.
    const s = sandbox();
    s.run();
    const log = readFileSync(join(s.box, 'curl.log'), 'utf8');
    assert.match(log, /\/v1\/support\/invite\/check/, 'an uninvited Mac asks the invite check');
    assert.match(log, new RegExp(`--data-binary \\{"install":"${INSTALL_ID}"\\}`), 'the check names only this Mac\'s install id');
    assert.doesNotMatch(log, /invite\/claim/, 'an uninvited Mac never claims an invite');
    assert.doesNotMatch(log, /support-install/, 'and never downloads the support installer');
    assert.ok(!existsSync(join(s.box, 'support-token.out')), 'the installer never ran');
  }

  {
    // A Mac that already has Tess Support is never mentioned it again, and does not even ask.
    const s = sandbox();
    mkdirSync(dirname(s.env.TESS_SUPPORT_CONFIG), { recursive: true });
    writeFileSync(s.env.TESS_SUPPORT_CONFIG, 'profile: tess-support\n');
    s.run();
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/check/, 'a Mac that has Tess Support does not check for an invite');
  }

  {
    // Not now is remembered for that invite, forever: it never claims, and a later run with a different answer does not
    // ask again for the same one.
    const s = sandbox();
    const invited = { TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":7}', TESS_TEST_INVITE_ANSWER: 'decline' };
    s.run(invited);
    assert.ok(existsSync(join(s.state, '.support-invite-asked-7')), 'Not now is recorded for that invite');
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/claim/, 'declining claims nothing');
    assert.ok(!existsSync(join(s.box, 'support-token.out')), 'and runs no installer');
    s.run({ ...invited, TESS_TEST_INVITE_ANSWER: 'install' });
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/claim/, 'a declined invite is never asked about a second time');
  }

  {
    // A dialog nobody answered is not a decision: the invite is not burned, and the next check asks again.
    const s = sandbox();
    const invited = { TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":9}' };
    s.run({ ...invited, TESS_TEST_INVITE_ANSWER: 'timeout' });
    assert.ok(!existsSync(join(s.state, '.support-invite-asked-9')), 'a timeout does not burn the invite');
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/claim/, 'and claims nothing');
    assert.ok(!existsSync(join(s.box, 'support-token.out')));
  }

  {
    // #140: a dialog can wait 15 minutes, and nothing else on the Mac may wait with it. While the invite dialog is
    // open, the update lock is not held, so wake.sh still wakes an update; a second run cannot open a second dialog.
    const s = sandbox();
    const child = spawn('/bin/zsh', [join(s.tess, 'updater.sh')], {
      env: {
        ...s.env,
        TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":21}',
        TESS_TEST_INVITE_ANSWER: 'decline',
        TESS_TEST_INVITE_WAIT: '6',
      },
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const slock = join(s.state, '.support-invite.lock');
    const deadline = Date.now() + 5000;
    while (!existsSync(slock) && Date.now() < deadline) execFileSync('/bin/sleep', ['0.05']);
    assert.ok(existsSync(slock), 'the invite dialog is open');
    assert.ok(!existsSync(join(s.tess, '.installing')), 'an open invite dialog does not hold the update lock');
    execFileSync('/bin/zsh', [join(s.tess, 'wake.sh')], { env: s.env, encoding: 'utf8' });
    assert.match(readFileSync(join(s.box, 'launchctl.log'), 'utf8'), /kickstart .*music\.tess\.guard/,
      'wake.sh still wakes an update while the invite dialog waits');
    execFileSync('/bin/zsh', [join(s.tess, 'updater.sh')], {
      env: { ...s.env, TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":22}', TESS_TEST_INVITE_ANSWER: 'install' },
      encoding: 'utf8',
    });
    assert.ok(!existsSync(join(s.state, '.support-invite-asked-22')), 'a second run cannot open a second dialog');
    writeFileSync(join(s.tess, '.installing'), ''); // tess-install.sh / another run takes the lock mid-dialog
    await exited;
    assert.ok(!existsSync(slock), 'the invite lock is removed when the run ends');
    assert.ok(existsSync(join(s.tess, '.installing')), 'finishing the invite does not delete a lock it no longer owns');
  }

  {
    // #140: the sandbox-only profile override. A real Mac ignores TESS_SUPPORT_CONFIG, so a stray variable can neither
    // offer Tess Support again nor hide an existing install.
    const updater = readFileSync(join(root, 'installer', 'updater.sh'), 'utf8');
    const block = updater.match(/^SUPPORT_CONFIG="\$HOME[^\n]*\n\[ -n "\$TESS_TEST" \][^\n]*$/m);
    assert.ok(block, 'the support config path and its sandbox-only override are both there');
    const value = (extra) => execFileSync('/bin/zsh', ['-c', `${block[0]}\nprintf '%s' "$SUPPORT_CONFIG"`],
      { env: { PATH: process.env.PATH, HOME: '/home/example', ...extra }, encoding: 'utf8' });
    assert.equal(value({ TESS_TEST: '1', TESS_SUPPORT_CONFIG: '/tmp/sandbox.yaml' }), '/tmp/sandbox.yaml',
      'a sandbox may point at its own profile');
    assert.equal(value({ TESS_SUPPORT_CONFIG: '/tmp/sandbox.yaml' }),
      '/home/example/.hermes/profiles/tess-support/config.yaml', 'a real Mac ignores the override');
  }

  {
    // Accept: the signed installer is checked first, the invite is claimed exactly once, and the token reaches the
    // installer in its environment only — not its arguments, not the log.
    const s = sandbox();
    s.run({
      TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":11}',
      TESS_INVITE_CLAIM_JSON: `{"token":"${SUPPORT_TOKEN}"}`,
      TESS_TEST_INVITE_ANSWER: 'install',
      TESS_TEST_WELCOME_ANSWER: 'open',
    });
    assert.equal(readFileSync(join(s.box, 'support-token.out'), 'utf8'), SUPPORT_TOKEN, 'the token reaches the installer in its environment');
    assert.equal(readFileSync(join(s.box, 'support-argv.out'), 'utf8'), '', 'and never on its command line');
    const log = readFileSync(join(s.box, 'curl.log'), 'utf8');
    const lines = log.trim().split('\n');
    const at = (needle) => lines.findIndex((l) => l.includes(needle));
    assert.equal(lines.filter((l) => l.includes('invite/claim')).length, 1, 'the invite is claimed exactly once');
    assert.ok(at('support-install.sig') !== -1 && at('support-install.sig') < at('invite/claim'), 'the signed installer is downloaded and checked before the invite is claimed');
    assert.ok(!log.includes(SUPPORT_TOKEN), 'the token never reaches the curl log');
    assert.doesNotMatch(readFileSync(join(s.tess, 'guard.log'), 'utf8'), new RegExp(SUPPORT_TOKEN), 'and never reaches the guard log');
    assert.ok(existsSync(join(s.state, '.support-invite-asked-11')), 'the accepted invite is remembered');
    assert.match(readFileSync(join(s.box, 'open.log'), 'utf8'), /Tess Support\.app/, 'Open Tess Support opens the app');
  }

  {
    // A signature that fails is refused before the claim, so the invite is still there for a later, good download.
    const s = sandbox();
    s.run({ TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":12}', TESS_TEST_INVITE_ANSWER: 'install', TESS_VERIFY_INSTALL_FAIL: '1' });
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/claim/, 'a bad signature never claims the invite');
    assert.ok(!existsSync(join(s.box, 'support-token.out')), 'and never runs the installer');
    assert.ok(!existsSync(join(s.state, '.support-invite-asked-12')), 'the invite is not burned by a bad download');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /installer failed its signature check; nothing was installed/);
    assert.ok(!doctorCalls(s).includes('--auto'), 'a bad signature never asks the doctor to repair Spotify');
  }

  {
    // #140: a valid signature on an older (replayed) support-install.sh still fails because its SHA-256 is not the
    // one pinned inside the rev-checked components.txt.
    const s = sandbox();
    const stale = join(s.fixtures, 'stale-support-install.sh');
    writeFileSync(stale, '#!/bin/sh\necho older signed copy\n');
    s.run({ TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":19}', TESS_TEST_INVITE_ANSWER: 'install', TESS_SUPPORT_INSTALL: stale });
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/claim/, 'a stale signed installer never claims the invite');
    assert.ok(!existsSync(join(s.box, 'support-token.out')), 'and never runs the installer');
    assert.ok(!existsSync(join(s.state, '.support-invite-asked-19')), 'the invite is not burned by a stale mirror');
    assert.ok(existsSync(join(s.state, '.support-invite-retry-19')), 'and backs off for 24 hours');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /installer does not match this release; nothing was installed/);
  }

  {
    // A download that fails costs nothing either.
    const s = sandbox();
    s.run({ TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":13}', TESS_TEST_INVITE_ANSWER: 'install', TESS_SUPPORT_ASSET_FAIL: '1' });
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/claim/, 'a failed download never claims the invite');
    assert.ok(!existsSync(join(s.box, 'support-token.out')));
    assert.ok(!existsSync(join(s.state, '.support-invite-asked-13')));
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /installer download failed/);
    assert.ok(!doctorCalls(s).includes('--auto'), 'a failed download never asks the doctor to repair Spotify');
  }

  {
    // #140: a 404 means spent, expired, revoked or not this Mac's. Stop asking, and run no installer.
    const s = sandbox();
    s.run({
      TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":17}',
      TESS_TEST_INVITE_ANSWER: 'install',
      TESS_INVITE_CLAIM_STATUS: '404',
      TESS_INVITE_CLAIM_JSON: '{"error":"not found"}',
    });
    assert.ok(existsSync(join(s.state, '.support-invite-asked-17')), 'a 404 burns the invite so it is not asked about again');
    assert.ok(!existsSync(join(s.box, 'support-token.out')), 'a 404 runs no installer');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /no longer open \(spent, expired or revoked\)/);
  }

  {
    // #140: a 429/503 is temporary. The invite is still open, so it is not burned, and a second run within 24 hours
    // does not re-ask the person every 20 minutes.
    const s = sandbox();
    const retryEnv = {
      TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":18}',
      TESS_TEST_INVITE_ANSWER: 'install',
      TESS_INVITE_CLAIM_STATUS: '503',
      TESS_INVITE_CLAIM_JSON: '{"error":"unavailable"}',
    };
    s.run(retryEnv);
    assert.ok(!existsSync(join(s.state, '.support-invite-asked-18')), 'a 503 keeps the invite open');
    assert.ok(existsSync(join(s.state, '.support-invite-retry-18')), 'a 503 writes the 24-hour retry backoff stamp');
    assert.ok(!existsSync(join(s.box, 'support-token.out')), 'a 503 runs no installer');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /could not be claimed \(HTTP 503\)/);
    const claimsBefore = readFileSync(join(s.box, 'curl.log'), 'utf8').split('\n').filter((l) => l.includes('invite/claim')).length;
    s.run(retryEnv);
    const claimsAfter = readFileSync(join(s.box, 'curl.log'), 'utf8').split('\n').filter((l) => l.includes('invite/claim')).length;
    assert.equal(claimsAfter, claimsBefore, 'a second run within 24 h does not re-prompt or re-claim');
  }

  {
    // The inbox answers with no token: the invite is spent or gone, so say so, never run an installer, and stop asking.
    const s = sandbox();
    s.run({ TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":14}', TESS_TEST_INVITE_ANSWER: 'install' });
    assert.ok(existsSync(join(s.state, '.support-invite-asked-14')), 'an unclaimable invite is not asked about forever');
    assert.ok(!existsSync(join(s.box, 'support-token.out')));
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /the inbox answered without a token/);
  }

  {
    // A network miss on the claim is not an answer: the invite is still open, so it is not burned, and nothing runs.
    const s = sandbox();
    s.run({ TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":15}', TESS_TEST_INVITE_ANSWER: 'install', TESS_INVITE_CLAIM_FAIL: '1' });
    assert.ok(!existsSync(join(s.state, '.support-invite-asked-15')), 'a claim that never reached the inbox keeps the invite');
    assert.ok(!existsSync(join(s.box, 'support-token.out')));
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /the invite could not be claimed \(HTTP none\)/);
    assert.ok(!doctorCalls(s).includes('--auto'), 'a claim that never reached the inbox never asks the doctor to repair Spotify');
  }

  {
    // The installer itself fails: the copy must not promise nothing changed, because it runs one step at a time.
    const s = sandbox();
    s.run({ TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":16}', TESS_INVITE_CLAIM_JSON: `{"token":"${SUPPORT_TOKEN}"}`, TESS_TEST_INVITE_ANSWER: 'install', TESS_INSTALL_EXIT: '1' });
    assert.equal(readFileSync(join(s.box, 'support-token.out'), 'utf8'), SUPPORT_TOKEN, 'the installer ran with the token');
    assert.ok(existsSync(join(s.state, '.support-invite-asked-16')));
    const guardLog = readFileSync(join(s.tess, 'guard.log'), 'utf8');
    assert.match(guardLog, /installer exited 1/);
    assert.ok(!guardLog.includes(SUPPORT_TOKEN), 'a failure never logs the token');
    assert.ok(!doctorCalls(s).includes('--auto'), 'a failed support install never asks the doctor to repair Spotify');
    const updater = readFileSync(join(root, 'installer', 'updater.sh'), 'utf8');
    assert.match(updater, /some files may have been partially set up\. Run the uninstall command or ask Krish\./,
      'a failed install says some files may have been set up, not that nothing changed');
    assert.doesNotMatch(updater, /Tess Support[^\n]*Nothing was changed/, 'the failed-install copy never claims nothing was changed');
    // The exact words the person sees, and the one dialog that gives up rather than nag.
    assert.match(updater, /display dialog "Krish invited you to Tess Support — a private helper in your Dock/);
    assert.match(updater, /buttons \{"Not now", "Install"\} default button 2 giving up after 900/);
    assert.match(updater, /display dialog "Tess Support is now in your Dock\./);
    assert.match(updater, /buttons \{"Done", "Open Tess Support"\}/);
  }

  // ---- #148: the Liquid Glass card ---------------------------------------------------------------------------------
  // A stand-in for bin/tess-invite. It writes down how it was called and what it could see, and answers with the exit
  // code the test asks for, so every branch of the updater is driven without opening a window.
  const FAKE_INVITE = `#!/bin/sh
case "$1" in
  --check) [ "\$TESS_FAKE_CHECK_BAD" = 1 ] && exit 1; echo "tess-invite 1"; exit 0 ;;
esac
printf '%s\\n' "$*" >> "$TESS_FAKE_DIR/invite-argv.log"
env | sort > "$TESS_FAKE_DIR/invite-$1.env"
case "$1" in
  ask) exit "\${TESS_FAKE_ASK_RC:-2}" ;;
  progress)
    f=$3
    grep -c 'invite/claim' "$TESS_CURL_LOG" > "$TESS_FAKE_DIR/invite-claims-at-start" 2>/dev/null
    first=$(cat "$f" 2>/dev/null); echo "$first" > "$TESS_FAKE_DIR/invite-first-word"
    i=0
    while [ $i -lt 100 ]; do
      w=$(cat "$f" 2>/dev/null)
      case "$w" in
        done) echo done > "$TESS_FAKE_DIR/invite-last-word"; exit "\${TESS_FAKE_DONE_RC:-1}" ;;
        failed) echo failed > "$TESS_FAKE_DIR/invite-last-word"; exit "\${TESS_FAKE_FAILED_RC:-1}" ;;
      esac
      i=$((i + 1)); sleep 0.1
    done
    exit 2 ;;
esac
exit 2
`;
  const plantInvite = (s, text = FAKE_INVITE) => {
    mkdirSync(join(s.tess, 'bin'), { recursive: true });
    writeFileSync(join(s.tess, 'bin', 'tess-invite'), text, { mode: 0o755 });
    return { TESS_FAKE_DIR: s.box };
  };
  const inviteLog = (s, file) => existsSync(join(s.box, file)) ? readFileSync(join(s.box, file), 'utf8') : '';
  const claimed = (id) => ({ TESS_INVITE_CHECK_JSON: `{"invited":true,"invite_id":${id}}`, TESS_INVITE_CLAIM_JSON: `{"token":"${SUPPORT_TOKEN}"}` });
  const LEAKED = 'tess_leaked_from_the_environment';

  {
    // The signed `invite` part installs to bin/tess-invite, executable, with the doctor's check after it.
    const s = sandbox({ fresh: true });
    const text = '#!/bin/sh\necho "tess-invite 1"\n';
    writeFileSync(join(s.fixtures, 'invite.bin'), text);
    writeFileSync(join(s.fixtures, 'components.txt'), `invite ${sha(text)} test://invite src\nversion 9.9.9\n`);
    s.run({ TESS_INVITE_ASSET: join(s.fixtures, 'invite.bin') });
    assert.equal(readFileSync(join(s.tess, 'bin', 'tess-invite'), 'utf8'), text, 'the invite part is installed to bin/tess-invite');
    assert.ok(statSync(join(s.tess, 'bin', 'tess-invite')).mode & 0o100, 'and it is executable');
    assert.equal(readFileSync(join(s.state, 'invite'), 'utf8').trim(), sha(text), 'and its checksum is recorded');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /invite: updated/);
    assert.ok(doctorCalls(s).includes('--validate'), 'the doctor checked it');
    assert.ok(!existsSync(join(s.tess, 'bin', 'tess-invite.new')), 'no half-written copy is left behind');
  }

  {
    // A part that cannot say what it is (--check) is never put in place, and the Mac keeps what it had.
    const s = sandbox({ fresh: true });
    const text = '#!/bin/sh\nexit 1\n';
    writeFileSync(join(s.fixtures, 'invite.bin'), text);
    writeFileSync(join(s.fixtures, 'components.txt'), `invite ${sha(text)} test://invite src\nversion 9.9.9\n`);
    s.run({ TESS_INVITE_ASSET: join(s.fixtures, 'invite.bin') });
    assert.ok(!existsSync(join(s.tess, 'bin', 'tess-invite')), 'a file that fails --check is not installed');
    assert.ok(!existsSync(join(s.state, 'invite')), 'and is not recorded as current');
    assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), /invite: bad file/);
  }

  {
    // The doctor rejects a new card. With an older card on the Mac it comes back; without one the file is removed, so
    // the plain dialog (never a rejected binary) is what the next invite uses.
    const bad = '#!/bin/sh\n# BADINVITE\necho "tess-invite 1"\n';
    const doctor = '#!/bin/zsh\necho "$1" >> "$TESS_DOCTOR_LOG"\nif [ "$1" = --validate ] && [ -f "$TESS_HOME/bin/tess-invite" ] && grep -q BADINVITE "$TESS_HOME/bin/tess-invite"; then exit 1; fi\nexit 0\n';
    const prepare = (s) => {
      writeFileSync(join(s.tess, 'doctor.sh'), doctor, { mode: 0o755 });
      writeFileSync(join(s.fixtures, 'invite.bin'), bad);
      writeFileSync(join(s.fixtures, 'components.txt'), `invite ${sha(bad)} test://invite src\nversion 9.9.9\n`);
    };
    const first = sandbox({ fresh: true });
    prepare(first);
    first.run({ TESS_INVITE_ASSET: join(first.fixtures, 'invite.bin') });
    assert.ok(!existsSync(join(first.tess, 'bin', 'tess-invite')), 'a rejected first install leaves no card behind');
    assert.ok(existsSync(join(first.state, `bad-invite-${sha(bad)}`)), 'the rejected build is marked bad');
    assert.match(readFileSync(join(first.tess, 'guard.log'), 'utf8'), /invite: doctor rejected/);
    first.run({ TESS_INVITE_ASSET: join(first.fixtures, 'invite.bin') });
    assert.match(readFileSync(join(first.tess, 'guard.log'), 'utf8'), /invite: skipped known bad/, 'and is not tried again');

    const older = sandbox({ fresh: true });
    prepare(older);
    const good = '#!/bin/sh\necho "tess-invite 1"\n';
    mkdirSync(join(older.tess, 'bin'), { recursive: true });
    writeFileSync(join(older.tess, 'bin', 'tess-invite'), good, { mode: 0o755 });
    older.run({ TESS_INVITE_ASSET: join(older.fixtures, 'invite.bin') });
    assert.equal(readFileSync(join(older.tess, 'bin', 'tess-invite'), 'utf8'), good, 'a rejected update puts the previous card back');
    assert.ok(!existsSync(join(older.tess, 'bin', 'tess-invite.restore')), 'with no half-written copy left');
  }

  {
    // Add Tess Support (exit 0): the card is asked first, the invite is claimed once, the card shows "installing" only
    // after the claim and moves to "done" when the installer finishes, and Open Tess Support (exit 0) opens the app.
    const s = sandbox();
    const extra = plantInvite(s);
    s.run({ ...extra, ...claimed(31), TESS_FAKE_ASK_RC: '0', TESS_FAKE_DONE_RC: '0', TESS_SUPPORT_TOKEN: LEAKED, TESS_INSTALL_SLEEP: '1' });
    const argv = inviteLog(s, 'invite-argv.log').split('\n').filter(Boolean);
    assert.equal(argv[0], 'ask --timeout 900', 'the card asks with the 15-minute timeout');
    assert.equal(argv[1], `progress --status-file ${join(s.state, '.support-invite-status')}`, 'and shows progress from one status file');
    assert.equal(argv.length, 2, 'it is started exactly twice');
    assert.equal(readFileSync(join(s.box, 'support-token.out'), 'utf8'), SUPPORT_TOKEN, 'the installer still gets the claimed token');
    assert.equal(readFileSync(join(s.box, 'support-argv.out'), 'utf8'), '', 'on no command line');
    assert.equal(inviteLog(s, 'invite-first-word').trim(), 'installing', 'the card starts on "installing"');
    assert.equal(inviteLog(s, 'invite-last-word').trim(), 'done', 'and is told "done" when the installer succeeds');
    assert.equal(inviteLog(s, 'invite-claims-at-start').trim(), '1', 'the card only appears once the invite is claimed');
    // Nothing that identifies the person or opens the installer reaches the card: not argv, not its environment.
    // (The fake inbox reads the token from TESS_INVITE_CLAIM_JSON in the test's own environment; that one harness line is
    // not part of what the updater hands on.)
    const seen = (f) => inviteLog(s, f).split('\n').filter((l) => !l.startsWith('TESS_INVITE_CLAIM_JSON=')).join('\n');
    const everything = argv.join('\n') + seen('invite-ask.env') + seen('invite-progress.env');
    assert.ok(seen('invite-ask.env').length > 100 && seen('invite-progress.env').length > 100, 'the environment the card saw was captured');
    assert.ok(!everything.includes(SUPPORT_TOKEN), 'the claimed token never reaches the card');
    assert.ok(!everything.includes(LEAKED), 'a token already in the updater environment never reaches the card either');
    assert.doesNotMatch(everything, /TESS_SUPPORT_TOKEN/, 'neither the name nor a value of the token variable is in its environment');
    assert.ok(!everything.includes(INSTALL_ID), 'nor the install id');
    assert.match(readFileSync(join(s.box, 'open.log'), 'utf8'), /Tess Support\.app/, 'Open Tess Support opens the app');
    assert.ok(existsSync(join(s.state, '.support-invite-asked-31')), 'the accepted invite is remembered');
    assert.ok(!existsSync(join(s.state, '.support-invite-status')), 'the status file is gone afterwards');
    assert.ok(!readFileSync(join(s.tess, 'guard.log'), 'utf8').includes(SUPPORT_TOKEN), 'the token is never logged');
  }

  {
    // Done (exit 1), or a card closed with x, opens nothing.
    for (const rc of ['1', '2']) {
      const s = sandbox();
      const extra = plantInvite(s);
      s.run({ ...extra, ...claimed(32), TESS_FAKE_ASK_RC: '0', TESS_FAKE_DONE_RC: rc });
      assert.equal(inviteLog(s, 'invite-last-word').trim(), 'done');
      assert.ok(!existsSync(join(s.box, 'open.log')), `exit ${rc} from the done card does not open the app`);
      assert.ok(existsSync(join(s.state, '.support-invite-asked-32')));
    }
  }

  {
    // Not now (exit 1) is remembered for good and claims nothing; the card never shows progress.
    const s = sandbox();
    const extra = plantInvite(s);
    s.run({ ...extra, ...claimed(33), TESS_FAKE_ASK_RC: '1' });
    assert.ok(existsSync(join(s.state, '.support-invite-asked-33')), 'Not now is recorded');
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/claim/, 'and claims nothing');
    assert.equal(inviteLog(s, 'invite-argv.log').trim(), 'ask --timeout 900', 'no progress card for a Not now');
    assert.ok(!existsSync(join(s.box, 'support-token.out')), 'and no installer');
  }

  {
    // Closing the card with x or Escape, or letting it time out (exit 2), is not an answer: the invite is not spent.
    const s = sandbox();
    const extra = plantInvite(s);
    s.run({ ...extra, ...claimed(34), TESS_FAKE_ASK_RC: '2' });
    assert.ok(!existsSync(join(s.state, '.support-invite-asked-34')), 'a dismissed card does not burn the invite');
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/claim/, 'and claims nothing');
    assert.ok(!existsSync(join(s.box, 'support-token.out')));
  }

  {
    // A card that cannot run at all (a crash, a missing loader: 126, 127, 139) must not hide the invite: the plain
    // dialog asks instead. In the sandbox that dialog is the TESS_TEST_INVITE_ANSWER stand-in.
    for (const rc of ['126', '127', '139']) {
      const s = sandbox();
      const extra = plantInvite(s);
      s.run({ ...extra, ...claimed(35), TESS_FAKE_ASK_RC: rc, TESS_TEST_INVITE_ANSWER: 'decline' });
      assert.ok(existsSync(join(s.state, '.support-invite-asked-35')), `a card that exited ${rc} falls back to the plain dialog`);
      assert.match(readFileSync(join(s.tess, 'guard.log'), 'utf8'), new RegExp(`the card exited ${rc}`));
    }
  }

  {
    // A spent invite (404) or a temporary miss (503) never shows a card that promises an install.
    for (const status of ['404', '503']) {
      const s = sandbox();
      const extra = plantInvite(s);
      s.run({ ...extra, TESS_INVITE_CHECK_JSON: '{"invited":true,"invite_id":36}', TESS_FAKE_ASK_RC: '0', TESS_INVITE_CLAIM_STATUS: status, TESS_INVITE_CLAIM_JSON: '{"error":"x"}' });
      assert.equal(inviteLog(s, 'invite-argv.log').trim(), 'ask --timeout 900', `a ${status} claim shows no progress card`);
      assert.ok(!existsSync(join(s.box, 'support-token.out')));
    }
    // A bad signature stops before the claim, so there is no progress card for it either.
    const s = sandbox();
    const extra = plantInvite(s);
    s.run({ ...extra, ...claimed(37), TESS_FAKE_ASK_RC: '0', TESS_VERIFY_INSTALL_FAIL: '1' });
    assert.equal(inviteLog(s, 'invite-argv.log').trim(), 'ask --timeout 900', 'a bad signature shows no progress card');
    assert.doesNotMatch(readFileSync(join(s.box, 'curl.log'), 'utf8'), /invite\/claim/);
  }

  {
    // The installer fails: the card is told "failed" (never "nothing was changed"), the doctor never repairs Spotify,
    // and nothing is opened.
    const s = sandbox();
    const extra = plantInvite(s);
    s.run({ ...extra, ...claimed(38), TESS_FAKE_ASK_RC: '0', TESS_FAKE_FAILED_RC: '1', TESS_INSTALL_EXIT: '1' });
    assert.equal(inviteLog(s, 'invite-last-word').trim(), 'failed', 'the card is told the install failed');
    assert.ok(!existsSync(join(s.box, 'open.log')), 'and nothing is opened');
    assert.ok(existsSync(join(s.state, '.support-invite-asked-38')));
    assert.ok(!doctorCalls(s).includes('--auto'), 'a failed support install never asks the doctor to repair Spotify');
    assert.ok(!readFileSync(join(s.tess, 'guard.log'), 'utf8').includes(SUPPORT_TOKEN));
  }

  {
    // A Mac without the card keeps the plain dialogs and banners, with their old words.
    const s = sandbox();
    assert.ok(!existsSync(join(s.tess, 'bin', 'tess-invite')));
    s.run({ ...claimed(39), TESS_TEST_INVITE_ANSWER: 'install', TESS_TEST_WELCOME_ANSWER: 'open' });
    assert.equal(readFileSync(join(s.box, 'support-token.out'), 'utf8'), SUPPORT_TOKEN, 'the install runs without the card');
    assert.match(readFileSync(join(s.box, 'open.log'), 'utf8'), /Tess Support\.app/, 'and the plain welcome still opens the app');
    assert.ok(!existsSync(join(s.state, '.support-invite-status')), 'with no status file');
  }

  {
    // Source guards for the invariants the card must never break.
    const updater = readFileSync(join(root, 'installer', 'updater.sh'), 'utf8');
    const uses = updater.split('\n').filter((l) => /\$SUPPORT_UI/.test(l) && !/^\s*#/.test(l) && /(ask|progress)/.test(l));
    assert.equal(uses.length, 2, 'the card is started in exactly two places');
    for (const l of uses) {
      assert.match(l, /env -u TESS_SUPPORT_TOKEN/, 'each start strips the token variable');
      assert.doesNotMatch(l, /\$tok\b|\$\{tok|install-id|\$iid|\$invite_id/, 'and passes no token, install id or invite id');
    }
    const tokenLines = updater.split('\n').filter((l) => /TESS_SUPPORT_TOKEN/.test(l) && !/^\s*#/.test(l));
    assert.equal(tokenLines.filter((l) => /TESS_SUPPORT_TOKEN="\$tok" sh "\$TMP\/support-install\.sh"/.test(l)).length, 1, 'the installer is the one place that gets the token');
    assert.equal(tokenLines.length, 3, 'the token name appears only on the installer line and the two env -u strips');
    const order = ['"$VERIFY" "$TMP/support-install.sh"', 'invite/claim', 'TESS_SUPPORT_TOKEN="$tok" sh'].map((m) => updater.indexOf(m));
    assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], 'download, signature check, SHA pin and claim keep their order before the installer');
    assert.ok(updater.indexOf("awk '$1 == \"support-install\"") < updater.indexOf('invite/claim'), 'the SHA pin is checked before the claim');
    const release = readFileSync(join(root, 'tools', 'release.mjs'), 'utf8');
    assert.match(release, /invite: \{ file: `\$\{build\}tess-invite`/, 'the release lists the invite part');
    assert.match(release, /codesign\(`\$\{build\}tess-invite`, 'music\.tess\.invite'\)/, 'signs it as music.tess.invite');
    assert.match(release, /`\$\{build\}tess-record`, `\$\{build\}tess-invite`/, 'and uploads it as a release asset');
    assert.match(release, /`\$\{build\}tess-support-kit\.tar\.gz`/, 'and uploads tess-support-kit.tar.gz as a release asset');
    assert.match(readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8'), /'support\/mac\/install\.sh'/, 'a pin commit to support/mac/install.sh builds dev');
  }

  console.log('updater tests passed (success, fresh, blocked, failed swap, rollback/no-retry, playing/idle, list reports, theme swap with ditto denied, support invite consent, invite lock released while a dialog waits, claim 404 vs 503, Liquid Glass card part install/rollback, exit codes, progress, no token to the card, plain-dialog fallback)');
} finally {
  for (const box of boxes) rmSync(box, { recursive: true, force: true });
}
