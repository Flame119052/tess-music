#!/usr/bin/env node
// The bot's only way to the inbox.
//
// The shell it runs in is driven by a model reading a stranger's message, so the posting token must never be part of a
// command: it is read from the bot's own environment here, the destination is fixed by this file, and a payload that
// carries something token-shaped is refused before it is sent. A message can change what a person types; it cannot
// change what this script will do with it.
//
//   node inbox.mjs report <session dir>           POST <dir>/payload.json and print the report id
//   node inbox.mjs recording <report id> <file>   PUT one recording or still against that report
//   node inbox.mjs issues                         GET the open issue titles
//   node inbox.mjs … --dry-run                    say where it would go, send nothing
// Exit 1 with one plain sentence when it refuses or the inbox answers badly. Nothing here reads a person's text; the
// payload is whatever triage wrote.
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { inRoot, scrub } from './session.mjs';
import { SECRET_SHAPES, stripInvisible } from './privacy.mjs';

// The one address this bot posts to. Not a variable a message can steer: a redirected host would take the token with it.
const HOST = 'tess-music-player.janus.ing';
// A test points it at its own loopback server, and only when TESS_TEST is set on that machine.
const TEST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_RECORDING = 50 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const VIDEO = { '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const die = (msg) => { console.error(scrub(msg)); process.exit(1); };
const dry = process.argv.includes('--dry-run');
const [cmd, one, two] = process.argv.slice(2).filter((a) => a !== '--dry-run');

const inbox = () => {
  const raw = process.env.TESS_INBOX || `https://${HOST}`;
  let url;
  try { url = new URL(raw); } catch { die('TESS_INBOX is not an address'); }
  const local = process.env.TESS_TEST === '1' && url.protocol === 'http:' && TEST_HOSTS.has(url.hostname);
  if (!local && !(url.protocol === 'https:' && url.hostname === HOST)) {
    die(`${url.hostname} is not the Tess inbox. This bot posts to ${HOST} and nowhere else.`);
  }
  if (url.username || url.password) die('TESS_INBOX must not carry a username or password');
  if (url.pathname !== '/' && url.pathname !== '') die(`TESS_INBOX must be the inbox itself, not a page on it: ${url.pathname}`);
  return url.origin;
};

const token = () => {
  const t = process.env.TESS_SUPPORT_TOKEN || '';
  if (!t) die('TESS_SUPPORT_TOKEN is missing: this bot cannot post without it');
  return t;
};

// The last gate before something leaves the machine: a report that picked up a token on the way here is not sent.
// The shapes are the shared ones, and the text is looked at with every invisible character removed first, because a
// token split by one is two harmless-looking halves to a pattern.
const noSecrets = (text, what) => {
  const shown = stripInvisible(text);
  for (const re of SECRET_SHAPES) {
    if (re.test(shown)) die(`${what} carries something that looks like a token. Retype it with that part blanked out.`);
  }
  const own = process.env.TESS_SUPPORT_TOKEN || '';
  if (own && shown.includes(own)) die(`${what} carries this bot's own posting token. That never leaves, not even to the inbox.`);
};

const send = async (method, path, { body, type, auth } = {}) => {
  const where = inbox();
  if (dry) {
    console.log(`${method} ${where}${path}${type ? ` as ${type}` : ''}${auth ? ', with this bot\'s token in a header' : ''}`);
    return null;
  }
  const headers = { ...(type ? { 'content-type': type } : {}), ...(auth ? { authorization: `Bearer ${token()}` } : {}) };
  let res;
  try {
    res = await fetch(where + path, { method, headers, body });
  } catch (e) {
    die(`could not reach the inbox: ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) die(`the inbox answered ${res.status}${text ? `: ${text.trim().slice(0, 200)}` : ''}`);
  return { status: res.status, text };
};

// A file the bot sends is only ever read from this visit's folder, and only when it is really a file that is there. A
// path string is not enough: a `clip.mov` inside the session that is a symlink to the bot's own `.env`, a second name
// for it (a hard link, which `realpath` cannot tell apart), or a `payload.json` pointed anywhere at all, used to be
// read and sent. So the real path must be inside the session, the file must have exactly one name, and the bytes come
// from the handle that passed those checks, so nothing can be swapped in between the check and the read.
const readSession = (dir, name, missing, max = Infinity) => {
  let session;
  try { session = realpathSync(inRoot(dir)); } catch (e) { die(e.message); }
  const wanted = join(session, basename(String(name || '')));
  let lst;
  try { lst = lstatSync(wanted); } catch { die(missing || 'no such file in the session folder'); }
  if (!lst.isFile() || lst.nlink > 1) {
    die(`${basename(wanted)} is not a plain file of this session: a link, or a file with another name, is not something this bot wrote`);
  }
  const real = realpathSync(wanted);
  if (!real.startsWith(session + '/')) die(`${basename(wanted)} leads outside the session folder`);
  const fd = openSync(real, 'r');
  try {
    const st = fstatSync(fd);
    // The name was checked above; this proves the bytes about to be read are the same file the checks passed.
    if (!st.isFile() || st.ino !== lst.ino || st.dev !== lst.dev) die(`${basename(wanted)} changed while it was being read`);
    if (st.size > max) return { tooBig: st.size };
    return { bytes: readFileSync(fd), size: st.size };
  } finally { closeSync(fd); }
};

if (cmd === 'report') {
  if (!one) die('usage: inbox.mjs report <session dir>');
  const body = readSession(one, 'payload.json', 'no payload in the session folder: triage writes it with --mode inbox').bytes.toString('utf8');
  noSecrets(body, 'the report');
  const out = await send('POST', '/v1/support', { body, type: 'application/json', auth: true });
  if (dry) process.exit(0);
  let id = null;
  try { id = JSON.parse(out.text).id; } catch { /* answered 201 with something else */ }
  console.log(id == null ? out.text.trim() : `report id: ${id}`);
} else if (cmd === 'recording') {
  if (!/^\d+$/.test(String(one || ''))) die('usage: inbox.mjs recording <report id> <file>');
  const name = basename(resolve(String(two || '')));
  const ext = extname(name).toLowerCase();
  const type = VIDEO[ext] || IMAGE[ext];
  if (!type) die('send a .mov, .mp4, .webm or .mkv recording, or a .png or .jpg still');
  const cap = IMAGE[ext] ? MAX_IMAGE : MAX_RECORDING;
  const what = IMAGE[ext] ? 'picture' : 'recording';
  const got = readSession(dirname(resolve(String(two || ''))), name, 'no such file in the session folder', cap);
  if (got.tooBig) die(`that ${what} is ${Math.round(got.tooBig / 1048576)} MB; the limit is ${cap / 1048576}`);
  const out = await send('PUT', `/v1/support/recording/${one}`, { body: got.bytes, type, auth: true });
  if (dry) process.exit(0);
  console.log(`${what} stored (${out.status})`);
} else if (cmd === 'issues') {
  const out = await send('GET', '/v1/issues');
  if (dry) process.exit(0);
  console.log(out.text.slice(0, 200000));
} else {
  die('usage: inbox.mjs report <session dir> | recording <report id> <file> | issues [--dry-run]');
}
