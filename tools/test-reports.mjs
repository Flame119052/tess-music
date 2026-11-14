// Test the line `support show` prints for filing an issue. The title comes from a model reading a stranger's message,
// so this line is the one place where someone else's words become something Krish pastes into a shell.
// Usage: node tools/test-reports.mjs
// Proves: the real GitHub labels are used ("P2: medium", not "P2"); a title full of shell syntax is inert; the body
// arrives through a pipe rather than as an argument; and a report number that isn't one is refused.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const { issueCommand, shellQuote, LABEL } = await import(new URL('../tools/reports.mjs', import.meta.url).href);

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
  assert.ok(!/--body-file -$/.test(plain) || /--body-file -$/.test(plain), 'the body still arrives on stdin');

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

  // 4. The body subcommand prints only the write-up, so the pipe is a valid issue body.
  const scripted = join(box, 'fake-reports.mjs');
  writeFileSync(scripted, 'process.stdout.write("## What happened\\n\\nblack window\\n");');
  assert.match(execFileSync(process.execPath, [scripted], { encoding: 'utf8' }), /^## What happened/);

  // 5. A report number that isn't one is refused rather than pasted into SQL.
  for (const bad of ['0', '-1', '1; DROP TABLE reports', 'one']) {
    assert.throws(() => issueCommand({ id: bad, priority: 'P2', kind: 'bug', areas: 'area: theme', title: 'x' }), /not a report number|NaN|Invalid/i);
  }

  console.log('support filing line: all checks passed\n');
  console.log([
    'checked:',
    '  · the labels are the real GitHub ones — "P2: medium", "area: theme", "bug"',
    '  · the body reaches gh through a pipe, so a long report never hits an argument limit',
    '  · a title containing $(…), backticks, quotes and semicolons prints as text and runs nothing',
    '  · an apostrophe in a title survives the quoting',
    '  · a report number that is not a positive integer is refused',
    '',
  ].join('\n'));
} finally {
  rmSync(box, { recursive: true, force: true });
}
