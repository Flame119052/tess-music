#!/usr/bin/env node
// The Spotify window, and nothing else. The model runs this file; it does not
// get a shell line that can grow -D (the whole display) or -G (the microphone).
//   $HERMES_HOME/runtime/node/bin/node spotify-window.mjs                         prints the window id
//   $HERMES_HOME/runtime/node/bin/node spotify-window.mjs still <session>/spotify.png
//   $HERMES_HOME/runtime/node/bin/node spotify-window.mjs video <session>/spotify.mov
// A still uses screencapture -l, which is the window. A recording can never
// take that path: its video flag ignores -l and records the whole display.
// Video comes
// only from the tess-record helper (TESS_RECORD), which captures that one
// window. No helper, no video: there is no display-wide fallback.
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { inRoot, scrub } from '../../tess-support/scripts/session.mjs';

const die = (msg) => { console.error(scrub(msg)); process.exit(1); };

// The same lookup the skill used to inline. It stays in this file so the
// approved command is `$HERMES_HOME/runtime/node/bin/node <this file>`, not an osascript -e line.
// CGPreflightScreenCaptureAccess does not prompt. Without it, screencapture can
// exit 0 and write a blank or wallpaper-only picture. The window list itself
// does not need the permission, so the check has to happen before that list.
const LOOKUP = 'ObjC.import("CoreGraphics"); if (!$.CGPreflightScreenCaptureAccess()) throw new Error("Screen Recording is not allowed"); const rows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0)); const hit = rows.find((w) => w.kCGWindowOwnerName === "Spotify" && w.kCGWindowLayer === 0); if (!hit) throw new Error("no Spotify window"); hit.kCGWindowNumber;';

const recordingDenied = () => process.env.TESS_TEST === '1' && process.env.TESS_SCREEN_RECORDING === 'denied';

const windowId = () => {
  // The test double stands in for a Mac that has not allowed Screen Recording.
  // A real visit does not set it, and LOOKUP calls the preflight itself.
  if (recordingDenied()) die('Screen Recording is not allowed');
  let out;
  try {
    out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', LOOKUP], { encoding: 'utf8' });
  } catch (err) {
    const detail = scrub(String(err.stderr || err.message || ''));
    if (detail.includes('no Spotify window')) die('no Spotify window');
    die('Screen Recording is not allowed');
  }
  const id = String(out).trim();
  if (!/^\d+$/.test(id)) die('no Spotify window');
  return id;
};

const capturePath = (out, name, label) => {
  if (!out || out.startsWith('-') || out.split(/[/\\]/).includes('..')) die(`the ${label} must be <session>/${name}`);
  let session;
  try { session = inRoot(dirname(out)); } catch (err) { die(err.message); }
  let dirStat;
  try { dirStat = lstatSync(session); } catch { die('that path is not a session folder'); }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) die('refusing to follow a link');
  if (basename(resolve(out)) !== name) die(`the ${label} must be named ${name}`);
  const dest = resolve(out);
  if (dirname(dest) !== session) die(`the ${label} must be named ${name}`);
  try {
    if (lstatSync(dest).isSymbolicLink()) die('refusing to follow a link');
  } catch (err) {
    if (err.code !== 'ENOENT') die('refusing to follow a link');
  }
  return dest;
};
const stillPath = (out) => capturePath(out, 'spotify.png', 'still');
const videoPath = (out) => capturePath(out, 'spotify.mov', 'recording');

const [mode, out, extra] = process.argv.slice(2);
if (process.argv.length === 2) {
  process.stdout.write(`${windowId()}\n`);
} else if (!extra && mode === 'still' && out) {
  const dest = stillPath(out);
  if (recordingDenied()) die('Screen Recording is not allowed');
  // Tests pass a fake picture. A real visit never sets TESS_FAKE_CAPTURE, so this stays the real capture.
  if (process.env.TESS_TEST === '1' && process.env.TESS_FAKE_CAPTURE === '1') {
    // The consent test overlaps two captures. A real visit never sets these.
    const log = process.env.TESS_CAPTURE_LOG;
    if (log) appendFileSync(log, '1\n');
    const delay = Number(process.env.TESS_CAPTURE_DELAY_MS || '0');
    if (Number.isFinite(delay) && delay > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    try { writeFileSync(dest, png, { mode: 0o600 }); }
    catch { die('cannot write the still'); }
  } else {
    execFileSync('/usr/sbin/screencapture', ['-x', '-l', windowId(), dest], { stdio: 'inherit' });
  }
} else if (!extra && mode === 'video' && out) {
  const dest = videoPath(out);
  // TESS_RECORD names the only program allowed to write video, and the helper
  // checks the window belongs to Spotify itself. Without it there is no way to
  // record the window alone, so this stops rather than reach for the display.
  const helper = process.env.TESS_RECORD;
  if (!helper || helper.includes('..')) die('this profile cannot record the window');
  if (recordingDenied()) die('Screen Recording is not allowed');
  if (process.env.TESS_TEST === '1' && process.env.TESS_FAKE_CAPTURE === '1') {
    try { writeFileSync(dest, Buffer.from('tess-fake-recording'), { mode: 0o600 }); }
    catch { die('cannot write the recording'); }
  } else {
    try {
      execFileSync(helper, [windowId(), dest], { stdio: 'inherit' });
    } catch (err) {
      die(scrub(String(err.stderr || err.message || 'the recording failed')));
    }
  }
} else {
  die('usage: spotify-window.mjs [still <session>/spotify.png] [video <session>/spotify.mov]');
}
