// A/B a CSS change by real CPU time used per process (cputime deltas), alternating 3x without/with.
// Usage: node tools/cpu-ab.mjs "<css>" [seconds per window]
import { execFileSync } from 'node:child_process';
const [css = '', s = '5'] = process.argv.slice(2); const secs = Number(s);
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('xpui'));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = (x) => send('Runtime.evaluate', { expression: x });
const t = (x) => { const p = x.split(/[:.]/).map(Number); return p.length === 3 ? p[0] * 60 + p[1] + p[2] / 100 : p[0] * 3600 + p[1] * 60 + p[2] + p[3] / 100; };
const snap = () => { const o = {}; for (const l of execFileSync('ps', ['-axo', 'time=,command='], { encoding: 'utf8' }).split('\n')) { if (!/Spotify\.app/.test(l)) continue; const k = /gpu-process/.test(l) ? 'gpu' : /renderer/.test(l) ? 'renderer' : /--type=/.test(l) ? 'other' : 'main'; o[k] = (o[k] || 0) + t(l.trim().split(/\s+/)[0]); } return o; };
const win = async () => { const a = snap(); await new Promise((r) => setTimeout(r, secs * 1000)); const b = snap(); const o = {}; let tot = 0; for (const k of Object.keys(b)) { o[k] = +(((b[k] - (a[k] || 0)) / secs) * 100).toFixed(1); tot += o[k]; } o.total = +tot.toFixed(1); return o; };
const on = () => ev(`(() => { const s = document.createElement('style'); s.id = 'tess-ab'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`);
const off = () => ev(`document.getElementById('tess-ab')?.remove()`);
const B = [], A = [];
for (let i = 0; i < 3; i++) { await off(); await new Promise((r) => setTimeout(r, 400)); B.push(await win()); if (css) { await on(); await new Promise((r) => setTimeout(r, 400)); A.push(await win()); } }
await off();
const avg = (xs) => xs.length ? Object.fromEntries(Object.keys(xs[0]).map((k) => [k, +(xs.reduce((s, x) => s + (x[k] || 0), 0) / xs.length).toFixed(1)])) : null;
console.log(JSON.stringify({ cpuPercentWithout: avg(B), cpuPercentWith: avg(A) }));
process.exit(0);
