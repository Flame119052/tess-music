// A/B a CSS change live: measures style recalcs, layouts and main-thread task time for N seconds without it, then
// with it injected, then removes it. Usage: node tools/ab.mjs "<css>" [seconds]
const [css, s = '4'] = process.argv.slice(2); const secs = Number(s);
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('xpui'));
const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true });
await send('Performance.enable');
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));
async function window_() { const a = await metrics(); await new Promise((r) => setTimeout(r, secs * 1000)); const b = await metrics();
  const per = (k) => (b[k] - a[k]) / secs; return { styles: +per('RecalcStyleCount').toFixed(1), layouts: +per('LayoutCount').toFixed(1), taskMs: +(per('TaskDuration') * 1000).toFixed(1), styleMs: +(per('RecalcStyleDuration') * 1000).toFixed(1), scriptMs: +(per('ScriptDuration') * 1000).toFixed(1) }; }
// alternate without/with three times and average, so a one-off (a lyric line changing, a page update) can't decide it
const on = () => ev(`(() => { const s = document.createElement('style'); s.id = 'tess-ab'; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`);
const off = () => ev(`document.getElementById('tess-ab')?.remove()`);
const runs = { before: [], after: [] };
for (let i = 0; i < 3; i++) {
  await off(); await new Promise((r) => setTimeout(r, 500)); runs.before.push(await window_());
  await on(); await new Promise((r) => setTimeout(r, 500)); runs.after.push(await window_());
}
await off();
const avg = (xs) => Object.fromEntries(Object.keys(xs[0]).map((k) => [k, +(xs.reduce((s, x) => s + x[k], 0) / xs.length).toFixed(1)]));
const B = avg(runs.before), A = avg(runs.after);
console.log(JSON.stringify({ before: B, after: A, taskMsSaved: +(B.taskMs - A.taskMs).toFixed(1), spread: runs.before.map((r) => r.taskMs).concat(['|'], runs.after.map((r) => r.taskMs)) }));
process.exit(0);
