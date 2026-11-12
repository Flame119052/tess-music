// Renderer cost over a window of time: script time, style/layout work, JS heap, DOM size.
// Usage: node tools/metrics.mjs [seconds]
const secs = Number(process.argv[2] || 20);
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('xpui'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Performance.enable');
const snap = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));
await send('HeapProfiler.collectGarbage');
const a = await snap();
await new Promise((r) => setTimeout(r, secs * 1000));
const b = await snap();
const per = (k) => ((b[k] - a[k]) / secs);
console.log(JSON.stringify({
  scriptMsPerSec: +(per('ScriptDuration') * 1000).toFixed(2),
  taskMsPerSec: +(per('TaskDuration') * 1000).toFixed(2),
  styleRecalcsPerSec: +per('RecalcStyleCount').toFixed(2),
  layoutsPerSec: +per('LayoutCount').toFixed(2),
  jsHeapMB: +(b.JSHeapUsedSize / 1048576).toFixed(1),
  domNodes: b.Nodes,
  layoutObjects: b.LayoutObjects,
}));
ws.close(); process.exit(0);
