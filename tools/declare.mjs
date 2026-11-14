// Declare the current dev build as beta and write notes for PRs merged since the previous beta.
// Usage: node tools/declare.mjs [X.Y.Z] [--dry-run]
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = 'Flame119052/tess-music';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const positionals = args.filter((arg) => arg !== '--dry-run');
if (positionals.length > 1) {
  console.error('usage: node tools/declare.mjs [X.Y.Z] [--dry-run]');
  process.exit(1);
}

const run = (cmd, cmdArgs, options = {}) => execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...options });
const output = (cmd, cmdArgs, options = {}) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...options }).trim();
const git = (...gitArgs) => output('git', ['-C', root, ...gitArgs]);
const showJson = (ref, path) => JSON.parse(git('show', `${ref}:${path}`));

run('git', ['-C', root, 'fetch', '-q', 'origin', 'dev', 'beta', 'main']);
const devManifest = showJson('origin/dev', 'dist/manifest.json');
const version = positionals[0] || devManifest.version;
if (devManifest.version !== version) {
  console.error(`dev has ${devManifest.version}, not ${version}; nothing declared`);
  process.exit(1);
}

const sourceCommit = git('rev-parse', 'origin/main');
let previousSource = '';
try {
  previousSource = JSON.parse(output('git', ['-C', root, 'show', 'origin/beta:release.json'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })).sourceCommit || '';
} catch {}

const isAncestor = (older, newer) => {
  try {
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', older, newer]);
    return true;
  } catch {
    return false;
  }
};

if (!previousSource || !isAncestor(previousSource, sourceCommit)) {
  const betaVersion = showJson('origin/beta', 'dist/manifest.json').version;
  try {
    const release = JSON.parse(output('gh', ['release', 'view', `v${betaVersion}`, '-R', repo, '--json', 'publishedAt']));
    previousSource = git('rev-list', '-1', `--before=${release.publishedAt}`, 'origin/main');
  } catch {
    previousSource = git('rev-list', '--max-parents=0', 'origin/main').split('\n')[0];
  }
}

const commits = previousSource === sourceCommit
  ? []
  : git('rev-list', '--reverse', '--first-parent', `${previousSource}..${sourceCommit}`).split('\n').filter(Boolean);
const pullRequests = new Map();
for (const commit of commits) {
  const associated = JSON.parse(output('gh', [
    'api',
    `repos/${repo}/commits/${commit}/pulls`,
    '-H',
    'Accept: application/vnd.github+json',
  ]) || '[]');
  for (const pr of associated) {
    if (pr.merged_at && pr.base?.ref === 'main') pullRequests.set(pr.number, pr);
  }
}

const changes = [...pullRequests.values()]
  .sort((a, b) => new Date(a.merged_at) - new Date(b.merged_at))
  .map((pr) => `- [#${pr.number}](${pr.html_url}) ${String(pr.title).replace(/\s+/g, ' ').trim()} (@${pr.user.login})`);
const notes = [
  `# Tess ${version} beta`,
  '',
  `Source: [\`${sourceCommit.slice(0, 12)}\`](https://github.com/${repo}/commit/${sourceCommit})`,
  '',
  '## Changes since the previous beta',
  '',
  ...(changes.length ? changes : ['No pull requests were merged since the previous beta.']),
  '',
].join('\n');

console.log(`Declare Tess ${version}: dev (${git('rev-parse', 'origin/dev').slice(0, 12)}) -> beta`);
console.log('Copy: dist/ byte for byte, changing only manifest.json channel; installer/install.sh -> /install.sh');
console.log('Write: RELEASE_NOTES.md and release.json (including the main source commit)');
console.log('\n' + notes);
if (dryRun) {
  console.log('Dry run: no branches, mirror, or GitHub release were changed.');
  process.exit(0);
}

const keyFile = process.env.TESS_MIRROR_KEY_FILE;
const mirror = keyFile ? 'git@github.com:Flame119052/tess-releases.git' : 'https://github.com/Flame119052/tess-releases.git';
const mirrorEnv = keyFile
  ? { env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` } }
  : {};
const worktree = `${root}.build/declare-beta/`;

rmSync(worktree, { recursive: true, force: true });
try {
  try { execFileSync('git', ['-C', root, 'worktree', 'prune']); } catch {}
  run('git', ['-C', root, 'worktree', 'add', '-q', '--detach', worktree, 'origin/beta']);
  rmSync(`${worktree}dist`, { recursive: true, force: true });
  run('git', ['-C', worktree, 'checkout', '-q', 'origin/dev', '--', 'dist']);

  const manifest = JSON.parse(readFileSync(`${worktree}dist/manifest.json`, 'utf8'));
  writeFileSync(`${worktree}dist/manifest.json`, JSON.stringify({ ...manifest, channel: 'beta' }, null, 2));
  writeFileSync(`${worktree}install.sh`, execFileSync('git', [
    '-C',
    root,
    'show',
    `${sourceCommit}:installer/install.sh`,
  ]));
  chmodSync(`${worktree}install.sh`, 0o755);
  writeFileSync(`${worktree}RELEASE_NOTES.md`, notes);
  writeFileSync(`${worktree}release.json`, JSON.stringify({
    version,
    channel: 'beta',
    sourceCommit,
    previousSourceCommit: previousSource,
  }, null, 2) + '\n');

  run('git', ['-C', worktree, 'add', '-A']);
  let unchanged = false;
  try { execFileSync('git', ['-C', worktree, 'diff', '--cached', '--quiet']); unchanged = true; }
  catch (error) { if (error.status !== 1) throw error; }
  if (!unchanged) run('git', ['-C', worktree, 'commit', '-q', '-m', `Tess ${version} (beta, declared from dev)`]);
  run('git', ['-C', worktree, 'push', '-q', 'origin', 'HEAD:refs/heads/beta']);
  try {
    run('git', ['-C', worktree, 'push', '-q', '--force', mirror, 'HEAD:refs/heads/beta'], mirrorEnv);
  } catch {
    console.error('mirror push of beta failed');
  }
  run('gh', ['release', 'edit', `v${version}`, '-R', repo, '--prerelease', '--notes-file', `${worktree}RELEASE_NOTES.md`]);
} finally {
  rmSync(worktree, { recursive: true, force: true });
  try { execFileSync('git', ['-C', root, 'worktree', 'prune']); } catch {}
}

console.log(`Declared Tess ${version} on beta.`);
