#!/usr/bin/env node
// Install the Mac tess-support profile.
// Tests (TESS_TEST=1) refuse any HERMES_HOME inside the real login home.
// A real install allows ~/.hermes, which is where Hermes lives, and still refuses a symlink
// and any write outside profiles/tess-support.
// Writes .env with the support token only — never an OpenCode key.
// Uses `hermes profile install` when that command actually runs, and copies the profile otherwise.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, cpSync, existsSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const src = join(root, 'support/mac');
const scripts = ['privacy.mjs', 'triage.mjs', 'inbox.mjs', 'session.mjs'];

const scrub = (text) => {
  const token = process.env.TESS_SUPPORT_TOKEN || '';
  let out = String(text ?? '');
  if (token.length >= 8 && out.includes(token)) out = out.split(token).join('[redacted]');
  return out;
};
const die = (msg) => { console.error(scrub(msg)); process.exit(1); };

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
const isLink = (path) => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};

// chosen and real are absolute. selfLink is HERMES_HOME itself, not an ancestor such as /var.
export const homeError = (chosen, real, login, { testMode = false, selfLink = false } = {}) => {
  if (selfLink) return 'HERMES_HOME is a symlink. Refusing to follow it.';
  if (!login) return '';
  if (!inside(chosen, login) && !inside(real, login)) return '';
  if (testMode) return `HERMES_HOME is inside the real home folder (${login}). Use a scratch directory.`;
  if (chosen === resolve(login, '.hermes')) return '';
  return `HERMES_HOME is inside the real home folder (${login}) but is not ~/.hermes.`;
};

// The nearest path that already exists. Creating `<symlink>/newdir` would otherwise
// mkdir inside whatever the symlink points at, and the check would run too late.
const existingAncestor = (path) => {
  let cur = path;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
};

const scratchHome = () => {
  const raw = process.env.HERMES_HOME;
  if (!raw) die('Set HERMES_HOME to a scratch directory. This installer will not use the real home.');
  const chosen = resolve(raw);
  const login = loginHome();
  const testMode = process.env.TESS_TEST === '1';
  if (existsSync(chosen) && isLink(chosen)) die(homeError(chosen, chosen, login, { testMode, selfLink: true }));
  const ancestor = existingAncestor(chosen);
  let ancestorReal;
  try { ancestorReal = realpathSync(ancestor); } catch { die('HERMES_HOME cannot be resolved'); }
  const rest = relative(ancestor, chosen);
  const predicted = rest ? join(ancestorReal, rest) : ancestorReal;
  // Decide before creating anything. A refusal must not leave a directory behind.
  const early = homeError(chosen, predicted, login, { testMode, selfLink: false });
  if (early) die(early);
  mkdirSync(chosen, { recursive: true });
  if (isLink(chosen)) die('HERMES_HOME is a symlink. Refusing to follow it.');
  const real = realpathSync(chosen);
  const problem = homeError(chosen, real, login, { testMode, selfLink: false });
  if (problem) die(problem);
  return real;
};

const PINNED_INBOX = 'https://tess-music-player.janus.ing';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const inboxOrigin = () => {
  const inboxRaw = (process.env.TESS_INBOX || PINNED_INBOX).replace(/\/$/, '');
  let inboxUrl;
  try { inboxUrl = new URL(inboxRaw); } catch { die('TESS_INBOX is not an address'); }
  if (inboxUrl.username || inboxUrl.password || inboxUrl.search) {
    die('TESS_INBOX must not carry a user, a password, or a query');
  }
  if (inboxUrl.pathname !== '/' && inboxUrl.pathname !== '') die('TESS_INBOX must be the inbox origin, not a page on it');
  const pinned = inboxUrl.protocol === 'https:' && inboxUrl.hostname === 'tess-music-player.janus.ing' && !inboxUrl.port;
  const testLoop = process.env.TESS_TEST === '1' && inboxUrl.protocol === 'http:' && LOOPBACK.has(inboxUrl.hostname);
  if (!pinned && !testLoop) die(`TESS_INBOX must be ${PINNED_INBOX}`);
  return inboxUrl.origin;
};

const main = () => {
  const home = scratchHome();

  const token = process.env.TESS_SUPPORT_TOKEN || '';
  if (!token || /[\r\n]/.test(token)) die('TESS_SUPPORT_TOKEN is missing');
  if (/OPENCODE|opencode\.ai|^sk-/i.test(token)) die('refusing a value that looks like an OpenCode key');

  const inbox = inboxOrigin();

  const dest = join(home, 'profiles', 'tess-support');
  if (isLink(join(home, 'profiles')) || isLink(dest)) die('the profile folder is a symlink. Refusing to follow it.');

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

    if (isLink(join(home, 'profiles')) || isLink(dest)) die('the profile folder is a symlink. Refusing to follow it.');
    const destReal = realpathSync(dest);
    if (!inside(destReal, home)) die('the profile folder points outside HERMES_HOME');

    // The same Node layout as install.sh: one binary, plus the pinned version.
    // TESS_NODE_RUNTIME is a regular file the tests supply. Otherwise this copies
    // the node that is running the installer. A matching VERSION is left in place.
    const placeRuntime = () => {
      const pins = readFileSync(join(src, 'install.sh'), 'utf8');
      const pinned = pins.match(/^NODE_VERSION=(v\d+\.\d+\.\d+)$/m);
      if (!pinned) die('install.sh has no NODE_VERSION pin');
      const version = pinned[1];
      const runtimeRoot = join(dest, 'runtime');
      const runtime = join(runtimeRoot, 'node');
      const bin = join(runtime, 'bin', 'node');
      const marker = join(runtime, 'VERSION');
      for (const path of [dest, runtimeRoot, runtime, join(runtime, 'bin'), bin]) {
        if (isLink(path)) die('the Node runtime path is a symlink. Refusing to follow it.');
      }
      if (existsSync(marker) && existsSync(bin) && readFileSync(marker, 'utf8').trim() === version) return;
      let from = process.execPath;
      if (process.env.TESS_NODE_RUNTIME) {
        from = resolve(process.env.TESS_NODE_RUNTIME);
        let info;
        try { info = lstatSync(from); } catch { die('TESS_NODE_RUNTIME must be a regular file'); }
        if (info.isSymbolicLink() || !info.isFile()) die('TESS_NODE_RUNTIME must be a regular file');
      }
      const incoming = join(runtimeRoot, '.node-incoming');
      const previous = join(runtimeRoot, '.node-previous');
      rmSync(incoming, { recursive: true, force: true });
      mkdirSync(join(incoming, 'bin'), { recursive: true });
      cpSync(from, join(incoming, 'bin', 'node'));
      chmodSync(join(incoming, 'bin', 'node'), 0o755);
      writeFileSync(join(incoming, 'VERSION'), `${version}\n`);
      rmSync(previous, { recursive: true, force: true });
      if (existsSync(runtime)) renameSync(runtime, previous);
      try {
        renameSync(incoming, runtime);
      } catch {
        if (existsSync(previous)) renameSync(previous, runtime);
        die('Could not install Node. The previous runtime was left in place.');
      }
      rmSync(previous, { recursive: true, force: true });
    };

    // Replace whatever the installer wrote. Two lines, mode 600, no other key.
    // Only inside the profile folder.
    const envPath = join(dest, '.env');
    if (isLink(envPath)) die('the profile .env is a symlink. Refusing to follow it.');
    if (realpathSync(dirname(envPath)) !== destReal) die('refusing to write outside the profile folder');
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0);
    let fd;
    try { fd = openSync(envPath, flags, 0o600); }
    catch { die('the profile .env is a symlink. Refusing to follow it.'); }
    try {
      writeSync(fd, `TESS_SUPPORT_TOKEN=${token}\nTESS_INBOX=${inbox}\n`);
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    placeRuntime();
    console.log(`via ${via}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
};

const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) main();
