// The install line's chain, in a sandbox: it fetches the verifier from main, checks the pin in installer/install.sh,
// verifies the channel installer's signature, and only then runs it. A channel with no signed installer refuses.
// No network beyond 127.0.0.1. Run: node tools/test-install-line.mjs
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
writeFileSync(join(verifyDir, sha), verifierText);
const installer = '#!/bin/sh\necho installer-ran > "$TESS_TEST_MARKER"\n[ -x "$TESS_VERIFY" ] && echo verifier-ok >> "$TESS_TEST_MARKER"\nexit 0\n';
writeFileSync(join(dist, 'components.txt'), 'version 0.2.22\n');
writeFileSync(join(dist, 'install.sh'), installer);
writeFileSync(join(dist, 'install.sig'), 'good\n');

let serverStatus = 0;
// normal | skew-once | skew-always | api-down | api-missing
// skew: the first contents-API signature is from the previous release. raw stays poisoned so a
// raw fallback cannot look like a recovered install.
let mode = 'normal';
const hits = { apiSh: 0, apiSig: 0, rawSh: 0, rawSig: 0 };
const resetHits = () => { hits.apiSh = hits.apiSig = hits.rawSh = hits.rawSig = 0; };
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const path = u.pathname;
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/octet-stream' });
    res.end(body ?? '');
  };
  const sendFile = (rel) => {
    const file = join(www, rel);
    if (!existsSync(file)) { send(404); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };
  if (path.endsWith('/dist/install.sh') || path.endsWith('/dist/install.sig')) {
    const api = path.includes('/contents/');
    const sig = path.endsWith('/dist/install.sig');
    if (api) { if (sig) hits.apiSig++; else hits.apiSh++; }
    else if (sig) hits.rawSig++; else hits.rawSh++;
    if (!sig && serverStatus) { send(serverStatus); return; }
    if (api && mode === 'api-down') { send(503); return; }
    if (api && mode === 'api-missing') { send(404); return; }
    if (api && sig && mode === 'skew-always') { send(200, 'stale\n'); return; }
    if (api && sig && mode === 'skew-once' && hits.apiSig === 1) { send(200, 'stale\n'); return; }
    if (!api && sig && (mode === 'skew-once' || mode === 'skew-always')) { send(200, 'raw-poison\n'); return; }
    const rel = api
      ? `${u.searchParams.get('ref')}/dist/${sig ? 'install.sig' : 'install.sh'}`
      : path.replace(/^\//, '');
    sendFile(rel);
    return;
  }
  sendFile(path.replace(/^\//, ''));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const env = {
  ...process.env,
  TESS_TEST: '1',
  TESS_TEST_BASE: base,
  TESS_TEST_API: `${base}/repos/Flame119052/tess-music`,
  TESS_VERIFY_SHA: sha,
  TESS_CHANNEL: 'stable',
};
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

  // 4. a channel with no signed installer refuses; there is no fallback to main
  rmSync(join(dist, 'install.sh'), { force: true });
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'a channel with no installer exits non-zero');
  assert.equal(outcome(), '', 'nothing ran without a channel installer');
  assert.match(r.stdout, /no signed installer ready/, 'the refusal is explained');

  // 4b. a newer channel with a rev and no installer refuses the same way
  writeFileSync(join(dist, 'components.txt'), 'version 0.2.99\nrev 5\n');
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'a newer channel with no installer exits non-zero');
  assert.equal(outcome(), '', 'nothing ran on a newer channel without an installer');
  assert.match(r.stdout, /no signed installer ready/, 'the refusal is explained');

  // 4c. any status other than 200/404 is an error
  writeFileSync(join(dist, 'install.sh'), installer);
  serverStatus = 503;
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'a 503 exits non-zero');
  assert.equal(outcome(), '', 'nothing ran after a 503');
  assert.match(r.stdout, /HTTP 503/, 'the HTTP status is named');
  serverStatus = 0;

  // 5. an installer with no signature on the channel is refused
  rmSync(join(dist, 'install.sig'), { force: true });
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'a missing signature exits non-zero');
  assert.equal(outcome(), '', 'nothing ran without a signature');

  // 6. a live contents-API pair is used even when the raw files are from two releases
  writeFileSync(join(dist, 'install.sig'), 'good\n');
  mode = 'skew-once';
  resetHits();
  rmSync(marker, { force: true });
  r = await run();
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(outcome(), /installer-ran/, 'a mixed pair is fetched again and the install runs');
  assert.equal(hits.apiSig, 2, 'the signature miss fetches the pair once more');
  assert.equal(hits.rawSh, 0, 'the retry stays on the contents API');

  // 7. a pair that stays mixed fails only after that one retry, and still runs nothing
  mode = 'skew-always';
  resetHits();
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'a pair that stays mixed exits non-zero');
  assert.equal(outcome(), '', 'a pair that stays mixed runs nothing');
  assert.equal(hits.apiSig, 2, 'a bad signature is tried once more and then stops');
  assert.equal(hits.rawSh, 0, 'a live API answer is not replaced with raw');
  assert.match(r.stdout, /signature check/, 'the refusal names the signature');

  // 8. the contents API being down uses the raw pair, both files from that one place
  mode = 'api-down';
  resetHits();
  rmSync(marker, { force: true });
  r = await run();
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(outcome(), /installer-ran/, 'an API outage still installs from the raw pair');
  assert.ok(hits.apiSh >= 1, 'the contents API is tried first');
  assert.equal(hits.rawSh, 1, 'one raw installer download covers the outage');
  assert.equal(hits.rawSig, 1, 'the signature comes from raw with the installer');

  // 9. a live 404 is the channel having no installer, not a reason to run a cached raw copy
  mode = 'api-missing';
  resetHits();
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'a live 404 exits non-zero');
  assert.equal(outcome(), '', 'a live 404 runs nothing');
  assert.match(r.stdout, /no signed installer ready/, 'the refusal is explained');
  assert.equal(hits.rawSh, 0, 'a cached raw installer is not run after a live 404');
  mode = 'normal';

  // ...and a broken network runs nothing
  await new Promise((r2) => server.close(r2));
  rmSync(marker, { force: true });
  r = await run();
  assert.notEqual(r.status, 0, 'network failure exits non-zero');
  assert.equal(outcome(), '', 'network failure runs nothing');

  console.log('install-line tests passed (pin, signature, tamper, missing signature, no-installer refusal, 503, mixed pair retry, API outage, live 404, network failure)');
} finally {
  await new Promise((r) => server.close(r));
  rmSync(box, { recursive: true, force: true });
}
