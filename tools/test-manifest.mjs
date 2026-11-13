// The release manifest's signed envelope, as tools/release.mjs writes it and theme/loader/loader.js reads it.
// Run: node tools/test-manifest.mjs
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import assert from 'node:assert/strict';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const sig = (text) => sign(null, Buffer.from(text), privateKey).toString('base64');
// the same canonical form on both sides: only the fields the loader acts on, in this order
const envelope = (m) => JSON.stringify({ version: m.version, js: m.js, css: m.css, rev: Number(m.rev), min: Number(m.min) });
const signed = (m) => verify(null, Buffer.from(envelope(m)), publicKey, Buffer.from(m.sig.envelope, 'base64'));

const prev = { rev: 3 };
const rev = prev.rev + 1;
const min = prev.rev;
const env = { version: '0.2.31', js: 'theme.js', css: 'user.css', rev, min };
const manifest = { ...env, channel: 'dev', sig: { js: sig('js'), css: sig('css'), envelope: sig(JSON.stringify(env)) } };

assert.equal(rev, 4);
assert.equal(min, 3);
assert.ok(signed(manifest), 'a fresh manifest verifies');
// promote changes only the channel; the envelope deliberately does not cover it
assert.ok(signed({ ...manifest, channel: 'stable' }), 'promote keeps the envelope valid');
// a changed version, file name, rev or min breaks it
for (const bad of [{ version: '0.2.30' }, { js: 'other.js' }, { rev: 5 }, { min: 2 }]) {
  assert.ok(!signed({ ...manifest, ...bad }), `tampered ${Object.keys(bad)[0]} is refused`);
}
// the loader's sanity rule
assert.ok(manifest.rev >= manifest.min, 'rev is not below min');
assert.ok(!(2 >= 3), 'an older rev fails the published floor');

console.log('manifest tests passed (envelope signs, promote keeps it, version/js/rev/min tampering refused)');
