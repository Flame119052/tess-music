// memory + idle only (same method as bench.mjs)
import { execFileSync } from 'node:child_process';
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('xpui'));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Performance.enable');
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));
await send('HeapProfiler.collectGarbage'); await sleep(3000);
const a = await metrics(); await sleep(15000); const b = await metrics();
const per = (k) => +(((b[k] - a[k]) / 15)).toFixed(2);
let tot = 0; const kinds = {};
for (const l of execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => /Spotify\.app\/Contents/.test(l))) {
  const pid = l.trim().split(/\s+/)[0]; let mb = 0;
  try { const m = execFileSync('footprint', ['-p', pid], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/); if (m) mb = Number(m[1]) * ({ KB: 1/1024, MB: 1, GB: 1024 }[m[2]]); } catch {}
  const k = /renderer/.test(l) ? 'renderer' : /gpu-process/.test(l) ? 'gpu' : /--type=/.test(l) ? 'other' : 'main'; kinds[k] = Math.round((kinds[k] || 0) + mb); tot += mb;
}
console.log(JSON.stringify({ totalMB: Math.round(tot), ...kinds, heapMB: +(b.JSHeapUsedSize/1048576).toFixed(1), nodes: b.Nodes, listeners: b.JSEventListeners, taskMsPerSec: +(per('TaskDuration')*1000).toFixed(1), scriptMsPerSec: +(per('ScriptDuration')*1000).toFixed(1), stylesPerSec: per('RecalcStyleCount'), layoutsPerSec: per('LayoutCount') }));
process.exit(0);
