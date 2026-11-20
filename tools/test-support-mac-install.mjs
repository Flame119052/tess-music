// The one-command Mac installer, against scratch folders and fake system tools.
// Never the real Dock, the real /Applications, or the real home.
// Usage: node tools/test-support-mac-install.mjs
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const install = join(root, 'support/mac/install.sh');
const token = `tess_${'0123456789abcdef'.repeat(4)}`;
const profileCommit = readFileSync(install, 'utf8').match(/^PROFILE_COMMIT=([0-9a-f]{40})$/m)[1];
const hermesTeam = readFileSync(install, 'utf8').match(/^HERMES_TEAM='([A-Z0-9]{10})'$/m)[1];
const hermesId = readFileSync(install, 'utf8').match(/^HERMES_ID='([^']+)'$/m)[1];
const cliUrl = readFileSync(install, 'utf8').match(/^CLI_URL=(\S+)$/m)[1];
const cliStub = `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'hermes 0.22.0'
  exit 0
fi
printf '%s\\n' "$*" > "$TESS_FAKE_LOG/cli-args"
if [ -n "\${TESS_SUPPORT_TOKEN:-}" ]; then printf '%s\\n' leak >> "$TESS_FAKE_LOG/env-leak"; fi
if [ -n "\${HERMES_REPO_URL:-}" ]; then printf '%s\\n' HERMES_REPO_URL >> "$TESS_FAKE_LOG/cli-env"; fi
if [ -n "\${HERMES_INSTALL_CHANNEL:-}" ]; then printf '%s\\n' HERMES_INSTALL_CHANNEL >> "$TESS_FAKE_LOG/cli-env"; fi
if [ -n "\${HERMES_INSTALL_DIR:-}" ]; then printf '%s\\n' HERMES_INSTALL_DIR >> "$TESS_FAKE_LOG/cli-env"; fi
if [ -n "\${HERMES_INSTALL_VERBOSE:-}" ]; then printf '%s\\n' HERMES_INSTALL_VERBOSE >> "$TESS_FAKE_LOG/cli-env"; fi
if [ -n "\${HERMES_RUNTIME_DIR:-}" ]; then printf '%s\\n' HERMES_RUNTIME_DIR >> "$TESS_FAKE_LOG/cli-env"; fi
if [ -n "\${UV_CMD:-}" ]; then printf '%s\\n' UV_CMD >> "$TESS_FAKE_LOG/cli-env"; fi
if [ -n "\${UV_PIN_URL:-}" ]; then printf '%s\\n' UV_PIN_URL >> "$TESS_FAKE_LOG/cli-env"; fi
if [ -n "\${UV_PIN_SHA256:-}" ]; then printf '%s\\n' UV_PIN_SHA256 >> "$TESS_FAKE_LOG/cli-env"; fi
if [ -n "\${UV_PIN_MIRROR:-}" ]; then printf '%s\\n' UV_PIN_MIRROR >> "$TESS_FAKE_LOG/cli-env"; fi
mkdir -p "$HOME/.local/bin" "$HERMES_HOME/hermes-agent"
cat > "$HOME/.local/bin/hermes" <<'END'
#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'hermes 0.22.0'
  exit 0
fi
exit 0
END
chmod +x "$HOME/.local/bin/hermes"
printf '%s\\n' agent > "$HERMES_HOME/hermes-agent/README"
exit 0
`;
const decoy = 'sk-opencode-this-must-not-be-written';
const nodeVersion = readFileSync(install, 'utf8').match(/^NODE_VERSION=(v\d+\.\d+\.\d+)$/m)[1];
const fakeNode = join(mkdtempSync(join(tmpdir(), 'tess-support-fake-node-')), 'node');
writeFileSync(fakeNode, '#!/bin/sh\nprintf \'%s\\n\' tess-support-node\n');
chmodSync(fakeNode, 0o755);
const packNode = (arch) => {
  const dir = mkdtempSync(join(tmpdir(), `tess-support-node-${arch}-`));
  const top = `node-${nodeVersion}-darwin-${arch}`;
  mkdirSync(join(dir, top, 'bin'), { recursive: true });
  mkdirSync(join(dir, top, 'lib', 'npm', 'bin'), { recursive: true });
  writeFileSync(join(dir, top, 'bin', 'node'), readFileSync(fakeNode));
  chmodSync(join(dir, top, 'bin', 'node'), 0o755);
  writeFileSync(join(dir, top, 'lib', 'should-not-land'), 'no\n');
  writeFileSync(join(dir, top, 'lib', 'npm', 'bin', 'node-gyp'), 'not-the-runtime\n');
  const archive = join(dir, `${top}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dir, top]);
  return readFileSync(archive);
};
const armTar = packNode('arm64');
const x64Tar = packNode('x64');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const armHash = sha256(armTar);
const x64Hash = sha256(x64Tar);
const cliHash = sha256(cliStub);
// A separate process: the installer is started with execFileSync, which would
// stop an in-process server from answering.
const serveDir = join(fakeNode, '..');
const armPath = join(serveDir, 'arm.tar.gz');
const x64Path = join(serveDir, 'x64.tar.gz');
const tamperFlag = join(serveDir, 'tamper');
writeFileSync(armPath, armTar);
writeFileSync(x64Path, x64Tar);
const serverFile = join(serveDir, 'server.mjs');
writeFileSync(serverFile, `import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
const arm = readFileSync(process.env.ARM);
const x64 = readFileSync(process.env.X64);
const armHash = process.env.ARM_HASH;
const x64Hash = process.env.X64_HASH;
const tamperFlag = process.env.TAMPER_FLAG;
const sumsFor = (version) => ['arm64', 'x64'].map((arch) => {
  const name = 'node-' + version + '-darwin-' + arch + '.tar.gz';
  return (arch === 'arm64' ? armHash : x64Hash) + '  ' + name;
}).join('\\n') + '\\n';
const server = createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  const match = url.match(/^\\/dist\\/(v\\d+\\.\\d+\\.\\d+)\\/(.+)$/);
  if (!match) { res.writeHead(404); res.end('no'); return; }
  const version = match[1];
  const name = match[2];
  if (name === 'SHASUMS256.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(sumsFor(version));
    return;
  }
  const darwin = name.endsWith('darwin-arm64.tar.gz') ? 'darwin-arm64' : name.endsWith('darwin-x64.tar.gz') ? 'darwin-x64' : '';
  const body = darwin === 'darwin-arm64' ? arm : darwin === 'darwin-x64' ? x64 : null;
  if (!body || name !== 'node-' + version + '-' + darwin + '.tar.gz') {
    res.writeHead(404); res.end('no'); return;
  }
  const bytes = existsSync(tamperFlag) ? Buffer.concat([body, Buffer.from('x')]) : body;
  res.writeHead(200, { 'content-type': 'application/gzip' });
  res.end(bytes);
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`);
const nodeChild = spawn(process.execPath, [serverFile], {
  env: {
    ...process.env, ARM: armPath, X64: x64Path, ARM_HASH: armHash, X64_HASH: x64Hash, TAMPER_FLAG: tamperFlag,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let nodeErr = '';
nodeChild.stderr.on('data', (chunk) => { nodeErr += chunk; });
const nodePort = await new Promise((resolve, reject) => {
  let buf = '';
  nodeChild.stdout.on('data', (chunk) => {
    buf += chunk;
    const end = buf.indexOf('\n');
    if (end !== -1) resolve(buf.slice(0, end).trim());
  });
  nodeChild.on('exit', (code) => reject(new Error(`fake nodejs.org exited ${code}: ${nodeErr}`)));
});

const loginHome = () => {
  const user = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).trim();
  let dir = '';
  try {
    const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8' });
    const line = out.split('\n').find((row) => row.startsWith('NFSHomeDirectory:'));
    dir = line?.slice('NFSHomeDirectory:'.length).trim() || '';
  } catch {
    const row = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).split('\n')[0] || '';
    dir = row.split(':')[5] || '';
  }
  if (!dir.startsWith('/')) throw new Error('the login home was not found');
  return dir;
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
  // plutil is the Mac converter. The same plist is JSON either way.
  const raw = existsSync('/usr/bin/plutil')
    ? execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })
    : execFileSync('python3', ['-c', `
import json, plistlib, sys
with open(sys.argv[1], 'rb') as handle:
    print(json.dumps(plistlib.load(handle)))
`, plist], { encoding: 'utf8' });
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
  https://raw.githubusercontent.com/Flame119052/tess-music/${profileCommit}/*)
    rel=\${url#https://raw.githubusercontent.com/Flame119052/tess-music/${profileCommit}/}
    case $rel in *..*) exit 1 ;; esac
    [ -f "$TESS_FAKE_REPO/$rel" ] || exit 22
    cp "$TESS_FAKE_REPO/$rel" "$out"
    if [ "\${TESS_FAKE_BAD_PROFILE:-}" = 1 ] && [ "$rel" = "support/mac/SOUL.md" ]; then
      printf 'tampered\\n' >> "$out"
    fi
    ;;
  *stable-mac.yml)
    payload="$TESS_FAKE_LOG/payload"
    printf 'dmg!!' > "$payload"
    hash=$(/usr/bin/openssl dgst -sha512 -binary "$payload" | /usr/bin/openssl base64 | tr -d '\\n')
    printf '%s\\n' "version: 9.9.9" "files:" "  - url: /releases/tag/v9.9.9/HermesBundled-9.9.9-mac-arm64.dmg" "    sha512: $hash" "    size: 5" > "$out"
    ;;
  *.dmg)
    if [ "\${TESS_FAKE_BAD_DMG:-}" = 1 ]; then
      printf 'dmg!!bad' > "$out"
    else
      printf 'dmg!!' > "$out"
    fi
    ;;
  https://nodejs.org/dist/*)
    case $url in
      *..*) exit 1 ;;
    esac
    rel=\${url#https://nodejs.org}
    /usr/bin/curl -fsSL --proto '=http' --retry 0 -o "$out" "http://127.0.0.1:\${TESS_NODE_PORT}\${rel}"
    ;;
  *install.sh)
    cat > "$out" <<'TESS_STUB'
${cliStub}TESS_STUB
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
if [ "\${TESS_FAKE_APP_LINK:-}" = 1 ]; then
  mkdir -p "$mp/real-app"
  ln -s real-app "$mp/Hermes Agent.app"
  exit 0
fi
mkdir -p "$mp/Hermes Agent.app/Contents/MacOS"
printf '%s\\n' '#!/bin/sh' 'exit 0' > "$mp/Hermes Agent.app/Contents/MacOS/Hermes"
chmod +x "$mp/Hermes Agent.app/Contents/MacOS/Hermes"
ver=\${TESS_FAKE_HERMES_VERSION:-0.22.0}
cat > "$mp/Hermes Agent.app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>$ver</string></dict></plist>
EOF
exit 0
`);
  // ditto is the Mac copy. The sandbox uses cp so this check does not need a Mac.
  writeBin(bin, 'ditto', `#!/bin/sh
case \${2:-} in
  /Applications|/Applications/*)
    printf '%s\\n' 'refusing real Applications' >> "$TESS_FAKE_LOG/ditto.log"
    exit 99
    ;;
esac
if [ "\${TESS_FAKE_DITTO_EXIT:-0}" != 0 ]; then
  if [ -n "\${2:-}" ]; then
    mkdir -p "$2"
    printf '%s\\n' partial > "$2/PARTIAL"
  fi
  exit "\${TESS_FAKE_DITTO_EXIT}"
fi
[ "$#" = 2 ] || exit 2
cp -R "$1" "$2"
`);
  writeBin(bin, 'mv', `#!/bin/sh
if [ "\${TESS_FAKE_MV_EXIT:-0}" != 0 ]; then
  for a in "$@"; do
    case $a in
      */Hermes.app|*"Hermes Agent.app") exit "\${TESS_FAKE_MV_EXIT}" ;;
    esac
  done
fi
if [ "\${TESS_FAKE_MV_INCOMING_EXIT:-}" = 1 ]; then case $1 in */.tess-support.incoming) exit 1 ;; esac; fi
/bin/mv "$@" || exit $?
case "$2" in
  */.tess-support.previous)
    if [ "\${TESS_FAKE_MV_RECREATE:-}" = 1 ]; then
      /bin/mkdir -p "$(dirname "$2")/tess-support/logs"
    fi
    if [ -n "\${TESS_FAKE_MV_SLEEP:-}" ]; then
      sleep "$TESS_FAKE_MV_SLEEP"
    fi
    if [ "\${TESS_FAKE_MV_SIGNAL:-}" = 1 ]; then
      kill -INT "$PPID"
      exit 0
    fi
    ;;
esac
exit 0
`);
  // A Mac uses PlistBuddy. Linux does not have it; the Dock checks still run.
  const appleBuddy = ['/usr', 'libexec', 'PlistBuddy'].join('/');
  writeBin(bin, 'PlistBuddy', `#!/bin/sh
if [ -x ${appleBuddy} ]; then
  exec ${appleBuddy} "$@"
fi
exec python3 ${join(root, 'tools/plist-buddy.py')} "$@"
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
    PlistBuddy -c 'Print :persistent-apps' "$plist"
    ;;
  write)
    [ "$3" = "persistent-apps" ] && [ "$4" = "-array-add" ] || exit 2
    url=$(printf '%s' "$5" | sed -n 's/.*_CFURLString<\\/key><string>\\([^<]*\\)<\\/string>.*/\\1/p' | head -1)
    [ -n "$url" ] || exit 2
    if [ ! -f "$plist" ]; then
      printf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' '<plist version="1.0"><dict/></plist>' > "$plist"
    fi
    if ! PlistBuddy -c 'Print :persistent-apps' "$plist" >/dev/null 2>&1; then
      PlistBuddy -c 'Add :persistent-apps array' "$plist"
    fi
    count=0
    while PlistBuddy -c "Print :persistent-apps:\${count}" "$plist" >/dev/null 2>&1; do
      count=$((count + 1))
    done
    PlistBuddy -c "Add :persistent-apps:\${count} dict" "$plist"
    PlistBuddy -c "Add :persistent-apps:\${count}:tile-type string file-tile" "$plist"
    PlistBuddy -c "Add :persistent-apps:\${count}:tile-data dict" "$plist"
    PlistBuddy -c "Add :persistent-apps:\${count}:tile-data:file-label string Tess Support" "$plist"
    PlistBuddy -c "Add :persistent-apps:\${count}:tile-data:file-data dict" "$plist"
    PlistBuddy -c "Add :persistent-apps:\${count}:tile-data:file-data:_CFURLString string \${url}" "$plist"
    PlistBuddy -c "Add :persistent-apps:\${count}:tile-data:file-data:_CFURLStringType integer 15" "$plist"
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
  TESS_NODE_PORT: String(nodePort),
  TESS_NODE_SHA_ARM64: armHash,
  TESS_NODE_SHA_X64: x64Hash,
  TESS_HERMES_CLI_SHA: cliHash,
  OPENCODE_GO_API_KEY: decoy,
  LANG: 'C',
  ...extra,
});

// piped runs the script the way a person does: curl ... | sh. It then has no checkout beside it.
const run = (args, env, { piped = false, cwd } = {}) => {
  const r = piped
    ? spawnSync('/bin/sh', ['-s', '--', ...args], {
      encoding: 'utf8', env, cwd, input: readFileSync(install, 'utf8'),
    })
    : spawnSync('/bin/sh', [install, ...args], { encoding: 'utf8', env });
  return {
    status: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
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
      TESS_NODE_RUNTIME: fakeNode,
    },
  });
  assert.equal(refOut, 'via copy\n');
  const reference = tree(join(ref, 'hermes', 'profiles', 'tess-support'));
  for (const name of ['plugins/tess-visit/__init__.py', 'plugins/tess-visit/plugin.yaml', 'skills/tess-gather/scripts/doctor.mjs',
    'skills/tess-evidence/scripts/spotify-window.mjs', 'skills/tess-handoff/scripts/triage-inbox.mjs',
    'skills/tess-support/scripts/session.mjs', 'config.yaml', 'distribution.yaml', 'SOUL.md', '.env',
    'runtime/node/bin/node', 'runtime/node/VERSION']) {
    assert.ok(reference.has(name), `install.mjs did not install ${name}`);
  }
  assert.ok(reference.get('runtime/node/bin/node').equals(readFileSync(fakeNode)));
  assert.equal(reference.get('runtime/node/VERSION').toString(), `${nodeVersion}\n`);
  assert.equal([...reference.keys()].some((name) => name.includes('should-not-land') || name.includes('node-gyp')), false);

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
  assert.equal(existsSync(join(armEnv.TESS_APPLICATIONS, 'Hermes Agent.app')), true);
  assert.equal(readFileSync(join(armEnv.HERMES_HOME, 'tess-support-app-name'), 'utf8').trim(), 'Hermes Agent.app');
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
  const signed = readFileSync(join(arm.log, 'codesign.log'), 'utf8');
  assert.match(signed, /--verify/);
  assert.ok(signed.includes(`certificate leaf[subject.OU] = "${hermesTeam}"`), signed);
  assert.ok(signed.includes('certificate 1[field.1.2.840.113635.100.6.2.6]'), signed);
  assert.ok(signed.includes('certificate leaf[field.1.2.840.113635.100.6.1.13]'), signed);
  assert.ok(signed.includes(`identifier "${hermesId}"`), signed);
  assert.match(curlOnce, new RegExp(`node-${nodeVersion.replaceAll('.', '\\.')}-darwin-arm64\\.tar\\.gz`));
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
  const buddy = join(arm.bin, 'PlistBuddy');
  execFileSync(buddy, ['-c', 'Add :persistent-apps: dict', arm.plist]);
  execFileSync(buddy, ['-c', 'Add :persistent-apps:1:tile-type string file-tile', arm.plist]);
  execFileSync(buddy, ['-c', 'Add :persistent-apps:1:tile-data dict', arm.plist]);
  execFileSync(buddy, ['-c', 'Add :persistent-apps:1:tile-data:file-data dict', arm.plist]);
  execFileSync(buddy, ['-c', 'Add :persistent-apps:1:tile-data:file-data:_CFURLString string file:///Applications/Other.app/', arm.plist]);

  const removed = run(['--uninstall'], armEnv);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Ask Krish to revoke your code/);
  assert.match(removed.stdout, /Hermes is still installed/);
  assert.equal(existsSync(join(armEnv.HERMES_HOME, 'profiles', 'tess-support')), false);
  assert.equal(existsSync(join(armProfile, 'runtime', 'node')), false);
  assert.equal(readFileSync(join(armEnv.HERMES_HOME, 'profiles', 'other', 'keep'), 'utf8'), 'leave this profile\n');
  assert.equal(existsSync(join(armEnv.HOME, 'Applications', 'Tess Support.app')), false);
  assert.equal(readFileSync(join(armEnv.HOME, 'Applications', 'NotOurs.app', 'keep'), 'utf8'), 'leave this app\n');
  assert.equal(existsSync(join(armEnv.TESS_APPLICATIONS, 'Hermes Agent.app')), true);
  const after = urlsInDock(arm.plist);
  assert.equal(after.some((url) => url.includes('Tess%20Support.app')), false);
  assert.equal(after.some((url) => url.includes('Other.app')), true);
  assert.equal(filesContaining(arm.box, token).length, 0);

  const gone = run(['--uninstall'], { ...armEnv, TESS_UNINSTALL_HERMES: 'yes' });
  assert.equal(gone.status, 0, gone.stderr);
  assert.match(gone.stdout, /Hermes was removed/);
  assert.equal(existsSync(join(armEnv.TESS_APPLICATIONS, 'Hermes Agent.app')), false);
  assert.equal(existsSync(join(armEnv.HERMES_HOME, 'tess-support-we-installed')), false);
  assert.equal(existsSync(join(armEnv.HERMES_HOME, 'tess-support-app-name')), false);
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
  const intelRun = run([], baseEnv(intel, {
    TESS_ARCH: 'x86_64',
    HERMES_REPO_URL: 'https://evil.example/hermes.git',
    HERMES_INSTALL_CHANNEL: 'main',
    HERMES_INSTALL_DIR: '/tmp/not-the-hermes-agent',
    HERMES_INSTALL_VERBOSE: '1',
    HERMES_RUNTIME_DIR: '/tmp/not-the-runtime',
    UV_CMD: '/tmp/not-uv',
    UV_PIN_URL: 'https://evil.example/uv.tar.gz',
    UV_PIN_SHA256: 'ab'.repeat(32),
    UV_PIN_MIRROR: 'https://evil.example/uv-mirror.tar.gz',
  }));
  assert.equal(intelRun.status, 0, intelRun.stderr);
  assert.match(intelRun.stdout, /Command Line Tools/);
  const curlLog = readFileSync(join(intel.log, 'curl.log'), 'utf8');
  assert.ok(curlLog.includes(cliUrl), curlLog);
  assert.equal(curlLog.includes('hermes-agent/v0.23.2/'), false);
  assert.match(curlLog, new RegExp(`node-${nodeVersion.replaceAll('.', '\\.')}-darwin-x64\\.tar\\.gz`));
  assert.doesNotMatch(curlLog, /\.dmg|stable-mac\.yml/);
  assert.equal(existsSync(join(intel.log, 'hdiutil.log')), false);
  assert.equal(existsSync(join(intel.log, 'cli-env')), false);
  assert.equal(existsSync(join(intel.box, 'Applications', 'Hermes.app')), false);
  assert.equal(existsSync(join(intel.box, 'Applications', 'Hermes Agent.app')), false);
  assert.match(readFileSync(join(intel.log, 'cli-args'), 'utf8'), /--non-interactive --skip-browser --skip-computer-use/);
  const intelLaunch = readFileSync(join(intel.box, 'home', 'Applications', 'Tess Support.app', 'Contents', 'MacOS', 'launch'), 'utf8');
  const intelHermes = realpathSync(join(intel.box, 'home', '.local', 'bin', 'hermes'));
  assert.match(intelLaunch, new RegExp(`exec '${intelHermes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' -p tess-support webapp`));
  assert.doesNotMatch(intelLaunch, /exec hermes /);
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
  assert.match(readFileSync(join(piped.log, 'curl.log'), 'utf8'), new RegExp(`raw\\.githubusercontent\\.com/Flame119052/tess-music/${profileCommit}/support/mac/plugins/tess-visit/__init__\\.py`));
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

  // A bad checksum is refused before the profile changes. The earlier runtime stays.
  const prior = layout('checksum');
  boxes.push(prior.box);
  mkdirSync(join(prior.box, 'tmp'));
  const priorEnv = baseEnv(prior, { TESS_ARCH: 'arm64' });
  const priorRun = run([], priorEnv);
  assert.equal(priorRun.status, 0, priorRun.stderr);
  const priorProfile = join(priorEnv.HERMES_HOME, 'profiles', 'tess-support');
  writeFileSync(join(priorProfile, 'cache-marker.txt'), 'leave this\n');
  const priorTree = tree(priorProfile);
  writeFileSync(tamperFlag, '1\n');
  const wrong = run([], { ...priorEnv, TESS_NODE_VERSION: 'v0.0.0' });
  unlinkSync(tamperFlag);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /did not match the checksum/);
  assert.match(wrong.stderr, /Nothing was unpacked into the profile/);
  sameTree(tree(priorProfile), priorTree, 'a wrong Node checksum');

  // uname -m picks the archive name when a test does not set TESS_ARCH.
  const host = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();
  const hostName = host === 'arm64' ? 'darwin-arm64' : host === 'x86_64' ? 'darwin-x64' : '';
  assert.ok(hostName, `uname -m was ${host}`);
  const named = layout('uname');
  boxes.push(named.box);
  mkdirSync(join(named.box, 'tmp'));
  const namedRun = run([], baseEnv(named));
  assert.equal(namedRun.status, 0, namedRun.stderr);
  const namedLog = readFileSync(join(named.log, 'curl.log'), 'utf8');
  assert.match(namedLog, new RegExp(`node-${nodeVersion.replaceAll('.', '\\.')}-${hostName}\\.tar\\.gz`));
  const otherArch = host === 'arm64' ? 'x86_64' : 'arm64';
  const otherName = otherArch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  const other = layout('other-arch');
  boxes.push(other.box);
  mkdirSync(join(other.box, 'tmp'));
  const otherRun = run([], baseEnv(other, { TESS_ARCH: otherArch }));
  assert.equal(otherRun.status, 0, otherRun.stderr);
  assert.match(readFileSync(join(other.log, 'curl.log'), 'utf8'), new RegExp(`node-${nodeVersion.replaceAll('.', '\\.')}-${otherName}\\.tar\\.gz`));
  assert.doesNotMatch(readFileSync(join(other.log, 'curl.log'), 'utf8'), new RegExp(`node-${nodeVersion.replaceAll('.', '\\.')}-${hostName}\\.tar\\.gz`));

  const shippedConfig = readFileSync(join(root, 'support/mac/config.yaml'), 'utf8');
  assert.doesNotMatch(shippedConfig, /^command_allowlist:/m);
  assert.equal(readFileSync(join(priorProfile, 'config.yaml'), 'utf8'), shippedConfig, 'install.sh rewrote the profile config');
  assert.equal(reference.get('config.yaml').toString(), shippedConfig, 'install.mjs rewrote the profile config');
  const pluginNode = execFileSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("tess_visit", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(mod.resolve_node(sys.argv[2]))
`, join(priorProfile, 'plugins/tess-visit/__init__.py'), priorProfile], { encoding: 'utf8' }).trim();
  assert.equal(pluginNode, realpathSync(join(priorProfile, 'runtime/node/bin/node')));

  const argPlace = layout('argv');
  boxes.push(argPlace.box);
  mkdirSync(join(argPlace.box, 'tmp'));
  const asArg = run([token], baseEnv(argPlace, { TESS_ARCH: 'arm64', TESS_SUPPORT_TOKEN: '' }));
  assert.notEqual(asArg.status, 0);
  assert.match(asArg.stderr, /Usage/);
  assert.equal(filesContaining(argPlace.box, token).length, 0);
  assert.equal(existsSync(join(argPlace.log, 'curl.log')), false);

  const seedApps = (place) => {
    const apps = join(place.box, 'Applications');
    mkdirSync(apps, { recursive: true });
    writeFileSync(join(apps, 'DO_NOT_TOUCH'), 'sentinel\n');
    return apps;
  };
  const appsUntouched = (place) => {
    const apps = join(place.box, 'Applications');
    assert.deepEqual(readdirSync(apps).sort(), ['DO_NOT_TOUCH']);
    assert.equal(readFileSync(join(apps, 'DO_NOT_TOUCH'), 'utf8'), 'sentinel\n');
    assert.equal(existsSync(join(apps, 'Hermes.app')), false);
    assert.equal(existsSync(join(apps, 'Hermes Agent.app')), false);
    assert.equal(existsSync(join(apps, '.Hermes.app.tess-incoming')), false);
    assert.equal(existsSync(join(apps, '.Hermes Agent.app.tess-incoming')), false);
  };
  const plist = (version) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`;
  const hermesBin = (version) => `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'hermes ${version}'; exit 0; fi
exit 0
`;

  const badSign = layout('codesign');
  boxes.push(badSign.box);
  mkdirSync(join(badSign.box, 'tmp'));
  seedApps(badSign);
  const badSignRun = run([], baseEnv(badSign, { TESS_ARCH: 'arm64', TESS_FAKE_CODESIGN_EXIT: '1' }));
  assert.notEqual(badSignRun.status, 0);
  assert.match(badSignRun.stderr, /Nothing was copied into Applications/);
  appsUntouched(badSign);
  assert.equal(existsSync(join(badSign.box, 'hermes', 'profiles', 'tess-support')), false);

  const badDmg = layout('dmg');
  boxes.push(badDmg.box);
  mkdirSync(join(badDmg.box, 'tmp'));
  seedApps(badDmg);
  const badDmgRun = run([], baseEnv(badDmg, { TESS_ARCH: 'arm64', TESS_FAKE_BAD_DMG: '1' }));
  assert.notEqual(badDmgRun.status, 0);
  assert.match(badDmgRun.stderr, /did not match Hermes's published checksum/);
  assert.match(badDmgRun.stderr, /Nothing was copied into Applications/);
  appsUntouched(badDmg);

  const badDitto = layout('ditto');
  boxes.push(badDitto.box);
  mkdirSync(join(badDitto.box, 'tmp'));
  seedApps(badDitto);
  const badDittoRun = run([], baseEnv(badDitto, { TESS_ARCH: 'arm64', TESS_FAKE_DITTO_EXIT: '1' }));
  assert.notEqual(badDittoRun.status, 0);
  appsUntouched(badDitto);
  assert.equal(existsSync(join(badDitto.box, 'Applications', '.Hermes Agent.app.tess-incoming', 'PARTIAL')), false);
  assert.equal(existsSync(join(badDitto.box, 'hermes', 'profiles', 'tess-support')), false);

  const badMove = layout('mv');
  boxes.push(badMove.box);
  mkdirSync(join(badMove.box, 'tmp'));
  seedApps(badMove);
  const badMoveRun = run([], baseEnv(badMove, { TESS_ARCH: 'arm64', TESS_FAKE_MV_EXIT: '1' }));
  assert.notEqual(badMoveRun.status, 0);
  assert.match(badMoveRun.stderr, /Applications was left as it was/);
  appsUntouched(badMove);

  const existingApp = layout('existing-app');
  boxes.push(existingApp.box);
  mkdirSync(join(existingApp.box, 'tmp'));
  const existingBundle = join(existingApp.box, 'Applications', 'Hermes.app');
  mkdirSync(join(existingBundle, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(existingBundle, 'SENTINEL'), 'keep\n');
  writeFileSync(join(existingBundle, 'Contents', 'Info.plist'), plist('0.22.0'));
  const existingCli = join(existingBundle, 'Contents', 'MacOS', 'hermes');
  writeFileSync(existingCli, hermesBin('0.22.0'));
  chmodSync(existingCli, 0o755);
  const existingRun = run([], baseEnv(existingApp, { TESS_ARCH: 'arm64' }));
  assert.equal(existingRun.status, 0, existingRun.stderr);
  assert.match(existingRun.stdout, /profile you already use stays as it is/);
  assert.equal(readFileSync(join(existingBundle, 'SENTINEL'), 'utf8'), 'keep\n');
  assert.equal(existsSync(join(existingApp.box, 'hermes', 'tess-support-we-installed')), false);
  assert.doesNotMatch(readFileSync(join(existingApp.log, 'curl.log'), 'utf8'), /stable-mac\.yml|\.dmg/);
  const existingLaunch = readFileSync(join(existingApp.box, 'home', 'Applications', 'Tess Support.app', 'Contents', 'MacOS', 'launch'), 'utf8');
  assert.match(existingLaunch, new RegExp(`exec '${realpathSync(existingCli).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' -p tess-support webapp`));
  assert.doesNotMatch(existingLaunch, /exec hermes /);

  const noCli = layout('no-cli');
  boxes.push(noCli.box);
  mkdirSync(join(noCli.box, 'tmp'));
  const noCliBundle = join(noCli.box, 'Applications', 'Hermes.app', 'Contents');
  mkdirSync(noCliBundle, { recursive: true });
  writeFileSync(join(noCli.box, 'Applications', 'Hermes.app', 'SENTINEL'), 'keep\n');
  writeFileSync(join(noCliBundle, 'Info.plist'), plist('0.22.0'));
  const noCliRun = run([], baseEnv(noCli, { TESS_ARCH: 'arm64' }));
  assert.notEqual(noCliRun.status, 0);
  assert.match(noCliRun.stderr, /could not find its hermes command/);
  assert.equal(readFileSync(join(noCli.box, 'Applications', 'Hermes.app', 'SENTINEL'), 'utf8'), 'keep\n');
  assert.equal(existsSync(join(noCli.box, 'hermes', 'profiles', 'tess-support', '.env')), false);

  const existingIntel = layout('existing-cli');
  boxes.push(existingIntel.box);
  mkdirSync(join(existingIntel.box, 'tmp'));
  const brewBin = join(existingIntel.box, 'homebrew', 'bin');
  mkdirSync(brewBin, { recursive: true });
  const brewHermes = join(brewBin, 'hermes');
  writeFileSync(brewHermes, hermesBin('0.22.0'));
  chmodSync(brewHermes, 0o755);
  const existingIntelRun = run([], baseEnv(existingIntel, {
    TESS_ARCH: 'x86_64',
    PATH: `${existingIntel.bin}:${brewBin}:/usr/bin:/bin:/usr/sbin`,
  }));
  assert.equal(existingIntelRun.status, 0, existingIntelRun.stderr);
  assert.match(existingIntelRun.stdout, /profile you already use stays as it is/);
  assert.equal(existsSync(join(existingIntel.log, 'cli-args')), false);
  assert.equal(readFileSync(join(existingIntel.log, 'curl.log'), 'utf8').includes(cliUrl), false);
  assert.equal(existsSync(join(existingIntel.box, 'hermes', 'tess-support-we-installed')), false);
  const brewLaunch = readFileSync(join(existingIntel.box, 'home', 'Applications', 'Tess Support.app', 'Contents', 'MacOS', 'launch'), 'utf8');
  assert.match(brewLaunch, new RegExp(`exec '${brewHermes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' -p tess-support webapp`));

  const oldCli = layout('old-cli');
  boxes.push(oldCli.box);
  mkdirSync(join(oldCli.box, 'tmp'));
  const oldBin = join(oldCli.box, 'old', 'bin');
  mkdirSync(oldBin, { recursive: true });
  writeFileSync(join(oldBin, 'hermes'), hermesBin('0.21.0'));
  chmodSync(join(oldBin, 'hermes'), 0o755);
  const oldRun = run([], baseEnv(oldCli, {
    TESS_ARCH: 'x86_64',
    PATH: `${oldCli.bin}:${oldBin}:/usr/bin:/bin:/usr/sbin`,
  }));
  assert.notEqual(oldRun.status, 0);
  assert.match(oldRun.stderr, /0\.21\.0/);
  assert.match(oldRun.stderr, /0\.22\.0 or newer/);
  assert.equal(existsSync(join(oldCli.box, 'hermes', 'profiles', 'tess-support')), false);

  const custom = layout('custom-profile');
  boxes.push(custom.box);
  mkdirSync(join(custom.box, 'tmp'));
  const customHome = join(custom.box, 'hermes');
  mkdirSync(customHome);
  writeFileSync(join(customHome, 'active_profile'), 'personal\n');
  const customDesk = join(custom.box, 'home', 'Library', 'Application Support', 'Hermes');
  mkdirSync(customDesk, { recursive: true });
  writeFileSync(join(customDesk, 'active-profile.json'), '{"profile":"personal"}\n');
  const customRun = run([], baseEnv(custom, { TESS_ARCH: 'arm64' }));
  assert.equal(customRun.status, 0, customRun.stderr);
  assert.equal(readFileSync(join(customHome, 'active_profile'), 'utf8'), 'personal\n');
  assert.equal(readFileSync(join(customDesk, 'active-profile.json'), 'utf8'), '{"profile":"personal"}\n');

  const badInbox = layout('inbox');
  boxes.push(badInbox.box);
  mkdirSync(join(badInbox.box, 'tmp'));
  const badInboxRun = run([], baseEnv(badInbox, { TESS_ARCH: 'arm64', TESS_INBOX: 'http://example.com' }));
  assert.notEqual(badInboxRun.status, 0);
  assert.match(badInboxRun.stderr, /TESS_INBOX must be https:\/\/tess-music-player\.janus\.ing/);
  assert.equal(existsSync(join(badInbox.box, 'hermes', 'profiles', 'tess-support', '.env')), false);

  const badCode = layout('bad-code');
  boxes.push(badCode.box);
  mkdirSync(join(badCode.box, 'tmp'));
  const badCodeRun = run([], baseEnv(badCode, { TESS_ARCH: 'arm64', TESS_SUPPORT_TOKEN: 'tess_not-a-real-code' }));
  assert.notEqual(badCodeRun.status, 0);
  assert.match(badCodeRun.stderr, /not one Krish issued/);
  assert.doesNotMatch(badCodeRun.stderr, /\/dev\/tty/);
  assert.equal(existsSync(join(badCode.box, 'hermes')), false, 'a bad code created HERMES_HOME');
  const badCodeRetry = run([], baseEnv(badCode, { TESS_ARCH: 'arm64' }));
  assert.equal(badCodeRetry.status, 0, badCodeRetry.stderr);
  assert.equal(readFileSync(join(badCode.box, 'hermes', 'active_profile'), 'utf8').trim(), 'tess-support');

  const badHash = layout('bad-hash');
  boxes.push(badHash.box);
  mkdirSync(join(badHash.box, 'tmp'));
  const badHashEnv = baseEnv(badHash, { TESS_ARCH: 'arm64' });
  const badHashFirst = run([], badHashEnv, { piped: true, cwd: badHash.box });
  assert.equal(badHashFirst.status, 0, badHashFirst.stderr);
  const badHashProfile = join(badHash.box, 'hermes', 'profiles', 'tess-support');
  mkdirSync(join(badHashProfile, 'cache'), { recursive: true });
  writeFileSync(join(badHashProfile, 'cache', 'keep.txt'), 'unsent\n');
  const badHashTree = tree(badHashProfile);
  const badHashSecond = run([], { ...badHashEnv, TESS_FAKE_BAD_PROFILE: '1' }, { piped: true, cwd: badHash.box });
  assert.notEqual(badHashSecond.status, 0);
  assert.match(badHashSecond.stderr, /did not match its pinned checksum/);
  assert.match(badHashSecond.stderr, /Nothing was changed in the profile/);
  sameTree(tree(badHashProfile), badHashTree, 'a wrong profile checksum');

  const badCli = layout('bad-cli-hash');
  boxes.push(badCli.box);
  mkdirSync(join(badCli.box, 'tmp'));
  seedApps(badCli);
  const badCliRun = run([], baseEnv(badCli, { TESS_ARCH: 'x86_64', TESS_HERMES_CLI_SHA: '0'.repeat(64) }));
  assert.notEqual(badCliRun.status, 0);
  assert.match(badCliRun.stderr, /did not match its pinned checksum/);
  assert.match(badCliRun.stderr, /It was not run/);
  assert.equal(existsSync(join(badCli.log, 'cli-args')), false);
  appsUntouched(badCli);

  const linkedOff = layout('linked-off');
  boxes.push(linkedOff.box);
  mkdirSync(join(linkedOff.box, 'tmp'));
  const linkedOffEnv = baseEnv(linkedOff, { TESS_ARCH: 'arm64' });
  const linkedOffRun = run([], linkedOffEnv);
  assert.equal(linkedOffRun.status, 0, linkedOffRun.stderr);
  const linkedProfiles = join(linkedOff.box, 'hermes', 'profiles');
  const linkedElsewhere = join(linkedOff.box, 'elsewhere');
  renameSync(linkedProfiles, linkedElsewhere);
  symlinkSync(linkedElsewhere, linkedProfiles);
  const linkedOffRemove = run(['--uninstall'], linkedOffEnv);
  assert.notEqual(linkedOffRemove.status, 0);
  assert.match(linkedOffRemove.stderr, /symlink/);
  assert.equal(readFileSync(join(linkedElsewhere, 'tess-support', '.env'), 'utf8').includes(token), true);
  assert.equal(existsSync(join(linkedOff.box, 'home', 'Applications', 'Tess Support.app')), true);

  const freshNode = layout('fresh-node');
  boxes.push(freshNode.box);
  mkdirSync(join(freshNode.box, 'tmp'));
  writeFileSync(tamperFlag, '1\n');
  let freshNodeRun;
  try {
    freshNodeRun = run([], baseEnv(freshNode, { TESS_ARCH: 'arm64' }));
  } finally {
    rmSync(tamperFlag, { force: true });
  }
  assert.notEqual(freshNodeRun.status, 0);
  assert.match(freshNodeRun.stderr, /did not match the checksum/);
  assert.equal(existsSync(join(freshNode.box, 'hermes')), false);
  assert.equal(existsSync(join(freshNode.box, 'Applications', 'Hermes Agent.app')), false);
  assert.equal(existsSync(join(freshNode.box, 'home', '.local', 'bin', 'hermes')), false);

  const freshProfile = layout('fresh-profile');
  boxes.push(freshProfile.box);
  mkdirSync(join(freshProfile.box, 'tmp'));
  const freshProfileRun = run([], baseEnv(freshProfile, { TESS_ARCH: 'arm64', TESS_FAKE_BAD_PROFILE: '1' }), { piped: true, cwd: freshProfile.box });
  assert.notEqual(freshProfileRun.status, 0);
  assert.match(freshProfileRun.stderr, /did not match its pinned checksum/);
  assert.equal(existsSync(join(freshProfile.box, 'hermes')), false);
  assert.equal(existsSync(join(freshProfile.box, 'Applications', 'Hermes Agent.app')), false);
  assert.equal(existsSync(join(freshProfile.box, 'home', '.local', 'bin', 'hermes')), false);

  const unknownName = layout('unknown-name');
  boxes.push(unknownName.box);
  mkdirSync(join(unknownName.box, 'tmp'));
  const unknownEnv = baseEnv(unknownName, { TESS_ARCH: 'arm64' });
  const unknownInstall = run([], unknownEnv);
  assert.equal(unknownInstall.status, 0, unknownInstall.stderr);
  writeFileSync(join(unknownName.box, 'hermes', 'tess-support-app-name'), 'Not Hermes.app\n');
  const unknownGone = run(['--uninstall'], { ...unknownEnv, TESS_UNINSTALL_HERMES: 'yes' });
  assert.equal(unknownGone.status, 0, unknownGone.stderr);
  assert.match(unknownGone.stderr, /not one this installer knows/);
  assert.doesNotMatch(unknownGone.stdout, /Hermes was removed/);
  assert.equal(existsSync(join(unknownName.box, 'Applications', 'Hermes Agent.app')), true);
  assert.equal(readFileSync(join(unknownName.box, 'hermes', 'tess-support-we-installed'), 'utf8').trim(), 'app');
  assert.equal(readFileSync(join(unknownName.box, 'hermes', 'tess-support-app-name'), 'utf8'), 'Not Hermes.app\n');

  const signalPlace = layout('signal');
  boxes.push(signalPlace.box);
  mkdirSync(join(signalPlace.box, 'tmp'));
  const signalEnv = baseEnv(signalPlace, { TESS_ARCH: 'arm64' });
  const signalFirst = run([], signalEnv);
  assert.equal(signalFirst.status, 0, signalFirst.stderr);
  const signalProfile = join(signalPlace.box, 'hermes', 'profiles', 'tess-support');
  mkdirSync(join(signalProfile, 'cache'), { recursive: true });
  writeFileSync(join(signalProfile, 'cache', 'keep.txt'), 'unsent\n');
  const signalEnvText = readFileSync(join(signalProfile, '.env'), 'utf8');
  const signalHit = run([], { ...signalEnv, TESS_FAKE_MV_SIGNAL: '1' });
  assert.notEqual(signalHit.status, 0);
  const signalPrevious = join(signalPlace.box, 'hermes', 'profiles', '.tess-support.previous');
  const signalIncoming = join(signalPlace.box, 'hermes', 'profiles', '.tess-support.incoming');
  assert.equal(existsSync(signalPrevious), false);
  assert.equal(existsSync(signalIncoming), false);
  assert.equal(readFileSync(join(signalProfile, 'cache', 'keep.txt'), 'utf8'), 'unsent\n');
  assert.equal(readFileSync(join(signalProfile, '.env'), 'utf8'), signalEnvText);
  assert.doesNotMatch(signalHit.stderr, /\/dev\/tty/);
  const signalAgain = run([], signalEnv);
  assert.equal(signalAgain.status, 0, signalAgain.stderr);
  assert.equal(readFileSync(join(signalProfile, 'cache', 'keep.txt'), 'utf8'), 'unsent\n');
  assert.equal(readFileSync(join(signalProfile, '.env'), 'utf8'), signalEnvText);

  const absent = layout('uninstall-absent');
  boxes.push(absent.box);
  mkdirSync(join(absent.box, 'tmp'));
  assert.equal(existsSync(join(absent.box, 'hermes')), false);
  const absentRun = run(['--uninstall'], baseEnv(absent, { TESS_ARCH: 'arm64' }));
  assert.equal(absentRun.status, 0, absentRun.stderr);
  assert.equal(existsSync(join(absent.box, 'hermes')), false);

  const linkedApps = layout('apps-link');
  boxes.push(linkedApps.box);
  mkdirSync(join(linkedApps.box, 'tmp'));
  const appsLink = join(linkedApps.box, 'apps-link');
  symlinkSync('/Applications', appsLink);
  const linkedAppsRun = run([], baseEnv(linkedApps, { TESS_ARCH: 'arm64', TESS_APPLICATIONS: appsLink }));
  assert.notEqual(linkedAppsRun.status, 0);
  assert.match(linkedAppsRun.stderr, /real Applications/);
  assert.equal(existsSync(join(linkedApps.log, 'hdiutil.log')), false);
  assert.equal(existsSync(join(linkedApps.log, 'ditto.log')), false);

  const login = loginHome();
  const hop = join(linkedApps.box, 'hop-to-login');
  symlinkSync(login, hop);
  const viaLink = join(hop, '.tess-support-install-ancestor-must-not-exist');
  const ancestorRun = run([], baseEnv(linkedApps, { TESS_ARCH: 'arm64', HERMES_HOME: viaLink }));
  assert.notEqual(ancestorRun.status, 0);
  assert.match(ancestorRun.stderr, /real home folder/);
  try {
    assert.equal(existsSync(viaLink), false);
  } finally {
    if (existsSync(viaLink)) rmSync(viaLink, { recursive: true, force: true });
  }

  const appLink = layout('app-link');
  boxes.push(appLink.box);
  mkdirSync(join(appLink.box, 'tmp'));
  const appLinkRun = run([], baseEnv(appLink, { TESS_ARCH: 'arm64', TESS_FAKE_APP_LINK: '1' }));
  assert.notEqual(appLinkRun.status, 0);
  assert.match(appLinkRun.stderr, /did not contain Hermes/);
  assert.equal(existsSync(join(appLink.box, 'Applications', 'Hermes Agent.app')), false);

  const extraDir = join(root, 'support/mac/plugins/tess-visit/__pycache__');
  const extraFile = join(extraDir, 'x.pyc');
  mkdirSync(extraDir);
  writeFileSync(extraFile, 'not a profile file\n');
  try {
    const extra = layout('extra-file');
    boxes.push(extra.box);
    mkdirSync(join(extra.box, 'tmp'));
    const extraRun = run([], baseEnv(extra, { TESS_ARCH: 'arm64' }));
    assert.equal(extraRun.status, 0, extraRun.stderr);
    assert.equal(existsSync(join(extra.box, 'hermes', 'profiles', 'tess-support', 'plugins', 'tess-visit', '__pycache__')), false);
  } finally {
    rmSync(extraDir, { recursive: true, force: true });
  }

  const profilesOf = (box) => join(box, 'hermes', 'profiles');
  const profileOf = (box) => join(profilesOf(box), 'tess-support');

  // S1. Uninstall after an interrupted swap removes the leftover folders and the code.
  const s1 = layout('s1-uninstall');
  boxes.push(s1.box);
  mkdirSync(join(s1.box, 'tmp'));
  const s1Env = baseEnv(s1, { TESS_ARCH: 'arm64' });
  assert.equal(run([], s1Env).status, 0);
  mkdirSync(join(profileOf(s1.box), 'cache'), { recursive: true });
  writeFileSync(join(profileOf(s1.box), 'cache', 'keep.txt'), 'unsent\n');
  const s1Hit = run([], { ...s1Env, TESS_FAKE_MV_SIGNAL: '1' });
  assert.notEqual(s1Hit.status, 0);
  const s1Un = run(['--uninstall'], s1Env);
  assert.equal(s1Un.status, 0, s1Un.stderr);
  assert.match(s1Un.stdout, /revoke/);
  assert.equal(existsSync(profileOf(s1.box)), false);
  assert.equal(existsSync(join(profilesOf(s1.box), '.tess-support.previous')), false);
  assert.equal(existsSync(join(profilesOf(s1.box), '.tess-support.incoming')), false);
  assert.equal(filesContaining(profilesOf(s1.box), token).length, 0);
  assert.equal(existsSync(join(s1.box, 'home', 'Applications', 'Tess Support.app')), false);
  const s1Again = run([], s1Env);
  assert.equal(s1Again.status, 0, s1Again.stderr);
  assert.equal(existsSync(join(profileOf(s1.box), 'cache', 'keep.txt')), false);

  const s1Link = layout('s1-link');
  boxes.push(s1Link.box);
  mkdirSync(join(s1Link.box, 'tmp'));
  const s1LinkEnv = baseEnv(s1Link, { TESS_ARCH: 'arm64' });
  assert.equal(run([], s1LinkEnv).status, 0);
  const s1PrevTarget = join(s1Link.box, 'prev-target');
  const s1IncTarget = join(s1Link.box, 'inc-target');
  mkdirSync(s1PrevTarget);
  mkdirSync(s1IncTarget);
  writeFileSync(join(s1PrevTarget, 'precious'), 'keep-prev\n');
  writeFileSync(join(s1IncTarget, 'precious'), 'keep-inc\n');
  symlinkSync(s1PrevTarget, join(profilesOf(s1Link.box), '.tess-support.previous'));
  symlinkSync(s1IncTarget, join(profilesOf(s1Link.box), '.tess-support.incoming'));
  const s1LinkUn = run(['--uninstall'], s1LinkEnv);
  assert.equal(s1LinkUn.status, 0, s1LinkUn.stderr);
  assert.equal(existsSync(join(profilesOf(s1Link.box), '.tess-support.previous')), false);
  assert.equal(existsSync(join(profilesOf(s1Link.box), '.tess-support.incoming')), false);
  assert.equal(readFileSync(join(s1PrevTarget, 'precious'), 'utf8'), 'keep-prev\n');
  assert.equal(readFileSync(join(s1IncTarget, 'precious'), 'utf8'), 'keep-inc\n');

  // A stub is not a live profile. The previous folder is put back.
  const stub = layout('stub-previous');
  boxes.push(stub.box);
  mkdirSync(join(stub.box, 'tmp'));
  const stubEnv = baseEnv(stub, { TESS_ARCH: 'arm64' });
  assert.equal(run([], stubEnv).status, 0);
  const stubProfile = profileOf(stub.box);
  mkdirSync(join(stubProfile, 'cache'), { recursive: true });
  writeFileSync(join(stubProfile, 'cache', 'keep.txt'), 'unsent\n');
  const stubEnvText = readFileSync(join(stubProfile, '.env'), 'utf8');
  renameSync(stubProfile, join(profilesOf(stub.box), '.tess-support.previous'));
  mkdirSync(join(stubProfile, 'logs'), { recursive: true });
  writeFileSync(join(stubProfile, 'logs', 'agent.log'), 'hermes started\n');
  const stubAgain = run([], stubEnv);
  assert.equal(stubAgain.status, 0, stubAgain.stderr);
  assert.equal(readFileSync(join(stubProfile, 'cache', 'keep.txt'), 'utf8'), 'unsent\n');
  assert.equal(readFileSync(join(stubProfile, '.env'), 'utf8'), stubEnvText);
  assert.equal(existsSync(join(profilesOf(stub.box), '.tess-support.previous')), false);

  // S3. A bad disk image creates nothing, so the next good run still sets the profile name.
  const s3 = layout('s3-dmg');
  boxes.push(s3.box);
  mkdirSync(join(s3.box, 'tmp'));
  const s3Env = baseEnv(s3, { TESS_ARCH: 'arm64' });
  const s3Bad = run([], { ...s3Env, TESS_FAKE_BAD_DMG: '1' });
  assert.notEqual(s3Bad.status, 0);
  assert.match(s3Bad.stderr, /did not match Hermes's published checksum/);
  assert.equal(existsSync(join(s3.box, 'hermes')), false);
  const s3Good = run([], s3Env);
  assert.equal(s3Good.status, 0, s3Good.stderr);
  assert.equal(readFileSync(join(s3.box, 'hermes', 'active_profile'), 'utf8').trim(), 'tess-support');
  assert.equal(
    readFileSync(join(s3.box, 'home', 'Library', 'Application Support', 'Hermes', 'active-profile.json'), 'utf8').trim(),
    '{"profile":"tess-support"}',
  );

  // A rerun keeps Hermes's own files. It replaces the files distribution.yaml owns, .env, and Node.
  const kept = layout('kept-files');
  boxes.push(kept.box);
  mkdirSync(join(kept.box, 'tmp'));
  const keptEnv = baseEnv(kept, { TESS_ARCH: 'arm64' });
  assert.equal(run([], keptEnv).status, 0);
  const keptProfile = profileOf(kept.box);
  writeFileSync(join(keptProfile, 'state.db'), 'chats\n');
  mkdirSync(join(keptProfile, 'sessions'));
  writeFileSync(join(keptProfile, 'sessions', 's.json'), '{}\n');
  mkdirSync(join(keptProfile, 'memories'));
  writeFileSync(join(keptProfile, 'memories', 'MEMORY.md'), 'm\n');
  writeFileSync(join(keptProfile, 'auth.json'), '{}\n');
  mkdirSync(join(keptProfile, 'cache'));
  writeFileSync(join(keptProfile, 'cache', 'keep.txt'), 'unsent\n');
  const keptAgain = run([], keptEnv);
  assert.equal(keptAgain.status, 0, keptAgain.stderr);
  assert.equal(readFileSync(join(keptProfile, 'state.db'), 'utf8'), 'chats\n');
  assert.equal(readFileSync(join(keptProfile, 'sessions', 's.json'), 'utf8'), '{}\n');
  assert.equal(readFileSync(join(keptProfile, 'memories', 'MEMORY.md'), 'utf8'), 'm\n');
  assert.equal(readFileSync(join(keptProfile, 'auth.json'), 'utf8'), '{}\n');
  assert.equal(readFileSync(join(keptProfile, 'cache', 'keep.txt'), 'utf8'), 'unsent\n');
  assert.match(readFileSync(join(keptProfile, 'SOUL.md'), 'utf8'), /You are Tess Support/);

  const keptLink = layout('kept-link');
  boxes.push(keptLink.box);
  mkdirSync(join(keptLink.box, 'tmp'));
  const keptLinkEnv = baseEnv(keptLink, { TESS_ARCH: 'arm64' });
  assert.equal(run([], keptLinkEnv).status, 0);
  const keptOutside = join(keptLink.box, 'outside-notes');
  mkdirSync(keptOutside);
  writeFileSync(join(keptOutside, 'secret'), 'do-not-copy\n');
  symlinkSync(keptOutside, join(profileOf(keptLink.box), 'notes'));
  const keptLinkRun = run([], keptLinkEnv);
  assert.notEqual(keptLinkRun.status, 0);
  assert.match(keptLinkRun.stderr, /notes is a symlink/);
  assert.equal(readFileSync(join(keptOutside, 'secret'), 'utf8'), 'do-not-copy\n');
  assert.equal(existsSync(join(profileOf(keptLink.box), '.env')), true);
  assert.equal(existsSync(join(profilesOf(keptLink.box), '.tess-support.incoming')), false);

  // S5. The second rename fails. The previous profile comes back, and the new folder does not stay.
  const s5 = layout('s5-rename');
  boxes.push(s5.box);
  mkdirSync(join(s5.box, 'tmp'));
  const s5Env = baseEnv(s5, { TESS_ARCH: 'arm64' });
  assert.equal(run([], s5Env).status, 0);
  const s5Profile = profileOf(s5.box);
  mkdirSync(join(s5Profile, 'cache'), { recursive: true });
  writeFileSync(join(s5Profile, 'cache', 'keep.txt'), 'unsent\n');
  const s5EnvText = readFileSync(join(s5Profile, '.env'), 'utf8');
  const s5Hit = run([], { ...s5Env, TESS_FAKE_MV_INCOMING_EXIT: '1' });
  assert.notEqual(s5Hit.status, 0);
  assert.match(s5Hit.stderr, /previous one was put back/);
  assert.doesNotMatch(s5Hit.stderr, /\/dev\/tty/);
  assert.equal(readFileSync(join(s5Profile, 'cache', 'keep.txt'), 'utf8'), 'unsent\n');
  assert.equal(readFileSync(join(s5Profile, '.env'), 'utf8'), s5EnvText);
  assert.equal(existsSync(join(profilesOf(s5.box), '.tess-support.incoming')), false);
  assert.equal(existsSync(join(profilesOf(s5.box), '.tess-support.previous')), false);

  // S6. A leftover incoming is rebuilt from the pinned files. A tampered file is not kept.
  const s6 = layout('s6-incoming');
  boxes.push(s6.box);
  mkdirSync(join(s6.box, 'tmp'));
  const s6Env = baseEnv(s6, { TESS_ARCH: 'arm64' });
  assert.equal(run([], s6Env).status, 0);
  const s6Profile = profileOf(s6.box);
  const s6Incoming = join(profilesOf(s6.box), '.tess-support.incoming');
  renameSync(s6Profile, s6Incoming);
  writeFileSync(join(s6Incoming, 'SOUL.md'), 'tampered\n');
  const s6Again = run([], s6Env);
  assert.equal(s6Again.status, 0, s6Again.stderr);
  assert.notEqual(readFileSync(join(s6Profile, 'SOUL.md'), 'utf8'), 'tampered\n');
  assert.match(readFileSync(join(s6Profile, 'SOUL.md'), 'utf8'), /You are Tess Support/);
  assert.equal(existsSync(s6Incoming), false);

  // Hermes has to be quit when this home's Hermes is running, even with no profile name
  // on its command line. That used to be missed. An unrelated command that only
  // contains those words must not block the swap.
  const liveHome = layout('live-home-hermes');
  boxes.push(liveHome.box);
  mkdirSync(join(liveHome.box, 'tmp'));
  const liveHomeEnv = baseEnv(liveHome, { TESS_ARCH: 'arm64' });
  assert.equal(run([], liveHomeEnv).status, 0);
  writeFileSync(join(profileOf(liveHome.box), 'state.db'), 'open-chat\n');
  const homeHermes = join(liveHomeEnv.HERMES_HOME, 'hermes');
  writeFileSync(homeHermes, '#!/bin/sh\nsleep 40\n');
  chmodSync(homeHermes, 0o755);
  const homeChild = spawn(homeHermes, ['gateway'], { stdio: 'ignore' });
  try {
    const homeBlocked = run([], { ...liveHomeEnv, TESS_CHECK_LIVE_HERMES: '1' });
    assert.notEqual(homeBlocked.status, 0);
    assert.match(homeBlocked.stderr, /Hermes is open\. Quit Hermes, then run this again\./);
    assert.equal(readFileSync(join(profileOf(liveHome.box), 'state.db'), 'utf8'), 'open-chat\n');
  } finally {
    homeChild.kill('SIGKILL');
  }

  const liveApp = layout('live-hermes-app');
  boxes.push(liveApp.box);
  mkdirSync(join(liveApp.box, 'tmp'));
  const liveAppEnv = baseEnv(liveApp, { TESS_ARCH: 'arm64' });
  assert.equal(run([], liveAppEnv).status, 0);
  writeFileSync(join(profileOf(liveApp.box), 'state.db'), 'open-chat\n');
  const appExe = join(liveAppEnv.TESS_APPLICATIONS, 'Hermes Agent.app', 'Contents', 'MacOS', 'Hermes');
  writeFileSync(appExe, '#!/bin/sh\nsleep 40\n');
  chmodSync(appExe, 0o755);
  const appChild = spawn(appExe, [], { stdio: 'ignore' });
  try {
    const appBlocked = run([], { ...liveAppEnv, TESS_CHECK_LIVE_HERMES: '1' });
    assert.notEqual(appBlocked.status, 0);
    assert.match(appBlocked.stderr, /Quit Hermes/);
    assert.equal(readFileSync(join(profileOf(liveApp.box), 'state.db'), 'utf8'), 'open-chat\n');
  } finally {
    appChild.kill('SIGKILL');
  }

  const liveDecoy = layout('live-hermes-decoy');
  boxes.push(liveDecoy.box);
  mkdirSync(join(liveDecoy.box, 'tmp'));
  const liveDecoyEnv = baseEnv(liveDecoy, { TESS_ARCH: 'arm64' });
  assert.equal(run([], liveDecoyEnv).status, 0);
  writeFileSync(join(profileOf(liveDecoy.box), 'state.db'), 'open-chat\n');
  const decoyHermes = join(liveDecoy.bin, 'hermes');
  writeFileSync(decoyHermes, '#!/bin/sh\nsleep 40\n');
  chmodSync(decoyHermes, 0o755);
  const decoyChild = spawn(decoyHermes, ['-p', 'tess-support', '--profile=tess-support'], { stdio: 'ignore' });
  try {
    const decoyRun = run([], { ...liveDecoyEnv, TESS_CHECK_LIVE_HERMES: '1' });
    assert.equal(decoyRun.status, 0, decoyRun.stderr);
    assert.equal(readFileSync(join(profileOf(liveDecoy.box), 'state.db'), 'utf8'), 'open-chat\n');
  } finally {
    decoyChild.kill('SIGKILL');
  }

  // S9. A folder recreated between the two renames is not treated as the new profile.
  const s9 = layout('s9-recreate');
  boxes.push(s9.box);
  mkdirSync(join(s9.box, 'tmp'));
  const s9Env = baseEnv(s9, { TESS_ARCH: 'arm64' });
  assert.equal(run([], s9Env).status, 0);
  const s9Profile = profileOf(s9.box);
  mkdirSync(join(s9Profile, 'cache'), { recursive: true });
  writeFileSync(join(s9Profile, 'cache', 'keep.txt'), 'unsent\n');
  const s9Hit = run([], { ...s9Env, TESS_FAKE_MV_RECREATE: '1' });
  assert.notEqual(s9Hit.status, 0);
  assert.match(s9Hit.stderr, /appeared during the install/);
  assert.doesNotMatch(s9Hit.stderr, /\/dev\/tty/);
  assert.equal(existsSync(join(s9Profile, '.env')), true);
  assert.equal(readFileSync(join(s9Profile, 'cache', 'keep.txt'), 'utf8'), 'unsent\n');
  assert.equal(existsSync(join(s9Profile, '.tess-support.incoming')), false);
  assert.ok(readFileSync(join(s9Profile, '.env'), 'utf8').includes(token));

  // S8. Two installs at once. The second waits. The first finishes with the visit intact.
  const s8 = layout('s8-lock');
  boxes.push(s8.box);
  mkdirSync(join(s8.box, 'tmp'));
  const s8Env = baseEnv(s8, { TESS_ARCH: 'arm64' });
  assert.equal(run([], s8Env).status, 0);
  const s8Profile = profileOf(s8.box);
  mkdirSync(join(s8Profile, 'cache'), { recursive: true });
  writeFileSync(join(s8Profile, 'cache', 'keep.txt'), 'unsent\n');
  const s8Previous = join(profilesOf(s8.box), '.tess-support.previous');
  const s8Child = spawn('/bin/sh', [install], {
    env: { ...s8Env, TESS_FAKE_MV_SLEEP: '25' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let s8Err = '';
  s8Child.stderr.on('data', (chunk) => { s8Err += chunk; });
  const s8Done = new Promise((resolve) => s8Child.on('exit', (code) => resolve(code ?? 1)));
  try {
    const s8Deadline = Date.now() + 20000;
    while (Date.now() < s8Deadline && !existsSync(s8Previous)) {
      if (s8Child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(s8Previous), true, s8Err);
    const s8Other = run([], s8Env);
    assert.notEqual(s8Other.status, 0);
    assert.match(s8Other.stderr, /Another Tess Support install is already changing this profile/);
    const s8Code = await s8Done;
    assert.equal(s8Code, 0, s8Err);
    assert.equal(readFileSync(join(s8Profile, 'cache', 'keep.txt'), 'utf8'), 'unsent\n');
    assert.equal(existsSync(join(s8Profile, '.env')), true);
    assert.equal(existsSync(join(s8Profile, '.tess-support.incoming')), false);
    assert.equal(existsSync(s8Previous), false);
  } finally {
    if (s8Child.exitCode === null) s8Child.kill('SIGKILL');
  }

  const modeOf = (path) => statSync(path).mode & 0o777;
  const lstartOf = (pid) => execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  }).replace(/^\s+|\s+$/g, '');
  const plantLock = (box, pid, lstart) => {
    const lock = join(profilesOf(box), '.tess-support.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${pid}\n`);
    writeFileSync(join(lock, 'lstart'), `${lstart}\n`);
  };
  const holdSleep = () => spawn('/bin/sh', ['-c', 'sleep 120'], { stdio: 'ignore' });

  // A crash left a lock whose pid now belongs to a different process. The start time
  // does not match, so the next install takes the lock and keeps the chat file's mode.
  const reused = layout('lock-reused');
  boxes.push(reused.box);
  mkdirSync(join(reused.box, 'tmp'));
  const reusedEnv = baseEnv(reused, { TESS_ARCH: 'arm64' });
  assert.equal(run([], reusedEnv).status, 0);
  const reusedProfile = profileOf(reused.box);
  writeFileSync(join(reusedProfile, 'state.db'), 'chats\n');
  chmodSync(join(reusedProfile, 'state.db'), 0o644);
  mkdirSync(join(reusedProfile, 'sessions'));
  chmodSync(join(reusedProfile, 'sessions'), 0o755);
  writeFileSync(join(reusedProfile, 'sessions', 'note.txt'), 'hello\n');
  chmodSync(join(reusedProfile, 'sessions', 'note.txt'), 0o640);
  const reusedSleeper = holdSleep();
  try {
    plantLock(reused.box, reusedSleeper.pid, 'Wed Jan  1 00:00:00 1970');
    const reusedAgain = run([], reusedEnv);
    assert.equal(reusedAgain.status, 0, reusedAgain.stderr);
    assert.doesNotMatch(reusedAgain.stderr, /already changing/);
    assert.equal(readFileSync(join(reusedProfile, 'state.db'), 'utf8'), 'chats\n');
    assert.equal(modeOf(join(reusedProfile, 'state.db')), 0o644);
    assert.equal(modeOf(join(reusedProfile, 'sessions')), 0o755);
    assert.equal(modeOf(join(reusedProfile, 'sessions', 'note.txt')), 0o640);
    assert.equal(modeOf(reusedProfile), 0o700);
  } finally {
    reusedSleeper.kill('SIGKILL');
  }

  // The same pid and the same start time is a real install. Do not take that lock.
  const held = layout('lock-held');
  boxes.push(held.box);
  mkdirSync(join(held.box, 'tmp'));
  const heldEnv = baseEnv(held, { TESS_ARCH: 'arm64' });
  assert.equal(run([], heldEnv).status, 0);
  const heldProfile = profileOf(held.box);
  writeFileSync(join(heldProfile, 'state.db'), 'open\n');
  const heldSleeper = holdSleep();
  try {
    plantLock(held.box, heldSleeper.pid, lstartOf(heldSleeper.pid));
    const heldBlocked = run([], heldEnv);
    assert.notEqual(heldBlocked.status, 0);
    assert.match(heldBlocked.stderr, /Another Tess Support install is already changing this profile\. Wait until it finishes, then run this again\./);
    assert.equal(readFileSync(join(heldProfile, 'state.db'), 'utf8'), 'open\n');
  } finally {
    heldSleeper.kill('SIGKILL');
  }

  // Two retries see one stale lock. One takes it. The other is told to wait.
  const race = layout('lock-race');
  boxes.push(race.box);
  mkdirSync(join(race.box, 'tmp'));
  const raceEnv = baseEnv(race, { TESS_ARCH: 'arm64' });
  assert.equal(run([], raceEnv).status, 0);
  const raceProfile = profileOf(race.box);
  mkdirSync(join(raceProfile, 'cache'), { recursive: true });
  writeFileSync(join(raceProfile, 'cache', 'keep.txt'), 'unsent\n');
  const raceSleeper = holdSleep();
  const raceKids = [];
  try {
    plantLock(race.box, raceSleeper.pid, 'Wed Jan  1 00:00:00 1970');
    const startRace = () => {
      const child = spawn('/bin/sh', [install], {
        env: { ...raceEnv, TESS_FAKE_MV_SLEEP: '30' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (chunk) => { err += chunk; });
      const done = new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
      return { child, done, err: () => err };
    };
    const raceA = startRace();
    const raceB = startRace();
    raceKids.push(raceA.child, raceB.child);
    const raceTimer = setTimeout(() => {
      raceA.child.kill('SIGKILL');
      raceB.child.kill('SIGKILL');
    }, 120000);
    const raceCodes = await Promise.all([raceA.done, raceB.done]);
    clearTimeout(raceTimer);
    const raceWins = raceCodes.filter((code) => code === 0);
    assert.equal(raceWins.length, 1, `${raceA.err()}\n---\n${raceB.err()}`);
    const raceErr = `${raceA.err()}\n${raceB.err()}`;
    assert.match(raceErr, /Another Tess Support install is already changing this profile/);
    assert.equal(readFileSync(join(raceProfile, 'cache', 'keep.txt'), 'utf8'), 'unsent\n');
    assert.equal(existsSync(join(raceProfile, '.env')), true);
    assert.equal(existsSync(join(raceProfile, '.tess-support.incoming')), false);
  } finally {
    raceSleeper.kill('SIGKILL');
    for (const child of raceKids) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }

  // The staged folder is private while the swap is still going, and the installed
  // folder stays private. A carried file keeps the mode it had.
  const priv = layout('private-profile');
  boxes.push(priv.box);
  mkdirSync(join(priv.box, 'tmp'));
  const privEnv = baseEnv(priv, { TESS_ARCH: 'arm64' });
  assert.equal(run([], privEnv).status, 0);
  const privProfile = profileOf(priv.box);
  writeFileSync(join(privProfile, 'state.db'), 'chats\n');
  chmodSync(join(privProfile, 'state.db'), 0o644);
  const privChild = spawn('/bin/sh', [install], {
    env: { ...privEnv, TESS_FAKE_MV_SLEEP: '12' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let privErr = '';
  privChild.stderr.on('data', (chunk) => { privErr += chunk; });
  const privDone = new Promise((resolve) => privChild.on('exit', (code) => resolve(code ?? 1)));
  try {
    const privIncoming = join(profilesOf(priv.box), '.tess-support.incoming');
    const privDeadline = Date.now() + 30000;
    while (Date.now() < privDeadline && !existsSync(privIncoming)) {
      if (privChild.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(privIncoming), true, privErr);
    assert.equal(modeOf(privIncoming), 0o700);
    const privCode = await privDone;
    assert.equal(privCode, 0, privErr);
    assert.equal(modeOf(privProfile), 0o700);
    assert.equal(modeOf(join(privProfile, 'state.db')), 0o644);
    assert.equal(readFileSync(join(privProfile, 'state.db'), 'utf8'), 'chats\n');
  } finally {
    if (privChild.exitCode === null) privChild.kill('SIGKILL');
  }

  // Uninstall takes the install lock first. A live install keeps the profile and the icon.
  const unHeld = layout('uninstall-held');
  boxes.push(unHeld.box);
  mkdirSync(join(unHeld.box, 'tmp'));
  const unHeldEnv = baseEnv(unHeld, { TESS_ARCH: 'arm64' });
  assert.equal(run([], unHeldEnv).status, 0);
  const unHeldProfile = profileOf(unHeld.box);
  const unHeldApp = join(unHeldEnv.HOME, 'Applications', 'Tess Support.app');
  writeFileSync(join(unHeldProfile, 'state.db'), 'open\n');
  const unSleeper = holdSleep();
  try {
    plantLock(unHeld.box, unSleeper.pid, lstartOf(unSleeper.pid));
    const unBlocked = run(['--uninstall'], unHeldEnv);
    assert.notEqual(unBlocked.status, 0);
    assert.match(unBlocked.stderr, /Another Tess Support install is already changing this profile\. Wait until it finishes, then run this again\./);
    assert.equal(readFileSync(join(unHeldProfile, 'state.db'), 'utf8'), 'open\n');
    assert.equal(existsSync(join(unHeldProfile, '.env')), true);
    assert.equal(existsSync(unHeldApp), true);
  } finally {
    unSleeper.kill('SIGKILL');
  }

  // A reused pid does not block uninstall.
  const unStale = layout('uninstall-stale');
  boxes.push(unStale.box);
  mkdirSync(join(unStale.box, 'tmp'));
  const unStaleEnv = baseEnv(unStale, { TESS_ARCH: 'arm64' });
  assert.equal(run([], unStaleEnv).status, 0);
  const unStaleSleeper = holdSleep();
  try {
    plantLock(unStale.box, unStaleSleeper.pid, 'Wed Jan  1 00:00:00 1970');
    const unGone = run(['--uninstall'], unStaleEnv);
    assert.equal(unGone.status, 0, unGone.stderr);
    assert.match(unGone.stdout, /Ask Krish to revoke your code/);
    assert.equal(existsSync(profileOf(unStale.box)), false);
  } finally {
    unStaleSleeper.kill('SIGKILL');
  }

  const pinned = readFileSync(install, 'utf8');
  // CI checks out one commit; the pinned commit is older, so fetch just that one before re-pinning from it.
  try {
    execFileSync('git', ['cat-file', '-e', `${profileCommit}^{commit}`], { cwd: root, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', profileCommit], { cwd: root, stdio: 'ignore' });
  }
  execFileSync(process.execPath, [join(root, 'tools/pin-support-mac.mjs'), profileCommit], { cwd: root });
  assert.equal(readFileSync(install, 'utf8'), pinned, 'pin-support-mac.mjs is idempotent');
  assert.match(readFileSync(join(root, 'support/mac/distribution.yaml'), 'utf8'), /hermes_requires:\s*">=0\.22\.0"/);
} finally {
  nodeChild.kill();
  rmSync(join(fakeNode, '..'), { recursive: true, force: true });
  for (const box of boxes) rmSync(box, { recursive: true, force: true });
}

console.log('support mac install: all checks passed');
