// Tess companion — the pages.
// Library as a timeline (Liked Songs pinned, then what you played, then the rest), playlist pages with the
// DNA section ported from the theme (the drifting cover wall, the artist ribbon, the years chart), plus
// light album, artist, search and Liked pages. Everything navigates by hash so the phone's back gesture works.
window.TessViews = (function () {
  'use strict';

  const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  // nearest cover at or above `min` wide, else the biggest there is
  const pick = (images, min = 200) => {
    const fit = (images || []).filter((i) => (i.width || 0) >= min).sort((a, b) => a.width - b.width);
    return (fit[0] || (images || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0))[0])?.url || '';
  };

  // ---------- shared data ----------
  let libCache = null;
  async function libraryData(force) {
    if (libCache && !force && Date.now() - libCache.at < 60000) return libCache;
    const [pls, albums, following, liked] = await Promise.all([
      TessAPI.playlists().catch(() => []),
      TessAPI.savedAlbums().catch(() => []),
      TessAPI.followingArtists().catch(() => []),
      TessAPI.req('/me/tracks?limit=1').catch(() => null),
    ]);
    libCache = {
      playlists: pls || [], albums: albums || [], artists: following || [],
      likedTotal: liked?.total || 0, at: Date.now(),
    };
    return libCache;
  }

  let recentsMap = null;
  async function recentContexts() {
    if (recentsMap && Date.now() - recentsMap.at < 120000) return recentsMap.map;
    const r = await TessAPI.recentlyPlayed().catch(() => null);
    const map = new Map();
    (r?.items || []).forEach((x) => {
      const uri = x.context?.uri;
      if (!uri || uri.startsWith('spotify:track:')) return;
      const at = Date.parse(x.played_at);
      if (!map.has(uri) || map.get(uri) < at) map.set(uri, at);
    });
    recentsMap = { map, at: Date.now() };
    return map;
  }

  // ---------- rows ----------
  function mediaRow(item) {
    const row = el('<button class="tv-row"><span class="tv-art"><img alt="" draggable="false"></span><span class="tv-text"><b></b><small></small></span><span class="tv-play" aria-label="Play"></span></button>');
    const img = row.querySelector('img');
    if (item.img) img.src = item.img;
    else row.querySelector('.tv-art').classList.add('tv-noart');
    row.querySelector('b').textContent = item.name;
    row.querySelector('small').textContent = item.sub || '';
    row.querySelector('.tv-play').innerHTML = '<svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor"><path d="M1 1.5l9.5 5.5L1 12.5z"/></svg>';
    row.onclick = (e) => (e.target.closest('.tv-play') ? (item.onPlay?.(), e.stopPropagation()) : item.onOpen?.());
    return row;
  }
  function trackRow(t, n, onPlay, onOpen) {
    const row = el('<button class="tv-row tv-track"><span class="tv-n"></span><span class="tv-text"><b></b><small></small></span><span class="tv-dur"></span></button>');
    row.querySelector('.tv-n').textContent = n || '';
    row.querySelector('b').textContent = t.name;
    row.querySelector('small').textContent = (t.artists || []).join(', ');
    row.querySelector('.tv-dur').textContent = fmt(t.duration_ms);
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    if (t.img) img.src = t.img;
    row.querySelector('.tv-text').prepend(img);
    row.onclick = (e) => (e.metaKey ? onOpen?.() : onPlay());
    return row;
  }

  // the one shape the DNA analysis reads, whichever API dialect the tracks came in
  const dnaShape = (t) => ({
    duration: { milliseconds: t.duration_ms },
    album: t.album ? { uri: t.album.uri, images: (t.album.images || []).map((i) => ({ url: i.url })) } : null,
    artists: (t.artists || []).map((a, i) => ({ uri: t.artistUris?.[i] || a.uri || '', name: a.name || a })),
    release: { isoString: t.album?.release_date || null },
  });

  // ---------- library: a timeline ----------
  const KINDS = [['all', 'All'], ['playlist', 'Playlists'], ['album', 'Albums'], ['artist', 'Artists']];
  const libFilter = (() => { try { return JSON.parse(localStorage.getItem('tc:libFilter') || '["all"]'); } catch { return ['all']; } })();
  const saveLibFilter = () => { try { localStorage.setItem('tc:libFilter', JSON.stringify(libFilter)); } catch {} };

  async function library(container) {
    const [data, recents] = await Promise.all([libraryData(true), recentContexts()]);
    const kindOf = (i) => (i.uri.startsWith('spotify:album:') ? 'album' : i.uri.startsWith('spotify:artist:') ? 'artist' : 'playlist');
    const items = [];
    items.push({ uri: 'tc:liked', name: 'Liked Songs', sub: `${data.likedTotal} songs`, img: '', kind: 'playlist', pinned: true, onOpen: () => TessApp.go('/liked'), onPlay: () => playLiked() });
    for (const p of data.playlists) items.push({ uri: p.uri, name: p.name, sub: p.owner?.display_name || p.owner?.id || 'Playlist', img: pick(p.images), kind: 'playlist', when: recents.get(p.uri), onOpen: () => TessApp.go('/playlist/' + p.uri.split(':')[2]), onPlay: () => TessSync.play({ context_uri: p.uri }) });
    for (const a of data.albums) items.push({ uri: a.album.uri, name: a.album.name, sub: (a.album.artists || [])[0]?.name || 'Album', img: pick(a.album.images), kind: 'album', when: recents.get(a.album.uri), onOpen: () => TessApp.go('/album/' + a.album.uri.split(':')[2]), onPlay: () => TessSync.play({ context_uri: a.album.uri }) });
    for (const a of data.artists) items.push({ uri: a.uri, name: a.name, sub: 'Artist', img: pick(a.images), kind: 'artist', when: recents.get(a.uri), onOpen: () => TessApp.go('/artist/' + a.uri.split(':')[2]), onPlay: () => TessSync.play({ context_uri: a.uri }) });

    const box = el(`
      <section class="tv-page tv-lib">
        <h2 class="tv-title">Library</h2>
        <div class="tv-libbar"><input type="search" placeholder="Search your library" aria-label="Search your library"></div>
        <div class="tv-chips">${KINDS.map(([k, label]) => `<button class="tv-chip" data-k="${k}">${label}</button>`).join('')}</div>
        <div class="tv-list"></div>
      </section>`);
    const list = box.querySelector('.tv-list');
    const needle = box.querySelector('input');

    const groupOf = (it) => {
      if (it.pinned) return 'Pinned';
      if (!it.when) return 'Not played yet';
      const then = new Date(it.when), now = new Date();
      const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const days = Math.round((day(now) - day(then)) / 864e5);
      if (days <= 0) return 'Today';
      if (days === 1) return 'Yesterday';
      if (days < 7) return 'This week';
      if (days < 31) return 'This month';
      return then.getFullYear() === now.getFullYear() ? then.toLocaleDateString(undefined, { month: 'long' }) : String(then.getFullYear());
    };

    function render() {
      const want = libFilter.includes('all') ? null : new Set(libFilter);
      const q = needle.value.trim().toLowerCase();
      const shown = items.filter((i) => (!want || want.has(i.kind)) && (!q || i.name.toLowerCase().includes(q)));
      shown.sort((a, b) => (b.pinned - a.pinned) || String(b.when || '').localeCompare(String(a.when || '')) || a.name.localeCompare(b.name));
      const frag = document.createDocumentFragment();
      let group = '';
      for (const it of shown) {
        const g = groupOf(it);
        if (g !== group) { group = g; const h = el('<div class="tv-group"></div>'); h.textContent = g; frag.appendChild(h); }
        frag.appendChild(mediaRow(it));
      }
      list.replaceChildren(frag);
    }
    box.querySelectorAll('.tv-chip').forEach((chip) => {
      chip.classList.toggle('on', libFilter.includes(chip.dataset.k));
      chip.onclick = () => {
        const k = chip.dataset.k;
        const idx = libFilter.indexOf(k);
        if (idx >= 0) { if (libFilter.length > 1) libFilter.splice(idx, 1); } else libFilter.push(k);
        if (!libFilter.length) libFilter.push('all');
        saveLibFilter();
        box.querySelectorAll('.tv-chip').forEach((c) => c.classList.toggle('on', libFilter.includes(c.dataset.k)));
        render();
      };
    });
    needle.addEventListener('input', render);
    container.replaceChildren(box);
    render();
  }

  async function playLiked() {
    const all = await TessAPI.likedTracks();
    const uris = all.slice(0, 50).map((x) => x.track.uri).filter((u) => u.startsWith('spotify:track:'));
    if (uris.length) TessSync.play({ uris });
  }

  async function liked(container) {
    const all = await TessAPI.likedTracks();
    const tracks = all.filter((x) => x.track).map((x) => ({ ...shapeApiTrack(x.track), addedAt: x.added_at }));
    const box = el('<section class="tv-page"><h2 class="tv-title">Liked Songs</h2><div class="tv-tracks"></div></section>');
    const list = box.querySelector('.tv-tracks');
    const frag = document.createDocumentFragment();
    tracks.slice(0, 100).forEach((t, i) => frag.appendChild(trackRow(t, i + 1,
      () => TessSync.play({ uris: tracks.slice(i, i + 50).map((x) => x.uri), position: 0 }),
      () => TessApp.go('/album/' + t.album?.uri?.split(':')[2]))));
    list.appendChild(frag);
    if (tracks.length > 100) {
      const more = el('<button class="tv-more"></button>');
      more.textContent = `Show all ${tracks.length} songs`;
      more.onclick = () => { more.remove(); const f = document.createDocumentFragment(); tracks.slice(100).forEach((t, i) => f.appendChild(trackRow(t, i + 101, () => TessSync.play({ uris: tracks.slice(i + 100, i + 150).map((x) => x.uri) })))); list.appendChild(f); };
      list.appendChild(more);
    }
    container.replaceChildren(box);
  }

  // ---------- playlist pages: header wall + DNA + tracks ----------
  function analyse(tracks) {
    const artists = new Map();
    const covers = new Map();
    const years = new Map();
    let ms = 0;
    for (const t of tracks) {
      ms += t.duration?.milliseconds || 0;
      const cover = t.album?.images?.[0]?.url || '';
      if (cover && t.album?.uri) covers.set(t.album.uri, cover);
      for (const a of t.artists || []) {
        const e = artists.get(a.uri) || { uri: a.uri, name: a.name, n: 0, covers: new Map() };
        e.n += 1 / (t.artists.length || 1);
        if (cover) e.covers.set(cover, (e.covers.get(cover) || 0) + 1);
        artists.set(a.uri, e);
      }
      const y = t.release?.isoString ? new Date(t.release.isoString).getUTCFullYear() : null;
      if (y && y > 1900) years.set(y, (years.get(y) || 0) + 1);
    }
    const ranked = [...artists.values()].sort((a, b) => b.n - a.n);
    for (const a of ranked) a.cover = [...a.covers.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '';
    return { tracks: tracks.length, ms, artists: ranked, covers: [...covers.values()], years };
  }

  function buildWall(covers) {
    const wall = el('<div class="tp-wall" aria-hidden="true"><div class="tp-wall-plane"></div></div>');
    const plane = wall.firstElementChild;
    for (let i = 0; i < 8 * 7; i++) {
      const c = document.createElement('i');
      if (covers.length) c.style.backgroundImage = `url("${covers[(i * 7 + Math.floor(i / 8)) % covers.length]}")`;
      plane.appendChild(c);
    }
    return wall;
  }

  function buildDNA(a) {
    const top = a.artists.slice(0, 10);
    const topShare = top.reduce((s, x) => s + x.n, 0);
    const pct = (n) => Math.round((n / a.tracks) * 100);
    const dna = el(`
      <section class="tess-dna" aria-label="What's in this playlist">
        <div class="dna-head"><div><h2>Who's in it</h2><small class="dna-cap"></small></div><div class="dna-stats"></div></div>
        <div class="dna-ribbon" role="list"></div>
        <div class="dna-years"><div class="dna-years-head"><h3>Across the years</h3><small></small></div><div class="dna-bars"></div><div class="dna-axis"></div></div>
      </section>`);
    const hours = a.ms / 3.6e6;
    const stats = [`${a.tracks} songs`, hours >= 1 ? `${hours.toFixed(hours < 10 ? 1 : 0)} hr` : `${Math.round(a.ms / 6e4)} min`, `${a.artists.length} artists`];
    dna.querySelector('.dna-stats').replaceChildren(...stats.map((s) => { const b = el('<span></span>'); b.textContent = s; return b; }));
    dna.querySelector('.dna-cap').textContent = `Your top ${top.length} artists make up ${pct(topShare)}% of it`;
    const ribbon = dna.querySelector('.dna-ribbon');
    for (const art of top) {
      const seg = el('<a class="dna-seg" role="listitem"><span class="dna-name"></span><span class="dna-pct"></span></a>');
      seg.style.setProperty('--w', String(art.n));
      if (art.cover) seg.style.backgroundImage = `url("${art.cover}")`;
      seg.querySelector('.dna-name').textContent = art.name;
      seg.querySelector('.dna-pct').textContent = `${pct(art.n)}% · ${Math.round(art.n)} song${Math.round(art.n) === 1 ? '' : 's'}`;
      seg.onclick = (e) => { e.preventDefault(); TessApp.go('/artist/' + art.uri.split(':')[2]); };
      ribbon.appendChild(seg);
    }
    const ys = [...a.years.keys()].sort((x, y) => x - y);
    if (ys.length) {
      const lo = ys[0], hi = ys[ys.length - 1], max = Math.max(...a.years.values());
      const bars = dna.querySelector('.dna-bars');
      for (let y = lo; y <= hi; y++) {
        const n = a.years.get(y) || 0;
        const b = el('<i></i>');
        b.style.setProperty('--h', (n / max).toFixed(3));
        bars.appendChild(b);
      }
      const decades = new Map();
      for (const [y, n] of a.years) decades.set(Math.floor(y / 10) * 10, (decades.get(Math.floor(y / 10) * 10) || 0) + n);
      const [peak, peakN] = [...decades.entries()].sort((x, y) => y[1] - x[1])[0];
      dna.querySelector('.dna-years small').textContent = `Mostly the ${peak}s (${Math.round((peakN / a.tracks) * 100)}%) · ${lo}–${hi}`;
      const axis = dna.querySelector('.dna-axis');
      for (const y of [lo, Math.round((lo + hi) / 2), hi]) { const s = el('<span></span>'); s.textContent = y; axis.appendChild(s); }
    } else dna.querySelector('.dna-years').remove();
    return dna;
  }

  function shapeApiTrack(t, albumOverride) {
    return {
      id: t.id, uri: t.uri, name: t.name || '',
      artists: (t.artists || []).map((a) => a.name),
      artistUris: (t.artists || []).map((a) => a.uri),
      album: albumOverride || (t.album ? { uri: t.album.uri, name: t.album.name, images: t.album.images || [], release_date: t.album.release_date } : null),
      img: pick(albumOverride?.images || t.album?.images, 120),
      duration_ms: t.duration_ms || 0,
    };
  }

  function header(meta, kindLabel, playWhat) {
    const h = el(`
      <header class="tv-head">
        <span class="tv-cover"><img alt="" draggable="false"></span>
        <small></small><h1></h1><p></p>
        <button class="tv-bigplay" aria-label="Play"><svg width="16" height="18" viewBox="0 0 16 18" fill="currentColor"><path d="M2 1.5l12 7.5L2 16.5z"/></svg></button>
      </header>`);
    const img = h.querySelector('img');
    const coverUrl = pick(meta.images, 300);
    if (coverUrl) img.src = coverUrl;
    h.querySelector('small').textContent = kindLabel;
    h.querySelector('h1').textContent = meta.name || '';
    h.querySelector('p').textContent = meta.sub || '';
    h.querySelector('.tv-bigplay').onclick = () => TessSync.play(playWhat);
    if (coverUrl) window.TessApp?.aurora?.setArtwork(coverUrl);
    return h;
  }

  async function playlist(id, container) {
    const box = el('<section class="tv-page tv-pl"></section>');
    container.replaceChildren(box);
    const [meta, raw] = await Promise.all([
      TessAPI.playlist(id).catch(() => null),
      TessAPI.playlistTracks(id, 600),
    ]);
    if (!meta) { box.appendChild(el('<p class="tv-empty">Playlist not found.</p>')); return; }
    const tracks = raw.filter((x) => x.track).map((x) => shapeApiTrack(x.track));
    const h = header({ images: meta.images, name: meta.name, sub: `${meta.owner?.display_name || meta.owner?.id || ''} · ${tracks.length} songs` }, 'Playlist', { context_uri: meta.uri });
    box.appendChild(h);
    const a = analyse(tracks.map(dnaShape));
    if (a.tracks >= 3) {
      h.appendChild(buildWall(a.covers));
      box.appendChild(buildDNA(a));
    }
    const list = el('<div class="tv-tracks"></div>');
    const frag = document.createDocumentFragment();
    tracks.slice(0, 60).forEach((t, i) => frag.appendChild(trackRow(t, i + 1,
      () => TessSync.play({ context_uri: meta.uri, offsetUri: t.uri }),
      () => t.album?.uri && TessApp.go('/album/' + t.album.uri.split(':')[2]))));
    list.appendChild(frag);
    if (tracks.length > 60) {
      const more = el('<button class="tv-more"></button>');
      more.textContent = `Show all ${tracks.length} songs`;
      more.onclick = () => {
        more.remove();
        const f = document.createDocumentFragment();
        tracks.slice(60).forEach((t, i) => f.appendChild(trackRow(t, i + 61,
          () => TessSync.play({ context_uri: meta.uri, offsetUri: t.uri }),
          () => t.album?.uri && TessApp.go('/album/' + t.album.uri.split(':')[2]))));
        list.appendChild(f);
      };
      list.appendChild(more);
    }
    box.appendChild(list);
  }

  async function album(id, container) {
    const box = el('<section class="tv-page tv-pl"></section>');
    container.replaceChildren(box);
    const [a, raw] = await Promise.all([TessAPI.album(id), TessAPI.albumTracks(id)]);
    if (!a) { box.appendChild(el('<p class="tv-empty">Album not found.</p>')); return; }
    const meta = { images: a.images, name: a.name, sub: `${(a.artists || [])[0]?.name || ''} · ${a.release_date?.slice(0, 4) || ''}` };
    const h = header(meta, 'Album', { context_uri: a.uri });
    box.appendChild(h);
    const list = el('<div class="tv-tracks"></div>');
    const frag = document.createDocumentFragment();
    (raw || []).forEach((t, i) => {
      const full = shapeApiTrack({ ...t, album: null }, { uri: a.uri, name: a.name, images: a.images, release_date: a.release_date });
      frag.appendChild(trackRow({ ...full, artists: (t.artists || []).map((x) => x.name) }, i + 1,
        () => TessSync.play({ context_uri: a.uri, position: i }),
        () => TessApp.go('/artist/' + (t.artists || [])[0]?.id)));
    });
    list.appendChild(frag);
    box.appendChild(list);
  }

  async function artist(id, container) {
    const box = el('<section class="tv-page tv-pl"></section>');
    container.replaceChildren(box);
    const [a, top, albums] = await Promise.all([
      TessAPI.artist(id), TessAPI.artistTop(id).catch(() => null), TessAPI.artistAlbums(id).catch(() => []),
    ]);
    if (!a) { box.appendChild(el('<p class="tv-empty">Artist not found.</p>')); return; }
    const h = header({
      images: a.images, name: a.name,
      sub: `${(a.followers?.total || 0).toLocaleString()} followers`,
    }, 'Artist', { uris: (top?.tracks || []).slice(0, 50).map((t) => t.uri) });
    h.querySelector('.tv-cover').classList.add('round');
    box.appendChild(h);
    if (top?.tracks?.length) {
      const title = el('<h3 class="tv-subtitle">Top songs</h3>');
      box.appendChild(title);
      const list = el('<div class="tv-tracks"></div>');
      const frag = document.createDocumentFragment();
      top.tracks.slice(0, 10).forEach((t, i) => {
        const full = shapeApiTrack(t);
        frag.appendChild(trackRow(full, i + 1,
          () => TessSync.play({ uris: top.tracks.slice(i, i + 50).map((x) => x.uri) }),
          () => t.album?.uri && TessApp.go('/album/' + t.album.uri.split(':')[2])));
      });
      list.appendChild(frag);
      box.appendChild(list);
    }
    if (albums.length) {
      box.appendChild(el('<h3 class="tv-subtitle">Albums</h3>'));
      const grid = el('<div class="tv-grid"></div>');
      albums.slice(0, 12).forEach((al) => {
        const card = el('<button class="tv-card"><span class="tv-art"><img alt="" draggable="false"></span><b></b><small></small></button>');
        const img = card.querySelector('img');
        const url = pick(al.images, 200);
        if (url) img.src = url;
        card.querySelector('b').textContent = al.name;
        card.querySelector('small').textContent = al.release_date?.slice(0, 4) || '';
        card.onclick = () => TessApp.go('/album/' + al.id);
        grid.appendChild(card);
      });
      box.appendChild(grid);
    }
  }

  // ---------- search ----------
  async function search(container, preset = '') {
    const box = el(`
      <section class="tv-page">
        <div class="tv-libbar tv-searchbar"><input type="search" placeholder="Songs, artists, albums, playlists" aria-label="Search" value=""></div>
        <div class="tv-results"></div>
      </section>`);
    const input = box.querySelector('input');
    const results = box.querySelector('.tv-results');
    input.value = preset;
    let seq = 0;
    let timer = 0;
    async function run() {
      const q = input.value.trim();
      const me = ++seq;
      if (!q) { results.replaceChildren(); return; }
      const r = await TessAPI.search(q).catch(() => null);
      if (me !== seq) return;
      if (!r) return;
      const frag = document.createDocumentFragment();
      for (const t of r.tracks?.items || []) {
        const full = shapeApiTrack(t);
        frag.appendChild(trackRow(full, '', () => TessSync.play({ uris: [t.uri] }), () => t.album?.uri && TessApp.go('/album/' + t.album.uri.split(':')[2])));
      }
      const others = [
        ...(r.artists?.items || []).map((x) => ({ uri: x.uri, name: x.name, sub: 'Artist', img: pick(x.images), kind: 'artist', onOpen: () => TessApp.go('/artist/' + x.id), onPlay: () => TessSync.play({ context_uri: x.uri }) })),
        ...(r.albums?.items || []).map((x) => ({ uri: x.uri, name: x.name, sub: 'Album · ' + ((x.artists || [])[0]?.name || ''), img: pick(x.images), kind: 'album', onOpen: () => TessApp.go('/album/' + x.id), onPlay: () => TessSync.play({ context_uri: x.uri }) })),
        ...(r.playlists?.items || []).map((x) => ({ uri: x.uri, name: x.name, sub: 'Playlist · ' + (x.owner?.display_name || ''), img: pick(x.images), kind: 'playlist', onOpen: () => TessApp.go('/playlist/' + x.id), onPlay: () => TessSync.play({ context_uri: x.uri }) })),
      ];
      for (const it of others) frag.appendChild(mediaRow(it));
      results.replaceChildren(frag);
    }
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
    container.replaceChildren(box);
    if (preset) run();
  }

  // ---------- on this day ----------
  // Liked on today's date in earlier years — or within a few days of it.
  let otdDay = '';
  async function onThisDay(container) {
    const today = new Date();
    if (otdDay === today.toDateString()) return;
    otdDay = today.toDateString();
    let all = [];
    try { all = await TessAPI.likedTracks(); } catch { return; }
    const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const gap = (t) => {
      const a = new Date(t.added_at);
      return Math.abs(dayStart(new Date(today.getFullYear(), a.getMonth(), a.getDate())) - dayStart(today)) / 864e5;
    };
    const past = all.filter((t) => t.added_at && new Date(t.added_at).getFullYear() < today.getFullYear());
    let picks = past.filter((t) => gap(t) === 0);
    let title = 'On this day';
    if (!picks.length) { picks = past.filter((t) => gap(t) <= 3); title = 'This week, years ago'; }
    if (!picks.length) { picks = past.filter((t) => gap(t) <= 7); title = 'Around now, years ago'; }
    if (!picks.length) { container.hidden = true; return; }
    picks.sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at));
    const years = [...new Set(picks.map((t) => today.getFullYear() - new Date(t.added_at).getFullYear()))];
    const box = el('<section class="tv-otd"><div class="tv-group"></div><small></small><div class="tv-grid"></div></section>');
    box.querySelector('.tv-group').textContent = title;
    box.querySelector('small').textContent = `Saved ${years.map((y) => (y === 1 ? 'a year' : `${y} years`)).join(', ')} ago`;
    const grid = box.querySelector('.tv-grid');
    picks.slice(0, 12).forEach((x) => {
      const t = shapeApiTrack(x.track);
      const card = el('<button class="tv-card tv-song"><span class="tv-art"><img alt="" draggable="false"></span><b></b><small></small></button>');
      const img = card.querySelector('img');
      if (t.img) img.src = t.img;
      card.querySelector('b').textContent = t.name;
      card.querySelector('small').textContent = t.artists.join(', ');
      card.onclick = () => TessSync.play({ uris: [x.track.uri] });
      grid.appendChild(card);
    });
    container.replaceChildren(box);
    container.hidden = false;
  }

  // ---------- hash router ----------
  async function route(hash, container) {
    const path = hash.replace(/^#/, '');
    let m;
    if ((m = path.match(/^\/playlist\/(.+)$/))) return playlist(m[1], container);
    if ((m = path.match(/^\/album\/(.+)$/))) return album(m[1], container);
    if ((m = path.match(/^\/artist\/(.+)$/))) return artist(m[1], container);
    if (path === '/liked') return liked(container);
    if (path.startsWith('/search')) return search(container, decodeURIComponent(path.split('?q=')[1] || ''));
    if (path === '/library') return library(container);
    return 'home';
  }

  return { route, library, search, onThisDay, libraryData, recentContexts, pick, fmt, el };
})();
