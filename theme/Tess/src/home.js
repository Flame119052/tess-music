// Tess Music — Home.
// A dated greeting, then The Dial: a ring of twelve things to play (your DJ, Made For mixes, the time-of-day
// shelf, Jump back in, top mixes, recents), chosen and ordered by TessDialPick (dial-pick.js). Turn the ring by
// scrolling, dragging or the arrow keys; whatever sits under the marker drops onto the record in the middle.
// Spotify's own shelves follow below, restyled in home.css. Everything plays and opens through Spotify.
(async function tessHome() {
  window.__tessHome?.dispose?.();
  const disposers = [];
  const onDispose = (fn) => disposers.push(fn);
  const self = {};
  window.__tessHome = self;
  self.dispose = () => disposers.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} });
  while (!window.Spicetify?.Platform?.History || !Spicetify.Player) await new Promise((r) => setTimeout(r, 300));
  if (window.__tessHome !== self) return; // a newer copy started while this one waited

  const P = Spicetify.Player;
  const html = document.documentElement;
  const route = () => Spicetify.Platform.History.location?.pathname || '';
  const isHome = () => route() === '/' || route() === '/home';
  const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
  const pathOf = (uri) => {
    if (uri === 'spotify:local-files') return '/collection/local-files';
    try { return Spicetify.URI.fromString(uri).toURLPath(true); } catch { const [, t, id] = uri.split(':'); return `/${t}/${id}`; }
  };
  const imageOf = (u) => (u?.startsWith('spotify:mosaic:') ? 'https://mosaic.scdn.co/300/' + u.split(':').slice(2).join('')
    : u?.startsWith('spotify:image:') ? 'https://i.scdn.co/image/' + u.split(':')[2] : u || '');
  const DJ_URI = 'spotify:playlist:37i9dQZF1EYkqdzj48dyYq';
  const DJ_IMG = 'https://lexicon-assets.spotifycdn.com/DJ-Beta-CoverArt-300.jpg';
  const SLOTS = 12;

  // ---------- greeting ----------
  let firstName = '';
  Spicetify.Platform.UserAPI?.getUser?.().then((u) => { firstName = (u?.displayName || '').split(' ')[0]; render(); }).catch(() => {});
  const greeting = () => {
    const h = new Date().getHours();
    return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  };
  const masthead = el('<header id="tess-home-masthead" class="contentSpacing tess-home-enter"><div class="thm-eyebrow"></div><h1 class="thm-title"></h1></header>');

  // ---------- the dial ----------
  const dial = el(`
    <section id="tess-dial" class="tess-home-enter" aria-label="Pick something to play" tabindex="0">
      <canvas class="td-bg" width="96" height="54"></canvas>
      <div class="td-label">
        <small class="td-reason"></small>
        <b class="td-title"></b>
        <span class="td-sub"></span>
        <div class="td-actions">
          <button class="td-play"><svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor"><path d="M1 1.5l9.5 5.5L1 12.5z"/></svg><span>Play</span></button>
          <button class="td-open">Open</button>
        </div>
        <div class="td-hint">Scroll, drag or use ← → to turn</div>
      </div>
      <div class="td-wheel">
        <div class="td-ring"></div>
        <div class="td-record"><i></i></div>
        <div class="td-marker"></div>
      </div>
    </section>`);
  onDispose(() => { masthead.remove(); dial.remove(); });
  const ring = dial.querySelector('.td-ring');
  const wheel = dial.querySelector('.td-wheel');
  let items = [];
  let index = 0; // which item sits under the marker
  let turns = 0; // total steps taken, so the ring keeps turning the short way round

  // ---------- candidates ----------
  const shelfSource = (title) => {
    const t = (title || '').toLowerCase();
    if (/^made for/.test(t)) return 'madeFor';
    if (/^soundtrack your|^your .*(morning|afternoon|evening|night)/.test(t)) return 'timeOfDay';
    if (/jump back in/.test(t)) return 'jumpBackIn';
    if (/top mixes/.test(t)) return 'topMixes';
    if (/recently played/.test(t)) return 'recent';
    return 'other';
  };
  const kindOf = (uri) => (uri === DJ_URI ? 'dj' : (uri.split(':')[1] || 'other'));
  function shelfCandidates() {
    const out = [];
    document.querySelectorAll('[data-testid="home-page"] [data-testid="component-shelf"]').forEach((shelf, shelfIndex) => {
      const source = shelfSource(shelf.querySelector('h2')?.textContent);
      shelf.querySelectorAll('[data-encore-id="card"]').forEach((card, position) => {
        const uri = card.querySelector('[id^="card-title-spotify:"]')?.id.replace('card-title-', '');
        const img = card.querySelector('img')?.src || '';
        if (!uri || !img) return;
        out.push({
          uri, img, source, shelfIndex, position, kind: kindOf(uri),
          title: card.querySelector('[data-encore-id="cardTitle"]')?.textContent?.trim() || '',
          subtitle: card.querySelector('[data-encore-id="cardSubtitle"]')?.textContent?.trim() || '',
          lastPlayedAt: null, addedAt: null, ownerIsSpotify: /^spotify:playlist:37i9/.test(uri), pinned: false,
        });
      });
    });
    return out;
  }
  async function apiCandidates() {
    const out = [{ uri: DJ_URI, title: 'DJ', subtitle: 'Music and commentary picked for you', img: DJ_IMG, source: 'dj', kind: 'dj', shelfIndex: null, position: 0, lastPlayedAt: null, addedAt: null, ownerIsSpotify: true, pinned: false }];
    try {
      const recent = await Spicetify.Platform.RecentlyPlayedAPI.getContexts();
      (recent || []).slice(0, 20).forEach((c, position) => {
        if (!c.uri?.startsWith('spotify:')) return;
        out.push({ uri: c.uri, title: c.name, subtitle: c.owner?.displayName || '', img: imageOf(c.images?.[0]?.url), source: 'recent', kind: kindOf(c.uri), shelfIndex: null, position, lastPlayedAt: c.timestampMs ? c.timestampMs * (c.timestampMs < 1e12 ? 1000 : 1) : null, addedAt: null, ownerIsSpotify: (c.owner?.displayName || '') === 'Spotify', pinned: false });
      });
    } catch {}
    try {
      const lib = await Spicetify.Platform.LibraryAPI.getContents({ limit: 100, offset: 0 });
      (lib.items || []).forEach((i, position) => {
        const img = imageOf(i.images?.[0]?.url);
        if (!i.uri?.startsWith('spotify:') || !img.startsWith('http')) return;
        out.push({ uri: i.uri, title: i.name, subtitle: i.owner?.name || i.artists?.[0]?.name || '', img, source: 'library', kind: kindOf(i.uri), shelfIndex: null, position, lastPlayedAt: i.lastPlayedAt ? Date.parse(i.lastPlayedAt) : null, addedAt: i.addedAt?.isoString ? Date.parse(i.addedAt.isoString) : null, ownerIsSpotify: /spotify/i.test(i.owner?.name || ''), pinned: !!i.pinned });
      });
    } catch {}
    return out;
  }

  // ---------- what the dial showed and what you played from it (the picker learns from this) ----------
  const HISTORY_KEY = 'tess:dialHistory';
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

  // Fallback order until dial-pick.js is present: DJ, time-of-day, Made For, Jump back in, top mixes, recents.
  function simplePick(cands) {
    const rank = { dj: 0, timeOfDay: 1, madeFor: 2, jumpBackIn: 3, topMixes: 4, recent: 5, other: 6, library: 7 };
    const seen = new Set();
    return cands.filter((c) => !seen.has(c.uri) && seen.add(c.uri))
      .sort((a, b) => (rank[a.source] - rank[b.source]) || (a.position - b.position)).slice(0, SLOTS);
  }

  let shownKey = '';
  let lastRefresh = 0;
  async function refreshDial() {
    // the ring is chosen at most once a minute (and when home first loads), so it never shuffles under your hand
    if (items.length && performance.now() - lastRefresh < 60000) return;
    lastRefresh = performance.now();
    const cands = [...shelfCandidates(), ...(await apiCandidates())];
    if (cands.length < 4) return;
    const ctx = { now: Date.now(), currentUri: P.data?.context?.uri || null, dialHistory: readHistory(), slots: SLOTS };
    let picked;
    try { picked = window.TessDialPick ? window.TessDialPick.pickDialItems(cands, ctx) : simplePick(cands); } catch { picked = simplePick(cands); }
    // whatever is playing right now sits on the ring and is the one selected
    const cur = P.data?.context?.uri;
    if (cur && !picked.some((i) => i.uri === cur)) {
      const c = cands.find((x) => x.uri === cur) || currentContextItem();
      if (c) picked = [c, ...picked.slice(0, SLOTS - 1)];
    }
    const key = picked.map((i) => i.uri).join();
    if (key === shownKey) return;
    shownKey = key;
    items = picked;
    try { localStorage.setItem('tess:dialItems', JSON.stringify(items.map(({ uri, title, subtitle, img, kind, source, reason }) => ({ uri, title, subtitle, img, kind, source, reason })))); } catch {}
    noteShown(items);
    buildRing();
    const playingAt = items.findIndex((i) => i.uri === cur);
    select(playingAt >= 0 ? playingAt : 0, true);
  }
  function currentContextItem() {
    const ctx = P.data?.context;
    if (!ctx?.uri || !/^spotify:(playlist|album|artist|show|collection)/.test(ctx.uri)) return null;
    const m = P.data?.item?.metadata || {};
    const md = ctx.metadata || {};
    return { uri: ctx.uri, title: md.context_description || m.context_description || 'Now playing', subtitle: '', img: imageOf(md.image_url || m.image_url || ''), kind: kindOf(ctx.uri), source: 'recent', reason: 'Playing now' };
  }
  // the ring from last time, shown immediately while the fresh one is worked out
  try {
    const saved = JSON.parse(localStorage.getItem('tess:dialItems') || '[]');
    if (saved.length >= 4) { items = saved; shownKey = saved.map((i) => i.uri).join(); }
  } catch {}

  // ---------- ring ----------
  const R = () => wheel.clientWidth * 0.41;
  function buildRing() {
    ring.replaceChildren();
    items.forEach((it, i) => {
      const c = el('<button class="td-cover" tabindex="-1"><img alt="" draggable="false"></button>');
      c.querySelector('img').src = it.img;
      c.title = it.title;
      c.dataset.uri = it.uri;
      c.dataset.name = it.title;
      c.setAttribute('aria-label', it.title);
      if (it.kind === 'artist') c.classList.add('round');
      c.onclick = () => turnTo(i);
      c.ondblclick = () => play(items[i]);
      ring.appendChild(c);
    });
    layoutRing();
  }
  function layoutRing() {
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
    const n = items.length;
    if (!n) return;
    index = ((i % n) + n) % n;
    if (instant) { turns = index; ring.classList.add('instant'); requestAnimationFrame(() => ring.classList.remove('instant')); }
    ring.style.setProperty('--turn', (-turns * 360 / n) + 'deg');
    [...ring.children].forEach((c, k) => c.classList.toggle('on', k === index));
    const it = items[index];
    dial.querySelector('.td-reason').textContent = it.reason || reasonFor(it);
    dial.querySelector('.td-title').textContent = it.title;
    dial.querySelector('.td-sub').textContent = it.subtitle;
    const live = isCurrent(it);
    const song = P.data?.item;
    const songArt = imageOf(song?.metadata?.image_large_url || song?.metadata?.image_url || '');
    dial.querySelector('.td-record i').style.backgroundImage = `url("${live && songArt ? songArt : it.img}")`;
    dial.classList.toggle('live', live);
    if (live && song) {
      dial.querySelector('.td-reason').textContent = P.isPlaying() ? 'Playing now' : 'Paused';
      dial.querySelector('.td-sub').textContent = `${song.name || song.metadata?.title || ''} · ${song.metadata?.artist_name || ''}`;
    }
    dial.querySelector('.td-play span').textContent = isPlayingNow(it) ? 'Pause' : 'Play';
    loadPalette(it.img);
  }
  const reasonFor = (it) => ({ dj: 'Your DJ', timeOfDay: 'For right now', madeFor: 'Made for you', jumpBackIn: 'Jump back in', topMixes: 'One of your top mixes', recent: 'Played recently', library: 'From your library' }[it.source] || 'For you');
  const isCurrent = (it) => !!it && P.data?.context?.uri === it.uri;
  const isPlayingNow = (it) => P.isPlaying() && isCurrent(it);
  function step(d) { turns += d; select(index + d); }
  function turnTo(i) {
    const n = items.length;
    let d = i - index;
    if (d > n / 2) d -= n;
    if (d < -n / 2) d += n;
    step(d);
  }
  function play(it) {
    if (!it) return;
    if (isPlayingNow(it)) { P.togglePlay(); } else { Spicetify.Player.playUri(it.uri); notePlayed(it.uri); }
    dial.classList.add('pulse');
    setTimeout(() => dial.classList.remove('pulse'), 500);
    setTimeout(() => select(index), 600);
  }
  dial.querySelector('.td-play').onclick = () => play(items[index]);
  dial.querySelector('.td-open').onclick = () => items[index] && Spicetify.Platform.History.push(pathOf(items[index].uri));

  // Wheel: one step per notch; trackpads accumulate so a gentle swipe moves one or two, not ten.
  let acc = 0, lastWheel = 0;
  wheel.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel > 250) acc = 0;
    lastWheel = now;
    acc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    while (Math.abs(acc) >= 60) { step(Math.sign(acc)); acc -= Math.sign(acc) * 60; }
  }, { passive: false });
  // Drag: the ring follows the pointer around the centre and settles on the nearest item.
  let drag = null;
  const angleAt = (e) => { const r = wheel.getBoundingClientRect(); return Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2); };
  wheel.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { a: angleAt(e), moved: 0 }; });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  onDispose(() => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); });
  function onMove(e) {
    if (!drag || !items.length) return;
    let d = angleAt(e) - drag.a;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    const per = (Math.PI * 2) / items.length;
    if (Math.abs(d) > per * 0.6) { const k = Math.round(d / per); step(-k); drag.a += k * per; drag.moved++; }
  }
  function onUp() { drag = null; }
  dial.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(items[index]); }
  });

  // ---------- aurora behind the dial, from the selected record's colours ----------
  const bg = dial.querySelector('.td-bg');
  let colors = [[40, 50, 90], [70, 40, 90], [30, 60, 80], [20, 20, 30]];
  let shown = colors.map((c) => [...c]);
  const palettes = new Map();
  function loadPalette(src) {
    if (palettes.has(src)) { colors = palettes.get(src); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 4;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, 4, 4);
        const d = x.getImageData(0, 0, 4, 4).data;
        const p = [0, 12, 40, 52].map((k) => [d[k], d[k + 1], d[k + 2]]);
        palettes.set(src, p);
        if (items[index]?.img === src) colors = p;
      } catch {}
    };
    img.src = src;
  }
  function paint(t) {
    const x = bg.getContext('2d');
    shown = shown.map((c, i) => c.map((v, j) => v + (colors[i][j] - v) * 0.1));
    x.filter = 'none'; x.fillStyle = '#08080b'; x.fillRect(0, 0, 96, 54);
    x.filter = 'blur(9px) saturate(150%)';
    shown.forEach((c, i) => {
      const a = t * 0.00012 * (i % 2 ? 1 : -1) + i * 1.7;
      x.fillStyle = `rgba(${c.map(Math.round).join(',')},0.85)`;
      x.beginPath();
      x.ellipse(96 * (0.5 + 0.38 * Math.cos(a)), 54 * (0.5 + 0.4 * Math.sin(a * 1.3)), 40, 30, a, 0, Math.PI * 2);
      x.fill();
    });
  }
  const bgTimer = setInterval(() => { if (!document.hidden && isHome() && dial.isConnected) paint(performance.now()); }, 90);
  onDispose(() => clearInterval(bgTimer));

  // ---------- on this day ----------
  // Songs you saved to Liked Songs on today's date in earlier years (or, failing that, within a few days of it).
  const otd = el(`<section id="tess-otd" class="tess-home-enter" hidden><div class="otd-head"><h2></h2><small></small></div><div class="otd-row"></div></section>`);
  onDispose(() => otd.remove());
  let otdDay = '';
  async function fillOnThisDay() {
    const today = new Date();
    if (otdDay === today.toDateString()) return;
    otdDay = today.toDateString();
    let all = [];
    try {
      for (let off = 0; off < 20000; off += 500) {
        const r = await Spicetify.Platform.LibraryAPI.getTracks({ limit: 500, offset: off });
        all = all.concat(r.items || []);
        if (!r.items || r.items.length < 500) break;
      }
    } catch { return; }
    const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const gap = (t) => { const a = new Date(t.addedAt); return Math.abs(dayStart(new Date(today.getFullYear(), a.getMonth(), a.getDate())) - dayStart(today)) / 864e5; };
    const past = all.filter((t) => t.addedAt && new Date(t.addedAt).getFullYear() < today.getFullYear());
    let picks = past.filter((t) => gap(t) === 0);
    let title = 'On this day';
    if (!picks.length) { picks = past.filter((t) => gap(t) <= 3); title = 'This week, years ago'; }
    if (!picks.length) { picks = past.filter((t) => gap(t) <= 7); title = 'Around now, years ago'; }
    if (!picks.length) { otd.hidden = true; return; }
    picks.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
    const years = [...new Set(picks.map((t) => today.getFullYear() - new Date(t.addedAt).getFullYear()))];
    otd.querySelector('h2').textContent = title;
    otd.querySelector('small').textContent = `Songs you saved ${years.map((y) => (y === 1 ? 'a year' : `${y} years`)).join(', ')} ago`;
    const row = otd.querySelector('.otd-row');
    row.replaceChildren(...picks.slice(0, 12).map((t) => {
      const c = el('<button class="otd-song"><span class="otd-art"><img alt=""></span><b></b><small></small><em></em></button>');
      c.querySelector('img').src = imageOf(t.album?.images?.[0]?.url || t.album?.coverArt?.sources?.[0]?.url || '');
      c.querySelector('b').textContent = t.name;
      c.dataset.uri = t.uri;
      c.dataset.name = t.name;
      c.querySelector('small').textContent = (t.artists || []).map((a) => a.name).join(', ');
      c.querySelector('em').textContent = new Date(t.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      c.onclick = () => {
        // play it inside Liked Songs so the music carries on from there
        Spicetify.Platform.PlayerAPI.play({ uri: 'spotify:collection:tracks' }, {}, { skipTo: { uri: t.uri } }).catch(() => Spicetify.Player.playUri(t.uri));
      };
      return c;
    }));
    otd.hidden = false;
  }

  // ---------- placement ----------
  function render() {
    if (window.__tessHome !== self) return;
    // clear anything a stale copy of this script left behind
    document.querySelectorAll('#tess-home-masthead, #tess-dial, #tess-otd').forEach((n) => { if (n !== masthead && n !== dial && n !== otd) n.remove(); });
    html.classList.toggle('tess-home', isHome());
    if (!isHome()) return;
    const page = document.querySelector('[data-testid="home-page"]');
    if (!page) return;
    let chipRow = document.querySelector('#main-view [data-encore-id="chip"]');
    while (chipRow && getComputedStyle(chipRow).position !== 'sticky') chipRow = chipRow.parentElement;
    masthead.querySelector('.thm-eyebrow').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    masthead.querySelector('.thm-title').textContent = firstName ? `${greeting()}, ${firstName}` : greeting();
    // the greeting lives inside Spotify's sticky filter bar, so the two stay pinned to the top together
    if (chipRow && masthead.parentElement !== chipRow) { chipRow.prepend(masthead); chipRow.classList.add('tess-home-sticky'); }
    chipRow?.querySelector(':scope > :not(#tess-home-masthead)')?.classList.add('tess-sticky-glass');
    if (chipRow && !chipRow.dataset.tessScroll) {
      chipRow.dataset.tessScroll = '1';
      let sc = chipRow.parentElement;
      while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
      sc?.addEventListener('scroll', () => chipRow.classList.toggle('tess-compact', sc.scrollTop > 40), { passive: true });
    }
    const content = page.querySelector('.main-home-content') || page.querySelector('.view-homeShortcutsGrid-shortcuts')?.parentElement;
    if (content && content.firstElementChild !== dial) {
      content.prepend(dial);
      if (items.length && !ring.children.length) { buildRing(); const at = items.findIndex((i) => i.uri === P.data?.context?.uri); select(at >= 0 ? at : 0, true); }
      layoutRing();
    }
    if (content && dial.nextElementSibling !== otd) dial.after(otd);
    refreshDial();
    fillOnThisDay();
  }
  const onSong = () => {
    if (!dial.isConnected || !items.length) return;
    const at = items.findIndex((i) => i.uri === P.data?.context?.uri);
    if (at >= 0 && at !== index && !drag) turnTo(at); else select(index);
  };
  P.addEventListener('songchange', onSong);
  P.addEventListener('onplaypause', onSong);
  onDispose(() => { P.removeEventListener('songchange', onSong); P.removeEventListener('onplaypause', onSong); html.classList.remove('tess-home'); });
  const ro = new ResizeObserver(() => layoutRing());
  ro.observe(wheel);
  onDispose(() => ro.disconnect());
  // place everything the moment Spotify draws home, instead of polling for it
  let queued = false;
  const mo = new MutationObserver(() => {
    if (queued || !isHome()) return;
    if (dial.isConnected && masthead.isConnected) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  });
  const watchMain = () => { const mv = document.getElementById('main-view'); if (mv) mo.observe(mv, { childList: true, subtree: true }); };
  watchMain();
  onDispose(() => mo.disconnect());
  const unlisten = Spicetify.Platform.History.listen(() => { requestAnimationFrame(render); setTimeout(render, 400); });
  onDispose(() => typeof unlisten === 'function' && unlisten());
  const beat = setInterval(() => { if (!document.hidden && isHome()) render(); }, 4000);
  onDispose(() => clearInterval(beat));
  render();
})();
