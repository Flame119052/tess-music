// promote.mjs must refuse a beta whose rev is below stable's, or every stable Mac would reject it.
// Run: node tools/test-release-revs.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const box = mkdtempSync(join(tmpdir(), 'tess-rev-guard-'));
const origin = join(box, 'origin.git');
const repo = join(box, 'repo');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const commit = (cwd, msg) => git(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg]);
const manifest = (rev, version) => JSON.stringify({ version, rev, channel: 'beta' }) + '\n';

try {
  git(box, ['init', '-q', '--bare', origin]);
  git(box, ['init', '-q', repo]);
  mkdirSync(join(repo, 'tools'), { recursive: true });
  copyFileSync(join(root, 'tools/promote.mjs'), join(repo, 'tools/promote.mjs'));
  mkdirSync(join(repo, 'dist'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'x\n');
  writeFileSync(join(repo, 'dist/manifest.json'), manifest(10, '0.2.10'));
  writeFileSync(join(repo, 'release.json'), JSON.stringify({ channel: 'stable' }) + '\n');
  git(repo, ['add', '.']); commit(repo, 'stable 10');
  git(repo, ['branch', '-M', 'stable']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', 'origin', 'stable']);

  const base = git(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim();
  git(repo, ['checkout', '-q', '-b', 'beta', base]);
  writeFileSync(join(repo, 'dist/manifest.json'), manifest(5, '0.2.05'));
  writeFileSync(join(repo, 'release.json'), JSON.stringify({ channel: 'beta' }) + '\n');
  git(repo, ['add', '.']); commit(repo, 'beta 5');
  git(repo, ['push', '-q', 'origin', 'beta']);
  git(repo, ['fetch', '-q', 'origin']);

  const promote = () => {
    try {
      const out = execFileSync('node', ['tools/promote.mjs', '--dry-run'], {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, out };
    } catch (e) {
      return { status: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
    }
  };

  let r = promote();
  assert.notEqual(r.status, 0, 'beta below stable is refused');
  assert.match(r.out, /lower than stable/, 'the guard explains why');

  // a beta above stable is allowed
  writeFileSync(join(repo, 'dist/manifest.json'), manifest(11, '0.2.11'));
  git(repo, ['add', '.']); commit(repo, 'beta 11');
  git(repo, ['push', '-q', 'origin', 'beta']);
  git(repo, ['fetch', '-q', 'origin']);
  r = promote();
  assert.equal(r.status, 0, r.out);
  console.log('release rev guard passed (beta 5 vs stable 10 refused; beta 11 allowed)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
