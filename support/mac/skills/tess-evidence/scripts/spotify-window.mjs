#!/usr/bin/env node
// The Spotify window, and nothing else. The model runs this file; it does not
// get a shell line that can grow -D (the whole display) or -G (the microphone).
//   node spotify-window.mjs                         prints the window id
//   node spotify-window.mjs still <session>/spotify.png
//   node spotify-window.mjs video $HERMES_HOME/cache/support/spotify.mov   eight silent seconds
//   (the cache, not the session: session.mjs add only accepts a file from the cache)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const die = (msg) => { console.error(msg); process.exit(1); };

// The same lookup the skill used to inline. It stays in this file so the
// approved command is `node <this file>`, not an osascript -e line.
const LOOKUP = 'ObjC.import("CoreGraphics"); const rows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0)); const hit = rows.find((w) => w.kCGWindowOwnerName === "Spotify" && w.kCGWindowLayer === 0); if (!hit) throw new Error("no Spotify window"); hit.kCGWindowNumber;';

const windowId = () => {
  let out;
  try {
    out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', LOOKUP], { encoding: 'utf8' });
  } catch (err) {
    const detail = String(err.stderr || err.message || '');
    if (detail.includes('no Spotify window')) die('no Spotify window');
    die('Screen Recording is not allowed');
  }
  const id = String(out).trim();
  if (!/^\d+$/.test(id)) die('no Spotify window');
  return id;
};

const [mode, out, extra] = process.argv.slice(2);
if (process.argv.length === 2) {
  process.stdout.write(`${windowId()}\n`);
} else if (!extra && (mode === 'still' || mode === 'video') && out && !out.startsWith('-')) {
  // Tests pass both. A real visit never sets TESS_FAKE_CAPTURE, so this stays the real capture.
  if (process.env.TESS_TEST === '1' && process.env.TESS_FAKE_CAPTURE === '1') {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    try { writeFileSync(out, mode === 'still' ? png : Buffer.from('tess-fake-mov')); }
    catch { die(`cannot write ${out}`); }
  } else {
    const args = ['-x', '-l', windowId()];
    if (mode === 'video') args.push('-V', '8');
    args.push(out);
    execFileSync('/usr/sbin/screencapture', args, { stdio: 'inherit' });
  }
} else {
  die('usage: spotify-window.mjs [still <out.png> | video <out.mov>]');
}
