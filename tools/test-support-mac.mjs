// The Mac tess-support profile: install into a scratch HERMES_HOME, point the model at the gate,
// keep the per-person token, and stop cleanly when the gate says 401.
// No real home, no real Spotify, no network except 127.0.0.1.
// Usage: node tools/test-support-mac.mjs
import { createServer } from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const install = join(root, 'support/mac/install.mjs');
const chat = join(root, 'support/mac/chat.mjs');
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
  let dir = '';
  try {
    const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('NFSHomeDirectory:'));
    dir = line?.slice('NFSHomeDirectory:'.length).trim() || '';
  } catch {
    const row = execFileSync('getent', ['passwd', user], { encoding: 'utf8' }).split('\n')[0] || '';
    dir = row.split(':')[5] || '';
  }
  if (!dir.startsWith('/')) throw new Error('the login home was not found');
  return dir;
};

// macOS often points TMPDIR at a folder under the login home. The installer then
// refuses its own scratch directory. /tmp is outside that home.
const scratchTmp = () => {
  const raw = tmpdir();
  let home = '';
  try { home = realpathSync(loginHome()); } catch { return raw; }
  let real = raw;
  try { real = realpathSync(raw); } catch { /* keep the path tmpdir reported */ }
  if (real === home || real.startsWith(`${home}/`)) return '/tmp';
  return raw;
};
const tempRoot = scratchTmp();
const box = mkdtempSync(join(tempRoot, 'tess-support-mac-test-'));

const listen = (onRequest) => new Promise((resolve) => {
  const server = createServer(onRequest);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const baseEnv = {
  PATH: process.env.PATH,
  HOME: join(box, 'home'),
  TMPDIR: tempRoot,
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
  const node = 'node $HERMES_HOME';
  const allow = [
    'tail -40 $HOME/Library/Application\\ Support/Tess/guard.log',
    `${node}/skills/tess-gather/scripts/doctor.mjs *`,
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs`,
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs still */cache/support/sessions/*/spotify.png`,
    `${node}/skills/tess-support/scripts/session.mjs new`,
    `${node}/skills/tess-support/scripts/session.mjs sweep`,
    `${node}/skills/tess-support/scripts/session.mjs handoff *`,
    `${node}/skills/tess-support/scripts/inbox.mjs issues`,
    `${node}/skills/tess-support/scripts/inbox.mjs report *`,
    `${node}/skills/tess-support/scripts/inbox.mjs recording *`,
    `${node}/skills/tess-handoff/scripts/triage-inbox.mjs --report * --words * --title-file * --summary-file * --mode inbox`,
    `${node}/skills/tess-handoff/scripts/triage-inbox.mjs --report * --words * --title-file * --summary-file * --also * --mode inbox`,
  ];
  const deny = [
    'sudo *', 'rm -rf *', 'rm -fr *', 'chmod -R *', 'dd *', 'mkfs*',
    'launchctl bootstrap*', 'launchctl submit*',
    '*curl*|*sh*', '*curl*|*bash*', '*/Applications/Spotify.app*',
    '*screencapture*', '*osascript*',
    'node -e*', 'node --eval*', 'node -p*',
    '*&&*', '*;*', '*|*', '*`*', '*$(*',
  ];
  assert.deepEqual(yamlItems(shipped, 'command_allowlist:'), allow);
  assert.deepEqual(yamlItems(shipped, '  deny:'), deny);
  assert.deepEqual(yamlItems(cfg, 'command_allowlist:'), allow);
  assert.deepEqual(yamlItems(cfg, '  deny:'), deny);
  const pass = [
    'tail -40 $HOME/Library/Application\\ Support/Tess/guard.log',
    `${node}/skills/tess-gather/scripts/doctor.mjs /tmp/sess`,
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs`,
    `${node}/skills/tess-evidence/scripts/spotify-window.mjs still /tmp/cache/support/sessions/visit/spotify.png`,
    `${node}/skills/tess-support/scripts/session.mjs new`,
    `${node}/skills/tess-support/scripts/session.mjs sweep`,
    `${node}/skills/tess-support/scripts/session.mjs handoff /tmp/cache/support/sessions/visit 12`,
    `${node}/skills/tess-support/scripts/inbox.mjs issues`,
    `${node}/skills/tess-support/scripts/inbox.mjs report /tmp/sess`,
    `${node}/skills/tess-support/scripts/inbox.mjs recording 12 /tmp/sess/spotify.mov`,
    `${node}/skills/tess-support/scripts/inbox.mjs recording 12 /tmp/sess/spotify.png`,
    `${node}/skills/tess-handoff/scripts/triage-inbox.mjs --report /tmp/cache/support/sessions/visit/doctor.txt --words /tmp/cache/support/sessions/visit/words.txt --title-file /tmp/cache/support/sessions/visit/title.txt --summary-file /tmp/cache/support/sessions/visit/summary.txt --mode inbox`,
    `${node}/skills/tess-handoff/scripts/triage-inbox.mjs --report /tmp/cache/support/sessions/visit/doctor.txt --words /tmp/cache/support/sessions/visit/words.txt --title-file /tmp/cache/support/sessions/visit/title.txt --summary-file /tmp/cache/support/sessions/visit/summary.txt --related 61 --mode inbox`,
    `${node}/skills/tess-handoff/scripts/triage-inbox.mjs --report /tmp/cache/support/sessions/visit/doctor.txt --words /tmp/cache/support/sessions/visit/words.txt --title-file /tmp/cache/support/sessions/visit/title.txt --summary-file /tmp/cache/support/sessions/visit/summary.txt --also area:theme --mode inbox`,
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
    'screencapture -x /tmp/desktop.png',
    'osascript -e \'tell application "Spotify"\'',
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
  assert.equal(allowMatch('tess doctor', allow), false, 'tess doctor is not pre-approved; doctor.mjs saves the output');
  assert.equal(allowMatch('zsh $HOME/Library/Application\\ Support/Tess/doctor.sh', allow), false, 'doctor.sh is not pre-approved');
  assert.equal(local[commands.length - 2].allow, false, 'tess doctor --help is broader than the doctor script');
  assert.equal(local[commands.length - 1].allow, false, 'a different program in front of session.mjs was pre-approved');
  assert.equal(allowMatch(`${node}/skills/tess-evidence/scripts/spotify-window.mjs still /tmp/spotify.png`, allow), false, 'a still outside the session root was pre-approved');
  assert.equal(allowMatch(`${node}/skills/tess-evidence/scripts/spotify-window.mjs video $HERMES_HOME/cache/support/spotify.mov`, allow), false, 'video capture was pre-approved');
  assert.equal(allowMatch(`${node}/skills/tess-support/scripts/session.mjs add /tmp/sess $HERMES_HOME/cache/support/spotify.mov --record`, allow), false, 'session add was pre-approved');
  assert.equal(allowMatch(`${node}/skills/tess-handoff/scripts/triage-inbox.mjs --report /tmp/cache/support/sessions/visit/doctor.txt --words /tmp/cache/support/sessions/visit/words.txt --title-file /tmp/cache/support/sessions/visit/title.txt --summary-file /tmp/cache/support/sessions/visit/summary.txt --mode inbox --also area:theme`, allow), false, '--also after --mode inbox was pre-approved');
  assert.match(shipped, /write_approval:\s*true/);
  for (const name of ['vision', 'catalog', 'project']) {
    assert.match(shipped, new RegExp(`^    - ${name}$`, 'm'), `${name} is still enabled`);
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
  assert.doesNotMatch(readFileSync(join(profile, 'skills/tess-evidence/SKILL.md'), 'utf8'), /spotify-window\.mjs video/);
  assert.match(readFileSync(join(profile, 'skills/tess-gather/SKILL.md'), 'utf8'), /tess_save_note/);
  assert.match(readFileSync(join(profile, 'skills/tess-gather/SKILL.md'), 'utf8'), /kind` `doctor`/);
  assert.match(readFileSync(join(profile, 'skills/tess-handoff/SKILL.md'), 'utf8'), /--also area:theme/);
  assert.match(cfg, /tess-notes/);
  assert.ok(existsSync(join(profile, 'plugins/tess-notes/__init__.py')));
  assert.ok(existsSync(join(profile, 'skills/tess-gather/scripts/doctor.mjs')));
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
  assert.match(windowScript, /inRoot/);
  assert.doesNotMatch(windowScript, /'-D'|'-G'|'-V'/);
  assert.doesNotMatch(windowScript, /mode === 'video'/);
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

  const { homeError } = await import(pathToFileURL(install).href);
  assert.equal(homeError('/tmp/scratch', '/tmp/scratch', '/Users/ada', { testMode: true }), '');
  assert.match(homeError('/Users/ada/.hermes', '/Users/ada/.hermes', '/Users/ada', { testMode: true }), /real home folder/);
  assert.equal(homeError('/Users/ada/.hermes', '/private/Users/ada/.hermes', '/Users/ada', { testMode: false }), '');
  assert.match(homeError('/Users/ada/Desktop', '/Users/ada/Desktop', '/Users/ada', { testMode: false }), /not ~\/\.hermes/);
  assert.match(homeError('/Users/ada/.hermes', '/tmp/elsewhere', '/Users/ada', { selfLink: true }), /symlink/);
  const linkTarget = join(box, 'link-target');
  mkdirSync(linkTarget);
  const linkHome = join(box, 'link-home');
  symlinkSync(linkTarget, linkHome);
  const linked = fails(install, [], { ...baseEnv, HERMES_HOME: linkHome, TESS_SUPPORT_TOKEN: token, TESS_TEST: '1' });
  assert.match(String(linked.stderr), /symlink/);
  const outside = join(box, 'outside-profile');
  mkdirSync(outside);
  const symHome = join(box, 'sym-profiles');
  mkdirSync(symHome);
  symlinkSync(outside, join(symHome, 'profiles'));
  const escaped = fails(install, [], { ...baseEnv, HERMES_HOME: symHome, TESS_SUPPORT_TOKEN: token, TESS_TEST: '1' });
  assert.match(String(escaped.stderr), /symlink/);
  assert.equal(existsSync(join(outside, 'tess-support')), false, 'a symlinked profiles folder was written through');

  const evilHome = join(box, 'evil-inbox');
  const evilInbox = fails(install, [], { ...baseEnv, HERMES_HOME: evilHome, TESS_SUPPORT_TOKEN: token, TESS_TEST: '1', TESS_INBOX: 'https://evil.example' });
  assert.match(String(evilInbox.stderr), /tess-music-player\.janus\.ing/);
  assert.ok(!`${evilInbox.stderr || ''}${evilInbox.stdout || ''}`.includes(token), 'the inbox refusal printed the token');
  assert.equal(existsSync(join(evilHome, 'profiles', 'tess-support', '.env')), false, 'a foreign inbox was written into .env');
  const plainHttp = fails(install, [], { ...baseEnv, HERMES_HOME: join(box, 'plain-http'), TESS_SUPPORT_TOKEN: token, TESS_INBOX: 'http://127.0.0.1:9' });
  assert.match(String(plainHttp.stderr), /tess-music-player\.janus\.ing/);
  const hop = join(box, 'hop-to-login');
  symlinkSync(real, hop);
  const viaLink = join(hop, '.tess-support-mac-ancestor-must-not-exist');
  const ancestor = fails(install, [], { ...baseEnv, HERMES_HOME: viaLink, TESS_SUPPORT_TOKEN: token, TESS_TEST: '1' });
  assert.match(String(ancestor.stderr), /real home folder/);
  assert.equal(existsSync(join(real, '.tess-support-mac-ancestor-must-not-exist')), false, 'mkdir followed a symlink into the real home');
  const leakedEnv = join(box, 'leaked.env');
  rmSync(join(profile, '.env'));
  symlinkSync(leakedEnv, join(profile, '.env'));
  const envLink = fails(install, [], env);
  assert.match(String(envLink.stderr), /symlink/);
  assert.equal(existsSync(leakedEnv), false, 'the installer followed a symlinked .env');

  // The visit, in the order the skills name, against a fake doctor, a fake capture and a fake inbox.
  // HERMES_HOME for these commands is the profile directory, which is what Hermes sets when the profile runs.
  const posted = [];
  const visitServer = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      posted.push({
        method: req.method,
        url: req.url,
        type: req.headers['content-type'] || '',
        body: Buffer.concat(chunks),
      });
      if (req.method === 'POST' && req.url === '/v1/support') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 7 }));
        return;
      }
      if (req.method === 'PUT' && req.url === '/v1/support/recording/7') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/issues') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ issues: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/support/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        return;
      }
      res.writeHead(404);
      res.end('no');
    });
  });
  const visitPort = visitServer.address().port;
  const visitHome = join(box, 'visit-hermes');
  const visitParent = {
    ...baseEnv,
    HERMES_HOME: visitHome,
    TESS_TEST: '1',
    TESS_SUPPORT_TOKEN: token,
    TESS_INBOX: `http://127.0.0.1:${visitPort}`,
  };
  assert.match(run(install, [], visitParent), /^via (copy|hermes)\n$/);
  // tmpdir() is /var/folders, which is a symlink to /private/var. session.mjs resolves its
  // own file URL, so the visit has to use that same real path or `add` refuses the capture.
  const visitProfile = realpathSync(join(visitHome, 'profiles', 'tess-support'));
  const bin = join(box, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tess'), '#!/bin/sh\necho "can\'t find Spotify"\necho "ada@example.com"\necho "/Users/ada/Library/Application Support/Tess/guard.log"\n', { mode: 0o755 });
  chmodSync(join(bin, 'tess'), 0o755);
  const visitEnv = {
    ...baseEnv,
    PATH: `${bin}:${process.env.PATH}`,
    HERMES_HOME: visitProfile,
    TESS_TEST: '1',
    TESS_FAKE_CAPTURE: '1',
    TESS_SUPPORT_TOKEN: token,
    TESS_INBOX: `http://127.0.0.1:${visitPort}`,
  };
  const sessionScript = join(visitProfile, 'skills/tess-support/scripts/session.mjs');
  const session = run(sessionScript, ['new'], visitEnv).trim();
  const windowScriptVisit = join(visitProfile, 'skills/tess-evidence/scripts/spotify-window.mjs');
  const outsidePng = join(box, 'spotify.png');
  const strayStill = fails(windowScriptVisit, ['still', outsidePng], visitEnv);
  assert.match(String(strayStill.stderr), /not a session folder/);
  assert.equal(existsSync(outsidePng), false, 'a still was written outside the session');
  assert.ok(!String(strayStill.stderr).includes(token), 'the still refusal printed the token');
  const wrongStill = fails(windowScriptVisit, ['still', join(session, 'shot.png')], visitEnv);
  assert.match(String(wrongStill.stderr), /spotify\.png/);
  const stillLink = join(box, 'linked-still.png');
  writeFileSync(stillLink, 'not-a-picture');
  symlinkSync(stillLink, join(session, 'spotify.png'));
  const linkedStill = fails(windowScriptVisit, ['still', join(session, 'spotify.png')], visitEnv);
  assert.match(String(linkedStill.stderr), /link/);
  assert.equal(readFileSync(stillLink, 'utf8'), 'not-a-picture', 'the still followed a symlink');
  rmSync(join(session, 'spotify.png'));
  const videoRefused = fails(windowScriptVisit, ['video', join(session, 'spotify.png')], visitEnv);
  assert.match(String(videoRefused.stderr), /usage/);
  run(join(visitProfile, 'skills/tess-gather/scripts/doctor.mjs'), [session], visitEnv);
  run(windowScriptVisit, ['still', join(session, 'spotify.png')], visitEnv);
  const noteScript = join(visitProfile, 'plugins/tess-notes/__init__.py');
  const saveNote = (kind, text) => JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("tess_notes", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
try:
    print(json.dumps(mod.save_note(sys.argv[2], sys.argv[3], sys.argv[4])))
except ValueError as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
`, noteScript, kind, text, visitProfile], { encoding: 'utf8' }));
  assert.equal(saveNote('words', 'the lyrics are behind. ada@example.com left /Users/ada/Library/Logs').ok, true);
  assert.equal(saveNote('title', 'Lyrics sit half a second behind the song').ok, true);
  assert.equal(saveNote('summary', 'Spotify itself is missing, which is what they noticed.').ok, true);
  assert.equal(saveNote('../.env', 'no').ok, false, 'a path is not a note');
  assert.equal(saveNote('words', '').ok, false, 'an empty note is refused');
  const tooLong = execFileSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("tess_notes", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
try:
    mod.save_note("summary", "x" * (64 * 1024 + 1), sys.argv[2])
except ValueError as exc:
    if "limit" not in str(exc):
        raise
    sys.exit(0)
sys.exit(2)
`, noteScript, visitProfile], { encoding: 'utf8' });
  assert.equal(tooLong, '');
  const steps = [
    'node $HERMES_HOME/skills/tess-support/scripts/session.mjs new',
    `node $HERMES_HOME/skills/tess-gather/scripts/doctor.mjs ${session}`,
    `node $HERMES_HOME/skills/tess-evidence/scripts/spotify-window.mjs still ${session}/spotify.png`,
    `node $HERMES_HOME/skills/tess-handoff/scripts/triage-inbox.mjs --report ${session}/doctor.txt --words ${session}/words.txt --title-file ${session}/title.txt --summary-file ${session}/summary.txt --mode inbox`,
    `node $HERMES_HOME/skills/tess-support/scripts/inbox.mjs report ${session}`,
    `node $HERMES_HOME/skills/tess-support/scripts/inbox.mjs recording 7 ${session}/spotify.png`,
    `node $HERMES_HOME/skills/tess-support/scripts/session.mjs handoff ${session} 7`,
  ];
  for (const line of steps) assert.equal(allowMatch(line, allow), true, `the visit needs an approval: ${line}`);
  for (const line of steps) assert.equal(denyMatch(line, deny), null, `the visit is denied: ${line}`);
  const triageInbox = join(visitProfile, 'skills/tess-handoff/scripts/triage-inbox.mjs');
  const elsewhere = join(box, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'doctor.txt'), 'not a session\n');
  const strayReport = fails(triageInbox, ['--report', join(elsewhere, 'doctor.txt'), '--mode', 'inbox'], visitEnv);
  assert.match(String(strayReport.stderr), /is not a session folder/);
  assert.equal(existsSync(join(elsewhere, 'payload.json')), false, 'a payload was written outside the session');
  const strayWords = fails(triageInbox, [
    '--report', join(session, 'doctor.txt'), '--words', join(elsewhere, 'doctor.txt'), '--mode', 'inbox',
  ], visitEnv);
  assert.match(String(strayWords.stderr), /--words must be/);
  const wrongName = fails(triageInbox, [
    '--report', join(session, 'doctor.txt'), '--title-file', join(session, 'words.txt'), '--mode', 'inbox',
  ], visitEnv);
  assert.match(String(wrongName.stderr), /--title-file must be/);
  assert.equal(existsSync(join(session, 'payload.json')), false, 'a refused line still wrote a payload');
  run(triageInbox, [
    '--report', join(session, 'doctor.txt'),
    '--words', join(session, 'words.txt'),
    '--title-file', join(session, 'title.txt'),
    '--summary-file', join(session, 'summary.txt'),
    '--mode', 'inbox',
  ], visitEnv);
  const png = readFileSync(join(session, 'spotify.png'));
  // inbox.mjs talks to the server in this process. A synchronous wait would stop it answering.
  const reported = await runAsync(join(visitProfile, 'skills/tess-support/scripts/inbox.mjs'), ['report', session], visitEnv);
  assert.match(reported, /report id: 7/);
  await runAsync(join(visitProfile, 'skills/tess-support/scripts/inbox.mjs'), ['recording', '7', join(session, 'spotify.png')], visitEnv);
  run(sessionScript, ['handoff', session, '7'], visitEnv);
  assert.equal(existsSync(session), false, 'the session folder is deleted after the post');
  const report = posted.find((item) => item.method === 'POST' && item.url === '/v1/support');
  const reportText = report.body.toString('utf8');
  assert.match(reportText, /Lyrics sit half a second behind the song/);
  assert.doesNotMatch(reportText, /ada@example\.com/);
  assert.doesNotMatch(reportText, /\/Users\/ada/);
  const image = posted.find((item) => item.method === 'PUT' && item.type.startsWith('image/png'));
  assert.ok(image && image.body.equals(png), 'the still reached the inbox');
  assert.equal(posted.some((item) => String(item.type).startsWith('video/')), false, 'the visit recorded a video');
  visitServer.close();

  const echoed = fails(sessionScript, ['handoff', token, '1'], visitEnv);
  assert.match(String(echoed.stderr), /not a session folder/);
  assert.ok(!`${echoed.stderr || ''}${echoed.stdout || ''}`.includes(token), 'a refused session path echoed the token');
  const echoedDoctor = fails(join(visitProfile, 'skills/tess-gather/scripts/doctor.mjs'), [token], visitEnv);
  assert.ok(!`${echoedDoctor.stderr || ''}${echoedDoctor.stdout || ''}`.includes(token), 'a refused doctor path echoed the token');
  const extraAdd = fails(sessionScript, ['add', session, join(box, 'spotify.png'), 'extra.mov', '--record'], visitEnv);
  assert.match(String(extraAdd.stderr), /usage/);

  const pluginSession = run(sessionScript, ['new'], visitEnv).trim();
  const noteHome = join(box, 'note-link-home');
  mkdirSync(join(noteHome, 'cache', 'support'), { recursive: true });
  const escapedSessions = join(box, 'escaped-sessions');
  mkdirSync(escapedSessions);
  symlinkSync(escapedSessions, join(noteHome, 'cache', 'support', 'sessions'));
  const cacheHome = join(box, 'cache-link-home');
  mkdirSync(cacheHome);
  const elsewhereCache = join(box, 'elsewhere-cache');
  mkdirSync(join(elsewhereCache, 'support', 'sessions'), { recursive: true });
  symlinkSync(elsewhereCache, join(cacheHome, 'cache'));
  const pluginOut = execFileSync('python3', ['-c', `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("tess_notes", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
hooks, tools = {}, {}
class Ctx:
    def register_tool(self, **kw):
        tools.update(kw)
    def register_hook(self, name, cb):
        hooks[name] = cb
mod.register(Ctx())
hook = hooks["pre_tool_call"]
blocked = hook("skill_manage", {"action": "write_file", "name": "tess-support", "file_path": "scripts/session.mjs", "file_content": "hack"})
assert blocked and blocked.get("action") == "block", blocked
assert hook("skills_list", {}) is None
assert hook("skill_view", {"name": "tess-gather"}) is None
assert hook("terminal", {"command": "node $HERMES_HOME/skills/tess-gather/scripts/doctor.mjs $TESS_SUPPORT_TOKEN"}).get("action") == "block"
assert hook("terminal", {"command": "tail -40 $HOME/Library/Application\\\\ Support/Tess/guard.log"}) is None
assert hook("terminal", {"command": "node $HERMES_HOME/skills/tess-support/scripts/session.mjs new"}) is None
for name in ("write_file", "patch", "read_file", "search_files", "manage_catalog", "desktop_project", "execute_code"):
    got = hook(name, {})
    assert got and got.get("action") == "block", name
for home in (sys.argv[2], sys.argv[3]):
    try:
        mod.save_note("words", "should not land", home)
    except ValueError as exc:
        assert "link" in str(exc), exc
        continue
    raise SystemExit("a symlinked session root was accepted")
fresh = sys.argv[4]
os.environ["HERMES_HOME"] = fresh
saved = json.loads(tools["handler"]({"kind": "doctor", "text": "tess doctor is not on this Mac"}))
assert saved.get("ok") is True, saved
mode = os.stat(os.path.join(mod.current_session(fresh), "doctor.txt")).st_mode & 0o777
assert mode == 0o600, mode
link = os.path.join(mod.current_session(fresh), "words.txt")
open(sys.argv[5], "w").write("keep")
os.symlink(sys.argv[5], link)
try:
    mod.save_note("words", "through the link", fresh)
except ValueError as exc:
    assert "link" in str(exc), exc
else:
    raise SystemExit("a symlinked note was written")
print("ok")
`, noteScript, noteHome, cacheHome, visitProfile, join(box, 'note-outside')], { encoding: 'utf8', env: { ...visitEnv, HERMES_HOME: visitProfile } });
  assert.equal(pluginOut.trim(), 'ok');
  assert.equal(readdirSync(escapedSessions).length, 0, 'a note was written through a symlinked sessions folder');
  assert.equal(readdirSync(join(elsewhereCache, 'support', 'sessions')).length, 0, 'a note was written through a symlinked cache');
  assert.equal(readFileSync(join(box, 'note-outside'), 'utf8'), 'keep', 'a symlinked note file was followed');
  assert.equal(readFileSync(join(pluginSession, 'doctor.txt'), 'utf8'), 'tess doctor is not on this Mac');
  assert.equal(statSync(join(pluginSession, 'doctor.txt')).mode & 0o777, 0o600);

  writeFileSync(join(bin, 'tess'), '#!/bin/sh\necho "Tess is in Spotify 1.2.52.442"\necho "  ✓ the look is the only complaint"\n', { mode: 0o755 });
  const clean = run(sessionScript, ['new'], visitEnv).trim();
  const newer = (Date.now() + 10000) / 1000;
  utimesSync(clean, newer, newer);
  run(join(visitProfile, 'skills/tess-gather/scripts/doctor.mjs'), [clean], visitEnv);
  utimesSync(clean, newer + 1, newer + 1);
  assert.equal(saveNote('words', 'the lyrics sit behind the song').ok, true);
  assert.equal(saveNote('title', 'Lyrics sit half a second behind the song').ok, true);
  assert.equal(saveNote('summary', 'The doctor is clean. The offset is in the theme.').ok, true);
  const cleanTriage = join(visitProfile, 'skills/tess-handoff/scripts/triage-inbox.mjs');
  const noArea = fails(cleanTriage, [
    '--report', join(clean, 'doctor.txt'),
    '--words', join(clean, 'words.txt'),
    '--title-file', join(clean, 'title.txt'),
    '--summary-file', join(clean, 'summary.txt'),
    '--mode', 'inbox',
  ], visitEnv);
  assert.match(String(noArea.stderr), /No area/);
  assert.equal(existsSync(join(clean, 'payload.json')), false, 'a clean doctor still wrote a payload');
  const alsoLine = `node $HERMES_HOME/skills/tess-handoff/scripts/triage-inbox.mjs --report ${clean}/doctor.txt --words ${clean}/words.txt --title-file ${clean}/title.txt --summary-file ${clean}/summary.txt --also area:theme --mode inbox`;
  assert.equal(allowMatch(alsoLine, allow), true, 'a clean-doctor --also line stops for approval');
  run(cleanTriage, [
    '--report', join(clean, 'doctor.txt'),
    '--words', join(clean, 'words.txt'),
    '--title-file', join(clean, 'title.txt'),
    '--summary-file', join(clean, 'summary.txt'),
    '--also', 'area:theme',
    '--mode', 'inbox',
  ], visitEnv);
  const cleanPayload = JSON.parse(readFileSync(join(clean, 'payload.json'), 'utf8'));
  assert.ok(cleanPayload.areas.includes('area: theme'), 'the clean doctor visit has no area');

  const names = readdirSync(join(root, 'support'));
  assert.ok(names.includes('tess-support.service'));
  assert.ok(names.includes('tess-cap.service'));
} finally {
  rmSync(box, { recursive: true, force: true });
}
