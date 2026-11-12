// Record a rendering trace of the running Spotify for N seconds; print where main-thread time goes.
// Usage: node tools/trace.mjs [seconds]
const secs = Number(process.argv[2] || 4);
const { webSocketDebuggerUrl } = await (await fetch('http://[::1]:9222/json/version')).json();
const ws = new WebSocket(webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const events = [];
let done;
const finished = new Promise((r) => (done = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Tracing.dataCollected') events.push(...m.params.value);
  if (m.method === 'Tracing.tracingComplete') done();
  pending.get(m.id)?.(m); pending.delete(m.id);
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
await new Promise((r) => setTimeout(r, secs * 1000));
await send('Tracing.end');
await finished;
const tot = {};
const recalcInit = {};
for (const ev of events) {
  if (ev.ph !== 'X' || !ev.dur) continue;
  tot[ev.name] = (tot[ev.name] || 0) + ev.dur;
}
for (const ev of events) {
  if (ev.name === 'ScheduleStyleRecalculation' || ev.name === 'InvalidateLayout') {
    const f = ev.args?.data?.stackTrace?.[0];
    const k = ev.name + ' ← ' + (f ? `${f.functionName}@${(f.url || '').split('/').pop()}:${f.lineNumber}` : '?');
    recalcInit[k] = (recalcInit[k] || 0) + 1;
  }
}
console.log('main-thread ms per second:');
for (const [k, v] of Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(String((v / 1000 / secs).toFixed(1)).padStart(7), k);
console.log('\nwho asks for style/layout work (count over the trace):');
for (const [k, v] of Object.entries(recalcInit).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(String(v).padStart(5), k);
ws.close(); process.exit(0);
