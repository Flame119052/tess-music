#!/usr/bin/env node
// Exchange the ChatGPT-plan refresh token in CODEX_AUTH_JSON for a new access token.
// The scheduled workflow writes the result and uploads it. A refresh can rotate the refresh
// token, so a run that does not keep the new file would burn the only login the reviewer has.
// Nothing here prints a token, a refresh token, or an account id: the only lines are the old
// expiry and the new one, in UTC.
import { chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const openaiIssuer = 'https://auth.openai.com';
export const openaiTokenUrl = 'https://auth.openai.com/oauth/token';
// Public client id baked into the Codex CLI. Used only when the current access token
// does not carry one of its own. It identifies the app; it is not a secret.
export const fallbackClientId = 'app_EMoamEEZ73f0CkXaXp7hrann';

const dayMs = 24 * 60 * 60 * 1000;

export function jwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    return claims;
  } catch {
    return null;
  }
}

function clock(options) {
  if (typeof options.now === 'function') return options.now;
  return Date.now;
}

function clientIdOf(claims) {
  const id = claims.client_id;
  if (typeof id === 'string' && id.trim()) return id;
  return fallbackClientId;
}

function finiteExp(claims) {
  const exp = claims?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp;
}

// The stored login the workflow is allowed to refresh. Anything else fails before a request,
// so a bad file cannot be sent to the token endpoint.
export function readCodexLogin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('CODEX_AUTH_JSON is empty');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('CODEX_AUTH_JSON is not readable JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('CODEX_AUTH_JSON is not a JSON object');
  }
  if (data.auth_mode !== 'chatgpt') throw new Error('CODEX_AUTH_JSON is not a ChatGPT plan login');
  const tokens = data.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new Error('CODEX_AUTH_JSON holds no tokens');
  }
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw new Error('CODEX_AUTH_JSON holds no refresh token');
  }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new Error('CODEX_AUTH_JSON holds no access token');
  }
  const claims = jwtClaims(tokens.access_token);
  if (!claims) throw new Error('the stored Codex access token is not a readable JWT');
  if (claims.iss !== openaiIssuer) throw new Error('the stored Codex access token is not from auth.openai.com');
  const exp = finiteExp(claims);
  if (exp === null) throw new Error('the stored Codex access token has no readable expiry');
  return { data, clientId: clientIdOf(claims), expiresAt: exp * 1000 };
}

function refreshedTokens(previous, payload) {
  const tokens = { ...previous };
  tokens.access_token = payload.access_token;
  if (typeof payload.id_token === 'string' && payload.id_token) tokens.id_token = payload.id_token;
  if (typeof payload.refresh_token === 'string' && payload.refresh_token) {
    tokens.refresh_token = payload.refresh_token;
  }
  return tokens;
}

// `fetch` and `now` are injected so a test never calls OpenAI. `now` is a function, as in the
// Antigravity mint. The new access token has to be a JWT from auth.openai.com with a finite
// expiry at least a day ahead: a missing `exp` must not look like a long-lived token.
export async function refreshCodexAuth(raw, options = {}) {
  const login = readCodexLogin(raw);
  const now = clock(options);
  const at = now();
  const fetchImpl = options.fetch || globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(openaiTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: login.clientId,
        refresh_token: login.data.tokens.refresh_token,
      }),
    });
  } catch {
    throw new Error('could not refresh the Codex login');
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response || response.ok !== true) throw new Error('the Codex token endpoint refused the refresh');
  if (!payload || typeof payload !== 'object' || typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('the refreshed Codex login has no access token');
  }
  const claims = jwtClaims(payload.access_token);
  if (!claims) throw new Error('the refreshed Codex access token is not a readable JWT');
  if (claims.iss !== openaiIssuer) throw new Error('the refreshed Codex access token is not from auth.openai.com');
  const exp = finiteExp(claims);
  if (exp === null) throw new Error('the refreshed Codex access token has no readable expiry');
  const expiresAt = exp * 1000;
  if (expiresAt <= at) throw new Error('the refreshed Codex access token is already expired');
  if (expiresAt < at + dayMs) throw new Error('the refreshed Codex access token expires in under 24 hours');
  return {
    auth: {
      ...login.data,
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: refreshedTokens(login.data.tokens, payload),
      last_refresh: new Date(at).toISOString(),
    },
    previousExpiresAt: login.expiresAt,
    expiresAt,
  };
}

export function formatExpiry(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

export async function runCodexRefresh(options = {}) {
  const result = await refreshCodexAuth(options.raw, options);
  const text = `${JSON.stringify(result.auth)}\n`;
  if (options.write) {
    writeFileSync(options.write, text, { mode: 0o600 });
    try { chmodSync(options.write, 0o600); } catch { /* the mode on write is the one that matters */ }
  }
  const say = options.log || ((line) => console.log(line));
  say(`Previous expiry ${formatExpiry(result.previousExpiresAt)}. New expiry ${formatExpiry(result.expiresAt)}.`);
  return result;
}

function writePath(argv) {
  let write = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--write') throw new Error('codex-refresh: unknown argument');
    write = argv[i + 1] || '';
    i += 1;
    if (!write || write.startsWith('--')) throw new Error('codex-refresh: --write needs a path');
  }
  if (!write) throw new Error('codex-refresh: --write needs a path');
  return write;
}

function runningAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

const knownErrors = new Set([
  'CODEX_AUTH_JSON is empty',
  'CODEX_AUTH_JSON is not readable JSON',
  'CODEX_AUTH_JSON is not a JSON object',
  'CODEX_AUTH_JSON is not a ChatGPT plan login',
  'CODEX_AUTH_JSON holds no tokens',
  'CODEX_AUTH_JSON holds no refresh token',
  'CODEX_AUTH_JSON holds no access token',
  'the stored Codex access token is not a readable JWT',
  'the stored Codex access token is not from auth.openai.com',
  'the stored Codex access token has no readable expiry',
  'could not refresh the Codex login',
  'the Codex token endpoint refused the refresh',
  'the refreshed Codex login has no access token',
  'the refreshed Codex access token is not a readable JWT',
  'the refreshed Codex access token is not from auth.openai.com',
  'the refreshed Codex access token has no readable expiry',
  'the refreshed Codex access token is already expired',
  'the refreshed Codex access token expires in under 24 hours',
]);

if (runningAsScript()) {
  const raw = process.env.CODEX_AUTH_JSON;
  let write;
  try {
    write = writePath(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'codex-refresh: --write needs a path');
    process.exit(1);
  }
  runCodexRefresh({ raw, write }).catch((error) => {
    const message = error instanceof Error ? error.message : '';
    // Print only fixed sentences this module throws so a runtime/parser error can never echo any slice of a secret.
    console.error(knownErrors.has(message) ? message : 'could not refresh the Codex login');
    process.exit(1);
  });
}
