// Tess companion — login.
// Spotify's Authorization Code flow with PKCE: no client secret ever lives in this app, the browser proves
// itself with a one-time code challenge instead. Tokens sit in localStorage and refresh silently shortly
// before they expire; a 401 from the API can force the refresh.
window.TessAuth = (function () {
  'use strict';

  const TOKEN_KEY = 'tc:tokens';
  const CLIENT_KEY = 'tc:clientId';
  const SCOPES = [
    'user-read-private', 'user-read-email',
    'user-library-read', 'user-library-modify',
    'user-top-read', 'user-read-recently-played',
    'user-read-currently-playing', 'user-read-playback-state', 'user-modify-playback-state',
    'playlist-read-private', 'playlist-read-collaborative',
  ];

  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sha256 = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const verifier = () => b64url(crypto.getRandomValues(new Uint8Array(64)));

  const clientId = () => localStorage.getItem(CLIENT_KEY) || '';
  const setClientId = (id) => localStorage.setItem(CLIENT_KEY, String(id || '').trim());
  // relative on purpose, so the same build runs from a local server and from GitHub Pages
  const redirectUri = () => location.origin + location.pathname;

  const tokens = () => { try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { return null; } };
  const saveTokens = (t) => { try { localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); } catch {} };
  const forget = () => localStorage.removeItem(TOKEN_KEY);
  const signedIn = () => !!tokens()?.access_token;

  let refreshing = null;
  async function token() {
    let t = tokens();
    if (!t?.access_token) throw new Error('Not signed in');
    if (t.expiresAt - Date.now() > 30000) return t.access_token;
    if (!refreshing) refreshing = (async () => {
      const body = new URLSearchParams({ client_id: clientId(), grant_type: 'refresh_token', refresh_token: t.refresh_token });
      const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', body });
      if (!r.ok) { forget(); throw new Error('Session expired — sign in again'); }
      const nt = await r.json();
      const out = { ...t, ...nt, expiresAt: Date.now() + nt.expires_in * 1000 };
      saveTokens(out);
      return out.access_token;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  const forceRefresh = async () => { const t = tokens(); if (t) { t.expiresAt = 0; saveTokens(t); } return token(); };

  async function login() {
    const cv = verifier();
    sessionStorage.setItem('tc:verifier', cv);
    const challenge = b64url(new Uint8Array(await sha256(cv)));
    const p = new URLSearchParams({
      client_id: clientId(), response_type: 'code', redirect_uri: redirectUri(),
      code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES.join(' '),
    });
    location.assign('https://accounts.spotify.com/authorize?' + p);
  }

  // Returns true when the URL carried a fresh authorization code that has now been traded for tokens.
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    if (!code) return false;
    const cv = sessionStorage.getItem('tc:verifier') || '';
    history.replaceState(null, '', redirectUri());
    const p = new URLSearchParams({
      client_id: clientId(), grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: cv,
    });
    const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', body: p });
    if (!r.ok) throw new Error('Spotify refused the sign-in (' + r.status + ')');
    const t = await r.json();
    saveTokens({ ...t, expiresAt: Date.now() + t.expires_in * 1000 });
    return true;
  }

  return { clientId, setClientId, redirectUri, login, logout: forget, handleRedirect, token, forceRefresh, signedIn };
})();
