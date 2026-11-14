// Kill each shell swap between its two renames, then prove the next attempt restores the sandboxed Spotify Apps.
// Usage: node tools/test-swap-recovery.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scripts = ['tess-install.sh', 'updater.sh', 'doctor.sh'];

const swapFunction = (name) => {
  const lines = readFileSync(join(root, 'installer', name), 'utf8').split('\n');
  const start = lines.indexOf('swap_apps() {');
  const end = lines.indexOf('}', start + 1);
  assert.notEqual(start, -1, `${name}: swap_apps exists`);
  assert.notEqual(end, -1, `${name}: swap_apps closes`);
  return lines.slice(start, end + 1).join('\n');
};

for (const name of scripts) {
  const box = mkdtempSync(join(tmpdir(), 'tess-swap-test-'));
  try {
    const apps = join(box, 'Spotify.app', 'Contents', 'Resources', 'Apps');
    const source = join(box, 'replacement');
    mkdirSync(apps, { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(join(apps, 'xpui.spa'), 'original Spotify interface\n');
    writeFileSync(join(source, 'xpui.spa'), 'replacement interface\n');

    const fn = swapFunction(name);
    const interrupted = fn.replace(
      'if [ -d "$APPS" ]; then mv "$APPS" "$_old" || { rm -rf "$_new"; return 1; }; fi',
      () => 'if [ -d "$APPS" ]; then mv "$APPS" "$_old" || { rm -rf "$_new"; return 1; }; kill -9 $$; fi',
    );
    assert.notEqual(interrupted, fn, `${name}: interruption point found`);

    const killedScript = join(box, 'kill-mid-swap.zsh');
    writeFileSync(killedScript, `#!/bin/zsh\nAPPS="$1"\n${interrupted}\nswap_apps "$2"\n`);
    const killed = spawnSync('/bin/zsh', [killedScript, apps, source], { encoding: 'utf8' });
    assert.ok(!existsSync(apps), `${name}: interrupted window reproduced (status ${killed.status}, signal ${killed.signal}, old ${existsSync(`${apps}.tess-old`)}, new ${existsSync(`${apps}.tess-new`)}, stderr ${killed.stderr})`);
    assert.ok(existsSync(`${apps}.tess-old/xpui.spa`), `${name}: original copy survived`);

    const recoverScript = join(box, 'recover.zsh');
    writeFileSync(recoverScript, `#!/bin/zsh\nAPPS="$1"\n${fn}\nswap_apps "$2"\n`);
    const recovered = spawnSync('/bin/zsh', [recoverScript, apps, join(box, 'missing-source')], { encoding: 'utf8' });
    assert.notEqual(recovered.status, 0, `${name}: failed replacement remains a failure`);
    assert.equal(readFileSync(join(apps, 'xpui.spa'), 'utf8'), 'original Spotify interface\n', `${name}: next run restored Apps`);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

console.log('swap recovery tests passed (3 scripts, SIGKILL between renames)');
