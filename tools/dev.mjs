#!/usr/bin/env node
// Local-first dev loop for Tess Music: iterate in seconds from this checkout,
// then push to GitHub once everything works end-to-end on your Mac.
//
// Usage:
//   node tools/dev.mjs [status]          Show local dev state (branch, Spotify CDP, Mini, Support)
//   node tools/dev.mjs theme [--watch]   Build theme/Tess/src/* and hot-load into running Spotify
//   node tools/dev.mjs support [--sandbox]
//                                        Sync local SOUL.md, tess-visit.ts, skills, scripts into installed Support
//                                        (or --sandbox to run a full isolated support/pi/install.sh test)
//   node tools/dev.mjs mini              Compile local Tess Mini (.build/dev-mini/) and restart it
//   node tools/dev.mjs restore           Switch back from local dev Mini to ~/Applications/Tess Mini.app
//   node tools/dev.mjs worker [--dev]    Run local Worker tests (or --dev for wrangler dev)
//   node tools/dev.mjs all               Run theme + support + mini in one pass
//   node tools/dev.mjs check             Run full pre-push verification gate locally
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TESS_HOME = join(homedir(), 'Library', 'Application Support', 'Tess');
const SUPPORT_CUR = join(TESS_HOME, 'support', 'current');
const DEV_MINI_APP = join(ROOT, '.build', 'dev-mini', 'Tess Mini.app');
const INSTALLED_MINI_APP = join(homedir(), 'Applications', 'Tess Mini.app');

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'status';
const flags = new Set(args.filter((a) => a.startsWith('-')));

function run(bin, argv, opts = {}) {
  return execFileSync(bin, argv, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function capture(bin, argv, opts = {}) {
  try {
    return execFileSync(bin, argv, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return '';
  }
}

async function cdpReady() {
  try {
    const res = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function miniRunning() {
  const out = capture('pgrep', ['-af', 'TessMini']);
  if (!out) return null;
  const line = out.split('\n')[0] || '';
  const isDev = line.includes('.build/dev-mini');
  return { line, isDev };
}

async function resetMiniPi() {
  try {
    const tokRes = await fetch('http://127.0.0.1:38411/token', {
      headers: { Origin: 'https://xpui.app.spotify.com' },
      signal: AbortSignal.timeout(1000),
    });
    if (!tokRes.ok) return false;
    const { k } = await tokRes.json();
    if (!k) return false;
    const resetRes = await fetch(`http://127.0.0.1:38411/support/reset?k=${encodeURIComponent(k)}`, {
      method: 'POST',
      headers: { Origin: 'https://xpui.app.spotify.com' },
      signal: AbortSignal.timeout(1000),
    });
    return resetRes.ok;
  } catch {
    return false;
  }
}

async function showStatus() {
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
  const sha = capture('git', ['rev-parse', '--short', 'HEAD']) || 'unknown';
  const dirty = capture('git', ['status', '--short']);
  const cdp = await cdpReady();
  const mini = await miniRunning();
  const installedVer = existsSync(join(TESS_HOME, 'state', 'version'))
    ? readFileSync(join(TESS_HOME, 'state', 'version'), 'utf8').trim()
    : 'not installed';
  const hasSupport = existsSync(join(SUPPORT_CUR, 'bin', 'pi'));

  console.log(`Tess local dev (${ROOT.replace(/\/$/, '')})`);
  console.log(`  git:      ${branch} @ ${sha}${dirty ? ` (${dirty.split('\n').length} modified)` : ' (clean)'}`);
  console.log(`  installed:${installedVer}`);
  console.log(`  Spotify:  ${cdp ? 'DevTools ready on :9222' : 'DevTools not open (run: node tools/dev.mjs theme --launch)'}`);
  console.log(`  Mini:     ${mini ? (mini.isDev ? 'local dev build' : 'installed app') : 'not running'}`);
  console.log(`  Support:  ${hasSupport ? 'Pi installed in Tess/support/current' : 'not installed yet'}`);
}

async function doTheme() {
  if (flags.has('--launch')) {
    console.log('Restarting Spotify with --remote-debugging-port=9222…');
    capture('osascript', ['-e', 'tell application "Spotify" to quit']);
    await new Promise((r) => setTimeout(r, 1200));
    run('open', ['-a', 'Spotify', '--args', '--remote-debugging-port=9222']);
    for (let i = 0; i < 20; i++) {
      if (await cdpReady()) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!(await cdpReady())) {
    console.error('Spotify DevTools (:9222) is not open. Run:\n  node tools/dev.mjs theme --launch');
    process.exit(1);
  }
  const reload = () => {
    run('node', [join(ROOT, 'tools', 'hot.mjs')]);
    run('node', ['--check', join(ROOT, 'theme', 'Tess', 'theme.js')]);
  };
  reload();
  if (flags.has('--watch')) {
    console.log('Watching theme/Tess/src/ for changes (Ctrl-C to stop)…');
    let timer = null;
    watch(join(ROOT, 'theme', 'Tess', 'src'), { recursive: true }, (_ev, file) => {
      if (!file || file.startsWith('.')) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        console.log(`\n[${new Date().toLocaleTimeString()}] changed ${file} → hot-reloading…`);
        try { reload(); } catch (err) { console.error(err.message); }
      }, 150);
    });
  }
}

async function doSupport() {
  if (flags.has('--sandbox')) {
    console.log('Running local support/pi/install.sh sandbox suite…');
    run('node', [join(ROOT, 'tools', 'test-pi-support.mjs')]);
    if (flags.has('--live-dev')) {
      const sb = mkdtempSync(join(tmpdir(), 'tess-dev-pi-sb-'));
      try {
        mkdirSync(join(sb, 'bin', 'patcher'), { recursive: true });
        mkdirSync(join(sb, 'state'), { recursive: true });
        cpSync(join(TESS_HOME, 'bin', 'patcher', 'tess-verify'), join(sb, 'bin', 'patcher', 'tess-verify'));
        writeFileSync(join(sb, 'updater.env'), "TESS_PARTS_CHANNEL='dev'\n");
        run('/bin/sh', [join(ROOT, 'support', 'pi', 'install.sh')], {
          env: {
            ...process.env,
            TESS_TEST: '1',
            TESS_HOME: sb,
            TESS_SUPPORT_TOKEN: 'tess_0123456789abcdef0123456789abcdef',
            TESS_SUPPORT_PROGRESS_FILE: join(sb, 'state', '.support-invite-status'),
          },
        });
      } finally {
        rmSync(sb, { recursive: true, force: true });
      }
    }
    return;
  }
  if (!existsSync(join(SUPPORT_CUR, 'bin', 'pi'))) {
    console.error('Tess Support is not installed yet at ~/Library/Application Support/Tess/support/current.');
    console.error('Run `node tools/dev.mjs support --sandbox` to test the installer in a sandbox.');
    process.exit(1);
  }
  mkdirSync(join(SUPPORT_CUR, 'extensions'), { recursive: true });
  mkdirSync(join(SUPPORT_CUR, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'support', 'pi', 'SOUL.md'), join(SUPPORT_CUR, 'SOUL.md'));
  cpSync(join(ROOT, 'support', 'pi', 'tess-visit.ts'), join(SUPPORT_CUR, 'extensions', 'tess-visit.ts'));
  cpSync(join(ROOT, 'support', 'bot', 'skills', 'tess-support', 'scripts', 'privacy.mjs'), join(SUPPORT_CUR, 'scripts', 'privacy.mjs'));
  cpSync(join(ROOT, 'support', 'bot', 'skills', 'tess-support', 'scripts', 'triage.mjs'), join(SUPPORT_CUR, 'scripts', 'triage.mjs'));
  for (const sk of ['tess-support', 'tess-gather', 'tess-evidence', 'tess-handoff']) {
    mkdirSync(join(SUPPORT_CUR, 'skills', sk), { recursive: true });
    cpSync(join(ROOT, 'support', 'mac', 'skills', sk, 'SKILL.md'), join(SUPPORT_CUR, 'skills', sk, 'SKILL.md'));
  }
  const reset = await resetMiniPi();
  console.log(`Synced local support kit (SOUL.md, tess-visit.ts, 4 skills, scripts) into Tess/support/current.${reset ? ' Pi session reset.' : ''}`);
}

async function doMini() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const contents = join(DEV_MINI_APP, 'Contents');
  const macos = join(contents, 'MacOS');
  mkdirSync(macos, { recursive: true });
  console.log(`Compiling local Tess Mini (${arch})…`);
  run('swiftc', [
    '-O', '-parse-as-library',
    '-target', `${arch}-apple-macos13.0`,
    join(ROOT, 'mini', 'MiniGate.swift'),
    join(ROOT, 'mini', 'TessMini.swift'),
    '-o', join(macos, 'TessMini'),
  ]);
  const plist = readFileSync(join(ROOT, 'mini', 'Info.plist'), 'utf8').replace('__VERSION__', '0.0.0-dev');
  writeFileSync(join(contents, 'Info.plist'), plist);
  capture('pkill', ['-x', 'TessMini']);
  await new Promise((r) => setTimeout(r, 400));
  run('open', ['-n', DEV_MINI_APP]);
  console.log(`Launched local dev Tess Mini from ${DEV_MINI_APP}. Run 'node tools/dev.mjs restore' when done.`);
}

async function doRestore() {
  capture('pkill', ['-x', 'TessMini']);
  await new Promise((r) => setTimeout(r, 400));
  if (existsSync(INSTALLED_MINI_APP)) {
    run('open', [INSTALLED_MINI_APP]);
    console.log(`Restored signed installed Tess Mini from ${INSTALLED_MINI_APP}.`);
  } else {
    console.log('Stopped local dev Tess Mini (no installed Tess Mini found).');
  }
}

async function doWorker() {
  if (flags.has('--dev')) {
    console.log('Starting local Cloudflare Worker dev server (Ctrl-C to stop)…');
    const child = spawn('npx', ['-y', 'wrangler@4', 'dev'], { cwd: join(ROOT, 'inbox'), stdio: 'inherit' });
    await new Promise((resolve) => child.on('exit', resolve));
    return;
  }
  run('node', ['--check', join(ROOT, 'inbox', 'worker.js')]);
  run('node', [join(ROOT, 'tools', 'test-support-chat.mjs')]);
  run('node', [join(ROOT, 'tools', 'test-inbox.mjs')]);
  run('node', [join(ROOT, 'tools', 'test-inbox-support.mjs')]);
}

async function doCheck() {
  const cleanEnv = { ...process.env };
  delete cleanEnv.ANTIGRAVITY_SOURCE_METADATA;
  console.log('Running full local pre-push check…');
  run('node', [join(ROOT, 'tools', 'build.mjs')], { env: cleanEnv });
  run('node', ['--check', join(ROOT, 'theme', 'Tess', 'theme.js')], { env: cleanEnv });
  run('node', ['--check', join(ROOT, 'inbox', 'worker.js')], { env: cleanEnv });
  run('node', [join(ROOT, 'tools', 'test-pi-support.mjs')], { env: cleanEnv });
  run('node', [join(ROOT, 'tools', 'test-support-chat.mjs')], { env: cleanEnv });
  run('node', [join(ROOT, 'tools', 'test-inbox.mjs')], { env: cleanEnv });
  run('node', [join(ROOT, 'tools', 'test-updater.mjs')], { env: cleanEnv });
  run('/bin/bash', [join(ROOT, 'tools', 'check-safety.sh')], { env: cleanEnv });
  console.log('\nAll local pre-push checks passed. Ready for a single push to GitHub.');
}

switch (cmd) {
  case 'status':
    await showStatus();
    break;
  case 'theme':
  case 'hot':
    await doTheme();
    break;
  case 'support':
    await doSupport();
    break;
  case 'mini':
    await doMini();
    break;
  case 'restore':
    await doRestore();
    break;
  case 'worker':
    await doWorker();
    break;
  case 'all':
    await doTheme();
    await doSupport();
    await doMini();
    break;
  case 'check':
    await doCheck();
    break;
  default:
    console.error(`Unknown command: ${cmd}\nRun: node tools/dev.mjs [status|theme|support|mini|worker|all|check|restore]`);
    process.exit(1);
}
