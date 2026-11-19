// Rewrite the profile pins in support/mac/install.sh from one commit.
// Usage: node tools/pin-support-mac.mjs <commit>
// The file list is the installer's rels block. The same commit writes the same text.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const commit = process.argv[2] || '';
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error('usage: node tools/pin-support-mac.mjs <40-character commit>');
  process.exit(1);
}

const file = join(root, 'support/mac/install.sh');
const text = readFileSync(file, 'utf8');
const relsMatch = text.match(/\n[ \t]*rels="\n([^"]*)\n"/);
if (!relsMatch) {
  console.error('support/mac/install.sh has no rels list');
  process.exit(1);
}
const rels = relsMatch[1].split('\n').map((line) => line.trim()).filter(Boolean);
if (!rels.length) {
  console.error('support/mac/install.sh lists no profile files');
  process.exit(1);
}

const lines = rels.map((rel) => {
  if (rel.startsWith('/') || rel.includes('..') || /\s/.test(rel)) {
    console.error(`refusing to pin ${rel}`);
    process.exit(1);
  }
  let bytes;
  try {
    bytes = execFileSync('git', ['show', `${commit}:${rel}`], { cwd: root });
  } catch {
    console.error(`git show ${commit}:${rel} failed`);
    process.exit(1);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `${rel} ${hash}`;
});

const block = `# >>> support profile pins >>>
PROFILE_COMMIT=${commit}
PROFILE_PINS='
${lines.join('\n')}
'
# <<< support profile pins <<<`;
if (!text.includes('# >>> support profile pins >>>') || !text.includes('# <<< support profile pins <<<')) {
  console.error('support/mac/install.sh has no profile pin block');
  process.exit(1);
}
const next = text.replace(/# >>> support profile pins >>>[\s\S]*?# <<< support profile pins <<</, block);
if (next === text) {
  console.log(`support profile pins already match ${commit}`);
} else {
  writeFileSync(file, next);
  console.log(`pinned ${rels.length} profile files at ${commit}`);
}
