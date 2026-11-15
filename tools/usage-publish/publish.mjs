#!/usr/bin/env node
// Publish this machine's usage snapshot as one repository Actions variable, so a reviewer on another machine can see what
// is left without holding any account key. Quota only: a window's share left, when it resets, and the pace sentence the
// hub prints. No keys, no account names, no balances.
//
// Usage: tess-usage-publish [--machine mac|vps|omarchy] [--repo owner/name] [--usage /path/to/tess-usage] [--dry-run]
// Called by a launchd job on the Mac and a user systemd timer on Linux; see README.md in this folder.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const snapshotVersion = 1;

// The three machines Krish runs. The reviewer reads these same names (tools/agent-review.mjs), and the workflow passes
// each variable to the review job. Adding a machine means a variable, one line there, and one line in the workflow.
export const machines = ['mac', 'vps', 'omarchy'];

export const variableName = (machine) => `USAGE_SNAPSHOT_${String(machine).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

// The hub names each provider by its instance. Only the providers a reviewer can be are published, so the snapshot is about
// what a review could spend and nothing else (no Devin or DeepSeek balances, no plans). The reviewer's config names
// OpenCode models as `<connector>/<model>`, so an OpenCode connector keeps its own name:
// `opencode:opencode-go` becomes instance `opencode-go` under provider `opencode`.
export function providerFor(instanceId) {
  const id = String(instanceId || '').trim();
  if (id.startsWith('opencode:')) return { provider: 'opencode', instance: id.slice('opencode:'.length) };
  if (id.startsWith('claude')) return { provider: 'claude', instance: 'claudeAgent' };
  if (id === 'codex') return { provider: 'codex', instance: 'codex' };
  if (id === 'cursor') return { provider: 'cursor', instance: 'cursor' };
  return null;
}

// One line per provider, from `tess-usage` with no argument:
//   - Claude (claudeAgent, claudeAgent): Session [session]: 36% left · resets in 3h 33m (…Z) · pace: …; Weekly [weekly]: …
// The name can itself contain brackets and parentheses ("Z.ai coding plan (OpenCode / ZCode / ZCode Lite)"), so the tuple
// is matched from the end of the line, and a window starts only where `[…] <kind>: <n>% left` appears after a `; `.
export function parseTessUsage(text) {
  const providers = [];
  for (const line of String(text || '').split('\n')) {
    const head = line.match(/^-\s+(.*)\s+\(([^(),]+),\s*([^()]+)\):\s*(.*)$/);
    if (!head) continue;
    const [, , , instanceId, rest] = head;
    const found = providerFor(instanceId);
    if (!found) continue;
    const { provider, instance } = found;
    const windows = [];
    // Each window's label sits between the previous separator and `[kind]: N% left`. A pace sentence may contain a
    // semicolon of its own ("no burn observed; run-out unknown"), so a split on "; " is only a split when what follows
    // really is a new window.
    for (const match of rest.matchAll(/(^|; )([^;]*?) \[([a-z]+)\]: (\d+(?:\.\d+)?)% left/g)) {
      const start = match.index + match[1].length;
      const after = rest.slice(start);
      const next = after.slice(1).search(/; [^;]* \[[a-z]+\]: \d+(?:\.\d+)?% left/);
      const body = next < 0 ? after : after.slice(0, next + 1);
      const resets = body.match(/resets in [^(]*\(([^)]+)\)/);
      const pace = body.match(/pace:\s*([^;]*(?:;(?! [^;]* \[[a-z]+\]: )\s*[^;]*)*)/);
      windows.push({
        kind: match[3],
        leftPercent: Number(match[4]),
        ...(resets ? { resetsAt: resets[1] } : {}),
        ...(pace ? { pace: pace[1].trim() } : {}),
      });
    }
    if (!windows.length) continue;
    providers.push({ provider, instance, windows });
  }
  return providers;
}

export function buildSnapshot({ machine, takenAt = new Date().toISOString(), text }) {
  return {
    version: snapshotVersion,
    machine,
    takenAt,
    providers: parseTessUsage(text),
  };
}

// A snapshot is read by a public workflow and sits in a repository variable, so anything that could be a credential or an
// account name stops the publish instead of being stored. The parser above only keeps numbers, reset times and a pace
// sentence; this is the second guard, so a hub that one day prints more cannot leak it.
export function snapshotProblem(snapshot) {
  const json = JSON.stringify(snapshot);
  if (/-----BEGIN|\b(?:gh[pousr]_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/]{120,}={0,2}/.test(json)) {
    return 'the snapshot looks like it holds a key or token';
  }
  if (!snapshot.providers.length) return 'the hub printed no provider windows to publish';
  if (json.length > 40 * 1024) return `the snapshot is too big for a repository variable (${json.length} bytes)`;
  return null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    if (name === 'dry-run') { out.dryRun = true; continue; }
    out[name] = argv[i + 1];
    i += 1;
  }
  return out;
}

function defaultMachine() {
  if (process.platform === 'darwin') return 'mac';
  const short = hostname().split('.')[0].toLowerCase();
  return machines.find((name) => short.includes(name)) || short.replace(/[^a-z0-9]+/g, '-');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const machine = args.machine || defaultMachine();
  const repo = args.repo || 'Flame119052/tess-music';
  const usage = args.usage || join(homedir(), '.local/bin/tess-usage');

  if (!existsSync(usage)) {
    console.error(`no usage tool at ${usage}; install it or pass --usage`);
    process.exit(2);
  }

  let text;
  try {
    text = execFileSync(usage, [], { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    console.error(`the usage tool failed: ${String(error.stderr || error.message || error).trim().split('\n')[0]}`);
    process.exit(2);
  }

  const snapshot = buildSnapshot({ machine, text });
  const problem = snapshotProblem(snapshot);
  if (problem) {
    console.error(`not publishing: ${problem}`);
    process.exit(4);
  }
  const body = `${JSON.stringify(snapshot)}\n`;

  if (args.dryRun) {
    process.stdout.write(body);
    return;
  }

  const name = variableName(machine);
  try {
    // `gh variable set` reads the value from standard input when --body is left out, which keeps it out of `ps` and out of
    // a shell history.
    execFileSync('gh', ['variable', 'set', name, '--repo', repo], {
      input: body,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (error) {
    console.error(`could not set ${name}: ${String(error.stderr || error.message || error).trim().split('\n')[0]}`);
    process.exit(3);
  }

  // One line, counts only: the timer's log is readable by whoever owns the account, so it says nothing about quota.
  const windows = snapshot.providers.reduce((sum, entry) => sum + entry.windows.length, 0);
  console.error(`published ${name}: ${snapshot.providers.length} providers, ${windows} windows, ${body.length} bytes`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
