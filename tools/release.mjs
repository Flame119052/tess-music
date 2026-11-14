// Build, sign and publish a Tess release.
// Usage: node tools/release.mjs 0.1.0 [stable|beta]
//
// 1. builds theme/Tess (user.css + theme.js)
// 2. signs both with the Ed25519 key in ~/.config/tess-signing/private.pem (never in the repo)
// 3. writes dist/manifest.json, the installable loader theme, and Tess Mini (universal)
// 4. writes the signed bundle to this repo's `stable` / `beta` branch (via a worktree in .build/channel), pushes it,
//    builds the patcher from patcher/, and creates the GitHub Release vX.Y.Z on Flame119052/tess-music.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign, createPublicKey, createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

let [version, channel = 'stable'] = process.argv.slice(2);
if (version === 'auto') {
  // next patch after the newest vX.Y.Z tag on GitHub (CI runs this on every push)
  const tags = execFileSync('git', ['ls-remote', '--tags', 'origin'], { encoding: 'utf8' }).match(/refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/gm) || [];
  const [a, b, c] = tags.map((t) => t.match(/(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number))
    .sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0] || [0, 2, 0];
  version = `${a}.${b}.${c + 1}`;
}
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('usage: node tools/release.mjs X.Y.Z [stable|beta|dev]'); process.exit(1); }
if (!['stable', 'beta', 'dev'].includes(channel)) { console.error('channel must be stable, beta or dev'); process.exit(1); }
const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}.build/channel/`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// the safety gate: nothing is built or published unless it passes
run('sh', [`${root}tools/check-safety.sh`]);
run('node', [`${root}tools/build.mjs`]);
const js = readFileSync(`${root}theme/Tess/theme.js`, 'utf8').replace("window.__tessVersion", "window.__tessVersion");
const css = readFileSync(`${root}theme/Tess/user.css`, 'utf8');
const key = createPrivateKey(process.env.TESS_SIGNING_KEY || readFileSync(`${homedir()}/.config/tess-signing/private.pem`));
const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const sig = (text) => sign(null, Buffer.from(text), key).toString('base64');
const stamped = `window.__tessVersion = window.__tessVersion === 'baseline' || !window.__tessVersion ? '${version}' : window.__tessVersion;\n${js}`;

// Everything Tess runs on a Mac is signed with one stable identity, "Tess Music" (self-signed). macOS ties a user's
// approvals (App Management for the patcher, background items for Tess Mini) to it, so they survive every update.
// Its .p12 comes from TESS_CODESIGN_P12 (base64) + TESS_CODESIGN_PASS in CI, or ~/.config/tess-signing/codesign.p12
// + codesign.pass locally. A release without it is refused: an ad-hoc signature would make every Mac ask again.
const keychain = `${root}.build/tess-sign.keychain-db`;
{
  const p12 = process.env.TESS_CODESIGN_P12 ? Buffer.from(process.env.TESS_CODESIGN_P12, 'base64') : readFileSync(`${homedir()}/.config/tess-signing/codesign.p12`);
  const pass = process.env.TESS_CODESIGN_PASS ?? readFileSync(`${homedir()}/.config/tess-signing/codesign.pass`, 'utf8').trim();
  mkdirSync(`${root}.build`, { recursive: true });
  writeFileSync(`${root}.build/codesign.p12`, p12, { mode: 0o600 });
  try { execFileSync('security', ['delete-keychain', keychain], { stdio: 'ignore' }); } catch {}
  run('security', ['create-keychain', '-p', 'tess', keychain]);
  run('security', ['unlock-keychain', '-p', 'tess', keychain]);
  run('security', ['import', `${root}.build/codesign.p12`, '-k', keychain, '-P', pass, '-T', '/usr/bin/codesign']);
  execFileSync('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', 'tess', keychain], { stdio: 'ignore' });
  rmSync(`${root}.build/codesign.p12`);
  // codesign looks identities up through the search list
  const list = execFileSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' }).split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  if (!list.includes(keychain)) run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...list]);
  // On the CI machine only, trust the certificate for code signing (older macOS won't sign with an untrusted one).
  // Users' Macs never need to trust it: macOS ties approvals to the signature's identity, not to trust.
  if (process.env.CI) {
    const cert = `${root}.build/codesign.crt`;
    writeFileSync(cert, execFileSync('security', ['find-certificate', '-c', 'Tess Music', '-p', keychain]));
    run('sudo', ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-p', 'codeSign', '-k', '/Library/Keychains/System.keychain', cert]);
  }
  run('security', ['find-identity', '-p', 'codesigning', keychain]);
}
const codesign = (path, id) => run('codesign', ['--force', '--keychain', keychain, '-s', 'Tess Music', ...(id ? ['-i', id] : []), path]);

rmSync(out, { recursive: true, force: true });
try { execFileSync('git', ['-C', root, 'worktree', 'prune']); } catch {}
try { run('git', ['-C', root, 'fetch', '-q', 'origin', `${channel}:${channel}`]); } catch {}
try { run('git', ['-C', root, 'worktree', 'add', '-q', out, channel]); }
catch { run('git', ['-C', root, 'worktree', 'add', '-q', '--orphan', '-b', channel, out]); }

// signed bundle the loader fetches
mkdirSync(`${out}dist`, { recursive: true });
// The release number only goes up across every channel, so recreating a branch or losing a manifest cannot reset it
// below a rev a Mac already runs.
const prevManifest = (() => { try { return JSON.parse(readFileSync(`${out}dist/manifest.json`, 'utf8')); } catch { return {}; } })();
const revOf = (ref) => { try { return Number(JSON.parse(execFileSync('git', ['-C', root, 'show', `${ref}:dist/manifest.json`], { encoding: 'utf8' })).rev) || 0; } catch { return 0; } };
const rev = Math.max(Number(prevManifest.rev) || 0, revOf('origin/dev'), revOf('origin/beta'), revOf('origin/stable')) + 1;
const sha = (s) => createHash('sha256').update(s).digest('hex');
// The envelope binds the file contents too: a mirror cannot pair a fresh rev with older, correctly signed files.
const envelope = { version, js: 'theme.js', css: 'user.css', jsSha: sha(stamped), cssSha: sha(css), rev };
writeFileSync(`${out}dist/theme.js`, stamped);
writeFileSync(`${out}dist/user.css`, css);
writeFileSync(`${out}dist/manifest.json`, JSON.stringify({ ...envelope, channel, sig: { js: sig(stamped), css: sig(css), envelope: sig(JSON.stringify(envelope)) } }, null, 2));

// the theme the installer writes into Spotify: loader + this release as the offline baseline
const loader = readFileSync(`${root}theme/loader/loader.js`, 'utf8').replace('__TESS_PUBLIC_KEY__', pub);
const build = `${root}.build/out/`;
rmSync(build, { recursive: true, force: true });
mkdirSync(`${build}Tess`, { recursive: true });
writeFileSync(`${build}Tess/theme.js`, `${loader}\nfunction TESS_BASELINE() {\n${stamped}\n}\n`);
writeFileSync(`${build}Tess/user.css`, css);
cpSync(`${root}theme/Tess/color.ini`, `${build}Tess/color.ini`);
run('tar', ['-C', build, '-czf', `${build}tess-theme.tar.gz`, 'Tess']);

// Tess Mini, universal
const mini = `${build}Tess Mini.app/Contents/`;
mkdirSync(`${mini}MacOS`, { recursive: true });
for (const arch of ['arm64', 'x86_64']) {
  run('swiftc', ['-O', '-parse-as-library', '-target', `${arch}-apple-macos13.0`, `${root}mini/TessMini.swift`, '-o', `${build}TessMini-${arch}`]);
}
run('lipo', ['-create', `${build}TessMini-arm64`, `${build}TessMini-x86_64`, '-output', `${mini}MacOS/TessMini`]);
writeFileSync(`${mini}Info.plist`, readFileSync(`${root}mini/Info.plist`, 'utf8').replace('__VERSION__', version));
codesign(`${build}Tess Mini.app`);
run('ditto', ['-c', '-k', '--keepParent', `${build}Tess Mini.app`, `${build}tess-mini.zip`]);

// the installer travels with the release, so the public install line only ever runs a promoted installer. The
// forwarder checks the verifier's pin (in installer/install.sh) and the installer's signature before running it.
const installText = readFileSync(`${root}installer/tess-install.sh`, 'utf8');
const uninstallText = readFileSync(`${root}installer/uninstall.sh`, 'utf8');
writeFileSync(`${out}dist/install.sh`, installText);
writeFileSync(`${out}dist/uninstall.sh`, uninstallText);
writeFileSync(`${out}dist/install.sig`, sig(installText) + '\n');
writeFileSync(`${out}README.md`, `Release channel \`${channel}\` of Tess Music. Source and install: https://github.com/Flame119052/tess-music\n`);
// the patcher, built from patcher/ (fork of Spicetify CLI) plus Spicetify's compiled helper scripts
const pdir = `${build}patcher/`;
mkdirSync(`${pdir}pkg`, { recursive: true });
for (const a of ['arm64', 'amd64']) run('go', ['build', '-ldflags', '-s -w -X main.version=2.46.4', '-o', `${pdir}tp-${a}`, '.'], { cwd: `${root}patcher`, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: a } });
run('lipo', ['-create', `${pdir}tp-arm64`, `${pdir}tp-amd64`, '-output', `${pdir}pkg/tess-patcher`]);
codesign(`${pdir}pkg/tess-patcher`, 'music.tess.patcher');
for (const a of ['arm64', 'amd64']) run('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags', '-s -w', '-o', `${pdir}tv-${a}`, './tessverify'], { cwd: `${root}patcher`, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: a } });
run('lipo', ['-create', `${pdir}tv-arm64`, `${pdir}tv-amd64`, '-output', `${pdir}pkg/tess-verify`]);
codesign(`${pdir}pkg/tess-verify`, 'music.tess.verify');
// The install line runs the verifier committed at installer/tess-verify, pinned by SHA-256 in installer/install.sh;
// the copy in the patcher archive above is the one the updater installs and is signed with the Tess identity.
// the rescue line: the same checker built with the rescue key (kept offline, never in CI), plus rescue.sh.
// Macs copy these once into Tess/rescue and updates never replace them (see installer/rescue.sh).
const RESCUE_PUBLIC_KEY = 'cC+AMjfi/tOWQ7pvldMC+m5O0n+2TLQ2rW2PhoAsbhk=';
mkdirSync(`${pdir}pkg/rescue`, { recursive: true });
for (const a of ['arm64', 'amd64']) run('go', ['build', '-ldflags', `-s -w -X main.publicKey=${RESCUE_PUBLIC_KEY}`, '-o', `${pdir}trv-${a}`, './tessverify'], { cwd: `${root}patcher`, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: a } });
run('lipo', ['-create', `${pdir}trv-arm64`, `${pdir}trv-amd64`, '-output', `${pdir}pkg/rescue/tess-rescue-verify`]);
codesign(`${pdir}pkg/rescue/tess-rescue-verify`, 'music.tess.rescue-verify');
cpSync(`${root}installer/rescue.sh`, `${pdir}pkg/rescue/rescue.sh`);
// Spicetify's prebuilt helper files are vendored (patcher/prebuilt/spicetify-2.46.4) and copied here: the release no
// longer downloads anything from Spicetify, so a compromised upstream release cannot ride Tess's signature.
cpSync(`${root}patcher/prebuilt/spicetify-2.46.4/jsHelper`, `${pdir}pkg/jsHelper`, { recursive: true });
cpSync(`${root}patcher/prebuilt/spicetify-2.46.4/css-map.json`, `${pdir}pkg/css-map.json`);
cpSync(`${root}patcher/LICENSE`, `${pdir}pkg/LICENSE`);
cpSync(`${root}patcher/NOTICE.md`, `${pdir}pkg/NOTICE.md`);
for (const d of ['Themes', 'Extensions', 'CustomApps']) mkdirSync(`${pdir}pkg/${d}`, { recursive: true });
run('tar', ['-C', `${pdir}pkg`, '-czf', `${build}tess-patcher-macos-universal.tar.gz`, '.']);
// The signed list of Tess's other parts, which the updater on each Mac installs. A part whose source did not change
// keeps pointing at the release that first shipped it, so Macs only download (and restart) what actually changed.
cpSync(`${root}installer/updater.sh`, `${build}tess-updater.sh`);
cpSync(`${root}installer/doctor.sh`, `${build}tess-doctor.sh`);
cpSync(`${root}installer/tess-install.sh`, `${build}tess-installer.sh`);
cpSync(`${root}installer/uninstall.sh`, `${build}tess-uninstall.sh`);
cpSync(`${root}installer/tess-command.sh`, `${build}tess-command.sh`);
cpSync(`${root}installer/wake.sh`, `${build}tess-wake.sh`);
const hashFiles = (files) => { const h = createHash('sha256'); for (const f of files) h.update(readFileSync(f)); return h.digest('hex'); };
const gitTree = (p) => execFileSync('git', ['-C', root, 'rev-parse', `HEAD:${p}`], { encoding: 'utf8' }).trim();
const parts = {
  updater: { file: `${build}tess-updater.sh`, src: hashFiles([`${root}installer/updater.sh`]) },
  patcher: { file: `${build}tess-patcher-macos-universal.tar.gz`, src: hashFiles([`${root}installer/rescue.sh`]).slice(0, 20) + gitTree('patcher').slice(0, 20) },
  command: { file: `${build}tess-command.sh`, src: hashFiles([`${root}installer/tess-command.sh`]) },
  wake: { file: `${build}tess-wake.sh`, src: hashFiles([`${root}installer/wake.sh`]) },
  doctor: { file: `${build}tess-doctor.sh`, src: hashFiles([`${root}installer/doctor.sh`]) },
  installer: { file: `${build}tess-installer.sh`, src: hashFiles([`${root}installer/tess-install.sh`]) },
  uninstall: { file: `${build}tess-uninstall.sh`, src: hashFiles([`${root}installer/uninstall.sh`]) },
  mini: { file: `${build}tess-mini.zip`, src: hashFiles([`${root}mini/TessMini.swift`, `${root}mini/Info.plist`]).slice(0, 56) + 'sig1' },
  theme: { file: `${build}tess-theme.tar.gz`, src: hashFiles([`${root}theme/loader/loader.js`]) },
};
const prev = {};
try { for (const l of readFileSync(`${out}dist/components.txt`, 'utf8').split('\n')) { const [n, sha, url, src] = l.split(' '); if (src) prev[n] = { sha, url, src }; } } catch {}
const lines = Object.entries(parts).map(([n, p]) => {
  if (prev[n]?.src === p.src) return `${n} ${prev[n].sha} ${prev[n].url} ${p.src}`;
  const sha = createHash('sha256').update(readFileSync(p.file)).digest('hex');
  return `${n} ${sha} https://github.com/Flame119052/tess-music/releases/download/v${version}/${p.file.split('/').pop()} ${p.src}`;
});
const components = lines.join('\n') + `\nversion ${version}\nrev ${rev}\n`;
writeFileSync(`${out}dist/components.txt`, components);
writeFileSync(`${out}dist/components.sig`, sig(components));
run('git', ['-C', out, 'add', '-A']);
try { run('git', ['-C', out, 'commit', '-q', '-m', `Tess ${version} (${channel})`]); } catch {}
run('git', ['-C', out, 'push', '-q', '-u', 'origin', channel]);
// Installs from 0.1.0 have a loader that reads Flame119052/tess-releases. Keep that repo as a mirror of each channel
// (never archive it), or those users stop getting updates.
// In CI the mirror is pushed with a deploy key that can write to tess-releases only (TESS_MIRROR_KEY_FILE).
const keyFile = process.env.TESS_MIRROR_KEY_FILE;
const mirror = keyFile ? 'git@github.com:Flame119052/tess-releases.git' : 'https://github.com/Flame119052/tess-releases.git';
const mirrorEnv = keyFile ? { env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` } } : {};
try { run('git', ['-C', out, 'push', '-q', '--force', mirror, `HEAD:refs/heads/${channel}`], mirrorEnv); } catch { console.error('mirror push to tess-releases failed; 0.1.0 installs will not see this release'); }
// beta always has at least what stable has: a stable release also moves beta up, unless beta is already ahead
if (channel === 'stable') {
  const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  let betaVersion = '0.0.0';
  try { betaVersion = JSON.parse(execFileSync('git', ['-C', root, 'show', 'origin/beta:dist/manifest.json'], { encoding: 'utf8' })).version; } catch {}
  try { run('git', ['-C', root, 'fetch', '-q', 'origin', 'beta']); betaVersion = JSON.parse(execFileSync('git', ['-C', root, 'show', 'FETCH_HEAD:dist/manifest.json'], { encoding: 'utf8' })).version; } catch {}
  if (newer(version, betaVersion)) {
    const bo = `${root}.build/beta/`;
    rmSync(bo, { recursive: true, force: true });
    try { execFileSync('git', ['-C', root, 'worktree', 'prune']); } catch {}
    run('git', ['-C', root, 'worktree', 'add', '-q', '--detach', bo, 'FETCH_HEAD']);
    cpSync(`${out}dist`, `${bo}dist`, { recursive: true });
    const m = JSON.parse(readFileSync(`${bo}dist/manifest.json`, 'utf8'));
    writeFileSync(`${bo}dist/manifest.json`, JSON.stringify({ ...m, channel: 'beta' }, null, 2));
    run('git', ['-C', bo, 'add', '-A']);
    try { run('git', ['-C', bo, 'commit', '-q', '-m', `Tess ${version} (beta, same as stable)`]); } catch {}
    run('git', ['-C', bo, 'push', '-q', 'origin', 'HEAD:refs/heads/beta']);
    try { run('git', ['-C', bo, 'push', '-q', '--force', mirror, 'HEAD:refs/heads/beta'], mirrorEnv); } catch { console.error('mirror push of beta failed'); }
    console.log(`beta moved up to ${version}`);
  }
}
const assets = [`${build}tess-theme.tar.gz`, `${build}tess-mini.zip`, `${build}tess-patcher-macos-universal.tar.gz`, `${build}tess-updater.sh`, `${build}tess-doctor.sh`, `${build}tess-installer.sh`, `${build}tess-uninstall.sh`, `${build}tess-wake.sh`, `${build}tess-command.sh`];
try {
  run('gh', ['release', 'create', `v${version}`, ...assets, '-R', 'Flame119052/tess-music', '--target', channel, '-t', `Tess ${version}`, '-n', `Tess ${version}. Install: curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/install.sh | sh`, ...(channel === 'stable' ? ['--latest'] : ['--prerelease'])]);
} catch {
  run('gh', ['release', 'upload', `v${version}`, ...assets, '--clobber', '-R', 'Flame119052/tess-music']);
}
console.log(`Released Tess ${version} on ${channel}.`);
