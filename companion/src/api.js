// Tess companion — Spotify's Web API, plus the two internal endpoints the desktop theme already uses.
// One fetch wrapper does the housekeeping: bearer token, one silent retry after a forced refresh, and
// respect for Retry-After when the rate limiter taps the brake.
window.TessAPI = (function () {
  'use strict';

  const BASE = 'https://api.spotify.com/v1';

  async function req(path, opts = {}, depth = 0) {
    const token = await TessAuth.token();
    const url = path.startsWith('http') ? path : BASE + path;
    const r = await fetch(url, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401 && depth < 1) { await TessAuth.forceRefresh(); return req(path, opts, depth + 1); }
    if (r.status === 429 && depth < 2) {
      await new Promise((res) => setTimeout(res, (Number(r.headers.get('Retry-After')) || 1) * 1000));
      return req(path, opts, depth + 1);
    }
    if (r.status === 204 || r.status === 304) return null;
    if (!r.ok) throw new Error('Spotify ' + r.status + ' on ' + path);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }
  // player commands are PUTs with no body
  const send = (path) => req(path, { method: 'PUT' });
  const post = (path) => req(path, { method: 'POST' });

  // walk every page of a list, up to a sane cap
  async function all(path, cap = 2000, page = 50) {
    const out = [];
    for (let off = 0; off < cap; off += page) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await req(`${path}${sep}limit=${page}&offset=${off}`);
      out.push(...(r.items || []));
      if (!r.items || r.items.length < page) break;
    }
    return out;
  }

  const me = () => req('/me');
  const playlists = () => all('/me/playlists', 1000);
  const likedTracks = () => all('/me/tracks', 6000);
  const savedAlbums = () => all('/me/albums', 1000);
  const followingArtists = async () => {
    // the following list pages by cursor, not offset
    const out = [];
    let after = '';
    for (let i = 0; i < 20; i++) {
      const r = await req('/me/following?type=artist&limit=50' + (after ? '&after=' + after : ''));
      const items = r?.artists?.items || [];
      out.push(...items);
      if (items.length < 50) break;
      after = items[items.length - 1].id;
    }
    return out;
  };
  const artistAlbums = async (id) => {
    const r = await req('/artists/' + id + '/albums?include_groups=album,single&limit=30');
    const seen = new Set();
    return (r?.items || []).filter((a) => a.album_type === 'album' && a.name && !seen.has(a.name) && seen.add(a.name));
  };
  const topTracks = (range = 'short_term') => req('/me/top/tracks?time_range=' + range + '&limit=50');
  const topArtists = (range = 'long_term') => req('/me/top/artists?time_range=' + range + '&limit=50');
  const recentlyPlayed = () => req('/me/player/recently-played?limit=50');

  const playlist = (id) => req('/playlists/' + id + '?fields=id,uri,name,description,images,owner,followers,total,tracks(total)');
  const playlistTracks = (id, cap = 600) => all('/playlists/' + id + '/tracks', cap, 100);
  const track = (id) => req('/tracks/' + id);
  const tracks = (ids) => req('/tracks?ids=' + ids.join(','));
  const album = (id) => req('/albums/' + id);
  const albumTracks = (id) => all('/albums/' + id + '/tracks', 400);
  const artist = (id) => req('/artists/' + id);
  const artistTop = (id) => req('/artists/' + id + '/top-tracks?market=from_token');
  const search = (q) => req('/search?type=track,album,artist,playlist&limit=10&q=' + encodeURIComponent(q));

  const player = () => req('/me/player?additional_types=track');
  const devices = () => req('/me/player/devices');
  const queue = () => req('/me/player/queue');
  const transfer = (ids, play) => req('/me/player', { method: 'PUT', body: { device_ids: ids, play: !!play } });
  const play = (deviceId, what = {}) => {
    const p = new URLSearchParams();
    if (deviceId) p.set('device_id', deviceId);
    return req('/me/player/play' + (p.toString() ? '?' + p : ''), { method: 'PUT', body: what });
  };
  const pause = (deviceId) => send('/me/player/pause' + (deviceId ? '?device_id=' + deviceId : ''));
  const next = () => post('/me/player/next');
  const prev = () => post('/me/player/previous');
  const seek = (ms, deviceId) => send('/me/player/seek?position_ms=' + Math.round(ms) + (deviceId ? '&device_id=' + deviceId : ''));
  const volume = (v, deviceId) => send('/me/player/volume?volume_percent=' + Math.round(v) + (deviceId ? '&device_id=' + deviceId : ''));
  const shuffle = (state) => send('/me/player/shuffle?state=' + (state ? 'true' : 'false'));
  const repeat = (mode) => send('/me/player/repeat?state=' + mode);
  const addToQueue = (uri) => post('/me/player/queue?uri=' + encodeURIComponent(uri));
  const saveTracks = (ids) => req('/me/tracks?ids=' + ids.join(','), { method: 'PUT' });
  const unsaveTracks = (ids) => req('/me/tracks?ids=' + ids.join(','), { method: 'DELETE' });
  const tracksSaved = (ids) => req('/me/tracks/contains?ids=' + ids.join(','));

  // ---------- names and covers for bare context uris (recently played gives uris only) ----------
  // Cached in localStorage for a week: playlists, albums and artists rarely change their art.
  const CTX_KEY = 'tc:ctx';
  const ctxCache = () => { try { return JSON.parse(localStorage.getItem(CTX_KEY) || '{}'); } catch { return {}; } };
  async function contextMeta(uri) {
    if (!uri?.startsWith('spotify:')) return null;
    const [, kind, id] = uri.split(':');
    const cache = ctxCache();
    if (cache[uri] && Date.now() - cache[uri].at < 7 * 864e5) return cache[uri];
    let meta = null;
    try {
      if (kind === 'playlist') {
        const p = await playlist(id);
        meta = p && { uri, name: p.name, images: p.images, owner: p.owner?.display_name || p.owner?.id || '' };
      } else if (kind === 'album') {
        const a = await album(id);
        meta = a && { uri, name: a.name, images: a.images, owner: (a.artists || [])[0]?.name || '' };
      } else if (kind === 'artist') {
        const a = await artist(id);
        meta = a && { uri, name: a.name, images: a.images, owner: 'Artist' };
      }
    } catch {}
    if (meta) {
      cache[uri] = { ...meta, at: Date.now() };
      try { localStorage.setItem(CTX_KEY, JSON.stringify(cache)); } catch {}
    }
    return meta || (cache[uri] ? { ...cache[uri] } : null);
  }

  // Synced lyrics: the same internal colour-lyrics endpoint the desktop theme reads with your own login.
  // It is not part of the public API and may refuse a browser origin — then there are simply no lyrics.
  async function lyrics(trackId) {
    try {
      const token = await TessAuth.token();
      const r = await fetch('https://spclient.wg.spotify.com/color-lyrics/v2/track/' + trackId + '?format=json&vocalRemoval=false&market=from_token', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return null;
      const res = await r.json();
      const raw = res?.lyrics?.lines || [];
      return {
        sync: res?.lyrics?.syncType || 'UNSYNCED',
        lines: raw.map((l, i) => ({ start: Number(l.startTimeMs), text: (l.words || '').trim() })),
      };
    } catch { return null; }
  }

  return {
    req,
    me, playlists, likedTracks, savedAlbums, followingArtists, topTracks, topArtists, recentlyPlayed,
    playlist, playlistTracks, track, tracks, album, albumTracks, artist, artistAlbums, artistTop, search,
    player, devices, queue, transfer, play, pause, next, prev, seek, volume, shuffle, repeat, addToQueue,
    saveTracks, unsaveTracks, tracksSaved, contextMeta, lyrics,
  };
})();
