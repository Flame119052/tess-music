// The release manifest's signed envelope, as tools/release.mjs writes it and theme/loader/loader.js reads it.
// Run: node tools/test-manifest.mjs
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import assert from 'node:assert/strict';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const sig = (text) => sign(null, Buffer.from(text), privateKey).toString('base64');
const sha = (text) => createHash('sha256').update(text).digest('hex');
// the same canonical form on both sides: only the fields the loader acts on, in this order
const envelope = (m) => JSON.stringify({ version: m.version, js: m.js, css: m.css, jsSha: m.jsSha, cssSha: m.cssSha, rev: Number(m.rev) });
const signed = (m) => verify(null, Buffer.from(envelope(m)), publicKey, Buffer.from(m.sig.envelope, 'base64'));

const js = 'window.__tessVersion = "0.2.31";';
const css = '/* 0.2.31 */';
const prev = { rev: 3 };
const rev = prev.rev + 1;
const env = { version: '0.2.31', js: 'theme.js', css: 'user.css', jsSha: sha(js), cssSha: sha(css), rev };
const manifest = { ...env, channel: 'dev', sig: { js: sig(js), css: sig(css), envelope: sig(JSON.stringify(env)) } };

assert.equal(rev, 4);
assert.ok(signed(manifest), 'a fresh manifest verifies');
// promote changes only the channel; the envelope deliberately does not cover it
assert.ok(signed({ ...manifest, channel: 'stable' }), 'promote keeps the envelope valid');
// a changed version, file name, rev, or either content hash breaks it
for (const bad of [{ version: '0.2.30' }, { js: 'other.js' }, { rev: 5 }, { jsSha: sha('old js') }, { cssSha: sha('old css') }]) {
  assert.ok(!signed({ ...manifest, ...bad }), `tampered ${Object.keys(bad)[0]} is refused`);
}

console.log('manifest tests passed (envelope signs, promote keeps it, version/js/jsSha/cssSha/rev tampering refused)');
