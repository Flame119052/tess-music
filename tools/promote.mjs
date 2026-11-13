// Promote the declared beta build to stable.
// Usage: node tools/promote.mjs [X.Y.Z] [--dry-run]
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = 'Flame119052/tess-music';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positionals = args.filter((arg) => arg !== '--dry-run');
if (positionals.length > 1) {
  console.error('usage: node tools/promote.mjs [X.Y.Z] [--dry-run]');
  process.exit(1);
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

run('git', ['-C', root, 'fetch', '-q', 'origin', 'beta', 'stable']);
const betaManifest = JSON.parse(git('show', 'origin/beta:dist/manifest.json'));
const version = positionals[0] || betaManifest.version;
if (betaManifest.version !== version) {
  console.error(`beta has ${betaManifest.version}, not ${version}; nothing promoted`);
  process.exit(1);
}
const betaCommit = git('rev-parse', 'origin/beta');
let notes = `# Tess ${version}\n\nNo release notes were recorded on beta.\n`;
try {
  notes = execFileSync('git', ['-C', root, 'show', 'origin/beta:RELEASE_NOTES.md'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {}

console.log(`Promote Tess ${version}: beta (${betaCommit.slice(0, 12)}) -> stable`);
console.log('Copy: dist/, /install.sh, RELEASE_NOTES.md and release.json; change only channel metadata');
console.log('\n' + notes);
if (dryRun) {
  console.log('Dry run: no branches, mirror, or GitHub release were changed.');
  process.exit(0);
}

const keyFile = process.env.TESS_MIRROR_KEY_FILE;
const mirror = keyFile ? 'git@github.com:Flame119052/tess-releases.git' : 'https://github.com/Flame119052/tess-releases.git';
const mirrorEnv = keyFile ? { env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` } } : {};

const worktree = `${root}.build/promote-stable/`;
rmSync(worktree, { recursive: true, force: true });
try {
  try { execFileSync('git', ['-C', root, 'worktree', 'prune']); } catch {}
  run('git', ['-C', root, 'worktree', 'add', '-q', '--detach', worktree, 'origin/stable']);
  rmSync(`${worktree}dist`, { recursive: true, force: true });
  run('git', ['-C', worktree, 'checkout', '-q', betaCommit, '--', 'dist', 'install.sh', 'RELEASE_NOTES.md', 'release.json']);
  const manifest = JSON.parse(readFileSync(`${worktree}dist/manifest.json`, 'utf8'));
  writeFileSync(`${worktree}dist/manifest.json`, JSON.stringify({ ...manifest, channel: 'stable' }, null, 2));
  const metadata = JSON.parse(readFileSync(`${worktree}release.json`, 'utf8'));
  writeFileSync(`${worktree}release.json`, JSON.stringify({ ...metadata, channel: 'stable' }, null, 2) + '\n');
  run('git', ['-C', worktree, 'add', '-A']);
  let unchanged = false;
  try { execFileSync('git', ['-C', worktree, 'diff', '--cached', '--quiet']); unchanged = true; }
  catch (error) { if (error.status !== 1) throw error; }
  if (!unchanged) run('git', ['-C', worktree, 'commit', '-q', '-m', `Tess ${version} (stable, promoted from beta)`]);
  run('git', ['-C', worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/stable']);
  try {
    run('git', ['-C', worktree, 'push', '-q', '--force', mirror, 'HEAD:refs/heads/stable'], mirrorEnv);
  } catch {
    console.error('mirror push of stable failed');
  }
  run('gh', ['release', 'edit', `v${version}`, '-R', repo, '--prerelease=false', '--latest', '--notes-file', `${worktree}RELEASE_NOTES.md`]);
} finally {
  rmSync(worktree, { recursive: true, force: true });
  try { execFileSync('git', ['-C', root, 'worktree', 'prune']); } catch {}
}
console.log(`Promoted Tess ${version} to stable.`);
