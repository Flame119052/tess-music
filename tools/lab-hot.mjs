// Load current theme files + home redesign into running Spotify Lab window (port 9223).
// Usage: node tools/lab-hot.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(root + 'theme/Tess/user.css', 'utf8');
const homeCss = existsSync(root + 'theme/Tess/home.css') ? readFileSync(root + 'theme/Tess/home.css', 'utf8') : '';
const js = readFileSync(root + 'theme/Tess/theme.js', 'utf8');
const homeJs = existsSync(root + 'theme/Tess/home.js') ? readFileSync(root + 'theme/Tess/home.js', 'utf8') : '';

const combinedCss = css + '\n' + homeCss;
const expr = `(() => {
  document.querySelectorAll('link.userCSS').forEach((l) => { if (/user\\.css$/.test(l.href)) l.disabled = true; });
  let style = document.getElementById('tess-hot-css');
  if (!style) { style = document.createElement('style'); style.id = 'tess-hot-css'; document.head.appendChild(style); }
  style.textContent = ${JSON.stringify(combinedCss)};
  if (!window.__tess) document.querySelectorAll('#tess-bar, #tess-np').forEach((n) => n.remove());
  (0, eval)(${JSON.stringify(js)});
  ${homeJs ? `(0, eval)(${JSON.stringify(homeJs)});` : ''}
  return 'hot-loaded';
})()`;

console.log(execFileSync('node', [root + 'tools/lab-cdp.mjs', 'eval', expr], { encoding: 'utf8' }).trim());
