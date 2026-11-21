// Test the line `support show` prints for filing an issue. The title comes from a model reading a stranger's message,
// so this line is the one place where someone else's words become something Krish pastes into a shell.
// Usage: node tools/test-reports.mjs
// Proves: the real GitHub labels are used ("P2: medium", not "P2"); a title full of shell syntax is inert; the body
// arrives through a pipe rather than as an argument; and a report number that isn't one is refused.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const { issueCommand, shellQuote, LABEL, parseSupport, d1Args, usageLines, capsFrom } = await import(new URL('../tools/reports.mjs', import.meta.url).href);

const box = mkdtempSync(join(tmpdir(), 'tess-reports-test-'));
// What the shell sees when it runs the printed line. `gh` is replaced by an echo, so the only thing exercised is the
// quoting — which is the whole point: everything else on the line is fixed text.
const runQuoted = (cmd) => execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });

try {
  // 1. Real labels. "P2" is not a label; `gh` would fail on every single report.
  assert.equal(LABEL.P0, 'P0: critical');
  assert.equal(LABEL.P1, 'P1: high');
  assert.equal(LABEL.P2, 'P2: medium');
  assert.equal(LABEL.P3, 'P3: low');
  const plain = issueCommand({ id: 7, priority: 'P2', kind: 'bug', areas: 'area: theme', title: 'Lyrics drift half a second behind the song' });
  assert.match(plain, /--label 'P2: medium' --label 'area: theme' --label 'bug'/, 'the labels are the real GitHub labels');
  assert.match(plain, /^node tools\/reports\.mjs support body 7 \| gh issue create /, 'the body is piped in, not passed as an argument');
  assert.match(plain, /--body-file -$/, 'the body still arrives on stdin');

  // 1b. `support show 12` must hand 12 to the number, not the subcommand. This is the argument every reading and filing
  // subcommand depends on.
  assert.deepEqual(parseSupport(['show', '12']), { sub: 'show', arg: '12' }, 'show takes the report number');
  assert.deepEqual(parseSupport(['body', '7']), { sub: 'body', arg: '7' }, 'body takes the report number');
  assert.deepEqual(parseSupport(['token', 'add']), { sub: 'token', arg: 'add' }, 'token takes its verb');
  assert.deepEqual(parseSupport(['list']), { sub: 'list', arg: undefined }, 'list takes nothing');

  // 2. A title written by someone hostile does nothing at all when the line is pasted.
  const marker = join(box, 'PWNED');
  const hostile = `Lyrics drift $(touch ${marker}) \`touch ${marker}\` ; touch ${marker} && echo oops`;
  const line = issueCommand({ id: 9, priority: 'P0', kind: 'bug', areas: 'area: installer, area: theme', title: hostile });
  // Run the gh half as an echo, keeping the quoting identical to the real line.
  const echoed = line.replace(/^node [^|]*\| /, 'echo ').replace(/ --body-file -$/, '');
  const printed = runQuoted(echoed);
  assert.equal(execFileSync('/bin/sh', ['-c', `[ -f ${shellQuote(marker)} ] && echo yes || echo no`], { encoding: 'utf8' }).trim(), 'no', 'nothing ran before the line was even printed');
  assert.ok(printed.includes(hostile), 'the title arrives as text, not as commands');
  assert.equal(execFileSync('/bin/sh', ['-c', `[ -f ${shellQuote(marker)} ] && echo yes || echo no`], { encoding: 'utf8' }).trim(), 'no', 'and pasting it runs nothing');

  // 3. A quote in a title is escaped, not a way out of the quoting.
  const quoted = issueCommand({ id: 3, priority: 'P3', kind: 'bug', areas: 'area: docs', title: `Sam's window doesn't open` });
  const out2 = runQuoted(quoted.replace(/^node [^|]*\| /, 'echo ').replace(/ --body-file -$/, ''));
  assert.ok(out2.includes(`Sam's window doesn't open`), 'an apostrophe survives intact');

  // 4. `support body` is really a subcommand of this tool, and it takes a number — not a path, not a flag.
  const reportsPath = fileURLToPath(new URL('../tools/reports.mjs', import.meta.url));
  const usage = execFileSync('/bin/sh', ['-c', `"${process.execPath}" "${reportsPath}" support 2>&1 || true`], { encoding: 'utf8' });
  assert.match(usage, /support list \| show <n> \| body <n>/, 'the usage line lists body <n>');

  // 5. A report number that isn't one is refused rather than pasted into SQL.
  for (const bad of ['0', '-1', '1; DROP TABLE reports', 'one']) {
    assert.throws(() => issueCommand({ id: bad, priority: 'P2', kind: 'bug', areas: 'area: theme', title: 'x' }), /not a report number|NaN|Invalid/i);
  }

  // 6. The live database unless a test names a local one, and a relative local path is refused rather than guessed.
  assert.deepEqual(d1Args('SELECT 1', {}), ['-y', 'wrangler@4', 'd1', 'execute', 'tess-inbox', '--remote', '--json', '--command', 'SELECT 1'],
    'no TESS_D1_LOCAL is the live inbox, as before');
  const local = d1Args('SELECT 1', { TESS_D1_LOCAL: '/tmp/tess-d1' });
  assert.ok(local.includes('--local') && local.includes('/tmp/tess-d1') && !local.includes('--remote'), 'TESS_D1_LOCAL is local only');
  assert.throws(() => d1Args('SELECT 1', { TESS_D1_LOCAL: 'relative' }), /absolute/);

  // 7. `support usage` prints a person's use against the caps in wrangler.toml, and an unused day as 0.
  const caps = capsFrom('SUPPORT_CHAT_PERSON_REQUESTS = "80"\nSUPPORT_CHAT_SHARED_REQUESTS = "400"\nSUPPORT_CHAT_PERSON_TOKENS = "0"\nSUPPORT_CHAT_SHARED_TOKENS = "2000000"\n');
  assert.deepEqual(usageLines([{ who: 'Ada', revoked: null, requests: 3, tokens: 900 }, { who: 'Old', revoked: 1, requests: null, tokens: null },
    { who: '(everyone)', revoked: null, requests: 3, tokens: 900 }], caps).map((l) => l.replace(/\s+/g, ' ')), [
    'Ada 3 of 80 requests 900 of 0 tokens active',
    'Old 0 of 80 requests 0 of 0 tokens REVOKED',
    '(everyone) 3 of 400 requests 900 of 2000000 tokens',
  ]);

  // 8. `support token revoke` of a name that is not active exits non-zero and names the command that lists real names.
  // The stand-in for `npx wrangler d1 execute` is local sqlite. It refuses --remote, so this cannot touch the live inbox.
  const db = join(box, 'inbox.sqlite');
  const schema = fileURLToPath(new URL('../inbox/schema.sql', import.meta.url));
  execFileSync('sh', ['-c', 'sqlite3 "$1" < "$2"', 'sh', db, schema]);
  const bin = join(box, 'bin');
  mkdirSync(bin);
  const shim = join(bin, 'npx');
  writeFileSync(shim, `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (!args.includes('--local') || args.includes('--remote')) {
  console.error('refusing a database that is not the local test copy');
  process.exit(2);
}
const sql = args[args.indexOf('--command') + 1];
const out = execFileSync('sqlite3', ['-json', process.env.TESS_TEST_SQLITE, sql], { encoding: 'utf8' }).trim();
const results = out ? JSON.parse(out) : [];
process.stdout.write(JSON.stringify([{ results, success: true }]));
`);
  chmodSync(shim, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TESS_D1_LOCAL: box, TESS_TEST_SQLITE: db };
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CLOUDFLARE_API_KEY']) delete env[k];
  const reportsRun = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [reportsPath, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status ?? 1, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
    }
  };
  const added = reportsRun(['support', 'token', 'add', 'Ada (Mac)']);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /tess_[0-9a-f]{64}/);
  const typo = reportsRun(['support', 'token', 'revoke', 'Ada Mac']);
  assert.notEqual(typo.status, 0, 'revoking a name that is not active exited 0');
  assert.match(typo.stderr, /no active token labelled "Ada Mac" — run support tokens to see exact names/);
  const still = JSON.parse(execFileSync('sqlite3', ['-json', db, "SELECT revoked FROM support_tokens WHERE label = 'Ada (Mac)'"], { encoding: 'utf8' }));
  assert.equal(still[0].revoked, null, 'a missed revoke left the token active');
  const revoked = reportsRun(['support', 'token', 'revoke', 'Ada (Mac)']);
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.match(revoked.stdout, /stops working on the next request/);
  const again = reportsRun(['support', 'token', 'revoke', 'Ada (Mac)']);
  assert.notEqual(again.status, 0, 'revoking an already-revoked token exited 0');
  assert.match(again.stderr, /no active token labelled "Ada \(Mac\)" — run support tokens to see exact names/);

  console.log('support filing line: all checks passed\n');
  console.log([
    'checked:',
    '  · the labels are the real GitHub ones — "P2: medium", "area: theme", "bug"',
    '  · the body reaches gh through a pipe, so a long report never hits an argument limit',
    '  · a title containing $(…), backticks, quotes and semicolons prints as text and runs nothing',
    '  · an apostrophe in a title survives the quoting',
    '  · a report number that is not a positive integer is refused',
    '  · every command reads the live inbox unless TESS_D1_LOCAL names a local folder, and never both',
    '  · support usage lines show requests and tokens against the wrangler.toml caps',
    '  · support token revoke of a missing or already-revoked name exits non-zero and leaves the active token alone',
    '',
  ].join('\n'));
} finally {
  rmSync(box, { recursive: true, force: true });
}
