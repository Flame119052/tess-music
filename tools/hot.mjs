// Load the current theme files into the running Spotify window without restarting it.
// Usage: node tools/hot.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

execFileSync('node', [fileURLToPath(new URL('build.mjs', import.meta.url))], { stdio: 'inherit' });

const root = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(root + 'theme/Tess/user.css', 'utf8');
const js = readFileSync(root + 'theme/Tess/theme.js', 'utf8');
const expr = `(() => {
  document.querySelectorAll('link.userCSS').forEach((l) => { if (/user\\.css$/.test(l.href)) l.disabled = true; });
  document.getElementById('tess-css')?.remove();
  let style = document.getElementById('tess-hot-css');
  if (!style) { style = document.createElement('style'); style.id = 'tess-hot-css'; document.head.appendChild(style); }
  style.textContent = ${JSON.stringify(css)};
  if (!window.__tess) document.querySelectorAll('#tess-bar, #tess-np').forEach((n) => n.remove());
  (0, eval)(${JSON.stringify(js)});
  return 'hot-loaded';
})()`;
console.log(execFileSync('node', [root + 'tools/cdp.mjs', 'eval', expr], { encoding: 'utf8' }).trim());
