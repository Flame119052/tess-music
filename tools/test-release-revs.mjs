// promote.mjs must refuse a beta whose rev is below stable's, or every stable Mac would reject it.
// Run: node tools/test-release-revs.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
// The signed parts list is installed in file order. The tess command runs installer.sh and uninstall.sh, so those must
// be written first: on a Mac that has neither yet, a command written first would point at a script that is not there.
const release = readFileSync(join(root, 'tools/release.mjs'), 'utf8');
const partsBlock = release.match(/const parts = \{([\s\S]*?)\n\};/);
assert.ok(partsBlock, 'release.mjs still lists the signed parts');
const partNames = [...partsBlock[1].matchAll(/^  (\w+):/gm)].map((m) => m[1]);
for (const name of ['command', 'installer', 'uninstall']) assert.ok(partNames.includes(name), `the list names ${name}`);
assert.ok(partNames.indexOf('installer') < partNames.indexOf('command'), 'installer.sh is written before the tess command');
assert.ok(partNames.indexOf('uninstall') < partNames.indexOf('command'), 'uninstall.sh is written before the tess command');
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

  // a beta above stable is allowed when its dist carries the signed installer pair
  writeFileSync(join(repo, 'dist/manifest.json'), manifest(11, '0.2.11'));
  writeFileSync(join(repo, 'dist/install.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(repo, 'dist/install.sig'), 'sig\n');
  git(repo, ['add', '.']); commit(repo, 'beta 11');
  git(repo, ['push', '-q', 'origin', 'beta']);
  git(repo, ['fetch', '-q', 'origin']);
  r = promote();
  assert.equal(r.status, 0, r.out);

  // a higher rev still refuses when either half of the pair is missing
  git(repo, ['rm', '-q', 'dist/install.sig']);
  git(repo, ['add', '.']); commit(repo, 'beta missing sig');
  git(repo, ['push', '-q', 'origin', 'beta']);
  git(repo, ['fetch', '-q', 'origin']);
  r = promote();
  assert.notEqual(r.status, 0, 'a beta without dist/install.sig is refused');
  assert.match(r.out, /dist\/install\.sig/, 'the refusal names the missing signature');

  writeFileSync(join(repo, 'dist/install.sig'), 'sig\n');
  git(repo, ['rm', '-q', 'dist/install.sh']);
  git(repo, ['add', '.']); commit(repo, 'beta missing installer');
  git(repo, ['push', '-q', 'origin', 'beta']);
  git(repo, ['fetch', '-q', 'origin']);
  r = promote();
  assert.notEqual(r.status, 0, 'a beta without dist/install.sh is refused');
  assert.match(r.out, /dist\/install\.sh/, 'the refusal names the missing installer');

  console.log('release rev guard passed (beta 5 vs stable 10 refused; beta 11 allowed; a dist without install.sh or install.sig refused; installer and uninstaller parts precede the command)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
