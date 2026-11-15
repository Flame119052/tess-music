// Kill the real patcher between the steps of its swap, then prove the next attempt restores the sandboxed Spotify Apps.
// The swap lives in tess-patcher (#108): macOS denies /usr/bin/ditto under /bin/zsh, so a shell can no longer do it.
// Usage: node tools/test-swap-recovery.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const box = mkdtempSync(join(tmpdir(), 'tess-swap-test-'));
const bin = join(box, 'tess-patcher');
const apps = join(box, 'Spotify.app', 'Contents', 'Resources', 'Apps');
const staged = join(box, 'staged');
const original = 'original Spotify interface\n';

const runSwap = (src) => {
  try {
    execFileSync(bin, ['swap-apps', apps, src], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
};

try {
  execFileSync('go', ['build', '-o', bin, '.'], { cwd: join(root, 'patcher') });
  mkdirSync(apps, { recursive: true });
  mkdirSync(staged, { recursive: true });
  // swap-apps only takes a real-shaped Spotify bundle: the path check reads the identifier before it moves anything.
  writeFileSync(join(box, 'Spotify.app', 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.spotify.client</string></dict></plist>
`);
  writeFileSync(join(apps, 'xpui.spa'), original);
  writeFileSync(join(staged, 'xpui.spa'), 'replacement interface\n');
  // A FIFO blocks inside the copy (opening it waits for a writer), so the kill lands in the middle of the copy with
  // Apps still untouched — the same window a real crash or a full disk falls into.
  execFileSync('mkfifo', [join(staged, 'zz-fifo')]);

  const child = spawn(bin, ['swap-apps', apps, staged], { stdio: 'ignore' });
  const deadline = Date.now() + 10000;
  while (!existsSync(`${apps}.tess-new`) && Date.now() < deadline) {
    // spin: the copy has started once the new folder appears beside Apps
  }
  assert.ok(existsSync(`${apps}.tess-new`), 'the swap started and copied beside Spotify, not into it');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('close', resolve));
  assert.equal(readFileSync(join(apps, 'xpui.spa'), 'utf8'), original, 'a kill during the copy left Spotify exactly as it was');
  assert.ok(existsSync(`${apps}.tess-new`), 'the killed run left its half-made folder beside Spotify');

  // The next run, whose own staged copy is gone, must still put Spotify's folder back and then fail cleanly.
  assert.notEqual(runSwap(join(box, 'missing')), 0, 'a missing staged folder is still a failure');
  assert.equal(readFileSync(join(apps, 'xpui.spa'), 'utf8'), original, 'the next run left Spotify exactly as it was');
  assert.ok(!existsSync(`${apps}.tess-new`), 'the next run cleared the half-made folder');

  // And a good staged folder finishes the job.
  rmSync(join(staged, 'zz-fifo'));
  assert.equal(runSwap(staged), 0, 'a good staged folder swaps in');
  assert.equal(readFileSync(join(apps, 'xpui.spa'), 'utf8'), 'replacement interface\n', 'the replacement is in place');
  for (const leftover of [`${apps}.tess-old`, `${apps}.tess-new`]) {
    assert.ok(!existsSync(leftover), `no leftover at ${leftover}`);
  }

  // The exact state a kill between the two renames leaves: Apps gone, the original in .tess-old, a partial copy.
  renameSync(apps, `${apps}.tess-old`);
  mkdirSync(`${apps}.tess-new`, { recursive: true });
  writeFileSync(join(`${apps}.tess-new`, 'xpui.spa'), 'partial interface\n');
  assert.notEqual(runSwap(join(box, 'missing')), 0, 'a failed replacement remains a failure');
  assert.equal(readFileSync(join(apps, 'xpui.spa'), 'utf8'), 'replacement interface\n', 'the next run restored Apps from .tess-old');
  assert.equal(runSwap(staged), 0, 'the run after that swaps the good copy in');
  assert.equal(readFileSync(join(apps, 'xpui.spa'), 'utf8'), 'replacement interface\n');

  console.log('swap recovery tests passed (real tess-patcher: SIGKILL during the copy, and a kill between the two renames)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
