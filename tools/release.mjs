// Build, sign and publish a Tess release.
// Usage: node tools/release.mjs 0.1.0 [stable|beta]
//
// 1. builds theme/Tess (user.css + theme.js)
// 2. signs both with the Ed25519 key in ~/.config/tess-signing/private.pem (never in the repo)
// 3. writes dist/manifest.json, the installable loader theme, and Tess Mini (universal)
// 4. writes the signed bundle to this repo's `stable` / `beta` branch (via a worktree in .build/channel), pushes it,
//    builds the patcher from patcher/, and creates the GitHub Release vX.Y.Z on Flame119052/tess-music.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign, createPublicKey } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const [version, channel = 'stable'] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('usage: node tools/release.mjs X.Y.Z [stable|beta]'); process.exit(1); }
const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}.build/channel/`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

run('node', [`${root}tools/build.mjs`]);
const js = readFileSync(`${root}theme/Tess/theme.js`, 'utf8').replace("window.__tessVersion", "window.__tessVersion");
const css = readFileSync(`${root}theme/Tess/user.css`, 'utf8');
const key = createPrivateKey(readFileSync(`${homedir()}/.config/tess-signing/private.pem`));
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
run('curl', ['-fsSL', '-o', `${pdir}up.tgz`, 'https://github.com/spicetify/cli/releases/download/v2.46.4/spicetify-2.46.4-darwin-arm64.tar.gz']);
mkdirSync(`${pdir}up`, { recursive: true });
run('tar', ['-xzf', `${pdir}up.tgz`, '-C', `${pdir}up`]);
cpSync(`${pdir}up/jsHelper`, `${pdir}pkg/jsHelper`, { recursive: true });
cpSync(`${pdir}up/css-map.json`, `${pdir}pkg/css-map.json`);
cpSync(`${root}patcher/LICENSE`, `${pdir}pkg/LICENSE`);
cpSync(`${root}patcher/NOTICE.md`, `${pdir}pkg/NOTICE.md`);
for (const d of ['Themes', 'Extensions', 'CustomApps']) mkdirSync(`${pdir}pkg/${d}`, { recursive: true });
run('tar', ['-C', `${pdir}pkg`, '-czf', `${build}tess-patcher-macos-universal.tar.gz`, '.']);
run('git', ['-C', out, 'add', '-A']);
try { run('git', ['-C', out, 'commit', '-q', '-m', `Tess ${version} (${channel})`]); } catch {}
run('git', ['-C', out, 'push', '-q', '-u', 'origin', channel]);
const assets = [`${build}tess-theme.tar.gz`, `${build}tess-mini.zip`, `${build}tess-patcher-macos-universal.tar.gz`];
try {
  run('gh', ['release', 'create', `v${version}`, ...assets, '-R', 'Flame119052/tess-music', '--target', channel, '-t', `Tess ${version}`, '-n', `Tess ${version}. Install: curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-music/main/installer/install.sh | sh`, ...(channel === 'beta' ? ['--prerelease'] : ['--latest'])]);
} catch {
  run('gh', ['release', 'upload', `v${version}`, ...assets, '--clobber', '-R', 'Flame119052/tess-music']);
}
console.log(`Released Tess ${version} on ${channel}.`);
