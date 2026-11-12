// Tess companion — Home's Dial.
// The ring is the theme's, on touch instead of scroll: a circle of covers you drag around, and whatever
// settles under the marker drops onto the record in the middle. What is on the ring is chosen by the
// theme's own picker (dial-pick.js, ported verbatim) fed here by Web API shelves: Made For mixes, the
// contexts you played recently, your top songs, the playlists you keep. The dial's memory — what you
// played from it, what you kept ignoring, both fading over a fortnight — lives in localStorage, same
// as on the desktop, so the ring keeps learning you.
window.TessDial = (function () {
  'use strict';

  const SLOTS = 12;
  const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };

  // ---------- what the dial showed and what you played from it ----------
  const HISTORY_KEY = 'tc:dialHistory';
  const readHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } };
  const writeHistory = (h) => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-400))); } catch {} };
  function noteShown(list) {
    const h = readHistory();
    const day = new Date().toDateString();
    for (const it of list) if (!h.some((e) => e.uri === it.uri && new Date(e.shownAt).toDateString() === day)) h.push({ uri: it.uri, shownAt: Date.now(), playedAt: null });
    writeHistory(h);
  }
  function notePlayed(uri) {
    const h = readHistory();
    const last = [...h].reverse().find((e) => e.uri === uri && !e.playedAt);
    if (last) last.playedAt = Date.now(); else h.push({ uri, shownAt: Date.now(), playedAt: Date.now() });
    writeHistory(h);
  }

  // ---------- candidates from the Web API ----------
  // The desktop reads Spotify's home shelves; the phone rebuilds the same kinds of shelf from the public API:
  // Made For (Spotify's own mixes saved in the library), jump back in and recents (distinct recently-played
  // contexts), your top songs, and the playlists you keep. The DJ has no public API — the picker tolerates
  // its absence.
  let meId = '';
  let candCache = null;
  let candAt = 0;
  async function candidates() {
    if (candCache && Date.now() - candAt < 5 * 60000) return candCache;
    if (!meId) { try { meId = (await TessAPI.me()).id; } catch {} }
    const [recent, pls, topRecent, topAll] = await Promise.all([
      TessAPI.recentlyPlayed().catch(() => null),
      TessAPI.playlists().catch(() => []),
      TessAPI.topTracks('short_term').catch(() => null),
      TessAPI.topTracks('long_term').catch(() => null),
    ]);
    const out = [];

    const topList = (topRecent?.items?.length ? topRecent.items : topAll?.items) || [];
    if (topList.length >= 5) {
      out.push({
        uri: 'tc:top-tracks', title: 'Your top songs', subtitle: 'The ones you have had on most',
        img: (topList[0].album?.images || [])[0]?.url || '', source: 'topMixes', kind: 'playlist',
        shelfIndex: null, position: 0, lastPlayedAt: null, addedAt: null, ownerIsSpotify: false, pinned: false,
        uris: topList.slice(0, 50).map((t) => t.uri),
      });
    }

    (pls || []).forEach((p, i) => {
      const owner = String(p.owner?.id || '').toLowerCase();
      const madeFor = owner === 'spotify' && /discover weekly|release radar|daily mix|daylist/i.test(p.name);
      if (madeFor) {
        out.push({
          uri: p.uri, title: p.name, subtitle: 'Made for you', img: (p.images || [])[0]?.url || '',
          source: 'madeFor', kind: 'playlist', shelfIndex: null, position: i, lastPlayedAt: null,
          addedAt: null, ownerIsSpotify: true, pinned: false,
        });
      } else if (p.owner?.id === meId && (p.tracks?.total || 0) > 3) {
        out.push({
          uri: p.uri, title: p.name, subtitle: 'From your library', img: (p.images || [])[0]?.url || '',
          source: 'library', kind: 'playlist', shelfIndex: null, position: i, lastPlayedAt: null,
          addedAt: null, ownerIsSpotify: false, pinned: false,
        });
      }
    });

    const seen = new Map();
    (recent?.items || []).forEach((r) => {
      const c = r.context;
      if (!c?.uri || c.uri.startsWith('spotify:track:') || seen.has(c.uri)) return;
      seen.set(c.uri, r.played_at);
    });
    const metas = await Promise.all([...seen.keys()].slice(0, 12).map((u) => TessAPI.contextMeta(u).catch(() => null)));
    let n = 0;
    for (const [uri, playedAt] of seen) {
      const meta = metas.find((m) => m?.uri === uri);
      if (!meta?.name) continue;
      out.push({
        uri, title: meta.name, subtitle: meta.owner || '', img: (meta.images || [])[0]?.url || '',
        source: n < 6 ? 'jumpBackIn' : 'recent', kind: uri.split(':')[1], shelfIndex: null, position: n,
        lastPlayedAt: Date.parse(playedAt) || null, addedAt: null, ownerIsSpotify: false, pinned: false,
      });
      if (++n >= 12) break;
    }

    candCache = out;
    candAt = Date.now();
    return out;
  }

  // Fallback order until the picker is present.
  function simplePick(cands) {
    const rank = { madeFor: 0, jumpBackIn: 1, topMixes: 2, recent: 3, library: 4, other: 5 };
    const seen = new Set();
    return cands.filter((c) => !seen.has(c.uri) && seen.add(c.uri))
      .sort((a, b) => (rank[a.source] - rank[b.source]) || (a.position - b.position)).slice(0, SLOTS);
  }

  // ---------- the module ----------
  let root = null;
  let ring = null;
  let wheel = null;
  let items = [];
  let index = 0;
  let turns = 0;
  let shownKey = '';
  let lastRefresh = 0;
  let aurora = null;
  let ro = null;
  let refreshTimer = 0;
  const syncState = () => window.TessSync?.state || {};

  function mount(parent) {
    root = el(`
      <section id="tcd" aria-label="Pick something to play" tabindex="0">
        <div class="td-label">
          <small class="td-reason"></small>
          <b class="td-title"></b>
          <span class="td-sub"></span>
          <div class="td-actions">
            <button class="td-play"><svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor"><path d="M1 1.5l9.5 5.5L1 12.5z"/></svg><span>Play</span></button>
            <button class="td-open">Open</button>
          </div>
          <div class="td-hint">Drag the ring to turn it</div>
        </div>
        <div class="td-wheel">
          <div class="td-ring"></div>
          <div class="td-record"><i></i></div>
          <div class="td-marker"></div>
        </div>
      </section>`);
    ring = root.querySelector('.td-ring');
    wheel = root.querySelector('.td-wheel');
    root.querySelector('.td-play').onclick = () => play(items[index]);
    root.querySelector('.td-open').onclick = () => items[index] && TessApp.open(items[index]);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(items[index]); }
    });
    parent.appendChild(root);
    ro = new ResizeObserver(() => layoutRing());
    ro.observe(wheel);
    refreshDial();
    refreshTimer = setInterval(() => { if (!document.hidden) refreshDial(); }, 60000);
    return root;
  }

  function unmount() {
    clearInterval(refreshTimer);
    ro?.disconnect();
    root?.remove();
    root = ring = wheel = null;
    items = [];
  }

  async function refreshDial() {
    if (!root || !wheel?.isConnected) return;
    if (items.length && performance.now() - lastRefresh < 60000) return;
    lastRefresh = performance.now();
    const cands = await candidates();
    if (cands.length < 4) return;
    const ctx = { now: Date.now(), currentUri: syncState().contextUri || null, dialHistory: readHistory(), slots: SLOTS };
    let picked;
    try { picked = window.TessDialPick ? TessDialPick.pickDialItems(cands, ctx) : simplePick(cands); } catch { picked = simplePick(cands); }
    const key = picked.map((i) => i.uri).join();
    if (key === shownKey && items.length) return;
    shownKey = key;
    items = picked;
    noteShown(items);
    buildRing();
    select(0, true);
  }

  // ---------- the ring ----------
  const R = () => wheel.clientWidth * 0.41;
  function buildRing() {
    ring.replaceChildren();
    items.forEach((it, i) => {
      const c = el('<button class="td-cover" tabindex="-1"><img alt="" draggable="false"></button>');
      if (it.img) c.querySelector('img').src = it.img;
      c.title = it.title;
      c.setAttribute('aria-label', it.title);
      if (it.kind === 'artist') c.classList.add('round');
      c.onclick = () => turnTo(i);
      c.ondblclick = () => play(items[i]);
      ring.appendChild(c);
    });
    layoutRing();
  }
  function layoutRing() {
    if (!ring) return;
    const n = items.length || 1;
    const r = R();
    [...ring.children].forEach((c, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      c.style.setProperty('--x', (Math.cos(a) * r).toFixed(1) + 'px');
      c.style.setProperty('--y', (Math.sin(a) * r).toFixed(1) + 'px');
    });
    ring.style.setProperty('--turn', (-turns * 360 / n) + 'deg');
  }
  function select(i, instant) {
    if (!root || !items.length) return;
    const n = items.length;
    index = ((i % n) + n) % n;
    if (instant) { turns = index; ring.classList.add('instant'); requestAnimationFrame(() => ring.classList.remove('instant')); }
    ring.style.setProperty('--turn', (-turns * 360 / n) + 'deg');
    [...ring.children].forEach((c, k) => c.classList.toggle('on', k === index));
    const it = items[index];
    root.querySelector('.td-reason').textContent = it.reason || reasonFor(it);
    root.querySelector('.td-title').textContent = it.title;
    root.querySelector('.td-sub').textContent = it.subtitle || '';
    root.querySelector('.td-record i').style.backgroundImage = it.img ? `url("${it.img}")` : 'none';
    root.querySelector('.td-play span').textContent = isPlayingNow(it) ? 'Pause' : 'Play';
    root.querySelector('.td-record').classList.toggle('spin', syncState().playing);
    window.TessApp?.aurora?.setArtwork(it.img);
    syncNowLabel();
  }
  const reasonFor = (it) => ({ madeFor: 'Made for you', jumpBackIn: 'Jump back in', topMixes: 'Your songs, most played', recent: 'Played recently', library: 'From your library' }[it.source] || 'For you');
  const isPlayingNow = (it) => syncState().playing && (syncState().contextUri === it.uri || (it.uris && syncState().contextUri === null));
  function syncNowLabel() {
    if (!root || !items.length) return;
    root.querySelector('.td-play span').textContent = isPlayingNow(items[index]) ? 'Pause' : 'Play';
    root.querySelector('.td-record').classList.toggle('spin', !!syncState().playing);
  }
  function step(d) { turns += d; select(index + d); }
  function turnTo(i) {
    const n = items.length;
    if (!n) return;
    let d = i - index;
    if (d > n / 2) d -= n;
    if (d < -n / 2) d += n;
    step(d);
  }
  function play(it) {
    if (!it) return;
    if (isPlayingNow(it)) TessSync.togglePlay();
    else if (it.uris) TessSync.play({ uris: it.uris });
    else TessSync.play({ context_uri: it.uri });
    notePlayed(it.uri);
    root.classList.add('pulse');
    setTimeout(() => root.classList.remove('pulse'), 500);
    setTimeout(select.bind(null, index), 600);
  }

  // Drag: the ring follows the pointer around the centre and settles on the nearest item.
  let drag = null;
  const angleAt = (e) => { const r = wheel.getBoundingClientRect(); return Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2); };
  function onMove(e) {
    if (!drag || !items.length) return;
    let d = angleAt(e) - drag.a;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    const per = (Math.PI * 2) / items.length;
    if (Math.abs(d) > per * 0.6) {
      const k = Math.round(d / per);
      step(-k);
      drag.a += k * per;
    }
  }
  const onUp = () => { drag = null; };
  function bindOnce() {
    if (bindOnce.done) return;
    bindOnce.done = true;
    document.addEventListener('pointerdown', (e) => {
      if (!wheel || !(e.target instanceof Element) || !wheel.contains(e.target)) return;
      drag = { a: angleAt(e) };
    });
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    if (window.TessSync) TessSync.on(syncNowLabel);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDial(); });
  }

  return {
    mount(parent) {
      bindOnce();
      return mount(parent);
    },
    unmount,
    refresh: refreshDial,
    isActive: () => !!root?.isConnected,
  };
})();
