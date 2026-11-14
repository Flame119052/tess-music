// Read the health reports Tess Macs send to the inbox. Only works with the owner's Cloudflare login (wrangler login).
//   node tools/reports.mjs                 latest 40 reports, one line each
//   node tools/reports.mjs problems        only problems, failed installs and rescue runs
//   node tools/reports.mjs mac <id>        every report from one Mac
//   node tools/reports.mjs show <n>        the full report number n
//   node tools/reports.mjs macs            each Mac's latest status
//
// Support reports, from the bot people message. These are the ones that become GitHub issues:
//   node tools/reports.mjs support list                 unfiled first, one line each
//   node tools/reports.mjs support show <n>             the person's words, the diagnosis, the finished write-up
//   node tools/reports.mjs support filed <n> --issue <url>   record which issue it became
//   node tools/reports.mjs support tokens               who holds a posting token
//   node tools/reports.mjs support token add <label>    mint one (printed once; only its hash is stored)
//   node tools/reports.mjs support token revoke <label> stop one working
//   node tools/reports.mjs support titles               refresh the open-issue title list the bot checks first
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? '' : String(argv[i + 1] || ''); };
const [cmd = 'latest', arg] = argv;
const q = (sql) => JSON.parse(execFileSync('npx', ['-y', 'wrangler@4', 'd1', 'execute', 'tess-inbox', '--remote', '--json', '--command', sql],
  { cwd: fileURLToPath(new URL('../inbox/', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
const hex = (v) => { if (!/^[0-9a-f]{32}$/.test(v || '')) { console.error('install ids are 32 hex characters'); process.exit(1); } return v; };
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
const line = (r) => `${String(r.id).padStart(5)}  ${when(r.at)}  ${r.install.slice(0, 8)}  ${r.kind.padEnd(9)}  tess ${r.tess || '?'}  spotify ${r.spotify || '?'}  macOS ${r.macos || '?'}  ${r.status || ''}`;
const cols = 'id, at, install, kind, tess, spotify, macos, status';

const sq = (v) => String(v).replace(/'/g, "''");
const PRI = (p) => p || '?';

function support() {
  const sub = argv[1];
  const num = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) { console.error('a support report number is a positive integer'); process.exit(1); } return n; };

  if (sub === 'list') {
    const rows = q(`SELECT id, at, person, priority, areas, kind, title, install, issue FROM support_reports ORDER BY (issue IS NULL) DESC, at DESC LIMIT 60`);
    if (!rows.length) { console.log('no support reports'); return; }
    // Unfiled first: those are the ones waiting on somebody.
    for (const r of rows) {
      console.log(`${String(r.id).padStart(5)}  ${when(r.at)}  ${PRI(r.priority)}  ${(r.areas || '').padEnd(28)}  ${(r.issue ? 'filed' : 'UNFILED').padEnd(7)}  ${r.title}${r.install ? `  [${r.install.slice(0, 8)}]` : ''}`);
    }
    return;
  }

  if (sub === 'show') {
    const n = num(arg);
    const [r] = q(`SELECT * FROM support_reports WHERE id = ${n}`);
    if (!r) { console.log('no such support report'); return; }
    const areas = (r.areas || '').split(/,\s*/).filter(Boolean);
    console.log(`support report ${r.id} · ${when(r.at)} · from ${r.person || '?'}`);
    console.log(`suggested labels: ${[r.priority, ...areas, r.kind].filter(Boolean).join(', ')}`);
    console.log(`tess ${r.tess || '?'} · spotify ${r.spotify || '?'} · macOS ${r.macos || '?'}${r.install ? ` · install ${r.install}` : ''}`);
    console.log(r.issue ? `filed as ${r.issue}` : 'not filed yet');
    // The recording is in R2 and never served back; this is the only place it is named.
    console.log(r.recording ? `recording in R2: ${r.recording} (deleted when filed, or at 14 days)` : 'no recording');
    console.log(`\n--- what they said\n${r.words || '(nothing)'}\n\n--- what the bot worked out\n${r.diagnosis || '(nothing)'}\n\n--- the finished write-up\n${r.body || '(nothing)'}`);
    console.log(`\nfile it with: gh issue create -R Flame119052/tess-music --title ${JSON.stringify(r.title)} ${[r.priority, ...areas, r.kind].filter(Boolean).map((l) => `--label ${JSON.stringify(l)}`).join(' ')} --body-file -`);
    console.log(`then record it: node tools/reports.mjs support filed ${r.id} --issue <url>`);
    return;
  }

  if (sub === 'filed') {
    const n = num(arg);
    const url = flag('issue');
    if (!/^https:\/\/github\.com\/Flame119052\/tess-music\/issues\/\d+$/.test(url)) {
      console.error('--issue must be a github.com/Flame119052/tess-music/issues/<n> url');
      process.exit(1);
    }
    const [r] = q(`SELECT id FROM support_reports WHERE id = ${n}`);
    if (!r) { console.error('no such support report'); process.exit(1); }
    q(`UPDATE support_reports SET issue = '${sq(url)}', filed_at = ${Date.now()} WHERE id = ${n}`);
    console.log(`support report ${n} recorded as ${url}`);
    return;
  }

  if (sub === 'titles') {
    // The bot has no GitHub login, so it gets titles only: enough to spot a duplicate, and nothing that could be a
    // person's words. `gh` uses Krish's own auth here, on his machine.
    const list = JSON.parse(execFileSync('gh', ['issue', 'list', '-R', 'Flame119052/tess-music', '--state', 'open', '--limit', '500', '--json', 'number,title'], { encoding: 'utf8' }));
    const now = Date.now();
    q('DELETE FROM issue_titles');
    if (list.length) {
      const values = list.map((i) => `(${Number(i.number)}, '${sq(i.title)}', ${now})`).join(',');
      q(`INSERT INTO issue_titles (n, title, updated) VALUES ${values}`);
    }
    console.log(`cached ${list.length} open issue titles for the bot`);
    return;
  }

  if (sub === 'tokens') {
    const rows = q(`SELECT id, label, added, revoked FROM support_tokens ORDER BY id`);
    if (!rows.length) { console.log('no support tokens — nothing can post a support report yet'); return; }
    for (const t of rows) console.log(`${t.label}  ${t.revoked ? 'REVOKED' : 'active'}  added ${when(t.added)}`);
    return;
  }

  if (sub === 'token' && ['add', 'revoke'].includes(arg)) {
    const label = argv.slice(3).filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!label) { console.error(`usage: support token ${arg} <label>`); process.exit(1); }
    if (arg === 'revoke') {
      q(`UPDATE support_tokens SET revoked = ${Date.now()} WHERE label = '${sq(label)}' AND revoked IS NULL`);
      console.log(`revoked any active token labelled "${label}" — it stops working on the next request`);
      return;
    }
    // 32 random bytes, printed once. Only the SHA-256 goes to the database, so this output is the only copy.
    const token = 'tess_' + randomBytes(32).toString('hex');
    q(`INSERT INTO support_tokens (label, sha, added) VALUES ('${sq(label)}', '${createHash('sha256').update(token).digest('hex')}', ${Date.now()})`);
    console.log(`token for "${label}":\n\n${token}\n\nIt is shown once and only its hash is stored. Put it on the server that runs the bot.`);
    return;
  }

  console.error('usage: support list | show <n> | filed <n> --issue <url> | tokens | token add <label> | token revoke <label> | titles');
  process.exit(1);
}

if (cmd === 'support') {
  support();
} else if (cmd === 'show') {
  const [r] = q(`SELECT * FROM reports WHERE id = ${Number(arg) | 0}`);
  if (!r) { console.log('no such report'); process.exit(0); }
  console.log(line(r), `\ninstall id ${r.install}\n\n${r.body || ''}`);
} else if (cmd === 'mac') {
  q(`SELECT ${cols} FROM reports WHERE install = '${hex(arg)}' ORDER BY at DESC LIMIT 100`).forEach((r) => console.log(line(r)));
} else if (cmd === 'macs') {
  q(`SELECT ${cols}, MAX(at) AS at FROM reports GROUP BY install ORDER BY at DESC`).forEach((r) => console.log(line(r)));
} else if (cmd === 'problems') {
  q(`SELECT ${cols} FROM reports WHERE kind IN ('problem', 'install', 'rescue') ORDER BY at DESC LIMIT 60`).forEach((r) => console.log(line(r)));
} else {
  q(`SELECT ${cols} FROM reports ORDER BY at DESC LIMIT 40`).forEach((r) => console.log(line(r)));
}
