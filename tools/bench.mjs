// Performance benchmark for the hill climb (#35). Same scenario every run, so runs can be compared.
// Usage: node tools/bench.mjs [label]        (Spotify running with --remote-debugging-port=9222, window visible)
// Prints one JSON line and appends it to .build/bench.jsonl.
//
//  memory   physical footprint of every Spotify process (what Activity Monitor shows), total and per kind
//  idle     renderer work per second over 15 s with nothing happening: script, tasks, layouts, style recalcs
//  page     JS heap, DOM nodes, event listeners after the scenario
//  clicks   real mouse clicks (via DevTools input) on a fixed list of targets; for each, the time from the click
//           to the next painted frame (Event Timing), plus every long task (>50 ms) seen during the scenario
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';

const label = process.argv[2] || 'run';
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('xpui'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function memory() {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .filter((l) => /Spotify\.app\/Contents/.test(l) && !/grep/.test(l));
  const kinds = {}; let total = 0;
  for (const l of out) {
    const pid = l.trim().split(/\s+/)[0];
    const cmd = l.slice(l.indexOf(pid) + pid.length);
    let mb = 0;
    try {
      const f = execFileSync('footprint', ['-p', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = f.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/);
      if (m) mb = Number(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]]);
    } catch {}
    const kind = /--type=renderer/.test(cmd) ? 'renderer' : /--type=gpu-process/.test(cmd) ? 'gpu' : /network/.test(cmd) ? 'network'
      : /--type=/.test(cmd) ? 'other' : 'main';
    kinds[kind] = +((kinds[kind] || 0) + mb).toFixed(1);
    total += mb;
  }
  return { totalMB: +total.toFixed(1), ...kinds };
}

await send('Performance.enable');
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]));

// --- clicks ---------------------------------------------------------------------------------------------------
await evaluate(`(() => {
  window.__bench = { events: [], long: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) __bench.events.push({ name: e.name, d: e.duration, t: e.startTime }); })
    .observe({ type: 'event', durationThreshold: 16, buffered: false });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) __bench.long.push(e.duration); }).observe({ type: 'longtask' });
  return 1;
})()`);
const center = async (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
async function click(sel) {
  const p = await center(sel);
  if (!p) return null;
  const before = await evaluate('__bench.events.length');
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], button: 'left', clickCount: 1 });
  await sleep(1500);
  return evaluate(`Math.max(0, ...__bench.events.slice(${before}).filter((e) => /click|pointer|mouse/.test(e.name)).map((e) => e.d))`);
}
const go = (path) => evaluate(`Spicetify.Platform.History.push(${JSON.stringify(path)}), 1`);
const SCENARIO = [
  ['open player', '#tess-bar .tb-art'],
  ['player: queue', '#tess-np .tn-q'],
  ['player: lyrics', '#tess-np .tn-lyr'],
  ['close player', '#tess-np .tn-pill.tl button'],
  ['nav: home', '[data-testid="home-button"], .tess-home-button, button[aria-label="Home"]'],
  ['account menu', '[data-testid="user-widget-link"]'],
  ['menu: settings', '.tess-account-menu a[href="/preferences"], .tess-account-menu li:has(a[href*="preferences"]) a'],
  ['library item', '#Desktop_LeftSidebar_Id [role="row"]:nth-of-type(3), #Desktop_LeftSidebar_Id li:nth-of-type(3)'],
];
await go('/');
await sleep(2500);
const clicks = {};
for (const [name, sel] of SCENARIO) clicks[name] = await click(sel);
await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1');
const longTasks = await evaluate('__bench.long');

// --- idle ---------------------------------------------------------------------------------------------------------
await go('/');
await sleep(3000);
await send('HeapProfiler.collectGarbage');
const a = await metrics();
await sleep(15000);
const b = await metrics();
const per = (k) => +(((b[k] - a[k]) / 15)).toFixed(3);

const result = {
  label,
  at: new Date().toISOString(),
  playing: await evaluate('Spicetify.Player.isPlaying()'),
  visible: await evaluate('document.visibilityState'),
  memory: memory(),
  idle: { scriptMsPerSec: +(per('ScriptDuration') * 1000).toFixed(2), taskMsPerSec: +(per('TaskDuration') * 1000).toFixed(2), layoutsPerSec: per('LayoutCount'), stylesPerSec: per('RecalcStyleCount') },
  page: { heapMB: +(b.JSHeapUsedSize / 1048576).toFixed(1), heapTotalMB: +(b.JSHeapTotalSize / 1048576).toFixed(1), nodes: b.Nodes, listeners: b.JSEventListeners, documents: b.Documents },
  clicksMs: Object.fromEntries(Object.entries(clicks).map(([k, v]) => [k, v == null ? null : Math.round(v)])),
  longTasks: { count: longTasks.length, maxMs: Math.round(Math.max(0, ...longTasks)), totalMs: Math.round(longTasks.reduce((x, y) => x + y, 0)) },
};
console.log(JSON.stringify(result));
mkdirSync(new URL('../.build/', import.meta.url), { recursive: true });
appendFileSync(new URL('../.build/bench.jsonl', import.meta.url), JSON.stringify(result) + '\n');
ws.close();
process.exit(0);
