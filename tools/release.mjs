// Build, sign and publish a Tess release.
// Usage: node tools/release.mjs 0.1.0 [stable|beta]
//
// 1. builds theme/Tess (user.css + theme.js)
// 2. signs both with the Ed25519 key in ~/.config/tess-signing/private.pem (never in the repo)
// 3. writes dist/manifest.json, the installable loader theme, and Tess Mini (universal)
// 4. copies them into the public Flame119052/tess-releases checkout (../tess-releases), commits, pushes the channel
//    branch, and creates the GitHub Release vX.Y.Z with the installer assets.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign, createPublicKey } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const [version, channel = 'stable'] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('usage: node tools/release.mjs X.Y.Z [stable|beta]'); process.exit(1); }
const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}../tess-releases/`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

run('node', [`${root}tools/build.mjs`]);
const js = readFileSync(`${root}theme/Tess/theme.js`, 'utf8').replace("window.__tessVersion", "window.__tessVersion");
const css = readFileSync(`${root}theme/Tess/user.css`, 'utf8');
const key = createPrivateKey(readFileSync(`${homedir()}/.config/tess-signing/private.pem`));
const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const sig = (text) => sign(null, Buffer.from(text), key).toString('base64');
const stamped = `window.__tessVersion = window.__tessVersion === 'baseline' || !window.__tessVersion ? '${version}' : window.__tessVersion;\n${js}`;

if (!existsSync(out)) run('gh', ['repo', 'clone', 'Flame119052/tess-releases', out]);
run('git', ['-C', out, 'fetch', '-q', 'origin']);
try { run('git', ['-C', out, 'checkout', '-q', channel]); } catch { run('git', ['-C', out, 'checkout', '-q', '-b', channel]); }

// signed bundle the loader fetches
mkdirSync(`${out}dist`, { recursive: true });
writeFileSync(`${out}dist/theme.js`, stamped);
writeFileSync(`${out}dist/user.css`, css);
writeFileSync(`${out}dist/manifest.json`, JSON.stringify({ version, channel, js: 'theme.js', css: 'user.css', sig: { js: sig(stamped), css: sig(css) } }, null, 2));

// the theme the installer writes into Spotify: loader + this release as the offline baseline
const loader = readFileSync(`${root}theme/loader/loader.js`, 'utf8').replace('__TESS_PUBLIC_KEY__', pub);
const build = `${root}.build/`;
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

cpSync(`${root}installer/install.sh`, `${out}install.sh`);
cpSync(`${root}installer/uninstall.sh`, `${out}uninstall.sh`);
cpSync(`${root}installer/README.md`, `${out}README.md`);
cpSync(`${root}installer/LICENSE-NOTICE.md`, `${out}NOTICE.md`);
run('git', ['-C', out, 'add', '-A']);
try { run('git', ['-C', out, 'commit', '-q', '-m', `Tess ${version} (${channel})`]); } catch {}
run('git', ['-C', out, 'push', '-q', '-u', 'origin', channel]);
if (channel === 'stable') {
  // main mirrors stable so the install line always points at the newest stable installer
  run('git', ['-C', out, 'push', '-q', '-f', 'origin', 'stable:main']);
}
const assets = [`${build}tess-theme.tar.gz`, `${build}tess-mini.zip`, `${root}../tess-patcher/dist/tess-patcher-macos-universal.tar.gz`];
try {
  run('gh', ['release', 'create', `v${version}`, ...assets, '-R', 'Flame119052/tess-releases', '--target', channel, '-t', `Tess ${version}`, '-n', `Tess ${version}. Install: curl -fsSL https://raw.githubusercontent.com/Flame119052/tess-releases/main/install.sh | sh`, ...(channel === 'beta' ? ['--prerelease'] : ['--latest'])]);
} catch {
  run('gh', ['release', 'upload', `v${version}`, ...assets, '--clobber', '-R', 'Flame119052/tess-releases']);
}
console.log(`Released Tess ${version} on ${channel}.`);
