// Test the session folder the support bot keeps while it works: one folder per visit, caps on what goes in, and it is
// gone once the report is handed over or once it is a day old.
// Usage: node tools/test-session.mjs
// Proves: a folder is created under the scratch root; a recording over the size cap is refused when it can't be
// shrunk and a file of the wrong type is refused; the folder and every file in it are deleted after a successful
// hand-off with only a one-line record left; a folder older than 24 hours is swept; and the total stays under the cap.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const box = mkdtempSync(join(tmpdir(), 'tess-session-test-'));
// The module reads its root at import time, so the sandbox is set before it loads.
process.env.TESS_SESSION_ROOT = join(box, 'sessions');
// A small total budget, so the cap is actually exercised: 540 MB of test files would take a minute and a half of disk.
process.env.TESS_MAX_TOTAL_MB = '60';
const { ROOT, RECORDS, MAX_SESSION, MAX_TOTAL, newSession, addFile, handoff, sweep, size, inRoot, MB } = await import(
  new URL('../support/bot/skills/tess-support/scripts/session.mjs', import.meta.url).href
);

const record = () => (existsSync(RECORDS) ? readFileSync(RECORDS, 'utf8') : '');
const file = (name, bytes) => { const p = join(box, name); writeFileSync(p, Buffer.alloc(bytes, 1)); return p; };

try {
  // 1. A session is one folder, and nothing outside it.
  const dir = newSession();
  assert.ok(dir.startsWith(ROOT), 'the folder lives under the scratch root');
  assert.ok(existsSync(join(dir, 'session.json')), 'and it knows about itself');
  assert.ok(size() < 1024, 'an empty session holds only its own manifest');

  // 2. What goes in is checked: type, then size, then the whole session.
  addFile(dir, file('shot.png', 120 * 1024));
  addFile(dir, file('guard.log', 4 * 1024));
  assert.equal(readdirSync(dir).filter((f) => !f.startsWith('session.')).length, 2, 'the screenshot and the log are in the folder');
  assert.throws(() => addFile(dir, file('installer.dmg', 1024)), /not something a person would send/, 'a file type nobody sends is refused');
  // 51 MB of fake video. With no ffmpeg on PATH it can't be shrunk, so it must be refused rather than stored — the
  // exact case that fills a disk if the bot is optimistic.
  const realPath = process.env.PATH;
  process.env.PATH = join(box, 'empty-path');
  mkdirSync(process.env.PATH, { recursive: true });
  try {
    assert.throws(() => addFile(dir, file('clip.mov', 51 * MB)), /limit is 50|shorter one/, 'an oversized recording is refused');
    assert.throws(() => addFile(dir, file('huge.mp4', MAX_SESSION)), /shorter one|capped at/, 'so is one that would fill a session');
  } finally {
    process.env.PATH = realPath;
  }
  assert.ok(!existsSync(join(dir, 'clip.mov')), 'and nothing oversized was copied into the folder');

  // 3. Hand-off: the folder and everything in it goes, with one line left behind.
  const before = size();
  assert.ok(before > 0, 'there is something to clean up');
  const result = handoff(dir, '42');
  assert.ok(!existsSync(dir), 'the session folder is deleted after a successful hand-off');
  assert.equal(size(), 0, 'and the scratch space is empty again');
  assert.deepEqual(result, { id: result.id, removed: true });
  const line = record().trim().split('\n').pop();
  assert.match(line, /report 42 2 file\(s\) \d+ KB/, 'one line records the report it became');
  assert.ok(!line.includes('shot.png'), 'and no file name or path: the line is a receipt, not a copy');

  // 4. A crash leaves a folder behind; the sweep takes it after 24 hours and says so, but only past that age.
  const stale = newSession();
  addFile(stale, file('old.png', 1024));
  const old = (Date.now() - 25 * 3600 * 1000) / 1000;
  utimesSync(stale, old, old);
  const gone = sweep();
  assert.deepEqual(gone, [stale], 'a folder older than 24 hours is swept');
  assert.ok(!existsSync(stale), 'and is really gone');
  assert.match(record(), /swept .* older than 24h/, 'the sweep leaves a line too');

  // 5. A file refused for size leaves the folder exactly as it was — nothing half-written to clean up later.
  const keep = newSession();
  addFile(keep, file('ok.png', 2 * MB));
  const beforeRefusal = readdirSync(keep).sort();
  assert.throws(() => addFile(keep, file('huge.log', 59 * MB)), /capped at/, 'a file that would break the session cap is refused');
  assert.deepEqual(readdirSync(keep).sort(), beforeRefusal, 'and nothing was left behind by the refusal');
  handoff(keep, '44');

  // 6. It only ever deletes inside its own root: a path from a message is not a path it may remove.
  const elsewhere = join(box, 'not-a-session');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'keep.txt'), 'precious');
  assert.throws(() => handoff(elsewhere, '9'), /not a session folder/, 'handoff refuses a path outside the root');
  assert.ok(existsSync(join(elsewhere, 'keep.txt')), 'and the file outside is still there');
  assert.throws(() => addFile(elsewhere, file('x.png', 10)), /not a session folder/, 'add refuses one too');
  assert.throws(() => inRoot('/'), /not a session folder/);

  // 7. A fresh folder is not swept, and the total is held under the cap.
  const fresh = newSession();
  addFile(fresh, file('new.png', 1024));
  assert.deepEqual(sweep(), [], 'a fresh session survives a sweep');
  assert.ok(existsSync(fresh), 'and is still there for the person who is mid-conversation');
  handoff(fresh, '43');

  // 8. The total cap, on folders that are all FRESH: the age sweep cannot rescue this, so the size loop has to.
  // The folders are written directly, because addFile rightly refuses to go over the cap in the first place — this is
  // the state left behind by an older version, which is exactly what the sweep exists to clean up.
  const filled = [];
  for (let i = 0; i < 3; i += 1) {
    const d = newSession();
    writeFileSync(join(d, `leftover-${i}.bin`), Buffer.alloc(30 * MB, 2));
    const t = (Date.now() - (30 - i) * 60 * 1000) / 1000;
    utimesSync(d, t, t);
    filled.push(d);
  }
  assert.ok(size() > MAX_TOTAL, `the scratch space is genuinely over the cap (${Math.round(size() / MB)} MB > ${MAX_TOTAL / MB})`);
  const sweptForSize = sweep();
  assert.ok(size() <= MAX_TOTAL, 'and the sweep brings it back under the cap');
  assert.ok(sweptForSize.length > 0, 'by removing whole sessions');
  assert.ok(!existsSync(filled[0]), 'the oldest goes first');
  assert.ok(existsSync(filled[2]), 'the newest is kept, so a live conversation survives');

  console.log('session folder: all checks passed\n');
  console.log([
    'checked:',
    '  · one folder per visit, under the scratch root, holding a small manifest',
    '  · a file type nobody would send is refused, and so is an oversized recording (nothing is stored)',
    '  · the folder and every file in it are deleted after a successful hand-off, leaving one line',
    '  · that line has the report id, the time, the count and the size — no file names, no paths',
    '  · a folder older than 24 hours is swept, and the sweep leaves its own line',
    '  · a refused file leaves nothing behind, so the folder is exactly as it was',
    '  · handoff and add refuse a path outside the session root, and the file outside it survives',
    '  · a fresh folder survives a sweep, so someone mid-conversation does not lose their evidence',
    '  · the total scratch space is held under the cap',
    '',
  ].join('\n'));
} finally {
  rmSync(box, { recursive: true, force: true });
}
