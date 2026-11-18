// The public install line may run a downloaded file only after tess-verify accepts it, and it never
// fetches an installer from main. The old gate only named two fallback paths and still said #77 allowed
// them. Run: node tools/test-forwarder-gate.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const gate = readFileSync(join(root, 'tools/check-safety.sh'), 'utf8');
assert.doesNotMatch(gate, /#77/, 'the #77 fallback comment is gone');
assert.match(gate, /forwarder_problem/, 'the gate checks how the install line runs a download');

const accepted = `"$D/tess-verify" "$D/install.sh" "sig" || fail "no"
TESS_CHANNEL="$CH" TESS_VERIFY="$D/tess-verify" sh "$D/install.sh"
`;

const run = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'tess-fwd-'));
  const file = join(dir, 'fixture.sh');
  writeFileSync(file, body);
  try {
    const out = execFileSync('sh', [join(root, 'tools/check-safety.sh'), '--forwarder-fixture', file], { encoding: 'utf8' });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const blocked = (body, why) => {
  const r = run(body);
  assert.notEqual(r.status, 0, why);
  assert.match(r.out, /forwarder-blocked/, why);
};

let r = run(accepted);
assert.equal(r.status, 0, r.out);
assert.match(r.out, /forwarder-ok/, 'the verified installer is the one shell of a download');

blocked('sh "$D/install.sh"\n', 'a shell before tess-verify is refused');
blocked(`${accepted}sh "$D/legacy.sh"\n`, 'a second downloaded script is refused');
blocked('curl -fsSL "$BASE/main/dist/install.sh" -o "$D/install.sh"\n' + accepted, 'an installer from main/dist is refused');
blocked('curl -fsSL "$BASE/main/installer/legacy.sh" -o "$D/x"\n' + accepted, 'the old legacy fallback is refused');
blocked('curl -fsSL "$BASE/main/installer/tess-install.sh" -o "$D/x"\n' + accepted, 'the old tess-install fallback is refused');
blocked('curl -fsSL -H "Accept: application/vnd.github.raw" "$API/contents/dist/install.sh?ref=main" -o "$D/install.sh"\n' + accepted, 'ref=main is refused');
blocked('"$D/tess-verify" "$D/install.sh" "sig" || true\nsh "$D/install.sh"\n', 'a verify that does not exit still refuses');
blocked('curl -fsSL "$BASE/$CH/dist/install.sh" | sh\n' + accepted, 'a pipe into a shell is refused');

r = run(readFileSync(join(root, 'installer/install.sh'), 'utf8'));
assert.equal(r.status, 0, r.out);
assert.match(r.out, /forwarder-ok/, 'installer/install.sh passes the gate');

// origin/stable is still the pre-Release-B build, so a missing installer is a notice.
// A missing ref stays quiet. A channel that already has dist/install.sh stays quiet.
const notice = (repo) => {
  try {
    const out = execFileSync('sh', [join(root, 'tools/check-safety.sh'), '--stable-notice', repo], { encoding: 'utf8' });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};
const initStable = (withInstaller) => {
  const box = mkdtempSync(join(tmpdir(), 'tess-stable-notice-'));
  const origin = join(box, 'origin.git');
  const repo = join(box, 'repo');
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(box, ['init', '-q', '--bare', origin]);
  git(box, ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), 'x\n');
  if (withInstaller) {
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist/install.sh'), '#!/bin/sh\nexit 0\n');
  }
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'stable']);
  git(repo, ['branch', '-M', 'stable']);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', 'origin', 'stable']);
  git(repo, ['fetch', '-q', 'origin']);
  return { box, repo };
};

const missing = initStable(false);
let n = notice(missing.repo);
rmSync(missing.box, { recursive: true, force: true });
assert.equal(n.status, 0, n.out);
assert.match(n.out, /new installs are refused until the first promote/, 'a stable channel with no installer is a notice, not a failure');
assert.doesNotMatch(n.out, /SAFETY CHECK FAILED/, 'the notice does not fail the check');

const present = initStable(true);
n = notice(present.repo);
rmSync(present.box, { recursive: true, force: true });
assert.equal(n.status, 0, n.out);
assert.doesNotMatch(n.out, /notice:/, 'a stable channel that has dist/install.sh stays quiet');

const bare = mkdtempSync(join(tmpdir(), 'tess-stable-noref-'));
try {
  execFileSync('git', ['init', '-q', bare]);
  n = notice(bare);
  assert.equal(n.status, 0, n.out);
  assert.equal(n.out.trim(), '', 'no origin/stable means no notice');
} finally {
  rmSync(bare, { recursive: true, force: true });
}

console.log('forwarder gate tests passed');
