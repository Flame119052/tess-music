#!/usr/bin/env node
// Prepare the Google-plan login the hosted Antigravity reviewer uses, without touching the login on this machine.
//
// agy 1.5.12 keeps that login in ~/.gemini/antigravity-cli/antigravity-oauth-token when the OS keyring is skipped.
// On the Dell, an SSH session with a throwaway HOME did that (19 Nov 2026). This script uses its own HOME, so the
// Mac keychain and any agy login already on the machine are never read.
//
// Usage, on the Dell (Linux), not on the Mac:
//   node tools/agy-ci-login.mjs --login     # agy acp --login, in the private HOME
//   node tools/agy-ci-login.mjs --check     # say whether that file is a plan login
//
// It never prints the token. It does not set the GitHub secret. The last lines are the command Krish runs once.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { antigravityAuth, antigravityTokenRelative } from './agent-review.mjs';

const repo = process.env.TESS_REPO || 'Flame119052/tess-music';
const home = process.env.TESS_AGY_CI_HOME || join(homedir(), '.config', 'tess-agy-ci');
const tokenPath = join(home, antigravityTokenRelative);
const checkOnly = process.argv.includes('--check');
const doLogin = process.argv.includes('--login');

const say = (line) => console.log(line);

function readLogin() {
  if (!existsSync(tokenPath)) return null;
  try { return readFileSync(tokenPath, 'utf8'); } catch { return null; }
}

function main() {
if (checkOnly) {
  const raw = readLogin();
  if (!raw) {
    say(`Antigravity CI login: none yet at ${tokenPath}`);
    say('On the Dell: node tools/agy-ci-login.mjs --login');
    process.exit(1);
  }
  const auth = antigravityAuth(raw);
  if (auth.problem) {
    console.error(`Antigravity CI login: ${auth.problem}`);
    process.exit(1);
  }
  say(`Antigravity CI login: a Google-plan file is present (${Buffer.byteLength(raw)} bytes). The token is not printed.`);
  process.exit(0);
}

if (!doLogin) {
  say('This prepares the Google-plan file for the GitHub review job. It does not set the secret.');
  say('Run it on the Dell over SSH, where agy uses a file instead of a keyring. Do not run it on the Mac.');
  say('');
  say('1. ssh dell');
  say('2. cd ~/Developer/tess-music && git fetch && git switch review-gemini');
  say('3. node tools/agy-ci-login.mjs --login');
  say('   Open the URL agy prints, sign in with the Google plan, and paste the code. Nothing is copied from the Mac.');
  say('4. node tools/agy-ci-login.mjs --check');
  say('5. Set the secret yourself, from that same throwaway HOME. The file is the secret. Do not print it:');
  say(`   gh secret set AGY_OAUTH_TOKEN -R ${repo} < "${tokenPath}"`);
  process.exit(0);
}

if (platform() !== 'linux') {
  console.error('Refusing to log in here. On macOS agy uses the keychain, and this script must not touch it. Use the Dell.');
  process.exit(1);
}

say(`Signing in under ${home}. Your existing agy login is left alone.`);
const result = spawnSync('agy', ['acp', '--login'], {
  stdio: 'inherit',
  env: { ...process.env, HOME: home, DBUS_SESSION_BUS_ADDRESS: '' },
});
if (result.status !== 0) {
  console.error('agy acp --login did not finish.');
  process.exit(result.status || 1);
}
const raw = readLogin();
const auth = antigravityAuth(raw || '');
if (auth.problem) {
  console.error(`Login finished but ${tokenPath} is not a usable plan file: ${auth.problem}`);
  process.exit(1);
}
say('Login file is ready. Set the secret yourself when you mean to. The token is not printed and was not uploaded:');
say(`gh secret set AGY_OAUTH_TOKEN -R ${repo} < "${tokenPath}"`);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
