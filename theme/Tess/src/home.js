// Tess Music — Home ("Listen Now").
// A dated greeting, a tall DJ card you can tilt, beside it your recently played (or your mixes, per Settings),
// then Spotify's own shortcuts and shelves, restyled in home.css. Everything still clicks through to Spotify.
(async function tessHome() {
  window.__tessHome?.dispose?.();
  const disposers = [];
  const onDispose = (fn) => disposers.push(fn);
  window.__tessHome = { dispose: () => disposers.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} }) };
  while (!window.Spicetify?.Platform?.History || !Spicetify.Player) await new Promise((r) => setTimeout(r, 300));

  const route = () => Spicetify.Platform.History.location?.pathname || '';
  const isHome = () => route() === '/' || route() === '/home';
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  let firstName = '';
  Spicetify.Platform.UserAPI?.getUser?.().then((u) => { firstName = (u?.displayName || '').split(' ')[0]; render(); }).catch(() => {});

  const greeting = () => {
    const h = new Date().getHours();
    return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  };
  const eyebrow = () => new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const masthead = el('<header id="tess-home-masthead" class="contentSpacing tess-home-enter"><div class="thm-eyebrow"></div><h1 class="thm-title"></h1></header>');
  // The top of home: your DJ as a tall card you can tilt, and beside it what you played last (or your mixes).
  const DJ_URI = 'spotify:playlist:37i9dQZF1EYkqdzj48dyYq';
  const hero = el(`
    <section id="tess-home-hero" class="tess-home-enter" aria-label="DJ and recently played">
      <div class="thd-stage">
        <a class="thd-card" draggable="false">
          <span class="thd-art"></span>
          <span class="thd-glare"></span>
          <span class="thd-label"><b>DJ</b><small>Music and commentary picked for you, right now</small></span>
          <button class="thd-play" aria-label="Play DJ"><svg width="14" height="16" viewBox="0 0 12 14" fill="currentColor"><path d="M1 1.5l9.5 5.5L1 12.5z"/></svg></button>
        </a>
      </div>
      <div class="thr">
        <div class="thr-head"><h2></h2></div>
        <div class="thr-grid"></div>
      </div>
    </section>`);
  onDispose(() => { masthead.remove(); hero.remove(); });

  const pathOf = (uri) => { const [, type, id] = uri.split(':'); return `/${type}/${id}`; };

  const homeRecent = () => { try { return JSON.parse(localStorage.getItem('tess:settings') || '{}').homeRecent !== false; } catch { return true; } };
  const imageOf = (u) => (u?.startsWith('spotify:mosaic:') ? 'https://mosaic.scdn.co/300/' + u.split(':').slice(2).join('') : u?.startsWith('spotify:image:') ? 'https://i.scdn.co/image/' + u.split(':')[2] : u || '');

  async function recentItems() {
    try {
      const list = await Spicetify.Platform.RecentlyPlayedAPI.getContexts();
      return (list || []).filter((c) => c.uri !== DJ_URI && c.uri?.startsWith('spotify:')).slice(0, 6)
        .map((c) => ({ uri: c.uri, title: c.name, sub: c.type === 'artist' ? 'Artist' : c.owner?.displayName || c.type.replace(/^./, (x) => x.toUpperCase()), img: imageOf(c.images?.[0]?.url) }));
    } catch { return []; }
  }
  // Your mixes are read from home's own first shelf (Spotify's "Made For" row), so they match what Spotify picked.
  function mixItems() {
    const shelf = document.querySelector('[data-testid="home-page"] [data-testid="component-shelf"]');
    return [...(shelf?.querySelectorAll('[data-encore-id="card"]') || [])].map((card) => ({
      uri: card.querySelector('[id^="card-title-spotify:"]')?.id.replace('card-title-', ''),
      title: card.querySelector('[data-encore-id="cardTitle"]')?.textContent?.trim() || '',
      sub: card.querySelector('[data-encore-id="cardSubtitle"]')?.textContent?.trim() || '',
      img: card.querySelector('img')?.src || '',
    })).filter((i) => i.uri && i.img).slice(0, 6);
  }

  let shown = '';
  async function fillRight() {
    const recent = homeRecent();
    document.documentElement.classList.toggle('tess-home-recent', recent && isHome());
    const items = recent ? await recentItems() : mixItems();
    const key = recent + JSON.stringify(items.map((i) => i.uri));
    if (!items.length || key === shown) return;
    shown = key;
    hero.querySelector('.thr-head h2').textContent = recent ? 'Recently played' : 'Made for you';
    const grid = hero.querySelector('.thr-grid');
    grid.innerHTML = '';
    for (const it of items) {
      const t = el('<a class="thr-item" draggable="false"><span class="thr-art"><img alt=""></span><span class="thr-text"><b></b><small></small></span><button class="thr-play" aria-label="Play"><svg width="11" height="13" viewBox="0 0 12 14" fill="currentColor"><path d="M1 1.5l9.5 5.5L1 12.5z"/></svg></button></a>');
      t.href = pathOf(it.uri);
      t.querySelector('img').src = it.img;
      if (it.uri.startsWith('spotify:artist:')) t.classList.add('round');
      t.querySelector('b').textContent = it.title;
      t.querySelector('small').textContent = it.sub;
      t.querySelector('.thr-play').onclick = (e) => { e.preventDefault(); e.stopPropagation(); Spicetify.Player.playUri(it.uri); };
      grid.appendChild(t);
    }
  }

  // 3D tilt: the card leans toward the pointer with a moving glare; only transforms, so it stays on the GPU's cheap path.
  const card = hero.querySelector('.thd-card');
  card.href = pathOf(DJ_URI);
  card.querySelector('.thd-art').style.backgroundImage = 'url("https://lexicon-assets.spotifycdn.com/DJ-Beta-CoverArt-300.jpg")';
  card.querySelector('.thd-play').onclick = (e) => { e.preventDefault(); e.stopPropagation(); Spicetify.Player.playUri(DJ_URI); };
  let tiltFrame = 0;
  card.addEventListener('pointermove', (e) => {
    cancelAnimationFrame(tiltFrame);
    tiltFrame = requestAnimationFrame(() => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      card.style.setProperty('--rx', ((0.5 - y) * 14).toFixed(2) + 'deg');
      card.style.setProperty('--ry', ((x - 0.5) * 16).toFixed(2) + 'deg');
      card.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
      card.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
    });
  });
  card.addEventListener('pointerleave', () => { cancelAnimationFrame(tiltFrame); card.style.removeProperty('--rx'); card.style.removeProperty('--ry'); });
  window.addEventListener('tess:settings', fillRight);
  onDispose(() => window.removeEventListener('tess:settings', fillRight));

  const htmlEl = document.documentElement;
  onDispose(() => htmlEl.classList.remove('tess-home', 'tess-home-recent'));
  function render() {
    htmlEl.classList.toggle('tess-home', isHome());
    if (!isHome()) htmlEl.classList.remove('tess-home-recent');
    if (!isHome()) return;
    const page = document.querySelector('[data-testid="home-page"]');
    if (!page) return;
    // the All / Music / Podcasts row is a sticky bar just above the page; the greeting goes right before it
    let chipRow = document.querySelector('#main-view [data-encore-id="chip"]');
    while (chipRow && getComputedStyle(chipRow).position !== 'sticky') chipRow = chipRow.parentElement;
    const shortcuts = page.querySelector('.view-homeShortcutsGrid-shortcuts');

    masthead.querySelector('.thm-eyebrow').textContent = eyebrow();
    masthead.querySelector('.thm-title').textContent = firstName ? `${greeting()}, ${firstName}` : greeting();
    if (chipRow && masthead.nextElementSibling !== chipRow) chipRow.before(masthead);

    if (!shortcuts) { hero.remove(); return; }
    if (hero.nextElementSibling !== shortcuts) shortcuts.before(hero);
    fillRight();
  }

  // Spotify rebuilds the page as it loads and when filters change: re-place on route changes and on a slow,
  // visibility-aware beat that does nothing away from home.
  const unlisten = Spicetify.Platform.History.listen(() => { setTimeout(render, 60); setTimeout(render, 400); });
  onDispose(() => typeof unlisten === 'function' && unlisten());
  const beat = setInterval(() => { if (!document.hidden && isHome()) render(); }, 1000);
  onDispose(() => clearInterval(beat));
  render();
})();
