// The loader's trust rules, in a fake Spotify: signed envelope, per-channel rev floor, verified cache, last-good
// fallback, and the legacy (pre-envelope) manifest. Run: node tools/test-loader.mjs
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(fileURLToPath(new URL('../theme/loader/loader.js', import.meta.url)), 'utf8');
const enc = new TextEncoder();
const keys = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', keys.publicKey)).toString('base64');
const sig = async (text) => Buffer.from(await webcrypto.subtle.sign('Ed25519', keys.privateKey, enc.encode(text))).toString('base64');
const sha = async (text) => [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

const release = async (rev, version, { ready = true } = {}) => {
  const js = ready
    ? `window.__tessReady = true; (window.__ran = window.__ran || []).push('${version}');`
    : `// __tessReady stays false\n(window.__ran = window.__ran || []).push('${version}-broken');`;
  const css = `/* ${version} */`;
  const env = { version, js: 'theme.js', css: 'user.css', jsSha: await sha(js), cssSha: await sha(css), rev };
  const envText = JSON.stringify(env);
  return {
    manifest: { ...env, channel: 'stable', sig: { js: await sig(js), css: await sig(css), envelope: await sig(envText) } },
    files: { 'theme.js': js, 'user.css': css },
    envText,
  };
};
const legacy = async (version, { ready = true } = {}) => {
  const js = ready
    ? `window.__tessReady = true; (window.__ran = window.__ran || []).push('${version}');`
    : `// __tessReady stays false\n(window.__ran = window.__ran || []).push('${version}-broken');`;
  const css = `/* ${version} */`;
  return { manifest: { version, channel: 'stable', js: 'theme.js', css: 'user.css', sig: { js: await sig(js), css: await sig(css) } }, files: { 'theme.js': js, 'user.css': css } };
};
const bundle = (version, js, sigJs = 'x') => ({ version, channel: 'stable', rev: 0, js, css: '', sigJs, sigCss: sigJs });

async function runLoader({ served, store = {}, channel = 'stable' }) {
  const saved = new Map(Object.entries(store).map(([k, v]) => [k, JSON.stringify(v)]));
  const ctx = vm.createContext({
    console,
    // the loader's 6 s fetch race would also resolve instantly if every timer did: give it real time (crypto is async),
    // while the 500 ms "wait for Spotify" loops are instant
    setTimeout: (fn, ms) => setTimeout(fn, ms >= 1000 ? 100 : 0),
    clearTimeout,
    atob, btoa,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    Blob: class { constructor(parts) { this.text = parts.join(''); } },
    URL: { createObjectURL: (b) => b.text },
    fetch: async (url) => {
      const path = url.includes('/dist/') ? url.split('/dist/')[1].split('?')[0] : '';
      const text = path === 'manifest.json' ? served.manifestText : served.files[path];
      return text == null ? { ok: false } : { ok: true, text: async () => text };
    },
    localStorage: {
      getItem: (k) => (saved.has(k) ? saved.get(k) : null),
      setItem: (k, v) => saved.set(k, String(v)),
      removeItem: (k) => saved.delete(k),
    },
    document: {
      getElementById: () => null,
      querySelector: (sel) => (String(sel).includes('now-playing-bar') ? {} : null),
      querySelectorAll: () => [],
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    window: { Spicetify: { Player: { data: {} } } },
  });
  // the loader's script tag runs the bundle; in the test the "blob" is the script text
  ctx.document.createElement = (tag) => {
    if (tag !== 'script') return {};
    let value;
    return { get src() { return value; }, set src(v) { value = v; } };
  };
  ctx.document.head = { appendChild: (el) => { if (el && el.src !== undefined) vm.runInContext(el.src, ctx); } };
  const code = source.replace('__TESS_PUBLIC_KEY__', pub);
  await vm.runInContext(code, ctx);
  return { ran: Array.from(ctx.window.__ran || []), saved };
}

const serve = async (rel) => ({ manifestText: JSON.stringify(rel.manifest), files: rel.files });
const floor = (saved, channel = 'stable') => JSON.parse(saved.get(`tess:rev:${channel}`) || 'null');

// 1. a fresh signed release runs and is remembered
let r = await runLoader({ served: await serve(await release(3, 'v3')) });
assert.deepEqual(r.ran, ['v3'], 'the newest signed release runs');
assert.equal(floor(r.saved), 3, 'the rev floor moves up');

// 2. a correctly signed older release is refused for a Mac that has seen a newer one
r = await runLoader({ served: await serve(await release(2, 'v2')), store: { 'tess:rev:stable': 3 } });
assert.ok(!r.ran.includes('v2'), 'an older rev is refused');

// 3. a forged cache is not run; the valid download is fetched instead
r = await runLoader({
  served: await serve(await release(3, 'v3')),
  store: { 'tess:bundle': bundle('3.0.0', "window.__ran.push('evil')", 'forged') },
});
assert.deepEqual(r.ran, ['v3'], 'a forged tess:bundle is ignored');

// 4. a tampered envelope is refused
const bad = await release(4, 'v4');
bad.manifest.sig.envelope = await sig('not the manifest');
r = await runLoader({ served: await serve(bad) });
assert.ok(!r.ran.includes('v4'), 'a bad envelope is refused');

// 4b. a mirror pairs a fresh envelope with older, genuinely signed files
const newer = await release(5, 'v5');
const older = await release(3, 'old');
newer.files = { ...older.files };
newer.manifest.sig.js = older.manifest.sig.js;
newer.manifest.sig.css = older.manifest.sig.css;
r = await runLoader({ served: await serve(newer) });
assert.ok(!r.ran.includes('old') && !r.ran.includes('v5'), 'old files under a new envelope are refused');

// 4c. a rev-tagged cache without its envelope is not run
r = await runLoader({
  served: await serve(await release(5, 'v5')),
  store: { 'tess:bundle': { version: 'v5', channel: 'stable', rev: 5, js: older.files['theme.js'], css: older.files['user.css'], sigJs: older.manifest.sig.js, sigCss: older.manifest.sig.css } },
});
assert.ok(!r.ran.includes('old') && r.ran.includes('v5'), 'a relabelled old cache is refetched');

// 5. a legacy manifest (no envelope, no rev) still runs on a Mac that has no rev floor yet
r = await runLoader({ served: await serve(await legacy('legacy')) });
assert.deepEqual(r.ran, ['legacy'], 'a legacy manifest still runs');

// 5b. ...but not once this Mac has run a release with a rev
r = await runLoader({ served: await serve(await legacy('old')), store: { 'tess:rev:stable': 3 } });
assert.ok(!r.ran.includes('old'), 'a pre-rev manifest is refused after a rev floor exists');

// 6. a release that never starts falls back to the last good copy, which is verified first
const good = await release(3, 'good');
const goodBundle = { version: 'good', channel: 'stable', rev: 3, js: good.files['theme.js'], css: good.files['user.css'], sigJs: good.manifest.sig.js, sigCss: good.manifest.sig.css, env: good.envText, sigEnv: good.manifest.sig.envelope };
r = await runLoader({
  served: await serve(await release(4, 'v4-broken', { ready: false })),
  store: { 'tess:good': goodBundle, 'tess:rev:stable': 3 },
});
assert.ok(r.ran.includes('good'), 'the last good copy runs after a broken release');
assert.ok(r.ran.some((x) => String(x).startsWith('v4-broken')), 'the broken release was tried once');

// 7. a forged last-good is not used
r = await runLoader({
  served: await serve(await release(4, 'v4-broken', { ready: false })),
  store: { 'tess:good': bundle('good', "window.__ran.push(' evil')", 'forged') },
});
assert.ok(!r.ran.some((x) => String(x).includes('evil')), 'a forged tess:good is not run');

console.log('loader tests passed (fresh, floor, forged cache, envelope, legacy, last-good, forged good)');
