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
//   node tools/reports.mjs support usage                today's support chat use, per person and shared (UTC day)
//   node tools/reports.mjs support token add <label>    mint one (printed once; only its hash is stored)
//   node tools/reports.mjs support token revoke <label> stop one working
//   node tools/reports.mjs support titles               refresh the open-issue title list the bot checks first
//
// Tests only: TESS_D1_LOCAL=<absolute folder> sends every command to the local copy of the database that
// `wrangler dev --persist-to <folder>` uses, instead of the live inbox.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? '' : String(argv[i + 1] || ''); };
const [cmd = 'latest', arg] = argv;
// The live database unless TESS_D1_LOCAL names a local one. A test checks these arguments before it runs anything,
// so a local run can never fall through to --remote.
export const d1Args = (sql, env = process.env) => {
  const local = env.TESS_D1_LOCAL || '';
  if (local && !isAbsolute(local)) throw new Error('TESS_D1_LOCAL must be an absolute folder');
  // A local run uses the wrangler already on this machine; the live one fetches wrangler 4 as before.
  const runner = local ? ['--no-install', 'wrangler'] : ['-y', 'wrangler@4'];
  const where = local ? ['--local', '--persist-to', local] : ['--remote'];
  return [...runner, 'd1', 'execute', 'tess-inbox', ...where, '--json', '--command', sql];
};
const q = (sql) => JSON.parse(execFileSync('npx', d1Args(sql),
  { cwd: fileURLToPath(new URL('../inbox/', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
const hex = (v) => { if (!/^[0-9a-f]{32}$/.test(v || '')) { console.error('install ids are 32 hex characters'); process.exit(1); } return v; };
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
// The inbox strips these on write, but a row stored before that fix is still in the database: a bidi override in a
// report could otherwise reorder the line this prints, so the reading side does not trust what it finds either.
const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '');
const line = (r) => `${String(r.id).padStart(5)}  ${when(r.at)}  ${r.install.slice(0, 8)}  ${r.kind.padEnd(9)}  tess ${clean(r.tess) || '?'}  spotify ${clean(r.spotify) || '?'}  macOS ${clean(r.macos) || '?'}  ${clean(r.status)}`;
const cols = 'id, at, install, kind, tess, spotify, macos, status';

const sq = (v) => String(v).replace(/'/g, "''");
const PRI = (p) => p || '?';

// The GitHub labels are "P2: medium", not "P2" — a bare priority makes `gh issue create` fail on every report.
export const LABEL = { P0: 'P0: critical', P1: 'P1: high', P2: 'P2: medium', P3: 'P3: low' };

// One line printed for Krish to paste. A single-quoted word is the only one a shell won't touch, so everything goes
// through this — the title is written by a model reading a stranger's message, and a double-quoted `$(...)` in it
// would run on his Mac the moment he pasted the line.
export const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// The body goes in through a pipe, so a title can never be read as a command and a long report never hits an argument
// limit. `support body <n>` is the other half of this line.
export const issueCommand = (r) => {
  const id = Number(r.id);
  // The id is the one number on this line that isn't fixed text, and it goes into SQL on the other side of the pipe.
  if (!Number.isInteger(id) || id < 1) throw new Error(`not a report number: ${r.id}`);
  const areas = String(r.areas || '').split(/,\s*/).filter(Boolean);
  const labels = [LABEL[r.priority], ...areas, r.kind].filter(Boolean);
  return `node tools/reports.mjs support body ${id} | gh issue create -R Flame119052/tess-music --title ${shellQuote(r.title)} ${labels.map((l) => `--label ${shellQuote(l)}`).join(' ')} --body-file -`;
};

// `support show 12`: the subcommand is argv[1], so the number is argv[2]. Reading the module-level `arg` here handed
// "show" to num() and broke show, body, filed and token alike — so the split lives in one tested place.
export const parseSupport = (args) => ({ sub: args[0], arg: args[1] });

const sha = (token) => createHash('sha256').update(token).digest('hex');

// Mint, revoke and usage are plain SQL so the chat test runs the same statements against its own database.
export const mintSql = (label, token, now = Date.now()) =>
  `INSERT INTO support_tokens (label, sha, added) VALUES ('${sq(label)}', '${sha(token)}', ${Number(now)})`;
export const revokeSql = (label, now = Date.now()) =>
  `UPDATE support_tokens SET revoked = ${Number(now)} WHERE label = '${sq(label)}' AND revoked IS NULL`;

// The gate's counters (inbox/worker.js supportChat): chat:p and chat:tp per token hash, chat:s and chat:ts shared.
// Each row lasts until the next 00:00 UTC; a row whose window has closed is yesterday's and counts as 0.
export const usageSql = (nowSec = Math.floor(Date.now() / 1000)) => {
  const t = Number(nowSec);
  return `SELECT t.id AS ord, t.label AS who, t.revoked AS revoked, p.n AS requests, tp.n AS tokens FROM support_tokens t
    LEFT JOIN limits p ON p.k = 'chat:p:' || t.sha AND p.until > ${t}
    LEFT JOIN limits tp ON tp.k = 'chat:tp:' || t.sha AND tp.until > ${t}
    UNION ALL SELECT 9007199254740991, '(everyone)', NULL,
      (SELECT n FROM limits WHERE k = 'chat:s' AND until > ${t}), (SELECT n FROM limits WHERE k = 'chat:ts' AND until > ${t})
    ORDER BY ord`;
};

// The caps this checkout would deploy. The live Worker has whatever was deployed last, so the line says where they came from.
export const capsFrom = (toml) => {
  const v = (name) => (toml.match(new RegExp(`^${name} = "(\\d+)"`, 'm')) || [])[1] || '?';
  return {
    personRequests: v('SUPPORT_CHAT_PERSON_REQUESTS'), sharedRequests: v('SUPPORT_CHAT_SHARED_REQUESTS'),
    personTokens: v('SUPPORT_CHAT_PERSON_TOKENS'), sharedTokens: v('SUPPORT_CHAT_SHARED_TOKENS'),
  };
};

export const usageLines = (rows, caps) => rows.map((r) => {
  const everyone = r.who === '(everyone)';
  const reqCap = everyone ? caps.sharedRequests : caps.personRequests;
  const tokCap = everyone ? caps.sharedTokens : caps.personTokens;
  const state = everyone ? '' : (r.revoked ? '  REVOKED' : '  active');
  return `${String(r.who).padEnd(24)}  ${r.requests ?? 0} of ${reqCap} requests  ${r.tokens ?? 0} of ${tokCap} tokens${state}`;
});

function support() {
  const { sub, arg } = parseSupport(argv.slice(1));
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
    console.log(r.image ? `image in R2: ${r.image} (deleted when filed, or at 14 days)` : 'no image');
    console.log(`\n--- what they said\n${r.words || '(nothing)'}\n\n--- what the bot worked out\n${r.diagnosis || '(nothing)'}\n\n--- the finished write-up\n${r.body || '(nothing)'}`);
    console.log(`\nfile it with:\n  ${issueCommand(r)}`);
    console.log(`then record it: node tools/reports.mjs support filed ${r.id} --issue <url>`);
    return;
  }

  if (sub === 'body') {
    // Only the write-up, so it can be piped straight into `gh issue create --body-file -`.
    const [r] = q(`SELECT body FROM support_reports WHERE id = ${num(arg)}`);
    if (!r) { console.error('no such support report'); process.exit(1); }
    process.stdout.write(r.body || '');
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

  if (sub === 'usage') {
    const caps = capsFrom(readFileSync(fileURLToPath(new URL('../inbox/wrangler.toml', import.meta.url)), 'utf8'));
    console.log('support chat today (resets 00:00 UTC; caps as in inbox/wrangler.toml, a token cap of 0 is off)');
    for (const l of usageLines(q(usageSql()), caps)) console.log(l);
    return;
  }

  if (sub === 'token' && ['add', 'revoke'].includes(arg)) {
    const label = argv.slice(3).filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!label) { console.error(`usage: support token ${arg} <label>`); process.exit(1); }
    if (arg === 'revoke') {
      q(revokeSql(label));
      console.log(`revoked any active token labelled "${label}" — it stops working on the next request`);
      return;
    }
    // 32 random bytes, printed once. Only the SHA-256 goes to the database, so this output is the only copy.
    const token = 'tess_' + randomBytes(32).toString('hex');
    q(mintSql(label, token));
    console.log(`token for "${label}":\n\n${token}\n\nIt is shown once and only its hash is stored. Send it to that person on its own (support/RUNBOOK-mac.md), or put it on the server that runs the bot.`);
    return;
  }

  console.error('usage: support list | show <n> | body <n> | filed <n> --issue <url> | tokens | usage | token add <label> | token revoke <label> | titles');
  process.exit(1);
}

function main() {
if (cmd === 'support') {
  support();
} else if (cmd === 'show') {
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
}

// Imported by tools/test-reports.mjs, so the CLI only runs when this file is the entry point.
if (basename(process.argv[1] || '') === 'reports.mjs') main();
