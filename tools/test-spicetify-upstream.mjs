// The vendored Spicetify 2.46.4 files match that upstream archive. The script checks the pinned
// SHA-256 before it diffs, and nothing in the release runs it. Run: node tools/test-spicetify-upstream.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'tools/check-spicetify-upstream.sh');
const pin = 'd217bcf3b780136d66dee9b3548b3689f6004263a958c57d96ad73d7f6fcdd5b';
const url = 'https://github.com/spicetify/cli/releases/download/v2.46.4/spicetify-2.46.4-darwin-arm64.tar.gz';
const prebuilt = join(root, 'patcher/prebuilt/spicetify-2.46.4');

assert.equal(existsSync(script), true, 'the maintainer script exists');
const body = readFileSync(script, 'utf8');
assert.match(body, new RegExp(pin), 'the script pins the v2.46.4 archive SHA-256');
for (const rel of ['tools/release.mjs', '.github/workflows/release.yml']) {
  const text = readFileSync(join(root, rel), 'utf8');
  assert.doesNotMatch(text, /check-spicetify-upstream/, `${rel} does not run the upstream check`);
  assert.doesNotMatch(text, /spicetify-2\.46\.4-darwin/, `${rel} does not download the Spicetify archive`);
}

const box = mkdtempSync(join(tmpdir(), 'tess-spice-'));
const run = (env) => {
  try {
    const out = execFileSync('sh', [script], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};

try {
  const bad = join(box, 'bad.tar.gz');
  writeFileSync(bad, 'not the spicetify archive\n');
  let r = run({ TESS_SPICETIFY_TARBALL: bad, TESS_SPICETIFY_PREBUILT: prebuilt });
  assert.notEqual(r.status, 0, 'a tarball with the wrong SHA-256 exits non-zero');
  assert.match(r.out, new RegExp(pin), 'the refusal names the pinned SHA-256');
  assert.doesNotMatch(r.out, /does not match the upstream archive/, 'a bad checksum is refused before the diff');

  const tarball = join(box, 'spicetify-2.46.4-darwin-arm64.tar.gz');
  execFileSync('curl', ['-fsSL', '--max-time', '120', '-o', tarball, url], { stdio: 'ignore' });
  const got = execFileSync('shasum', ['-a', '256', tarball], { encoding: 'utf8' }).split(/\s+/)[0];
  assert.equal(got, pin, 'the downloaded archive is the pinned v2.46.4 tarball');

  r = run({ TESS_SPICETIFY_TARBALL: tarball, TESS_SPICETIFY_PREBUILT: prebuilt });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /matches the upstream archive/, 'the committed tree matches upstream');

  const changed = join(box, 'changed');
  cpSync(prebuilt, changed, { recursive: true });
  writeFileSync(join(changed, 'css-map.json'), `${readFileSync(join(changed, 'css-map.json'), 'utf8')}\n`);
  r = run({ TESS_SPICETIFY_TARBALL: tarball, TESS_SPICETIFY_PREBUILT: changed });
  assert.notEqual(r.status, 0, 'a changed vendored file exits non-zero');
  assert.match(r.out, /css-map\.json/, 'the refusal names the file that differs');
  assert.match(r.out, /does not match the upstream archive/, 'the refusal is a diff, not a checksum miss');

  console.log('spicetify upstream tests passed (pin, committed tree, changed file, release path)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
