#!/usr/bin/env node
// The bot's only way to the inbox.
//
// The shell it runs in is driven by a model reading a stranger's message, so the posting token must never be part of a
// command: it is read from the bot's own environment here, the destination is fixed by this file, and a payload that
// carries something token-shaped is refused before it is sent. A message can change what a person types; it cannot
// change what this script will do with it.
//
//   node inbox.mjs report <session dir>           POST <dir>/payload.json and print the report id
//   node inbox.mjs recording <report id> <file>   PUT one recording against that report
//   node inbox.mjs issues                         GET the open issue titles
//   node inbox.mjs … --dry-run                    say where it would go, send nothing
// Exit 1 with one plain sentence when it refuses or the inbox answers badly. Nothing here reads a person's text; the
// payload is whatever triage wrote.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { inRoot } from './session.mjs';

// The one address this bot posts to. Not a variable a message can steer: a redirected host would take the token with it.
const HOST = 'tess-music-player.janus.ing';
// A test points it at its own loopback server, and only when TESS_TEST is set on that machine.
const TEST_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MAX_RECORDING = 50 * 1024 * 1024;
const VIDEO = { '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
// A token has shapes, and none of them may leave in a report: the two this machine holds, and the general API-key one.
const SECRET_SHAPES = [
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/,
  /\btess_[0-9a-f]{32,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

const die = (msg) => { console.error(msg); process.exit(1); };
const dry = process.argv.includes('--dry-run');
const [cmd, one, two] = process.argv.slice(2).filter((a) => a !== '--dry-run');

const inbox = () => {
  const raw = process.env.TESS_INBOX || `https://${HOST}`;
  let url;
  try { url = new URL(raw); } catch { die(`TESS_INBOX is not an address: ${raw}`); }
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
const noSecrets = (text, what) => {
  for (const re of SECRET_SHAPES) {
    if (re.test(text)) die(`${what} carries something that looks like a token. Retype it with that part blanked out.`);
  }
  const own = process.env.TESS_SUPPORT_TOKEN || '';
  if (own && text.includes(own)) die(`${what} carries this bot's own posting token. That never leaves, not even to the inbox.`);
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

// A recording is only ever read from this visit's folder, so a path in a message cannot point it at anything else.
const sessionFile = (p) => {
  const dir = inRoot(dirname(resolve(String(p || ''))));
  const file = join(dir, basename(resolve(String(p))));
  if (!existsSync(file)) die(`no such file: ${file}`);
  return file;
};

if (cmd === 'report') {
  if (!one) die('usage: inbox.mjs report <session dir>');
  const dir = inRoot(one);
  const file = join(dir, 'payload.json');
  if (!existsSync(file)) die(`no payload at ${file}: triage writes it with --mode inbox`);
  const body = readFileSync(file, 'utf8');
  noSecrets(body, 'the report');
  const out = await send('POST', '/v1/support', { body, type: 'application/json', auth: true });
  if (dry) process.exit(0);
  let id = null;
  try { id = JSON.parse(out.text).id; } catch { /* answered 201 with something else */ }
  console.log(id == null ? out.text.trim() : `report id: ${id}`);
} else if (cmd === 'recording') {
  if (!/^\d+$/.test(String(one || ''))) die('usage: inbox.mjs recording <report id> <file>');
  const file = sessionFile(two);
  const type = VIDEO[extname(file).toLowerCase()];
  if (!type) die('a recording must be .mov, .mp4, .webm or .mkv');
  const size = statSync(file).size;
  if (size > MAX_RECORDING) die(`that recording is ${Math.round(size / 1048576)} MB; the limit is ${MAX_RECORDING / 1048576}`);
  const out = await send('PUT', `/v1/support/recording/${one}`, { body: readFileSync(file), type, auth: true });
  if (dry) process.exit(0);
  console.log(`recording stored (${out.status})`);
} else if (cmd === 'issues') {
  const out = await send('GET', '/v1/issues');
  if (dry) process.exit(0);
  console.log(out.text.slice(0, 200000));
} else {
  die('usage: inbox.mjs report <session dir> | recording <report id> <file> | issues [--dry-run]');
}
