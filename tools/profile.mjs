// CPU-profile the running Spotify page for N seconds and print the functions using the most time.
// Usage: node tools/profile.mjs [seconds]
const secs = Number(process.argv[2] || 5);
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('xpui'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 200 });
await send('Profiler.start');
await new Promise((r) => setTimeout(r, secs * 1000));
const { result } = await send('Profiler.stop');
const p = result.profile;
const dt = {};
const total = p.timeDeltas.reduce((a, b) => a + b, 0);
const byId = new Map(p.nodes.map((n) => [n.id, n]));
p.samples.forEach((sid, i) => { dt[sid] = (dt[sid] || 0) + (p.timeDeltas[i] || 0); });
const self = new Map();
for (const [sid, t] of Object.entries(dt)) {
  const n = byId.get(Number(sid));
  const f = n.callFrame;
  const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`;
  self.set(key, (self.get(key) || 0) + t);
}
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
console.log('total ms', Math.round(total / 1000));
for (const [k, t] of rows) console.log(String(Math.round(t / 1000)).padStart(6), 'ms ', k);
ws.close(); process.exit(0);
