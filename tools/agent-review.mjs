// Run a read-only issue approach or pull-request review and post the verdict.
// Usage: node tools/agent-review.mjs <approach|pr> <number>
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const marker = '<!-- tess-review-bot -->';
const providerDetails = {
  claude: { command: 'claude', cache: 'claudeAgent.json' },
  codex: { command: 'codex', cache: 'codex.json' },
  cursor: { command: 'cursor-agent', cache: 'cursor.json' },
  opencode: { command: 'opencode', cache: 'opencode.json' },
};

const docsPath = (path) => path.startsWith('docs/')
  || path.endsWith('.md')
  || path.startsWith('.github/ISSUE_TEMPLATE/');
const sensitivePath = (path) => path.startsWith('installer/')
  || path.startsWith('inbox/')
  || path.startsWith('patcher/')
  || path.startsWith('.github/')
  || ['tools/release.mjs', 'tools/promote.mjs', 'tools/rescue.mjs', 'tools/check-safety.sh'].includes(path)
  || /(^|[/.-])(signing|rescue)([/.-]|$)/i.test(path);

export function tierForPaths(paths) {
  const clean = paths.map((path) => String(path).trim()).filter(Boolean);
  if (clean.length && clean.every(docsPath)) return 'docs';
  if (clean.some((path) => !docsPath(path) && sensitivePath(path))) return 'sensitive';
  return 'normal';
}

export function providerHasUsage(usage) {
  if (!usage || !Array.isArray(usage.windows) || usage.windows.length === 0) return true;
  const now = Date.now();
  return usage.windows.every((window) => {
    if (window.resetsAt && Date.parse(window.resetsAt) <= now) return true;
    return typeof window.usedPercent !== 'number' || window.usedPercent < 100;
  });
}

export function eligibleModels(models, usageByProvider, commandAvailable = () => true) {
  return models.filter(({ provider }) => {
    const details = providerDetails[provider];
    return details && commandAvailable(details.command) && providerHasUsage(usageByProvider[provider]);
  });
}

function commandExists(command) {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

function readUsage(provider) {
  const cache = providerDetails[provider]?.cache;
  if (!cache) return undefined;
  try {
    return JSON.parse(readFileSync(`${homedir()}/.t3/caches/${cache}`, 'utf8')).usageLimits;
  } catch {
    return undefined;
  }
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, ...options }).trim();
}

function apiJson(path) {
  return JSON.parse(gh(['api', path, '-H', 'Accept: application/vnd.github+json']) || 'null');
}

function eventComment() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) return '';
  try { return JSON.parse(readFileSync(path, 'utf8')).comment?.body || ''; } catch { return ''; }
}

function issueText(issue) {
  return [
    `#${issue.number}: ${issue.title}`,
    `URL: ${issue.html_url}`,
    '',
    issue.body || '(no description)',
  ].join('\n');
}

function linkedIssueNumber(body) {
  const closing = String(body || '').match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i);
  if (closing) return Number(closing[1]);
  const any = String(body || '').match(/#(\d+)\b/);
  return any ? Number(any[1]) : null;
}

function reviewPrompt(role, context) {
  const common = [
    'You are the Tess Music reviewer. Review only the supplied text.',
    'Do not run code, edit files, install anything, or inspect a pull-request checkout.',
    'Find concrete correctness, safety, and spec gaps. Be concise and cite the supplied path or requirement.',
    'End with exactly one line: Verdict: approve OR Verdict: changes needed.',
  ].join('\n');
  if (role === 'approach') {
    return `${common}\n\nISSUE\n${context.issue}\n\nAPPROACH COMMENT\n${context.approach}`;
  }
  return `${common}\n\nLINKED ISSUE\n${context.issue}\n\nAPPROACH\n${context.approach}\n\nPULL REQUEST DIFF\n${context.diff}`;
}

function reviewerEnv() {
  const allowed = ['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL'];
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
}

function cliInvocation(provider, model, prompt) {
  const env = reviewerEnv();
  if (provider === 'claude') {
    return spawnSync('claude', ['-p', '--model', model, '--restricted', '--safe-mode', '--tools', ''], {
      cwd: root,
      env,
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
    });
  }
  if (provider === 'codex') {
    return spawnSync('codex', ['exec', '--model', model, '--sandbox', 'read-only', '--ephemeral', '--ignore-rules', '-C', root, '-'], {
      cwd: root,
      env,
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
    });
  }
  if (provider === 'cursor') {
    return spawnSync('cursor-agent', ['--print', '--mode', 'ask', '--model', model, '--workspace', root, prompt], {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
    });
  }
  if (provider === 'opencode') {
    return spawnSync('opencode', ['run', '--agent', 'plan', '--model', model, '--archived', prompt], {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
    });
  }
  throw new Error(`unsupported review provider: ${provider}`);
}

function usageLimitError(result) {
  return /(?:usage|rate)[ -]?limit|quota|credits?.*(?:exhaust|deplet|limit)|too many requests|insufficient.*credits?/i
    .test(`${result.stdout || ''}\n${result.stderr || ''}`);
}

function runReviewer(models, prompt) {
  const usage = Object.fromEntries(models.map(({ provider }) => [provider, readUsage(provider)]));
  const candidates = eligibleModels(models, usage, commandExists);
  if (!candidates.length) throw new Error('no configured reviewer provider has both usage and a local CLI');

  for (const candidate of candidates) {
    const result = cliInvocation(candidate.provider, candidate.model, prompt);
    if (result.status === 0 && result.stdout?.trim()) return { ...candidate, text: result.stdout.trim() };
    if (usageLimitError(result)) continue;
    throw new Error(`${candidate.provider} reviewer failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
  throw new Error('all configured reviewer providers reported a usage limit');
}

function verdictFor(text) {
  if (/Verdict:\s*changes needed/i.test(text)) return 'changes needed';
  if (/Verdict:\s*approve/i.test(text)) return 'approve';
  return 'changes needed';
}

function postComment(repo, number, body) {
  execFileSync('gh', ['issue', 'comment', String(number), '-R', repo, '--body-file', '-'], {
    input: body,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

async function main() {
  const [role, numberText] = process.argv.slice(2);
  if (role === 'tier') {
    const paths = readFileSync(0, 'utf8').split('\n');
    console.log(tierForPaths(paths));
    return;
  }
  const number = Number(numberText);
  if (!['approach', 'pr'].includes(role) || !Number.isInteger(number) || number < 1) {
    console.error('usage: node tools/agent-review.mjs <approach|pr> <number>');
    process.exit(1);
  }

  const repo = process.env.GITHUB_REPOSITORY || 'Flame119052/tess-music';
  const config = JSON.parse(readFileSync(`${root}.github/agents.json`, 'utf8'));
  const issue = apiJson(`repos/${repo}/issues/${number}`);

  if (role === 'approach') {
    const approach = eventComment();
    const result = runReviewer(config.approach, reviewPrompt(role, {
      issue: issueText(issue),
      approach,
    }));
    const verdict = verdictFor(result.text);
    const review = result.text.replaceAll(marker, '').replace(/\n?Verdict:\s*(?:approve|changes needed)\s*$/i, '').trim();
    postComment(repo, number, `${marker}\nReviewer: ${result.provider} / ${result.model}\n\n${review}\n\nVerdict: ${verdict}`);
    return;
  }

  const files = gh(['api', `repos/${repo}/pulls/${number}/files`, '--paginate', '--jq', '.[].filename']).split('\n').filter(Boolean);
  const tier = tierForPaths(files);
  if (tier === 'docs') {
    postComment(repo, number, `${marker}\n\ndocs-only: CI is the review\n\nVerdict: approve`);
    return;
  }

  const linkedNumber = linkedIssueNumber(issue.body);
  const linked = linkedNumber ? apiJson(`repos/${repo}/issues/${linkedNumber}`) : null;
  let approach = '(no linked approach comment found)';
  if (linkedNumber) {
    const comments = apiJson(`repos/${repo}/issues/${linkedNumber}/comments?per_page=100`) || [];
    const approved = comments.filter((comment) => /(^|\n)@tess-review approach(?:\s|$)/.test(comment.body || ''));
    if (approved.length) approach = approved.at(-1).body;
  }
  const diff = gh(['pr', 'diff', String(number), '-R', repo]);
  const key = tier === 'sensitive' ? 'pr_sensitive' : 'pr_normal';
  const result = runReviewer(config[key], reviewPrompt(role, {
    issue: linked ? issueText(linked) : '(no linked issue found)',
    approach,
    diff,
  }));
  const verdict = verdictFor(result.text);
  const review = result.text.replaceAll(marker, '').replace(/\n?Verdict:\s*(?:approve|changes needed)\s*$/i, '').trim();
  postComment(repo, number, `${marker}\nTier: ${tier}\nReviewer: ${result.provider} / ${result.model}\n\n${review}\n\nVerdict: ${verdict}`);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  await main();
}
