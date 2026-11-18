#!/usr/bin/env node
// triage.mjs prints the inbox payload. Saving it with `>` is a shell redirect,
// and Hermes will not pre-approve a line that contains one. This runs triage
// and writes <dir>/payload.json next to the --report file.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const die = (msg) => { console.error(msg); process.exit(1); };
const args = process.argv.slice(2);
const reportAt = args.indexOf('--report');
const report = reportAt === -1 ? '' : args[reportAt + 1];
const modeAt = args.indexOf('--mode');
if (!report || report.startsWith('-') || args[modeAt + 1] !== 'inbox') {
  die('usage: triage-inbox.mjs --report <dir>/doctor.txt --words <dir>/words.txt --title-file <dir>/title.txt --summary-file <dir>/summary.txt --mode inbox');
}

const triage = join(dirname(fileURLToPath(import.meta.url)), '../../tess-support/scripts/triage.mjs');
let out;
try {
  out = execFileSync(process.execPath, [triage, ...args], { encoding: 'utf8' });
} catch (err) {
  if (err.stderr) process.stderr.write(err.stderr);
  process.exit(err.status || 1);
}
writeFileSync(join(dirname(report), 'payload.json'), out);
console.log(join(dirname(report), 'payload.json'));
