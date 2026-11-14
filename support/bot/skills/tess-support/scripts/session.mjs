#!/usr/bin/env node
// One temporary folder per support session, and the caps that keep it from filling a disk.
//
// Everything a person sends — screenshots, a screen recording, the doctor report, the chat scratch — lives in one
// folder under TESS_SESSION_ROOT, and nowhere else. The folder is deleted the moment the inbox accepts the report, and
// anything left behind is swept after 24 hours, so a crash can't quietly cost half a gigabyte.
//
// Recordings are the only big thing: capped at ~50 MB and 2 minutes. Over the cap, the script re-encodes down when
// ffmpeg is on the machine and refuses when it isn't — it never takes a large file "to sort out later".
//
//   node session.mjs new                        prints the folder to use
//   node session.mjs add <file> [--record]      checks size/type, re-encodes a big recording, records it
//   node session.mjs handoff <report id>        one-line record, then deletes the folder
//   node session.mjs sweep                      deletes folders older than 24h and holds the total under the cap
//   node session.mjs size                       total bytes held right now
// Runs on the server. Nothing here runs on anyone's Mac.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const MB = 1024 * 1024;
export const MAX_RECORDING = 50 * MB;      // a Telegram upload, and a reasonable thing to re-encode
export const MAX_SESSION = 60 * MB;        // everything one person sends in one visit
export const MAX_TOTAL = 500 * MB;         // the whole bot's scratch space
export const MAX_AGE_MS = 24 * 3600 * 1000;
export const MAX_MINUTES = 2;

export const ROOT = process.env.TESS_SESSION_ROOT
  || join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'cache', 'support', 'sessions');
export const RECORDS = join(ROOT, 'handoffs.log');

const VIDEO = /\.(mov|mp4|m4v|webm|mkv)$/i;
const IMAGE = /\.(png|jpe?g|heic|gif|webp)$/i;
const TEXT = /\.(txt|log|md|json)$/i;
const have = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };

const folders = () => (existsSync(ROOT)
  ? readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(ROOT, d.name))
  : []);
const bytesIn = (dir) => {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? bytesIn(p) : (statSync(p).size || 0);
  }
  return total;
};
const totalHeld = () => folders().reduce((n, d) => n + bytesIn(d), 0);
const age = (dir) => Date.now() - statSync(dir).mtimeMs;
const meta = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')); } catch { return { id: dir.split('/').pop(), created: statSync(dir).mtimeMs, files: [] }; }
};
const save = (dir, m) => writeFileSync(join(dir, 'session.json'), JSON.stringify(m, null, 2));

// --- commands ---------------------------------------------------------------------------------------------------------
export const newSession = () => {
  mkdirSync(ROOT, { recursive: true });
  // Refuse rather than grow: if the floor is already full, clean it before making another folder.
  if (totalHeld() > MAX_TOTAL - MAX_SESSION) sweep();
  if (totalHeld() > MAX_TOTAL - MAX_SESSION) throw new Error(`scratch space is over ${MAX_TOTAL / MB} MB; sweep before starting another session`);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  save(dir, { id, created: Date.now(), files: [] });
  return dir;
};

export const addFile = (dir, file, { record = false } = {}) => {
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  const name = file.split('/').pop();
  if (!(VIDEO.test(name) || IMAGE.test(name) || TEXT.test(name))) {
    throw new Error(`"${name}" is not something a person would send: a screenshot (png, jpg, heic), a recording (mov, mp4, webm) or text`);
  }
  let size = statSync(file).size;
  let target = join(dir, name);

  if (VIDEO.test(name)) {
    if (size > MAX_RECORDING) {
      if (!have('ffmpeg')) throw new Error(`that recording is ${Math.round(size / MB)} MB; the limit is ${MAX_RECORDING / MB}. Ask for a shorter one.`);
      // Re-encode down rather than storing it and hoping: one pass, no quality promises, small enough to keep.
      const out = join(dir, `${name.replace(/\.[^.]+$/, '')}-small.mp4`);
      try {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-t', String(MAX_MINUTES * 60), '-vf', 'scale=-2:720', '-b:v', '2M', out], { stdio: 'ignore' });
      } catch {
        // A file that won't shrink is still too big. Say the useful thing, not ffmpeg's error.
        throw new Error(`that recording is ${Math.round(size / MB)} MB and couldn't be shrunk; ask for a shorter one`);
      }
      target = out; size = statSync(out).size;
      if (size > MAX_RECORDING) throw new Error(`that recording is still ${Math.round(size / MB)} MB after shrinking; ask for a shorter one.`);
    }
    // Duration is only checkable when ffprobe is there; the size cap still applies either way.
    if (have('ffprobe')) {
      const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', target], { encoding: 'utf8' }).trim());
      if (Number.isFinite(secs) && secs > MAX_MINUTES * 60 + 5) throw new Error(`that recording is ${Math.round(secs)}s; ask for ${MAX_MINUTES} minutes or less`);
    }
  }
  if (target !== file) { writeFileSync(target, readFileSync(file)); }

  const m = meta(dir);
  const held = m.files.reduce((n, f) => n + f.size, 0) + size;
  if (held > MAX_SESSION) throw new Error(`this session is now ${Math.round(held / MB)} MB; one visit is capped at ${MAX_SESSION / MB}`);
  if (totalHeld() + size > MAX_TOTAL) { sweep(); if (totalHeld() + size > MAX_TOTAL) throw new Error('scratch space is full; sweep before adding more'); }
  m.files.push({ name: target.split('/').pop(), size, at: Date.now() });
  save(dir, m);
  return { path: target, size };
};

// The hand-off is the point of no return: once the inbox has it, the local copies are a liability, not evidence.
export const handoff = (dir, reportId) => {
  mkdirSync(ROOT, { recursive: true });
  const m = meta(dir);
  appendFileSync(RECORDS, `${new Date().toISOString()} report ${reportId} ${m.files.length} file(s) ${Math.round(bytesIn(dir) / 1024)} KB\n`);
  rmSync(dir, { recursive: true, force: true });
  return { id: m.id, removed: !existsSync(dir) };
};

export const sweep = () => {
  const gone = [];
  for (const dir of folders()) {
    if (age(dir) > MAX_AGE_MS) {
      // A swept folder is recorded too: "it vanished" is never an acceptable answer to what happened to someone's file.
      try {
        const m = meta(dir);
        appendFileSync(RECORDS, `${new Date().toISOString()} swept ${m.id} ${m.files.length} file(s) older than ${MAX_AGE_MS / 3600000}h\n`);
      } catch { /* a folder we can't read still gets removed */ }
      rmSync(dir, { recursive: true, force: true });
      gone.push(dir);
    }
  }
  // Then the total, oldest first, in case a burst of small sessions got past the per-folder cap.
  let total = totalHeld();
  if (total > MAX_TOTAL) {
    for (const dir of folders().sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)) {
      if (total <= MAX_TOTAL) break;
      total -= bytesIn(dir);
      rmSync(dir, { recursive: true, force: true });
      gone.push(dir);
    }
  }
  return gone;
};

export const size = () => totalHeld();

// --- CLI --------------------------------------------------------------------------------------------------------------
// Matching on the bare name matters: tools/test-session.mjs ends with "session.mjs" too, and a loose pattern would make
// the test run the CLI instead of the tests.
if (basename(process.argv[1] || '') === 'session.mjs') {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'new') console.log(newSession());
    else if (cmd === 'add') console.log(JSON.stringify(addFile(arg, rest[0], { record: rest.includes('--record') })));
    else if (cmd === 'handoff') console.log(JSON.stringify(handoff(arg, rest[0] || 'unknown')));
    else if (cmd === 'sweep') console.log(JSON.stringify({ removed: sweep() }));
    else if (cmd === 'size') console.log(size());
    else {
      console.error('usage: session.mjs new | add <dir> <file> [--record] | handoff <dir> <report id> | sweep | size');
      process.exit(1);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
