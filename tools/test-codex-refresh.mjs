// The scheduled Codex login refresh, without calling OpenAI or GitHub.
// Usage: node tools/test-codex-refresh.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  fallbackClientId,
  openaiIssuer,
  openaiTokenUrl,
  refreshCodexAuth,
  runCodexRefresh,
} from './codex-refresh.mjs';

const scriptPath = fileURLToPath(new URL('./codex-refresh.mjs', import.meta.url));
const now = Date.parse('2026-11-21T06:00:00.000Z');
const day = 24 * 60 * 60;

const refreshOld = 'refresh-old-SENTINEL-9f3a';
const refreshNew = 'refresh-new-SENTINEL-9f3a';
const accountId = 'acct-SENTINEL-9f3a';
const idOld = 'id-old-SENTINEL-9f3a';
const idNew = 'id-new-SENTINEL-9f3a';
const ownerId = 'owner-SENTINEL-9f3a';
const apiKey = 'sk-SENTINEL-9f3a';

function jwt(claims) {
  return `hdr.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
}

function access(expSeconds, extra = {}) {
  return jwt({
    iss: openaiIssuer,
    exp: expSeconds,
    client_id: 'app_from_token',
    ...extra,
  });
}

function login(accessToken, extraTokens = {}) {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshOld,
      account_id: accountId,
      id_token: idOld,
      oauth_provenance: 'chatgpt-web',
      login_owner_id: ownerId,
      ...extraTokens,
    },
    last_refresh: '2026-11-01T00:00:00.000Z',
    extra: 'kept',
  });
}

function tokenResponse(claims, extra = {}) {
  return {
    access_token: jwt({ iss: openaiIssuer, client_id: 'app_from_token', ...claims }),
    ...extra,
  };
}

function fetchOk(payload, seen) {
  return async (url, init) => {
    if (seen) seen.push({ url, init });
    return { ok: true, status: 200, json: async () => payload };
  };
}

const oldExp = Math.floor(now / 1000) + 2 * day;
const newExp = Math.floor(now / 1000) + 10 * day;
const secrets = [refreshOld, refreshNew, accountId, idOld, idNew, ownerId, apiKey];

function assertNoSecrets(text, label) {
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `${label} contains ${secret}`);
  }
}

test('a refresh rotates the refresh token and keeps the login fields', async () => {
  const seen = [];
  const raw = login(access(oldExp));
  const result = await refreshCodexAuth(raw, {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp: newExp }, { refresh_token: refreshNew, id_token: idNew }), seen),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, openaiTokenUrl);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(seen[0].init.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('client_id'), 'app_from_token');
  assert.equal(body.get('refresh_token'), refreshOld);
  assert.equal(result.auth.auth_mode, 'chatgpt');
  assert.equal(result.auth.OPENAI_API_KEY, null);
  assert.equal(result.auth.extra, 'kept');
  assert.equal(result.auth.tokens.access_token, tokenResponse({ exp: newExp }).access_token);
  assert.equal(result.auth.tokens.refresh_token, refreshNew);
  assert.equal(result.auth.tokens.id_token, idNew);
  assert.equal(result.auth.tokens.account_id, accountId);
  assert.equal(result.auth.tokens.oauth_provenance, 'chatgpt-web');
  assert.equal(result.auth.tokens.login_owner_id, ownerId);
  assert.equal(result.auth.last_refresh, '2026-11-21T06:00:00.000Z');
  assert.equal(result.previousExpiresAt, oldExp * 1000);
  assert.equal(result.expiresAt, newExp * 1000);
});

test('a response with no new refresh token or id token keeps the previous ones', async () => {
  const result = await refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp: newExp })),
  });
  assert.equal(result.auth.tokens.refresh_token, refreshOld);
  assert.equal(result.auth.tokens.id_token, idOld);
});

test('an empty rotated token is not treated as a rotation', async () => {
  const result = await refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp: newExp }, { refresh_token: '', id_token: '' })),
  });
  assert.equal(result.auth.tokens.refresh_token, refreshOld);
  assert.equal(result.auth.tokens.id_token, idOld);
});

test('a missing client id falls back to the public Codex client id', async () => {
  const seen = [];
  await refreshCodexAuth(login(access(oldExp, { client_id: '  ' })), {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp: newExp }), seen),
  });
  assert.equal(new URLSearchParams(seen[0].init.body).get('client_id'), fallbackClientId);
});

test('an API key login is refused before any request', async () => {
  let called = false;
  const raw = JSON.stringify({
    auth_mode: 'apikey',
    OPENAI_API_KEY: apiKey,
    tokens: { access_token: access(oldExp), refresh_token: refreshOld, account_id: accountId },
  });
  await assert.rejects(refreshCodexAuth(raw, {
    now: () => now,
    fetch: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  }), /not a ChatGPT plan login/);
  assert.equal(called, false);
});

test('a stored token from another issuer is refused before any request', async () => {
  let called = false;
  await assert.rejects(refreshCodexAuth(login(access(oldExp, { iss: 'https://evil.example' })), {
    now: () => now,
    fetch: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  }), /stored Codex access token is not from auth\.openai\.com/);
  assert.equal(called, false);
});

test('a refreshed token from another issuer is refused', async () => {
  await assert.rejects(refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp: newExp, iss: 'https://evil.example' }, { refresh_token: refreshNew })),
  }), /refreshed Codex access token is not from auth\.openai\.com/);
});

test('a non-finite, missing, or non-numeric expiry is refused', async () => {
  for (const claims of [{ exp: null }, { exp: 'soon' }, {}]) {
    await assert.rejects(refreshCodexAuth(login(access(oldExp)), {
      now: () => now,
      fetch: fetchOk({ access_token: jwt({ iss: openaiIssuer, ...claims }) }),
    }), /no readable expiry/);
  }
});

test('an already expired token and one inside 24 hours are refused', async () => {
  await assert.rejects(refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp: Math.floor(now / 1000) })),
  }), /already expired/);
  await assert.rejects(refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp: Math.floor(now / 1000) - 5 })),
  }), /already expired/);
  await assert.rejects(refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp: Math.floor(now / 1000) + day - 1 })),
  }), /under 24 hours/);
});

test('a token that expires exactly 24 hours out is accepted', async () => {
  const exp = Math.floor(now / 1000) + day;
  const result = await refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp })),
  });
  assert.equal(result.expiresAt, exp * 1000);
});

test('a stored access token can already be expired: the refresh token is what matters', async () => {
  const expiredAccess = access(Math.floor(now / 1000) - day);
  const result = await refreshCodexAuth(login(expiredAccess), {
    now: () => now,
    fetch: fetchOk(tokenResponse({ exp: newExp }, { refresh_token: refreshNew })),
  });
  assert.equal(result.auth.tokens.refresh_token, refreshNew);
});

test('an HTTP error, a missing token, and a token that is not a JWT all refuse', async () => {
  await assert.rejects(refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: refreshOld, refresh_token: refreshNew }) }),
  }), /refused the refresh/);
  await assert.rejects(refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ refresh_token: refreshNew }) }),
  }), /no access token/);
  await assert.rejects(refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'not-a-jwt' }) }),
  }), /not a readable JWT/);
  await assert.rejects(refreshCodexAuth(login(access(oldExp)), {
    now: () => now,
    fetch: async () => { throw new Error(`network ${refreshOld}`); },
  }), /could not refresh the Codex login/);
});

test('stdout and stderr name the expiries and none of the secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-'));
  const path = join(dir, 'auth.json');
  const lines = [];
  try {
    const raw = login(access(oldExp), {});
    const withKey = JSON.parse(raw);
    withKey.OPENAI_API_KEY = apiKey;
    await runCodexRefresh({
      raw: JSON.stringify(withKey),
      write: path,
      now: () => now,
      log: (line) => lines.push(line),
      fetch: fetchOk(tokenResponse({ exp: newExp }, { refresh_token: refreshNew, id_token: idNew })),
    });
    const written = readFileSync(path, 'utf8');
    const parsed = JSON.parse(written);
    assert.equal(parsed.OPENAI_API_KEY, null);
    assert.equal(parsed.tokens.refresh_token, refreshNew);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const spoken = lines.join('\n');
    assert.match(spoken, /Previous expiry 2026-11-23 06:00:00\.000 UTC/);
    assert.match(spoken, /New expiry 2026-12-01 06:00:00\.000 UTC/);
    assertNoSecrets(spoken, 'success output');
    assert.equal(spoken.includes(parsed.tokens.access_token), false);

    lines.length = 0;
    await assert.rejects(runCodexRefresh({
      raw: login(access(oldExp)),
      now: () => now,
      log: (line) => lines.push(line),
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: refreshOld, account_id: accountId, access_token: idNew }),
      }),
    }), (error) => {
      assert.match(error.message, /refused the refresh/);
      assertNoSecrets(error.message, 'failure error');
      return true;
    });
    assert.equal(lines.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command fails closed without printing the login', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-cli-'));
  const path = join(dir, 'auth.json');
  const raw = `not-json ${refreshOld} ${accountId} ${apiKey}`;
  try {
    const result = spawnSync(process.execPath, [scriptPath, '--write', path], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_AUTH_JSON: raw },
    });
    assert.equal(result.status, 1);
    assertNoSecrets(`${result.stdout}${result.stderr}`, 'cli output');
    assert.match(result.stderr, /not readable JSON/);
    assert.equal(result.stdout, '');

    const noWrite = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_AUTH_JSON: login(access(oldExp)) },
    });
    assert.equal(noWrite.status, 1);
    assert.match(noWrite.stderr, /--write needs a path/);
    assertNoSecrets(`${noWrite.stdout}${noWrite.stderr}`, 'cli usage');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a loose file mode is tightened to 0600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-refresh-mode-'));
  const path = join(dir, 'auth.json');
  try {
    chmodSync(dir, 0o700);
    await runCodexRefresh({
      raw: login(access(oldExp)),
      write: path,
      now: () => now,
      log: () => {},
      fetch: fetchOk(tokenResponse({ exp: newExp })),
    });
    chmodSync(path, 0o644);
    await runCodexRefresh({
      raw: login(access(oldExp)),
      write: path,
      now: () => now,
      log: () => {},
      fetch: fetchOk(tokenResponse({ exp: newExp })),
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the refresh workflow stays off pull requests and the review workflow never sees the rotator', () => {
  const workflow = readFileSync(new URL('../.github/workflows/codex-refresh.yml', import.meta.url), 'utf8');
  const review = readFileSync(new URL('../.github/workflows/agent-review.yml', import.meta.url), 'utf8');
  const check = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8');
  assert.equal(workflow.includes('pull_request'), false);
  assert.equal(workflow.includes('issue_comment'), false);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /cron: '0 6 \*\/4 \* \*'/);
  assert.match(workflow, /group: codex-refresh/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /contents: read/);
  assert.equal(/contents: write/.test(workflow), false);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /ref: main/);
  const refreshStep = workflow.slice(workflow.indexOf('Refresh the Codex login'), workflow.indexOf('Store the refreshed login'));
  const storeStep = workflow.slice(workflow.indexOf('Store the refreshed login'), workflow.indexOf('Remove the temp login'));
  assert.match(refreshStep, /CODEX_AUTH_JSON: \$\{\{ secrets\.CODEX_AUTH_JSON \}\}/);
  assert.equal(refreshStep.includes('CODEX_SECRET_ROTATOR_TOKEN'), false);
  assert.equal(refreshStep.includes('secrets.GITHUB_TOKEN'), false);
  assert.match(refreshStep, /node tools\/codex-refresh\.mjs --write "\$RUNNER_TEMP\/codex-auth\.json"/);
  assert.match(storeStep, /GH_TOKEN: \$\{\{ secrets\.CODEX_SECRET_ROTATOR_TOKEN \}\}/);
  assert.equal(storeStep.includes('secrets.CODEX_AUTH_JSON'), false);
  assert.match(storeStep, /for i in 1 2 3; do/);
  assert.match(storeStep, /gh secret set CODEX_AUTH_JSON -R "\$GITHUB_REPOSITORY" < "\$RUNNER_TEMP\/codex-auth\.json" && break/);
  assert.match(storeStep, /\[ "\$i" = 3 \] && exit 1/);
  assert.match(storeStep, /sleep 10/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /rm -f "\$RUNNER_TEMP\/codex-auth\.json"/);
  assert.equal(review.includes('CODEX_SECRET_ROTATOR_TOKEN'), false);
  assert.match(check, /node tools\/test-codex-refresh\.mjs/);
});
