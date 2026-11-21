#!/usr/bin/env node
// One chat-completions post to the support gate. The configured URL is the base (D-103, D-104):
// this script appends /chat/completions, which is the gate's route.
// 401 and 429 stop. The token is never printed, and a redirect is not followed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const die = (msg) => { console.error(msg); process.exit(1); };

const configPath = process.env.TESS_SUPPORT_CONFIG
  || (process.env.HERMES_HOME ? join(process.env.HERMES_HOME, 'profiles', 'tess-support', 'config.yaml') : '');
if (!configPath) die('Set HERMES_HOME or TESS_SUPPORT_CONFIG so the gate URL can be read');

// The profile .env is the environment this chat uses. A key sitting in the parent process is not sent.
const profileEnv = {};
for (const line of readFileSync(join(dirname(configPath), '.env'), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const cut = line.indexOf('=');
  if (cut === -1) continue;
  profileEnv[line.slice(0, cut)] = line.slice(cut + 1);
}
const token = profileEnv.TESS_SUPPORT_TOKEN || '';
if (!token) die('TESS_SUPPORT_TOKEN is missing');

const expand = (value) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
  if (name === 'TESS_INBOX') return (profileEnv.TESS_INBOX || 'https://tess-music-player.janus.ing').replace(/\/$/, '');
  return profileEnv[name] || '';
});

const rawBase = () => {
  const text = readFileSync(configPath, 'utf8');
  const providers = text.split(/^providers:/m)[1] || '';
  const block = providers.split(/^model:/m)[0] || providers;
  const match = block.match(/base_url:\s*(\S+)/);
  if (!match) die('the profile has no gate URL');
  return expand(match[1].replace(/^['"]|['"]$/g, ''));
};

const gate = () => {
  let url;
  try { url = new URL(rawBase()); } catch { die('the gate URL is not an address'); }
  if (url.username || url.password || url.search || url.href.includes(token)) die('the gate URL must not carry the token or a query');
  const local = process.env.TESS_TEST === '1' && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  const live = url.protocol === 'https:' && url.hostname === 'tess-music-player.janus.ing';
  if (!local && !live) die(`${url.hostname} is not the Tess support gate`);
  // The profile stores the base, as Hermes expects; Hermes appends /chat/completions, so this does the same.
  if (url.pathname.replace(/\/$/, '') !== '/v1/support') die(`the gate URL is not the support chat base: ${url.pathname}`);
  url.pathname = '/v1/support/chat/completions';
  return url;
};

const say = (status) => {
  if (status === 401) die('The support token was refused. Ask for a new one. Nothing else was sent.');
  if (status === 429) die('This Mac is over the support cap. The model will not be called again until it resets.');
  if (status >= 300 && status < 400) die('The gate redirected. The token was not sent on.');
  die(`the gate answered ${status}`);
};

const url = gate();
const res = await fetch(url, {
  method: 'POST',
  redirect: 'manual',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: process.argv[2] || 'ping' }],
  }),
});
if (!res.ok) say(res.status);
const text = await res.text();
process.stdout.write(text.replaceAll(token, '[token]'));
