// The Mac tess-support profile: install into a scratch HERMES_HOME, point the model at the gate,
// keep the per-person token, and stop cleanly when the gate says 401.
// No real home, no real Spotify, no network except 127.0.0.1.
// Usage: node tools/test-support-mac.mjs
import { createServer } from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
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

// Hermes matches an allowlist entry against the whole line (fnmatch, case-sensitive)
// and skips the match when the line has a shell operator. Deny globs are
// case-insensitive and also see the command split on &&, ; and |. This is the
// copy of tools/approval_floors.py used when that tree is not on the machine.
const SHELL_CONTROL = new Set(['\n', '\r', ';', '&', '|', '<', '>', '`', '$', '(', ')']);
const REINTERPRETED = /(?:^|[ \t])(?:-[^-\s]*[ce]|--(?:command|eval))(?:[= \t]|$)/;
const hasShellOperator = (command) => {
  command = command || '';
  let quote = null;
  let quotedControl = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'") {
      const nxt = command[i + 1] || '';
      if (SHELL_CONTROL.has(nxt)) quotedControl = true;
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '`' || ch === '$')) return true;
      else if (SHELL_CONTROL.has(ch)) quotedControl = true;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '$') { if (command[i + 1] === '(') return true; }
    else if (SHELL_CONTROL.has(ch) && ch !== '(' && ch !== ')') return true;
  }
  if (quote) return true;
  return quotedControl && REINTERPRETED.test(command);
};
const fnmatchcase = (name, pat) => {
  let src = '';
  for (let i = 0; i < pat.length; i += 1) {
    const c = pat[i];
    if (c === '*') src += '[\\s\\S]*';
    else if (c === '?') src += '[\\s\\S]';
    else src += c.replace(/[\\^$.*+?(){}|[\]-]/g, '\\$&');
  }
  return new RegExp(`^${src}$`).test(name);
};
const allowMatch = (command, patterns) => {
  const line = String(command || '').trim();
  if (!line || hasShellOperator(line)) return false;
  return patterns.some((pattern) => {
    const item = String(pattern).trim();
    if (!item) return false;
    if (line === item) return true;
    return /[*?\[]/.test(item) && fnmatchcase(line, item);
  });
};
const denyMatch = (command, patterns) => {
  const globs = patterns.map((item) => String(item).trim()).filter(Boolean);
  const pieces = [command];
  for (const part of String(command).split(/&&|[;|]/)) {
    const piece = part.trim();
    if (piece) pieces.push(piece);
  }
  const first = String(command).match(/^(\S+)([\s\S]*)$/);
  if (first) {
    const base = first[1].split('/').pop();
    if (base !== first[1]) pieces.push(base + first[2]);
  }
  for (const variant of pieces) {
    const candidate = variant.toLowerCase().trim();
    for (const pattern of globs) {
      if (fnmatchcase(candidate, pattern.toLowerCase())) return pattern;
    }
  }
  return null;
};
const yamlItems = (text, header) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === header);
  if (start === -1) throw new Error(`missing ${header}`);
  const indent = header.match(/^ */)[0].length;
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const quoted = line.match(new RegExp(`^ {${indent + 2}}- '(.*)'$`));
    const plain = line.match(new RegExp(`^ {${indent + 2}}- (\\S+)$`));
    const item = quoted || plain;
    if (!item) break;
    items.push(item[1]);
  }
  return items;
};
// The real matcher, when this machine has the Hermes tree the profile is written for.
const hermesVerdicts = (allow, deny, commands) => {
  const root = process.env.HERMES_AGENT_SRC || '/Volumes/DellSSD/iMac-offload/.hermes/hermes-agent';
  if (!existsSync(join(root, 'tools/approval_floors.py'))) return null;
  const script = `
import fnmatch, json, re, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root))
from tools.approval_detection import _deny_command_variants
text = (root / "tools/approval_floors.py").read_text()
ns = {"re": re}
exec(text[text.index("_SHELL_CONTROL_CHARS"):text.index("def _command_matches_permanent_allowlist")], ns)
has_op = ns["_has_allowlist_shell_operator"]
payload = json.load(sys.stdin)
allow, deny, commands = payload["allow"], payload["deny"], payload["commands"]
def allow_match(command):
    command = (command or "").strip()
    if not command or has_op(command):
        return False
    for pattern in allow:
        pattern = pattern.strip() if isinstance(pattern, str) else ""
        if pattern and (command == pattern or (any(ch in pattern for ch in "*?[") and fnmatch.fnmatchcase(command, pattern))):
            return True
    return False
def deny_match(command):
    globs = [p.strip() for p in deny if isinstance(p, str) and p.strip()]
    for variant in _deny_command_variants(command):
        candidate = variant.lower().strip()
        for pattern in globs:
            if fnmatch.fnmatchcase(candidate, pattern.lower()):
                return pattern
    return None
json.dump([{"allow": allow_match(c), "deny": bool(deny_match(c))} for c in commands], sys.stdout)
`;
  const child = spawnSync('python3', ['-c', script, root], {
    input: JSON.stringify({ allow, deny, commands }), encoding: 'utf8',
  });
  if (child.status !== 0) throw new Error(child.stderr || 'hermes matcher failed');
  return JSON.parse(child.stdout);
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
  assert.match(cfg, /base_url:\s*\$\{TESS_INBOX\}\/v1\/support\s*$/m);
  assert.match(cfg, /provider:\s*tess-gate/);
  assert.match(cfg, /default:\s*deepseek-v4\.1-flash/);
  assert.match(cfg, /key_env:\s*TESS_SUPPORT_TOKEN/);
  assert.match(cfg, /api_mode:\s*chat_completions/);
  assert.match(cfg, /mode:\s*manual/);
  assert.doesNotMatch(cfg, /telegram/i);
  assert.doesNotMatch(cfg, /^gateway:/m);
  assert.doesNotMatch(cfg, /opencode-go|OPENCODE_GO/);
  const shipped = readFileSync(join(root, 'support/mac/config.yaml'), 'utf8');
  assert.doesNotMatch(shipped, /Dangerous patterns that are already approved/);
  const node = 'node $HERMES_HOME/profiles/tess-support';
  const allow = [
    'tess doctor',
    'zsh $HOME/Library/Application\\ Support/Tess/doctor.sh',
    'tail -40 $HOME/Library/Application\\ Support/Tess/guard.log',
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs`,
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs still */spotify.png`,
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs video */spotify.mov`,
    `${node}/skills/tess-support/scripts/session.mjs new`,
    `${node}/skills/tess-support/scripts/session.mjs sweep`,
    `${node}/skills/tess-support/scripts/session.mjs add */spotify.mov --record`,
    `${node}/skills/tess-support/scripts/session.mjs handoff *`,
    `${node}/skills/tess-support/scripts/inbox.mjs issues`,
    `${node}/skills/tess-support/scripts/inbox.mjs report *`,
    `${node}/skills/tess-support/scripts/inbox.mjs recording *`,
    `${node}/skills/tess-handoff/scripts/triage-inbox.mjs --report * --words * --title-file * --summary-file * --mode inbox`,
  ];
  const deny = [
    'sudo *', 'rm -rf *', 'rm -fr *', 'chmod -R *', 'dd *', 'mkfs*',
    'launchctl bootstrap*', 'launchctl submit*',
    '*curl*|*sh*', '*curl*|*bash*', '*/Applications/Spotify.app*',
    '*screencapture*-G*', '*screencapture*-D*',
    'node -e*', 'node --eval*', 'node -p*',
    '*&&*', '*;*', '*|*', '*`*', '*$(*',
  ];
  assert.deepEqual(yamlItems(shipped, 'command_allowlist:'), allow);
  assert.deepEqual(yamlItems(shipped, '  deny:'), deny);
  assert.deepEqual(yamlItems(cfg, 'command_allowlist:'), allow);
  assert.deepEqual(yamlItems(cfg, '  deny:'), deny);
  const pass = [
    'tess doctor',
    'zsh $HOME/Library/Application\\ Support/Tess/doctor.sh',
    'tail -40 $HOME/Library/Application\\ Support/Tess/guard.log',
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs`,
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs still /tmp/sess/spotify.png`,
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs video /tmp/sess/spotify.mov`,
    `${node}/skills/tess-support/scripts/session.mjs new`,
    `${node}/skills/tess-support/scripts/session.mjs sweep`,
    `${node}/skills/tess-support/scripts/session.mjs add /tmp/sess /tmp/sess/spotify.mov --record`,
    `${node}/skills/tess-support/scripts/session.mjs handoff /tmp/sess 12`,
    `${node}/skills/tess-support/scripts/inbox.mjs issues`,
    `${node}/skills/tess-support/scripts/inbox.mjs report /tmp/sess`,
    `${node}/skills/tess-support/scripts/inbox.mjs recording 12 /tmp/sess/spotify.mov`,
    `${node}/skills/tess-handoff/scripts/triage-inbox.mjs --report /tmp/sess/doctor.txt --words /tmp/sess/words.txt --title-file /tmp/sess/title.txt --summary-file /tmp/sess/summary.txt --mode inbox`,
    `${node}/skills/tess-handoff/scripts/triage-inbox.mjs --report /tmp/sess/doctor.txt --words /tmp/sess/words.txt --title-file /tmp/sess/title.txt --summary-file /tmp/sess/summary.txt --related 61 --mode inbox`,
  ];
  const blocked = [
    'node -e \'fs.copyFileSync(env.HOME+"/.hermes/profiles/tess-support/.env","/tmp/x")\' x-triage.mjs',
    'node --eval process.exit',
    'node -p process.version',
    'tess doctor && rm -rf ~',
    'tess doctor; rm -rf ~',
    'tess doctor | sh',
    'echo `rm -rf ~`',
    'echo $(rm -rf ~)',
    '/usr/sbin/screencapture -x -l 1 -D 1 /tmp/spotify.png',
  ];
  const commands = [...pass, ...blocked, 'tess doctor --help', `node /tmp/evil.mjs ${node}/skills/tess-support/scripts/session.mjs new`];
  const local = commands.map((command) => ({ allow: allowMatch(command, allow), deny: Boolean(denyMatch(command, deny)) }));
  const hermes = hermesVerdicts(allow, deny, commands);
  if (hermes) assert.deepEqual(hermes, local, 'the copy of the matcher disagrees with Hermes');
  pass.forEach((command, i) => {
    assert.equal(local[i].allow, true, `not pre-approved: ${command}`);
    assert.equal(local[i].deny, false, `denied an intended call: ${command}`);
  });
  blocked.forEach((command, i) => {
    const verdict = local[pass.length + i];
    assert.equal(verdict.allow, false, `pre-approved a refused line: ${command}`);
    assert.equal(verdict.deny, true, `not denied: ${command}`);
  });
  assert.equal(local[commands.length - 2].allow, false, 'tess doctor --help is broader than tess doctor');
  assert.equal(local[commands.length - 1].allow, false, 'a different program in front of session.mjs was pre-approved');

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
  for (const name of yamlItems(readFileSync(join(root, 'support/mac/distribution.yaml'), 'utf8'), 'distribution_owned:')) {
    assert.ok(existsSync(join(profile, name)), `${name} was not installed`);
  }
  for (const banned of ['install.mjs', 'chat.mjs', '.gitignore']) {
    assert.equal(existsSync(join(profile, banned)), false, `${banned} was copied into the profile`);
  }
  assert.ok(existsSync(join(profile, 'skills/tess-evidence/scripts/spotify-window.mjs')));
  assert.ok(existsSync(join(profile, 'skills/tess-handoff/scripts/triage-inbox.mjs')));
  const windowScript = readFileSync(join(profile, 'skills/tess-evidence/scripts/spotify-window.mjs'), 'utf8');
  assert.match(windowScript, /execFileSync\('\/usr\/sbin\/screencapture'/);
  assert.doesNotMatch(windowScript, /'-D'|'-G'/);
  const wrapper = join(root, 'support/mac/skills/tess-handoff/scripts/triage-inbox.mjs');
  const notInbox = fails(wrapper, ['--report', '/tmp/doctor.txt', '--mode', 'issue'], baseEnv);
  assert.match(String(notInbox.stderr), /--mode inbox/);
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
  assert.equal(seen[0].url, '/v1/support/chat/completions');
  assert.equal(seen[0].authorization, `Bearer ${token}`);
  assert.equal(JSON.parse(seen[0].body).model, 'deepseek-v4.1-flash');

  const capped = await runAsync(chat, [], chatEnv).then(() => assert.fail('a 429 was treated as success'), (e) => e);
  assert.match(String(capped.stderr), /over the support cap/);
  assert.equal(seen.length, 2);
  server.close();

  writeFileSync(join(profile, '.env'), `TESS_SUPPORT_TOKEN=${token}\nTESS_INBOX=https://evil.example\n`, { mode: 0o600 });
  const foreign = await runAsync(chat, [], { ...chatEnv, TESS_INBOX: 'https://evil.example' }).then(
    () => assert.fail('a foreign host was accepted'),
    (e) => e,
  );
  assert.equal(foreign.status, 1);
  assert.match(String(foreign.stderr), /evil\.example is not the Tess support gate/);
  assert.ok(!`${foreign.stderr || ''}${foreign.stdout || ''}`.includes(token), 'the host refusal printed the token');

  const redirects = [];
  const redirectServer = await listen((req, res) => {
    redirects.push(req.url);
    res.writeHead(302, { location: 'https://evil.example/stolen' });
    res.end('go away');
  });
  const redirectPort = redirectServer.address().port;
  writeFileSync(join(profile, '.env'), `TESS_SUPPORT_TOKEN=${token}\nTESS_INBOX=http://127.0.0.1:${redirectPort}\n`, { mode: 0o600 });
  const redirected = await runAsync(chat, [], { ...chatEnv, TESS_INBOX: `http://127.0.0.1:${redirectPort}` }).then(
    () => assert.fail('a redirect was followed'),
    (e) => e,
  );
  assert.equal(redirected.status, 1);
  assert.match(String(redirected.stderr), /The gate redirected/);
  assert.ok(!`${redirected.stderr || ''}${redirected.stdout || ''}`.includes(token), 'the redirect refusal printed the token');
  assert.deepEqual(redirects, ['/v1/support/chat/completions']);
  redirectServer.close();

  const names = readdirSync(join(root, 'support'));
  assert.ok(names.includes('tess-support.service'));
  assert.ok(names.includes('tess-cap.service'));
} finally {
  rmSync(box, { recursive: true, force: true });
}
