// Test the rescue line (installer/rescue.sh) in a sandbox: real orders signed with the rescue key, checked by the
// installed tess-rescue-verify, run with TESS_TEST=1 (actions are logged, never run).
// Usage: node tools/test-rescue.mjs        (owner's Mac only: needs ~/.config/tess-signing/rescue.pem and Tess)
// Proves: each of the five actions is accepted; script orders, unknown actions, injected text, bad signatures,
// expired orders, replays and orders for other Macs do nothing.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const keyFile = `${homedir()}/.config/tess-signing/rescue.pem`;
const verifier = `${homedir()}/Library/Application Support/Tess/rescue/tess-rescue-verify`;
if (!existsSync(keyFile) || !existsSync(verifier)) { console.log('skipped: needs the rescue key and an installed Tess'); process.exit(0); }
const key = createPrivateKey(readFileSync(keyFile));

const box = mkdtempSync(join(tmpdir(), 'tess-rescue-test-'));
const T = join(box, 'Tess'), R = join(T, 'rescue'), orders = join(box, 'orders');
mkdirSync(R, { recursive: true }); mkdirSync(orders);
cpSync(verifier, join(R, 'tess-rescue-verify'));
cpSync(join(root, 'installer/rescue.sh'), join(R, 'rescue.sh'));
const ID = 'a'.repeat(32), OTHER = 'b'.repeat(32);
writeFileSync(join(T, 'install-id'), ID);
const env = { ...process.env, TESS_TEST: '1', TESS_HOME: T, TESS_RESCUE_DIR: orders };
const later = () => Math.floor(Date.now() / 1000) + 3600;

const publish = (text, { badSig = false } = {}) => {
  writeFileSync(join(orders, 'rescue.txt'), text);
  const sig = sign(null, Buffer.from(badSig ? text + 'x' : text), key).toString('base64');
  writeFileSync(join(orders, 'rescue.sig'), sig + '\n');
};
const order = (serial, action, extra = []) => ['tess-rescue 2', `serial ${serial}`, `expires ${later()}`, ...extra, `action ${action}`].join('\n') + '\n';
const run = () => execFileSync('/bin/zsh', [join(R, 'rescue.sh')], { env, encoding: 'utf8' });
const serial = () => Number(readFileSync(join(R, 'serial'), 'utf8'));
const log = () => (existsSync(join(R, 'rescue.log')) ? readFileSync(join(R, 'rescue.log'), 'utf8') : '');
const marker = join(box, 'PWNED');

try {
  let s = 0;
  // 1. every action is accepted and maps to Tess's own tool
  const expect = { check: 'doctor.sh --report', update: 'updater.sh', repair: 'installer/install.sh', 'restore-spotify': 'restore', uninstall: 'uninstall.sh' };
  for (const [a, what] of Object.entries(expect)) {
    publish(order(++s, a)); run();
    assert.equal(serial(), s, `${a}: marked done`);
    assert.match(log(), new RegExp(`order ${s}: ${a}`)); assert.ok(log().split('\n').some((l) => l.includes('would run') && l.includes(what)), `${a} runs ${what}`);
  }
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
  console.log('rescue tests passed (5 actions; script, unknown, injected, bad signature, expired, replay, other Mac)');
} finally {
  rmSync(box, { recursive: true, force: true });
}
