// Test the Tess support bot: the triage step that turns a doctor report into a filed issue with its labels
// (support/bot/skills/tess-support/scripts/triage.mjs), the allowlist, and the server setup script
// (support/setup.sh) driven against a stub `hermes` and a real `tar` over a real archive.
// No network, no keys, no real Hermes, no issue created.
// Usage: node tools/test-support.mjs
// Proves: the label set survives triage and reaches the gh command; the personal-data scrub leaves four-part versions
// alone; --kind and the priority floor are enforced; the allowlist fails closed; setup.sh refuses to run on the machine
// that hosts Paperclip, unpacks GitHub's real archive layout, borrows the connected model, never changes anyone's
// default profile, and starts its own gateway.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

  // 7. The bot reports to the inbox and nothing else: there is no mode, and no command, that files on GitHub.
  refuses([TRIAGE, '--report', fix('report-clean.txt'), '--words', fix('words-lyrics.txt'), '--also', 'area:theme', '--title', 'Lyrics drift', '--mode', 'gh'], /never files a GitHub issue/);
  for (const mode of ['issue', 'krish', 'json', 'inbox']) {
    out(process.execPath, [TRIAGE, '--report', fix('report-blank-spotify.txt'), '--words', fix('words-blank-spotify.txt'), '--title', 'Spotify opens as a black window and nothing loads', '--mode', mode]);
  }
  // Every file the bot or the Mac profile can run, scanned for a GitHub write. Reading the public repo is fine; filing is not.
  const botFiles = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : botFiles.push(p); } };
  walk(join(root, 'support/bot'));
  walk(join(root, 'support/mac'));
  const ghub = botFiles.filter((f) => /gh issue|gh api|gh pr|api\.github\.com\/repos\/.*\/issues/i.test(readFileSync(f, 'utf8')));
  assert.deepEqual(ghub, [], 'nothing the bot or the Mac profile can run can file on GitHub');
  // The owner's side still has the one filing path, and it lives in the owner's tool.
  assert.match(readFileSync(join(root, 'tools/reports.mjs'), 'utf8'), /gh issue create/, 'Krish\'s tool is where an issue gets filed');

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

  // 9b. The admin gate is Hermes', not the model's, model defaults to opencode-go/deepseek-v4.1-flash pointed at the
  // local tess-cap proxy, secrets never reach argv, and both systemd units enforce strict VPS isolation.
  const cfg = readFileSync(join(root, 'support/bot/config.yaml'), 'utf8');
  assert.match(cfg, /allow_admin_from:/, 'the gateway has an admin list');
  assert.match(cfg, /user_allowed_commands:/, 'and a short list of what everyone else may run');
  assert.match(cfg, /provider:\s*opencode-go/, 'default provider is opencode-go');
  assert.match(cfg, /default:\s*deepseek-v4\.1-flash/, 'default model is deepseek-v4.1-flash');
  assert.match(cfg, /base_url:\s*http:\/\/127\.0\.0\.1:4193\/v1/, 'config points opencode-go at local tess-cap proxy');
  assert.match(cfg, /plugins:\s*\n\s*enabled:\s*\n\s*-\s*daily-cap/, 'daily-cap plugin is enabled');
  const distYaml = readFileSync(join(root, 'support/bot/distribution.yaml'), 'utf8');
  assert.match(distYaml, /-\s*plugins\b/, 'distribution_owned includes plugins so hermes copies daily-cap');
  assert.match(distYaml, /OPENCODE_GO_API_KEY/, 'distribution.yaml documents OPENCODE_GO_API_KEY');
  assert.match(distYaml, /OPENCODE_GO_BASE_URL/, 'distribution.yaml documents OPENCODE_GO_BASE_URL');
  const setupText = readFileSync(SETUP, 'utf8');
  assert.match(setupText, /config set gateway\.platforms\.telegram\.extra\.allow_admin_from/, 'setup.sh writes the admin list from Krish\'s id');
  assert.ok(!/config set (TELEGRAM_BOT_TOKEN|OPENCODE_GO_API_KEY|TESS_SUPPORT_TOKEN)/.test(setupText), 'setup.sh never puts secrets on config set argv');
  // No in-chat admin at all: the gate is shell access plus the unit's read-only files, and a chat command would put the
  // allowlist back within reach of the model that a stranger is talking to.
  for (const cmd of ['tess-allow', 'tess-deny', 'tess-who']) {
    assert.ok(!existsSync(join(root, 'support/bot/skills', cmd)), `${cmd} is not offered in chat`);
  }
  const unit = readFileSync(join(root, 'support/tess-support.service'), 'utf8');
  assert.match(unit, /ReadOnlyPaths=.*\.env/, 'the unit makes .env read-only to the bot');
  assert.match(unit, /ReadOnlyPaths=.*allow\.txt/, 'and the allowlist too');
  assert.ok(!/^StateDirectory=/m.test(unit), 'tess-support no longer holds StateDirectory (moved to tess-cap)');
  assert.match(unit, /After=.*tess-cap\.service/, 'tess-support orders after tess-cap.service');
  for (const directive of ['MemoryMax=512M', 'CPUQuota=50%', 'TasksMax=64', 'Nice=19', 'IOSchedulingClass=idle', 'NoNewPrivileges=yes', 'PrivateTmp=yes', 'ProtectSystem=strict', 'ProtectHome=read-only', 'ReadWritePaths=__HOME__', 'InaccessiblePaths=.*\\/srv\\/paperclip.*__CAP_HOME__.*\\/var\\/lib\\/tess-cap']) {
    assert.match(unit, new RegExp(directive), `unit sets ${directive}`);
  }
  const capUnit = readFileSync(join(root, 'support/tess-cap.service'), 'utf8');
  for (const directive of ['User=__CAP_USER__', 'StateDirectory=tess-cap', 'StateDirectoryMode=0700', 'MemoryMax=128M', 'MemorySwapMax=0', 'CPUQuota=25%', 'TasksMax=32', 'Nice=19', 'IOSchedulingClass=idle', 'NoNewPrivileges=yes', 'PrivateTmp=yes', 'ProtectSystem=strict', 'ProtectHome=read-only', 'ReadOnlyPaths=__CAP_HOME__\\/cap-proxy __CAP_HOME__\\/\\.env', 'InaccessiblePaths=.*\\/srv\\/paperclip.*__BOT_HOME__']) {
    assert.match(capUnit, new RegExp(directive), `tess-cap unit sets ${directive}`);
  }
  assert.ok(!/^\s+web,|, web\b/m.test(cfg.split('platform_toolsets')[1] || ''), 'the bot has no general web tool to send a token out with');

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

  // 10b. A title that came from a stranger's words goes in through a file, never as a shell argument.
  const titleFile = join(box, 'title.txt'), summaryFile = join(box, 'summary.txt');
  writeFileSync(titleFile, "Lyrics drift — Sam's window, 100% reproducible\n");
  writeFileSync(summaryFile, 'Two lines about $(whoami) and more, kept as text\n');
  const fromFiles = out(process.execPath, [TRIAGE, '--report', fix('report-clean.txt'), '--words', fix('words-lyrics.txt'), '--also', 'area:theme', '--title-file', titleFile, '--summary-file', summaryFile, '--mode', 'issue']);
  assert.match(fromFiles, /^TITLE: Lyrics drift — Sam's window, 100% reproducible$/m, 'a title from a file arrives byte for byte');
  assert.match(fromFiles, /Two lines about \$\(whoami\) and more, kept as text/, 'and so does the summary');
  // A title the inbox would refuse is refused here, before the bot posts and gets a 400.
  writeFileSync(titleFile, 'Lyrics drift $(id)\n');
  try { out(process.execPath, [TRIAGE, '--report', fix('report-clean.txt'), '--words', fix('words-lyrics.txt'), '--also', 'area:theme', '--title-file', titleFile]); assert.fail('expected a refusal'); }
  catch (e) { assert.match(String(e.stderr), /without shell characters/, 'a title with shell syntax is refused before it is sent'); }
  assert.ok(!/--title "/.test(readFileSync(join(root, 'support/bot/skills/tess-support/SKILL.md'), 'utf8')), 'the skill never tells the model to put a title in a shell argument');

  // 10c. A path or an email inside the doctor's own log block must not reach the issue.
  const dirty = join(box, 'dirty.txt');
  writeFileSync(dirty, readFileSync(fix('report-blank-spotify.txt'), 'utf8')
    .replace('  1 problem(s), 0 fixed.', '2026-11-14 09:12:44 tess could not read /Users/alice/Spotify.app for alice@example.com\n  1 problem(s), 0 fixed.'));
  const dirtyIssue = out(process.execPath, [TRIAGE, '--report', dirty, '--words', fix('words-blank-spotify.txt'), '--title', 'Spotify opens as a black window and nothing loads', '--mode', 'issue']);
  assert.ok(!/alice/.test(dirtyIssue), 'a home path and an email in the helper log are scrubbed like everything else');
  assert.match(dirtyIssue, /could not read ~/, 'the line is kept, with the path replaced');
  const dirtyPayload = JSON.parse(out(process.execPath, [TRIAGE, '--report', dirty, '--words', fix('words-blank-spotify.txt'), '--title', 'Spotify opens as a black window and nothing loads', '--mode', 'inbox']));
  assert.ok(!/alice/.test(JSON.stringify(dirtyPayload)), 'and the inbox payload does not carry it either');

  // 10d. A paste is the screen output of `tess report`, and doctor's own privacy pass only rewrites the JSON it sends,
  // so a home folder reaches the text as `~`, the Mac's name as `<name>.local`, and a file path in the Spotify line.
  // Bidi overrides and zero-width characters can reorder or hide a line on screen. None of it may survive into a public
  // issue, and none of it may ride along in the inbox payload either.
  const leakyReport = join(box, 'leaky.txt');
  writeFileSync(leakyReport, readFileSync(fix('report-clean.txt'), 'utf8')
    .replace('✓ Tess is in Spotify 1.3.9', '✓ Tess is in Spotify /Users/alice/Spotify.app'));
  const leakyWords = join(box, 'leaky-words.txt');
  writeFileSync(leakyWords, 'it broke on Krishs-MacBook-Pro.local and my key is at ~/.ssh/id_rsa\n'
    + 'the window is \u202eactually fine\u202c and there is a \u200bzero width here\n');
  const leaky = out(process.execPath, [TRIAGE, '--report', leakyReport, '--words', leakyWords, '--also', 'area:theme',
    '--title', 'Lyrics drift half a second behind the song', '--macos', '26.1', '--mode', 'issue']);
  const leakyPayload = JSON.parse(out(process.execPath, [TRIAGE, '--report', leakyReport, '--words', leakyWords,
    '--also', 'area:theme', '--title', 'Lyrics drift half a second behind the song', '--macos', '26.1', '--mode', 'inbox']));
  const leakyBoth = leaky + JSON.stringify(leakyPayload);
  for (const [what, re] of [
    ['a home folder', /alice/],
    ['a tilde path', /id_rsa/],
    ['a computer name', /MacBook|\.local/],
    ['a right-to-left override', /[\u202a-\u202e]/],
    ['a zero-width character', /[\u200b-\u200f\ufeff]/],
  ]) {
    assert.ok(!re.test(leakyBoth), `${what} is not in the issue or the payload`);
  }
  assert.equal(leakyPayload.spotify, 'unknown', 'a path where the Spotify version should be is not carried');
  assert.equal(leakyPayload.macos, '26.1', 'a real macOS version is');

  // 10d-2. A home folder is a home folder however it is written. The rule used to want a bare `~/` at the start of a
  // token, so a quote, an `=` or the account's own name after the tilde carried the path straight onto a public page.
  const quotedWords = join(box, 'quoted-words.txt');
  const quotedText = 'it stopped at "~/.ssh/id_rsa" and \'~bob/notes\' and path=~alice/x\n'
    + 'and "/Users/alice/secret", /users/alice/other, /var/folders/ab/xy/T/alice, ~bob alone\n';
  writeFileSync(quotedWords, quotedText);
  const quotedArgs = ['--report', fix('report-clean.txt'), '--words', quotedWords, '--also', 'area:theme',
    '--title', 'Lyrics drift half a second behind the song'];
  const quotedBoth = out(process.execPath, [TRIAGE, ...quotedArgs, '--mode', 'issue'])
    + out(process.execPath, [TRIAGE, ...quotedArgs, '--mode', 'inbox']);
  for (const [what, re] of [
    ['a quoted tilde path', /id_rsa/],
    ['a `~user` path', /bob/],
    ['a home path after an `=`', /alice/],
    ['a quoted absolute home path', /alice/],
    ['a lowercase home folder', /\/users/],
    ['a temp folder that names the account', /alice/],
  ]) {
    assert.ok(!re.test(quotedBoth), `${what} is not in the issue or the payload`);
  }
  // The same home folder in a title, in the form the slash check cannot see: a title that had to be scrubbed was copied,
  // not understood.
  writeFileSync(titleFile, 'Fix the ~bob account please\n');
  try {
    out(process.execPath, [TRIAGE, '--report', fix('report-clean.txt'), '--words', fix('words-lyrics.txt'), '--also', 'area:theme', '--title-file', titleFile]);
    assert.fail('expected a refusal');
  } catch (e) { assert.match(String(e.stderr), /personal detail/, 'a home folder naming an account in the title is refused'); }

  // 10d-3. Invisible characters outside the old strip list still hid a token: the Mongolian vowel separator, the
  // combining grapheme joiner, a variation selector and a deprecated bidi control. Every format character and every
  // invisible mark is removed before a pattern runs, so a split token is one token again by the time it is looked for.
  const hiddenWords = join(box, 'hidden-words.txt');
  writeFileSync(hiddenWords, ['\u180e', '\u034f', '\ufe0e', '\u206a'].map((sep) => `token 123456789:${sep}${'Q'.repeat(35)}`).join('\n')
    + '\nmail sam.whitfield\u180e@example.com\n');
  const hiddenArgs = ['--report', fix('report-clean.txt'), '--words', hiddenWords, '--also', 'area:theme',
    '--title', 'Lyrics drift half a second behind the song'];
  const hiddenBoth = out(process.execPath, [TRIAGE, ...hiddenArgs, '--mode', 'issue'])
    + out(process.execPath, [TRIAGE, ...hiddenArgs, '--mode', 'inbox']);
  assert.ok(!/Q{10}/.test(hiddenBoth), 'a token split by an invisible character is redacted');
  assert.ok(!/sam\.whitfield|example\.com/.test(hiddenBoth), 'and so is an email split by one');
  for (const sep of ['\u180e', '\u034f', '\ufe0e', '\u206a']) {
    assert.ok(!hiddenBoth.includes(sep), 'and the invisible character itself is gone');
  }

  // 10d-4. One set of rules, not two. The bot and the inbox used to keep their own copy of the same list and drifted;
  // a rule that exists on one side is a rule a stranger walks around on the other. The cleaning lives once, both import
  // it, and the two agree on the same text.
  const { clean } = await import(join(SKILL, 'scripts/privacy.mjs'));
  const triageText = readFileSync(TRIAGE, 'utf8');
  const workerText = readFileSync(join(root, 'inbox/worker.js'), 'utf8');
  assert.match(triageText, /from '\.\/privacy\.mjs'/, 'the bot cleans with the shared rules');
  assert.match(workerText, /privacy\.mjs/, 'and so does the inbox');
  assert.ok(!/INVISIBLE =/.test(triageText) && !/PERSONAL =\[|const PERSONAL/.test(triageText), 'the bot has no copy of the list');
  assert.ok(!/INVISIBLE =/.test(workerText) && !/const PERSONAL/.test(workerText), 'and neither does the inbox');
  const sharedSample = 'at "~/.ssh/id_rsa" or "sam.whitfield@example.com" or 123456789:\u180e' + 'Q'.repeat(35);
  const sharedWords = join(box, 'shared-words.txt');
  writeFileSync(sharedWords, sharedSample);
  const sharedPayload = JSON.parse(out(process.execPath, [TRIAGE, '--report', fix('report-clean.txt'), '--words',
    sharedWords, '--also', 'area:theme', '--title', 'Lyrics drift half a second behind the song', '--mode', 'inbox']));
  assert.equal(sharedPayload.words, clean(sharedSample).trim(), 'the bot\'s own words are exactly what the shared rules make of them');

  // 10e. The posting token is never in a command. The bot's shell is driven by a model reading a stranger's message, so
  // a message that changes the host, or asks for the token, must have nothing to change and nothing to read: one script
  // holds the address and the token, and refuses anything else.
  const handoffSkill = readFileSync(join(root, 'support/bot/skills/tess-handoff/SKILL.md'), 'utf8');
  const dupSkill = readFileSync(join(root, 'support/bot/skills/tess-duplicate/SKILL.md'), 'utf8');
  const supportSkill = readFileSync(join(root, 'support/bot/skills/tess-support/SKILL.md'), 'utf8');
  for (const [name, text] of [['tess-handoff', handoffSkill], ['tess-duplicate', dupSkill], ['tess-support', supportSkill]]) {
    assert.ok(!/\$TESS_SUPPORT_TOKEN|\$TESS_INBOX|Bearer \$/.test(text), `${name} never puts the token or the inbox address in a command`);
  }
  assert.match(handoffSkill, /inbox\.mjs" report/, 'the hand-off posts with the inbox script');
  assert.match(dupSkill, /inbox\.mjs" issues/, 'and the duplicate check reads the titles through it');

  const INBOX = join(SKILL, 'scripts/inbox.mjs');
  const sessions = join(box, 'sessions');
  const payloadDir = join(sessions, '2026-01-01T00-00-00-abc');
  mkdirSync(payloadDir, { recursive: true });
  const payload = {
    priority: 'P2', kind: 'bug', areas: ['area: theme'], title: 'Lyrics drift half a second behind the song',
    words: 'the lyrics are always behind', diagnosis: 'the sync offset', body: '## What happened\n\nthe lyrics drift\n',
  };
  writeFileSync(join(payloadDir, 'payload.json'), JSON.stringify(payload));
  const postToken = `tess_${'c'.repeat(64)}`;
  const inbox = (args, extra = {}) => out(process.execPath, [INBOX, ...args], {
    TESS_SESSION_ROOT: sessions, TESS_SUPPORT_TOKEN: postToken, TESS_INBOX: `https://tess-music-player.janus.ing`, ...extra,
  });
  const refusesToPost = (args, expect, extra = {}, what = '') => {
    try { inbox(args, extra); } catch (e) {
      assert.notEqual(e.status, 0, 'the refusal exited 0');
      assert.match(String(e.stderr), expect, what);
      return String(e.stderr);
    }
    assert.fail(`expected a refusal matching ${expect}${what ? ` (${what})` : ''}`);
  };

  // A host that is not the Tess inbox is refused before any request is made, so a message cannot walk the token out.
  const redirected = refusesToPost(['report', payloadDir], /is not the Tess inbox/, { TESS_INBOX: 'https://example.com' });
  assert.ok(!redirected.includes(postToken), 'and the refusal does not print the token');
  // A payload that picked a token up on the way is refused too: the report is not the place for one.
  writeFileSync(join(payloadDir, 'payload.json'), JSON.stringify({ ...payload, words: `my key is ${postToken}` }));
  refusesToPost(['report', payloadDir], /looks like a token|own posting token/);
  writeFileSync(join(payloadDir, 'payload.json'), JSON.stringify(payload));

  // A real POST, against a loopback server this test owns. The token travels in the header, and it is nowhere in what
  // the script prints.
  const portFile = join(box, 'port'), seenFile = join(box, 'seen.json');
  const serverCode = `
    const http = require('node:http');
    const { writeFileSync } = require('node:fs');
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body }));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: 7 }));
      });
    });
    s.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(portFile)}, String(s.address().port)));
  `;
  const server = spawn(process.execPath, ['-e', serverCode], { stdio: 'ignore' });
  const waitFor = (p) => {
    const until = Date.now() + 10000;
    while (!existsSync(p) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
  };
  try {
    const port = waitFor(portFile);
    assert.ok(port, 'the test inbox is listening');
    const said = inbox(['report', payloadDir], { TESS_TEST: '1', TESS_INBOX: `http://127.0.0.1:${port}` });
    assert.match(said, /report id: 7/, 'the script prints the id the inbox answered with');
    assert.ok(!said.includes(postToken), 'and never the token');
    const seen = JSON.parse(readFileSync(seenFile, 'utf8'));
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v1/support', 'the report goes to the support route');
    assert.equal(seen.auth, `Bearer ${postToken}`, 'with the token in the header, not on the command line');
    assert.equal(seen.type, 'application/json');
    assert.deepEqual(JSON.parse(seen.body), payload, 'and the payload the session folder holds');
  } finally {
    server.kill();
  }

  // 11b. The session folder holds files, not links. A `clip.mov` that is a symlink to the bot's own `.env` was read and
  // uploaded as a recording, and a `payload.json` that was a symlink to a file outside the session was posted as the
  // report — so a message could choose what left the machine. The real path must be inside the session folder, a file
  // with a second name is refused, and the bytes come from the handle that was checked. `--dry-run` keeps this off the
  // network: the refusal must happen while the file is being opened, before anything is sent.
  const linkBox = join(box, 'links');
  mkdirSync(linkBox, { recursive: true });
  const botEnv = join(linkBox, '.env');
  writeFileSync(botEnv, `TELEGRAM_BOT_TOKEN=123456789:${'S'.repeat(35)}\nghp_${'a'.repeat(36)}\n`
    + '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n');
  const linkDir = join(sessions, '2026-01-02T00-00-00-lnk');
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(botEnv, join(linkDir, 'clip.mov'));
  linkSync(botEnv, join(linkDir, 'taken.mov'));
  symlinkSync(botEnv, join(linkDir, 'payload.json'));
  const linkPayloadDir = join(sessions, '2026-01-03T00-00-00-lnk');
  mkdirSync(linkPayloadDir, { recursive: true });
  linkSync(botEnv, join(linkPayloadDir, 'payload.json'));
  refusesToPost(['recording', '7', join(linkDir, 'clip.mov'), '--dry-run'], /not a plain file|another name/, {}, 'a recording that is a link to .env');
  refusesToPost(['recording', '7', join(linkDir, 'taken.mov'), '--dry-run'], /not a plain file|another name/, {}, 'a recording that is a hard link to .env');
  refusesToPost(['report', linkDir, '--dry-run'], /not a plain file|another name/, {}, 'a payload that is a link to .env');
  refusesToPost(['report', linkPayloadDir, '--dry-run'], /not a plain file|another name/, {}, 'a payload that is a hard link to .env');
  assert.match(readFileSync(botEnv, 'utf8'), /TELEGRAM_BOT_TOKEN/, 'and the file they pointed at is untouched');
  rmSync(linkBox, { recursive: true, force: true });

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
  // The profile is derived from the script's own location in production, so the test points it there directly.
  const aenv = { TESS_PROFILE_DIR: prof, TESS_OWNER_ID: '900000001', PATH: `${hermesBin}:${process.env.PATH}` };
  const run = (...a) => out(process.execPath, [ALLOW, ...a], aenv);
  const denied = (...a) => {
    try { out(process.execPath, [ALLOW, ...a], aenv); assert.fail(`expected a refusal: ${a.join(' ')}`); } catch (e) { assert.notEqual(e.status, 0); assert.match(String(e.stderr), /Refused/); }
  };

  run('add', '111111111', 'Sam', '--as', '900000001');
  assert.match(readFileSync(listFile, 'utf8'), /^111111111 Sam$/m);
  assert.match(readFileSync(envFile, 'utf8'), /^TELEGRAM_ALLOWED_USERS=111111111$/m, 'the gateway list is rewritten');
  assert.match(readFileSync(envFile, 'utf8'), /^TELEGRAM_BOT_TOKEN=test$/m, 'the rest of .env is untouched');
  assert.equal(statSync(envFile).mode & 0o777, 0o600, '.env is 600');
  // Who may run this is decided by shell access and by the unit's read-only files, not by an argument, so there is
  // deliberately no "wrong caller" case here any more — asserting one would be claiming a gate that does not exist.
  denied('add', '*', '--as', '900000001');             // allow-all
  denied('add', '+447700900123', '--as', '900000001'); // a phone number is not a user id
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
  // Include skills and the daily-cap plugin: setup.sh runs allowlist.mjs and installs plugins/daily-cap.
  cpSync(join(SKILL, 'SKILL.md'), join(archDir, 'skills', 'tess-support', 'SKILL.md'));
  mkdirSync(join(archDir, 'skills', 'tess-support', 'scripts'), { recursive: true });
  for (const sc of ['allowlist.mjs', 'triage.mjs', 'inbox.mjs', 'privacy.mjs']) cpSync(join(SKILL, 'scripts', sc), join(archDir, 'skills', 'tess-support', 'scripts', sc));
  mkdirSync(join(archDir, 'plugins', 'daily-cap'), { recursive: true });
  cpSync(join(root, 'support/bot/plugins/daily-cap/plugin.yaml'), join(archDir, 'plugins', 'daily-cap/plugin.yaml'));
  cpSync(join(root, 'support/bot/plugins/daily-cap/__init__.py'), join(archDir, 'plugins', 'daily-cap/__init__.py'));
  // The download carries support/ as a whole, so cap-proxy and both unit templates sit beside the bot.
  mkdirSync(join(stage, 'tess-music-main', 'support', 'cap-proxy'), { recursive: true });
  cpSync(join(root, 'support/cap-proxy/proxy.mjs'), join(stage, 'tess-music-main', 'support', 'cap-proxy/proxy.mjs'));
  cpSync(join(root, 'support/tess-support.service'), join(stage, 'tess-music-main', 'support', 'tess-support.service'));
  cpSync(join(root, 'support/tess-cap.service'), join(stage, 'tess-music-main', 'support', 'tess-cap.service'));
  const archive = join(box, 'tess-music-main.tar.gz');
  out('/usr/bin/tar', ['-czf', archive, '-C', stage, 'tess-music-main']);

  const bin = join(box, 'bin'), state = join(box, 'state'), home = join(box, 'setup-home'), userHome = join(box, 'user-home');
  mkdirSync(bin, { recursive: true }); mkdirSync(state, { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(userHome, { recursive: true });
  const stub = (name, body, dir = bin) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };
  stub('hermes', `
echo "hermes $*" >> "${state}/calls"
[ -n "$STUB_FAIL_PROFILE" ] && case "$*" in *"profile install"*) exit 1;; esac
if [ "$1" = "--version" ]; then echo "hermes 0.0.0-stub"; exit 0; fi
[ "$1" = "-p" ] && { P=$2; shift 2; } || P=default
case "$1 $2" in
  "profile show")   [ -f "${state}/installed" ] && exit 0; exit 1 ;;
  "profile install")
    # A real install copies the profile in; the test needs that too, because setup.sh then runs the installed copy.
    share=$3; name=""
    shift 3
    while [ $# -gt 0 ]; do [ "$1" = "--name" ] && name=$2; shift; done
    mkdir -p "$HERMES_HOME/profiles/$name"
    cp -R "$share/." "$HERMES_HOME/profiles/$name/" || exit 1
    touch "${state}/installed"; exit 0 ;;
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

  const tgSecret = '123:abc_secret';
  const goSecret = 'og_go_stub_secret';
  const supSecret = 'tess_stub_secret';
  const senv = {
    // The stub hermes is first; the real node is left on PATH on purpose, so the allowlist script genuinely runs.
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: userHome, HERMES_HOME: home, TESS_TEST: '1',
    TESS_SUPPORT_BOT_DIR: '', TESS_TELEGRAM_TOKEN: tgSecret, TESS_OWNER_ID: '900000001',
    TESS_SUPPORT_NONINTERACTIVE: '1', TESS_SUPPORT_TOKEN: supSecret, OPENCODE_GO_API_KEY: goSecret,
  };

  const setup = (extra = {}) => out('/bin/sh', [SETUP], { ...senv, TESS_TEST_NO_SYSTEMCTL: '1', ...extra });
  const calls = () => (existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8').match(/^.*$/gm) || [] : []);

  const ran = setup();
  const said = calls().join('\n');
  assert.match(said, /profile install .*\/bot --name tess-support --yes/, 'the bot is installed from the path the real tar produced');
  assert.match(said, /config set model\.provider opencode-go/, 'default provider is opencode-go');
  assert.match(said, /config set model\.default deepseek-v4\.1-flash/, 'default model is deepseek-v4.1-flash');
  assert.match(said, /config set model\.base_url http:\/\/127\.0\.0\.1:4193\/v1/, 'base_url points at tess-cap proxy');
  assert.equal(readFileSync(join(state, 'model.tess-support.model.provider'), 'utf8').trim(), 'opencode-go');
  assert.equal(readFileSync(join(state, 'model.tess-support.model.default'), 'utf8').trim(), 'deepseek-v4.1-flash');
  assert.equal(readFileSync(join(state, 'model.tess-support.model.base_url'), 'utf8').trim(), 'http://127.0.0.1:4193/v1');
  assert.ok(!said.includes(tgSecret) && !said.includes(goSecret) && !said.includes(supSecret), 'no secret ever enters CLI arguments');
  assert.ok(!said.includes('GH_TOKEN'), 'no GitHub token anywhere: the bot posts to the inbox, not to GitHub');
  assert.match(readFileSync(join(state, 'gateway'), 'utf8'), /gateway start for tess-support/, 'the bot starts its own gateway when systemctl is absent');
  assert.ok(!said.includes('profile use'), 'it never changes which profile is the default for everything else');
  assert.match(ran, /Message the bot from Telegram/, 'and it says what to do next');

  const profDir = join(home, 'profiles', 'tess-support');
  const setupEnv = join(profDir, '.env');
  const capHomeNonRoot = join(box, 'tess-cap');
  const capEnvNonRoot = join(capHomeNonRoot, '.env');
  const setupList = join(profDir, 'allow.txt');
  assert.ok(existsSync(setupEnv), 'setup.sh wrote .env under the profile');
  assert.ok(existsSync(capEnvNonRoot), 'setup.sh wrote tess-cap .env');
  assert.ok(existsSync(join(capHomeNonRoot, 'cap-proxy', 'proxy.mjs')), 'setup.sh installed cap-proxy');
  assert.equal(statSync(setupEnv).mode & 0o777, 0o600, '.env is mode 600');
  assert.equal(statSync(capEnvNonRoot).mode & 0o777, 0o600, 'tess-cap .env is mode 600');

  const setupEnvText = readFileSync(setupEnv, 'utf8');
  const capEnvText = readFileSync(capEnvNonRoot, 'utf8');
  assert.ok(!setupEnvText.includes(goSecret), 'real OPENCODE_GO_API_KEY never enters tess-support .env');
  assert.match(capEnvText, new RegExp(`^OPENCODE_GO_API_KEY=${goSecret}$`, 'm'), 'real key lives in tess-cap .env');
  const proxyTokenMatch = capEnvText.match(/^TESS_CAP_PROXY_TOKEN=(.+)$/m);
  assert.ok(proxyTokenMatch && proxyTokenMatch[1] && proxyTokenMatch[1] !== goSecret, 'distinct local proxy token minted');
  const mintedProxyToken = proxyTokenMatch[1];
  assert.match(setupEnvText, new RegExp(`^OPENCODE_GO_API_KEY=${mintedProxyToken}$`, 'm'), 'bot .env holds proxy token');
  assert.match(setupEnvText, /^OPENCODE_GO_BASE_URL=http:\/\/127\.0\.0\.1:4193\/v1$/m);
  assert.match(setupEnvText, new RegExp(`^TELEGRAM_BOT_TOKEN=${tgSecret}$`, 'm'));
  assert.match(setupEnvText, /^TESS_OWNER_ID=900000001$/m);
  assert.match(setupEnvText, new RegExp(`^TESS_SUPPORT_TOKEN=${supSecret}$`, 'm'));
  assert.match(setupEnvText, /^TESS_INBOX=https:\/\/tess-music-player\.janus\.ing$/m);
  assert.match(capEnvText, /^TESS_DAILY_REPLY_CAP=40$/m);
  assert.match(capEnvText, /^TESS_DAILY_USER_CAP=20$/m);
  assert.match(setupEnvText, /^TELEGRAM_ALLOWED_USERS=900000001$/m);
  assert.ok(existsSync(join(profDir, 'plugins', 'daily-cap', '__init__.py')), 'daily-cap plugin installed in profile');
  assert.ok(existsSync(setupList), 'setup.sh wrote an allowlist under the Hermes home');
  assert.match(readFileSync(setupList, 'utf8'), /^900000001 Krish$/m, 'starting with Krish');

  // 12. Idempotent re-run with TESS_ALLOW_IDS + custom caps, then re-run without TESS_ALLOW_IDS preserving tester + caps + proxy token.
  rmSync(join(state, 'calls'), { force: true });
  setup({ TESS_ALLOW_IDS: '222222222', TESS_DAILY_REPLY_CAP: '50', TESS_DAILY_USER_CAP: '15', TESS_DAILY_TOKEN_CAP: '250000' });
  assert.match(calls().join('\n'), /profile install .* --name tess-support --force --yes/, 'second run updates in place with --force');
  assert.match(readFileSync(setupList, 'utf8'), /^222222222 tester$/m, 'TESS_ALLOW_IDS seeds the trusted tester');
  const envAfterTester = readFileSync(setupEnv, 'utf8');
  const capEnvAfterTester = readFileSync(capEnvNonRoot, 'utf8');
  assert.match(envAfterTester, /^TELEGRAM_ALLOWED_USERS=900000001,222222222$/m);
  assert.match(capEnvAfterTester, /^TESS_DAILY_REPLY_CAP=50$/m);
  assert.match(capEnvAfterTester, /^TESS_DAILY_USER_CAP=15$/m);
  assert.match(capEnvAfterTester, /^TESS_DAILY_TOKEN_CAP=250000$/m);
  assert.match(capEnvAfterTester, new RegExp(`^TESS_CAP_PROXY_TOKEN=${mintedProxyToken}$`, 'm'), 're-run preserves proxy token');

  setup();
  const envPreserved = readFileSync(setupEnv, 'utf8');
  const capEnvPreserved = readFileSync(capEnvNonRoot, 'utf8');
  assert.match(envPreserved, /^TELEGRAM_ALLOWED_USERS=900000001,222222222$/m, 're-run preserves existing tester');
  assert.match(capEnvPreserved, /^TESS_DAILY_REPLY_CAP=50$/m, 're-run preserves existing cap');
  assert.match(capEnvPreserved, /^TESS_DAILY_TOKEN_CAP=250000$/m, 're-run preserves existing token cap');

  // Missing OPENCODE_GO_API_KEY, bad TESS_ALLOW_IDS, bad TESS_CAP_PORT, and control characters in inputs are refused upfront.
  for (const [label, extra, expect] of [
    ['missing OpenCode Go key', { OPENCODE_GO_API_KEY: '' }, /OPENCODE_GO_API_KEY/],
    ['wildcard TESS_ALLOW_IDS', { TESS_ALLOW_IDS: '*' }, /TESS_ALLOW_IDS/],
    ['bad TESS_CAP_PORT', { TESS_CAP_PORT: '99999' }, /TESS_CAP_PORT/],
    ['newline in secret', { OPENCODE_GO_API_KEY: 'abc\ndef' }, /control characters/],
  ]) {
    let err = '';
    try { setup(extra); assert.fail(`expected refusal for ${label}`); } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; err = String(e.stderr) + String(e.stdout); }
    assert.match(err, expect, label);
  }

  // 13. Simulated root VPS install: creates `tess-support` and `tess-cap` users, runs Hermes/allowlist via runuser,
  // puts real key only in tess-cap/.env, writes both units to TESS_SYSTEMD_DIR, enables & restarts tess-cap then tess-support.
  const vpsBox = join(box, 'vps');
  const vpsBin = join(vpsBox, 'bin'), vpsHome = join(vpsBox, 'home', 'tess-support'), vpsCapHome = join(vpsBox, 'home', 'tess-cap'), vpsUnitDir = join(vpsBox, 'systemd'), vpsState = join(vpsBox, 'state');
  mkdirSync(vpsBin, { recursive: true }); mkdirSync(vpsUnitDir, { recursive: true }); mkdirSync(vpsState, { recursive: true });
  rmSync(join(state, 'calls'), { force: true });
  rmSync(join(state, 'installed'), { force: true });
  rmSync(join(state, 'gateway'), { force: true });
  stub('id', `
if [ "$1" = "-u" ] && [ -z "$2" ]; then echo 0; exit 0; fi
if [ "$1" = "-u" ] && [ -n "$2" ]; then
  if [ "$2" = "tess-support" ] && [ -f "${vpsState}/user-tess-support" ]; then echo "\${TESS_TEST_BOT_UID:-998}"; exit 0; fi
  if [ "$2" = "tess-cap" ] && [ -f "${vpsState}/user-tess-cap" ]; then echo "\${TESS_TEST_CAP_UID:-997}"; exit 0; fi
  exit 1
fi
if [ "$1" = "-un" ] && [ -z "$2" ]; then echo root; exit 0; fi
if [ -n "$1" ] && [ -f "${vpsState}/user-$1" ]; then exit 0; fi
exit 1
`, vpsBin);
  stub('useradd', `
for _ua in "$@"; do _last=$_ua; done
echo "useradd $*" >> "${vpsState}/sys"
touch "${vpsState}/user-$_last"
exit 0
`, vpsBin);
  stub('chown', `echo "chown $*" >> "${vpsState}/sys"; exit 0`, vpsBin);
  stub('runuser', `
[ "$1" = "-u" ] || exit 2
U=$2; shift 2
[ "$1" = "--" ] && shift
[ "$1" = "env" ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    *=*) export "$1"; shift ;;
    *) break ;;
  esac
done
echo "runuser $U $*" >> "${vpsState}/runuser"
exec "$@"
`, vpsBin);
  stub('systemctl', `echo "systemctl $*" >> "${vpsState}/sys"; exit 0`, vpsBin);

  const adminHome = join(vpsBox, 'admin-home');
  mkdirSync(join(adminHome, '.hermes'), { recursive: true });
  writeFileSync(join(adminHome, '.hermes', 'keep.txt'), 'admin-secret');
  const vpsEnv = {
    ...senv,
    PATH: `${vpsBin}:${senv.PATH}`,
    HOME: adminHome,
    HERMES_HOME: join(adminHome, '.hermes'),
    TESS_TEST_ROOT: vpsBox,
    TESS_TEST_ALLOW_UID: String(process.getuid()),
    TESS_BOT_HOME: vpsHome,
    TESS_CAP_HOME: vpsCapHome,
    TESS_SYSTEMD_DIR: vpsUnitDir,
    TESS_ALLOW_IDS: '333333333',
  };
  const vpsOut = out('/bin/sh', [SETUP], vpsEnv);
  assert.match(vpsOut, /Installed and started .*tess-cap\.service as user 'tess-cap'/);
  assert.match(vpsOut, /Installed and started .*tess-support\.service as user 'tess-support'/);
  const sysLog = readFileSync(join(vpsState, 'sys'), 'utf8');
  assert.match(sysLog, /useradd --system --create-home --home-dir .*\/tess-support --shell .* tess-support/, 'creates system user tess-support');
  assert.match(sysLog, /useradd --system --create-home --home-dir .*\/tess-cap --shell .* tess-cap/, 'creates system user tess-cap');
  assert.match(sysLog, /systemctl daemon-reload/, 'reloads systemd');
  assert.match(sysLog, /systemctl enable tess-cap\n[\s\S]*systemctl restart tess-cap\n[\s\S]*systemctl enable tess-support\n[\s\S]*systemctl restart tess-support/, 'enables and starts tess-cap before tess-support');
  const ruLog = readFileSync(join(vpsState, 'runuser'), 'utf8');
  assert.match(ruLog, /runuser tess-support .*hermes profile install/, 'runs hermes as tess-support');
  assert.match(ruLog, /runuser tess-support node .*allowlist\.mjs/, 'runs allowlist.mjs as tess-support');
  assert.ok(!ruLog.includes(tgSecret) && !ruLog.includes(goSecret) && !ruLog.includes(supSecret), 'no secret in runuser argv');

  const installedUnit = readFileSync(join(vpsUnitDir, 'tess-support.service'), 'utf8');
  assert.match(installedUnit, /^User=tess-support$/m);
  assert.match(installedUnit, /^MemoryMax=512M$/m);
  assert.match(installedUnit, /^MemorySwapMax=0$/m);
  assert.match(installedUnit, /^CPUQuota=50%$/m);
  assert.ok(!/^StateDirectory=/m.test(installedUnit), 'tess-support unit has no StateDirectory');
  assert.match(installedUnit, /^ReadWritePaths=.*\/\.hermes\/profiles\/tess-support(?:\s|$)/m);
  assert.ok(!/^ReadWritePaths=.*\/vps\/home\/tess-support(?:\s|$)/m.test(installedUnit), 'ReadWritePaths no longer exposes the whole home');
  assert.match(installedUnit, /^ReadOnlyPaths=.*\/plugins\b/m);
  assert.match(installedUnit, /^ReadOnlyPaths=.*\/config\.yaml\b/m);
  assert.match(installedUnit, new RegExp(`^InaccessiblePaths=.*\\/srv\\/paperclip.*${vpsCapHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\/var\\/lib\\/tess-cap`, 'm'));

  const installedCapUnit = readFileSync(join(vpsUnitDir, 'tess-cap.service'), 'utf8');
  assert.match(installedCapUnit, /^User=tess-cap$/m);
  assert.match(installedCapUnit, /^MemoryMax=128M$/m);
  assert.match(installedCapUnit, /^MemorySwapMax=0$/m);
  assert.match(installedCapUnit, /^CPUQuota=25%$/m);
  assert.match(installedCapUnit, /^StateDirectory=tess-cap$/m);
  assert.match(installedCapUnit, /^StateDirectoryMode=0700$/m);
  assert.match(installedCapUnit, /^ReadOnlyPaths=.*\/cap-proxy\s+.*\/\.env$/m);
  assert.match(installedCapUnit, new RegExp(`^InaccessiblePaths=.*\\/srv\\/paperclip.*${vpsHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));

  const vpsProfDir = join(vpsHome, '.hermes', 'profiles', 'tess-support');
  assert.equal(statSync(join(vpsProfDir, '.env')).mode & 0o777, 0o600);
  assert.equal(statSync(join(vpsCapHome, '.env')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(vpsProfDir, '.env'), 'utf8').includes(goSecret), 'bot .env never receives real Go key on VPS');
  assert.match(readFileSync(join(vpsCapHome, '.env'), 'utf8'), new RegExp(`^OPENCODE_GO_API_KEY=${goSecret}$`, 'm'));
  assert.equal(statSync(join(vpsCapHome, 'cap-proxy')).mode & 0o777, 0o755, 'cap-proxy dir is 0755');
  assert.equal(statSync(join(vpsCapHome, 'cap-proxy', 'proxy.mjs')).mode & 0o777, 0o644, 'cap-proxy/proxy.mjs is 0644');
  assert.equal(statSync(join(vpsProfDir, 'plugins')).mode & 0o777, 0o755, 'plugins dir is 0755');
  assert.equal(statSync(join(vpsProfDir, 'plugins', 'daily-cap')).mode & 0o777, 0o755, 'daily-cap dir is 0755');
  assert.equal(statSync(join(vpsProfDir, 'plugins', 'daily-cap', '__init__.py')).mode & 0o777, 0o644, 'plugin __init__.py is 0644');
  assert.equal(statSync(join(vpsProfDir, 'plugins', 'daily-cap', 'plugin.yaml')).mode & 0o777, 0o644, 'plugin.yaml is 0644');
  assert.match(sysLog, /chown -h /, 'uses chown -h without following symlinks');
  assert.match(sysLog, /chown -h (?:root:root|0:0) .*\/plugins\/daily-cap\/__init__\.py/, 'plugin code is chowned to root');
  assert.match(sysLog, /chown -h (?:root:root|0:0) .*\/cap-proxy\/proxy\.mjs/, 'cap-proxy code is chowned to root');
  assert.ok(!/chown\s+-R|chmod\s+-R/.test(setupText), 'setup.sh never uses recursive chown -R or chmod -R');
  assert.match(setupText, /O_NOFOLLOW/, 'setup.sh uses fd-safe O_NOFOLLOW chmod_no_follow');
  // Inherited admin HOME/HERMES_HOME were ignored completely when running as root.
  assert.equal(readFileSync(join(adminHome, '.hermes', 'keep.txt'), 'utf8'), 'admin-secret');
  assert.ok(!existsSync(join(adminHome, '.hermes', 'profiles', 'tess-support')), 'admin HERMES_HOME was untouched');

  // Idempotent second run as simulated root: users already exist so useradd is not called again.
  rmSync(join(vpsState, 'sys'), { force: true });
  out('/bin/sh', [SETUP], vpsEnv);
  assert.ok(!/useradd/.test(readFileSync(join(vpsState, 'sys'), 'utf8')), 'second run skips useradd');

  // Grok low #2: As root, TESS_TEST=1 must refuse unsafe TESS_TEST_ROOT (like /usr/local), missing TESS_TEST_ROOT,
  // or unfaked system tools (real PATH useradd/systemctl), never redirecting real paths.
  const unfakedRootBin = join(vpsBox, 'unfaked-root-bin');
  mkdirSync(unfakedRootBin, { recursive: true });
  stub('id', '[ "$1" = "-u" ] && [ -z "$2" ] && { echo 0; exit 0; }; [ "$1" = "-un" ] && { echo root; exit 0; }; exit 1', unfakedRootBin);
  for (const [label, extra, expect] of [
    ['root TESS_TEST=1 without TESS_TEST_ROOT', { TESS_TEST_ROOT: '' }, /refusing TESS_TEST=1 as root/],
    ['root TESS_TEST=1 with /usr/local', { TESS_TEST_ROOT: '/usr/local' }, /refusing|outside scratch/],
    ['root TESS_TEST=1 without faked useradd/chown', { PATH: `${unfakedRootBin}:${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, TESS_TEST_ROOT: vpsBox }, /must be faked inside TESS_TEST_ROOT/],
  ]) {
    let testBypassErr = '';
    try {
      out('/bin/sh', [SETUP], { ...vpsEnv, ...extra });
      assert.fail(`expected refusal for ${label}`);
    } catch (e) {
      if (e.code === 'ERR_ASSERTION') throw e;
      testBypassErr = String(e.stderr) + String(e.stdout);
    }
    assert.match(testBypassErr, expect, label);
  }

  // Root without TESS_TEST=1 ignores inherited HOME, HERMES_HOME, TESS_BOT_HOME, TESS_CAP_HOME, TESS_SYSTEMD_DIR and uses fixed /home/tess-support.
  const realRootBin = join(vpsBox, 'real-root-bin');
  mkdirSync(realRootBin, { recursive: true });
  stub('id', '[ "$1" = "-u" ] && [ -z "$2" ] && { echo 0; exit 0; }; [ "$1" = "-un" ] && { echo root; exit 0; }; exit 1', realRootBin);
  stub('useradd', `echo "useradd $*" > "${vpsState}/real-root-useradd"; exit 1`, realRootBin);
  let realRootOut = '';
  try {
    out('/bin/sh', [SETUP], {
      ...senv,
      TESS_TEST: '0',
      PATH: `${realRootBin}:${vpsBin}:${senv.PATH}`,
      HOME: adminHome,
      HERMES_HOME: join(adminHome, '.hermes'),
      TESS_BOT_HOME: '/tmp/nope/../../var/lib/postgresql',
      TESS_CAP_HOME: '/tmp/nope/../../usr/local',
      TESS_SYSTEMD_DIR: '/tmp/nope/../../etc',
    });
    assert.fail('expected stubbed useradd failure');
  } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; realRootOut = String(e.stderr) + String(e.stdout); }
  assert.match(realRootOut, /couldn't create system user tess-support/);
  assert.match(readFileSync(join(vpsState, 'real-root-useradd'), 'utf8'), /--home-dir \/home\/tess-support /, 'real root ignores env overrides and always uses /home/tess-support');

  // Root test mode refuses .. traversal, symlinks pointing outside scratch root, and foreign-owned targets.
  const outsideDir = join(box, 'outside-target');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'sentinel.txt'), 'keep');
  const linkParent = join(vpsBox, 'link-parent');
  symlinkSync(outsideDir, linkParent);
  const linkHome = join(vpsBox, 'link-home');
  symlinkSync(outsideDir, linkHome);
  const linkHermes = join(vpsBox, 'link-hermes');
  symlinkSync(outsideDir, linkHermes);
  const foreignHome = join(vpsBox, 'foreign-home');
  mkdirSync(foreignHome, { recursive: true });

  for (const [label, extra] of [
    ['.. in TESS_BOT_HOME', { TESS_BOT_HOME: '/tmp/nope/../../var/lib/postgresql' }],
    ['.. in TESS_CAP_HOME', { TESS_CAP_HOME: '/tmp/nope/../../usr/local' }],
    ['.. in TESS_BOT_HOME under scratch', { TESS_BOT_HOME: `${vpsBox}/home/sub/../../outside` }],
    ['.. in TESS_SYSTEMD_DIR', { TESS_SYSTEMD_DIR: '/tmp/nope/../../etc' }],
    ['symlink parent in TESS_BOT_HOME', { TESS_BOT_HOME: join(linkParent, 'tess-support') }],
    ['symlinked TESS_BOT_HOME', { TESS_BOT_HOME: linkHome }],
    ['symlinked TESS_CAP_HOME', { TESS_CAP_HOME: linkHome }],
    ['symlinked TESS_BOT_HERMES_HOME', { TESS_BOT_HERMES_HOME: linkHermes }],
    ['foreign-owned TESS_BOT_HOME', { TESS_BOT_HOME: foreignHome, TESS_TEST_ALLOW_UID: '', TESS_TEST_BOT_UID: '998' }],
  ]) {
    rmSync(join(vpsState, 'sys'), { force: true });
    let badOut = '';
    try {
      out('/bin/sh', [SETUP], { ...vpsEnv, ...extra });
      assert.fail(`expected refusal for ${label}`);
    } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; badOut = String(e.stderr) + String(e.stdout); }
    assert.ok(!existsSync(join(vpsState, 'sys')) || !/chown|useradd/.test(readFileSync(join(vpsState, 'sys'), 'utf8')), `${label} never runs useradd or chown`);
    assert.ok(badOut.length > 0, `${label} explains refusal`);
  }
  assert.equal(readFileSync(join(outsideDir, 'sentinel.txt'), 'utf8'), 'keep', 'symlink target outside root untouched');

  // Symlinked plugin file inside profile AND symlinked cap-proxy/proxy.mjs are refused on root re-run without altering targets.
  rmSync(join(vpsCapHome, 'cap-proxy', 'proxy.mjs'));
  symlinkSync(join(outsideDir, 'sentinel.txt'), join(vpsCapHome, 'cap-proxy', 'proxy.mjs'));
  let symCapOut = '';
  try {
    out('/bin/sh', [SETUP], vpsEnv);
    assert.fail('expected refusal for symlinked proxy.mjs');
  } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; symCapOut = String(e.stderr) + String(e.stdout); }
  assert.match(symCapOut, /symlink/i);
  assert.equal(readFileSync(join(outsideDir, 'sentinel.txt'), 'utf8'), 'keep', 'symlinked proxy target untouched');
  rmSync(join(vpsCapHome, 'cap-proxy', 'proxy.mjs'));
  cpSync(join(root, 'support/cap-proxy/proxy.mjs'), join(vpsCapHome, 'cap-proxy', 'proxy.mjs'));

  rmSync(join(vpsProfDir, 'plugins', 'daily-cap', '__init__.py'));
  symlinkSync(join(outsideDir, 'sentinel.txt'), join(vpsProfDir, 'plugins', 'daily-cap', '__init__.py'));
  let symPluginOut = '';
  try {
    out('/bin/sh', [SETUP], vpsEnv);
    assert.fail('expected refusal for symlinked plugin file');
  } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; symPluginOut = String(e.stderr) + String(e.stdout); }
  assert.match(symPluginOut, /symlink/i);
  assert.equal(readFileSync(join(outsideDir, 'sentinel.txt'), 'utf8'), 'keep', 'symlinked plugin target untouched');

  // Non-root on a systemd+useradd machine without TESS_TEST refuses and directs operator to sudo -E sh.
  const linuxBin = join(box, 'linux-bin');
  mkdirSync(linuxBin, { recursive: true });
  stub('useradd', 'exit 0', linuxBin);
  stub('systemctl', 'exit 0', linuxBin);
  stub('id', '[ "$1" = "-u" ] && { echo 1000; exit 0; }; echo alice; exit 0', linuxBin);
  let nonRootLinux = '';
  try {
    out('/bin/sh', [SETUP], { ...senv, TESS_TEST: '0', PATH: `${linuxBin}:${senv.PATH}` });
    assert.fail('expected non-root Linux systemd refusal');
  } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; nonRootLinux = String(e.stderr) + String(e.stdout); }
  assert.match(nonRootLinux, /sudo -E sh/);

  // 7b. No advice to grant the bot passwordless sudo, and never two gateways: when a unit is generated non-root (TESS_TEST=1),
  // setup does not start a standalone gateway.
  const botCfg = readFileSync(join(root, 'support/bot/config.yaml'), 'utf8');
  assert.match(botCfg, /^  disabled_toolsets:.*\bfile\b/m, 'config.yaml disables file toolset');
  assert.ok(!/^  telegram:.*\bfile\b/m.test(botCfg), 'config.yaml removes file from telegram platform_toolsets');

  assert.ok(!/passwordless sudo for systemctl|give this account passwordless sudo/i.test(setupText), 'setup never suggests granting the bot sudo');
  const sysDir = join(box, 'sysonly');
  mkdirSync(sysDir, { recursive: true });
  writeFileSync(join(sysDir, 'systemctl'), '#!/bin/sh\n[ "$1" = "is-active" ] && exit 3\nexit 0\n');
  chmodSync(join(sysDir, 'systemctl'), 0o755);
  rmSync(join(state, 'calls'), { force: true });
  const unitRun = out('/bin/sh', [SETUP], { ...senv, PATH: `${sysDir}:${senv.PATH}` });
  assert.match(unitRun, /Not starting a second gateway/, 'with a unit generated non-root, it does not start a second gateway');
  assert.ok(!/gateway start/.test(calls().join('\n')), 'and never calls gateway start in that case');

  // Paperclip user/path collisions are refused outright before anything is installed.
  const pc = join(box, 'paperclip-host');
  mkdirSync(join(pc, 'paperclip'), { recursive: true });
  for (const [label, extra, expect] of [
    ['home containing paperclip dir', { HOME: pc }, /paperclip/i],
    ['TESS_BOT_HOME=/srv/paperclip', { TESS_BOT_HOME: '/srv/paperclip' }, /Paperclip/],
    ['TESS_CAP_HOME=/srv/paperclip', { TESS_CAP_HOME: '/srv/paperclip' }, /Paperclip/],
    ['TESS_BOT_HOME=/home/paperclip/bot', { TESS_BOT_HOME: '/home/paperclip/bot' }, /Paperclip/],
    ['TESS_BOT_USER=paperclip', { TESS_BOT_USER: 'paperclip' }, /refusing bot user/],
    ['TESS_CAP_USER=paperclip', { TESS_CAP_USER: 'paperclip' }, /refusing cap proxy user/],
    ['TESS_BOT_USER=root', { TESS_BOT_USER: 'root' }, /refusing bot user/],
    ['TESS_CAP_USER=root', { TESS_CAP_USER: 'root' }, /refusing cap proxy user/],
  ]) {
    let pcOut = '';
    try { out('/bin/sh', [SETUP], { ...senv, ...extra }); assert.fail(`expected refusal for ${label}`); }
    catch (e) { if (e.code === 'ERR_ASSERTION') throw e; pcOut = String(e.stderr) + String(e.stdout); }
    assert.match(pcOut, expect, label);
    assert.ok(!/profile install/.test(pcOut), `${label} installs nothing`);
  }

  // A failed install is reported and the gateway is not started onto nothing.
  rmSync(join(state, 'gateway'), { force: true });
  let failed = '';
  try { out('/bin/sh', [SETUP], { ...senv, STUB_FAIL_PROFILE: '1' }); } catch (e) { failed = String(e.stderr) + String(e.stdout); }
  assert.match(failed, /couldn't (install|update) the tess-support profile/);
  assert.ok(!existsSync(join(state, 'gateway')), 'no gateway started for a bot that is not there');

  // --- daily-cap plugin (Python unit checks) ------------------------------------------------------------------------
  const capDir = join(box, 'cap-test');
  mkdirSync(capDir, { recursive: true });
  const capScript = `
import importlib.util, json, os, pathlib, tempfile
plugin_path = pathlib.Path(${JSON.stringify(join(root, 'support/bot/plugins/daily-cap/__init__.py'))})
spec = importlib.util.spec_from_file_location("daily_cap", plugin_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class FakeCtx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, fn): self.hooks[name] = fn

ctx = FakeCtx()
mod.register(ctx)
assert "pre_llm_call" in ctx.hooks and "post_api_request" in ctx.hooks

with tempfile.TemporaryDirectory() as td:
    cap_file = pathlib.Path(td) / "daily-cap.json"
    os.environ["TESS_DAILY_CAP_FILE"] = str(cap_file)
    os.environ["TESS_DAILY_REPLY_CAP"] = "3"
    os.environ["TESS_DAILY_USER_CAP"] = "2"
    os.environ["TESS_DAILY_TOKEN_CAP"] = "0"
    os.environ["TESS_CAP_TODAY"] = "2026-11-18"

    # Per-person cap (2) blocks user A on 3rd turn while user B can still take the remaining global slot.
    assert mod.pre_llm_call(sender_id="1001") is None
    assert mod.pre_llm_call(sender_id="1001") is None
    blk_user = mod.pre_llm_call(sender_id="1001")
    assert blk_user and blk_user["action"] == "block" and "limit" in blk_user["message"]
    assert mod.pre_llm_call(sender_id="1002") is None

    # Shared global cap (3) now blocks user B as well.
    blk_global = mod.pre_llm_call(sender_id="1002")
    assert blk_global and blk_global["action"] == "block" and "00:00 UTC" in blk_global["message"]

    # Next UTC day resets counters cleanly.
    os.environ["TESS_CAP_TODAY"] = "2026-11-19"
    assert mod.pre_llm_call(sender_id="1001") is None

    # Token cap blocks after post_api_request crosses TESS_DAILY_TOKEN_CAP.
    os.environ["TESS_DAILY_TOKEN_CAP"] = "1000"
    mod.post_api_request(usage={"prompt_tokens": 600, "completion_tokens": 450})
    blk_tok = mod.pre_llm_call(sender_id="1002")
    assert blk_tok and blk_tok["action"] == "block"

    # Corrupt state fails closed.
    cap_file.write_text("{bad json", encoding="utf-8")
    blk_bad = mod.pre_llm_call(sender_id="1002")
    assert blk_bad and blk_bad["action"] == "block"

    # Symlinked state fails closed and leaves target untouched.
    secret_target = pathlib.Path(td) / "secret.txt"
    secret_target.write_text("keep-me", encoding="utf-8")
    cap_file.unlink()
    cap_file.symlink_to(secret_target)
    blk_sym = mod.pre_llm_call(sender_id="1002")
    assert blk_sym and blk_sym["action"] == "block"
    assert secret_target.read_text(encoding="utf-8") == "keep-me"

    # STATE_DIRECTORY places daily-cap state outside sessions/ and cache/.
    state_dir = pathlib.Path(td) / "systemd-state"
    state_dir.mkdir()
    os.environ.pop("TESS_DAILY_CAP_FILE", None)
    os.environ["STATE_DIRECTORY"] = str(state_dir)
    resolved_state = mod._state_path()
    assert resolved_state == state_dir / "daily-cap.json"
    assert "sessions" not in resolved_state.parts and "cache" not in resolved_state.parts

    # Trying to reset the counter or edit the plugin via bot tools (file or terminal) is refused by pre_tool_call.
    assert "pre_tool_call" in ctx.hooks
    os.environ["TESS_DAILY_REPLY_CAP"] = "1"
    os.environ["TESS_DAILY_USER_CAP"] = "1"
    os.environ["TESS_DAILY_TOKEN_CAP"] = "0"
    assert mod.pre_llm_call(sender_id="2001") is None
    assert mod.pre_llm_call(sender_id="2001")["action"] == "block"

    payload_zero = '{"date":"2026-11-19","replies":0}'
    for tname, targs in [
        ("write_file", {"path": str(resolved_state), "content": "{}"}),
        ("read_file", {"path": str(resolved_state)}),
        ("patch", {"path": str(plugin_path), "old": "block", "new": "allow"}),
        ("terminal", {"command": "echo " + payload_zero + " > " + str(resolved_state)}),
        ("terminal", {"command": "rm -f /var/lib/tess-support/daily-cap.json"}),
        ("terminal", {"command": "printf x > " + str(plugin_path)}),
        ("terminal", {"command": "python3 -c 'import pathlib; pathlib.Path(\\"/var/lib/tess-support/daily-cap.json\\").write_text(\\"{}\\")'"}),
    ]:
        blk_tool = mod.pre_tool_call(tool_name=tname, args=targs)
        assert blk_tool and blk_tool["action"] == "block", f"expected tool block for {tname}: {targs}"

    # Counter is still intact and still blocks user 2001.
    assert mod.pre_llm_call(sender_id="2001")["action"] == "block"

    # Low finding: once TESS_DAILY_TOKEN_CAP is exceeded mid-turn, pre_tool_call blocks further tool calls in the loop.
    os.environ["TESS_DAILY_TOKEN_CAP"] = "500"
    mod.post_api_request(usage={"total_tokens": 600})
    blk_loop_tok = mod.pre_tool_call(tool_name="terminal", args={"command": "node triage.mjs --help"})
    assert blk_loop_tok and blk_loop_tok["action"] == "block"

    # Unprivileged OS write attempt against read-only (0444) counter or plugin fails with PermissionError, and pre_llm_call fails closed.
    ro_plugin = pathlib.Path(td) / "ro-plugin.py"
    ro_plugin.write_text("# plugin", encoding="utf-8")
    ro_plugin.chmod(0o444)
    try:
        ro_plugin.write_text("# hijacked", encoding="utf-8")
        raise AssertionError("expected PermissionError editing read-only plugin")
    except PermissionError:
        pass

    resolved_state.chmod(0o444)
    state_dir.chmod(0o555)
    try:
        try:
            resolved_state.write_text('{"date":"2026-11-19","replies":0,"tokens":0,"users":{}}', encoding="utf-8")
            raise AssertionError("expected PermissionError resetting read-only counter")
        except PermissionError:
            pass
        blk_ro = mod.pre_llm_call(sender_id="3001")
        assert blk_ro and blk_ro["action"] == "block"
    finally:
        state_dir.chmod(0o700)
        resolved_state.chmod(0o600)

    # Holding daily-cap.lock triggers bounded lock timeout and fails closed rather than hanging until Hermes fails open.
    import fcntl
    lock_file = state_dir / "daily-cap.lock"
    hold_fd = os.open(lock_file, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(hold_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.environ["TESS_CAP_LOCK_TIMEOUT"] = "0.05"
        os.environ["TESS_DAILY_REPLY_CAP"] = "40"
        os.environ["TESS_DAILY_USER_CAP"] = "20"
        blk_lock = mod.pre_llm_call(sender_id="4001")
        assert blk_lock and blk_lock["action"] == "block"
    finally:
        fcntl.flock(hold_fd, fcntl.LOCK_UN)
        os.close(hold_fd)
        os.environ.pop("TESS_CAP_LOCK_TIMEOUT", None)
`;
  out('python3', ['-B', '-c', capScript], { PYTHONDONTWRITEBYTECODE: '1' });

  console.log('support bot: all checks passed\n');
  console.log([
    'checked:',
    '  · triage works out the P0–P3, area and kind labels, and carries them in the inbox payload',
    '  · the bot has no way to file on GitHub: no --mode gh, and no GitHub write anywhere it can run',
    '  · a four-part Spotify version survives the scrub; an email, phone number and install id do not',
    '  · a misread priority cannot go below the doctor\'s evidence, and --kind is checked against triage.md',
    '  · reports turned off are said out loud instead of being claimed as sent',
    '  · the allowlist refuses a wildcard, a phone number and removing the owner, and keeps .env at 600',
    '  · a removal rewrites the gateway list, and --restart really restarts (the unit under systemd, the gateway otherwise)',
    '  · the allowlist is not reachable from chat, and the unit makes .env and allow.txt read-only to the bot',
    '  · Hermes\' own admin list is still written with Krish\'s id, for Hermes\' own commands',
    '  · setup.sh unpacks GitHub\'s real archive layout with the real tar, so the download path is actually tested',
    '  · it defaults to opencode-go/deepseek-v4.1-flash with OPENCODE_GO_API_KEY in .env at 600 and zero secrets on CLI argv',
    '  · it seeds TESS_ALLOW_IDS, writes cap settings, and stays idempotent on re-run',
    '  · under simulated root/VPS it creates tess-support, drops privileges via runuser, installs the hardened unit, and enables/restarts it',
    '  · it refuses Paperclip/PostgreSQL paths and users, and installs nothing after a failed profile install',
    '  · daily-cap plugin enforces per-user and shared daily reply limits, token budget, UTC rollover, and fails closed on corrupt/symlinked state',
    '  · the payload it posts carries only fields the inbox accepts, and no token or personal data',
    '  · the posting token and the inbox address are never in a command: one script holds both, and refuses any other host',
    '  · a title the inbox would refuse with a 400 is refused here first, before anything is posted',
    '  · a home path or an email inside the helper log is scrubbed out of the issue and the payload',
    '  · a path where the Spotify version goes, a Mac name, a bidi override and a zero-width character never reach the issue or the payload',
    '',
  ].join('\n'));
  console.log('─'.repeat(96));
  console.log('The exact payload the bot posts to the inbox for the blank-Spotify report (nothing created):');
  console.log('─'.repeat(96) + '\n');
  console.log(inboxPayload.trim() + '\n');
  console.log('Filing is Krish\'s side, from the inbox — the bot has no path to GitHub at all.');
} finally {
  rmSync(box, { recursive: true, force: true });
}
