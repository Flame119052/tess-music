// The one-command Mac installer, against scratch folders and fake system tools.
// Never the real Dock, the real /Applications, or the real home.
// Usage: node tools/test-support-mac-install.mjs
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const install = join(root, 'support/mac/install.sh');
const token = `tess_${'abc123'.repeat(6)}`;
const decoy = 'sk-opencode-this-must-not-be-written';

const loginHome = () => {
  const user = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).trim();
  const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8' });
  const line = out.split('\n').find((row) => row.startsWith('NFSHomeDirectory:'));
  return line.slice('NFSHomeDirectory:'.length).trim();
};

const writeBin = (dir, name, body) => {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

const filesContaining = (dir, needle) => {
  const hits = [];
  const walk = (current) => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (readFileSync(path).includes(needle)) hits.push(path);
    }
  };
  walk(dir);
  return hits;
};

// Every file under dir, as relative path -> bytes. A symlink is a failure: the profile never holds one.
const tree = (dir) => {
  const files = new Map();
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const info = lstatSync(path);
      assert.equal(info.isSymbolicLink(), false, `${path} is a symlink`);
      if (info.isDirectory()) walk(path);
      else files.set(relative(dir, path), readFileSync(path));
    }
  };
  walk(dir);
  return files;
};

const sameTree = (got, want, label) => {
  assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort(), `${label}: a different set of files`);
  for (const [name, bytes] of want) assert.ok(got.get(name).equals(bytes), `${label}: ${name} differs`);
};

const urlsInDock = (plist) => {
  if (!existsSync(plist)) return [];
  const raw = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
  const data = JSON.parse(raw);
  return (data['persistent-apps'] || []).map((tile) => tile?.['tile-data']?.['file-data']?._CFURLString || '');
};

const layout = (name) => {
  const box = mkdtempSync(join(tmpdir(), `tess-support-install-${name}-`));
  const bin = join(box, 'bin');
  const log = join(box, 'log');
  mkdirSync(bin);
  mkdirSync(log);
  const leak = `
if [ -n "\${TESS_SUPPORT_TOKEN:-}" ]; then printf '%s\\n' leak >> "$TESS_FAKE_LOG/env-leak"; fi
`;
  // The piped install downloads the profile from GitHub. Here those files come from this checkout.
  writeBin(bin, 'curl', `#!/bin/sh
{
  printf 'argv'
  for a in "$@"; do printf ' <%s>' "$a"; done
  printf '\\n'
} >> "$TESS_FAKE_LOG/curl.log"
${leak}
out=
prev=
url=
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out=$a; fi
  prev=$a
  case $a in
    -*) ;;
    *) url=$a ;;
  esac
done
[ -n "$out" ] || exit 2
case $url in
  https://raw.githubusercontent.com/Flame119052/tess-music/main/*)
    rel=\${url#https://raw.githubusercontent.com/Flame119052/tess-music/main/}
    case $rel in *..*) exit 1 ;; esac
    [ -f "$TESS_FAKE_REPO/$rel" ] || exit 22
    cp "$TESS_FAKE_REPO/$rel" "$out"
    ;;
  *stable-mac.yml)
    payload="$TESS_FAKE_LOG/payload"
    printf 'dmg!!' > "$payload"
    hash=$(/usr/bin/openssl dgst -sha512 -binary "$payload" | /usr/bin/openssl base64 | tr -d '\\n')
    printf '%s\\n' "version: 9.9.9" "files:" "  - url: /releases/tag/v9.9.9/HermesBundled-9.9.9-mac-arm64.dmg" "    sha512: $hash" "    size: 5" > "$out"
    ;;
  *.dmg)
    printf 'dmg!!' > "$out"
    ;;
  *install.sh)
    cat > "$out" <<'END'
#!/bin/sh
printf '%s\\n' "$*" > "$TESS_FAKE_LOG/cli-args"
if [ -n "\${TESS_SUPPORT_TOKEN:-}" ]; then printf '%s\\n' leak >> "$TESS_FAKE_LOG/env-leak"; fi
mkdir -p "$HOME/.local/bin" "$HERMES_HOME/hermes-agent"
printf '%s\\n' '#!/bin/sh' 'exit 0' > "$HOME/.local/bin/hermes"
chmod +x "$HOME/.local/bin/hermes"
printf '%s\\n' agent > "$HERMES_HOME/hermes-agent/README"
exit 0
END
    ;;
  *)
    printf 'bad url %s\\n' "$url" >> "$TESS_FAKE_LOG/curl.log"
    exit 1
    ;;
esac
exit 0
`);
  writeBin(bin, 'hdiutil', `#!/bin/sh
{
  printf 'argv'
  for a in "$@"; do printf ' <%s>' "$a"; done
  printf '\\n'
} >> "$TESS_FAKE_LOG/hdiutil.log"
${leak}
if [ "$1" = "detach" ]; then exit 0; fi
mp=
prev=
for a in "$@"; do
  if [ "$prev" = "-mountpoint" ]; then mp=$a; fi
  prev=$a
done
[ -n "$mp" ] || exit 2
mkdir -p "$mp/Hermes.app/Contents/MacOS"
printf '%s\\n' '#!/bin/sh' 'exit 0' > "$mp/Hermes.app/Contents/MacOS/Hermes"
chmod +x "$mp/Hermes.app/Contents/MacOS/Hermes"
exit 0
`);
  writeBin(bin, 'codesign', `#!/bin/sh
{
  printf 'argv'
  for a in "$@"; do printf ' <%s>' "$a"; done
  printf '\\n'
} >> "$TESS_FAKE_LOG/codesign.log"
${leak}
exit "\${TESS_FAKE_CODESIGN_EXIT:-0}"
`);
  writeBin(bin, 'spctl', `#!/bin/sh
{
  printf 'argv'
  for a in "$@"; do printf ' <%s>' "$a"; done
  printf '\\n'
} >> "$TESS_FAKE_LOG/spctl.log"
${leak}
exit "\${TESS_FAKE_SPCTL_EXIT:-0}"
`);
  writeBin(bin, 'killall', `#!/bin/sh
printf '%s\\n' "$*" >> "$TESS_FAKE_LOG/killall.log"
${leak}
[ "$1" = "Dock" ]
`);
  writeBin(bin, 'defaults', `#!/bin/sh
plist="$TESS_FAKE_LOG/dock.plist"
{
  printf 'argv'
  for a in "$@"; do printf ' <%s>' "$a"; done
  printf '\\n'
} >> "$TESS_FAKE_LOG/defaults.log"
${leak}
cmd=$1
domain=$2
[ "$domain" = "com.apple.dock" ] || exit 2
case $cmd in
  read)
    [ "$3" = "persistent-apps" ] || exit 2
    [ -f "$plist" ] || exit 1
    /usr/libexec/PlistBuddy -c 'Print :persistent-apps' "$plist"
    ;;
  write)
    [ "$3" = "persistent-apps" ] && [ "$4" = "-array-add" ] || exit 2
    url=$(printf '%s' "$5" | sed -n 's/.*_CFURLString<\\/key><string>\\([^<]*\\)<\\/string>.*/\\1/p' | head -1)
    [ -n "$url" ] || exit 2
    if [ ! -f "$plist" ]; then
      printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0"><dict/></plist>' > "$plist"
    fi
    if ! /usr/libexec/PlistBuddy -c 'Print :persistent-apps' "$plist" >/dev/null 2>&1; then
      /usr/libexec/PlistBuddy -c 'Add :persistent-apps array' "$plist"
    fi
    count=0
    while /usr/libexec/PlistBuddy -c "Print :persistent-apps:\${count}" "$plist" >/dev/null 2>&1; do
      count=$((count + 1))
    done
    /usr/libexec/PlistBuddy -c "Add :persistent-apps:\${count} dict" "$plist"
    /usr/libexec/PlistBuddy -c "Add :persistent-apps:\${count}:tile-type string file-tile" "$plist"
    /usr/libexec/PlistBuddy -c "Add :persistent-apps:\${count}:tile-data dict" "$plist"
    /usr/libexec/PlistBuddy -c "Add :persistent-apps:\${count}:tile-data:file-label string Tess Support" "$plist"
    /usr/libexec/PlistBuddy -c "Add :persistent-apps:\${count}:tile-data:file-data dict" "$plist"
    /usr/libexec/PlistBuddy -c "Add :persistent-apps:\${count}:tile-data:file-data:_CFURLString string \${url}" "$plist"
    /usr/libexec/PlistBuddy -c "Add :persistent-apps:\${count}:tile-data:file-data:_CFURLStringType integer 15" "$plist"
    ;;
  export)
    [ -f "$plist" ] || exit 1
    cp "$plist" "$3"
    ;;
  import)
    cp "$3" "$plist"
    ;;
  *)
    exit 2
    ;;
esac
`);
  return { box, bin, log, plist: join(log, 'dock.plist') };
};

const baseEnv = (place, extra) => ({
  PATH: `${place.bin}:/usr/bin:/bin:/usr/sbin`,
  HOME: join(place.box, 'home'),
  HERMES_HOME: join(place.box, 'hermes'),
  TESS_APPLICATIONS: join(place.box, 'Applications'),
  TMPDIR: join(place.box, 'tmp'),
  TESS_FAKE_LOG: place.log,
  TESS_FAKE_REPO: root,
  TESS_TEST: '1',
  TESS_SUPPORT_TOKEN: token,
  TESS_INBOX: 'http://127.0.0.1:9',
  OPENCODE_GO_API_KEY: decoy,
  LANG: 'C',
  ...extra,
});

// piped runs the script the way a person does: curl ... | sh. It then has no checkout beside it.
const run = (args, env, { piped = false, cwd } = {}) => {
  try {
    const stdout = piped
      ? execFileSync('/bin/sh', ['-s', '--', ...args], {
        encoding: 'utf8', env, cwd, input: readFileSync(install, 'utf8'), stdio: ['pipe', 'pipe', 'pipe'],
      })
      : execFileSync('/bin/sh', [install, ...args], {
        encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
      });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() || '',
      stderr: error.stderr?.toString() || '',
    };
  }
};

const assertOnlyEnv = (place) => {
  const tokenHits = filesContaining(place.box, token);
  const envPath = join(place.box, 'hermes', 'profiles', 'tess-support', '.env');
  assert.deepEqual(tokenHits, [envPath]);
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  assert.equal(filesContaining(place.box, decoy).length, 0);
  assert.equal(existsSync(join(place.log, 'env-leak')), false);
  const logs = ['curl.log', 'hdiutil.log', 'codesign.log', 'spctl.log', 'defaults.log', 'killall.log', 'cli-args']
    .map((name) => join(place.log, name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.equal(logs.includes(token), false);
  assert.equal(logs.includes(decoy), false);
};

const boxes = [];
try {
  // install.mjs is the profile's own installer. install.sh must leave the same files.
  const ref = mkdtempSync(join(tmpdir(), 'tess-support-install-ref-'));
  boxes.push(ref);
  const refOut = execFileSync(process.execPath, [join(root, 'support/mac/install.mjs')], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin', HOME: join(ref, 'home'), HERMES_HOME: join(ref, 'hermes'), TMPDIR: tmpdir(),
      LANG: 'C', TESS_TEST: '1', TESS_SUPPORT_TOKEN: token, TESS_INBOX: 'http://127.0.0.1:9',
    },
  });
  assert.equal(refOut, 'via copy\n');
  const reference = tree(join(ref, 'hermes', 'profiles', 'tess-support'));
  for (const name of ['plugins/tess-notes/__init__.py', 'plugins/tess-notes/plugin.yaml', 'skills/tess-gather/scripts/doctor.mjs',
    'skills/tess-evidence/scripts/spotify-window.mjs', 'skills/tess-handoff/scripts/triage-inbox.mjs',
    'skills/tess-support/scripts/session.mjs', 'config.yaml', 'distribution.yaml', 'SOUL.md', '.env']) {
    assert.ok(reference.has(name), `install.mjs did not install ${name}`);
  }

  const missing = run([], {
    PATH: '/usr/bin:/bin',
    HOME: join(tmpdir(), 'tess-support-missing-home'),
    TMPDIR: tmpdir(),
    LANG: 'C',
    TESS_TEST: '1',
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /HERMES_HOME/);

  const planted = join(loginHome(), '.tess-support-install-must-not-exist');
  assert.equal(existsSync(planted), false);
  const refused = run([], {
    PATH: '/usr/bin:/bin',
    HOME: join(tmpdir(), 'tess-support-refuse-home'),
    HERMES_HOME: planted,
    TESS_APPLICATIONS: join(tmpdir(), 'tess-support-refuse-apps'),
    TMPDIR: tmpdir(),
    LANG: 'C',
    TESS_TEST: '1',
    TESS_SUPPORT_TOKEN: token,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /real home folder/);
  assert.equal(existsSync(planted), false);

  const applications = run([], {
    PATH: '/usr/bin:/bin',
    HOME: join(tmpdir(), 'tess-support-refuse-apps-home'),
    HERMES_HOME: join(tmpdir(), 'tess-support-refuse-apps-hermes'),
    TESS_APPLICATIONS: '/Applications',
    TMPDIR: tmpdir(),
    LANG: 'C',
    TESS_TEST: '1',
    TESS_SUPPORT_TOKEN: token,
  });
  assert.notEqual(applications.status, 0);
  assert.match(applications.stderr, /real Applications/);

  const arm = layout('arm');
  boxes.push(arm.box);
  mkdirSync(arm.box + '/tmp');
  const armEnv = baseEnv(arm, { TESS_ARCH: 'arm64' });
  const first = run([], armEnv);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /macOS will ask once to allow screen recording/);
  assert.match(first.stdout, /Turn it on for Tess Support in System Settings, under Privacy and Security/);
  assert.equal(existsSync(join(armEnv.TESS_APPLICATIONS, 'Hermes.app')), true);
  assert.equal(readFileSync(join(armEnv.HERMES_HOME, 'tess-support-we-installed'), 'utf8').trim(), 'app');
  const launcher = readFileSync(join(armEnv.HOME, 'Applications', 'Tess Support.app', 'Contents', 'MacOS', 'launch'), 'utf8');
  assert.match(launcher, /open -a /);
  assert.match(launcher, /--profile=tess-support/);
  assert.equal(readFileSync(join(armEnv.HERMES_HOME, 'active_profile'), 'utf8').trim(), 'tess-support');
  const desk = readFileSync(join(armEnv.HOME, 'Library', 'Application Support', 'Hermes', 'active-profile.json'), 'utf8');
  assert.equal(JSON.parse(desk).profile, 'tess-support');
  const copied = readFileSync(join(armEnv.HERMES_HOME, 'profiles', 'tess-support', 'config.yaml'), 'utf8');
  assert.match(copied, /provider:\s*tess-gate/);
  assert.match(copied, /enabled:\s*true/);
  const shipped = readFileSync(join(root, 'support/bot/skills/tess-support/scripts/inbox.mjs'));
  const installedScript = readFileSync(join(armEnv.HERMES_HOME, 'profiles/tess-support/skills/tess-support/scripts/inbox.mjs'));
  assert.ok(shipped.equals(installedScript));
  assert.equal(readFileSync(join(armEnv.HERMES_HOME, 'profiles/tess-support/.env'), 'utf8'), `TESS_SUPPORT_TOKEN=${token}\nTESS_INBOX=http://127.0.0.1:9\n`);
  sameTree(tree(join(armEnv.HERMES_HOME, 'profiles', 'tess-support')), reference, 'install.sh beside a checkout');
  const curlOnce = readFileSync(join(arm.log, 'curl.log'), 'utf8');
  assert.match(curlOnce, /stable-mac\.yml/);
  assert.match(curlOnce, /mac-arm64\.dmg/);
  assert.equal((readFileSync(join(arm.log, 'killall.log'), 'utf8').match(/^Dock$/gm) || []).length, 1);
  assert.equal(urlsInDock(arm.plist).filter((url) => url.includes('Tess%20Support.app')).length, 1);

  // A reinstall replaces the listed files whole and keeps an unsent visit in cache/.
  const armProfile = join(armEnv.HERMES_HOME, 'profiles', 'tess-support');
  writeFileSync(join(armProfile, 'skills', 'tess-gather', 'stale.md'), 'old\n');
  mkdirSync(join(armProfile, 'cache', 'support', 'sessions', 'visit-1'), { recursive: true });
  writeFileSync(join(armProfile, 'cache', 'support', 'sessions', 'visit-1', 'words.txt'), 'unsent\n');
  const second = run([], armEnv);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(urlsInDock(arm.plist).filter((url) => url.includes('Tess%20Support.app')).length, 1);
  assert.equal((readFileSync(join(arm.log, 'killall.log'), 'utf8').match(/^Dock$/gm) || []).length, 1);
  assert.equal(readFileSync(join(arm.log, 'curl.log'), 'utf8'), curlOnce);
  assert.equal(existsSync(join(armProfile, 'skills', 'tess-gather', 'stale.md')), false);
  assert.equal(readFileSync(join(armProfile, 'cache', 'support', 'sessions', 'visit-1', 'words.txt'), 'utf8'), 'unsent\n');
  assertOnlyEnv(arm);

  // Uninstall must leave Spotify and Tess exactly as they were.
  const spotifyFile = join(armEnv.TESS_APPLICATIONS, 'Spotify.app', 'Contents', 'Resources', 'Apps', 'xpui.spa');
  const tessFiles = [
    join(armEnv.HOME, 'Library', 'Application Support', 'Tess', 'guard.log'),
    join(armEnv.HOME, 'Library', 'Application Support', 'Tess', 'tess'),
    join(armEnv.HOME, '.local', 'bin', 'tess'),
  ];
  for (const path of [spotifyFile, ...tessFiles]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `sentinel ${path}\n`);
  }
  const keepTree = (path) => tree(join(path, '..'));
  const spotifyBefore = tree(join(armEnv.TESS_APPLICATIONS, 'Spotify.app'));
  const tessBefore = tessFiles.map(keepTree);

  mkdirSync(join(armEnv.HERMES_HOME, 'profiles', 'other'), { recursive: true });
  writeFileSync(join(armEnv.HERMES_HOME, 'profiles', 'other', 'keep'), 'leave this profile\n');
  mkdirSync(join(armEnv.HOME, 'Applications', 'NotOurs.app'), { recursive: true });
  writeFileSync(join(armEnv.HOME, 'Applications', 'NotOurs.app', 'keep'), 'leave this app\n');
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :persistent-apps: dict', arm.plist]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :persistent-apps:1:tile-type string file-tile', arm.plist]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :persistent-apps:1:tile-data dict', arm.plist]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :persistent-apps:1:tile-data:file-data dict', arm.plist]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :persistent-apps:1:tile-data:file-data:_CFURLString string file:///Applications/Other.app/', arm.plist]);

  const removed = run(['--uninstall'], armEnv);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Ask Krish to revoke your code/);
  assert.match(removed.stdout, /Hermes is still installed/);
  assert.equal(existsSync(join(armEnv.HERMES_HOME, 'profiles', 'tess-support')), false);
  assert.equal(readFileSync(join(armEnv.HERMES_HOME, 'profiles', 'other', 'keep'), 'utf8'), 'leave this profile\n');
  assert.equal(existsSync(join(armEnv.HOME, 'Applications', 'Tess Support.app')), false);
  assert.equal(readFileSync(join(armEnv.HOME, 'Applications', 'NotOurs.app', 'keep'), 'utf8'), 'leave this app\n');
  assert.equal(existsSync(join(armEnv.TESS_APPLICATIONS, 'Hermes.app')), true);
  const after = urlsInDock(arm.plist);
  assert.equal(after.some((url) => url.includes('Tess%20Support.app')), false);
  assert.equal(after.some((url) => url.includes('Other.app')), true);
  assert.equal(filesContaining(arm.box, token).length, 0);

  const gone = run(['--uninstall'], { ...armEnv, TESS_UNINSTALL_HERMES: 'yes' });
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(existsSync(join(armEnv.TESS_APPLICATIONS, 'Hermes.app')), false);
  assert.equal(readFileSync(join(armEnv.HERMES_HOME, 'profiles', 'other', 'keep'), 'utf8'), 'leave this profile\n');
  assert.equal(readFileSync(join(armEnv.HOME, 'Applications', 'NotOurs.app', 'keep'), 'utf8'), 'leave this app\n');
  assert.equal(urlsInDock(arm.plist).some((url) => url.includes('Other.app')), true);
  sameTree(tree(join(armEnv.TESS_APPLICATIONS, 'Spotify.app')), spotifyBefore, 'Spotify after uninstall');
  tessFiles.forEach((path, i) => sameTree(keepTree(path), tessBefore[i], 'Tess after uninstall'));
  assert.deepEqual(readdirSync(armEnv.TESS_APPLICATIONS).sort(), ['Spotify.app']);

  const blocked = layout('spctl');
  boxes.push(blocked.box);
  mkdirSync(join(blocked.box, 'tmp'));
  const blockedApps = join(blocked.box, 'Applications');
  mkdirSync(blockedApps);
  writeFileSync(join(blockedApps, 'DO_NOT_TOUCH'), 'sentinel\n');
  const before = readdirSync(blockedApps);
  const failed = run([], baseEnv(blocked, { TESS_ARCH: 'arm64', TESS_FAKE_SPCTL_EXIT: '1' }));
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Nothing was copied into Applications/);
  assert.deepEqual(readdirSync(blockedApps), before);
  assert.equal(readFileSync(join(blockedApps, 'DO_NOT_TOUCH'), 'utf8'), 'sentinel\n');
  assert.equal(existsSync(join(blocked.box, 'hermes', 'profiles', 'tess-support')), false);
  assert.equal(filesContaining(blocked.box, token).length, 0);
  assert.equal(existsSync(join(blocked.log, 'env-leak')), false);

  const intel = layout('intel');
  boxes.push(intel.box);
  mkdirSync(join(intel.box, 'tmp'));
  const intelRun = run([], baseEnv(intel, { TESS_ARCH: 'x86_64' }));
  assert.equal(intelRun.status, 0, intelRun.stderr);
  assert.match(intelRun.stdout, /Command Line Tools/);
  const curlLog = readFileSync(join(intel.log, 'curl.log'), 'utf8');
  assert.match(curlLog, /install\.sh/);
  assert.doesNotMatch(curlLog, /\.dmg|stable-mac\.yml/);
  assert.equal(existsSync(join(intel.log, 'hdiutil.log')), false);
  assert.equal(existsSync(join(intel.box, 'Applications', 'Hermes.app')), false);
  assert.match(readFileSync(join(intel.log, 'cli-args'), 'utf8'), /--non-interactive --skip-browser --skip-computer-use/);
  const intelLaunch = readFileSync(join(intel.box, 'home', 'Applications', 'Tess Support.app', 'Contents', 'MacOS', 'launch'), 'utf8');
  assert.match(intelLaunch, /hermes -p tess-support webapp/);
  assert.doesNotMatch(intelLaunch, /open -a /);
  assert.equal(readFileSync(join(intel.box, 'hermes', 'tess-support-we-installed'), 'utf8').trim(), 'cli');
  assertOnlyEnv(intel);
  sameTree(tree(join(intel.box, 'hermes', 'profiles', 'tess-support')), reference, 'Intel install');

  mkdirSync(join(intel.box, 'hermes', 'profiles', 'other'), { recursive: true });
  writeFileSync(join(intel.box, 'hermes', 'profiles', 'other', 'keep'), 'leave this profile\n');
  const intelGone = run(['--uninstall'], baseEnv(intel, { TESS_ARCH: 'x86_64', TESS_UNINSTALL_HERMES: 'yes' }));
  assert.equal(intelGone.status, 0, intelGone.stderr);
  assert.match(intelGone.stdout, /Hermes was removed/);
  assert.equal(existsSync(join(intel.box, 'home', '.local', 'bin', 'hermes')), false);
  assert.equal(existsSync(join(intel.box, 'hermes', 'hermes-agent')), false);
  assert.equal(existsSync(join(intel.box, 'hermes', 'profiles', 'tess-support')), false);
  assert.equal(existsSync(join(intel.box, 'hermes', 'tess-support-we-installed')), false);
  assert.equal(existsSync(join(intel.box, 'home', 'Applications', 'Tess Support.app')), false);
  assert.equal(readFileSync(join(intel.box, 'hermes', 'profiles', 'other', 'keep'), 'utf8'), 'leave this profile\n');
  assert.equal(urlsInDock(intel.plist).some((url) => url.includes('Tess%20Support.app')), false);

  // The pasted line: curl ... | sh. No checkout beside it, so every profile file is downloaded.
  const piped = layout('piped');
  boxes.push(piped.box);
  mkdirSync(join(piped.box, 'tmp'));
  const pipedRun = run([], baseEnv(piped, { TESS_ARCH: 'arm64' }), { piped: true, cwd: piped.box });
  assert.equal(pipedRun.status, 0, pipedRun.stderr);
  assert.match(readFileSync(join(piped.log, 'curl.log'), 'utf8'), /raw\.githubusercontent\.com\/Flame119052\/tess-music\/main\/support\/mac\/plugins\/tess-notes\/__init__\.py/);
  sameTree(tree(join(piped.box, 'hermes', 'profiles', 'tess-support')), reference, 'install.sh piped from curl');
  assertOnlyEnv(piped);
  const pipedGone = run(['--uninstall'], baseEnv(piped, { TESS_ARCH: 'arm64' }), { piped: true, cwd: piped.box });
  assert.equal(pipedGone.status, 0, pipedGone.stderr);
  assert.match(pipedGone.stdout, /Ask Krish to revoke your code/);
  assert.equal(existsSync(join(piped.box, 'hermes', 'profiles', 'tess-support')), false);

  // A symlinked HERMES_HOME or profiles folder is refused, and its target is not written.
  const linked = layout('linked');
  boxes.push(linked.box);
  mkdirSync(join(linked.box, 'tmp'));
  const elsewhere = join(linked.box, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(linked.box, 'hermes'));
  const linkHome = run([], baseEnv(linked, { TESS_ARCH: 'arm64' }));
  assert.notEqual(linkHome.status, 0);
  assert.match(linkHome.stderr, /symlink/);
  unlinkSync(join(linked.box, 'hermes'));
  mkdirSync(join(linked.box, 'hermes'));
  symlinkSync(elsewhere, join(linked.box, 'hermes', 'profiles'));
  const linkProfiles = run([], baseEnv(linked, { TESS_ARCH: 'arm64' }));
  assert.notEqual(linkProfiles.status, 0);
  assert.match(linkProfiles.stderr, /symlink/);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(filesContaining(linked.box, token).length, 0);

  const argPlace = layout('argv');
  boxes.push(argPlace.box);
  mkdirSync(join(argPlace.box, 'tmp'));
  const asArg = run([token], baseEnv(argPlace, { TESS_ARCH: 'arm64', TESS_SUPPORT_TOKEN: '' }));
  assert.notEqual(asArg.status, 0);
  assert.match(asArg.stderr, /Usage/);
  assert.equal(filesContaining(argPlace.box, token).length, 0);
  assert.equal(existsSync(join(argPlace.log, 'curl.log')), false);
} finally {
  for (const box of boxes) rmSync(box, { recursive: true, force: true });
}

console.log('support mac install: all checks passed');
