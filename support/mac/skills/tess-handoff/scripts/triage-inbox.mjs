#!/usr/bin/env node
// triage.mjs prints the inbox payload. Saving it with `>` is a shell redirect,
// and Hermes will not pre-approve a line that contains one. This runs triage
// and writes <session>/payload.json. The line is pre-approved with wildcards,
// so every file it names must be that session's own file: the model never
// chooses where a pre-approved script reads or writes.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const die = (msg) => { console.error(msg); process.exit(1); };
const args = process.argv.slice(2);
const reportAt = args.indexOf('--report');
const report = reportAt === -1 ? '' : args[reportAt + 1];
const modeAt = args.indexOf('--mode');
if (!report || report.startsWith('-') || args[modeAt + 1] !== 'inbox') {
  die('usage: triage-inbox.mjs --report <dir>/doctor.txt --words <dir>/words.txt --title-file <dir>/title.txt --summary-file <dir>/summary.txt --mode inbox');
}

const here = dirname(fileURLToPath(import.meta.url));
let session;
try {
  const { inRoot } = await import(pathToFileURL(join(here, '../../tess-support/scripts/session.mjs')).href);
  session = inRoot(dirname(report));
} catch (err) { die(err.message); }
const own = { '--report': 'doctor.txt', '--words': 'words.txt', '--title-file': 'title.txt', '--summary-file': 'summary.txt' };
for (const [flag, name] of Object.entries(own)) {
  const at = args.indexOf(flag);
  if (at === -1) continue;
  const file = resolve(String(args[at + 1] || ''));
  if (dirname(file) !== session || basename(file) !== name) die(`${flag} must be ${join(session, name)}`);
}

const triage = join(here, '../../tess-support/scripts/triage.mjs');
let out;
try {
  out = execFileSync(process.execPath, [triage, ...args], { encoding: 'utf8' });
} catch (err) {
  if (err.stderr) process.stderr.write(err.stderr);
  process.exit(err.status || 1);
}
writeFileSync(join(session, 'payload.json'), out);
console.log(join(session, 'payload.json'));
