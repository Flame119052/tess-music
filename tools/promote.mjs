// Promote the build on the internal `dev` channel to the public `stable` and `beta` channels.
// Usage: node tools/promote.mjs [X.Y.Z]     (defaults to whatever dev has now; refuses if dev has something else)
//
// Every push to main is built and signed onto `dev` only (the owner's Mac follows it). Nothing reaches users until
// that exact build is promoted: the same signed files, the same release assets, only the channel name in the
// manifest changes (it isn't covered by the signature; the theme files and the parts list are).
// In CI this runs from the release workflow's "promote" action; locally it uses your git and gh login.
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

run('git', ['-C', root, 'fetch', '-q', 'origin', 'dev']);
const devManifest = JSON.parse(git('show', 'FETCH_HEAD:dist/manifest.json'));
const version = process.argv[2] || devManifest.version;
if (devManifest.version !== version) { console.error(`dev has ${devManifest.version}, not ${version}; nothing promoted`); process.exit(1); }
const devCommit = git('rev-parse', 'FETCH_HEAD');

const keyFile = process.env.TESS_MIRROR_KEY_FILE;
const mirror = keyFile ? 'git@github.com:Flame119052/tess-releases.git' : 'https://github.com/Flame119052/tess-releases.git';
const mirrorEnv = keyFile ? { env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` } } : {};

for (const channel of ['stable', 'beta']) {
  const wt = `${root}.build/promote-${channel}/`;
  rmSync(wt, { recursive: true, force: true });
  try { execFileSync('git', ['-C', root, 'worktree', 'prune']); } catch {}
  run('git', ['-C', root, 'fetch', '-q', 'origin', channel]);
  run('git', ['-C', root, 'worktree', 'add', '-q', '--detach', wt, 'FETCH_HEAD']);
  rmSync(`${wt}dist`, { recursive: true, force: true });
  run('git', ['-C', wt, 'checkout', '-q', devCommit, '--', 'dist']);
  const m = JSON.parse(readFileSync(`${wt}dist/manifest.json`, 'utf8'));
  writeFileSync(`${wt}dist/manifest.json`, JSON.stringify({ ...m, channel }, null, 2));
  run('git', ['-C', wt, 'add', '-A']);
  try { run('git', ['-C', wt, 'commit', '-q', '-m', `Tess ${version} (${channel}, promoted from dev)`]); } catch {}
  run('git', ['-C', wt, 'push', '-q', 'origin', `HEAD:refs/heads/${channel}`]);
  // installs from 0.1.0 read the mirror (never archive it)
  try { run('git', ['-C', wt, 'push', '-q', '--force', mirror, `HEAD:refs/heads/${channel}`], mirrorEnv); } catch { console.error(`mirror push of ${channel} failed`); }
  rmSync(wt, { recursive: true, force: true });
}
try { execFileSync('git', ['-C', root, 'worktree', 'prune']); } catch {}
run('gh', ['release', 'edit', `v${version}`, '-R', 'Flame119052/tess-music', '--prerelease=false', '--latest']);
console.log(`Promoted Tess ${version} to stable and beta.`);
