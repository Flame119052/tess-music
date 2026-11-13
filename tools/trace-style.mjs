// Who keeps invalidating style and paint? Traces N seconds with stacks and counts the JS location (or CSS
// animation) behind every style recalculation and paint invalidation. Usage: node tools/trace-style.mjs [seconds]
const secs = Number(process.argv[2] || 5);
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('xpui'));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pending = new Map(); const events = []; let done;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Tracing.dataCollected') events.push(...m.params.value); if (m.method === 'Tracing.tracingComplete') done(); pending.get(m.id)?.(m); pending.delete(m.id); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReportEvents' });
await new Promise((r) => setTimeout(r, secs * 1000));
const fin = new Promise((r) => (done = r)); await send('Tracing.end'); await fin;
const agg = new Map();
for (const e of events) {
  if (!/ScheduleStyleRecalculation|StyleRecalcInvalidationTracking|StyleInvalidatorInvalidationTracking|PaintInvalidationTracking|InvalidateLayout|Animation/.test(e.name)) continue;
  const a = e.args?.data || {};
  const st = a.stackTrace || e.args?.beginData?.stackTrace;
  const top = st?.[0] ? `${st[0].functionName || '(anon)'} ${String(st[0].url).split('/').pop() || 'tess'}:${st[0].lineNumber}` : (a.reason || a.nodeName || a.name || '');
  const k = `${e.name} | ${top} | ${a.reason || ''} ${a.nodeName ? '<' + a.nodeName + '>' : ''}`.slice(0, 170);
  agg.set(k, (agg.get(k) || 0) + 1);
}
for (const [k, n] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(n).padStart(6), k);
process.exit(0);
