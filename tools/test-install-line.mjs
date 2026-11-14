// The install line's chain, in a sandbox: it fetches the verifier from main, checks the pin in installer/install.sh,
// verifies the channel installer's signature, and only then runs it. No network beyond 127.0.0.1.
// Run: node tools/test-install-line.mjs
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
const box = mkdtempSync(join(tmpdir(), 'tess-install-line-'));
const www = join(box, 'www');
const main = join(www, 'main', 'installer');
const dist = join(www, 'stable', 'dist');
const verifyDir = join(main, 'verify');
mkdirSync(verifyDir, { recursive: true });
mkdirSync(dist, { recursive: true });

// A stand-in for the committed tess-verify: accepts only the exact signature text "good". It is stored under its
// own SHA-256, so an older copy of the install line keeps working after the verifier is rebuilt.
const verifierText = '#!/bin/sh\n[ "$2" = good ] || exit 1\n';
const sha = createHash('sha256').update(verifierText).digest('hex');
const verifier = join(verifyDir, sha);
writeFileSync(verifier, verifierText);
const installer = '#!/bin/sh\necho installer-ran > "$TESS_TEST_MARKER"\n[ -x "$TESS_VERIFY" ] && echo verifier-ok >> "$TESS_TEST_MARKER"\nexit 0\n';
writeFileSync(join(dist, 'components.txt'), 'version 0.2.22\n');
writeFileSync(join(dist, 'install.sh'), installer);
writeFileSync(join(dist, 'install.sig'), 'good\n');
writeFileSync(join(main, 'tess-install.sh'), installer);

let serverStatus = 0;
const server = createServer((req, res) => {
  if (serverStatus && req.url.endsWith('/dist/install.sh')) { res.writeHead(serverStatus); res.end(); return; }
  const file = join(www, req.url.split('?')[0]);
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, TESS_TEST: '1', TESS_TEST_BASE: base, TESS_VERIFY_SHA: sha, TESS_CHANNEL: 'stable' };
const marker = join(box, 'ran');
// execFile, not execFileSync: this process is also the HTTP server
const run = async () => {
  try {
    const { stdout } = await pexec('sh', [join(root, 'installer/install.sh')], { encoding: 'utf8', env: { ...env, TESS_TEST_MARKER: marker } });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
};
const outcome = () => (existsSync(marker) ? readFileSync(marker, 'utf8') : '');

try {
  // 1. the pinned verifier checks the channel installer, then the installer runs
  let r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(outcome(), /installer-ran\nverifier-ok/, 'installer ran with the checked verifier');

  // 2. a tampered installer fails its signature and nothing runs
  rmSync(marker, { force: true });
  writeFileSync(join(dist, 'install.sig'), 'bad\n');
  r = await run();
  assert.notEqual(r.status, 0, 'bad signature exits non-zero');
  assert.equal(outcome(), '', 'nothing ran after a bad signature');

  // 3. a verifier that does not match the pin in install.sh is refused before it is run
  writeFileSync(join(dist, 'install.sig'), 'good\n');
  const wrong = { ...env, TESS_VERIFY_SHA: '0'.repeat(64) };
  rmSync(marker, { force: true });
  try {
    await pexec('sh', [join(root, 'installer/install.sh')], { encoding: 'utf8', env: { ...wrong, TESS_TEST_MARKER: marker } });
    assert.fail('a wrong verifier pin must exit non-zero');
  } catch (e) {
    assert.notEqual(e.code ?? 1, 0, 'wrong verifier pin exits non-zero');
  }
  assert.equal(outcome(), '', 'nothing ran after a wrong pin');

  // 4. a channel with no installer yet falls back to main's installer (temporary, #77)
  rmSync(join(dist, 'install.sh'), { force: true });
  rmSync(marker, { force: true });
  r = await run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(outcome(), /installer-ran\nverifier-ok/, "main's installer ran with the checked verifier");
  assert.match(r.stdout, /temporary installer/, 'the temporary fallback is announced');

  // 4b. any status other than 404 is an error, not a fallback to main
  writeFileSync(join(dist, 'install.sh'), installer);
  serverStatus = 503;
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'a 503 exits non-zero');
  assert.equal(outcome(), '', 'nothing ran after a 503');
  assert.match(r.stdout, /HTTP 503/, 'the HTTP status is named');
  serverStatus = 0;

  // 4c. a channel that already has a rev must not fall back when its installer is missing
  writeFileSync(join(dist, 'components.txt'), 'version 0.2.99\nrev 5\n');
  rmSync(join(dist, 'install.sh'), { force: true });
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'a newer channel with no installer fails');
  assert.equal(outcome(), '', 'nothing ran when a newer channel has no installer');
  assert.match(r.stdout, /nothing was installed/, 'the failure is explained');

  // 5. an installer with no signature on the channel is refused (not silently downgraded to main)
  writeFileSync(join(dist, 'install.sh'), installer);
  rmSync(join(dist, 'install.sig'), { force: true });
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'a missing signature exits non-zero');
  assert.equal(outcome(), '', 'nothing ran without a signature');

  // ...and a broken network runs nothing
  await new Promise((r2) => server.close(r2));
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'network failure exits non-zero');
  assert.equal(outcome(), '', 'network failure runs nothing');

  console.log('install-line tests passed (pin, signature, tamper, missing signature, main fallback, network failure)');
} finally {
  await new Promise((r) => server.close(r));
  rmSync(box, { recursive: true, force: true });
}
