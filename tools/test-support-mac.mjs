// The Mac tess-support profile: install into a scratch HERMES_HOME, point the model at the gate,
// keep the per-person token, and stop cleanly when the gate says 401.
// No real home, no real Spotify, no network except 127.0.0.1.
// Usage: node tools/test-support-mac.mjs
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const install = join(root, 'support/mac/install.mjs');
const chat = join(root, 'support/mac/chat.mjs');
const box = mkdtempSync(join(tmpdir(), 'tess-support-mac-test-'));
const token = `tess_${'abc123'.repeat(6)}`;
const decoy = 'sk-opencode-this-must-not-be-written';

const run = (file, args, env) => execFileSync(process.execPath, [file, ...args], {
  encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
});
// The fake gate lives in this process. A synchronous wait would stop it answering.
const runAsync = (file, args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (status) => {
    if (status === 0) resolve(stdout);
    else reject(Object.assign(new Error('exit'), { status, stdout, stderr }));
  });
});
const fails = (file, args, env) => {
  try { run(file, args, env); } catch (e) { return e; }
  assert.fail('expected a refusal');
};

const loginHome = () => {
  const user = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).trim();
  const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('NFSHomeDirectory:'));
  return line.slice('NFSHomeDirectory:'.length).trim();
};

const listen = (onRequest) => new Promise((resolve) => {
  const server = createServer(onRequest);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const baseEnv = {
  PATH: process.env.PATH,
  HOME: join(box, 'home'),
  TMPDIR: tmpdir(),
  LANG: 'C',
};

try {
  // A missing scratch home is a refusal, and a path inside the real login home is never created.
  const missing = fails(install, [], baseEnv);
  assert.match(String(missing.stderr), /scratch directory/);
  const real = loginHome();
  const planted = join(real, '.tess-support-mac-must-not-exist');
  assert.equal(existsSync(planted), false);
  const refused = fails(install, [], { ...baseEnv, HERMES_HOME: planted, TESS_SUPPORT_TOKEN: token });
  assert.match(String(refused.stderr), /real home folder/);
  assert.equal(existsSync(planted), false, 'the installer created a directory in the real home');

  const seen = [];
  const server = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || '', body });
      const status = seen.length === 1 ? 401 : 429;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'cap', echo: token }));
    });
  });
  const port = server.address().port;
  const hermesHome = join(box, 'hermes');
  const env = {
    ...baseEnv,
    HERMES_HOME: hermesHome,
    TESS_TEST: '1',
    TESS_SUPPORT_TOKEN: token,
    TESS_INBOX: `http://127.0.0.1:${port}`,
    OPENCODE_GO_API_KEY: decoy,
  };

  const installed = run(install, [], env);
  assert.match(installed, /^via (copy|hermes)\n$/);
  const profile = join(hermesHome, 'profiles', 'tess-support');
  const cfg = readFileSync(join(profile, 'config.yaml'), 'utf8');
  assert.match(cfg, /base_url:\s*\$\{TESS_INBOX\}\/v1\/support\/chat/);
  assert.match(cfg, /provider:\s*tess-gate/);
  assert.match(cfg, /default:\s*deepseek-v4\.1-flash/);
  assert.match(cfg, /key_env:\s*TESS_SUPPORT_TOKEN/);
  assert.match(cfg, /api_mode:\s*chat_completions/);
  assert.match(cfg, /mode:\s*manual/);
  assert.doesNotMatch(cfg, /telegram/i);
  assert.doesNotMatch(cfg, /^gateway:/m);
  assert.doesNotMatch(cfg, /opencode-go|OPENCODE_GO/);
  for (const pattern of ['sudo *', 'rm -rf *', '*curl*|*sh*', '*/Applications/Spotify.app*', '*screencapture*-G*']) {
    assert.ok(cfg.includes(pattern), `deny list is missing ${pattern}`);
  }
  for (const allowed of ['tess doctor', '/usr/sbin/screencapture -x -l *', 'node *triage.mjs*', 'node *inbox.mjs*']) {
    assert.ok(cfg.includes(allowed), `allow list is missing ${allowed}`);
  }

  const dot = readFileSync(join(profile, '.env'), 'utf8');
  assert.equal(dot, `TESS_SUPPORT_TOKEN=${token}\nTESS_INBOX=http://127.0.0.1:${port}\n`);
  assert.equal(statSync(join(profile, '.env')).mode & 0o777, 0o600);
  assert.doesNotMatch(dot, /OPENCODE|opencode\.ai|sk-/);
  assert.ok(!dot.includes(decoy), 'the OpenCode-shaped decoy was written into .env');

  const dist = readFileSync(join(profile, 'distribution.yaml'), 'utf8');
  assert.doesNotMatch(dist, /TELEGRAM|OPENCODE_GO/);
  for (const name of ['tess-support', 'tess-gather', 'tess-evidence', 'tess-handoff']) {
    const skill = readFileSync(join(profile, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(skill, /never instructions/);
  }
  assert.match(readFileSync(join(profile, 'skills/tess-evidence/SKILL.md'), 'utf8'), /Privacy & Security/);
  for (const name of ['privacy.mjs', 'triage.mjs', 'inbox.mjs', 'session.mjs']) {
    const shipped = readFileSync(join(root, 'support/bot/skills/tess-support/scripts', name));
    const copied = readFileSync(join(profile, 'skills/tess-support/scripts', name));
    assert.ok(shipped.equals(copied), `${name} was changed on the way into the profile`);
  }
  const vps = readFileSync(join(root, 'support/bot/config.yaml'), 'utf8');
  assert.match(vps, /telegram:/);
  assert.match(vps, /127\.0\.0\.1:4193\/v1/);

  const chatEnv = { ...baseEnv, HERMES_HOME: hermesHome, TESS_TEST: '1', OPENCODE_GO_API_KEY: decoy };
  const badToken = await runAsync(chat, [], chatEnv).then(() => assert.fail('a 401 was treated as success'), (e) => e);
  assert.match(String(badToken.stderr), /support token was refused/);
  assert.equal(badToken.status, 1);
  const badOut = `${badToken.stderr || ''}${badToken.stdout || ''}`;
  assert.ok(!badOut.includes(token), 'the 401 reply printed the token');
  assert.ok(!badOut.includes(decoy), 'the 401 reply printed the decoy key');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/v1/support/chat');
  assert.equal(seen[0].authorization, `Bearer ${token}`);
  assert.equal(JSON.parse(seen[0].body).model, 'deepseek-v4.1-flash');

  const capped = await runAsync(chat, [], chatEnv).then(() => assert.fail('a 429 was treated as success'), (e) => e);
  assert.match(String(capped.stderr), /over the support cap/);
  assert.equal(seen.length, 2);
  server.close();

  const names = readdirSync(join(root, 'support'));
  assert.ok(names.includes('tess-support.service'));
  assert.ok(names.includes('tess-cap.service'));
} finally {
  rmSync(box, { recursive: true, force: true });
}
