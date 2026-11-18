// Test rescue with an ephemeral signing key and the real Go verifier built for that key.
// Usage: node tools/test-rescue.mjs [--slow] (no installed Tess or production keys required)
// Proves: each of the five actions is accepted; script orders, unknown actions, injected text, bad signatures,
// expired orders, replays and orders for other Macs do nothing; an order's time limit stops the action and every
// process it started, and a running order records its process group for `tess rescue off` (--slow adds the 60 s
// end-to-end run).
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const { privateKey: key, publicKey } = generateKeyPairSync('ed25519');
const box = mkdtempSync(join(tmpdir(), 'tess-rescue-test-'));
const T = join(box, 'Tess'), R = join(T, 'rescue'), orders = join(box, 'orders');
mkdirSync(R, { recursive: true }); mkdirSync(orders);
const rawKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
execFileSync('go', ['build', '-ldflags', `-X main.publicKey=${rawKey}`, '-o', join(R, 'tess-rescue-verify'), './tessverify'], { cwd: join(root, 'patcher') });
cpSync(join(root, 'installer/rescue.sh'), join(R, 'rescue.sh'));
const ID = 'a'.repeat(32), OTHER = 'b'.repeat(32);
writeFileSync(join(T, 'install-id'), ID);
writeFileSync(join(T, 'installer.sh'), '#!/bin/sh\nexit 0\n');
writeFileSync(join(T, 'uninstall.sh'), '#!/bin/sh\nexit 0\n');
mkdirSync(join(T, 'bin/patcher'), { recursive: true });
writeFileSync(join(T, 'bin/patcher/tess-verify'), '#!/bin/sh\nexit 0\n');
chmodSync(join(T, 'bin/patcher/tess-verify'), 0o755);
const env = { ...process.env, TESS_TEST: '1', TESS_HOME: T, TESS_RESCUE_DIR: orders };
const later = () => Math.floor(Date.now() / 1000) + 3600;

const publish = (text, { badSig = false } = {}) => {
  writeFileSync(join(orders, 'rescue.txt'), text);
  const sig = sign(null, Buffer.from(badSig ? text + 'x' : text), key).toString('base64');
  writeFileSync(join(orders, 'rescue.sig'), sig + '\n');
};
const order = (serial, action, extra = []) => ['tess-rescue 2', `serial ${serial}`, `expires ${later()}`, ...extra, `action ${action}`].join('\n') + '\n';
const run = (...args) => execFileSync('/bin/zsh', [join(R, 'rescue.sh'), ...args], { env, encoding: 'utf8' });
const serial = () => Number(readFileSync(join(R, 'serial'), 'utf8'));
const log = () => (existsSync(join(R, 'rescue.log')) ? readFileSync(join(R, 'rescue.log'), 'utf8') : '');
const marker = join(box, 'PWNED');
const slowChild = join(box, 'slow-child.pid');
// A pid that is gone cannot be signalled: the point of the timeout tests below is that this is false afterwards.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidIn = (file) => { try { return Number(readFileSync(file, 'utf8').trim()); } catch { return 0; } };

try {
  let s = 0;
  // 1. every action is accepted and maps to Tess's own tool
  const expect = { check: 'doctor.sh --report', update: 'updater.sh', repair: `${T}/installer.sh`, 'restore-spotify': 'restore', uninstall: `${T}/uninstall.sh` };
  for (const [a, what] of Object.entries(expect)) {
    publish(order(++s, a)); run();
    assert.equal(serial(), s, `${a}: marked done`);
    assert.match(log(), new RegExp(`order ${s}: ${a}`)); assert.ok(log().split('\n').some((l) => l.includes('would run') && l.includes(what)), `${a} runs ${what}`);
  }
  assert.ok(!log().includes('curl '), 'repair and uninstall never fetch code');
  // 2. a replay does nothing
  const before = log(); run(); assert.equal(log(), before, 'replay ignored');
  // 3. an old-style script order is refused (and its script never runs)
  publish(['tess-rescue 1', `serial ${++s}`, `expires ${later()}`, '---', `touch ${marker}`].join('\n') + '\n'); run();
  assert.ok(!existsSync(marker), 'script order did not run'); assert.equal(serial(), s - 1, 'script order not even marked');
  // 4. an unknown action is refused
  publish(order(++s, 'shell')); run();
  assert.ok(!existsSync(marker)); assert.match(log(), /'shell'.*refused/);
  // 5. text smuggled after an action is refused, and never run
  publish(order(++s, `check; touch ${marker}`)); run();
  assert.ok(!existsSync(marker), 'injected command did not run'); assert.match(log(), /isn't one of Tess's rescue actions/);
  publish(order(++s, `$(touch ${marker})`)); run();
  assert.ok(!existsSync(marker), 'command substitution did not run');
  // 6. a bad signature is refused
  const done = serial();
  publish(order(++s, 'check'), { badSig: true }); run(); assert.equal(serial(), done, 'bad signature ignored');
  // 7. an expired order is refused
  publish(['tess-rescue 2', `serial ${++s}`, `expires ${Math.floor(Date.now() / 1000) - 10}`, 'action check'].join('\n') + '\n'); run();
  assert.equal(serial(), done, 'expired order ignored');
  // 8. an order for another Mac is skipped (marked seen, not run)
  const n = log().length;
  publish(order(++s, 'uninstall', [`only ${OTHER}`])); run();
  assert.equal(serial(), s); assert.ok(!log().slice(n).includes('would run'), 'other Mac\'s order not run');
  // 9. ...and one naming this Mac runs
  publish(order(++s, 'check', [`only ${OTHER} ${ID}`])); run();
  assert.equal(serial(), s); assert.match(log().slice(n), /would run.*doctor/);
  // 10. repair without a verifier is refused loudly, not run against the archive's own checker
  const beforeMissing = log().length;
  rmSync(join(T, 'bin/patcher/tess-verify'));
  publish(order(++s, 'repair')); run();
  assert.equal(serial(), s, 'the order is marked seen');
  assert.match(log().slice(beforeMissing), /repair: no verifier installed; refused/);
  assert.ok(!log().slice(beforeMissing).includes('would run'), 'repair did not run without a verifier');
  writeFileSync(join(T, 'bin/patcher/tess-verify'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(T, 'bin/patcher/tess-verify'), 0o755);
  // 11. an order says how long its action may run: read, defaulted and clamped, never unbounded
  const limit = () => (log().match(/up to (\d+)s/g) || []).pop();
  publish(order(++s, 'check', ['timeout 900'])); run();
  assert.equal(limit(), 'up to 900s', 'the order sets its own limit');
  publish(order(++s, 'check', ['timeout abc'])); run();
  assert.equal(limit(), 'up to 1800s', 'a value that is not a number falls back to half an hour');
  publish(order(++s, 'check', ['timeout 10'])); run();
  assert.equal(limit(), 'up to 60s', 'a too-short limit is raised to a minute');
  publish(order(++s, 'check', ['timeout 99999'])); run();
  assert.equal(limit(), 'up to 3600s', 'a too-long limit is lowered to an hour');
  // 12. a real run reports only this order's lines, through the shared privacy filter
  const me = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
  writeFileSync(join(T, 'doctor.sh'), `#!/bin/zsh
echo "doctor report: Tess is fine"
echo "home $HOME account ${me} mac $(scutil --get ComputerName) mail ${me}@example.com"
exit 0
`);
  chmodSync(join(T, 'doctor.sh'), 0o755);
  appendFileSync(join(R, 'rescue.log'), '2026-01-01 00:00:00 an earlier order said: /Users/someone.else/private\n');
  publish(order(++s, 'check'));
  execFileSync('/bin/zsh', [join(R, 'rescue.sh')], { env: { ...env, TESS_TEST_RUN: '1' }, encoding: 'utf8' });
  const sent = JSON.parse(readFileSync(join(R, 'order-report.json'), 'utf8'));
  assert.equal(sent.kind, 'rescue', 'the report is a rescue report');
  assert.equal(sent.status, `order ${s} check exit 0`, 'the status names this order and its exit');
  assert.match(sent.body, /doctor report: Tess is fine/, 'the action output is included');
  assert.match(sent.body, /~/, 'a home folder is folded');
  assert.match(sent.body, /\(email\)/, 'an email address is removed');
  assert.ok(!sent.body.includes(me), 'the account name is removed');
  assert.ok(!sent.body.includes('someone.else'), 'an earlier order is not uploaded again');
  assert.ok(!sent.body.includes('an earlier order said'), 'the report starts where this order started');

  // 12b. the limit stops the action AND what the action started, in seconds rather than sixty: the runner is lifted out
  // of rescue.sh and driven on its own (the same way test-install lifts the doctor's settings writer). The action here
  // starts a long child and then sleeps itself, which is the shape of check, update and repair.
  const runner = readFileSync(join(root, 'installer/rescue.sh'), 'utf8').match(/^run_bounded\(\) \{[\s\S]*?^\}$/m);
  assert.ok(runner, 'rescue.sh still has the bounded runner');
  const held = join(box, 'held.pid'), boundedRc = join(box, 'bounded.rc'), boundedStop = join(box, 'bounded.stop'), boundedLog = join(box, 'bounded.log');
  const driver = join(box, 'bounded.zsh');
  writeFileSync(driver, `#!/bin/zsh
${runner[0]}
run_bounded 3 "$1" "$2" "$3" /bin/zsh -c 'sleep 300 & echo $! > "$1"; sleep 300' _ ${JSON.stringify(held)} 2>/dev/null
`);
  const t0 = Date.now();
  execFileSync('/bin/zsh', [driver, boundedLog, boundedRc, boundedStop], { encoding: 'utf8' });
  const short = (Date.now() - t0) / 1000;
  const heldPid = Number(readFileSync(held, 'utf8').trim());
  assert.ok(short >= 3 && short < 30, `the runner stopped the group at its limit (took ${Math.round(short)}s)`);
  assert.equal(readFileSync(boundedStop, 'utf8').trim(), 'term', 'the group went away on TERM');
  assert.equal(readFileSync(boundedRc, 'utf8').trim(), '143', 'the action is reported as stopped, not as a success');
  assert.equal(alive(heldPid), false, `the child the action started is gone when the runner returns (pid ${heldPid})`);
  // 12c. an action that ignores TERM is still stopped: the grace period ends in KILL, and the log can say which happened
  const stubborn = join(box, 'stubborn.pid'), stubbornStop = join(box, 'stubborn.stop');
  writeFileSync(driver, `#!/bin/zsh
${runner[0]}
run_bounded 2 "$1" "$2" "$3" /bin/zsh -c 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done' _ ${JSON.stringify(stubborn)} 2>/dev/null
`);
  const t1 = Date.now();
  execFileSync('/bin/zsh', [driver, boundedLog, boundedRc, stubbornStop], { encoding: 'utf8' });
  const held2 = Number(readFileSync(stubborn, 'utf8').trim());
  assert.ok((Date.now() - t1) / 1000 < 40, 'TERM, the grace period and KILL all finished');
  assert.equal(readFileSync(stubbornStop, 'utf8').trim(), 'kill', 'a process that ignores TERM is killed outright');
  assert.equal(alive(held2), false, `the process that ignored TERM is gone (pid ${held2})`);
  // 12d. while an action runs, the runner writes its process group to order.pid, which is what `tess rescue off` reads to
  // stop an order that has already started (#91). The number is the group's leader, and it goes away when the limit stops
  // the action, so a person who turns the line off later is never handed a number that has moved on.
  const groupPidFile = join(R, 'order.pid'), groupLog = join(box, 'group.log'), groupRc = join(box, 'group.rc'), groupStopFile = join(box, 'group.stop');
  writeFileSync(driver, `#!/bin/zsh
${runner[0]}
RUN_PIDFILE=${JSON.stringify(groupPidFile)}
run_bounded 2 "$1" "$2" "$3" /bin/zsh -c 'sleep 60' _ 2>/dev/null
`);
  const runnerJob = spawn('/bin/zsh', [driver, groupLog, groupRc, groupStopFile], { stdio: 'ignore' });
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 60 && !existsSync(groupPidFile); i++) pause(50);
  assert.ok(existsSync(groupPidFile), 'a running order writes its process group down for `tess rescue off`');
  const groupLines = readFileSync(groupPidFile, 'utf8').split('\n');
  const groupPid = Number(groupLines[0]);
  const groupStart = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(groupPid)], { encoding: 'utf8' }).trim();
  assert.equal(groupLines[1], groupStart, 'order.pid records the pid and the start time');
  assert.equal(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(groupPid)], { encoding: 'utf8' }).trim(), String(groupPid), 'the number written is the group leader');
  for (let i = 0; i < 100 && existsSync(groupPidFile); i++) pause(50);
  assert.ok(!existsSync(groupPidFile), 'a stopped order leaves no number behind');
  assert.equal(readFileSync(groupStopFile, 'utf8').trim(), 'term', 'the action was stopped by the limit, not left running');
  assert.equal(alive(groupPid), false, `the action's group is gone (pid ${groupPid})`);
  runnerJob.kill('SIGKILL');
  if (process.argv.includes('--slow')) {
    // 13. an action that outlives its limit is stopped, with everything it started, and the log says which limit it
    // passed (60 s of real waiting). The child is the shape that matters: `check`, `update` and `repair` run the
    // patcher, ditto and curl as children of the action's shell, and stopping only that shell left them running.
    writeFileSync(join(T, 'doctor.sh'), `#!/bin/zsh
sleep 600 &
echo $! > ${slowChild}
sleep 600
`);
    chmodSync(join(T, 'doctor.sh'), 0o755);
    const started = Date.now();
    publish(order(++s, 'check', ['timeout 60']));
    execFileSync('/bin/zsh', [join(R, 'rescue.sh')], { env: { ...env, TESS_TEST_RUN: '1' }, encoding: 'utf8' });
    const took = (Date.now() - started) / 1000;
    assert.ok(took >= 60 && took < 120, `the action was stopped at the limit (took ${Math.round(took)}s)`);
    assert.match(log(), new RegExp(`order ${s} ran past 60s; stopped it`), 'the stop names the limit');
    assert.equal(serial(), s, 'a stopped order is still marked done');
    const child = Number(readFileSync(slowChild, 'utf8').trim());
    assert.ok(child > 1, 'the action recorded the child it started');
    assert.equal(alive(child), false, `the child the action started was stopped too (pid ${child} still ran)`);
  }
  // 12e. `tess rescue off` writes "off" before the signal, so the log and the report name what stopped the order.
  {
    writeFileSync(join(T, 'doctor.sh'), '#!/bin/zsh\nsleep 300\n');
    chmodSync(join(T, 'doctor.sh'), 0o755);
    const agents = join(box, 'LaunchAgents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(T, 'tess'), readFileSync(join(root, 'installer/tess-command.sh')));
    chmodSync(join(T, 'tess'), 0o755);
    publish(order(++s, 'check', ['timeout 60']));
    const offRescue = spawn('/bin/zsh', [join(R, 'rescue.sh')], { env: { ...env, TESS_TEST_RUN: '1' }, stdio: 'ignore' });
    const offOrderPid = join(box, 'off-order.pid');
    try {
      for (let i = 0; i < 50 && !existsSync(join(R, 'order.pid')); i++) pause(100);
      assert.ok(existsSync(join(R, 'order.pid')), 'the order wrote its pid before rescue off');
      const leader = Number(readFileSync(join(R, 'order.pid'), 'utf8').split('\n')[0]);
      writeFileSync(offOrderPid, `${leader}\n`);
      const offOut = execFileSync('/bin/sh', [join(T, 'tess'), 'rescue', 'off'], {
        env: { ...env, TESS_LAUNCH_AGENTS: agents },
        encoding: 'utf8',
      });
      assert.match(offOut, /had already started was stopped/);
      const stoppedLine = `rescue order ${s} was stopped by rescue off`;
      for (let i = 0; i < 40 && !log().includes(stoppedLine); i++) pause(250);
      assert.match(log(), new RegExp(stoppedLine));
      const offReport = JSON.parse(readFileSync(join(R, 'order-report.json'), 'utf8'));
      assert.match(offReport.status, /stopped by rescue off/);
      assert.match(offReport.body, /stopped by rescue off/);
      assert.equal(alive(leader), false, 'rescue off stopped the order');
    } finally {
      try { offRescue.kill('SIGKILL'); } catch {}
      const leader = pidIn(offOrderPid);
      try { if (leader > 1) process.kill(-leader, 'SIGKILL'); } catch {}
    }
  }
  writeFileSync(join(T, 'rescue-off'), '');
  publish(order(++s, 'uninstall'));
  const beforeAdopt = log();
  run('--adopt');
  assert.equal(serial(), s, 'adopt records order while still off');
  assert.equal(log(), beforeAdopt, 'adopt never executes the order');
  publish(order(++s, 'check'), { badSig: true });
  assert.throws(() => run('--adopt'), /Command failed/, 'bad signature fails adoption');
  rmSync(join(orders, 'rescue.txt'));
  assert.throws(() => run('--adopt'), /Command failed/, 'offline adoption fails');
  assert.ok(existsSync(join(T, 'rescue-off')), 'adoption never removes opt-out');
  console.log('rescue tests passed (5 actions; script, unknown, injected, bad signature, expired, replay, other Mac; the limit stops the action group; a running order records its group for `tess rescue off`)');
} finally {
  // a failed run must not leave a long sleep of its own behind
  for (const f of [join(box, 'held.pid'), join(box, 'stubborn.pid'), slowChild, join(box, 'off-order.pid')]) {
    const pid = pidIn(f);
    try { if (pid > 1) process.kill(pid, 'SIGKILL'); } catch {}
  }
  rmSync(box, { recursive: true, force: true });
}
