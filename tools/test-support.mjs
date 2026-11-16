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
  // Every file the bot can run, scanned for a GitHub write. Reading the public repo is fine; filing is not.
  const botFiles = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : botFiles.push(p); } };
  walk(join(root, 'support/bot'));
  const ghub = botFiles.filter((f) => /gh issue|gh api|gh pr|api\.github\.com\/repos\/.*\/issues/i.test(readFileSync(f, 'utf8')));
  assert.deepEqual(ghub, [], 'nothing the bot can run can file on GitHub');
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

  // 9b. The admin gate is Hermes', not the model's: configured, and written with Krish's own id by setup.sh.
  const cfg = readFileSync(join(root, 'support/bot/config.yaml'), 'utf8');
  assert.match(cfg, /allow_admin_from:/, 'the gateway has an admin list');
  assert.match(cfg, /user_allowed_commands:/, 'and a short list of what everyone else may run');
  const setupText = readFileSync(SETUP, 'utf8');
  assert.match(setupText, /config set gateway\.platforms\.telegram\.extra\.allow_admin_from/, 'setup.sh writes the admin list from Krish\'s id');
  assert.match(setupText, /id -u.*= 0/, 'and refuses to run as root, where the bot\'s shell would be root\'s');
  // No in-chat admin at all: the gate is shell access plus the unit's read-only files, and a chat command would put the
  // allowlist back within reach of the model that a stranger is talking to.
  for (const cmd of ['tess-allow', 'tess-deny', 'tess-who']) {
    assert.ok(!existsSync(join(root, 'support/bot/skills', cmd)), `${cmd} is not offered in chat`);
  }
  const unit = readFileSync(join(root, 'support/tess-support.service'), 'utf8');
  assert.match(unit, /ReadOnlyPaths=.*\.env/, 'the unit makes .env read-only to the bot');
  assert.match(unit, /ReadOnlyPaths=.*allow\.txt/, 'and the allowlist too');
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
  // The whole skill, scripts included: the setup script runs allowlist.mjs from inside it, and a test archive that
  // left it out would prove a setup that can't work.
  cpSync(join(SKILL, 'SKILL.md'), join(archDir, 'skills', 'tess-support', 'SKILL.md'));
  mkdirSync(join(archDir, 'skills', 'tess-support', 'scripts'), { recursive: true });
  for (const sc of ['allowlist.mjs', 'triage.mjs', 'inbox.mjs', 'privacy.mjs']) cpSync(join(SKILL, 'scripts', sc), join(archDir, 'skills', 'tess-support', 'scripts', sc));
  // The download carries support/ as a whole, so the unit template sits beside the bot.
  cpSync(join(root, 'support/tess-support.service'), join(stage, 'tess-music-main', 'support', 'tess-support.service'));
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
  const setupList = join(home, 'profiles', 'tess-support', 'allow.txt');
  assert.ok(existsSync(setupList), 'setup.sh wrote an allowlist under the Hermes home');
  assert.match(readFileSync(setupList, 'utf8'), /^900000001 Kris$|^900000001/m, 'starting with Krish and only Krish');

  // 12. A machine with nothing connected gets OpenCode's free tier, not a request for a paid key.
  rmSync(join(state, 'model.default.model.default'), { force: true });
  rmSync(join(state, 'model.tess-support.model.default'), { force: true });
  rmSync(join(state, 'calls'), { force: true });
  const free = setup();
  assert.match(calls().join('\n'), /config set model.provider opencode/, 'the free tier is chosen when nothing is connected');
  assert.equal(readFileSync(join(state, 'model.tess-support.model.default'), 'utf8').trim(), 'deepseek-v4.1-flash-free');
  assert.match(free, /free tier/, 'and it says so rather than asking for a key');

  // 2b. Root is refused outright: the bot has a shell, and a root-owned shell is a root shell.
  const rootBin = join(box, 'root-bin');
  mkdirSync(rootBin, { recursive: true });
  writeFileSync(join(rootBin, 'id'), '#!/bin/sh\n[ "$1" = "-u" ] && { echo 0; exit 0; }; echo root; exit 0\n');
  chmodSync(join(rootBin, 'id'), 0o755);
  let asRoot = '';
  try { out('/bin/sh', [SETUP], { ...senv, PATH: `${rootBin}:${senv.PATH}` }); } catch (e) { asRoot = String(e.stderr) + String(e.stdout); }
  assert.match(asRoot, /don't run this as root/, 'setup.sh refuses to run as root');
  assert.ok(!/profile install/.test(asRoot), 'and installs nothing when it does');

  // 7b. No advice to grant the bot passwordless sudo, and never two gateways: when a unit was generated, setup does not
  // start one of its own.
  assert.ok(!/passwordless sudo for systemctl|give this account passwordless sudo/i.test(setupText), 'setup never suggests granting the bot sudo');
  const sysDir = join(box, 'sysonly');
  mkdirSync(sysDir, { recursive: true });
  writeFileSync(join(sysDir, 'systemctl'), '#!/bin/sh\n[ "$1" = "is-active" ] && exit 3\nexit 0\n');
  chmodSync(join(sysDir, 'systemctl'), 0o755);
  rmSync(join(state, 'calls'), { force: true });
  const unitRun = out('/bin/sh', [SETUP], { ...senv, PATH: `${sysDir}:${senv.PATH}` });
  assert.match(unitRun, /Not starting a second gateway/, 'with a unit generated, it does not start a second gateway');
  assert.ok(!/gateway start/.test(calls().join('\n')), 'and never calls gateway start in that case');

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
    '  · it borrows the connected model, falls back to OpenCode\'s free tier, and stores the token, owner and inbox',
    '  · the payload it posts carries only fields the inbox accepts, and no token or personal data',
    '  · the posting token and the inbox address are never in a command: one script holds both, and refuses any other host',
    '  · a title the inbox would refuse with a 400 is refused here first, before anything is posted',
    '  · a home path or an email inside the helper log is scrubbed out of the issue and the payload',
    '  · a path where the Spotify version goes, a Mac name, a bidi override and a zero-width character never reach the issue or the payload',
    '  · it refuses to run as root, so the bot\'s shell is never root\'s',
    '  · it never suggests passwordless sudo, and never starts a second gateway beside the systemd unit',
    '  · it never changes the default profile, refuses Paperclip\'s machine, and starts nothing after a failed install',
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
