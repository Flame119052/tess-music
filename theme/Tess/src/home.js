// Tess Music — Home ("Listen Now").
// A dated greeting, a featured card for the first thing in your top shelf (usually your Daily Mix 1),
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
  const hero = el(`
    <section id="tess-home-hero" class="tess-home-enter" aria-label="Featured">
      <div class="thh-content">
        <div class="thh-badge">Featured</div>
        <a class="thh-title" draggable="false"></a>
        <div class="thh-desc"></div>
        <div class="thh-actions">
          <button class="thh-play"><svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor"><path d="M1 1.5l9.5 5.5L1 12.5z"/></svg><span>Play</span></button>
          <a class="thh-open" draggable="false">Open</a>
        </div>
      </div>
      <a class="thh-art" draggable="false" aria-hidden="true" tabindex="-1"><img alt=""></a>
    </section>`);
  onDispose(() => { masthead.remove(); hero.remove(); });

  const pathOf = (uri) => { const [, type, id] = uri.split(':'); return `/${type}/${id}`; };
  let featured = null;

  // Tint the card with the artwork's average colour (one tiny canvas read per new picture).
  const tintCache = new Map();
  function tint(src) {
    if (tintCache.has(src)) return Promise.resolve(tintCache.get(src));
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas'); c.width = c.height = 8;
          const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 8, 8);
          const d = ctx.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
          const n = d.length / 4; const rgb = `${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)}`;
          tintCache.set(src, rgb); resolve(rgb);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function pickFeatured() {
    for (const card of document.querySelectorAll('[data-testid="home-page"] [data-testid="component-shelf"] [data-encore-id="card"]')) {
      const uri = card.querySelector('[id^="card-title-spotify:"]')?.id.replace('card-title-', '');
      if (!uri || !/^spotify:(playlist|album|artist|show):/.test(uri)) continue;
      return {
        uri,
        title: card.querySelector('[data-encore-id="cardTitle"]')?.textContent?.trim() || '',
        desc: card.querySelector('[data-encore-id="cardSubtitle"]')?.textContent?.trim() || '',
        img: card.querySelector('img')?.src || '',
      };
    }
    return null;
  }

  const htmlEl = document.documentElement;
  onDispose(() => htmlEl.classList.remove('tess-home'));
  function render() {
    htmlEl.classList.toggle('tess-home', isHome());
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

    const f = pickFeatured();
    if (!f || !shortcuts) { hero.remove(); return; }
    if (hero.nextElementSibling !== shortcuts) shortcuts.before(hero);
    if (featured?.uri === f.uri && featured.img === f.img) return;
    featured = f;
    hero.querySelector('.thh-title').textContent = f.title;
    hero.querySelector('.thh-desc').textContent = f.desc;
    hero.querySelector('.thh-art img').src = f.img;
    for (const a of hero.querySelectorAll('a')) a.href = pathOf(f.uri);
    hero.querySelector('.thh-play').onclick = () => Spicetify.Player.playUri(f.uri);
    tint(f.img).then((rgb) => { if (rgb && featured === f) hero.style.setProperty('--thh-tint', rgb); });
  }

  // Spotify rebuilds the page as it loads and when filters change: re-place on route changes and on a slow,
  // visibility-aware beat that does nothing away from home.
  const unlisten = Spicetify.Platform.History.listen(() => { setTimeout(render, 60); setTimeout(render, 400); });
  onDispose(() => typeof unlisten === 'function' && unlisten());
  const beat = setInterval(() => { if (!document.hidden && isHome()) render(); }, 1000);
  onDispose(() => clearInterval(beat));
  render();
})();
