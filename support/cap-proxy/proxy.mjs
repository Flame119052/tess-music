// Daily-cap and credential-isolating proxy for the Tess support bot.
//
// Runs as its own dedicated system user (`tess-cap`) under `tess-cap.service`, separate from the bot user
// (`tess-support`). Holds the real `OPENCODE_GO_API_KEY` in `tess-cap`-owned `.env` (mode 600) and stores cap state
// inside `tess-cap`'s own `StateDirectory=/var/lib/tess-cap` (`0700`). Because `tess-support` only receives a local
// proxy bearer token (`TESS_CAP_PROXY_TOKEN`) and never holds `OPENCODE_GO_API_KEY` or write access to cap state, a
// compromised bot tool loop cannot read the owner's OpenCode Go key or reset its own daily cap.
//
// Route & host allowlist follows `tools/review-proxy.mjs`: only `POST /v1/chat/completions` on loopback (or a dedicated
// Unix socket) is accepted; `CONNECT`, `Upgrade`, other methods/paths, path tricks, and non-loopback `Host` headers
// are refused before any credential is attached.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_UPSTREAM = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_LISTEN_HOST = '127.0.0.1';
export const DEFAULT_LISTEN_PORT = 4193;
export const DEFAULT_DAILY_REPLY_CAP = 40;
export const DEFAULT_DAILY_USER_CAP = 20;
export const DEFAULT_DAILY_TOKEN_CAP = 0;
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_USAGE_CAPTURE_BYTES = 2 * 1024 * 1024;
export const MAX_SSE_LINE_BYTES = 512 * 1024;
export const UPSTREAM_TIMEOUT_MS = 120 * 1000;

const TG_ID_RE = /^\d{5,15}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_TG_RE = /(?:^|:)telegram:(?:dm:)?(\d{5,15})(?:$|:)/;
const BODY_TG_RE = /^(?:telegram:(?:dm:)?)?(\d{5,15})$/;

const HOP_BY_HOP_AND_IDENTITY_HEADERS = [
  'host',
  'authorization',
  'x-api-key',
  'proxy-authorization',
  'proxy-connection',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'forwarded',
  'x-real-ip',
  'x-tess-user-id',
  'x-telegram-user-id',
  'accept-encoding',
];

const decodeSafe = (value) => {
  try { return decodeURIComponent(value); } catch { return null; }
};

export function isLoopbackHost(host) {
  const clean = String(host || '').trim().toLowerCase();
  return clean === '127.0.0.1' || clean === '::1' || clean === '[::1]' || clean === 'localhost';
}

export function isAllowedIncomingHostHeader(rawHost) {
  if (Array.isArray(rawHost)) return false;
  const host = String(rawHost || '').trim().toLowerCase();
  if (!host) return false;
  if (/[\s/@,\\]/.test(host)) return false;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return false;
    const inside = host.slice(1, end);
    const rest = host.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return false;
    return inside === '::1';
  }
  const colon = host.indexOf(':');
  const name = colon === -1 ? host : host.slice(0, colon);
  const port = colon === -1 ? '' : host.slice(colon + 1);
  if (port && !/^\d{1,5}$/.test(port)) return false;
  return name === '127.0.0.1' || name === 'localhost';
}

// Strict route allowlist modeled on tools/review-proxy.mjs: only `POST /v1/chat/completions` with no query string,
// fragment, dot segments, double slashes, backslashes, percent-escapes, or absolute-form URLs.
export function matchCapRoute(method, rawUrl) {
  if (String(method || '').toUpperCase() !== 'POST') return null;
  const url = String(rawUrl || '');
  if (url !== '/v1/chat/completions') return null;
  if (url.includes('#') || url.includes('?') || url.includes('\\') || url.includes('//')) return null;
  if (url.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  if (decodeSafe(url) !== url) return null;
  return { method: 'POST', path: '/v1/chat/completions', upstreamSuffix: '/chat/completions' };
}

export function timingSafeTokenMatch(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string' || !expected || !actual) return false;
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(actual, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function extractBearerOrApiKey(headers) {
  const authHeader = headers?.authorization;
  if (Array.isArray(authHeader)) return '';
  const auth = String(authHeader || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (match) return match[1].trim();
  const apiKey = headers?.['x-api-key'];
  if (Array.isArray(apiKey)) return '';
  return String(apiKey || '').trim();
}

export function extractTelegramUserId(headers, bodyObj) {
  for (const name of ['x-tess-user-id', 'x-telegram-user-id']) {
    const raw = headers?.[name];
    if (raw !== undefined) {
      if (Array.isArray(raw)) return { ok: false, error: `invalid ${name} header` };
      const val = String(raw).trim();
      if (!TG_ID_RE.test(val)) return { ok: false, error: `invalid ${name} header` };
      return { ok: true, userId: val };
    }
  }
  const bodyUser = bodyObj?.user;
  if (typeof bodyUser === 'number' && Number.isSafeInteger(bodyUser)) {
    const s = String(bodyUser);
    if (TG_ID_RE.test(s)) return { ok: true, userId: s };
  } else if (typeof bodyUser === 'string') {
    const m = BODY_TG_RE.exec(bodyUser.trim());
    if (m) return { ok: true, userId: m[1] };
  }
  const sessionHeader = headers?.['x-opencode-session'];
  if (typeof sessionHeader === 'string') {
    const m = SESSION_TG_RE.exec(sessionHeader.trim());
    if (m) return { ok: true, userId: m[1] };
  }
  return { ok: true, userId: null };
}

export function extractTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return 0;
  const total = usage.total_tokens;
  if (Number.isSafeInteger(total) && total > 0) return total;
  const inRaw = Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : usage.prompt_tokens;
  const outRaw = Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : usage.completion_tokens;
  const inTok = Number.isSafeInteger(inRaw) && inRaw > 0 ? inRaw : 0;
  const outTok = Number.isSafeInteger(outRaw) && outRaw > 0 ? outRaw : 0;
  const sum = inTok + outTok;
  return Number.isSafeInteger(sum) && sum > 0 ? sum : 0;
}

export function createSseUsageTracker() {
  let remainder = '';
  let maxTokens = 0;
  let corrupted = false;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.usage) {
      const tok = extractTokensFromUsage(obj.usage);
      if (tok > maxTokens) maxTokens = tok;
    }
  };

  return {
    push(chunk) {
      if (corrupted) return;
      remainder += chunk.toString('utf8');
      if (Buffer.byteLength(remainder, 'utf8') > MAX_SSE_LINE_BYTES) {
        const lastNl = remainder.lastIndexOf('\n');
        if (lastNl === -1) {
          remainder = '';
          corrupted = true;
          return;
        }
      }
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    },
    finish() {
      if (!corrupted && remainder) processLine(remainder);
      remainder = '';
      return maxTokens;
    },
  };
}

export function parseUpstreamJsonTokens(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    return extractTokensFromUsage(parsed.usage);
  } catch {
    return 0;
  }
}

function parseNonNegativeInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`cap setting must be a non-negative integer, got "${s}"`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`cap setting out of range: "${s}"`);
  }
  return n;
}

function currentUtcDate(todayOverride) {
  if (todayOverride) {
    if (!DATE_RE.test(todayOverride)) throw new Error(`invalid UTC date override: ${todayOverride}`);
    return todayOverride;
  }
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilNextUtcMidnight(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

function freshState(today) {
  return { date: today, replies: 0, tokens: 0, users: {} };
}

function validateAndNormalizeState(rawObj, today) {
  if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
    throw new Error('cap state must be a JSON object');
  }
  if (typeof rawObj.date !== 'string' || !DATE_RE.test(rawObj.date)) {
    throw new Error('cap state missing valid YYYY-MM-DD date');
  }
  if (rawObj.date !== today) {
    return freshState(today);
  }
  if (!Number.isSafeInteger(rawObj.replies) || rawObj.replies < 0) {
    throw new Error('cap state has invalid replies count');
  }
  if (!Number.isSafeInteger(rawObj.tokens) || rawObj.tokens < 0) {
    throw new Error('cap state has invalid tokens count');
  }
  const usersRaw = rawObj.users ?? {};
  if (!usersRaw || typeof usersRaw !== 'object' || Array.isArray(usersRaw)) {
    throw new Error('cap state has invalid users map');
  }
  const users = Object.create(null);
  for (const [uid, count] of Object.entries(usersRaw)) {
    if (!TG_ID_RE.test(uid) || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('cap state has invalid user counter');
    }
    users[uid] = count;
  }
  return { date: rawObj.date, replies: rawObj.replies, tokens: rawObj.tokens, users };
}

function assertSafeStateDir(dirPath) {
  let st;
  try {
    st = lstatSync(dirPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      mkdirSync(dirPath, { recursive: true, mode: 0o700 });
      st = lstatSync(dirPath);
    } else {
      throw err;
    }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing non-directory state directory: ${dirPath}`);
  }
}

function readStateStrict(statePath, today) {
  const dirPath = dirname(statePath);
  assertSafeStateDir(dirPath);
  let lst;
  try {
    lst = lstatSync(statePath);
  } catch (err) {
    if (err.code === 'ENOENT') return freshState(today);
    throw err;
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw new Error(`refusing non-regular cap state file: ${statePath}`);
  }
  if (lst.nlink !== 1) {
    throw new Error(`refusing hardlinked cap state file: ${statePath}`);
  }
  const nofollow = fsConstants.O_NOFOLLOW || 0;
  const fd = openSync(statePath, fsConstants.O_RDONLY | nofollow);
  let raw;
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.nlink !== 1 || fst.dev !== lst.dev || fst.ino !== lst.ino) {
      throw new Error(`cap state file changed during open: ${statePath}`);
    }
    raw = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  const parsed = JSON.parse(raw);
  return validateAndNormalizeState(parsed, today);
}

function writeStateAtomic(statePath, state) {
  const dirPath = dirname(statePath);
  assertSafeStateDir(dirPath);
  try {
    const existing = lstatSync(statePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`refusing to overwrite non-regular cap state file: ${statePath}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const tmpName = `.daily-cap-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  const tmpPath = join(dirPath, tmpName);
  const nofollow = fsConstants.O_NOFOLLOW || 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | nofollow;
  const payload = `${JSON.stringify({
    date: state.date,
    replies: state.replies,
    tokens: state.tokens,
    users: Object.fromEntries(Object.entries(state.users).sort(([a], [b]) => a.localeCompare(b))),
  })}\n`;

  const fd = openSync(tmpPath, flags, 0o600);
  try {
    writeSync(fd, payload, 0, 'utf8');
    fsyncSync(fd);
  } catch (err) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmpPath, statePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function validateUpstreamUrl(upstream, { allowAnyUpstream = false } = {}) {
  let target;
  try {
    target = new URL(upstream || DEFAULT_UPSTREAM);
  } catch {
    throw new Error(`invalid cap proxy upstream URL: ${upstream}`);
  }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('cap proxy upstream must be a plain http(s) URL with no credentials, query, or hash');
  }
  if (!allowAnyUpstream) {
    const isTestLoopback = process.env.TESS_TEST === '1' && isLoopbackHost(target.hostname);
    if (!isTestLoopback && (target.protocol !== 'https:' || target.hostname.toLowerCase() !== 'opencode.ai')) {
      throw new Error('cap proxy production upstream must be https://opencode.ai/...');
    }
  }
  return target;
}

const jsonResponse = (res, status, bodyObj, extraHeaders = {}) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    connection: 'close',
    ...extraHeaders,
  });
  res.end(JSON.stringify(bodyObj));
};

export async function createCapProxy({
  apiKey,
  token,
  upstream = DEFAULT_UPSTREAM,
  allowAnyUpstream = false,
  listenHost = DEFAULT_LISTEN_HOST,
  listenPort = DEFAULT_LISTEN_PORT,
  socketPath = '',
  socketMode = 0o660,
  statePath,
  replyCap = DEFAULT_DAILY_REPLY_CAP,
  userCap = DEFAULT_DAILY_USER_CAP,
  tokenCap = DEFAULT_DAILY_TOKEN_CAP,
  todayOverride = '',
  nowUtcDate,
} = {}) {
  const target = validateUpstreamUrl(upstream, { allowAnyUpstream });
  if (!socketPath && !isLoopbackHost(listenHost)) {
    throw new Error(`cap proxy must bind only to loopback, refusing "${listenHost}"`);
  }
  if (!token || typeof token !== 'string') {
    throw new Error('cap proxy requires TESS_CAP_PROXY_TOKEN');
  }
  if (!statePath || typeof statePath !== 'string') {
    throw new Error('cap proxy requires statePath');
  }
  const normalizedReplyCap = parseNonNegativeInt(replyCap, DEFAULT_DAILY_REPLY_CAP);
  const normalizedUserCap = parseNonNegativeInt(userCap, DEFAULT_DAILY_USER_CAP);
  const normalizedTokenCap = parseNonNegativeInt(tokenCap, DEFAULT_DAILY_TOKEN_CAP);
  const forward = target.protocol === 'http:' ? httpRequest : httpsRequest;

  // Serialize every read-modify-write cycle on the cap state file.
  let lockChain = Promise.resolve();
  const withStateLock = (fn) => {
    const run = lockChain.then(fn, fn);
    lockChain = run.catch(() => {});
    return run;
  };

  const getToday = () => {
    if (typeof nowUtcDate === 'function') return currentUtcDate(nowUtcDate());
    if (todayOverride) return currentUtcDate(todayOverride);
    if (process.env.TESS_TEST === '1' && process.env.TESS_CAP_TODAY) {
      return currentUtcDate(process.env.TESS_CAP_TODAY.trim());
    }
    return currentUtcDate('');
  };

  const server = createServer((req, res) => {
    const deny = (status, code, message, type = 'proxy_error', extra = {}) => {
      req.resume();
      jsonResponse(res, status, { error: { message, type, code, ...extra } });
    };

    if (!socketPath && !isAllowedIncomingHostHeader(req.headers.host)) {
      deny(403, 'forbidden_host', 'tess cap proxy: forbidden Host header');
      return;
    }

    const given = extractBearerOrApiKey(req.headers);
    if (!timingSafeTokenMatch(token, given)) {
      deny(401, 'invalid_proxy_token', 'tess cap proxy: invalid proxy token', 'authentication_error');
      return;
    }

    const route = matchCapRoute(req.method, req.url);
    if (!route) {
      deny(403, 'forbidden_route', 'tess cap proxy: route or method is not allowed');
      return;
    }

    if (!apiKey || typeof apiKey !== 'string') {
      deny(500, 'missing_upstream_key', 'tess cap proxy: upstream credential not configured', 'server_error');
      return;
    }

    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      deny(413, 'request_too_large', 'tess cap proxy: request too large');
      return;
    }

    const chunks = [];
    let bodyBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        aborted = true;
        deny(413, 'request_too_large', 'tess cap proxy: request too large');
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      aborted = true;
      if (!res.headersSent) jsonResponse(res, 400, { error: { message: 'tess cap proxy: bad request stream', type: 'invalid_request_error', code: 'bad_request' } });
    });

    req.on('end', async () => {
      if (aborted) return;
      const bodyBuf = Buffer.concat(chunks);
      let bodyObj;
      try {
        bodyObj = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        jsonResponse(res, 400, { error: { message: 'tess cap proxy: body must be valid JSON', type: 'invalid_request_error', code: 'invalid_json' } });
        return;
      }
      if (!bodyObj || typeof bodyObj !== 'object' || Array.isArray(bodyObj)) {
        jsonResponse(res, 400, { error: { message: 'tess cap proxy: body must be a JSON object', type: 'invalid_request_error', code: 'invalid_json' } });
        return;
      }

      const tgRes = extractTelegramUserId(req.headers, bodyObj);
      if (!tgRes.ok) {
        jsonResponse(res, 400, { error: { message: `tess cap proxy: ${tgRes.error}`, type: 'invalid_request_error', code: 'invalid_user_id' } });
        return;
      }
      const tgUserId = tgRes.userId;

      let gate;
      try {
        gate = await withStateLock(() => {
          const today = getToday();
          const state = readStateStrict(statePath, today);
          if (normalizedTokenCap > 0 && state.tokens >= normalizedTokenCap) {
            return { allowed: false, limitType: 'token' };
          }
          if (state.replies >= normalizedReplyCap) {
            return { allowed: false, limitType: 'global' };
          }
          if (tgUserId) {
            const userCount = state.users[tgUserId] || 0;
            if (userCount >= normalizedUserCap) {
              return { allowed: false, limitType: 'user' };
            }
            state.users[tgUserId] = userCount + 1;
          }
          state.replies += 1;
          writeStateAtomic(statePath, state);
          return { allowed: true, today };
        });
      } catch {
        jsonResponse(res, 503, {
          error: {
            message: 'Daily usage check failed closed; support bot is paused until checked or 00:00 UTC.',
            type: 'cap_state_error',
            code: 'cap_state_unavailable',
          },
        });
        return;
      }

      if (!gate.allowed) {
        const resetsIn = secondsUntilNextUtcMidnight();
        const prefix =
          gate.limitType === 'user'
            ? "You've reached today's message limit for this bot"
            : gate.limitType === 'token'
              ? "I've reached today's token usage limit"
              : "I've reached today's reply limit";
        jsonResponse(
          res,
          429,
          {
            error: {
              message: `${prefix} (resets_in_seconds: ${resetsIn}). Please try again tomorrow after 00:00 UTC.`,
              type: 'usage_limit_reached',
              code: 'terminal_quota_exhausted',
              resets_in_seconds: resetsIn,
              limit_type: gate.limitType,
            },
          },
          { 'retry-after': String(resetsIn) },
        );
        return;
      }

      const headers = { ...req.headers };
      for (const h of HOP_BY_HOP_AND_IDENTITY_HEADERS) delete headers[h];
      headers.authorization = `Bearer ${apiKey}`;
      headers.host = target.host;
      headers['content-length'] = String(bodyBuf.length);
      if (!headers['content-type']) headers['content-type'] = 'application/json';

      const upstreamPath = `${target.pathname.replace(/\/$/, '')}${route.upstreamSuffix}`;
      const up = forward(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === 'http:' ? 80 : 443),
          method: route.method,
          path: upstreamPath,
          headers,
          timeout: UPSTREAM_TIMEOUT_MS,
        },
        (upstreamRes) => {
          const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase();
          const isSse = contentType.includes('text/event-stream');
          const sseTracker = isSse ? createSseUsageTracker() : null;
          const jsonChunks = [];
          let capturedBytes = 0;
          let captureOverflow = false;

          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);

          upstreamRes.on('data', (chunk) => {
            res.write(chunk);
            if (sseTracker) {
              sseTracker.push(chunk);
            } else if (!captureOverflow) {
              capturedBytes += chunk.length;
              if (capturedBytes <= MAX_USAGE_CAPTURE_BYTES) {
                jsonChunks.push(chunk);
              } else {
                captureOverflow = true;
                jsonChunks.length = 0;
              }
            }
          });

          upstreamRes.on('end', () => {
            res.end();
            let tokens = 0;
            if (sseTracker) {
              tokens = sseTracker.finish();
            } else if (!captureOverflow && jsonChunks.length > 0) {
              tokens = parseUpstreamJsonTokens(Buffer.concat(jsonChunks).toString('utf8'));
            }
            if (Number.isSafeInteger(tokens) && tokens > 0) {
              withStateLock(() => {
                try {
                  const st = readStateStrict(statePath, gate.today);
                  st.tokens += tokens;
                  writeStateAtomic(statePath, st);
                } catch {
                  // Never throw or reset state if recording post-response tokens fails.
                }
              });
            }
          });

          upstreamRes.on('aborted', () => {
            if (!res.writableEnded) res.end();
          });

          upstreamRes.on('error', () => {
            if (!res.writableEnded) res.end();
          });
        },
      );

      let failed = false;
      up.on('timeout', () => {
        up.destroy(new Error('upstream timeout'));
      });
      up.on('error', () => {
        if (failed) return;
        failed = true;
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        jsonResponse(res, 502, {
          error: {
            message: 'tess cap proxy: upstream request failed',
            type: 'upstream_error',
            code: 'upstream_failed',
          },
        });
      });
      up.end(bodyBuf);
    });
  });

  server.on('connect', (_req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\n\r\n{"error":{"message":"tess cap proxy: CONNECT not allowed","code":"forbidden_route"}}');
  });
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\n\r\n{"error":{"message":"tess cap proxy: Upgrade not allowed","code":"forbidden_route"}}');
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    const onListening = () => {
      server.removeListener('error', rejectPromise);
      if (socketPath) {
        try {
          const st = lstatSync(socketPath);
          if (st.isSymbolicLink() || !st.isSocket()) {
            server.close(() => rejectPromise(new Error(`refusing non-socket at ${socketPath}`)));
            return;
          }
          const modeVal = Number(socketMode);
          if (Number.isInteger(modeVal)) {
            chmodSync(socketPath, modeVal);
            const verify = lstatSync(socketPath);
            if (verify.isSymbolicLink() || !verify.isSocket() || (verify.mode & 0o777) !== modeVal) {
              server.close(() => rejectPromise(new Error(`socket verification failed at ${socketPath}`)));
              return;
            }
          }
          resolvePromise({
            url: `unix://${socketPath}`,
            socketPath,
            close: () => new Promise((done) => server.close(() => {
              try {
                const cur = lstatSync(socketPath);
                if (!cur.isSymbolicLink() && cur.isSocket()) unlinkSync(socketPath);
              } catch {}
              done();
            })),
          });
          return;
        } catch (err) {
          server.close(() => rejectPromise(err));
          return;
        }
      }
      const addr = server.address();
      resolvePromise({
        url: `http://${addr.address === '::1' ? '[::1]' : addr.address}:${addr.port}`,
        port: addr.port,
        close: () => new Promise((done) => server.close(done)),
      });
    };

    if (socketPath) {
      try {
        const existing = lstatSync(socketPath);
        if (existing.isSymbolicLink() || !existing.isSocket()) {
          rejectPromise(new Error(`refusing to replace non-socket path: ${socketPath}`));
          return;
        }
        unlinkSync(socketPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          rejectPromise(err);
          return;
        }
      }
      server.listen(socketPath, onListening);
    } else {
      server.listen(listenPort, listenHost, onListening);
    }
  });
}

export function parseEnvFile(text) {
  const out = Object.create(null);
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadFallbackEnvFile() {
  const explicit = String(process.env.TESS_CAP_ENV_FILE || '').trim();
  const candidates = explicit ? [explicit] : [resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')];
  for (const envPath of candidates) {
    try {
      const lst = lstatSync(envPath);
      if (lst.isSymbolicLink() || !lst.isFile() || lst.nlink !== 1) continue;
      const vars = parseEnvFile(readFileSync(envPath, 'utf8'));
      for (const [k, v] of Object.entries(vars)) {
        if (!(k in process.env)) process.env[k] = v;
      }
      return;
    } catch {
      // Optional when EnvironmentFile= already loaded vars into process.env.
    }
  }
}

function resolveStatePathFromEnv() {
  const explicit = String(process.env.TESS_CAP_STATE_FILE || '').trim();
  if (explicit) return explicit;
  const stateDir = String(process.env.STATE_DIRECTORY || '').split(':', 1)[0].trim();
  if (stateDir) return join(stateDir, 'daily-cap.json');
  const capHome = String(process.env.HOME || '').trim() || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return join(capHome, 'state', 'daily-cap.json');
}

function main() {
  loadFallbackEnvFile();
  const apiKey = String(process.env.OPENCODE_GO_API_KEY || '');
  const token = String(process.env.TESS_CAP_PROXY_TOKEN || '');
  const upstream = String(process.env.TESS_CAP_UPSTREAM || DEFAULT_UPSTREAM).trim() || DEFAULT_UPSTREAM;
  const listenHost = String(process.env.TESS_CAP_LISTEN_HOST || DEFAULT_LISTEN_HOST).trim() || DEFAULT_LISTEN_HOST;
  const portRaw = String(process.env.TESS_CAP_LISTEN_PORT ?? DEFAULT_LISTEN_PORT).trim();
  const listenPort = /^\d+$/.test(portRaw) ? Number(portRaw) : DEFAULT_LISTEN_PORT;
  const socketPath = String(process.env.TESS_CAP_SOCKET || '').trim();
  const statePath = resolveStatePathFromEnv();
  const replyCap = parseNonNegativeInt(process.env.TESS_DAILY_REPLY_CAP, DEFAULT_DAILY_REPLY_CAP);
  const userCap = parseNonNegativeInt(process.env.TESS_DAILY_USER_CAP, DEFAULT_DAILY_USER_CAP);
  const tokenCap = parseNonNegativeInt(process.env.TESS_DAILY_TOKEN_CAP, DEFAULT_DAILY_TOKEN_CAP);

  createCapProxy({
    apiKey,
    token,
    upstream,
    listenHost,
    listenPort,
    socketPath,
    statePath,
    replyCap,
    userCap,
    tokenCap,
  }).then((proxy) => {
    const readyFile = String(process.env.TESS_CAP_READY_FILE || '').trim();
    if (readyFile && process.env.TESS_TEST === '1') {
      const nofollow = fsConstants.O_NOFOLLOW || 0;
      const fd = openSync(readyFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | nofollow, 0o600);
      try { writeSync(fd, proxy.url, 0, 'utf8'); } finally { closeSync(fd); }
    }
    const stop = () => { proxy.close().then(() => process.exit(0)); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((error) => {
    console.error(`tess cap proxy failed to start: ${error.message}`);
    process.exit(1);
  });
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
