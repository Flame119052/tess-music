#!/usr/bin/env node
// Tess support triage: turns one person's `tess report` output, their own words and what the person looking at it
// decided into the exact GitHub issue text, and the short private note to the owner. It is the mechanical half of the
// Tess support bot's triage step (this skill's SKILL.md): the model reads and judges, this file does the parts
// that must come out the same every time — scrubbing personal data, picking the labels from evidence, and refusing
// an issue that carries more severity than the evidence supports.
//
// Usage:
//   node scripts/triage.mjs --report <file|-> --words <file|-> [options]
// Options:
//   --tess <x.y.z|unknown>     the version the person runs (Tess Settings shows it)
//   --macos <ver|unknown>      optional; the paste doesn't carry it
//   --title "plain English"    the model's title; checked, never trusted
//   --summary "plain English"  two or three lines of what the model concluded, for the issue
//   --kind bug|design|enhancement|testing|documentation   default bug
//   --priority P0|P1|P2|P3     may only RAISE what the evidence supports
//   --also area:theme          areas the model spotted that the report can't show; repeatable
//   --related 61,65            existing issues the person's problem looks like
//   --main <sha>               commit of main the model read (says how fresh the diagnosis is)
//   --mode issue|krish|json|gh|inbox   issue is the exact text; gh prints the filing command; inbox is the payload
//                                      the bot posts to the Tess inbox, which the owner's side turns into the issue
// Exit 1 with a sentence on stderr when the bot must ask one more question instead of filing.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPO = 'Flame119052/tess-music';

const args = process.argv.slice(2);
const opt = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const many = (name) => args.reduce((out, a, i) => (a === `--${name}` ? [...out, args[i + 1]] : out), []);
const read = (p) => (p === '-' ? readFileSync(0, 'utf8') : readFileSync(p, 'utf8'));

const die = (msg) => { throw new Error(msg); };

// --- privacy ---------------------------------------------------------------------------------------------------------
// Everything that leaves this file goes through scrub(): the issue is public, and the person on the other end may
// have pasted a path, an address or their own phone number. doctor.sh already replaces the home folder, the account
// name, the computer name and emails, but it can't know what they typed into the chat, and a second pass costs
// nothing. Timestamps are protected first so the phone-number rule can't eat "2026-11-14 10:02:11".
export const scrub = (text) => {
  if (!text) return '';
  const keep = [];
  const stash = (m) => `\u0000${keep.push(m) - 1}\u0000`;
  let out = text
    .replace(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|\b\d+(?:\.\d+){2,}\b/g, stash)
    .replace(/\b[0-9a-f]{32}\b/gi, '(install id withheld)')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '(email)')
    .replace(/(?:\/Users|\/home|\/Volumes)\/[^\s"'`)]+/g, '~')
    .replace(/(^|[\s([])\+?\d[\d ().-]{7,}\d(?=$|[\s.,;:)\]\n])/g, (_, pre) => `${pre}(number)`)
    .replace(/@[A-Za-z0-9_]{3,}/g, '(handle)');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
};

// --- what the doctor said --------------------------------------------------------------------------------------------
// The paste is the human output of `tess report` (installer/doctor.sh, --report mode): "  ✓ ok", "  ✕ problem",
// "  ↻ fixed", a summary line, then "Report sent. Your install id: …". Each symptom below is a phrase doctor.sh
// prints today; the regex is the binding, so a wording change there shows up as an unrecognised line (kept in the
// issue) rather than as a silently lower priority.
const SYMPTOMS = [
  { id: 'spotify=missing', re: /can't find Spotify/i, area: 'area: installer', floor: 'P0', title: "Tess can't find Spotify on this Mac" },
  { id: 'spotify=broken', re: /Spotify's interface files are missing/i, area: 'area: installer', floor: 'P0', title: 'Spotify opens with no interface after a Tess update' },
  { id: 'spotify=noloader', re: /Tess's loader is missing/i, area: 'area: installer', floor: 'P0', title: "Tess disappears and Spotify is left patched" },
  { id: 'patcher=bad', re: /the patcher is damaged/i, area: 'area: installer', floor: 'P1', title: 'Tess stops applying because its patcher is damaged' },
  { id: 'updater=bad', re: /the updater is damaged/i, area: 'area: installer', floor: 'P1', title: "Tess can't update itself" },
  { id: 'appmgmt=blocked', re: /macOS is blocking tess-patcher/i, area: 'area: installer', floor: 'P1', title: 'macOS blocks Tess from installing, with no clear next step' },
  { id: 'net=down', re: /can't reach GitHub for updates/i, area: 'area: installer', floor: 'P1', title: "Tess can't update because GitHub is unreachable" },
  { id: 'spotify=stock', re: /Spotify \S+ is stock/i, area: 'area: installer', floor: 'P2', title: 'Tess keeps dropping out and Spotify comes back' },
  { id: 'guard=missing', re: /the update helper is missing/i, area: 'area: installer', floor: 'P2', title: 'Tess stops updating by itself' },
  { id: 'guard=restarted', re: /restarted the update helper/i, area: 'area: installer', floor: 'P2', title: 'The update helper stops running' },
  { id: 'mini=restarted', re: /restarted Tess Mini/i, area: 'area: mini', floor: 'P2', title: 'Tess Mini stops running' },
  { id: 'rescue=restarted', re: /restarted the rescue line/i, area: 'area: installer', floor: 'P2', title: 'The rescue line stops running' },
];
const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

const parseReport = (text) => {
  const found = SYMPTOMS.filter((s) => s.re.test(text));
  const lines = text.split('\n');
  const problems = lines.filter((l) => /^\s*✕ /.test(l)).map((l) => l.replace(/^\s*✕\s*/, '').trim());
  const fixed = lines.filter((l) => /^\s*↻ /.test(l)).map((l) => l.replace(/^\s*↻\s*/, '').trim());
  const spotify = (text.match(/Tess is in Spotify (\S+)/) || [])[1] || 'unknown';
  const installId = (text.match(/install id: ([0-9a-f]{32})/i) || [])[1] || '';
  // `tess report` prints this when reports are off, or when the Mac is offline. The two are indistinguishable from
  // the paste, so the issue says "may not have gone through" rather than claiming either.
  const reportsMayBeOff = /Couldn't send the report|reports are off/i.test(text);
  // The helper's own log is the only place a real error message appears; keep the last few lines for the issue.
  const log = [];
  const at = lines.findIndex((l) => /recent problems in the helper's log/i.test(l));
  if (at !== -1) for (const l of lines.slice(at + 1)) { if (!/^\s{4,}\S/.test(l)) break; log.push(l.trim()); }
  return { found, problems, fixed, spotify, installId, log, reportsMayBeOff };
};

// --- what the person said --------------------------------------------------------------------------------------------
// `tess report` prints "Report sent. Your install id: …" — the person normally pastes the whole thing. Keep the
// report intact in the issue (it is the evidence) but drop that line: the id is the one thing that would tie this
// public issue to their private health reports.
const tidyReport = (text) => scrub(text
  .replace(/^.*Report sent\. Your install id:.*$/gim, '')
  .replace(/^.*Couldn't send the report.*$/gim, '')
  .trim());

// --- the judgement the model is not allowed to make on the cheap -----------------------------------------------------
export const decide = ({ report, words, tess = 'unknown', macos = 'unknown', priority = '', also = [], kind = 'bug',
  title = '', summary = '', related = [], main = '' }) => {
  const p = parseReport(report);
  const floor = p.found.reduce((worst, s) => (RANK[s.floor] < RANK[worst] ? s.floor : worst), 'P2');
  const asked = priority ? priority.toUpperCase().replace(/^([0-3])$/, 'P$1') : '';
  if (asked && !/^P[0-3]$/.test(asked)) die(`--priority must be P0, P1, P2 or P3 (got "${priority}")`);
  // Raising is fine — a person who says their whole Mac is unusable gets attention. Lowering is not: the doctor's
  // own evidence is the floor, so a model that misreads a broken Spotify as "cosmetic" cannot bury it. The issue is
  // still filed at once (refusing would delay the one case that must not wait) and the disagreement is shown to the
  // maintainer, so a model that keeps getting this wrong is visible instead of silent.
  const chosen = asked && RANK[asked] < RANK[floor] ? asked : floor;
  const lowered = Boolean(asked) && RANK[asked] > RANK[floor];
  // Labels on GitHub are literally "area: theme", and a shell argument with a space is a nuisance to type, so both
  // spellings are accepted and normalised here.
  const KINDS = ['bug', 'enhancement', 'design', 'security', 'testing', 'documentation', 'spec'];
  if (!KINDS.includes(kind)) die(`--kind must be one of ${KINDS.join(', ')} (docs/triage.md) — a kind is a GitHub label, not a free word`);
  const areas = [...new Set([...p.found.map((s) => s.area), ...also.map((a) => String(a).replace(/^area:\s*/, 'area: '))])];
  const bad = areas.filter((a) => !/^area: (theme|patcher|installer|mini|companion|release-ci|docs)$/.test(a));
  if (bad.length) die(`--also: not an area label: ${bad.join(', ')} (see docs/triage.md)`);
  if (!areas.length) {
    die('No area can be worked out from this report. Ask the person which part of Tess is wrong (the look, the '
      + 'miniplayer, installing or updating), then pass it as --also area:theme|mini|installer.');
  }
  const strongest = p.found.find((s) => s.floor === floor);
  const out = {
    priority: chosen,
    raised: chosen !== floor,
    lowered,
    floor,
    areas,
    kind,
    tess,
    spotify: p.spotify,
    macos,
    problems: p.problems,
    fixed: p.fixed,
    log: p.log,
    installId: p.installId,
    reportsMayBeOff: p.reportsMayBeOff,
    words: scrub(words || '').trim(),
    report: tidyReport(report),
    summary: scrub(summary || '').trim(),
    related,
    main,
  };
  out.title = cleanTitle(title || (strongest ? strongest.title : ''));
  return out;
};

// Titles are the one thing a person skimming the tracker sees, and triage.md §5 asks for plain English. A path, an
// email or a 32-character id in a title is a red flag that the model copied instead of understood.
export const cleanTitle = (t) => {
  const raw = String(t || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (/\//.test(raw)) die(`--title must not contain a file path or a slash: "${raw}"`);
  if (/@/.test(raw)) die(`--title must not contain an email or handle: "${raw}"`);
  if (/[0-9a-f]{12,}/i.test(raw)) die(`--title must not contain an id: "${raw}"`);
  // A title that had to be scrubbed was copied, not understood. Refusing is better than filing "Reply to (email)".
  if (scrub(raw) !== raw) die(`--title carries personal detail: "${raw}". Write it in plain words without it.`);
  if (raw.length > 90) die(`--title is ${raw.length} characters; a plain title is under 90. Split it or drop detail.`);
  return raw;
};

// --- rendering -------------------------------------------------------------------------------------------------------
const optTitle = opt('title'), optSummary = opt('summary'), optMain = opt('main');
const optRelated = many('related');

const versionLine = (d) => [
  `- Tess: ${d.tess}`,
  `- Spotify: ${d.spotify}`,
  `- macOS: ${d.macos}`,
  d.main ? `- Checked against source at \`main\` \`${d.main}\`${d.tess === 'unknown' ? '' : ' (the version above may be older; line references are approximate)'}` : '',
].filter(Boolean).join('\n');

// Blocks are joined with one blank line, so a section that is skipped (no log lines, no related issues) costs nothing
// and the ones that remain stay properly spaced.
const body = (d) => [
  '## What happened',
  d.words || '_The person did not add words._',
  d.summary ? `## What it looks like\n\n${d.summary}` : '',
  '## What Tess doctor found',
  d.reportsMayBeOff ? '_The anonymous health report may not have gone through — reports are off on this Mac, or it was offline._' : '',
  d.problems.length ? d.problems.map((l) => `- ${l}`).join('\n') : '_Doctor reported no failing checks._',
  d.fixed.length ? `Fixed by the doctor before they reported it: ${d.fixed.join('; ')}.` : '',
  d.log.length ? `The update helper's own log says:\n\n\`\`\`\n${d.log.join('\n')}\n\`\`\`` : '',
  `<details><summary>The full report they sent (names, paths and emails already removed)</summary>\n\n\`\`\`\n${d.report || '(nothing)'}\n\`\`\`\n\n</details>`,
  '## Version',
  versionLine(d) + '\n- Install id: withheld. It is in the private note to the maintainer.',
  d.related.length ? `## Related\n\n${d.related.map((n) => `- #${String(n).replace('#', '')}`).join('\n')}` : '',
  '## What happens next',
  d.priority === 'P0' || d.priority === 'P1'
    ? 'This is marked as urgent. The person was told a fix is coming and that Tess updates itself when one ships — there is nothing for them to do.'
    : 'The person was told it is written down and that fixes reach them on their own, with no action from them.',
  '---',
  'Reported through the Tess support bot. The machine details come from Tess\'s own doctor, which the person ran; they\nchose what to share. No name, email, phone number, computer name or home folder is included. Priority and area were\nworked out from the doctor\'s evidence, not from how loud the report was.',
].filter((s) => s !== '').join('\n\n');

const krish = (d) => `Tess support: ${d.title}
${d.priority}${d.raised ? ` (raised from ${d.floor} by the person's description)` : ''}${d.lowered ? ` (the assessment said lower; the doctor's evidence holds it at ${d.floor})` : ''} · ${d.areas.join(', ')} · ${d.kind}
Tess ${d.tess} on Spotify ${d.spotify}${d.macos === 'unknown' ? '' : `, macOS ${d.macos}`}
install id: ${d.installId || 'not in the report'}
who: someone on the allowlist — their id stays on the server, never in this message
they said: ${d.words.split('\n')[0] || '(no words)'}
${d.problems.length ? `doctor: ${d.problems.join(' / ')}` : 'doctor: nothing failing'}`;

const LABEL = { P0: 'P0: critical', P1: 'P1: high', P2: 'P2: medium', P3: 'P3: low' };
export const labels = (d) => [LABEL[d.priority], ...d.areas, d.kind];

const main = () => {
  const mode = opt('mode', 'issue');
  const reportFile = opt('report'), wordsFile = opt('words');
  if (mode !== 'krish' && (!reportFile || !wordsFile)) {
    die('usage: triage.mjs --report <file|-> --words <file|-> [--tess 0.1.9] [--title "…"] [--mode issue|krish|json]');
  }
  const d = decide({
    report: reportFile ? read(reportFile) : '',
    words: wordsFile ? read(wordsFile) : '',
    tess: opt('tess', 'unknown'),
    macos: opt('macos', 'unknown'),
    priority: opt('priority'),
    also: many('also'),
    kind: opt('kind', 'bug'),
    title: optTitle,
    summary: optSummary,
    related: optRelated,
    main: optMain,
  });
  if (!d.title) die('No plain-English title: pass --title, or make sure the report shows something Tess doctor flags.');
  if (mode === 'json') {
    console.log(JSON.stringify({ ...d, labels: labels(d), body: body(d), krish: krish(d) }, null, 2));
  } else if (mode === 'inbox') {
    // Exactly what POST /v1/support takes, and nothing else: no name, no Telegram id, no token. The Worker checks the
    // priority, the areas and the kind again on its side, because these values become GitHub labels.
    console.log(JSON.stringify({
      priority: d.priority, kind: d.kind, areas: d.areas, title: d.title,
      words: d.words, diagnosis: d.summary, body: body(d),
      tess: d.tess, spotify: d.spotify, macos: d.macos, install: d.installId || undefined,
    }));
  } else if (mode === 'krish') {
    console.log(krish(d));
  } else if (mode === 'gh') {
    // The bot runs `gh` itself, so this file prints the command instead of quietly filing anything: what gets posted
    // is visible in the conversation, and nothing here needs a GitHub token to be tested.
    const dir = opt('out', join(homedir(), '.hermes/cache/support'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'issue.md');
    writeFileSync(file, body(d) + '\n');
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    console.log(['gh', 'issue', 'create', '-R', REPO, '--title', q(d.title), ...labels(d).flatMap((l) => ['--label', q(l)]), '--body-file', q(file)].join(' '));
  } else {
    console.log(`TITLE: ${d.title}\n\nLABELS: ${labels(d).join(', ')}\n\n${body(d)}`);
  }
};

// Imported by tools/test-support.mjs, so the CLI only runs when this file is the entry point.
if (process.argv[1] && /triage\.mjs$/.test(process.argv[1])) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
