// The one privacy filter every report path uses, run against real-looking samples.
// Proves: nothing personal survives it, ordinary words are left alone, and the four copies cannot drift.
// Run: node tools/test-redact.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const FILES = ['installer/redact.sh', 'installer/tess-install.sh', 'installer/doctor.sh', 'installer/rescue.sh'];
const Home = '/Users/sam.jones';
const box = mkdtempSync(join(tmpdir(), 'tess-redact-test-'));
const bin = join(box, 'bin');
mkdirSync(bin);
// a Mac that is not the test machine: one account name, two computer names
writeFileSync(join(bin, 'id'), '#!/bin/sh\n[ "$1" = -un ] && echo "sam.jones"\nexit 0\n');
writeFileSync(join(bin, 'scutil'), '#!/bin/sh\n[ "$1" = --get ] || exit 1\ncase "$2" in\n  ComputerName) echo "Sam\'s MacBook Pro" ;;\n  LocalHostName) echo "Sams-MacBook-Pro" ;;\nesac\n');
for (const f of ['id', 'scutil']) chmodSync(join(bin, f), 0o755);

// The function as it stands in a file, so the test runs the shipped copy rather than a copy written here.
function extract(file) {
  const text = readFileSync(join(root, file), 'utf8');
  const start = text.indexOf('\ntess_redact() {');
  assert.ok(start > 0, `${file} defines tess_redact`);
  const end = text.indexOf('\n}\n', start + 1);
  assert.ok(end > start, `${file} closes tess_redact`);
  return text.slice(start + 1, end + 2);
}
const redact = (fn, input) => execFileSync('/bin/sh', ['-c', `${fn}\ntess_redact`], {
  input, encoding: 'utf8', env: { ...process.env, HOME: Home, PATH: `${bin}:${process.env.PATH}` },
});

// What a report actually carries out of a broken install: paths, an ls owner column, both computer names, addresses.
const input = [
  '== /Applications/Spotify.app',
  `drwxr-xr-x  12 sam.jones  staff  384 15 Nov 12:00 ${Home}/Library/Application Support/Tess`,
  '/Users/other.person/Applications/Spotify.app',
  '/Users/sam.joneson/Library/x',
  "ComputerName Sam's MacBook Pro; LocalHostName Sams-MacBook-Pro.local",
  'mail sam.jones@example.com and bob_b@mail.co.uk',
  'macOS 15.1.1  staff  Applications Support  Spotify.app  sam.jones.bak',
  `${Home}/Library/Caches/com.spotify&co|pipe`,
  'files: $HOME and $(id -un) were printed by the shell, not by us',
].join('\n') + '\n';
const want = [
  '== /Applications/Spotify.app',
  'drwxr-xr-x  12 user  staff  384 15 Nov 12:00 ~/Library/Application Support/Tess',
  '~/Applications/Spotify.app',
  '~/Library/x',
  'ComputerName this-mac; LocalHostName this-mac.local',
  'mail (email) and (email)',
  'macOS 15.1.1  staff  Applications Support  Spotify.app  user.bak',
  '~/Library/Caches/com.spotify&co|pipe',
  'files: $HOME and $(id -un) were printed by the shell, not by us',
].join('\n') + '\n';

try {
  const copies = FILES.map((f) => extract(f));
  const unique = new Set(copies);
  assert.equal(unique.size, 1, 'every report path carries the same filter, byte for byte');

  for (const [i, file] of FILES.entries()) {
    assert.equal(redact(copies[i], input), want, `${file} removes exactly what it should`);
  }

  // The three scripts that report must actually call it, and none may keep the old one-sided sed from SEC-10.
  for (const file of ['installer/tess-install.sh', 'installer/doctor.sh', 'installer/rescue.sh']) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.match(text, /tess_redact/, `${file} uses the filter`);
    assert.ok(!text.includes('s|/Users/$(id -un)|~|g'),
      `${file} does not keep the old home-only redaction the installer had while the doctor did better`);
  }

  // Nothing is invented either: a line with no personal detail comes back unchanged.
  const plain = '== tess\nspotify: /Applications/Spotify.app\n1 problem(s), 0 fixed.\n';
  for (const [i, file] of FILES.entries()) assert.equal(redact(copies[i], plain), plain, `${file} leaves a plain report alone`);

  console.log('redact tests passed (four identical copies; homes of any account, account name, both computer names, emails removed; plain lines kept)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
