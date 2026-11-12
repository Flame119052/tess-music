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
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('usage: node tools/release.mjs X.Y.Z [stable|beta]'); process.exit(1); }
const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}.build/channel/`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

run('node', [`${root}tools/build.mjs`]);
const js = readFileSync(`${root}theme/Tess/theme.js`, 'utf8').replace("window.__tessVersion", "window.__tessVersion");
const css = readFileSync(`${root}theme/Tess/user.css`, 'utf8');
const key = createPrivateKey(process.env.TESS_SIGNING_KEY || readFileSync(`${homedir()}/.config/tess-signing/private.pem`));
const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const sig = (text) => sign(null, Buffer.from(text), key).toString('base64');
const stamped = `window.__tessVersion = window.__tessVersion === 'baseline' || !window.__tessVersion ? '${version}' : window.__tessVersion;\n${js}`;

rmSync(out, { recursive: true, force: true });
try { execFileSync('git', ['-C', root, 'worktree', 'prune']); } catch {}
try { run('git', ['-C', root, 'fetch', '-q', 'origin', `${channel}:${channel}`]); } catch {}
try { run('git', ['-C', root, 'worktree', 'add', '-q', out, channel]); }
catch { run('git', ['-C', root, 'worktree', 'add', '-q', '--orphan', '-b', channel, out]); }

// signed bundle the loader fetches
mkdirSync(`${out}dist`, { recursive: true });
writeFileSync(`${out}dist/theme.js`, stamped);
writeFileSync(`${out}dist/user.css`, css);
writeFileSync(`${out}dist/manifest.json`, JSON.stringify({ version, channel, js: 'theme.js', css: 'user.css', sig: { js: sig(stamped), css: sig(css) } }, null, 2));

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
run('codesign', ['--force', '--sign', '-', `${build}Tess Mini.app`]);
run('ditto', ['-c', '-k', '--keepParent', `${build}Tess Mini.app`, `${build}tess-mini.zip`]);

writeFileSync(`${out}README.md`, `Release channel \`${channel}\` of Tess Music. Source and install: https://github.com/Flame119052/tess-music\n`);
// the patcher, built from patcher/ (fork of Spicetify CLI) plus Spicetify's compiled helper scripts
const pdir = `${build}patcher/`;
mkdirSync(`${pdir}pkg`, { recursive: true });
for (const a of ['arm64', 'amd64']) run('go', ['build', '-ldflags', '-s -w -X main.version=2.46.4', '-o', `${pdir}tp-${a}`, '.'], { cwd: `${root}patcher`, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: a } });
run('lipo', ['-create', `${pdir}tp-arm64`, `${pdir}tp-amd64`, '-output', `${pdir}pkg/tess-patcher`]);
for (const a of ['arm64', 'amd64']) run('go', ['build', '-ldflags', '-s -w', '-o', `${pdir}tv-${a}`, './tessverify'], { cwd: `${root}patcher`, env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: a } });
run('lipo', ['-create', `${pdir}tv-arm64`, `${pdir}tv-amd64`, '-output', `${pdir}pkg/tess-verify`]);
run('curl', ['-fsSL', '-o', `${pdir}up.tgz`, 'https://github.com/spicetify/cli/releases/download/v2.46.4/spicetify-2.46.4-darwin-arm64.tar.gz']);
mkdirSync(`${pdir}up`, { recursive: true });
run('tar', ['-xzf', `${pdir}up.tgz`, '-C', `${pdir}up`]);
cpSync(`${pdir}up/jsHelper`, `${pdir}pkg/jsHelper`, { recursive: true });
cpSync(`${pdir}up/css-map.json`, `${pdir}pkg/css-map.json`);
cpSync(`${root}patcher/LICENSE`, `${pdir}pkg/LICENSE`);
cpSync(`${root}patcher/NOTICE.md`, `${pdir}pkg/NOTICE.md`);
for (const d of ['Themes', 'Extensions', 'CustomApps']) mkdirSync(`${pdir}pkg/${d}`, { recursive: true });
run('tar', ['-C', `${pdir}pkg`, '-czf', `${build}tess-patcher-macos-universal.tar.gz`, '.']);
// The signed list of Tess's other parts, which the updater on each Mac installs. A part whose source did not change
// keeps pointing at the release that first shipped it, so Macs only download (and restart) what actually changed.
cpSync(`${root}installer/updater.sh`, `${build}tess-updater.sh`);
const hashFiles = (files) => { const h = createHash('sha256'); for (const f of files) h.update(readFileSync(f)); return h.digest('hex'); };
const gitTree = (p) => execFileSync('git', ['-C', root, 'rev-parse', `HEAD:${p}`], { encoding: 'utf8' }).trim();
const parts = {
  updater: { file: `${build}tess-updater.sh`, src: hashFiles([`${root}installer/updater.sh`]) },
  patcher: { file: `${build}tess-patcher-macos-universal.tar.gz`, src: gitTree('patcher') },
  mini: { file: `${build}tess-mini.zip`, src: hashFiles([`${root}mini/TessMini.swift`, `${root}mini/Info.plist`]) },
  theme: { file: `${build}tess-theme.tar.gz`, src: hashFiles([`${root}theme/loader/loader.js`]) },
};
const prev = {};
try { for (const l of readFileSync(`${out}dist/components.txt`, 'utf8').split('\n')) { const [n, sha, url, src] = l.split(' '); if (src) prev[n] = { sha, url, src }; } } catch {}
const lines = Object.entries(parts).map(([n, p]) => {
  if (prev[n]?.src === p.src) return `${n} ${prev[n].sha} ${prev[n].url} ${p.src}`;
  const sha = createHash('sha256').update(readFileSync(p.file)).digest('hex');
  return `${n} ${sha} https://github.com/Flame119052/tess-music/releases/download/v${version}/${p.file.split('/').pop()} ${p.src}`;
});
const components = lines.join('\n') + '\n';
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
const assets = [`${build}tess-theme.tar.gz`, `${build}tess-mini.zip`, `${build}tess-patcher-macos-universal.tar.gz`, `${build}tess-updater.sh`];
try {
  run('gh', ['release', 'create', `v${version}`, ...assets, '-R', 'Flame119052/tess-music', '--target', channel, '-t', `Tess ${version}`, '-n', `Tess ${version}. Install: curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/install.sh | sh`, ...(channel === 'beta' ? ['--prerelease'] : ['--latest'])]);
} catch {
  run('gh', ['release', 'upload', `v${version}`, ...assets, '--clobber', '-R', 'Flame119052/tess-music']);
}
console.log(`Released Tess ${version} on ${channel}.`);
