// A real TESS_TEST install into a fake Spotify, from a local dist: the installer must check the signed list with the
// verifier the install line passed *before* it unpacks the patcher. Run: node tools/test-install.mjs
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const pexec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const box = mkdtempSync(join(tmpdir(), 'tess-install-test-'));
const home = join(box, 'home');
const www = join(box, 'www');
const dist = join(www, 'stable', 'dist');
mkdirSync(dist, { recursive: true });
mkdirSync(join(home, 'Library/Application Support/Spotify'), { recursive: true });
writeFileSync(join(home, 'Library/Application Support/Spotify/prefs'), '');

// a Spotify-shaped folder with the interface file the installer looks for
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.3.9</string><key>CFBundleIdentifier</key><string>com.spotify.client</string></dict></plist>
`;
const makeSpotify = (dir) => {
  mkdirSync(join(dir, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(dir, 'Contents/Resources/Apps'), { recursive: true });
  writeFileSync(join(dir, 'Contents/MacOS/Spotify'), '');
  writeFileSync(join(dir, 'Contents/Resources/Apps/xpui.spa'), '');
  writeFileSync(join(dir, 'Contents/Info.plist'), infoPlist);
};
const spotify = join(box, 'Spotify.app');
makeSpotify(spotify);

// a patcher that records the Spotify path and writes the wrapper marker, so the install finishes in TESS_TEST
const pdir = join(box, 'patcher');
mkdirSync(pdir, { recursive: true });
writeFileSync(join(pdir, 'tess-patcher'), `#!/bin/sh
case "$1" in
  config) [ "$2" = spotify_path ] && echo "$3" > "$TESS_FAKE_CONF" ;;
  backup) a="$(cat "$TESS_FAKE_CONF")/Apps"; mkdir -p "$a/xpui"; echo '<html>spicetifyWrapper</html>' > "$a/xpui/index.html" ;;
esac
exit 0
`);
writeFileSync(join(pdir, 'tess-verify'), '#!/bin/sh\nexit 0\n');
chmodSync(join(pdir, 'tess-patcher'), 0o755);
chmodSync(join(pdir, 'tess-verify'), 0o755);
const themeDir = join(box, 'theme', 'Tess');
mkdirSync(themeDir, { recursive: true });
writeFileSync(join(themeDir, 'theme.js'), '// theme\n');
writeFileSync(join(themeDir, 'user.css'), '/* css */\n');
writeFileSync(join(box, 'updater.sh'), '#!/bin/zsh\nexit 0\n');
writeFileSync(join(box, 'doctor.sh'), '#!/bin/zsh\nexit 0\n');

const server = createServer((req, res) => {
  const file = join(www, req.url.split('?')[0]);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200); createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const base = `${origin}/stable/dist`;
const mk = async (args) => pexec('tar', args);
await mk(['-czf', join(dist, 'patcher.tgz'), '-C', pdir, '.']);
await mk(['-czf', join(dist, 'theme.tgz'), '-C', join(box, 'theme'), 'Tess']);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const parts = ['patcher.tgz', 'theme.tgz', 'updater.sh', 'doctor.sh'];
for (const p of parts) {
  const from = p.endsWith('.sh') ? join(box, p) : join(dist, p);
  if (p.endsWith('.sh')) writeFileSync(join(dist, p), readFileSync(from));
}
const partLines = [
  `patcher ${sha(join(dist, 'patcher.tgz'))} ${base}/patcher.tgz src-p`,
  `theme ${sha(join(dist, 'theme.tgz'))} ${base}/theme.tgz src-t`,
  `updater ${sha(join(dist, 'updater.sh'))} ${base}/updater.sh src-u`,
  `doctor ${sha(join(dist, 'doctor.sh'))} ${base}/doctor.sh src-d`,
];
const writeComponents = (extra = ['version 0.2.99', 'rev 99']) => {
  writeFileSync(join(dist, 'components.txt'), [...partLines, ...extra].join('\n') + '\n');
};
writeComponents();
writeFileSync(join(dist, 'components.sig'), 'test\n');

const verifier = join(box, 'verify');
const verifierLog = join(box, 'verify.log');
writeFileSync(verifier, `#!/bin/sh\necho "$1" >> "$VERIFY_LOG"\nexit 0\n`);
chmodSync(verifier, 0o755);
const env = {
  ...process.env,
  HOME: home,
  TESS_TEST: '1',
  TESS_HOME: join(box, 'tess'),
  TESS_CONFIG: join(box, 'config'),
  TESS_SPOTIFY: spotify,
  TESS_DIST_BASE: origin,
  TESS_CHANNEL: 'stable',
  TESS_VERIFY: verifier,
  TESS_FAKE_CONF: join(box, 'apps.conf'),
  VERIFY_LOG: verifierLog,
};
const install = async (overrides = {}) => {
  try {
    const { stdout } = await pexec('sh', [join(root, 'installer/tess-install.sh')], { encoding: 'utf8', env: { ...env, ...overrides } });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
};
const installed = () => installedAt(spotify);
const installedAt = (dir) => existsSync(join(dir, 'Contents/Resources/Apps/xpui/index.html'));

try {
  // 1. the verifier is called with the signed list, and the install completes
  const r = await install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(verifierLog, 'utf8'), /components\.txt/, 'the verifier checked the signed list');
  assert.ok(installed(), 'the fake patcher applied the wrapper');
  assert.equal(readFileSync(join(box, 'tess/state/version'), 'utf8').trim(), '0.2.99', 'installed version recorded');
  assert.equal(readFileSync(join(box, 'tess/state/rev-stable'), 'utf8').trim(), '99', 'rev recorded per channel');

  // 1b. a lower rev is refused before anything is downloaded or touched
  writeComponents(['version 0.2.98', 'rev 98']);
  const lower = await install();
  assert.notEqual(lower.status, 0, 'a lower rev fails the install');
  assert.match(lower.stdout, /older than the version already installed/, 'the failure names the downgrade');
  assert.equal(readFileSync(join(box, 'tess/state/rev-stable'), 'utf8').trim(), '99', 'the floor is not lowered');

  // 1c. a pre-rev list is refused once a rev is installed
  writeComponents(['version 0.2.98']);
  const noRev = await install();
  assert.notEqual(noRev.status, 0, 'a pre-rev list fails after a rev is installed');
  assert.match(noRev.stdout, /has no rev/, 'the failure names the missing rev');

  // 1d. ...but a pre-rev list still installs on a fresh Mac, which is what stable serves today
  rmSync(join(box, 'tess'), { recursive: true, force: true });
  rmSync(join(spotify, 'Contents/Resources/Apps/xpui'), { recursive: true, force: true });
  writeComponents(['version 0.2.98']);
  const fresh = await install();
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.equal(readFileSync(join(box, 'tess/state/version'), 'utf8').trim(), '0.2.98', 'fresh pre-rev install recorded');
  assert.equal(existsSync(join(box, 'tess/state/rev-stable')), false, 'no rev file for a pre-rev list');

  // 2. a failing verifier stops before the patcher is unpacked or Spotify is touched
  rmSync(join(spotify, 'Contents/Resources/Apps/xpui'), { recursive: true, force: true });
  rmSync(join(box, 'tess'), { recursive: true, force: true });
  rmSync(join(box, 'verify.log'), { force: true });
  writeFileSync(verifier, `#!/bin/sh\nexit 1\n`);
  const bad = await install();
  assert.notEqual(bad.status, 0, 'a bad signature fails the install');
  assert.equal(installed(), false, 'Spotify was not touched');
  assert.equal(existsSync(join(box, 'tess/bin/patcher')), false, 'the patcher archive was not unpacked');
  assert.match(bad.stdout, /signature check/, 'the failure names the signature check');

  // 3. a Spotify folder whose name has a quote and an & is stored exactly, and reads back from a shell unchanged
  writeFileSync(verifier, `#!/bin/sh\necho "$1" >> "$VERIFY_LOG"\nexit 0\n`);
  const odd = join(box, "Sam's & Spotify.app");
  makeSpotify(odd);
  const oddTess = join(box, 'tess-odd');
  const oddRun = await install({ TESS_SPOTIFY: odd, TESS_HOME: oddTess });
  assert.equal(oddRun.status, 0, oddRun.stdout + oddRun.stderr);
  const settings = readFileSync(join(oddTess, 'updater.env'), 'utf8');
  assert.match(settings, /^SPOTIFY='/m, 'the settings file quotes the path');
  const readBack = async (what) => (await pexec('/bin/sh', ['-c', `. "$1"; printf '%s' "$${what}"`, '_', join(oddTess, 'updater.env')], { encoding: 'utf8' })).stdout;
  assert.equal(await readBack('SPOTIFY'), odd, 'a shell reads back the exact folder name');
  assert.equal(await readBack('TESS_CONFIG'), join(box, 'config'), 'the other settings survive the same quoting');

  // 3b. a folder name with a line break in it cannot be stored, so the install stops before touching anything
  const broken = join(box, 'line\nbreak.app');
  makeSpotify(broken);
  const brokenRun = await install({ TESS_SPOTIFY: broken, TESS_HOME: join(box, 'tess-broken') });
  assert.notEqual(brokenRun.status, 0, 'a line break in the path is refused');
  assert.match(brokenRun.stdout, /line break/, 'the refusal says why');
  assert.equal(existsSync(join(broken, 'Contents/Resources/Apps/xpui')), false, 'Spotify was not touched');
  assert.equal(existsSync(join(box, 'tess-broken', 'updater.env')), false, 'nothing was saved');

  // 4. ownership is only taken on a Spotify that Apple itself vouches for (SEC-09)
  const bin = join(box, 'bin');
  mkdirSync(bin, { recursive: true });
  const chownLog = join(box, 'chown.log');
  writeFileSync(join(bin, 'codesign'), `#!/bin/sh
case "$1" in
  --verify) [ "$FAKE_CODESIGN_BAD" = 1 ] && exit 1; exit 0 ;;
  -dvvv) echo "Authority=Developer ID Application: Spotify AB (5N7G3VZ6Q4)"; exit 0 ;;
esac
exit 0
`);
  writeFileSync(join(bin, 'spctl'), `#!/bin/sh
exit 0
`);
  // a real chown to this account makes the folder writable again, which is the whole point of taking ownership
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh
echo "$@" >> "${chownLog}"
[ "$1" = chown ] && chmod -R u+w "${'$'}{@: -1}" 2>/dev/null
exit 0
`);
  for (const f of ['codesign', 'spctl', 'sudo']) chmodSync(join(bin, f), 0o755);
  const me = (await pexec('id', ['-un'], { encoding: 'utf8' })).stdout.trim();
  const locked = join(box, 'locked.app');
  makeSpotify(locked);
  chmodSync(join(locked, 'Contents/Resources'), 0o555);
  const refused = await install({ TESS_SPOTIFY: locked, TESS_HOME: join(box, 'tess-locked'), PATH: `${bin}:${process.env.PATH}`, FAKE_CODESIGN_BAD: '1' });
  assert.notEqual(refused.status, 0, 'an unverified bundle is refused');
  assert.match(refused.stdout, /isn't Spotify's own signed app/, 'the refusal says what is wrong');
  assert.equal(existsSync(chownLog), false, 'no password was asked for');
  assert.equal(statSync(join(locked, 'Contents/Resources')).mode & 0o777, 0o555, 'ownership was not changed');
  assert.equal(installedAt(locked), false, 'Spotify was not touched');

  const okOwn = await install({ TESS_SPOTIFY: locked, TESS_HOME: join(box, 'tess-locked'), PATH: `${bin}:${process.env.PATH}` });
  assert.equal(okOwn.status, 0, okOwn.stdout + okOwn.stderr);
  // the path is canonicalised first, so a link or a ".." chain cannot point the chown somewhere else
  assert.ok(readFileSync(chownLog, 'utf8').includes(`chown -R ${me} ${realpathSync(locked)}`), 'a verified Spotify is chowned to this account');
  assert.equal(installedAt(locked), true, 'and the install finishes');

  // 5. the doctor adopts a moved Spotify with the same quoted writer, keeping the other settings (SEC-08)
  const doctorSrc = readFileSync(join(root, 'installer/doctor.sh'), 'utf8');
  const envFn = doctorSrc.match(/^env_line\(\) \{[\s\S]*?^\}$/m)[0];
  const setFn = doctorSrc.match(/^set_env\(\) \{[\s\S]*?^\}$/m)[0];
  const settingsFile = join(box, 'adopt', 'updater.env');
  mkdirSync(join(box, 'adopt'), { recursive: true });
  writeFileSync(settingsFile, "SPOTIFY='/Applications/Spotify.app'\nTESS_PARTS_CHANNEL='beta'\nTESS_CONFIG='/Users/sam/.config/tess-patcher'\n");
  const adoptScript = join(box, 'adopt.zsh');
  writeFileSync(adoptScript, `${envFn}\n${setFn}\nset_env "$1" SPOTIFY "$2"\n`);
  const moved = "/Users/sam/Applications/Sam's & Spotify.app";
  execFileSync('/bin/zsh', [adoptScript, settingsFile, moved]);
  const adopted = readFileSync(settingsFile, 'utf8');
  assert.equal(adopted.split('\n').filter((l) => l.startsWith('SPOTIFY=')).length, 1, 'the old line is replaced, not added to');
  assert.match(adopted, /^TESS_PARTS_CHANNEL='beta'$/m, 'the channel line is kept');
  const reader = join(box, 'read.sh');
  writeFileSync(reader, `. "$1"\ncase "$2" in SPOTIFY) printf '%s' "$SPOTIFY" ;; TESS_PARTS_CHANNEL) printf '%s' "$TESS_PARTS_CHANNEL" ;; esac\n`);
  const readBack2 = async (what) => (await pexec('/bin/sh', [reader, settingsFile, what], { encoding: 'utf8' })).stdout;
  assert.equal(await readBack2('SPOTIFY'), moved, 'the doctor stores a folder name with a quote and an & exactly');
  assert.equal(await readBack2('TESS_PARTS_CHANNEL'), 'beta', 'and does not disturb the rest of the file');

  console.log('install tests passed (signed list first; lower and pre-rev refusal; fresh pre-rev; bad verifier stops before the patcher; quoted path; line break refused; verified ownership only; doctor adoption)');
} finally {
  await new Promise((r) => server.close(r));
  rmSync(box, { recursive: true, force: true });
}
