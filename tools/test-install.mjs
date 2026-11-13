// A real TESS_TEST install into a fake Spotify, from a local dist: the installer must check the signed list with the
// verifier the stub passed *before* it unpacks the patcher. Run: node tools/test-install.mjs
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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
const spotify = join(box, 'Spotify.app');
mkdirSync(join(spotify, 'Contents/MacOS'), { recursive: true });
mkdirSync(join(spotify, 'Contents/Resources/Apps'), { recursive: true });
writeFileSync(join(spotify, 'Contents/MacOS/Spotify'), '');
writeFileSync(join(spotify, 'Contents/Resources/Apps/xpui.spa'), '');
writeFileSync(join(spotify, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.3.9</string></dict></plist>
`);

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
const components = [
  `patcher ${sha(join(dist, 'patcher.tgz'))} ${base}/patcher.tgz src-p`,
  `theme ${sha(join(dist, 'theme.tgz'))} ${base}/theme.tgz src-t`,
  `updater ${sha(join(dist, 'updater.sh'))} ${base}/updater.sh src-u`,
  `doctor ${sha(join(dist, 'doctor.sh'))} ${base}/doctor.sh src-d`,
  'version 0.2.99',
  'rev 99',
].join('\n') + '\n';
writeFileSync(join(dist, 'components.txt'), components);
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
const install = async () => {
  try {
    const { stdout } = await pexec('sh', [join(root, 'installer/tess-install.sh')], { encoding: 'utf8', env });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
};
const installed = () => existsSync(join(spotify, 'Contents/Resources/Apps/xpui/index.html'));

try {
  // 1. the verifier is called with the signed list, and the install completes
  const r = await install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(verifierLog, 'utf8'), /components\.txt/, 'the verifier checked the signed list');
  assert.ok(installed(), 'the fake patcher applied the wrapper');
  assert.equal(readFileSync(join(box, 'tess/state/version'), 'utf8').trim(), '0.2.99', 'installed version recorded');
  assert.equal(readFileSync(join(box, 'tess/state/rev-stable'), 'utf8').trim(), '99', 'rev recorded per channel');

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

  console.log('install tests passed (signed list checked first; failing verifier stops before the patcher)');
} finally {
  await new Promise((r) => server.close(r));
  rmSync(box, { recursive: true, force: true });
}
