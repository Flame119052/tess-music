// Tess Mini's localhost API must ignore a website, and only Spotify's page may learn the token.
// Run: node tools/test-mini-gate.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), 'tess-mini-gate-')), 'gate');
execFileSync('swiftc', ['-parse-as-library', join(root, 'mini/MiniGate.swift'), join(root, 'mini/MiniGateTest.swift'), '-o', out], { stdio: 'inherit' });
const ran = execFileSync(out, { encoding: 'utf8' });
assert.match(ran, /mini gate tests passed/);

for (const rel of ['theme/Tess/src/core.js', 'theme/Tess/theme.js']) {
  const src = readFileSync(join(root, rel), 'utf8');
  assert.match(src, /\/token/, `${rel} asks Mini for a token`);
  assert.match(src, /\?k=/, `${rel} sends that token on later calls`);
  assert.doesNotMatch(src, /MINI \+ '\/toggle'/, `${rel} does not call toggle with no token`);
  assert.doesNotMatch(src, /MINI \+ '\/ping'/, `${rel} does not treat an open port as Mini`);
}
const swift = readFileSync(join(root, 'mini/TessMini.swift'), 'utf8');
assert.doesNotMatch(swift, /Access-Control-Allow-Origin:\s*\*/, 'Mini does not allow every website');
assert.doesNotMatch(swift, /Access-Control-Allow-Private-Network:\s*true/, 'Mini does not opt every caller into localhost');
assert.match(swift, /miniHandle\(/, 'Mini answers through the checked gate');

console.log('mini gate tests passed (website ignored, token only for Spotify, theme sends it)');
