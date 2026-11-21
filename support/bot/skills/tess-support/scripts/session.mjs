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
//   node session.mjs add <dir> <file> [--record] checks size/type, re-encodes a big recording, records it
//   node session.mjs handoff <dir> <report id>  one-line record, then deletes the folder
//   node session.mjs sweep                      deletes folders older than 24h and holds the total under the cap
//   node session.mjs size                       total bytes held right now
// Runs on the VPS bot, and, copied verbatim by support/mac/install.mjs, on a person's Mac (D-106).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const MB = 1024 * 1024;
export const MAX_RECORDING = 50 * MB;      // a Telegram upload, and a reasonable thing to re-encode
export const MAX_SESSION = 60 * MB;        // everything one person sends in one visit
export const MAX_TOTAL = Number(process.env.TESS_MAX_TOTAL_MB || 500) * MB;   // the whole bot's scratch space
// Both are overridable because an operator may want a smaller budget on a small disk, and because a test can then
// prove the cap works without writing half a gigabyte to do it.
export const MAX_AGE_MS = Number(process.env.TESS_MAX_AGE_HOURS || 24) * 3600 * 1000;
export const MAX_MINUTES = 2;

// This file lives at <profile>/skills/tess-support/scripts/session.mjs, so the profile and the Hermes home are derivable
// from it. Guessing `$HERMES_HOME` breaks the moment Hermes points that at the profile directory instead of the root:
// the scratch space would land in the wrong tree and nothing would say so.
const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE_DIR = process.env.TESS_PROFILE_DIR || resolve(HERE, '../../..');
export const HERMES_HOME = process.env.HERMES_HOME_DIR || resolve(PROFILE_DIR, '../..');

export const ROOT = process.env.TESS_SESSION_ROOT || join(PROFILE_DIR, 'cache', 'support', 'sessions');
// Where Hermes puts an attachment it downloaded. Nothing outside this may be fed to addFile: the source is deleted once
// it is copied, so a path from a message must never be able to point at the profile's own config.
export const INBOUND = resolve(process.env.TESS_UPLOADS_DIR || join(PROFILE_DIR, 'cache'));
export const RECORDS = join(ROOT, 'handoffs.log');

const VIDEO = /\.(mov|mp4|m4v|webm|mkv)$/i;
const IMAGE = /\.(png|jpe?g|heic|gif|webp)$/i;
const TEXT = /\.(txt|log|md|json)$/i;
const have = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };

// A refused path used to be printed back. The shell expands `$TESS_SUPPORT_TOKEN` before this process
// sees the argument, so the refusal must not repeat whatever it was given.
export const scrub = (text) => {
  const token = process.env.TESS_SUPPORT_TOKEN || '';
  let out = String(text ?? '');
  if (token.length >= 8 && out.includes(token)) out = out.split(token).join('[redacted]');
  return out;
};
const refuse = (msg) => { throw new Error(scrub(msg)); };

// Every path this file touches must be a direct child of the session root. The model passes these paths, and a model
// reading a stranger's message is exactly the thing that must not be able to point `handoff` at, say, a home folder.
export const inRoot = (dir) => {
  const r = resolve(String(dir || ''));
  if (dirname(r) !== resolve(ROOT)) throw new Error('that path is not a session folder');
  return r;
};

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
  // Sweep on the way in, not only when the disk is nearly full: a folder left behind by a crashed visit has to go on
  // the next visit, because nothing else runs on a timer.
  sweep();
  // Refuse rather than grow: if the budget is spent even after that, say so.
  if (totalHeld() >= MAX_TOTAL) sweep();
  if (totalHeld() >= MAX_TOTAL) throw new Error(`scratch space is at ${MAX_TOTAL / MB} MB; sweep before starting another session`);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  save(dir, { id, created: Date.now(), files: [] });
  return dir;
};

// A path-string check is only half of it: a symlink inside the uploads folder, aimed at the profile's own `.env`, passes
// the string check and is then read. `realpath` says what the file actually is, so a link out of the folder is refused
// where the string said yes. A hard link is worse: it is not a link to a path, it is a second name for the same bytes,
// and `realpath` cannot tell it apart. A download has exactly one name, so a file with more than one is refused too.
export const inInbound = (file) => {
  const raw = resolve(String(file || ''));
  if (!raw.startsWith(resolve(INBOUND) + '/') || raw.startsWith(resolve(ROOT) + '/')) {
    refuse('that path is not an attachment Hermes downloaded; only a file from the uploads folder can be added');
  }
  let real;
  try { real = realpathSync(raw); } catch { refuse('no such file in the uploads folder'); }
  let inbound;
  try { inbound = realpathSync(INBOUND); } catch { inbound = resolve(INBOUND); }
  if (!real.startsWith(inbound + '/')) {
    refuse('that file is a link, which is not an attachment; only a file from the uploads folder can be added');
  }
  if ((statSync(real).nlink || 1) > 1) {
    refuse('that file is another name for a file outside the uploads folder; only the download itself can be added');
  }
  return raw;
};

export const addFile = (dir, file, { record = false } = {}) => {
  dir = inRoot(dir);
  inInbound(file);                 // before anything is deleted: a refusal must not remove the wrong file
  if (!existsSync(file)) refuse('no such file in the uploads folder');
  // Whatever happens below, the source is gone by the end: refused or accepted, it is Hermes' copy of their upload.
  const dropSource = () => { try { rmSync(String(file), { force: true }); } catch { /* already gone */ } };
  try {
    return addChecked(dir, file);
  } catch (e) {
    dropSource();
    throw e;
  }
};

const addChecked = (dir, file) => {
  const name = file.split('/').pop();
  if (!(VIDEO.test(name) || IMAGE.test(name) || TEXT.test(name))) {
    throw new Error(`"${name}" is not something a person would send: a screenshot (png, jpg, heic), a recording (mov, mp4, webm) or text`);
  }
  let size = statSync(file).size;
  let target = join(dir, name);

  // A file that can't possibly fit is refused before it is copied, not after: a refused file must never be left on
  // disk where nothing will ever clean it up.
  const current = meta(dir).files.reduce((n, f) => n + f.size, 0);
  if (current + size > MAX_SESSION && !VIDEO.test(name)) {
    throw new Error(`this session is already ${Math.round(current / MB)} MB and one file is capped at ${MAX_SESSION / MB} MB in total`);
  }

  // A shrink replaces the target, so "copy the source in" must not then undo it.
  let shrunk = false;
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
      target = out; size = statSync(out).size; shrunk = true;
      if (size > MAX_RECORDING) {
        rmSync(out, { force: true });   // the shrunk copy is no good either; don't leave it behind
        throw new Error(`that recording is still ${Math.round(size / MB)} MB after shrinking; ask for a shorter one.`);
      }
    }
    // Duration is only checkable when ffprobe is there; the size cap still applies either way.
    if (have('ffprobe')) {
      // Only a shrunk file exists at `target` yet; anything else is still at the source until the copy below.
      const probe = shrunk ? target : file;
      const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', probe], { encoding: 'utf8' }).trim());
      if (Number.isFinite(secs) && secs > MAX_MINUTES * 60 + 5) {
        if (shrunk) rmSync(target, { force: true });
        throw new Error(`that recording is ${Math.round(secs)}s; ask for ${MAX_MINUTES} minutes or less`);
      }
    }
  }
  // Everything is checked before anything more is written, and every refusal cleans up after itself.
  const m = meta(dir);
  const held = m.files.reduce((n, f) => n + f.size, 0) + size;
  const cleanup = () => { if (target !== file) rmSync(target, { force: true }); };
  if (held > MAX_SESSION) { cleanup(); throw new Error(`this session would be ${Math.round(held / MB)} MB; one visit is capped at ${MAX_SESSION / MB}`); }
  if (totalHeld() + size > MAX_TOTAL) {
    sweep();
    if (totalHeld() + size > MAX_TOTAL) { cleanup(); throw new Error('scratch space is full; sweep before adding more'); }
  }

  if (target !== file && !shrunk) {
    try { writeFileSync(target, readFileSync(file)); }
    catch (e) { rmSync(target, { force: true }); throw e; }
  }

  m.files.push({ name: target.split('/').pop(), size, at: Date.now() });
  save(dir, m);
  // The source is Hermes' own download of what the person sent. Keeping it would leave their screen on the disk after
  // the hand-off, which is the one thing the whole session budget exists to prevent.
  if (target !== file) rmSync(file, { force: true });
  return { path: target, size };
};

// The hand-off is the point of no return: once the inbox has it, the local copies are a liability, not evidence.
export const handoff = (dir, reportId) => {
  dir = inRoot(dir);
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
  const [cmd, ...args] = process.argv.slice(2);
  const usage = () => {
    console.error('usage: session.mjs new | add <dir> <file> [--record] | handoff <dir> <report id> | sweep | size');
    process.exit(1);
  };
  try {
    if (cmd === 'new') {
      if (args.length) usage();
      console.log(newSession());
    } else if (cmd === 'add') {
      const flags = args.filter((a) => a.startsWith('--'));
      const pos = args.filter((a) => !a.startsWith('--'));
      if (pos.length !== 2 || flags.some((f) => f !== '--record')) usage();
      console.log(JSON.stringify(addFile(pos[0], pos[1], { record: flags.includes('--record') })));
    } else if (cmd === 'handoff') {
      if (args.length !== 2) usage();
      console.log(JSON.stringify(handoff(args[0], args[1])));
    } else if (cmd === 'sweep') {
      if (args.length) usage();
      console.log(JSON.stringify({ removed: sweep() }));
    } else if (cmd === 'size') {
      if (args.length) usage();
      console.log(size());
    } else usage();
  } catch (e) {
    console.error(scrub(e.message));
    process.exit(1);
  }
}
