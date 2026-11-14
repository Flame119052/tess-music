// Test the Tess support bot: the triage step that turns a doctor report into a filed issue with its labels
// (support/bot/skills/tess-support/scripts/triage.mjs), the allowlist, and the server setup script
// (support/setup.sh) driven against a stub `hermes` and a real `tar` over a real archive.
// No network, no keys, no real Hermes, no issue created.
// Usage: node tools/test-support.mjs
// Proves: the label set survives triage and reaches the gh command; the personal-data scrub leaves four-part versions
// alone; --kind and the priority floor are enforced; the allowlist fails closed; setup.sh refuses to run on the machine
// that hosts Paperclip, unpacks GitHub's real archive layout, borrows the connected model, never changes anyone's
// default profile, and starts its own gateway.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKILL = join(root, 'support/bot/skills/tess-support');
const TRIAGE = join(SKILL, 'scripts/triage.mjs');
const ALLOW = join(SKILL, 'scripts/allowlist.mjs');
const SETUP = join(root, 'support/setup.sh');
const fix = (n) => join(SKILL, 'fixtures', n);

const box = mkdtempSync(join(tmpdir(), 'tess-support-test-'));
const out = (cmd, args, env = {}) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
const tri = (report, words, extra = []) => out(process.execPath, [TRIAGE, '--report', fix(report), '--words', fix(words), '--mode', 'issue', ...extra]);
const refuses = (args, expect, env = {}) => {
  try { out(process.execPath, args, env); } catch (e) {
    assert.notEqual(e.status, 0, 'refusal exited 0');
    assert.match(String(e.stderr) + String(e.stdout), expect);
    return;
  }
  assert.fail(`expected a refusal matching ${expect}`);
};

try {
  // --- triage --------------------------------------------------------------------------------------------------------
  // 1. A broken Spotify is urgent, labelled from the doctor's own evidence, and titled in words a person would use.
  const blank = tri('report-blank-spotify.txt', 'words-blank-spotify.txt', [
    '--tess', '0.1.9', '--kind', 'bug',
    '--title', 'Spotify opens as a black window and nothing loads',
    '--summary', 'The doctor says Spotify’s interface files are missing. This matches the blank-window failures already fixed once, so it is likely the same cause on a newer Spotify.',
    '--main', 'c55f610',
  ]);
  assert.match(blank, /^LABELS: P0: critical, area: installer, bug$/m, 'broken Spotify is P0 and an installer problem');

  // 2. Nothing personal gets out, even when the person types it themselves.
  for (const secret of ['example.com', 'sam.whitfield', '900123', '7700']) {
    assert.ok(!blank.includes(secret), `"${secret}" from their own words reached the public issue`);
  }
  assert.match(blank, /\(email\)/); assert.match(blank, /\(number\)/);
  assert.ok(!blank.includes('4f2a9c1e8b7d0a3f5e6c8b2d1a4f7e90'), 'the install id is not in the issue');

  // 3. A clean doctor plus a look problem is a look problem.
  const lyrics = tri('report-clean.txt', 'words-lyrics.txt', ['--tess', '0.1.9', '--title', 'Lyrics drift about half a second behind the song', '--also', 'area:theme']);
  assert.match(lyrics, /^LABELS: P2: medium, area: theme, bug$/m);
  assert.match(lyrics, /- Spotify: 1\.3\.9/);

  // 4. A four-part Spotify version is a version, not a phone number.
  const four = tri('report-four-part-version.txt', 'words-lyrics.txt', ['--title', 'Tess stops updating and the update helper has to be reinstalled']);
  assert.match(four, /Spotify 1\.2\.52\.442/, 'the four-part version survives the scrub');
  assert.ok(!four.includes('(number)'), 'and is not mistaken for a phone number');

  // 5. Evidence is the floor; the model may raise but not bury.
  const floored = tri('report-blank-spotify.txt', 'words-blank-spotify.txt', ['--priority', 'P3', '--title', 'Spotify opens as a black window and nothing loads']);
  assert.match(floored, /^LABELS: P0: critical, area: installer, bug$/m, 'a misread P3 still files as P0');
  const note = out(process.execPath, [TRIAGE, '--report', fix('report-blank-spotify.txt'), '--words', fix('words-blank-spotify.txt'), '--priority', 'P3', '--mode', 'krish']);
  assert.match(note, /the assessment said lower; the doctor's evidence holds it at P0/);
  const raised = tri('report-clean.txt', 'words-lyrics.txt', ['--priority', 'P1', '--also', 'area:theme', '--title', 'Lyrics drift about half a second behind the song']);
  assert.match(raised, /^LABELS: P1: high, area: theme, bug$/m, 'the model may raise priority');

  // 6. A blocked Mac is urgent but fixable in one sentence, so P1 with the exact setting in it.
  const blocked = tri('report-appmgmt-blocked.txt', 'words-blank-spotify.txt', ['--title', 'macOS blocks Tess from installing, with no clear next step']);
  assert.match(blocked, /^LABELS: P1: high, area: installer, bug$/m);
  assert.match(blocked, /App Management/);

  // 7. The gh command carries every label, and its body file is the same scrubbed text.
  const outDir = join(box, 'filing');
  const cmd = out(process.execPath, [TRIAGE, '--report', fix('report-blank-spotify.txt'), '--words', fix('words-blank-spotify.txt'), '--tess', '0.1.9', '--title', 'Spotify opens as a black window and nothing loads', '--mode', 'gh', '--out', outDir]).trim();
  assert.match(cmd, /^gh issue create -R Flame119052\/tess-music --title 'Spotify opens as a black window and nothing loads'/);
  assert.match(cmd, /--label 'P0: critical' --label 'area: installer' --label 'bug'/, 'triage rights: the labels ride on the command');
  assert.ok(!readFileSync(join(outDir, 'issue.md'), 'utf8').includes('900123'));

  // 8. A kind is a label, not a free word; a title that copied a path is refused; no area means ask, not guess.
  refuses([TRIAGE, '--report', fix('report-clean.txt'), '--words', fix('words-lyrics.txt'), '--also', 'area:theme', '--title', 'Lyrics drift', '--kind', 'whatever i feel like'], /--kind must be one of/);
  refuses([TRIAGE, '--report', fix('report-clean.txt'), '--words', fix('words-lyrics.txt'), '--also', 'area:theme', '--title', 'Fix theme/Tess/src/core.js'], /--title/);
  refuses([TRIAGE, '--report', fix('report-clean.txt'), '--words', fix('words-lyrics.txt'), '--title', 'Something looks wrong'], /area/);

  // 9. Reports off is said out loud instead of being claimed as sent.
  const off = tri('report-clean.txt', 'words-lyrics.txt', ['--also', 'area:theme', '--title', 'Lyrics drift about half a second behind the song']);
  assert.ok(!off.includes('may not have gone through'), 'a normal report is not hedged');
  const offFixture = join(box, 'reports-off.txt');
  writeFileSync(offFixture, readFileSync(fix('report-clean.txt'), 'utf8') + '\nCouldn\'t send the report (reports off, or offline).\n');
  const hedged = out(process.execPath, [TRIAGE, '--report', offFixture, '--words', fix('words-lyrics.txt'), '--mode', 'issue', '--also', 'area:theme', '--title', 'Lyrics drift half a second behind the song']);
  assert.match(hedged, /may not have gone through — reports are off on this Mac, or it was offline/, 'the person is not told a report went that did not');

  // 9b. The admin gate is Hermes', not the model's: configured, and written with Krish's own id by setup.sh.
  const cfg = readFileSync(join(root, 'support/bot/config.yaml'), 'utf8');
  assert.match(cfg, /allow_admin_from:/, 'the gateway has an admin list');
  assert.match(cfg, /user_allowed_commands:/, 'and a short list of what everyone else may run');
  const setupText = readFileSync(SETUP, 'utf8');
  assert.match(setupText, /config set gateway\.platforms\.telegram\.extra\.allow_admin_from/, 'setup.sh writes the admin list from Krish\'s id');

  // 10. The bot is seven skills, each short enough to load on its own and each saying when to use it.
  const skillNames = ['tess-support', 'tess-evidence', 'tess-repro', 'tess-duplicate', 'tess-gather', 'tess-triage', 'tess-handoff'];
  for (const name of skillNames) {
    const file = join(root, 'support/bot/skills', name, 'SKILL.md');
    assert.ok(existsSync(file), `${name} exists as its own skill file`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^---\n/, `${name} has frontmatter, so Hermes can load it by name`);
    assert.match(text, new RegExp(`name: ${name}`), `${name} declares its own name`);
    assert.match(text, /description: ".{40,}"/, `${name} says when to use it`);
    assert.match(text, /^## /m, `${name} has steps, not just a description`);
    assert.ok(text.split('\n').length < 160, `${name} is short enough to load on its own`);
    // A trigger word for each is in its description, which is what Hermes shows in the catalog.
    assert.match(text, /Use (when|for|as|immediately|once|before|whenever|at)/, `${name} says when it triggers`);
  }

  // --- the allowlist -------------------------------------------------------------------------------------------------
  const prof = join(box, 'hermes', 'profiles', 'tess-support');
  mkdirSync(prof, { recursive: true });
  const envFile = join(prof, '.env'), listFile = join(prof, 'allow.txt');
  writeFileSync(envFile, 'TELEGRAM_BOT_TOKEN=test\n');
  chmodSync(envFile, 0o644);   // deliberately loose: the script must tighten it
  // A stub `hermes` on PATH, so --restart is actually exercised instead of silently skipped.
  const hermesBin = join(box, 'hermes-bin');
  mkdirSync(hermesBin, { recursive: true });
  writeFileSync(join(hermesBin, 'hermes'), `#!/bin/sh\necho "hermes $*" >> "${join(box, 'hermes-calls')}"\nexit 0\n`);
  chmodSync(join(hermesBin, 'hermes'), 0o755);
  const aenv = { HERMES_HOME: join(box, 'hermes'), TESS_OWNER_ID: '900000001', PATH: `${hermesBin}:${process.env.PATH}` };
  const run = (...a) => out(process.execPath, [ALLOW, ...a], aenv);
  const denied = (...a) => {
    try { out(process.execPath, [ALLOW, ...a], aenv); assert.fail(`expected a refusal: ${a.join(' ')}`); } catch (e) { assert.notEqual(e.status, 0); assert.match(String(e.stderr), /Refused/); }
  };

  run('add', '111111111', 'Sam', '--as', '900000001');
  assert.match(readFileSync(listFile, 'utf8'), /^111111111 Sam$/m);
  assert.match(readFileSync(envFile, 'utf8'), /^TELEGRAM_ALLOWED_USERS=111111111$/m, 'the gateway list is rewritten');
  assert.match(readFileSync(envFile, 'utf8'), /^TELEGRAM_BOT_TOKEN=test$/m, 'the rest of .env is untouched');
  assert.equal(statSync(envFile).mode & 0o777, 0o600, '.env is 600');
  denied('add', '333333333', '--as', '222222222');     // someone who isn't Krish
  denied('add', '333333333');                          // no proof of who is asking
  denied('add', '*', '--as', '900000001');             // allow-all
  denied('add', '+447700900123', '--as', '900000001'); // a phone number is not a user id
  denied('list', '--as', '222222222');                 // the list itself is Krish's
  denied('remove', '900000001', '--as', '900000001');  // he cannot lock himself out
  assert.ok(!readFileSync(listFile, 'utf8').includes('333333333'), 'nothing refused was written');

  // 11. The payload the bot posts is exactly what the Worker accepts, and carries no secret.
  const inboxPayload = out(process.execPath, [TRIAGE, '--report', fix('report-blank-spotify.txt'), '--words', fix('words-blank-spotify.txt'), '--tess', '0.1.9', '--title', 'Spotify opens as a black window and nothing loads', '--mode', 'inbox']);
  const parsed = JSON.parse(inboxPayload);
  assert.deepEqual(Object.keys(parsed).sort(), ['areas', 'body', 'diagnosis', 'install', 'kind', 'macos', 'priority', 'spotify', 'tess', 'title', 'words'], 'the payload has only the fields the endpoint takes');
  assert.ok(/^P[0-3]$/.test(parsed.priority), 'a priority the Worker will accept');
  assert.ok(parsed.areas.every((a) => /^area: (theme|patcher|installer|mini|companion|release-ci|docs)$/.test(a)), 'areas the Worker will accept');
  assert.ok(['bug', 'enhancement', 'design', 'security', 'testing', 'documentation', 'spec'].includes(parsed.kind), 'a kind the Worker will accept');
  assert.ok(!JSON.stringify(parsed).includes('900123') && !JSON.stringify(parsed).includes('example.com'), 'and no personal data in it');
  assert.ok(!JSON.stringify(parsed).includes('tess_stub'), 'the posting token is never in the payload');

  // --- setup.sh, against a real tar over a real archive and a stub hermes --------------------------------------------
  // Finding 14: the download path was never exercised. This builds an archive with GitHub's real layout and lets the
  // real `tar` unpack it, so a wrong path inside the tarball fails here instead of on someone's server.
  const stage = join(box, 'stage'), archDir = join(stage, 'tess-music-main', 'support', 'bot');
  mkdirSync(archDir, { recursive: true });
  for (const f of ['SOUL.md', 'config.yaml', 'distribution.yaml']) writeFileSync(join(archDir, f), `# ${f}\n`);
  // The whole skill, scripts included: the setup script runs allowlist.mjs from inside it, and a test archive that
  // left it out would prove a setup that can't work.
  cpSync(join(SKILL, 'SKILL.md'), join(archDir, 'skills', 'tess-support', 'SKILL.md'));
  mkdirSync(join(archDir, 'skills', 'tess-support', 'scripts'), { recursive: true });
  for (const sc of ['allowlist.mjs', 'triage.mjs']) cpSync(join(SKILL, 'scripts', sc), join(archDir, 'skills', 'tess-support', 'scripts', sc));
  const archive = join(box, 'tess-music-main.tar.gz');
  out('/usr/bin/tar', ['-czf', archive, '-C', stage, 'tess-music-main']);

  const bin = join(box, 'bin'), state = join(box, 'state'), home = join(box, 'setup-home');
  mkdirSync(bin, { recursive: true }); mkdirSync(state, { recursive: true }); mkdirSync(home, { recursive: true });
  const stub = (name, body) => { const p = join(bin, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };
  stub('hermes', `
echo "hermes $*" >> "${state}/calls"
[ -n "$STUB_FAIL_PROFILE" ] && case "$*" in *"profile install"*) exit 1;; esac
if [ "$1" = "--version" ]; then echo "hermes 0.0.0-stub"; exit 0; fi
[ "$1" = "-p" ] && { P=$2; shift 2; } || P=default
case "$1 $2" in
  "profile show")   [ -f "${state}/installed" ] && exit 0; exit 1 ;;
  "profile install") touch "${state}/installed"; exit 0 ;;
esac
if [ "$1" = "config" ]; then
  case "$2" in
    get) cat "${state}/model.$P.$3" 2>/dev/null || true; exit 0 ;;
    set) printf '%s\\n' "$4" > "${state}/model.$P.$3"; exit 0 ;;
  esac
fi
if [ "$1" = "gateway" ]; then echo "gateway $2 for $P" >> "${state}/gateway"; exit 0; fi
exit 0
`);
  // curl is stubbed to hand over the real archive; tar is the real one, so the layout is genuinely tested.
  stub('curl', `cat "${archive}"; exit 0`);

  const senv = {
    // The stub hermes is first; the real node is left on PATH on purpose, so the allowlist script genuinely runs.
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HERMES_HOME: home,
    TESS_SUPPORT_BOT_DIR: '', TESS_TELEGRAM_TOKEN: '123:abc', TESS_OWNER_ID: '900000001',
    TESS_SUPPORT_NONINTERACTIVE: '1', TESS_SUPPORT_TOKEN: 'tess_stub',
  };
  writeFileSync(join(state, 'model.default.model.default'), 'glm-5\n');
  writeFileSync(join(state, 'model.default.model.provider'), 'nous\n');

  const setup = (extra = {}) => out('/bin/sh', [SETUP], { ...senv, ...extra });
  const calls = () => (existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8').match(/^.*$/gm) || [] : []);

  const ran = setup();
  const said = calls().join('\n');
  assert.match(said, /profile install .*\/bot --name tess-support --yes/, 'the bot is installed from the path the real tar produced');
  assert.match(said, /-p tess-support config set model.default/, 'the connected model is borrowed');
  assert.equal(readFileSync(join(state, 'model.tess-support.model.default'), 'utf8').trim(), 'glm-5');
  assert.match(said, /config set TELEGRAM_BOT_TOKEN/, 'the token is stored on the server');
  assert.match(said, /config set TESS_OWNER_ID/, 'and Krish is recorded as the only owner');
  assert.match(said, /config set TESS_SUPPORT_TOKEN/, 'the inbox posting token is stored');
  assert.match(said, /config set TESS_INBOX/, 'and so is where to post');
  assert.ok(!said.includes('GH_TOKEN'), 'no GitHub token anywhere: the bot posts to the inbox, not to GitHub');
  assert.match(readFileSync(join(state, 'gateway'), 'utf8'), /gateway start for tess-support/, 'the bot starts its own gateway');
  assert.ok(!said.includes('profile use'), 'it never changes which profile is the default for everything else');
  assert.match(ran, /Message the bot from Telegram/, 'and it says what to do next');
  assert.ok(existsSync(join(home, 'profiles', 'tess-support', 'allow.txt')) || existsSync(listFile), 'an allowlist was written');

  // 12. A machine with nothing connected gets OpenCode's free tier, not a request for a paid key.
  rmSync(join(state, 'model.default.model.default'), { force: true });
  rmSync(join(state, 'model.tess-support.model.default'), { force: true });
  rmSync(join(state, 'calls'), { force: true });
  const free = setup();
  assert.match(calls().join('\n'), /config set model.provider opencode/, 'the free tier is chosen when nothing is connected');
  assert.equal(readFileSync(join(state, 'model.tess-support.model.default'), 'utf8').trim(), 'deepseek-v4.1-flash-free');
  assert.match(free, /free tier/, 'and it says so rather than asking for a key');

  // Paperclip's machine is refused outright, before anything is installed.
  const pc = join(box, 'paperclip-host');
  mkdirSync(join(pc, 'paperclip'), { recursive: true });
  let pcOut = '';
  try { out('/bin/sh', [SETUP], { ...senv, HOME: pc }); } catch (e) { pcOut = String(e.stderr) + String(e.stdout); }
  assert.match(pcOut, /machine that runs Paperclip/, 'it will not run beside Paperclip');
  assert.ok(!/profile install/.test(pcOut), 'and installs nothing there');

  // A failed install is reported and the gateway is not started onto nothing.
  rmSync(join(state, 'gateway'), { force: true });
  let failed = '';
  try { out('/bin/sh', [SETUP], { ...senv, STUB_FAIL_PROFILE: '1' }); } catch (e) { failed = String(e.stderr) + String(e.stdout); }
  assert.match(failed, /couldn't (install|update) the tess-support profile/);
  assert.ok(!existsSync(join(state, 'gateway')), 'no gateway started for a bot that is not there');

  console.log('support bot: all checks passed\n');
  console.log([
    'checked:',
    '  · triage works out the P0–P3, area and kind labels, and the filing command on Krish\'s side carries them',
    '  · a four-part Spotify version survives the scrub; an email, phone number and install id do not',
    '  · a misread priority cannot go below the doctor\'s evidence, and --kind is checked against triage.md',
    '  · reports turned off are said out loud instead of being claimed as sent',
    '  · the allowlist refuses a wildcard, a phone number, a stranger and removing the owner, and keeps .env at 600',
    '  · a removal rewrites the gateway list, and --restart actually restarts the gateway',
    '  · the admin gate is Hermes\' own list, written with Krish\'s id by setup.sh',
    '  · setup.sh unpacks GitHub\'s real archive layout with the real tar, so the download path is actually tested',
    '  · it borrows the connected model, falls back to OpenCode\'s free tier, and stores the token, owner and inbox',
    '  · the payload it posts carries only fields the inbox accepts, and no token or personal data',
    '  · it never changes the default profile, refuses Paperclip\'s machine, and starts nothing after a failed install',
    '',
  ].join('\n'));
  console.log('─'.repeat(96));
  console.log('The exact command Krish\'s side files it with, and the issue text, for the blank-Spotify report:');
  console.log('─'.repeat(96) + '\n');
  console.log(cmd + '\n');
  console.log(blank);
} finally {
  rmSync(box, { recursive: true, force: true });
}
