// Drive the running Spotify app over the Chrome DevTools Protocol.
// Usage: node tools/cdp.mjs eval '<js expression>'   |   node tools/cdp.mjs shot out.png
const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('xpui')) || targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  const v = r.result?.result?.value ?? r.result?.exceptionDetails ?? r.result;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
} else if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
  console.log('saved', arg);
}
ws.close(); process.exit(0);
