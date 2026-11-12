// Tess Music — playlist pages.
// The header gets a slowly drifting, tilted wall of the playlist's own album covers. Under the action bar sits the
// playlist's DNA: a ribbon split by how much of it each artist takes up (each slice filled with their artwork), a
// small chart of when the songs came out, and the headline numbers. Everything is read from Spotify's playlist data.
(async function tessPlaylist() {
  window.__tessPlaylist?.dispose?.();
  const disposers = [];
  const onDispose = (fn) => disposers.push(fn);
  const self = {};
  window.__tessPlaylist = self;
  self.dispose = () => disposers.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} });
  while (!window.Spicetify?.Platform?.PlaylistAPI || !Spicetify.Platform.History) await new Promise((r) => setTimeout(r, 300));
  if (window.__tessPlaylist !== self) return; // a newer copy started while this one waited

  const route = () => Spicetify.Platform.History.location?.pathname || '';
  const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
  const img = (u) => (u?.startsWith('spotify:image:') ? 'https://i.scdn.co/image/' + u.split(':')[2] : u || '');
  const cache = new Map();

  async function loadPlaylist(uri) {
    if (cache.has(uri)) return cache.get(uri);
    const p = (async () => {
      let items = [];
      for (let off = 0; off < 10000; off += 500) {
        const r = await Spicetify.Platform.PlaylistAPI.getContents(uri, { limit: 500, offset: off });
        items = items.concat(r.items || []);
        if (!r.items || r.items.length < 500) break;
      }
      return items.filter((t) => t.type === 'track' || t.uri?.startsWith('spotify:track:'));
    })();
    cache.set(uri, p);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return p;
  }

  function analyse(tracks) {
    const artists = new Map();
    const covers = new Map();
    const years = new Map();
    let ms = 0;
    for (const t of tracks) {
      ms += t.duration?.milliseconds || 0;
      const cover = img(t.album?.images?.[0]?.url);
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

  // ---------- header cover wall ----------
  function buildWall(covers) {
    const wall = el('<div class="tp-wall" aria-hidden="true"><div class="tp-wall-plane"></div></div>');
    const plane = wall.firstElementChild;
    const pool = covers.length ? covers : [];
    const cells = 8 * 7;
    for (let i = 0; i < cells; i++) {
      const c = document.createElement('i');
      if (pool.length) c.style.backgroundImage = `url("${pool[(i * 7 + Math.floor(i / 8)) % pool.length]}")`;
      plane.appendChild(c);
    }
    return wall;
  }

  // ---------- DNA ----------
  function buildDNA(a) {
    // the ribbon compares your top artists with each other; their combined share of the playlist is the caption
    const top = a.artists.slice(0, 10);
    const topShare = top.reduce((s, x) => s + x.n, 0);
    const others = 0;
    const pct = (n) => Math.round((n / a.tracks) * 100);
    const dna = el(`
      <section id="tess-dna" aria-label="What's in this playlist">
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
      const seg = el('<a class="dna-seg" role="listitem" draggable="false"><span class="dna-name"></span><span class="dna-pct"></span></a>');
      seg.style.setProperty('--w', String(art.n));
      if (art.cover) seg.style.backgroundImage = `url("${art.cover}")`;
      seg.querySelector('.dna-name').textContent = art.name;
      seg.querySelector('.dna-pct').textContent = `${pct(art.n)}% · ${Math.round(art.n)} song${Math.round(art.n) === 1 ? '' : 's'}`;
      seg.title = `${art.name} — ${Math.round(art.n)} songs`;
      seg.dataset.tessUri = art.uri;
      seg.onclick = (e) => { e.preventDefault(); Spicetify.Platform.History.push('/artist/' + art.uri.split(':')[2]); };
      ribbon.appendChild(seg);
    }
    if (others >= 1) {
      const seg = el('<div class="dna-seg dna-others" role="listitem"><span class="dna-name">Everyone else</span><span class="dna-pct"></span></div>');
      seg.style.setProperty('--w', String(others));
      seg.querySelector('.dna-pct').textContent = `${pct(others)}% · ${a.artists.length - top.length} artists`;
      ribbon.appendChild(seg);
    }

    // years: one bar per year from the first to the last, height by songs, peak decade called out
    const ys = [...a.years.keys()].sort((x, y) => x - y);
    if (ys.length) {
      const lo = ys[0], hi = ys[ys.length - 1], max = Math.max(...a.years.values());
      const bars = dna.querySelector('.dna-bars');
      for (let y = lo; y <= hi; y++) {
        const n = a.years.get(y) || 0;
        const b = el('<i></i>');
        b.style.setProperty('--h', (n / max).toFixed(3));
        b.title = `${y}: ${n} song${n === 1 ? '' : 's'}`;
        bars.appendChild(b);
      }
      const decades = new Map();
      for (const [y, n] of a.years) decades.set(Math.floor(y / 10) * 10, (decades.get(Math.floor(y / 10) * 10) || 0) + n);
      const [peak, peakN] = [...decades.entries()].sort((x, y) => y[1] - x[1])[0];
      dna.querySelector('.dna-years small').textContent = `Mostly the ${peak}s (${Math.round((peakN / a.tracks) * 100)}%) · ${lo}–${hi}`;
      const axis = dna.querySelector('.dna-axis');
      for (const y of [lo, Math.round((lo + hi) / 2), hi]) { const s = el('<span></span>'); s.textContent = y; axis.appendChild(s); }
    } else {
      dna.querySelector('.dna-years').remove();
    }
    return dna;
  }

  let current = '';
  async function render() {
    const m = route().match(/^\/playlist\/([A-Za-z0-9]+)/);
    if (!m) { current = ''; return; }
    const uri = 'spotify:playlist:' + m[1];
    const page = document.querySelector('[data-testid="playlist-page"]');
    const header = page?.querySelector('.main-entityHeader-container');
    const actionBar = page?.querySelector('[data-testid="action-bar"]');
    if (!page || !header || !actionBar) return;
    if (current === uri && page.querySelector('#tess-dna') && header.querySelector('.tp-wall')) return;
    current = uri;
    let a;
    // wait until the browser is idle so building this never competes with Spotify drawing the page you clicked
    await new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 1200 }) : setTimeout(r, 300)));
    try { a = analyse(await loadPlaylist(uri)); } catch { return; }
    if (route() !== '/playlist/' + m[1] || a.tracks < 3) return;
    page.querySelector('#tess-dna')?.remove();
    header.querySelector('.tp-wall')?.remove();
    header.classList.add('tp-header');
    const tint = header.querySelector('[class*="mixingBackground"]')?.style.getPropertyValue('--background-base-min-contrast');
    const wall = buildWall(a.covers);
    if (tint) wall.style.setProperty('--tp-tint', tint.trim());
    header.prepend(wall);
    actionBar.after(buildDNA(a));
  }
  onDispose(() => document.querySelectorAll('#tess-dna, .tp-wall').forEach((n) => n.remove()));
  const unlisten = Spicetify.Platform.History.listen(() => { current = ''; setTimeout(render, 300); setTimeout(render, 1200); });
  onDispose(() => typeof unlisten === 'function' && unlisten());
  const beat = setInterval(() => { if (!document.hidden && route().startsWith('/playlist/')) render(); }, 2000);
  onDispose(() => clearInterval(beat));
  render();
})();
