#!/usr/bin/env node
// Who is allowed to message the Tess support bot, and the only place the list is changed.
//
// Hermes enforces the list itself, before the model is called: TELEGRAM_ALLOWED_USERS in the bot profile's .env, and a
// gateway with no list denies everyone. This script exists so adding or removing a person is a two-word command Krish
// can type in Telegram, and so the rules can't be talked around by whoever is on the other end of the chat: it refuses a
// wildcard, refuses anything that isn't a numeric id, refuses to remove Krish, and never writes a phone number anywhere
// (Telegram ids are integers, not phone numbers).
//
// Runs on the server, where Node exists — not on anyone's Mac.
//
//   node allowlist.mjs list
//   node allowlist.mjs add 123456789 Sam [--restart]
//   node allowlist.mjs remove 123456789 [--restart]
//
// Run it ON THE SERVER, as the account that owns the bot (over SSH). It is not reachable from chat.
import { appendFileSync, chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// This file lives at <profile>/skills/tess-support/scripts/allowlist.mjs. Deriving the profile from where it sits beats
// assuming `$HERMES_HOME=~/.hermes`: if Hermes ever points HERMES_HOME at the profile directory, an assumed path writes
// a nested .env that the gateway never reads, and nothing reports a failure.
const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE_DIR = process.env.TESS_PROFILE_DIR || resolve(HERE, '../../..');
export const HERMES_HOME = process.env.HERMES_HOME_DIR || resolve(PROFILE_DIR, '../..');
const PROFILE = process.env.TESS_PROFILE || PROFILE_DIR.split('/').pop();
export const ENV_FILE = process.env.TESS_HERMES_ENV || join(PROFILE_DIR, '.env');
const LIST = process.env.TESS_ALLOWLIST || join(PROFILE_DIR, 'allow.txt');
const LOG = join(dirname(LIST), 'allow.log');
// Run over SSH, the environment is a fresh shell: the owner id lives in the profile's .env, not in it. The documented
// commands therefore failed with "TESS_OWNER_ID is not set". Read that file for anything the environment doesn't have.
const profileEnv = () => {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
};
const fromProfile = profileEnv();
const OWNER = (process.env.TESS_OWNER_ID || fromProfile.TESS_OWNER_ID || '').trim();
const KEY = 'TELEGRAM_ALLOWED_USERS';

const stop = (msg) => { console.error(msg); process.exit(1); };
const isId = (v) => /^\d{5,15}$/.test(v);

// There is no in-chat admin command any more, on purpose. The gate is **shell access to this machine**: Krish runs this
// file over SSH as the bot user (or via sudo), and the bot's own process cannot change who is allowed because the
// unit marks `.env` and `allow.txt` read-only to it. An argument the model types proves nothing, so nothing here trusts
// one: `--as` is accepted only to record who ran it.
const askedBy = (() => {
  const i = process.argv.indexOf('--as');
  return i === -1 ? '' : String(process.argv[i + 1] || '').trim();
})();
// No owner check on the argument: over SSH the operator already is the owner. What stops anyone else is the kernel —
// the unit marks these files read-only to the bot — so a check here would be theatre.
const requireOwner = (what) => {
  if (!OWNER) stop('Refused: TESS_OWNER_ID is not set, so I cannot tell whose list this is.');
  void what;
};

const checkId = (v) => {
  if (v === '*') stop('Refused: "*" would let anyone message the bot. Add people one id at a time.');
  if (/^\+\d/.test(v) || /\s/.test(v) || /^@/.test(v)) stop(`Refused: "${v}" is not a Telegram user id. It is a number, like 123456789 — get it from @userinfobot.`);
  if (!isId(v)) stop(`Refused: "${v}" is not a Telegram user id (5–15 digits).`);
  return v;
};

const load = () => (existsSync(LIST)
  ? readFileSync(LIST, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [id, ...rest] = l.split(/\s+/);
    return { id, label: rest.join(' ') };
  }).filter((u) => isId(u.id))
  : []);

const preserveOwner = (tmp, target) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    try {
      const ref = existsSync(target) ? target : PROFILE_DIR;
      if (existsSync(ref)) {
        const st = statSync(ref);
        chownSync(tmp, st.uid, st.gid);
      }
    } catch { /* best-effort ownership preservation */ }
  }
};

const save = (users) => {
  mkdirSync(dirname(LIST), { recursive: true });
  const body = users.map((u) => (u.label ? `${u.id} ${u.label}` : u.id)).join('\n') + (users.length ? '\n' : '');
  const tmp = `${LIST}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  preserveOwner(tmp, LIST);
  renameSync(tmp, LIST);          // atomic: a reader never sees half a list
};

// The .env keeps everything else exactly as it was; only that one line changes. Hermes reads it at gateway start.
const writeEnv = (users) => {
  const line = `${KEY}=${users.map((u) => u.id).join(',')}`;
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const re = new RegExp(`^${KEY}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  const tmp = `${ENV_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  preserveOwner(tmp, ENV_FILE);
  renameSync(tmp, ENV_FILE);
  return line;
};

const envInSync = (users) => {
  if (!existsSync(ENV_FILE)) return false;
  const expected = `${KEY}=${users.map((u) => u.id).join(',')}`;
  return new RegExp(`^${expected}$`, 'm').test(readFileSync(ENV_FILE, 'utf8'));
};

const argv = process.argv.slice(2);
const restart = argv.includes('--restart');
const [cmd, arg, ...label] = argv.filter((a, i) => a !== '--restart' && a !== '--as' && argv[i - 1] !== '--as');

const users = load();
const audit = (what) => {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${what} by ${askedBy} -> ${users.map((u) => u.id).join(',')}\n`, { mode: 0o600 });
    preserveOwner(LOG, LIST);
  } catch { /* a log that can't be written must not stop the change */ }
};
const report = (line) => {
  const n = users.length;
  console.log(`${n} ${n === 1 ? 'person is' : 'people are'} allowed${n ? `: ${users.map((u) => u.label ? `${u.label} (${u.id})` : u.id).join(', ')}` : ''}.`);
  if (!n) console.log('Nobody can message the bot right now. That is the safe default, not an error.');
  if (line) console.log(line);
};

switch (cmd) {
  case 'list':
    requireOwner('listing who is allowed');
    report();
    console.log(`${KEY} in ${ENV_FILE}: ${existsSync(ENV_FILE) && new RegExp(`^${KEY}=`, 'm').test(readFileSync(ENV_FILE, 'utf8')) ? 'set' : 'not set yet'}`);
    break;
  case 'check':
    requireOwner('checking the list');
    if (users.some((u) => u.id === checkId(arg || stop('usage: allowlist.mjs check <id> --as <owner id>')))) { console.log('allowed'); break; }
    console.log('not allowed'); process.exit(1);
    break;
  case 'sync':
    requireOwner('syncing the list');
    writeEnv(users);
    report(`${KEY} synced.`);
    break;
  case 'add': {
    requireOwner('adding someone');
    const id = checkId(arg || stop('usage: allowlist.mjs add <id> [label] --as <owner id>'));
    if (users.some((u) => u.id === id)) {
      if (!envInSync(users)) { writeEnv(users); report(`Already on the list — ${KEY} synced.`); break; }
      report('Already on the list — nothing changed.');
      break;
    }
    users.push({ id, label: String(label.join(' ')).replace(/[^\w .'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) });
    save(users); writeEnv(users); audit('add');
    report(`Added. ${KEY} rewritten.`);
    break;
  }
  case 'remove': {
    requireOwner('removing someone');
    const id = checkId(arg || stop('usage: allowlist.mjs remove <id> --as <owner id>'));
    if (OWNER && id === OWNER) stop('Refused: that is your own id. Removing it would lock you out of your own bot.');
    if (!users.some((u) => u.id === id)) { report('Not on the list — nothing changed.'); break; }
    const kept = users.filter((u) => u.id !== id);
    users.length = 0; users.push(...kept);
    save(users); writeEnv(users); audit('remove');
    report(`Removed. ${KEY} rewritten.`);
    break;
  }
  default:
    stop('usage: allowlist.mjs list | add <id> [label] | remove <id> | check <id> | sync --as <owner id>   (add --restart to restart the gateway)');
}

if (restart) {
  // Under systemd the gateway runs in the foreground as a unit; `hermes gateway restart` there would try to start a
  // second gateway on the same session store, which is the one thing the README warns against. Restart the unit.
  // Under systemd the bot user cannot run `systemctl restart` (polkit refuses it), and even if it could, that would kill
  // the very process group doing the asking. Signalling the main PID reads the unit, which needs no privilege, and the
  // unit's Restart=always brings it straight back with the new list.
  const mainPid = () => {
    try {
      const out = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', 'tess-support'], { encoding: 'utf8' }).trim();
      return /^[1-9]\d*$/.test(out) ? Number(out) : 0;
    } catch { return 0; }
  };
  try {
    const pid = mainPid();
    if (pid) {
      process.kill(pid, 'SIGTERM');
      console.log(`Signalled the gateway (pid ${pid}); systemd starts it again with this list, so it is live in a moment.`);
    } else {
      execFileSync('hermes', ['-p', PROFILE, 'gateway', 'restart'], { stdio: 'inherit' });
      console.log('Gateway restarted, so this is live now.');
    }
  } catch {
    console.log('The list is saved but nothing restarted. On the server: systemctl restart tess-support (or hermes -p tess-support gateway restart)');
  }
} else if (cmd === 'add' || cmd === 'remove') {
  console.log('Live after the next restart: systemctl restart tess-support (or hermes -p tess-support gateway restart)');
}
