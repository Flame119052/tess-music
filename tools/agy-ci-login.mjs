#!/usr/bin/env node
// Prepare the Google-plan login the hosted Antigravity reviewer uses, without touching the login on this machine.
//
// agy 1.5.12 keeps that login in ~/.gemini/antigravity-cli/antigravity-oauth-token when the OS keyring is skipped.
// On the Dell, an SSH session with a throwaway HOME did that (19 Nov 2026). This script uses its own HOME, so the
// Mac keychain and any agy login already on the machine are never read.
//
// Usage, on the Dell (Linux), not on the Mac:
//   node tools/agy-ci-login.mjs --login                 # agy acp --login, in the private HOME
//   node tools/agy-ci-login.mjs --check                 # mint an access token and print scopes and expiry
//   node tools/agy-ci-login.mjs --trial-review <number> # one local review, access token only, nothing posted
//
// It never prints a token. It does not set the GitHub secret. The last lines of a plain run are the command Krish runs once.
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  antigravityAuth,
  antigravityTokenRelative,
  buildPrContext,
  describeAntigravityLogin,
  failureSummary,
  reviewPrompt,
  runReviewerAsync,
  snapshot,
  verdictFor,
} from './agent-review.mjs';

const repo = process.env.TESS_REPO || 'Flame119052/tess-music';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const home = process.env.TESS_AGY_CI_HOME || join(homedir(), '.config', 'tess-agy-ci');
const tokenPath = join(home, antigravityTokenRelative);
const checkOnly = process.argv.includes('--check');
const doLogin = process.argv.includes('--login');
const trialAt = process.argv.indexOf('--trial-review');
const trialNumber = trialAt >= 0 ? process.argv[trialAt + 1] : '';

const say = (line) => console.log(line);

function readLogin() {
  if (!existsSync(tokenPath)) return null;
  try { return readFileSync(tokenPath, 'utf8'); } catch { return null; }
}

function requireLinux() {
  if (platform() === 'linux') return;
  console.error('Refusing to log in here. On macOS agy uses the keychain, and this script must not touch it. Use the Dell.');
  process.exit(1);
}

async function check() {
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
  try {
    const info = await describeAntigravityLogin(raw);
    say(`scopes: ${info.scopes.join(' ')}`);
    say(`expiry: ${info.expiry || 'unknown'}`);
  } catch (error) {
    console.error(`Antigravity CI login: ${error.message}`);
    process.exit(1);
  }
}

function ghText(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 });
}

async function trialReview(number) {
  requireLinux();
  if (!/^[0-9]+$/.test(number || '')) {
    console.error('Usage: node tools/agy-ci-login.mjs --trial-review <PR number>');
    process.exit(1);
  }
  const raw = readLogin();
  if (!raw) {
    console.error(`Antigravity CI login: none yet at ${tokenPath}`);
    process.exit(1);
  }
  const auth = antigravityAuth(raw);
  if (auth.problem) {
    console.error(`Antigravity CI login: ${auth.problem}`);
    process.exit(1);
  }
  execFileSync('git', ['-C', repoRoot, 'fetch', '--quiet', '--depth=1', 'origin', `pull/${number}/head`]);
  const files = ghText(['api', `repos/${repo}/pulls/${number}/files`, '--paginate', '--jq', '.[].filename'])
    .split('\n').filter(Boolean);
  const diff = ghText(['pr', 'diff', String(number), '-R', repo]);
  const work = snapshot('FETCH_HEAD');
  const env = { ...process.env, AGY_OAUTH_TOKEN: raw };
  let failed = null;
  try {
    const result = await runReviewerAsync(
      [{ provider: 'antigravity', model: 'gemini-4-neon', effort: 'high' }],
      reviewPrompt('pr', buildPrContext({
        issue: '(trial review)',
        approach: '(trial review)',
        diff,
        files,
        work,
      })),
      work,
      { env },
    );
    say(`status: ${result.status || 'SUCCESS'}`);
    say(`num_turns: ${result.usage?.turns ?? 'none'}`);
    const usage = result.usage || {};
    say(`usage: ${JSON.stringify({
      input: usage.input ?? null,
      output: usage.output ?? null,
      total: usage.total ?? null,
    })}`);
    say(`verdict: ${verdictFor(result.text)}`);
  } catch (error) {
    failed = error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (failed) {
    console.error(`trial review stopped: ${failureSummary({ stderr: failed?.message || String(failed) }, env)}`);
    process.exit(1);
  }
}

function login() {
  requireLinux();
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

async function main() {
  if (checkOnly) {
    await check();
    return;
  }
  if (trialAt >= 0) {
    await trialReview(trialNumber);
    return;
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
    say('   This prints scopes and expiry. It does not print a token.');
    say('5. node tools/agy-ci-login.mjs --trial-review <PR number>');
    say('   This runs the job\'s Antigravity path locally and prints status, num_turns, usage and the verdict line.');
    say('6. Set the secret yourself, from that same throwaway HOME. The file is the secret. Do not print it:');
    say(`   gh secret set AGY_OAUTH_TOKEN -R ${repo} < "${tokenPath}"`);
    return;
  }
  login();
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`Antigravity CI login: ${failureSummary({ stderr: error?.message || String(error) })}`);
    process.exitCode = 1;
  }
}
