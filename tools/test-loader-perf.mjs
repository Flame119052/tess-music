// What the loader's cache check costs at Spotify start: one Ed25519 verify of the JS and one of the CSS.
// Run: node tools/test-loader-perf.mjs        (budget: ≤5 ms for both, from the #72 plan)
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const js = readFileSync(`${root}theme/Tess/theme.js`);
const css = readFileSync(`${root}theme/Tess/user.css`);
const keys = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const sig = async (bytes) => webcrypto.subtle.sign('Ed25519', keys.privateKey, bytes);
const sigJs = await sig(js);
const sigCss = await sig(css);
const runs = 200;
const times = [];
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  const ok = (await webcrypto.subtle.verify('Ed25519', keys.publicKey, sigJs, js)) &&
    (await webcrypto.subtle.verify('Ed25519', keys.publicKey, sigCss, css));
  if (!ok) throw new Error('verify failed');
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const mean = times.reduce((a, b) => a + b, 0) / runs;
const p95 = times[Math.floor(runs * 0.95)];
console.log(`loader verify: ${(js.length + css.length) / 1024 | 0} KB, ${runs} runs, mean ${mean.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${times.at(-1).toFixed(2)} ms`);
if (p95 > 5) { console.error('over the 5 ms budget'); process.exit(1); }
console.log('perf budget met (≤5 ms for both verifies)');
