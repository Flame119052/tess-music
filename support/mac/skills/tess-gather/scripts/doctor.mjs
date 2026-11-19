#!/usr/bin/env node
// Runs tess doctor and writes <session>/doctor.txt itself.
// The model never starts this. The visit tool runs it with an argument list.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inRoot, scrub } from '../../tess-support/scripts/session.mjs';

const MAX = 1024 * 1024;
const die = (msg) => { console.error(scrub(msg)); process.exit(1); };

const dir = process.argv[2];
if (process.argv.length !== 3 || !dir || dir.startsWith('-')) {
  die('usage: doctor.mjs <session>');
}

let session;
try { session = inRoot(dir); } catch (err) { die(err.message); }

const capture = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 120000, maxBuffer: MAX + 1 });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    const out = err.stdout ? String(err.stdout) : '';
    if (out) return out;
    die(String(err.stderr || err.message || 'tess doctor failed').trim().slice(0, 400));
  }
};

let out = capture('tess', ['doctor']);
if (out == null) {
  const home = process.env.HOME || '';
  out = capture('zsh', [join(home, 'Library/Application Support/Tess/doctor.sh')]);
}
if (out == null) die('tess doctor is not on this Mac');
if (Buffer.byteLength(out) > MAX) die('the doctor output is over 1 MB');
const dest = join(session, 'doctor.txt');
writeFileSync(dest, out);
console.log(dest);
