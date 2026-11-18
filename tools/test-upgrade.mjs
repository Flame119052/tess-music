// Before a build can be published, install the pinned stable Tess (0.2.22) on a fake Spotify, update to this
// build, run the doctor, and do a fresh install. The old updater and doctor are the release assets, checked by
// SHA-256. Signatures use a key this test generates; the release key is never read. Run: node tools/test-upgrade.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureDir = join(root, 'tools/fixtures/upgrade/0.2.22');
const OLD_VERSION = '0.2.22';
const NEW_VERSION = '0.2.99';
const OLD_MARKER = 'tess-old-0.2.22';
const NEW_MARKER = 'tess-upgrade-new';
const STOCK = 'stock Spotify interface\n';
// These are the GitHub release digests for v0.2.22. The fixture bytes and PIN.json must both match them.
const PINNED = {
  'tess-updater.sh': '7ef6c380381937c5c89401bcb8ad019131ba608e09c77cf4c6cae769a391c896',
  'tess-doctor.sh': '9aadfdda12bf0c18f2f1914c986e45200fe96e9fd88d1c21a1f8af2da2cf2038',
};

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const boxes = [];
const run = (cmd, args, env) => {
  try {
    const stdout = execFileSync(cmd, args, { env, encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: `${e.stdout || ''}`, stderr: `${e.stderr || ''}` };
  }
};

function assertPinned() {
  const pin = JSON.parse(readFileSync(join(fixtureDir, 'PIN.json'), 'utf8'));
  assert.equal(pin.version, OLD_VERSION);
  for (const [name, digest] of Object.entries(PINNED)) {
    const bytes = readFileSync(join(fixtureDir, name));
    assert.equal(sha(bytes), digest, `${name} is not the pinned 0.2.22 release asset`);
    assert.equal(pin.files[name].sha256, digest, `PIN.json drifted from the ${name} pin`);
    assert.match(pin.files[name].url, new RegExp(`/v${OLD_VERSION}/${name}$`));
  }
}

function throwawayVerifier(dir) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const bin = join(dir, 'tess-verify');
  execFileSync('go', ['build', '-ldflags', `-X main.publicKey=${pub}`, '-o', bin, './tessverify'], {
    cwd: join(root, 'patcher'),
    env: { ...process.env, CGO_ENABLED: '0' },
    stdio: 'inherit',
  });
  chmodSync(bin, 0o755);
  return { bin, sig: (text) => sign(null, Buffer.from(text), privateKey).toString('base64') };
}

function writePatcher(dir, verifyBin) {
  const script = `#!/bin/sh
CONF="\${SPICETIFY_CONFIG:-\$TESS_CONFIG}"
ini="\$CONF/config-xpui.ini"
path_of() { sed -n 's/^spotify_path *= *//p' "\$ini" | head -1; }
set_path() {
  mkdir -p "\$CONF"
  if [ -f "\$ini" ]; then grep -v '^spotify_path' "\$ini" > "\$ini.new" || true; else : > "\$ini.new"; fi
  printf 'spotify_path = %s\\n' "\$1" >> "\$ini.new"
  mv "\$ini.new" "\$ini"
}
do_swap() {
  apps="\$1"; staged="\$2"
  _new="\$apps.tess-new"; _old="\$apps.tess-old"
  if [ ! -d "\$apps" ] && [ -d "\$_old" ]; then mv "\$_old" "\$apps" || exit 1; fi
  rm -rf "\$_new"
  ditto "\$staged" "\$_new" || { rm -rf "\$_new"; exit 1; }
  [ -s "\$_new/xpui.spa" ] || [ -s "\$_new/xpui/index.html" ] || { rm -rf "\$_new"; exit 1; }
  rm -rf "\$_old"
  if [ -d "\$apps" ]; then mv "\$apps" "\$_old" || { rm -rf "\$_new"; exit 1; }; fi
  mv "\$_new" "\$apps" || { [ -d "\$_old" ] && mv "\$_old" "\$apps"; rm -rf "\$_new"; exit 1; }
  rm -rf "\$_old"
}
case "\$1" in
  config)
    [ "\$2" = spotify_path ] && set_path "\$3"
    exit 0 ;;
  can-write|-c|-v) exit 0 ;;
  swap-apps) do_swap "\$2" "\$3"; exit 0 ;;
  refresh)
    apps="\$(path_of)/Apps"; theme="\$CONF/Themes/Tess"
    mkdir -p "\$apps/xpui/extensions"
    cp "\$theme/theme.js" "\$apps/xpui/extensions/theme.js"
    cp "\$theme/user.css" "\$apps/xpui/user.css"
    exit 0 ;;
  backup)
    apps="\$(path_of)/Apps"; theme="\$CONF/Themes/Tess"
    stage=\$(mktemp -d)
    mkdir -p "\$stage/xpui/extensions"
    printf '%s\\n' '<html>spicetifyWrapper</html>' > "\$stage/xpui/index.html"
    cp "\$theme/theme.js" "\$stage/xpui/extensions/theme.js"
    cp "\$theme/user.css" "\$stage/xpui/user.css"
    do_swap "\$apps" "\$stage"
    rm -rf "\$stage"
    exit 0 ;;
  restore) rm -rf "\$(path_of)/Apps/xpui"; exit 0 ;;
esac
exit 0
`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tess-patcher'), script);
  writeFileSync(join(dir, 'tess-verify'), readFileSync(verifyBin));
  chmodSync(join(dir, 'tess-patcher'), 0o755);
  chmodSync(join(dir, 'tess-verify'), 0o755);
}

function themeArchive(dir, name, marker) {
  const theme = join(dir, 'theme-src', 'Tess');
  mkdirSync(theme, { recursive: true });
  writeFileSync(join(theme, 'theme.js'), `function TESS_BASELINE(){}\n/* ${marker} */\n`);
  writeFileSync(join(theme, 'user.css'), `/* ${marker} */\n`);
  const archive = join(dir, name);
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'theme-src'), 'Tess']);
  return archive;
}

function writeDist(dir, { sig, files, version, rev }) {
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (const [name, file] of Object.entries(files)) {
    const bytes = readFileSync(file);
    const dest = join(dir, name);
    writeFileSync(dest, bytes);
    if (name.endsWith('.sh')) chmodSync(dest, 0o755);
    lines.push(`${name.replace(/\.sh$/, '').replace(/\.tgz$/, '')} ${sha(bytes)} test://${name} src-${name}`);
  }
  const text = `${lines.join('\n')}\nversion ${version}\nrev ${rev}\n`;
  writeFileSync(join(dir, 'components.txt'), text);
  writeFileSync(join(dir, 'components.sig'), `${sig(text)}\n`);
}

function fakeSpotify(box) {
  const spotify = join(box, 'Spotify.app');
  const apps = join(spotify, 'Contents/Resources/Apps');
  mkdirSync(join(spotify, 'Contents/MacOS'), { recursive: true });
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(spotify, 'Contents/MacOS/Spotify'), '');
  writeFileSync(join(apps, 'xpui.spa'), STOCK);
  writeFileSync(join(spotify, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.spotify.client</string>
<key>CFBundleShortVersionString</key><string>1.3.9.2055</string>
</dict></plist>
`);
  return spotify;
}

function sandboxEnv(box, extra) {
  const home = join(box, 'home');
  mkdirSync(join(home, 'Library/Application Support/Spotify'), { recursive: true });
  writeFileSync(join(home, 'Library/Application Support/Spotify/prefs'), '');
  const bin = join(box, 'bin');
  mkdirSync(bin, { recursive: true });
  const shim = (name, body) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  shim('curl', `#!/bin/sh
echo "$@" >> "$TESS_CURL_LOG"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    *://*) url=$1; shift ;;
    *) shift ;;
  esac
done
root=$(cat "$TESS_CURL_ROOT")
case "$url" in
  *components.txt*) cp "$root/components.txt" "$out" || exit 22 ;;
  *components.sig*) cp "$root/components.sig" "$out" || exit 22 ;;
  test://*) cp "$root/\${url##*/}" "$out" || exit 22 ;;
  http://*|https://*) exit 0 ;;
  *) exit 22 ;;
esac
`);
  shim('launchctl', '#!/bin/sh\necho "$@" >> "$TESS_LAUNCH_LOG"\nexit 0\n');
  shim('pgrep', '#!/bin/sh\nexit 1\n');
  shim('pmset', '#!/bin/sh\nexit 0\n');
  shim('osascript', '#!/bin/sh\nexit 0\n');
  shim('open', '#!/bin/sh\nexit 0\n');
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('TESS_') || key === 'SPICETIFY_CONFIG' || key === 'SPICETIFY_STATE') delete clean[key];
  }
  delete clean.TESS_SIGNING_KEY;
  return {
    ...clean,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    TESS_TEST: '1',
    TESS_CURL_LOG: join(box, 'curl.log'),
    TESS_LAUNCH_LOG: join(box, 'launchctl.log'),
    ...extra,
  };
}

function assertWhole(spotify, tess, marker) {
  const apps = join(spotify, 'Contents/Resources/Apps');
  assert.equal(existsSync(`${apps}.tess-old`), false, 'a swap left Apps.tess-old behind');
  assert.equal(existsSync(`${apps}.tess-new`), false, 'a swap left Apps.tess-new behind');
  assert.equal(existsSync(apps), true, 'Apps is missing');
  assert.match(readFileSync(join(apps, 'xpui/index.html'), 'utf8'), /spicetifyWrapper/);
  const theme = readFileSync(join(apps, 'xpui/extensions/theme.js'), 'utf8');
  const css = readFileSync(join(apps, 'xpui/user.css'), 'utf8');
  assert.match(theme, /TESS_BASELINE/);
  assert.match(theme, new RegExp(marker));
  assert.match(css, new RegExp(marker));
  assert.equal(readFileSync(join(tess, 'original-1.3.9.2055/xpui.spa'), 'utf8'), STOCK, 'the safety copy of Spotify was changed');
}

const box = mkdtempSync(join(tmpdir(), 'tess-upgrade-'));
boxes.push(box);
try {
  assertPinned();
  const { bin: verifyBin, sig } = throwawayVerifier(box);
  const patcherDir = join(box, 'patcher');
  writePatcher(patcherDir, verifyBin);
  const patcherArchive = join(box, 'patcher.tgz');
  execFileSync('tar', ['-czf', patcherArchive, '-C', patcherDir, '.']);

  const oldDist = join(box, 'old');
  const newDist = join(box, 'new');
  writeDist(oldDist, {
    sig,
    version: OLD_VERSION,
    rev: 22,
    files: {
      'patcher.tgz': patcherArchive,
      'theme.tgz': themeArchive(box, 'old-theme.tgz', OLD_MARKER),
      'updater.sh': join(fixtureDir, 'tess-updater.sh'),
      'doctor.sh': join(fixtureDir, 'tess-doctor.sh'),
    },
  });
  writeDist(newDist, {
    sig,
    version: NEW_VERSION,
    rev: 99,
    files: {
      'patcher.tgz': patcherArchive,
      'theme.tgz': themeArchive(box, 'new-theme.tgz', NEW_MARKER),
      'updater.sh': join(root, 'installer/updater.sh'),
      'doctor.sh': join(root, 'installer/doctor.sh'),
      'wake.sh': join(root, 'installer/wake.sh'),
      'installer.sh': join(root, 'installer/tess-install.sh'),
      'uninstall.sh': join(root, 'installer/uninstall.sh'),
      'command.sh': join(root, 'installer/tess-command.sh'),
    },
  });

  const pointer = join(box, 'curl-root');
  const pointAt = (dir) => writeFileSync(pointer, `${dir}\n`);
  const baseEnv = {
    TESS_CURL_ROOT: pointer,
    TESS_DIST_BASE: 'test://dist',
    TESS_CHANNEL: 'stable',
    TESS_VERIFY: verifyBin,
  };

  // 1. The last stable build, then the updater that an old Mac actually runs, then the doctor.
  {
    const home = mkdtempSync(join(box, 'from-old-'));
    const spotify = fakeSpotify(home);
    const tess = join(home, 'tess');
    const config = join(home, 'config');
    const env = sandboxEnv(home, { ...baseEnv, TESS_HOME: tess, TESS_CONFIG: config, TESS_SPOTIFY: spotify });
    pointAt(oldDist);
    const installed = run('/bin/sh', [join(root, 'installer/tess-install.sh')], env);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.match(installed.stdout, /Test install/);
    assert.match(readFileSync(join(spotify, 'Contents/Resources/Apps/xpui/extensions/theme.js'), 'utf8'), new RegExp(OLD_MARKER));
    assert.equal(readFileSync(join(tess, 'state/version'), 'utf8').trim(), OLD_VERSION);
    assert.equal(readFileSync(join(tess, 'updater.sh'), 'utf8'), readFileSync(join(fixtureDir, 'tess-updater.sh'), 'utf8'));

    pointAt(newDist);
    const updated = run('/bin/zsh', [join(tess, 'updater.sh')], { ...env, TESS_FORCE: '1' });
    assert.equal(updated.status, 0, updated.stdout + updated.stderr + readFileSync(join(tess, 'guard.log'), 'utf8'));
    assert.equal(readFileSync(join(tess, 'state/version'), 'utf8').trim(), NEW_VERSION, 'the old updater did not take the new version');
    assert.equal(readFileSync(join(tess, 'updater.sh'), 'utf8'), readFileSync(join(root, 'installer/updater.sh'), 'utf8'), 'the installed updater is not this build');
    assertWhole(spotify, tess, NEW_MARKER);
    assert.match(readFileSync(join(config, 'Themes/Tess/theme.js'), 'utf8'), new RegExp(NEW_MARKER));
    assert.doesNotMatch(readFileSync(join(spotify, 'Contents/Resources/Apps/xpui/extensions/theme.js'), 'utf8'), new RegExp(OLD_MARKER));

    // The updater this build ships has to run on the Mac it just updated. exit 1 here is a broken build.
    const again = run('/bin/zsh', [join(tess, 'updater.sh')], { ...env, TESS_FORCE: '1' });
    assert.equal(again.status, 0, `the updater this build ships failed\n${again.stdout}${again.stderr}${readFileSync(join(tess, 'guard.log'), 'utf8')}`);
    const doctor = run('/bin/zsh', [join(tess, 'doctor.sh'), '--validate'], env);
    assert.equal(doctor.status, 0, `doctor --validate failed\n${doctor.stdout}${doctor.stderr}`);
    const report = run('/bin/zsh', [join(tess, 'doctor.sh')], env);
    assert.equal(report.status, 0, report.stdout + report.stderr);
    assert.match(report.stdout, /Tess is in Spotify/);
    assertWhole(spotify, tess, NEW_MARKER);
  }

  // 2. A Mac with no Tess yet: the same build installs cleanly, and its updater and doctor agree.
  {
    const home = mkdtempSync(join(box, 'fresh-'));
    const spotify = fakeSpotify(home);
    const tess = join(home, 'tess');
    const config = join(home, 'config');
    const env = sandboxEnv(home, { ...baseEnv, TESS_HOME: tess, TESS_CONFIG: config, TESS_SPOTIFY: spotify });
    pointAt(newDist);
    const installed = run('/bin/sh', [join(root, 'installer/tess-install.sh')], env);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.match(installed.stdout, /Test install/);
    const updated = run('/bin/zsh', [join(tess, 'updater.sh')], { ...env, TESS_FORCE: '1' });
    assert.equal(updated.status, 0, `fresh install's updater failed\n${updated.stdout}${updated.stderr}${existsSync(join(tess, 'guard.log')) ? readFileSync(join(tess, 'guard.log'), 'utf8') : ''}`);
    const doctor = run('/bin/zsh', [join(tess, 'doctor.sh'), '--validate'], env);
    assert.equal(doctor.status, 0, `fresh doctor --validate failed\n${doctor.stdout}${doctor.stderr}`);
    assert.equal(readFileSync(join(tess, 'state/version'), 'utf8').trim(), NEW_VERSION);
    assertWhole(spotify, tess, NEW_MARKER);
  }

  console.log('upgrade gate passed (pinned 0.2.22, then this build, doctor clean, fresh install, fake Spotify left whole)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
