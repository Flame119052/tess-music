// Real mouse clicks / typing into the running Spotify over DevTools, for checks that need true user input
// (dropdowns, right-click menus). Coordinates are CSS pixels.
// Usage: node tools/cdp-input.mjs click X Y | rclick X Y | type "text" | key Escape
const [cmd, a, b] = process.argv.slice(2);
const targets = await (await fetch('http://[::1]:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('xpui'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
if (cmd === 'click' || cmd === 'rclick') {
  const button = cmd === 'click' ? 'left' : 'right';
  const x = Number(a), y = Number(b);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
} else if (cmd === 'type') {
  await send('Input.insertText', { text: a });
} else if (cmd === 'key') {
  const code = { Escape: 27, Enter: 13 }[a] || 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: a, code: a, windowsVirtualKeyCode: code });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: a, code: a, windowsVirtualKeyCode: code });
}
console.log('ok');
ws.close();
process.exit(0);
