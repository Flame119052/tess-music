// Tess's installer scripts must not be able to act on a real Mac by accident (issue #107): sourcing one does nothing,
// and a copy inside a git checkout or worktree refuses to run outside a sandbox. Everything here runs in a scratch copy
// of the checkout, with HOME, TESS_HOME, TESS_CONFIG and TESS_SPOTIFY in scratch folders and fake tools on PATH, so a
// guard that failed could still not reach the real Mac. Run: node tools/test-script-guards.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const box = mkdtempSync(join(tmpdir(), 'tess-guard-test-'));

// Every script a person or an agent could run by hand. installer/redact.sh is a library (a function other scripts copy)
// and is meant to be sourced, so it is not one of these.
const scripts = [
  { name: 'install.sh', shell: 'sh' },
  { name: 'tess-install.sh', shell: 'sh' },
  { name: 'uninstall.sh', shell: 'sh' },
  { name: 'tess-command.sh', shell: 'sh' },
  { name: 'updater.sh', shell: 'zsh' },
  { name: 'doctor.sh', shell: 'zsh' },
  { name: 'rescue.sh', shell: 'zsh' },
  { name: 'wake.sh', shell: 'zsh' },
];

// A checkout (.git folder), a worktree (.git file) and an installed-style folder with no repository above it.
const checkoutDir = join(box, 'checkout');
const worktreeDir = join(box, 'worktree');
const installedDir = join(box, 'installed');
mkdirSync(join(checkoutDir, '.git'), { recursive: true });
mkdirSync(worktreeDir, { recursive: true });
mkdirSync(installedDir, { recursive: true });
for (const dir of [checkoutDir, worktreeDir, installedDir]) {
  cpSync(join(root, 'installer'), join(dir, 'installer'), { recursive: true });
}
writeFileSync(join(worktreeDir, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n');

// The whole sandbox: a home folder, Tess's folders, a Spotify-shaped app, and tools that would touch the real Mac.
const home = join(box, 'home');
const tess = join(box, 'tess');
const config = join(box, 'config');
const spotify = join(box, 'Spotify.app');
const fakeLog = join(box, 'fake-tools.log');
const fakeBin = join(box, 'fake-bin');
const fakeBinLinux = join(box, 'fake-bin-linux');
mkdirSync(home, { recursive: true });
// Spotify's prefs file: the installer opens Spotify once and waits for this, which a sandbox never writes.
mkdirSync(join(home, 'Library', 'Application Support', 'Spotify'), { recursive: true });
writeFileSync(join(home, 'Library', 'Application Support', 'Spotify', 'prefs'), '');
mkdirSync(fakeBin, { recursive: true });
mkdirSync(fakeBinLinux, { recursive: true });
mkdirSync(join(spotify, 'Contents', 'MacOS'), { recursive: true });
mkdirSync(join(spotify, 'Contents', 'Resources', 'Apps'), { recursive: true });
const stockInterface = 'stock Spotify interface\n';
writeFileSync(join(spotify, 'Contents', 'Resources', 'Apps', 'xpui.spa'), stockInterface);
writeFileSync(join(spotify, 'Contents', 'MacOS', 'Spotify'), '');
writeFileSync(join(spotify, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.3.9</string></dict></plist>
`);

// Only Apple's tools matter here, and every one of them is replaced or kept away from the real Mac: no launchd job, no
// dialog, no browser, no network, and nothing reported as running or playing.
const fakeTool = (name, status) => {
  writeFileSync(join(fakeBin, name), `#!/bin/sh\necho "${name} $*" >> "$FAKE_LOG"\nexit ${status}\n`);
  chmodSync(join(fakeBin, name), 0o755);
};
fakeTool('launchctl', 0);
fakeTool('pgrep', 1);
fakeTool('pmset', 0);
fakeTool('osascript', 0);
fakeTool('open', 0);
fakeTool('scutil', 0);
fakeTool('curl', 22);
// The installer's first real step on a Mac that is not one; it proves the script started without installing anything.
writeFileSync(join(fakeBinLinux, 'uname'), '#!/bin/sh\necho Linux\n');
chmodSync(join(fakeBinLinux, 'uname'), 0o755);

const env = (extra = {}) => {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith('TESS_')) delete clean[key];
  return {
    ...clean,
    HOME: home,
    TESS_HOME: tess,
    TESS_CONFIG: config,
    TESS_SPOTIFY: spotify,
    FAKE_LOG: fakeLog,
    PATH: `${fakeBin}:${process.env.PATH}`,
    ...extra,
  };
};
const run = (shell, args, options = {}) => {
  const r = spawnSync(shell === 'sh' ? '/bin/sh' : '/bin/zsh', args, { encoding: 'utf8', env: env(), ...options });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const untouched = (why) => {
  assert.equal(existsSync(tess), false, `${why}: nothing was written into TESS_HOME`);
  assert.equal(existsSync(config), false, `${why}: nothing was written into TESS_CONFIG`);
  assert.equal(existsSync(join(spotify, 'Contents', 'Resources', 'Apps', 'xpui')), false, `${why}: Spotify was not patched`);
  assert.equal(readFileSync(join(spotify, 'Contents', 'Resources', 'Apps', 'xpui.spa'), 'utf8'), stockInterface, `${why}: Spotify's own files are unchanged`);
};
const noToolRan = (why) => assert.equal(existsSync(fakeLog), false, `${why}: no system tool was called`);
// A run that is meant to get past the guard calls these tools, so the log is cleared after one before the next
// "nothing may run" check.
const resetToolLog = () => rmSync(fakeLog, { force: true });

try {
  // 1. Sourcing does nothing, and says why. This is the accident that ran the real installer (#107).
  for (const { name, shell } of scripts) {
    for (const [where, dir] of [['a checkout', checkoutDir], ['an installed copy', installedDir]]) {
      const r = run(shell, ['-c', `. "${join(dir, 'installer', name)}"; echo TESS-AFTER-SOURCE`]);
      assert.match(r.out, /was sourced, so it did nothing/, `${name} sourced from ${where}: says why`);
      assert.match(r.out, /run it as its own command/, `${name} sourced from ${where}: says what to do instead`);
      assert.match(r.out, /sh \.\/file or zsh \.\/file/, `${name} sourced from ${where}: names a command that actually runs the file`);
      assert.match(r.out, /TESS-AFTER-SOURCE/, `${name} sourced from ${where}: the caller keeps running`);
      untouched(`${name} sourced from ${where}`);
      noToolRan(`${name} sourced from ${where}`);
    }
    const alone = run(shell, ['-c', `. "${join(checkoutDir, 'installer', name)}"`]);
    assert.notEqual(alone.status, 0, `${name} sourced: the shell is told it refused`);
  }

  // 2. Outside a sandbox, a checkout's copy refuses: it is for developing, not for a real Mac.
  for (const { name, shell } of scripts) {
    const r = run(shell, [join(checkoutDir, 'installer', name)], { cwd: box });
    assert.notEqual(r.status, 0, `${name} from a checkout: refused`);
    assert.match(r.out, /is inside a git checkout/, `${name} from a checkout: says why`);
    assert.match(r.out, /set TESS_REAL_INSTALL=1/, `${name} from a checkout: names the way through`);
    untouched(`${name} from a checkout`);
    noToolRan(`${name} from a checkout`);
  }

  // 2b. Handing the file's text to a shell skips the file itself: there is no source to detect and no path to walk, so
  // `sh -c "$(cat file)"` and zsh's `eval` of that text used to start a real install. Both are refused now. The published
  // `curl … | sh` line is a different shape (the shell reads the pipe, with no `-c` and no file) and stays allowed.
  for (const { name, shell } of scripts) {
    const body = readFileSync(join(checkoutDir, 'installer', name), 'utf8');
    const dashC = run(shell, ['-c', body]);
    assert.notEqual(dashC.status, 0, `${name} handed to ${shell} -c: refused`);
    assert.match(dashC.out, /was handed to a shell to run/, `${name} handed to ${shell} -c: says why`);
    assert.match(dashC.out, /sh \.\/file or zsh \.\/file/, `${name} handed to ${shell} -c: says what to do instead`);
    untouched(`${name} handed to ${shell} -c`);
    noToolRan(`${name} handed to ${shell} -c`);

    const evaled = run('zsh', ['-c', `eval "$(cat "${join(checkoutDir, 'installer', name)}")"`]);
    assert.notEqual(evaled.status, 0, `${name} eval'd under zsh: refused`);
    assert.match(evaled.out, /was handed to a shell to run/, `${name} eval'd under zsh: says why`);
    untouched(`${name} eval'd under zsh`);
    noToolRan(`${name} eval'd under zsh`);

    // The ordinary case: a zsh script outside any checkout that evals the text (context `toplevel:eval`, not `eval…`).
    const evaler = join(checkoutDir, '..', `eval-${name}.zsh`);
    writeFileSync(evaler, `eval "$(cat "${join(checkoutDir, 'installer', name)}")"\n`);
    const fromFile = run('zsh', [evaler]);
    assert.notEqual(fromFile.status, 0, `${name} eval'd from a zsh script: refused`);
    assert.match(fromFile.out, /was handed to a shell to run/, `${name} eval'd from a zsh script: says why`);
    untouched(`${name} eval'd from a zsh script`);
    noToolRan(`${name} eval'd from a zsh script`);
  }

  // The escape still lets the text run, so a sandbox run of a script handed to a shell is not refused.
  for (const { name, shell } of scripts) {
    const body = readFileSync(join(checkoutDir, 'installer', name), 'utf8');
    for (const flag of ['TESS_TEST', 'TESS_REAL_INSTALL']) {
      const allowed = run(shell, ['-c', body], { env: env({ [flag]: '1', TESS_HOME: '', TESS_CONFIG: '', TESS_SPOTIFY: '' }) });
      assert.doesNotMatch(allowed.out, /was handed to a shell to run/, `${name} handed to ${shell} -c with ${flag}=1: not refused`);
    }
  }
  resetToolLog();

  // 2c. The way through is exactly 1. `0` and `false` mean off to a person, and both used to start the real installer.
  for (const { name, shell } of scripts) {
    for (const value of ['', '0', 'false']) {
      const shown = value === '' ? 'empty' : value;
      const r = run(shell, [join(checkoutDir, 'installer', name)], { cwd: box, env: env({ TESS_REAL_INSTALL: value }) });
      assert.notEqual(r.status, 0, `${name} with TESS_REAL_INSTALL=${shown}: refused`);
      assert.match(r.out, /is inside a git checkout/, `${name} with TESS_REAL_INSTALL=${shown}: says why`);
      untouched(`${name} with TESS_REAL_INSTALL=${shown}`);
      noToolRan(`${name} with TESS_REAL_INSTALL=${shown}`);
    }
  }

  // 3. A worktree's .git file counts as a checkout, and so does a folder under one.
  for (const { name, shell } of scripts) {
    const wt = run(shell, [join(worktreeDir, 'installer', name)], { cwd: box });
    assert.match(wt.out, /is inside a git checkout/, `${name} from a worktree: refused`);
    const deep = run(shell, [join(checkoutDir, 'installer', name)], { cwd: checkoutDir });
    assert.match(deep.out, /is inside a git checkout/, `${name} from a folder inside a checkout: refused`);
  }

  // 4. `cd installer && sh tess-install.sh` names no folder, and must not slip past the guard.
  for (const { name, shell } of scripts.filter((s) => s.shell === 'sh')) {
    const r = run(shell, [name], { cwd: join(checkoutDir, 'installer') });
    assert.notEqual(r.status, 0, `${name} run from its own folder in a checkout: refused`);
    assert.match(r.out, /is inside a git checkout/, `${name} run from its own folder in a checkout: says why`);
  }

  // 5. The published install line (`curl … | sh`) is code from a pipe, not a checkout's file, and still runs.
  const piped = run('sh', [], { cwd: checkoutDir, input: readFileSync(join(checkoutDir, 'installer', 'install.sh'), 'utf8') });
  assert.doesNotMatch(piped.out, /was sourced|is inside a git checkout|was handed to a shell/, 'a piped install line is not refused');
  assert.match(piped.out, /Couldn't download Tess's signature checker/, 'a piped install line starts its own work');
  // The old README uninstall line is the same shape as the install line, but it must not run: that file is whatever
  // is on main. Removal is the signed script already on the Mac.
  const pipedUninstall = run('sh', [], { cwd: checkoutDir, input: readFileSync(join(checkoutDir, 'installer', 'uninstall.sh'), 'utf8') });
  assert.notEqual(pipedUninstall.status, 0, 'a piped uninstall line is refused');
  assert.match(pipedUninstall.out, /does not remove Tess/, 'a piped uninstall line says it did not run');
  assert.doesNotMatch(pipedUninstall.out, /Removing Tess Music/, 'a piped uninstall line does not start removing anything');
  untouched('a piped uninstall line');

  // 6. The library file is the one thing that is safe to source, and it acts on nothing.
  const library = run('sh', ['-c', `. "${join(checkoutDir, 'installer', 'redact.sh')}"; type tess_redact >/dev/null 2>&1 && echo TESS-LIBRARY-READY`]);
  assert.match(library.out, /TESS-LIBRARY-READY/, 'sourcing installer/redact.sh defines the filter and does nothing else');
  untouched('sourcing installer/redact.sh');

  // 7. A sandbox (TESS_TEST=1) and the documented escape (TESS_REAL_INSTALL=1) both get past the guard.
  for (const { name, shell } of scripts) {
    for (const flag of ['TESS_TEST', 'TESS_REAL_INSTALL']) {
      const r = run(shell, [join(checkoutDir, 'installer', name)], { cwd: box, env: env({ [flag]: '1' }) });
      assert.doesNotMatch(r.out, /was sourced|is inside a git checkout/, `${name} with ${flag}=1: not refused`);
    }
  }
  // The sandbox itself still works: TESS_TEST=1 asks for its folders instead of installing anything.
  const sandboxed = run('sh', [join(checkoutDir, 'installer', 'tess-install.sh')], { cwd: box, env: env({ TESS_TEST: '1', TESS_HOME: '', TESS_CONFIG: '', TESS_SPOTIFY: '' }) });
  assert.match(sandboxed.out, /TESS_TEST needs TESS_HOME/, 'a sandbox install gets past the guard and checks its own folders');

  // 8. Installed copies, which are not in a checkout, do their work with no flag at all. Each line is the script's own
  // first step, so this proves the guard lets the real paths through.
  const installed = (name) => join(installedDir, 'installer', name);
  const wakeOut = run('zsh', [installed('wake.sh'), '--plist']);
  assert.equal(wakeOut.status, 0, wakeOut.out);
  assert.match(wakeOut.out, /music\.tess\.wake/, 'the installed wake check still writes its LaunchAgent');
  const install = run('sh', [installed('tess-install.sh')], { cwd: box, env: env({ PATH: `${fakeBinLinux}:${fakeBin}:${process.env.PATH}` }) });
  assert.equal(install.status, 1, install.out);
  assert.match(install.out, /Tess Music runs on macOS/, 'the installed installer still starts its own work');
  const uninstall = run('sh', [installed('uninstall.sh')], { cwd: box });
  assert.match(uninstall.out, /Removing Tess Music/, 'the installed uninstaller still starts its own work');
  const command = run('sh', [installed('tess-command.sh')], { cwd: box });
  assert.match(command.out, /usage: tess/, 'the installed command still prints its usage');
  const doctor = run('zsh', [installed('doctor.sh')], { cwd: box });
  assert.match(doctor.out, /Tess isn't installed on this Mac/, 'the installed doctor still starts its own check');
  const rescue = run('zsh', [installed('rescue.sh')], { cwd: box });
  assert.doesNotMatch(rescue.out, /is inside a git checkout|was handed to a shell/, 'the installed rescue line is not refused');
  // A positive step, so a false positive in either refusal cannot pass as "not refused": launchd runs these as
  // `/bin/zsh <file>`, with no `-c`, and the guard has to leave that alone.
  // launchd starts these as `/bin/zsh <file>` as well, and that path must stay open. The updater only goes past its
  // first check with the settings the installer writes, so give it the sandbox's Spotify path first.
  mkdirSync(tess, { recursive: true });
  writeFileSync(join(tess, 'updater.env'), `SPOTIFY=${spotify}\n`);
  const logBefore = existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8') : '';
  const updater = run('zsh', [installed('updater.sh')], { cwd: box });
  const updaterCalls = (existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8') : '').slice(logBefore.length);
  assert.doesNotMatch(updater.out, /is inside a git checkout|was handed to a shell/, 'the installed updater is not refused');
  assert.match(updaterCalls, /music\.tess\.guard/, 'the installed updater still asks launchd for its guard job');

  // 9. A dotfiles repository in the home folder (`git init` in ~) is not a copy of Tess: an install under it still runs.
  const dotfiles = join(box, 'dotfiles');
  const dotfilesTess = join(dotfiles, 'Library', 'Application Support', 'Tess');
  mkdirSync(join(dotfiles, '.git'), { recursive: true });
  mkdirSync(dotfilesTess, { recursive: true });
  cpSync(join(root, 'installer', 'wake.sh'), join(dotfilesTess, 'wake.sh'));
  const dotfilesOut = run('zsh', [join(dotfilesTess, 'wake.sh'), '--plist'], { cwd: box, env: env({ HOME: dotfiles, TESS_HOME: dotfilesTess }) });
  assert.equal(dotfilesOut.status, 0, dotfilesOut.out);
  assert.match(dotfilesOut.out, /music\.tess\.wake/, 'an install under a home folder that is a repository still runs');

  console.log('script guard tests passed (8 scripts: sourcing does nothing; a body handed to sh -c or eval is refused; '
    + 'a checkout or worktree copy refuses, so do TESS_REAL_INSTALL=0/false; the piped install line, TESS_TEST=1, '
    + 'TESS_REAL_INSTALL=1 and installed copies run)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
