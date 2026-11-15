// Read the health reports Tess Macs send to the inbox. Only works with the owner's Cloudflare login (wrangler login).
//   node tools/reports.mjs                 latest 40 reports, one line each
//   node tools/reports.mjs problems        only problems, failed installs and rescue runs
//   node tools/reports.mjs mac <id>        every report from one Mac
//   node tools/reports.mjs show <n>        the full report number n
//   node tools/reports.mjs macs            each Mac's latest status
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [cmd = 'latest', arg] = process.argv.slice(2);
const q = (sql) => JSON.parse(execFileSync('npx', ['-y', 'wrangler@4', 'd1', 'execute', 'tess-inbox', '--remote', '--json', '--command', sql],
  { cwd: fileURLToPath(new URL('../inbox/', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
const hex = (v) => { if (!/^[0-9a-f]{32}$/.test(v || '')) { console.error('install ids are 32 hex characters'); process.exit(1); } return v; };
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
// The inbox strips these on write, but a row stored before that fix is still in the database: a bidi override in a
// report could otherwise reorder the line this prints, so the reading side does not trust what it finds either.
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '');
const line = (r) => `${String(r.id).padStart(5)}  ${when(r.at)}  ${r.install.slice(0, 8)}  ${r.kind.padEnd(9)}  tess ${clean(r.tess) || '?'}  spotify ${clean(r.spotify) || '?'}  macOS ${clean(r.macos) || '?'}  ${clean(r.status)}`;
const cols = 'id, at, install, kind, tess, spotify, macos, status';

if (cmd === 'show') {
  const [r] = q(`SELECT * FROM reports WHERE id = ${Number(arg) | 0}`);
  if (!r) { console.log('no such report'); process.exit(0); }
  console.log(line(r), `\ninstall id ${r.install}\n\n${clean(r.body)}`);
} else if (cmd === 'mac') {
  q(`SELECT ${cols} FROM reports WHERE install = '${hex(arg)}' ORDER BY at DESC LIMIT 100`).forEach((r) => console.log(line(r)));
} else if (cmd === 'macs') {
  q(`SELECT ${cols}, MAX(at) AS at FROM reports GROUP BY install ORDER BY at DESC`).forEach((r) => console.log(line(r)));
} else if (cmd === 'problems') {
  q(`SELECT ${cols} FROM reports WHERE kind IN ('problem', 'install', 'rescue') ORDER BY at DESC LIMIT 60`).forEach((r) => console.log(line(r)));
} else {
  q(`SELECT ${cols} FROM reports ORDER BY at DESC LIMIT 40`).forEach((r) => console.log(line(r)));
}
