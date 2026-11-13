// The install stub's chain, in a sandbox: it downloads a verifier, checks its pinned SHA-256, verifies the installer's
// signature with it, and only then runs the installer. No network beyond 127.0.0.1.
// Run: node tools/test-stub.mjs
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const pexec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const box = mkdtempSync(join(tmpdir(), 'tess-stub-test-'));
const dist = join(box, 'www', 'stable', 'dist');
mkdirSync(dist, { recursive: true });

// A stand-in for tess-verify: accepts only the exact signature text "good". The real one checks Ed25519.
const verifier = join(dist, 'tess-verify');
writeFileSync(verifier, '#!/bin/sh\n[ "$2" = good ] || exit 1\n');
writeFileSync(join(dist, 'install.sh'), '#!/bin/sh\necho installer-ran > "$TESS_TEST_MARKER"\n[ -x "$TESS_VERIFY" ] && echo verifier-ok >> "$TESS_TEST_MARKER"\nexit 0\n');
const sha = createHash('sha256').update(readFileSync(verifier)).digest('hex');
const template = readFileSync(join(root, 'installer/stub.sh'), 'utf8');
const render = (pin) => template.replace('__TESS_VERIFY_SHA__', pin);
writeFileSync(join(dist, 'stub.sh'), render(sha));

const server = createServer((req, res) => {
  const file = join(box, 'www', req.url.split('?')[0]);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, TESS_TEST: '1', TESS_STUB_BASE: base, TESS_CHANNEL: 'stable' };
const marker = join(box, 'ran');
// execFile, not execFileSync: this process is also the HTTP server
const run = async (file, extra = {}) => {
  try {
    const { stdout } = await pexec('sh', [file], { encoding: 'utf8', env: { ...env, TESS_TEST_MARKER: marker, ...extra } });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
};
const outcome = () => (existsSync(marker) ? readFileSync(marker, 'utf8') : '');

try {
  // 1. a good chain runs the installer and hands it the checked verifier
  writeFileSync(join(dist, 'install.sig'), 'good\n');
  let r = await run(join(dist, 'stub.sh'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(outcome(), /installer-ran\nverifier-ok/, 'installer ran with a verifier');

  // 2. a tampered installer fails its signature and nothing runs
  rmSync(marker, { force: true });
  writeFileSync(join(dist, 'install.sig'), 'bad\n');
  r = await run(join(dist, 'stub.sh'));
  assert.notEqual(r.status, 0, 'bad signature exits non-zero');
  assert.equal(outcome(), '', 'nothing ran after a bad signature');

  // 3. a verifier that does not match its pin is refused before it is run
  writeFileSync(join(dist, 'install.sig'), 'good\n');
  writeFileSync(join(dist, 'stub.sh'), render('0'.repeat(64)));
  r = await run(join(dist, 'stub.sh'));
  assert.notEqual(r.status, 0, 'wrong verifier pin exits non-zero');
  assert.equal(outcome(), '', 'nothing ran after a wrong pin');

  // 4. the forwarder hands over to the stub
  writeFileSync(join(dist, 'stub.sh'), render(sha));
  r = await run(join(root, 'installer/install.sh'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(outcome(), /installer-ran/, 'forwarder ran the stub chain');

  // 5. a channel with no stub yet falls back to that channel's own installer
  rmSync(join(box, 'www', 'stable', 'dist', 'stub.sh'), { force: true });
  rmSync(marker, { force: true });
  r = await run(join(root, 'installer/install.sh'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(outcome(), /installer-ran/, 'the channel installer ran');
  assert.match(r.stdout, /isn't on stable yet/, 'the fallback is announced');

  // 6. a channel with neither falls back to main's installer (temporary, #77)
  mkdirSync(join(box, 'www', 'main', 'installer'), { recursive: true });
  writeFileSync(join(box, 'www', 'main', 'installer', 'tess-install.sh'), readFileSync(join(dist, 'install.sh')));
  rmSync(join(box, 'www', 'stable', 'dist', 'install.sh'), { force: true });
  rmSync(marker, { force: true });
  r = await run(join(root, 'installer/install.sh'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(outcome(), /installer-ran/, "main's installer ran as the last resort");
  assert.match(r.stdout, /temporary installer/, 'the temporary fallback is announced');

  // ...and a broken network runs nothing
  await new Promise((r2) => server.close(r2));
  rmSync(marker, { force: true });
  r = await run(join(root, 'installer/install.sh'));
  assert.notEqual(r.status, 0, 'network failure exits non-zero');
  assert.equal(outcome(), '', 'network failure runs nothing');

  console.log('stub tests passed (good chain, tampered installer, wrong pin, forwarder, channel and main fallbacks)');
} finally {
  await new Promise((r) => server.close(r));
  rmSync(box, { recursive: true, force: true });
}
