#!/usr/bin/env node
// Publish this machine's usage snapshot as one repository Actions variable, so a reviewer on another machine can see what
// is left without holding any account key. Quota only (strict allowlist schema): a fixed provider/instance id, a window
// kind from a known enum, % left (0-100), an ISO reset time, numeric pace fields, a timestamp, and a machine name from
// a fixed list. No labels, plan names, account names, keys, or free text.
//
// Usage: tess-usage-publish [--machine mac|vps|omarchy] [--repo owner/name] [--usage /path/to/tess-usage] [--dry-run]
// Called by a launchd job on the Mac and a user systemd timer on Linux; see README.md in this folder.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const snapshotVersion = 1;

// The three machines Krish runs. The reviewer reads these same names (tools/agent-review.mjs), and the workflow passes
// each variable to the review job. Adding a machine means a variable, one line there, and one line in the workflow.
export const machines = ['mac', 'vps', 'omarchy'];

export const allowedWindowKinds = ['session', 'weekly', 'monthly', 'other'];

// Exact provider/instance pairs a reviewer can be. OpenCode connectors are allowlisted by name so an unknown or custom
// connector suffix can never smuggle an account name or token into the snapshot.
export const allowedProviderInstances = {
  claude: ['claudeAgent'],
  codex: ['codex'],
  cursor: ['cursor'],
  opencode: ['opencode-go', 'zai-coding-plan'],
};

const hubProviderMap = {
  claudeAgent: { provider: 'claude', instance: 'claudeAgent' },
  claude: { provider: 'claude', instance: 'claudeAgent' },
  codex: { provider: 'codex', instance: 'codex' },
  cursor: { provider: 'cursor', instance: 'cursor' },
  'opencode:opencode-go': { provider: 'opencode', instance: 'opencode-go' },
  'opencode:zai-coding-plan': { provider: 'opencode', instance: 'zai-coding-plan' },
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnlyKeys = (obj, allowed) => Object.keys(obj).every((key) => allowed.includes(key));
const isoTimestampRe = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function parseIsoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(isoTimestampRe);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  // Reject calendar rollovers like Feb 30 that Date.parse/Date.UTC would otherwise wrap into the next month.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (match[7] !== 'Z') {
    const [oh, om] = match[7].slice(1).split(':').map(Number);
    if (oh > 23 || om > 59) return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export const variableName = (machine) => `USAGE_SNAPSHOT_${String(machine).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

export function providerFor(instanceId) {
  const id = typeof instanceId === 'string' ? instanceId.trim() : '';
  const found = Object.hasOwn(hubProviderMap, id) ? hubProviderMap[id] : null;
  return found ? { provider: found.provider, instance: found.instance } : null;
}

export function parsePace(paceText) {
  const text = String(paceText || '');
  let deltaPp;
  const deltaMatch = text.match(/(\d+(?:\.\d+)?)pp\s+(ahead of|behind)\s+even burn/);
  if (deltaMatch) {
    const magnitude = Number(deltaMatch[1]);
    if (Number.isFinite(magnitude) && magnitude >= 0 && magnitude <= 100) {
      deltaPp = deltaMatch[2] === 'behind' ? -magnitude : magnitude;
    }
  }
  let runsOutInMins;
  const runsOutMatch = text.match(/runs out in ~?(?=\d)(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?/);
  if (runsOutMatch && (runsOutMatch[1] !== undefined || runsOutMatch[2] !== undefined || runsOutMatch[3] !== undefined)) {
    const mins = (Number(runsOutMatch[1] || 0) * 24 * 60)
      + (Number(runsOutMatch[2] || 0) * 60)
      + Number(runsOutMatch[3] || 0);
    if (Number.isFinite(mins) && mins >= 0) runsOutInMins = mins;
  } else if (/\b0% left now\b/.test(text)) {
    runsOutInMins = 0;
  }
  const pace = {
    ...(deltaPp !== undefined ? { deltaPp } : {}),
    ...(runsOutInMins !== undefined ? { runsOutInMins } : {}),
  };
  return Object.keys(pace).length ? pace : undefined;
}

export function normalizePace(pace) {
  if (!isPlainObject(pace)) return null;
  const out = {};
  if (pace.deltaPp !== undefined) {
    if (typeof pace.deltaPp !== 'number' || !Number.isFinite(pace.deltaPp) || pace.deltaPp < -100 || pace.deltaPp > 100) {
      return null;
    }
    out.deltaPp = pace.deltaPp;
  }
  if (pace.runsOutInMins !== undefined) {
    if (typeof pace.runsOutInMins !== 'number' || !Number.isFinite(pace.runsOutInMins) || pace.runsOutInMins < 0) {
      return null;
    }
    out.runsOutInMins = pace.runsOutInMins;
  }
  return Object.keys(out).length ? out : null;
}

export function normalizeWindow(window) {
  if (!isPlainObject(window)) return null;
  if (typeof window.kind !== 'string' || !allowedWindowKinds.includes(window.kind)) return null;
  if (typeof window.leftPercent !== 'number' || !Number.isFinite(window.leftPercent) || window.leftPercent < 0 || window.leftPercent > 100) {
    return null;
  }
  let resetsAt;
  if (window.resetsAt !== undefined) {
    resetsAt = parseIsoTimestamp(window.resetsAt);
    if (!resetsAt) return null;
  }
  let pace;
  if (window.pace !== undefined) {
    pace = normalizePace(window.pace);
    if (!pace) return null;
  }
  return {
    kind: window.kind,
    leftPercent: window.leftPercent,
    ...(resetsAt ? { resetsAt } : {}),
    ...(pace ? { pace } : {}),
  };
}

export function normalizeProvider(entry) {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.provider !== 'string' || !Object.hasOwn(allowedProviderInstances, entry.provider)) return null;
  if (typeof entry.instance !== 'string' || !allowedProviderInstances[entry.provider].includes(entry.instance)) return null;
  if (!Array.isArray(entry.windows) || !entry.windows.length) return null;
  const windows = [];
  for (const window of entry.windows) {
    const normalized = normalizeWindow(window);
    if (!normalized) return null;
    windows.push(normalized);
  }
  return {
    provider: entry.provider,
    instance: entry.instance,
    windows,
  };
}

export function normalizeProviders(entries) {
  if (!Array.isArray(entries)) return [];
  const rejected = new Set();
  const valid = [];
  for (const entry of entries) {
    const normalized = normalizeProvider(entry);
    if (!normalized) {
      if (isPlainObject(entry)
        && typeof entry.provider === 'string' && Object.hasOwn(allowedProviderInstances, entry.provider)
        && typeof entry.instance === 'string' && allowedProviderInstances[entry.provider].includes(entry.instance)) {
        rejected.add(`${entry.provider}:${entry.instance}`);
      }
      continue;
    }
    valid.push(normalized);
  }
  // Duplicate entries for one provider are merged, keeping every window, so a limit in any of them still counts (the
  // most restrictive one wins downstream). Dropping a duplicate could hide an exhausted window.
  const merged = new Map();
  for (const entry of valid) {
    const key = `${entry.provider}:${entry.instance}`;
    if (rejected.has(key)) continue;
    const seen = merged.get(key);
    if (seen) seen.windows.push(...entry.windows);
    else merged.set(key, { ...entry, windows: [...entry.windows] });
  }
  return [...merged.values()];
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
      const kind = match[3];
      const leftPercent = Number(match[4]);
      const start = match.index + match[1].length;
      const after = rest.slice(start);
      const next = after.slice(1).search(/; [^;]* \[[a-z]+\]: \d+(?:\.\d+)?% left/);
      const body = next < 0 ? after : after.slice(0, next + 1);
      const resetsMatch = body.match(/resets in [^(]*\(([^)]+)\)/);
      const resetsAt = resetsMatch ? parseIsoTimestamp(resetsMatch[1].trim()) : undefined;
      const paceMatch = body.match(/pace:\s*([^;]*(?:;(?! [^;]* \[[a-z]+\]: )\s*[^;]*)*)/);
      const pace = paceMatch ? parsePace(paceMatch[1]) : undefined;
      const normalized = normalizeWindow({
        kind,
        leftPercent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(pace ? { pace } : {}),
      });
      if (normalized) windows.push(normalized);
    }
    const entry = normalizeProvider({ provider, instance, windows });
    if (entry) providers.push(entry);
  }
  return providers;
}

export function buildSnapshot({ machine, takenAt = new Date().toISOString(), text }) {
  return {
    version: snapshotVersion,
    machine: typeof machine === 'string' && machines.includes(machine) ? machine : null,
    takenAt: parseIsoTimestamp(takenAt),
    providers: normalizeProviders(parseTessUsage(text)),
  };
}

// A snapshot is read by a public workflow and sits in a repository variable, so anything outside the strict allowlist
// schema (unrecognized keys, free text, invalid types, unknown providers/machines) or any secret shape stops the publish.
export function snapshotProblem(snapshot) {
  if (!isPlainObject(snapshot)) return 'the snapshot is not an object';
  if (!hasOnlyKeys(snapshot, ['version', 'machine', 'takenAt', 'providers'])) {
    return 'the snapshot holds an unrecognized top-level field';
  }
  if (snapshot.version !== snapshotVersion) return 'unsupported snapshot version';
  if (typeof snapshot.machine !== 'string' || !machines.includes(snapshot.machine)) {
    return `machine must be one of ${machines.join(', ')}`;
  }
  if (!parseIsoTimestamp(snapshot.takenAt)) return 'takenAt must be an ISO-8601 timestamp';
  if (!Array.isArray(snapshot.providers) || !snapshot.providers.length) {
    return 'the hub printed no provider windows to publish';
  }
  for (const entry of snapshot.providers) {
    if (!isPlainObject(entry) || !hasOnlyKeys(entry, ['provider', 'instance', 'windows'])) {
      return 'a provider entry holds an unrecognized field';
    }
    if (!normalizeProvider(entry)) return 'a provider entry fails the allowlist schema';
    for (const w of entry.windows) {
      if (!isPlainObject(w) || !hasOnlyKeys(w, ['kind', 'leftPercent', 'resetsAt', 'pace'])) {
        return 'a window holds an unrecognized field';
      }
      if (w.pace !== undefined && (!isPlainObject(w.pace) || !hasOnlyKeys(w.pace, ['deltaPp', 'runsOutInMins']))) {
        return 'a pace object holds an unrecognized field';
      }
      if (!normalizeWindow(w)) return 'a window fails the allowlist schema';
    }
  }
  const json = JSON.stringify(snapshot);
  if (/-----BEGIN|\b(?:gh[pousr]_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/]{120,}={0,2}/.test(json)) {
    return 'the snapshot looks like it holds a key or token';
  }
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
  return machines.find((name) => short.includes(name)) || '';
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
