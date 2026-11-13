// Publish a signed rescue order: a zsh script every Tess Mac runs once (see installer/rescue.sh). It is the way to
// fix Macs whose normal updates are stuck. Signed with the rescue key, ~/.config/tess-signing/rescue.pem, which
// exists only on the owner's Mac (never in GitHub, never in CI).
//
//   node tools/rescue.mjs fix.sh [--days 3] [--only <install id>,<install id>]
//
// Write the script so running it twice is harmless. It runs as the user (not root) with the zsh in macOS, from
// anywhere, with $T = Tess's folder exported. Its output lands in Tess/rescue/rescue.log and is sent to the inbox.
// To check it on one Mac first, use --only with that Mac's install id (tess report prints it).
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !/^[0-9a-f,]+$/.test(a));
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
if (!file) { console.error('usage: node tools/rescue.mjs fix.sh [--days 3] [--only id,id]'); process.exit(1); }
const days = Number(opt('days') || 3);
const only = (opt('only') || '').split(',').filter(Boolean);
if (only.some((i) => !/^[0-9a-f]{32}$/.test(i))) { console.error('--only takes install ids (32 hex characters)'); process.exit(1); }
const script = readFileSync(file, 'utf8');
execFileSync('zsh', ['-n', file], { stdio: 'inherit' });

const REPO = 'Flame119052/tess-music';
// The next serial must be above every order already out. raw.githubusercontent caches for ~5 minutes, so two orders
// sent close together got the same serial and Macs skipped the second; read GitHub's live API and the inbox's wake
// number instead, and take the highest.
const seen = [];
const read = (args) => { try { return execFileSync('curl', ['-fsSL', '--max-time', '20', ...args], { encoding: 'utf8' }); } catch { return ''; } };
seen.push(Number((read(['-H', 'Accept: application/vnd.github.raw', `https://api.github.com/repos/${REPO}/contents/rescue.txt?ref=rescue`]).match(/^serial (\d+)$/m) || [])[1] || 0));
seen.push(Number(read(['https://tess-music-player.janus.ing/v1/wake']).trim().match(/^\d+$/)?.[0] || 0));
let serial = Math.max(...seen) + 1;
const expires = Math.floor(Date.now() / 1000) + days * 86400;
const order = ['tess-rescue 1', `serial ${serial}`, `expires ${expires}`, ...(only.length ? [`only ${only.join(' ')}`] : []), '---',
  'export T="${TESS_HOME:-$HOME/Library/Application Support/Tess}"', script].join('\n') + '\n';
const key = createPrivateKey(readFileSync(`${homedir()}/.config/tess-signing/rescue.pem`));
const sig = sign(null, Buffer.from(order), key).toString('base64');

console.log(`\n${order}\n---\nRescue order ${serial}: runs on ${only.length ? `${only.length} Mac(s)` : 'EVERY Tess Mac'}, valid ${days} day(s).`);
if (!args.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question('Type "publish" to sign and send it: ');
  rl.close();
  if (a.trim() !== 'publish') { console.log('Not published.'); process.exit(0); }
}

// 1. the `rescue` branch of the repo (read by GitHub's API and raw files)
const dir = mkdtempSync(`${tmpdir()}/tess-rescue-`);
const run = (cmd, a, o = {}) => execFileSync(cmd, a, { stdio: 'inherit', ...o });
run('git', ['clone', '-q', '--depth', '1', '--branch', 'rescue', `https://github.com/${REPO}.git`, dir]);
writeFileSync(`${dir}/rescue.txt`, order);
writeFileSync(`${dir}/rescue.sig`, sig + '\n');
run('git', ['-C', dir, 'add', '-A']);
run('git', ['-C', dir, 'commit', '-q', '-m', `Rescue order ${serial}`]);
run('git', ['-C', dir, 'push', '-q', 'origin', 'rescue']);
// 2. the Tess inbox, in case GitHub can't be reached
const kv = (k, path) => run('npx', ['-y', 'wrangler@4', 'kv', 'key', 'put', '--remote', '--namespace-id', '26cadf05786a439b89302a0641180c39', k, '--path', path], { cwd: fileURLToPath(new URL('../inbox/', import.meta.url)) });
kv('rescue.txt', `${dir}/rescue.txt`);
kv('rescue.sig', `${dir}/rescue.sig`);
// 3. the wake row in D1: strongly consistent, so a Mac's next wake check (every five minutes) sees it at once
try {
  execFileSync('npx', ['-y', 'wrangler@4', 'd1', 'execute', 'tess-inbox', '--remote', '--command',
    `INSERT INTO wake (id, serial) VALUES (1, ${serial}) ON CONFLICT(id) DO UPDATE SET serial = excluded.serial`],
  { cwd: fileURLToPath(new URL('../inbox/', import.meta.url)), stdio: 'ignore' });
} catch {
  console.error('Warning: the wake row in D1 failed; the KV fallback still works.');
}
// 4. the same serial in KV: slower to reach every edge, but keeps the wake path alive if D1 is unavailable
try {
  writeFileSync(`${dir}/wake`, `${serial}\n`);
  kv('wake', `${dir}/wake`);
} catch {
  console.error('Warning: the KV wake fallback failed; the D1 wake row still works.');
}
console.log(`Published rescue order ${serial}. Macs with the wake helper start it within about five minutes; others within 6 hours (or at their next login).`);
