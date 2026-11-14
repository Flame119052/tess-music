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
//   node support/allowlist.mjs list --as <owner id>
//   node support/allowlist.mjs add 123456789 Sam --as <owner id> [--restart]
//   node support/allowlist.mjs remove 123456789 --as <owner id> [--restart]
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const PROFILE = process.env.TESS_PROFILE || 'tess-support';
export const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), '.hermes');
export const ENV_FILE = process.env.TESS_HERMES_ENV || join(HERMES_HOME, 'profiles', PROFILE, '.env');
const LIST = process.env.TESS_ALLOWLIST || join(HERMES_HOME, 'profiles', PROFILE, 'allow.txt');
const LOG = join(dirname(LIST), 'allow.log');
const OWNER = (process.env.TESS_OWNER_ID || '').trim();
const KEY = 'TELEGRAM_ALLOWED_USERS';

const stop = (msg) => { console.error(msg); process.exit(1); };
const isId = (v) => /^\d{5,15}$/.test(v);

// Every change records who asked for it. The id comes from the message envelope — the platform's own "this person sent
// it" — never from anything typed in the message, and the skill forbids taking it from the text. This is a lock, not a
// wall: the model writes the command line, so someone who talks it into typing the owner's id could still get through.
// That is why the bot holds no GitHub token at all and can only write one report at a time to one inbox, and why every
// change here is logged and echoed to Krish in the same chat.
const askedBy = (() => {
  const i = process.argv.indexOf('--as');
  return i === -1 ? '' : String(process.argv[i + 1] || '').trim();
})();
const requireOwner = (what) => {
  if (!OWNER) stop('Refused: TESS_OWNER_ID is not set, so I cannot tell who is allowed to do this.');
  if (askedBy !== OWNER) stop(`Refused: ${what} is only for the owner.`);
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

const save = (users) => {
  mkdirSync(dirname(LIST), { recursive: true });
  const body = users.map((u) => (u.label ? `${u.id} ${u.label}` : u.id)).join('\n') + (users.length ? '\n' : '');
  const tmp = `${LIST}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
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
  renameSync(tmp, ENV_FILE);
  return line;
};

const argv = process.argv.slice(2);
const restart = argv.includes('--restart');
const [cmd, arg, ...label] = argv.filter((a, i) => a !== '--restart' && a !== '--as' && argv[i - 1] !== '--as');

const users = load();
const audit = (what) => {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${what} by ${askedBy} -> ${users.map((u) => u.id).join(',')}\n`, { mode: 0o600 });
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
  case 'add': {
    requireOwner('adding someone');
    const id = checkId(arg || stop('usage: allowlist.mjs add <id> [label] --as <owner id>'));
    if (users.some((u) => u.id === id)) { report('Already on the list — nothing changed.'); break; }
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
    stop('usage: allowlist.mjs list | add <id> [label] | remove <id> | check <id> --as <owner id>   (add --restart to restart the gateway)');
}

if (restart) {
  try {
    execFileSync('hermes', ['-p', PROFILE, 'gateway', 'restart'], { stdio: 'inherit' });
    console.log('Gateway restarted, so this is live now.');
  } catch {
    console.log('The list is saved but the gateway did not restart. On the server: hermes -p tess-support gateway restart');
  }
} else if (cmd === 'add' || cmd === 'remove') {
  console.log('Live after the next gateway restart: hermes -p tess-support gateway restart');
}
