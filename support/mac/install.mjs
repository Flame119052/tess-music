#!/usr/bin/env node
// Install the Mac tess-support profile into a scratch HERMES_HOME.
// Refuses the real login home. Writes .env with the support token only — never an OpenCode key.
// Uses `hermes profile install` when that command actually runs, and copies the profile otherwise.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const src = join(root, 'support/mac');
const scripts = ['privacy.mjs', 'triage.mjs', 'inbox.mjs', 'session.mjs'];

const die = (msg) => { console.error(msg); process.exit(1); };

const loginHome = () => {
  try {
    const user = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).trim();
    if (!/^[\w.-]+$/.test(user)) return null;
    const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('NFSHomeDirectory:'));
    const dir = line?.slice('NFSHomeDirectory:'.length).trim();
    return dir && dir.startsWith('/') ? resolve(dir) : null;
  } catch {
    return null;
  }
};

const inside = (path, rootDir) => path === rootDir || path.startsWith(`${rootDir}/`);

const scratchHome = () => {
  const raw = process.env.HERMES_HOME;
  if (!raw) die('Set HERMES_HOME to a scratch directory. This installer will not use the real home.');
  const chosen = resolve(raw);
  const login = loginHome();
  if (login && inside(chosen, login)) die(`HERMES_HOME is inside the real home folder (${login}). Use a scratch directory.`);
  mkdirSync(chosen, { recursive: true });
  const real = realpathSync(chosen);
  if (login && inside(real, login)) die(`HERMES_HOME is inside the real home folder (${login}). Use a scratch directory.`);
  return real;
};

const home = scratchHome();

const token = process.env.TESS_SUPPORT_TOKEN || '';
if (!token || /[\r\n]/.test(token)) die('TESS_SUPPORT_TOKEN is missing');
if (/OPENCODE|opencode\.ai|^sk-/i.test(token)) die('refusing a value that looks like an OpenCode key');

const inboxRaw = (process.env.TESS_INBOX || 'https://tess-music-player.janus.ing').replace(/\/$/, '');
let inboxUrl;
try { inboxUrl = new URL(inboxRaw); } catch { die(`TESS_INBOX is not an address: ${inboxRaw}`); }
if (inboxUrl.username || inboxUrl.password || inboxUrl.search) die('TESS_INBOX must not carry a user, a password, or a query');
if (inboxUrl.pathname !== '/' && inboxUrl.pathname !== '') die('TESS_INBOX must be the inbox origin, not a page on it');
const inbox = inboxUrl.origin;

const dest = join(home, 'profiles', 'tess-support');

// distribution.yaml names what the person gets. install.mjs, chat.mjs and
// .gitignore stay in the repo; they are not part of the running profile.
const owned = () => {
  const text = readFileSync(join(src, 'distribution.yaml'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'distribution_owned:');
  if (start === -1) die('distribution.yaml has no distribution_owned list');
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const item = line.match(/^  - (\S+)$/);
    if (!item) break;
    names.push(item[1]);
  }
  if (!names.length) die('distribution_owned is empty');
  return names;
};

const stage = mkdtempSync(join(tmpdir(), 'tess-support-mac-'));
try {
  for (const name of owned()) {
    const from = join(src, name);
    if (!existsSync(from)) die(`distribution_owned lists ${name}, which is not in support/mac`);
    cpSync(from, join(stage, name), { recursive: true, filter: (path) => basename(path) !== '.env' });
  }
  const scriptDir = join(stage, 'skills', 'tess-support', 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  for (const name of scripts) {
    cpSync(join(root, 'support/bot/skills/tess-support/scripts', name), join(scriptDir, name));
  }

  const childEnv = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || tmpdir(),
    HERMES_HOME: home,
    TMPDIR: process.env.TMPDIR || tmpdir(),
    LANG: process.env.LANG || 'C',
    TESS_SUPPORT_TOKEN: token,
    TESS_INBOX: inbox,
  };
  const help = spawnSync('hermes', ['profile', 'install', '--help'], {
    env: childEnv, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const helpText = `${help.stdout || ''}${help.stderr || ''}`;
  const hermesOk = help.status === 0 && /--yes/.test(helpText) && /--name/.test(helpText);
  let via = 'copy';
  if (hermesOk) {
    const installed = spawnSync('hermes', ['profile', 'install', stage, '--name', 'tess-support', '--yes'], {
      env: childEnv, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (installed.status !== 0) {
      die(`hermes profile install failed: ${(installed.stderr || installed.stdout || '').trim().slice(0, 400)}`);
    }
    via = 'hermes';
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(stage, dest, { recursive: true });
  }

  // Replace whatever the installer wrote. Two lines, mode 600, no other key.
  const envPath = join(dest, '.env');
  writeFileSync(envPath, `TESS_SUPPORT_TOKEN=${token}\nTESS_INBOX=${inbox}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  console.log(`via ${via}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
