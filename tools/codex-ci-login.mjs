#!/usr/bin/env node
// Create or renew the ChatGPT-plan login the hosted reviewer uses, without touching the login on this Mac.
//
// Why a separate CODEX_HOME: a ChatGPT-plan login is an `auth.json` holding a refresh token, and refreshing it can rotate
// that token. The scheduled workflow (D-111) is what renews the secret. This script is the fallback for when that
// refresh is broken: run it only after the codex-refresh schedule is off. Uploading this folder while the schedule is
// on replaces the rotated secret with a stale copy. `~/.codex` is never read or written.
//
// Usage:
//   node tools/codex-ci-login.mjs            # sign in if needed, then upload the secret
//   node tools/codex-ci-login.mjs --check    # only say whether the stored login still has life in it
//
// It never prints a token, a refresh token or the account id. It prints the expiry date and how long is left, which is all
// that is needed to decide whether to run it.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const repo = process.env.TESS_REPO || 'Flame119052/tess-music';
const home = process.env.TESS_CODEX_CI_HOME || join(homedir(), '.config', 'tess-codex-ci');
const authPath = join(home, 'auth.json');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

const say = (line) => console.log(line);

function readAuth() {
  if (!existsSync(authPath)) return null;
  try {
    return JSON.parse(readFileSync(authPath, 'utf8'));
  } catch {
    return null;
  }
}

// The access token's expiry is the only number that matters: the review refuses to start close to it, so renewing a few
// days ahead is what keeps Codex usable. A token that is not a readable JWT is treated as unusable, the same way the
// reviewer treats it.
function expiryOf(auth) {
  const token = auth?.tokens?.access_token;
  if (typeof token !== 'string') return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function describe(expiresAt) {
  if (expiresAt === null) return 'no readable expiry (sign in again)';
  const hours = (expiresAt - Date.now()) / (60 * 60 * 1000);
  const when = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  if (hours <= 0) return `expired at ${when}`;
  if (hours < 48) return `expires ${when} (in ${Math.max(1, Math.round(hours))}h) — renew now`;
  return `expires ${when} (in ${Math.round(hours / 24)} days)`;
}

function deviceLogin() {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try { chmodSync(home, 0o700); } catch { /* already tight */ }
  say(`Signing in to the ChatGPT plan in ${home} (your ~/.codex login is left alone).`);
  say('Follow the printed URL and enter the code; nothing is printed back here.');
  // CODEX_HOME is what keeps this login separate: every codex command below reads and writes only that folder.
  const result = spawnSync('codex', ['login', '--device-auth'], {
    stdio: 'inherit',
    env: { ...process.env, CODEX_HOME: home },
  });
  if (result.status !== 0) {
    throw new Error('codex login did not finish; run `codex login --device-auth` yourself with CODEX_HOME set to this folder');
  }
}

const auth = readAuth();
const mode = auth?.auth_mode;
if (auth && mode && mode !== 'chatgpt') {
  console.error(`The stored login in ${home} is not a ChatGPT plan login (auth_mode=${mode}). Delete that folder and run this again; an API key must never be the reviewer's login.`);
  process.exit(1);
}
const expiresAt = expiryOf(auth);

if (checkOnly) {
  say(auth ? `Codex CI login: ${describe(expiresAt)}` : 'Codex CI login: none yet — run without --check to sign in');
  process.exit(auth && expiresAt !== null && expiresAt > Date.now() ? 0 : 1);
}

// A login inside the reviewer's own 12-hour safety margin is renewed rather than uploaded: the job would refuse it.
const marginMs = 12 * 60 * 60 * 1000;
if (!auth || expiresAt === null || expiresAt - Date.now() < marginMs) {
  deviceLogin();
}

const fresh = readAuth();
if (!fresh) throw new Error(`no login was written to ${authPath}`);
const freshExpiry = expiryOf(fresh);
if (freshExpiry === null || freshExpiry <= Date.now()) throw new Error('the new login has no usable access token');

// `codex login status` is the CLI's own check; it catches a file that exists but was never completed.
// It prints to stderr (0.167), so both streams are read.
const statusRun = spawnSync('codex', ['login', 'status'], {
  encoding: 'utf8',
  env: { ...process.env, CODEX_HOME: home },
});
const status = `${statusRun.stdout || ''}${statusRun.stderr || ''}`;
if (!/ChatGPT/i.test(status)) {
  throw new Error(`codex reports "${status.trim()}" instead of a ChatGPT login; not uploading that`);
}

// The secret is the auth.json itself. It goes to `gh` on stdin, so it never appears in a shell argument or a process list.
const raw = readFileSync(authPath, 'utf8');
execFileSync('gh', ['secret', 'set', 'CODEX_AUTH_JSON', '-R', repo], { input: raw, stdio: ['pipe', 'inherit', 'inherit'] });
writeFileSync(join(home, '.uploaded'), new Date().toISOString());
say(`Uploaded CODEX_AUTH_JSON to ${repo}. ${describe(freshExpiry)}.`);
say('Leave this copy alone while the codex-refresh schedule is on. Uploading it again replaces the rotated secret.');
