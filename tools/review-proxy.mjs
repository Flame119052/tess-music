// The reviewer's credential stays in this process and never enters the sandbox.
//
// A review runs a provider CLI that can be talked into running a command by the very diff it is reading, and that command
// can read the environment it inherited. Claude Code and OpenCode are handed tool lists that cannot run anything (see
// `claudeTools` and `tools/opencode-reviewer.md`), but Codex's read-only sandbox still allows a shell, and a shell can
// print `env`. So for the providers that take a gateway endpoint, the CLI is pointed at this proxy with a per-review
// token that can spend nothing outside this job, and the real key is added to the request here, in a process the
// sandbox cannot read: it holds no tool that can reach another process, and bubblewrap's `/proc` shows it only its own.
//
// What this does not cover, stated plainly: the token is still a credential the sandbox holds, so a diff can still get
// the model to print it. It dies with the job and opens nothing, and any text that quotes a key the job holds is refused
// by `containsHeldSecret` before it is posted.
//
// Usage (a child process, because the reviewer itself is spawned with `spawnSync` and would otherwise block the proxy):
//   node tools/review-proxy.mjs --config <file> --ready <file>
// The config file holds the provider, its key, the token and the upstream; it lives outside the sandbox (bubblewrap
// gives the reviewer an empty `/tmp`) and is deleted when the review ends. Once listening, the URL is written to the
// ready file. The parent kills this process when the CLI exits.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where each provider's calls really go, and how its credential is spelled on the wire. Only providers whose endpoint is
// a single public host are listed: an OpenCode review spends one connector's allowance at that connector's own endpoint,
// so there is nothing here to point it at, and it keeps its own key (its agent file denies every read outside the copy).
export const proxyProviders = {
  claude: { upstream: 'https://api.anthropic.com', header: 'authorization', scheme: 'Bearer ' },
  codex: { upstream: 'https://api.openai.com', header: 'authorization', scheme: 'Bearer ' },
};

// The path prefix keeps one proxy's routes apart from another's (`/claude/v1/messages` → `https://api.anthropic.com/v1/…`),
// so a request can never leave for a host the provider was not given.
export const proxyPath = (provider) => `/${provider}`;

const upstreamPath = (provider, url) => {
  const stripped = String(url || '').startsWith(proxyPath(provider))
    ? String(url).slice(proxyPath(provider).length)
    : null;
  return stripped && stripped.startsWith('/') ? stripped : null;
};

export function createReviewProxy({ provider, key, token, upstream }) {
  const target = new URL(upstream || proxyProviders[provider]?.upstream || '');
  const forward = target.protocol === 'http:' ? httpRequest : httpsRequest;
  const server = createServer((req, res) => {
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      || String(req.headers['x-api-key'] || '');
    // Anything that is not this job's own token is refused before a byte is forwarded: the proxy is on loopback, but the
    // sandbox is not the only process that could find the port.
    if (!token || given !== token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"tess review proxy: not this review"}');
      return;
    }
    const path = upstreamPath(provider, req.url);
    if (!path) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"tess review proxy: unknown route"}');
      return;
    }
    if (!key) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"tess review proxy: no credential"}');
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.authorization;
    delete headers['x-api-key'];
    headers[proxyProviders[provider]?.header || 'authorization'] = `${proxyProviders[provider]?.scheme || 'Bearer '}${key}`;
    headers.host = target.host;
    const up = forward({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      method: req.method,
      path: `${target.pathname.replace(/\/$/, '')}${path}`,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    // A failed forward is the proxy's own failure, never the reviewer's answer: say so, and keep the key out of it.
    up.on('error', (error) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `tess review proxy: ${error.code || 'upstream failed'}` }));
    });
    req.pipe(up);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// What the sandbox is told, and what it is not: the CLI's own endpoint settings point at the proxy, and the token stands
// where the key used to be. Returning the key names too lets the caller assert they never travel.
export function proxyReviewerConfig(provider, url, token) {
  const base = `${url}${proxyPath(provider)}`;
  if (provider === 'claude') {
    return {
      env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token },
      args: [],
      removedKeys: ['CLAUDE_CODE_OAUTH_TOKEN'],
    };
  }
  if (provider === 'codex') {
    // Codex takes its provider from `-c` overrides, so no config file is written into the sandbox: a file is one more
    // thing a diff could ask the model to read, and the values here hold nothing worth reading. The provider id is
    // underscores because a `-c` key is a dotted TOML path, where a bare key may not contain a hyphen.
    const quote = (value) => JSON.stringify(value);
    return {
      env: { TESS_REVIEW_TOKEN: token },
      args: [
        '-c', `model_provider=${quote('tess_review_proxy')}`,
        '-c', `model_providers.tess_review_proxy.name=${quote('tess review proxy')}`,
        '-c', `model_providers.tess_review_proxy.base_url=${quote(`${base}/v1`)}`,
        '-c', `model_providers.tess_review_proxy.env_key=${quote('TESS_REVIEW_TOKEN')}`,
        '-c', `model_providers.tess_review_proxy.wire_api=${quote('responses')}`,
      ],
      removedKeys: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
    };
  }
  return { env: {}, args: [], removedKeys: [] };
}

function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : '';
  };
  const configPath = value('--config');
  const readyPath = value('--ready');
  if (!configPath || !readyPath) {
    console.error('usage: node tools/review-proxy.mjs --config <file> --ready <file>');
    process.exit(2);
  }
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch {
    console.error('the review proxy was given no readable config');
    process.exit(1);
  }
  createReviewProxy(config).then((proxy) => {
    writeFileSync(readyPath, proxy.url, { mode: 0o600 });
    // The parent kills this process when the reviewer exits; until then it serves one review and nothing else.
    const stop = () => { proxy.close().then(() => process.exit(0)); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((error) => {
    console.error(`the review proxy could not start: ${error.message}`);
    process.exit(1);
  });
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
