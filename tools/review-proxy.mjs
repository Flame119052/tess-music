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
// the model to print it. It dies with the job, and what it can do is one inference call on one route: `proxyRoutes`
// refuses every other method and path, so the token is not a way to reach the rest of what the key can do (delete a
// file, list a batch). Any text that quotes a key the job holds is refused by `containsHeldSecret` before it is posted.
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

// Where each provider's calls really go, and how its login is spelled on the wire. Only providers whose endpoint is a
// single public host are listed: an OpenCode review spends one connector's allowance at that connector's own endpoint,
// so there is nothing here to point it at, and it keeps its own key (its agent file denies every read outside the copy).
//
// Codex is the ChatGPT plan, not the OpenAI API. That backend lives under `/backend-api/codex` on chatgpt.com and wants
// the account id beside the bearer token, so the proxy adds both from the stored `auth.json` (CODEX_AUTH_JSON).
export const proxyProviders = {
  claude: { upstream: 'https://api.anthropic.com', header: 'authorization', scheme: 'Bearer ' },
  codex: {
    upstream: 'https://chatgpt.com/backend-api/codex',
    header: 'authorization',
    scheme: 'Bearer ',
    accountHeader: 'chatgpt-account-id',
    // The ChatGPT backend expects an originator; the CLI's own plan login sends this one, and the backend answered a real
    // plan request with it and nothing else proprietary present.
    extraHeaders: { originator: 'codex_cli_rs' },
  },
};

// The path prefix keeps one proxy's routes apart from another's (`/claude/v1/messages` → `https://api.anthropic.com/v1/…`),
// so a request can never leave for a host the provider was not given.
export const proxyPath = (provider) => `/${provider}`;

// The exact requests a review's CLI makes, and nothing else. Confirmed by running both pinned CLIs against a local
// upstream that logged every method and path: Claude Code 2.1.325 in the review's print mode (restricted, safe mode,
// Read/Grep/Glob) sends only `POST /v1/messages?beta=true`, and Codex 0.169.0 with `wire_api = "responses"` sends only
// `POST /v1/responses`. On the ChatGPT plan the same `POST …/responses` lands on `chatgpt.com/backend-api/codex/responses`,
// which is what the upstream above plus this `/responses` route forwards to: a real `codex exec` was pointed at a local
// proxy that logged the request and forwarded it there, and the backend answered it as a plan request (a usage-limit
// answer for an account with no weekly room left, not a 401 or a 404), with `authorization` and `chatgpt-account-id` the
// only credential headers it received. The login can also list and delete files on the API; none of that is on this list,
// so the proxy never carries the login to it. A route is a method, a literal path, and the only query keys the CLI was
// seen to send (an empty list means no query at all).
export const proxyRoutes = {
  claude: [{ method: 'POST', path: '/v1/messages', query: ['beta'] }],
  codex: [{ method: 'POST', path: '/responses', query: [] }],
};

// A review body is a diff and a prompt; 10 MB is far above the largest real one and below anything that could be used
// to exhaust the runner.
export const maxProxyBodyBytes = 10 * 1024 * 1024;

const decodeSafe = (value) => {
  try { return decodeURIComponent(value); } catch { return null; }
};

// What this asks: does the request line name one of the routes above, exactly? It answers with the canonical method,
// path and query to forward, or null. Everything a request line could do to look like a route without being one is
// refused here, before any byte or the key moves: another method, another path, `..` and `.` segments, `//`, a
// backslash, any percent-escape (which is how `%2f`, `%2e%2e` and `%5c` hide), a fragment, a query key the CLI does
// not send, and an absolute-form URL that names its own host.
export function matchProxyRoute(provider, method, rawUrl) {
  const routes = proxyRoutes[provider] || [];
  const prefix = proxyPath(provider);
  const url = String(rawUrl || '');
  if (!url.startsWith(`${prefix}/`)) return null;
  const rest = url.slice(prefix.length);
  if (rest.includes('#')) return null;
  const at = rest.indexOf('?');
  const path = at === -1 ? rest : rest.slice(0, at);
  const search = at === -1 ? '' : rest.slice(at + 1);
  if (path.includes('\\') || path.includes('//')) return null;
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (decodeSafe(path) !== path) return null;
  const route = routes.find((candidate) => candidate.method === String(method || '').toUpperCase()
    && candidate.path === path);
  if (!route) return null;
  const pairs = [];
  if (search) {
    for (const part of search.split('&')) {
      const eq = part.indexOf('=');
      const key = eq === -1 ? part : part.slice(0, eq);
      const value = eq === -1 ? '' : part.slice(eq + 1);
      if (!route.query.includes(key)) return null;
      if (decodeSafe(key) !== key || decodeSafe(value) !== value) return null;
      pairs.push(`${key}=${value}`);
    }
  }
  return { method: route.method, path: route.path, search: pairs.length ? `?${pairs.join('&')}` : '' };
}

// A refusal is the end of the conversation: the connection is closed with it, so a client never reuses a socket the
// proxy has already said no on.
const refusal = (res, status, message) => {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ error: `tess review proxy: ${message}` }));
};

export function createReviewProxy({ provider, key, token, upstream, accountId }) {
  const target = new URL(upstream || proxyProviders[provider]?.upstream || '');
  if (!/^https?:$/.test(target.protocol) || target.username || target.password) {
    throw new Error('the review proxy needs a plain http(s) upstream with no credentials in it');
  }
  const forward = target.protocol === 'http:' ? httpRequest : httpsRequest;
  const server = createServer((req, res) => {
    // A refusal drains the body it will not read before answering, so the client reads the refusal instead of a reset.
    const deny = (status, message) => { req.resume(); refusal(res, status, message); };
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      || String(req.headers['x-api-key'] || '');
    // Anything that is not this job's own token is refused before a byte is forwarded: the proxy is on loopback, but the
    // sandbox is not the only process that could find the port.
    if (!token || given !== token) {
      deny(401, 'not this review');
      return;
    }
    const route = matchProxyRoute(provider, req.method, req.url);
    if (!route) {
      // The method, the path and the query are all part of the route: a DELETE, a GET, a management path, a path trick
      // and an absolute-form request line all stop here, and none of them reaches the provider.
      deny(403, 'not a route a review uses');
      return;
    }
    if (!key) {
      deny(500, 'no credential');
      return;
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > maxProxyBodyBytes) {
      deny(413, 'request too large');
      return;
    }
    // The real credential is added here and any credential the request brought is dropped, so a client cannot choose
    // the key, and the host is the one this proxy was given, never one from the request line or its headers.
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.authorization;
    delete headers['x-api-key'];
    delete headers['proxy-authorization'];
    headers[proxyProviders[provider]?.header || 'authorization'] = `${proxyProviders[provider]?.scheme || 'Bearer '}${key}`;
    const accountHeader = proxyProviders[provider]?.accountHeader;
    if (accountHeader && accountId) headers[accountHeader] = accountId;
    Object.assign(headers, proxyProviders[provider]?.extraHeaders || {});
    headers.host = target.host;
    const up = forward({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      method: route.method,
      path: `${target.pathname.replace(/\/$/, '')}${route.path}${route.search}`,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    // A failed forward is the proxy's own failure, never the reviewer's answer: say so once, and keep the key out of it.
    let failed = false;
    up.on('error', (error) => {
      if (failed) return;
      failed = true;
      req.unpipe(up);
      if (res.headersSent) { res.end(); return; }
      deny(502, error.code || 'upstream failed');
    });
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      // A body with no honest content-length still cannot grow past the cap: the forward is cut, the rest is discarded,
      // and the client is told why instead of the proxy buffering it.
      if (size > maxProxyBodyBytes && !tooLarge) {
        tooLarge = true;
        req.unpipe(up);
        up.destroy();
        deny(413, 'request too large');
      }
    });
    req.pipe(up);
  });
  // A tunnel is how a proxy is asked to reach another host; this one only ever speaks to the upstream it was given.
  server.on('connect', (req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\n\r\n{"error":"tess review proxy: not a route a review uses"}');
  });
  server.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\n\r\n{"error":"tess review proxy: not a route a review uses"}');
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
    // underscores because a `-c` key is a dotted TOML path, where a bare key may not contain a hyphen. The base URL is
    // the proxy root with no `/v1`: on the ChatGPT plan the CLI appends `/responses` to whatever it is given, and the
    // proxy's only route is that path, forwarded to the plan backend's own `/responses`.
    const quote = (value) => JSON.stringify(value);
    return {
      env: { TESS_REVIEW_TOKEN: token },
      args: [
        '-c', `model_provider=${quote('tess_review_proxy')}`,
        '-c', `model_providers.tess_review_proxy.name=${quote('tess review proxy')}`,
        '-c', `model_providers.tess_review_proxy.base_url=${quote(base)}`,
        '-c', `model_providers.tess_review_proxy.env_key=${quote('TESS_REVIEW_TOKEN')}`,
        '-c', `model_providers.tess_review_proxy.wire_api=${quote('responses')}`,
      ],
      removedKeys: ['CODEX_AUTH_JSON', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
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
