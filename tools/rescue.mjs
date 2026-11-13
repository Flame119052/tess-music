// Publish a signed rescue order: one of Tess's fixed rescue actions, for Macs whose normal updates are stuck.
// Signed with the rescue key, ~/.config/tess-signing/rescue.pem, which exists only on the owner's Mac (never in
// GitHub, never in CI).
//
//   node tools/rescue.mjs <action> [--days 3] [--only <install id>,<install id>] [--yes]
//
// Actions (the only things a rescue line can do; they are fixed in installer/rescue.sh, an order can't add one):
//   check            Tess's doctor checks Tess and Spotify and sends a report
//   update           Tess's updater runs now (only parts signed with the release key)
//   repair           Tess is reinstalled with the public install line, on the Mac's channel
//   restore-spotify  Tess is taken out of Spotify and Spotify's own interface put back
//   uninstall        Tess is removed completely
// To try it on one Mac first, use --only with that Mac's install id (tess report prints it).
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ACTIONS = ['check', 'update', 'repair', 'restore-spotify', 'uninstall'];
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const action = args[0];
if (!ACTIONS.includes(action)) { console.error(`usage: node tools/rescue.mjs <${ACTIONS.join('|')}> [--days 3] [--only id,id]`); process.exit(1); }
const days = Number(opt('days') || 3);
const only = (opt('only') || '').split(',').filter(Boolean);
if (only.some((i) => !/^[0-9a-f]{32}$/.test(i))) { console.error('--only takes install ids (32 hex characters)'); process.exit(1); }

const REPO = 'Flame119052/tess-music';
// The next serial must be above every order already out. raw.githubusercontent caches for ~5 minutes, so read
// GitHub's live API and the inbox's wake number instead, and take the highest.
const read = (a) => { try { return execFileSync('curl', ['-fsSL', '--max-time', '20', ...a], { encoding: 'utf8' }); } catch { return ''; } };
const serial = Math.max(
  Number((read(['-H', 'Accept: application/vnd.github.raw', `https://api.github.com/repos/${REPO}/contents/rescue.txt?ref=rescue`]).match(/^serial (\d+)$/m) || [])[1] || 0),
  Number(read(['https://tess-music-player.janus.ing/v1/wake']).trim().match(/^\d+$/)?.[0] || 0),
) + 1;
const expires = Math.floor(Date.now() / 1000) + days * 86400;
const order = ['tess-rescue 2', `serial ${serial}`, `expires ${expires}`, ...(only.length ? [`only ${only.join(' ')}`] : []), `action ${action}`].join('\n') + '\n';
const key = createPrivateKey(readFileSync(`${homedir()}/.config/tess-signing/rescue.pem`));
const sig = sign(null, Buffer.from(order), key).toString('base64');

console.log(`\n${order}---\nRescue order ${serial} (${action}): runs on ${only.length ? `${only.length} Mac(s)` : 'EVERY Tess Mac'}, valid ${days} day(s).`);
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
run('git', ['-C', dir, 'commit', '-q', '-m', `Rescue order ${serial}: ${action}`]);
run('git', ['-C', dir, 'push', '-q', 'origin', 'rescue']);
// 2. the Tess inbox, in case GitHub can't be reached
const kv = (k, path) => run('npx', ['-y', 'wrangler@4', 'kv', 'key', 'put', '--remote', '--namespace-id', '26cadf05786a439b89302a0641180c39', k, '--path', path], { cwd: fileURLToPath(new URL('../inbox/', import.meta.url)) });
kv('rescue.txt', `${dir}/rescue.txt`);
kv('rescue.sig', `${dir}/rescue.sig`);
console.log(`Published rescue order ${serial} (${action}). Macs pick it up within 6 hours (or at their next login).`);
