// What does the page do while idle? Traces N seconds and lists timers, animation-frame callbacks, style/layout work
// and their sources. Usage: node tools/trace-idle.mjs [seconds]
const secs = Number(process.argv[2] || 5);
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('xpui'));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pending = new Map(); const events = []; let done;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); if (m.method === 'Tracing.tracingComplete') done(); pending.get(m.id)?.(m); pending.delete(m.id); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8.execute', transferMode: 'ReportEvents' });
await new Promise((r) => setTimeout(r, secs * 1000));
const fin = new Promise((r) => (done = r)); await send('Tracing.end'); await fin;
const agg = new Map();
const add = (k, dur) => { const v = agg.get(k) || { n: 0, ms: 0 }; v.n++; v.ms += dur / 1000; agg.set(k, v); };
for (const e of events) {
  if (e.ph !== 'X' && e.ph !== 'B') continue;
  const d = e.dur || 0; const a = e.args?.data || {};
  const where = a.url ? `${a.functionName || ''} ${String(a.url).split('/').pop()}:${a.lineNumber}:${a.columnNumber}` : '';
  if (['TimerFire', 'FireAnimationFrame', 'FunctionCall', 'EventDispatch', 'UpdateLayoutTree', 'Layout', 'Paint', 'RunMicrotasks', 'v8.run', 'ParseHTML', 'Animation', 'ScrollLayer', 'UpdateLayer', 'CompositeLayers', 'PrePaint', 'HitTest'].includes(e.name))
    add(`${e.name}${a.type ? '(' + a.type + ')' : ''} ${where}`.trim(), d);
}
const rows = [...agg].sort((x, y) => y[1].ms - x[1].ms).slice(0, 30);
console.log(`idle ${secs}s:`);
for (const [k, v] of rows) console.log(`${v.ms.toFixed(1).padStart(8)} ms  x${String(v.n).padEnd(5)} ${k}`);
process.exit(0);
