// Tess Music — Spicetify theme script.
// Adds the floating playing bar, the full-screen Now Playing view with synced lyrics,
// the artwork-tinted window, Tess settings, and the full-height artist header.
// Everything reads from and drives Spotify's own player.
(async function tess() {
  window.__tess?.dispose?.();
  const disposers = [];
  const onDispose = (fn) => disposers.push(fn);
  const self = { dispose: () => disposers.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} }) };
  window.__tess = self;

  const ready = () =>
    window.Spicetify?.Player?.data !== undefined &&
    Spicetify.Platform?.History &&
    Spicetify.CosmosAsync &&
    Spicetify.GraphQL?.Definitions &&
    document.querySelector('[data-testid="now-playing-bar"]');
  while (!ready()) await new Promise((r) => setTimeout(r, 300));
  if (window.__tess !== self) return; // a newer copy started while this one waited

  const P = Spicetify.Player;
  const el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const mount = (node, parent = document.body) => { parent.appendChild(node); onDispose(() => node.remove()); return node; };
  // timers do nothing while the window is hidden or minimised
  // A copy of this script that is no longer the newest stops itself at its next tick, so two copies can never fight.
  const stale = () => window.__tess !== self;
  const every = (ms, fn) => { const id = setInterval(() => { if (stale()) return clearInterval(id); if (!document.hidden) fn(); }, ms); onDispose(() => clearInterval(id)); };
  // Run placement work the moment Spotify draws something (at most once a frame), with a slow timer as a backup.
  // This replaces polling, which made Tess's pieces appear seconds after Spotify's page.
  const placers = [];
  let placeQueued = false;
  const runPlacers = () => {
    placeQueued = false;
    if (stale()) return domWatch.disconnect();
    for (const fn of placers) { try { fn(); } catch {} }
  };
  // Ignore changes that can't affect placement: the player clock ticking, and Tess's own pieces updating.
  const IGNORE = '[data-testid="now-playing-bar"], #tess-bar, #tess-np, #tess-timeline, .tess-side-lyrics, .tess-cover-wrap, #tess-dial, #tess-otd, #tess-dna, .tess-marquee';
  const relevant = (records) => records.some((m) => {
    const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    return t && !t.closest(IGNORE);
  });
  const domWatch = new MutationObserver((records) => {
    if (placeQueued || !relevant(records)) return;
    placeQueued = true;
    requestAnimationFrame(runPlacers);
  });
  const startWatch = () => { const root = document.querySelector('.Root') || document.body; domWatch.observe(root, { childList: true, subtree: true }); };
  onDispose(() => domWatch.disconnect());
  const onDraw = (fn, backupMs = 2500) => { placers.push(fn); every(backupMs, fn); };
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); onDispose(() => target.removeEventListener(type, fn, opts)); };
  const imageUrl = (u) => (u && u.startsWith('spotify:image:') ? 'https://i.scdn.co/image/' + u.split(':')[2] : u || '');
  // Blurred-artwork backgrounds are painted small on a canvas and stretched by the GPU. It looks like a huge
  // CSS blur but costs a tiny fraction of the GPU memory and work.
  const artImages = new Map();
  const trackCanvasCache = new Map();
  function loadArt(url) {
    if (!url) return Promise.resolve(null);
    if (!artImages.has(url)) {
      artImages.set(url, new Promise((r) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => r(i); i.onerror = () => r(null); i.src = url; }));
      if (artImages.size > 6) artImages.delete(artImages.keys().next().value);
    }
    return artImages.get(url);
  }
  const GLOW_LAYERS = [[0.5, 0.5, 1.5, 0.85, 1 / 70], [0.7, 0.5, 1.1, 0.55, -1 / 95], [0.25, 0.75, 0.9, 0.45, 1 / 120]];
  function paintGlow(canvas, img, seconds, layers = GLOW_LAYERS) {
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#0b0b0d';
    ctx.fillRect(0, 0, w, h);
    if (!img) return;
    ctx.filter = 'blur(5px) saturate(160%)';
    for (const [cx, cy, size, alpha, speed] of layers) {
      const d = size * Math.max(w, h);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx * w, cy * h);
      ctx.rotate(seconds * speed * 2 * Math.PI);
      ctx.drawImage(img, -d / 2, -d / 2, d, d);
      ctx.restore();
    }
  }
  const item = () => P.data?.item;
  const meta = () => item()?.metadata || {};
  const artUrl = () => imageUrl(meta().image_xlarge_url || meta().image_large_url || meta().image_url);
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const spotifyButton = (sel) => document.querySelector(`[data-testid="now-playing-bar"] ${sel}`);
  const route = () => Spicetify.Platform.History.location?.pathname || '';

  // ---------------- settings ----------------
  const DEFAULTS = { npStyle: 'cover', coverVideo: true, panelVideo: true, artistVideo: true, tintWindow: true, sideLyrics: true, circadian: true };
  const settings = (() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tess:settings') || '{}') }; } catch { return { ...DEFAULTS }; }
  })();
  const saveSettings = () => { try { localStorage.setItem('tess:settings', JSON.stringify(settings)); } catch {} };

  const html = document.documentElement;
  html.classList.add('tess');
  onDispose(() => html.classList.remove('tess', 'tess-artist', 'tess-tint', 'tess-hero-light'));
  const applySettings = () => {
    html.classList.toggle('tess-tint', settings.tintWindow);
    html.classList.toggle('tess-side-lyrics-off', !settings.sideLyrics);
  };
  applySettings();

  // Tess's options live in Spotify's own Settings page, in a "Theme" section built from Spotify's row markup.
  const THEME_ROWS = [
    ['coverVideo', 'Animated artwork in the full-screen player', 'Plays the song’s looping Canvas video in place of the album art when it has one.'],
    ['panelVideo', 'Animated artwork in the Now Playing panel', 'Loops the Canvas inside the square cover in the right-hand panel.'],
    ['artistVideo', 'Moving video on artist pages', 'Fills the top of an artist’s page with a Canvas from their top songs; it blurs as you scroll.'],
    ['sideLyrics', 'Live lyrics in the Now Playing panel', 'Synced lyrics that follow the song. Off shows Spotify’s preview card.'],
    ['tintWindow', 'Tint the window with the artwork colours', 'The panels pick up the colours of what’s playing.'],
    ['circadian', 'Follow the time of day', 'Warm in the morning, neutral midday, golden in the evening, dim and low in blue at night.'],
  ];
  const settingChanged = () => { saveSettings(); applySettings(); syncTrack(); onRoute(); window.dispatchEvent(new Event('tess:settings')); };
  function buildThemeSection() {

    if (!route().startsWith('/preferences') || document.getElementById('tess-theme-settings')) return;
    const sections = [...document.querySelectorAll('#main-view h2')].map((h) => h.parentElement).filter((sct) => sct.querySelector('[data-settings-row]'));
    const template = sections.find((sct) => sct.querySelector('[data-settings-row] input[type="checkbox"]'));
    if (!template || sections.length < 2) return;
    const section = template.cloneNode(true);
    section.id = 'tess-theme-settings';
    section.querySelector('h2').textContent = 'Theme';
    const rowTemplate = section.querySelector('[data-settings-row]:has(input[type="checkbox"])');
    section.querySelectorAll('[data-settings-row]').forEach((r) => r.remove());
    const divider = section.querySelector('hr');
    for (const [key, title, hint] of THEME_ROWS) {
      const row = rowTemplate.cloneNode(true);
      const id = 'tess.settings.' + key;
      const textBox = row.querySelector('label[for]').parentElement;
      textBox.innerHTML = '';
      const label = el('<label class="e-101040-text encore-text-body-small encore-internal-color-text-base" data-encore-id="text"></label>');
      label.htmlFor = id;
      label.textContent = title;
      const sub = el('<span class="e-101040-text encore-text-marginal encore-internal-color-text-subdued tess-set-hint" data-encore-id="text"></span>');
      sub.textContent = hint;
      textBox.append(label, sub);
      const input = row.querySelector('input[type="checkbox"]');
      input.id = id;
      input.checked = !!settings[key];
      input.onchange = () => { settings[key] = input.checked; settingChanged(); };
      divider ? divider.before(row) : section.appendChild(row);
    }
    // version, update channel and the welcome again
    const meta = el('<p class="tess-set-meta"></p>');
    meta.textContent = `Tess ${window.__tessVersion || 'dev'} · ${settings.channel === 'beta' ? 'Beta updates' : 'Stable updates'} · `;
    const ch = el('<button class="tess-set-link"></button>');
    ch.textContent = settings.channel === 'beta' ? 'Switch to stable' : 'Get beta updates';
    ch.onclick = () => { settings.channel = settings.channel === 'beta' ? 'stable' : 'beta'; saveSettings(); try { localStorage.removeItem('tess:bundle'); } catch {} location.reload(); };
    const again = el('<button class="tess-set-link"> · Show welcome</button>');
    again.onclick = () => { try { localStorage.removeItem('tess:onboarded'); } catch {} onboarding(); };
    meta.append(ch, again);
    section.querySelector('h2').after(meta);
    sections[1].before(section);
    onDispose(() => section.remove());
    if (pendingThemeScroll) { pendingThemeScroll = false; section.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  let pendingThemeScroll = false;
  function openSettings() {
    pendingThemeScroll = true;
    if (typeof closeNP === 'function') closeNP();
    if (!route().startsWith('/preferences')) Spicetify.Platform.History.push('/preferences');
    else { document.getElementById('tess-theme-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); pendingThemeScroll = false; }
  }
  onDraw(buildThemeSection);
  if (Spicetify.Menu?.Item) {
    const menuItem = new Spicetify.Menu.Item('Tess Music settings', false, openSettings);
    menuItem.register();
    onDispose(() => menuItem.deregister());
  }

  // One icon family: 24-unit grid, 1.75 strokes, round caps and joins, soft filled glyphs for transport,
  // so every control reads as part of the same object (SF Symbols' rules, drawn for Tess).
  const ico = (w, h, body, fill = false) =>
    `<svg viewBox="0 0 24 24" width="${w}" height="${h}" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;
  const I = {
    shuffle: ico(19, 19, '<path d="M3 7h3.2c2 0 3.1.9 4.2 2.7l3.2 4.6c1.1 1.8 2.2 2.7 4.2 2.7H21"/><path d="M3 17h3.2c1.4 0 2.4-.5 3.2-1.4"/><path d="M14.4 8.4c.8-.9 1.8-1.4 3.2-1.4H21"/><path d="M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5"/>'),
    repeat: ico(19, 19, '<path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19"/><path d="M16.5 3.5 19 6l-2.5 2.5"/><path d="M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5"/><path d="M7.5 20.5 5 18l2.5-2.5"/>'),
    prev: ico(26, 26, '<path d="M11.2 6.2a1 1 0 0 1 1.6.8v10a1 1 0 0 1-1.6.8L4.6 12.8a1 1 0 0 1 0-1.6z"/><path d="M19.2 6.2a1 1 0 0 1 1.6.8v10a1 1 0 0 1-1.6.8l-6.6-5a1 1 0 0 1 0-1.6z"/>', true),
    next: ico(26, 26, '<path d="M12.8 6.2a1 1 0 0 0-1.6.8v10a1 1 0 0 0 1.6.8l6.6-5a1 1 0 0 0 0-1.6z"/><path d="M4.8 6.2a1 1 0 0 0-1.6.8v10a1 1 0 0 0 1.6.8l6.6-5a1 1 0 0 0 0-1.6z"/>', true),
    pause: ico(22, 22, '<rect x="5.5" y="4" width="4.6" height="16" rx="1.6"/><rect x="13.9" y="4" width="4.6" height="16" rx="1.6"/>', true),
    play: ico(22, 22, '<path d="M7.6 4.3a1.3 1.3 0 0 0-2 1.1v13.2a1.3 1.3 0 0 0 2 1.1l10.4-6.6a1.3 1.3 0 0 0 0-2.2z"/>', true),
    lyrics: ico(19, 19, '<path d="M20 12.2c0 4-3.6 7.3-8 7.3-1.1 0-2.2-.2-3.1-.6L4 20l1.2-3.5C4.4 15.3 4 13.8 4 12.2 4 8.1 7.6 4.9 12 4.9s8 3.2 8 7.3z"/><path d="M9 11.2h.01M9 11.2c0 1.2-.6 2.1-1.4 2.4M14.6 11.2h.01M14.6 11.2c0 1.2-.6 2.1-1.4 2.4"/>'),
    queue: ico(19, 19, '<path d="M9 6.5h11M9 12h11M9 17.5h7"/><path d="M4 5.6v1.8M4 11.1v1.8M4 16.6v1.8" stroke-width="2.4"/>'),
    devices: ico(19, 19, '<path d="M6.2 16.5A8 8 0 1 1 17.8 16.5"/><path d="M8.9 13.8a4.2 4.2 0 1 1 6.2 0"/><path d="M12 15.2 15.4 20H8.6z" fill="currentColor" stroke="none"/>'),
    volume: ico(20, 20, '<path d="M4 9.6v4.8a1 1 0 0 0 1 1h2.6l4.4 3.6a.8.8 0 0 0 1.3-.6V5.6a.8.8 0 0 0-1.3-.6L7.6 8.6H5a1 1 0 0 0-1 1z"/><path d="M16.4 9a4.2 4.2 0 0 1 0 6M18.9 6.6a8 8 0 0 1 0 10.8"/>'),
    close: ico(15, 15, '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke-width="2.2"/>'),
    mini: ico(19, 19, '<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><rect x="11.5" y="12" width="7" height="5" rx="1.5" fill="currentColor" stroke="none"/>'),
    gear: ico(18, 18, '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>'),
    saved: ico(18, 18, '<circle cx="12" cy="12" r="10"/><path d="M7.6 12.3l3 3 5.8-6.2" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>', true),
    unsaved: ico(18, 18, '<circle cx="12" cy="12" r="9.2"/><path d="M12 8v8M8 12h8"/>'),
    more: ico(18, 18, '<circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/>', true),
    expand: ico(15, 15, '<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>'),
  };


  // ---------------- window tint (album colors behind the panels) ----------------
  // Aurora: soft light fields in the artwork's colours behind the panels. Painted ONCE per song (and when the time
  // of day changes) onto a tiny 96x54 canvas, cross-faded from the previous one; the slow drift is a CSS transform
  // on the graphics chip, so it costs the main thread nothing and nothing re-renders while it moves.
  const ambient = mount(el('<div id="tess-ambient" aria-hidden="true"><canvas width="96" height="54"></canvas><canvas width="96" height="54"></canvas></div>'));
  const auroraCanvases = [...ambient.querySelectorAll('canvas')];
  let auroraFront = 0;
  let auroraColors = [[40, 50, 90], [70, 40, 90], [30, 60, 80], [20, 20, 30]];
  // the window hums with the song's colours, or the artist's photo while you're on their page
  let songColors = auroraColors;
  let artistColors = null;
  function paletteOf(img) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, 4, 4);
      const d = x.getImageData(0, 0, 4, 4).data;
      const out = [];
      for (const k of [0, 12, 40, 52]) out.push([d[k], d[k + 1], d[k + 2]]);
      return out;
    } catch { return null; }
  }
  // Colour psychology. The artwork sets the hue; the hour bends it (soft warm light in the morning, clean neutral
  // light midday, golden in the evening, dim and low in blue at night so it doesn't fight your sleep); vivid
  // artwork drifts a little faster, muted artwork calmer; it holds still while paused.
  const DAYPARTS = [
    // [from hour, tone rgb, how much tone to mix in, brightness, blue kept]
    [5, [255, 176, 110], 0.15, 1.05, 0.96],  // morning: warm, gentle sunrise light
    [11, [200, 215, 235], 0.1, 1.08, 1],     // midday: clean, neutral, bright
    [16, [255, 150, 90], 0.16, 1.0, 0.92],   // golden hour / evening: warm amber
    [20, [120, 70, 60], 0.12, 0.86, 0.82],   // night: a little dimmer and warmer, the song's colour still clear
  ];
  const daypart = () => {
    const h = new Date().getHours();
    return [...DAYPARTS].reverse().find((d) => h >= d[0]) || DAYPARTS[3];
  };
  function paintFields(canvas, colors, seed) {
    const x = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    // the whole window carries the colour: a dim wash of the average first (no black corners), then the fields,
    // placed evenly round the window so every panel sits over some of the light
    const avg = [0, 1, 2].map((j) => colors.reduce((t, c) => t + c[j], 0) / colors.length);
    x.filter = 'none';
    x.fillStyle = `rgb(${avg.map((v) => Math.round(v * 0.32)).join(',')})`;
    x.fillRect(0, 0, w, h);
    x.filter = 'blur(9px) saturate(140%)';
    const spots = [[0.18, 0.3], [0.82, 0.28], [0.3, 0.8], [0.78, 0.78]];
    colors.forEach((c, i) => {
      const a = seed + i * 1.7;
      x.fillStyle = `rgba(${c.map(Math.round).join(',')},0.9)`;
      x.beginPath();
      x.ellipse(w * (spots[i % 4][0] + 0.08 * Math.cos(a)), h * (spots[i % 4][1] + 0.08 * Math.sin(a)), w * 0.38, h * 0.5, a, 0, Math.PI * 2);
      x.fill();
    });
    if (false) colors.forEach((c, i) => {
      const a = seed + i * 1.7;
      x.fillStyle = `rgba(${c.map(Math.round).join(',')},0.95)`;
      x.beginPath();
      x.ellipse(w * (0.5 + 0.4 * Math.cos(a)), h * (0.5 + 0.42 * Math.sin(a * 1.3)), w * 0.5, h * 0.62, a, 0, Math.PI * 2);
      x.fill();
    });
  }
  let auroraKey = '';
  function paintAurora() {
    if (!settings.tintWindow) return;
    const [from, tone, mix, bright, blue] = settings.circadian ? daypart() : [0, [0, 0, 0], 0, 1, 1];
    const key = JSON.stringify(auroraColors) + from + settings.circadian;
    if (key === auroraKey) return;
    auroraKey = key;
    const colors = auroraColors.map((c) => c.map((v, j) => Math.min(255, (v * (1 - mix) + tone[j] * mix) * bright * (j === 2 ? blue : 1))));
    const sat = auroraColors.reduce((s, c) => s + (Math.max(...c) - Math.min(...c)), 0) / (auroraColors.length * 255);
    ambient.style.setProperty('--drift', Math.round(80 - sat * 40) + 's');
    const back = auroraCanvases[1 - auroraFront];
    paintFields(back, colors, (Date.now() / 6e4) % 6);
    back.classList.add('on');
    auroraCanvases[auroraFront].classList.remove('on');
    auroraFront = 1 - auroraFront;
    // the same picture also becomes the page's own background, so every panel and the top bar sit on it
    // regardless of how Spotify stacks its layers
    html.style.setProperty('--tess-aurora', `url("${back.toDataURL()}")`);
  }
  every(60000, paintAurora); // picks up the next part of the day

  // ---------------- floating playing bar ----------------
  const bar = mount(el(`
    <div id="tess-bar" role="region" aria-label="Now playing">
      <div class="tb-ctl">
        <button class="tb-shuffle" aria-label="Shuffle">${I.shuffle}</button>
        <button class="tb-prev" aria-label="Previous">${I.prev}</button>
        <button class="tb-play" aria-label="Play or pause">${I.play}</button>
        <button class="tb-next" aria-label="Next">${I.next}</button>
        <button class="tb-repeat" aria-label="Repeat">${I.repeat}</button>
      </div>
      <div class="tb-now">
        <button class="tb-art" aria-label="Open full screen player"><img alt=""></button>
        <div class="tb-meta">
          <div class="tb-title"><span></span><button class="tb-heart" aria-label="Add to playlist">${I.unsaved}</button></div>
          <div class="tb-sub tess-marquee"><span></span></div>
        </div>
        <div class="tb-prog"><i></i></div>
      </div>
      <div class="tb-tools">
        <span class="tb-quality"></span>
        <button class="tb-lyrics" aria-label="Lyrics">${I.lyrics}</button>
        <button class="tb-queue" aria-label="Queue">${I.queue}</button>
        <button class="tb-devices" aria-label="Connect to a device">${I.devices}</button>
        <button class="tb-mini" aria-label="Open Miniplayer">${I.mini}</button>
        <div class="tb-vol">${I.volume}<input type="range" min="0" max="1" step="0.01" aria-label="Volume"></div>
      </div>
    </div>`));

  const q = (root, s) => root.querySelector(s);
  const saveButton = () =>
    [...document.querySelectorAll('[data-testid="now-playing-widget-v2"] button, [data-testid="now-playing-widget"] button')]
      .find((b) => /playlist|liked songs/i.test(b.getAttribute('aria-label') || ''));
  const toggleSave = () => { saveButton()?.click(); setTimeout(syncState, 400); };

  q(bar, '.tb-play').onclick = () => P.togglePlay();
  q(bar, '.tb-prev').onclick = () => P.back();
  q(bar, '.tb-next').onclick = () => P.next();
  q(bar, '.tb-shuffle').onclick = () => { P.toggleShuffle(); setTimeout(syncState, 150); };
  q(bar, '.tb-repeat').onclick = () => { P.toggleRepeat(); setTimeout(syncState, 150); };
  q(bar, '.tb-heart').onclick = toggleSave;
  q(bar, '.tb-art').onclick = () => openNP('lyrics');
  q(bar, '.tb-lyrics').onclick = () => openNP('lyrics');
  q(bar, '.tb-queue').onclick = () => spotifyButton('[data-testid="control-button-queue"]')?.click();
  q(bar, '.tb-mini').onclick = () => openMini();
  q(bar, '.tb-devices').onclick = () => spotifyButton('button[aria-label="Connect to a device"]')?.click();
  q(bar, '.tb-prog').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    P.seek(Math.round(((e.clientX - r.left) / r.width) * P.getDuration()));
  };
  const barVol = q(bar, '.tb-vol input');
  barVol.oninput = () => P.setVolume(Number(barVol.value));

  // ---------------- full-screen now playing ----------------
  const np = mount(el(`
    <div id="tess-np" class="mode-lyrics" aria-hidden="true">
      <div class="tn-bg"><canvas class="tn-glow" width="128" height="72"></canvas><div class="tn-shade"></div></div>
      <div class="tn-pill tl">
        <button class="tn-close" aria-label="Close">${I.close}</button>
        <button class="tn-mini" aria-label="Open Miniplayer">${I.mini}</button>
      </div>
      <div class="tn-pill tr">
        <button class="tn-devices" aria-label="Connect to a device">${I.devices}</button>
        <input class="tn-vol" type="range" min="0" max="1" step="0.01" aria-label="Volume">
        <span class="tn-volicon">${I.volume}</span>
        <div class="tn-look" role="radiogroup" aria-label="Full screen look"><button data-look="cover">Artwork</button><button data-look="canvas">Video</button><button data-look="vinyl">Vinyl</button></div>
        <button class="tn-gear" aria-label="Tess Music settings">${I.gear}</button>
      </div>
      <div class="tn-stage">
        <div class="tn-player">
          <div class="tn-flow" aria-hidden="true"></div>
          <div class="tn-cover"><img alt=""><video muted loop playsinline></video><i class="tn-spindle"></i></div>
          <svg class="tn-arm" viewBox="0 0 60 220" aria-hidden="true"><circle cx="30" cy="22" r="18" fill="rgba(255,255,255,.18)" stroke="rgba(255,255,255,.5)"/><circle cx="30" cy="22" r="6" fill="#ddd"/><path d="M30 22 L30 170 L44 200" stroke="#e8e8ea" stroke-width="5" fill="none" stroke-linecap="round"/><rect x="36" y="194" width="16" height="22" rx="3" fill="#cfcfd4"/></svg>
          <div class="tn-meta">
            <div class="tn-text"><h2></h2><p class="tess-marquee"><span></span></p></div>
            <button class="tn-round tn-heart" aria-label="Add to playlist">${I.unsaved}</button>
            <button class="tn-round tn-more" aria-label="Go to album">${I.more}</button>
          </div>
          <div class="tn-scrub"><i></i><div class="tn-ribbon"></div><span class="tn-peek"></span></div>
          <div class="tn-times"><span class="tn-cur">0:00</span><span class="tn-quality"></span><span class="tn-rem">-0:00</span></div>
          <div class="tn-btns">
            <button class="tn-shuffle tn-sm" aria-label="Shuffle">${I.shuffle}</button>
            <button class="tn-prev" aria-label="Previous">${I.prev}</button>
            <button class="tn-play" aria-label="Play or pause">${I.pause}</button>
            <button class="tn-next" aria-label="Next">${I.next}</button>
            <button class="tn-repeat tn-sm" aria-label="Repeat">${I.repeat}</button>
          </div>
        </div>
        <div class="tn-lyrics"><div class="tn-lines"></div><div class="tn-note"></div>
          <div class="tn-sync" aria-label="Lyrics timing"><button data-d="-0.5" aria-label="Lyrics earlier">−</button><b>In sync</b><button data-d="0.5" aria-label="Lyrics later">+</button></div>
        </div>
        <div class="tn-queue"><h4>Playing Next</h4><div class="tn-qlist"></div></div>
      </div>
      <div class="tn-pill br">
        <button class="tn-lyr on" aria-label="Lyrics">${I.lyrics}</button>
        <button class="tn-q" aria-label="Playing next">${I.queue}</button>
      </div>
    </div>`));

  let npOpen = false;
  function openNP(mode) {
    renderFlow();
    npOpen = true;
    setMode(mode || 'lyrics');
    np.classList.add('open');
    np.setAttribute('aria-hidden', 'false');
    renderQueue();
    requestAnimationFrame(fitMarquees);
    if (np.classList.contains('has-canvas')) q(np, '.tn-cover video').play().catch(() => {});
    loop();
  }
  function closeNP() {
    npOpen = false;
    np.classList.remove('open');
    q(np, '.tn-cover video').pause();
    np.setAttribute('aria-hidden', 'true');
  }
  function setMode(m) {
    np.classList.remove('mode-lyrics', 'mode-queue', 'mode-none');
    np.classList.add('mode-' + m);
    q(np, '.tn-lyr').classList.toggle('on', m === 'lyrics');
    q(np, '.tn-q').classList.toggle('on', m === 'queue');
    if (m === 'queue') { renderQueue(); renderFlow(); }
    lastLine = -2;
    requestAnimationFrame(fitMarquees);
  }
  q(np, '.tn-close').onclick = closeNP;
  q(np, '.tn-mini').onclick = () => { closeNP(); openMini(); };
  // Cover or Vinyl, remembered
  // Artwork / Video (the song's Canvas) / Vinyl, remembered
  const npLook = () => (settings.npStyle === 'vinyl' ? 'vinyl' : settings.coverVideo ? 'canvas' : 'cover');
  const applyNpStyle = () => {
    np.classList.toggle('vinyl', npLook() === 'vinyl');
    armMeasured = false;
    document.querySelector('.tess-cover-wrap')?.classList.toggle('vinyl', npLook() === 'vinyl');
    np.querySelectorAll('.tn-look button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.look === npLook())));
  };
  np.querySelectorAll('.tn-look button').forEach((b) => {
    b.onclick = () => {
      settings.npStyle = b.dataset.look === 'vinyl' ? 'vinyl' : 'cover';
      if (b.dataset.look !== 'vinyl') settings.coverVideo = b.dataset.look === 'canvas';
      saveSettings();
      applyNpStyle();
      syncTrack();
    };
  });
  applyNpStyle();

  // Vinyl tonearm: its angle is the track position (outer groove at the start, inner groove at the end), it rests
  // off the record while paused, and you can pick it up: drop it on the record to play from that spot, or lift it
  // off to pause.
  let ARM_REST = -28, ARM_START = 2, ARM_END = 24;
  var armMeasured = false;
  // Measure where the stylus meets the record's outer edge and the label's edge (the arm swings about its pivot),
  // so the start of the song is always the outer groove and the end is always the label, whatever the length.
  function measureArm() {
    const rec = q(np, '.tn-cover').getBoundingClientRect();
    if (!rec.width) { armMeasured = false; return; }
    const [px, py] = pivot();
    const sc = (arm.clientWidth || 96) / 60;
    const tx = (44 - 30) * sc, ty = (205 - 22) * sc;
    const cx = rec.left + rec.width / 2, cy = rec.top + rec.height / 2;
    const dist = (deg) => { const a = deg * Math.PI / 180; const x = px + tx * Math.cos(a) - ty * Math.sin(a); const y = py + tx * Math.sin(a) + ty * Math.cos(a); return Math.hypot(x - cx, y - cy); };
    const find = (r) => { let best = 0, err = Infinity; for (let d = -40; d <= 80; d += 0.25) { const e = Math.abs(dist(d) - r); if (e < err) { err = e; best = d; } } return best; };
    // the label edge, or as close to it as the arm can reach
    let minD = Infinity; for (let d = -40; d <= 80; d += 0.5) minD = Math.min(minD, dist(d));
    const outer = find(rec.width / 2 * 0.95), inner = find(Math.max(rec.width * 0.205, minD + 2));
    ARM_START = Math.min(outer, inner); ARM_END = Math.max(outer, inner); ARM_REST = ARM_START - 26;
  }
  listen(window, 'resize', () => np.classList.contains('vinyl') && measureArm());
  const arm = q(np, '.tn-arm');
  let armDrag = null;
  const armAngleFor = (ms) => ARM_START + (ARM_END - ARM_START) * Math.min(1, ms / (P.getDuration() || 1));
  function placeArm(ms) {
    if (armDrag || !np.classList.contains('vinyl')) return;
    if (!armMeasured) { armMeasured = true; measureArm(); }
    arm.style.transform = `rotate(${P.isPlaying() ? armAngleFor(ms) : ARM_REST}deg)`;
  }
  // the pivot from the arm's unrotated box (its rotated bounding box moves as it turns)
  const pivot = () => {
    const p = arm.parentElement.getBoundingClientRect();
    const w = arm.clientWidth || arm.getBBox?.().width || 0;
    const h = arm.clientHeight || 0;
    const left = parseFloat(getComputedStyle(arm).left) || (p.width - w);
    const top = parseFloat(getComputedStyle(arm).top) || 0;
    return [p.left + left + w / 2, p.top + top + h * 0.1];
  };
  const pointerAngle = (e) => { const [cx, cy] = pivot(); return Math.atan2(cx - e.clientX, e.clientY - cy) * 180 / Math.PI; };
  arm.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { arm.setPointerCapture(e.pointerId); } catch {}
    const now = parseFloat((arm.style.transform.match(/-?[\d.]+/) || [ARM_REST])[0]);
    armDrag = { offset: now - pointerAngle(e) };
    arm.classList.add('held');
  });
  arm.addEventListener('pointermove', (e) => {
    if (!armDrag) return;
    const a = Math.max(ARM_REST, Math.min(ARM_END + 2, pointerAngle(e) + armDrag.offset));
    armDrag.angle = a;
    arm.style.transform = `rotate(${a}deg)`;
  });
  const dropArm = () => {
    if (!armDrag) return;
    const a = armDrag.angle ?? ARM_REST;
    armDrag = null;
    arm.classList.remove('held');
    if (a < ARM_START - 4) { if (P.isPlaying()) P.pause(); }
    else {
      const frac = Math.max(0, Math.min(1, (a - ARM_START) / (ARM_END - ARM_START)));
      P.seek(Math.round(frac * P.getDuration()));
      if (!P.isPlaying()) P.play();
    }
  };
  arm.addEventListener('pointerup', dropArm);
  arm.addEventListener('pointercancel', dropArm);

  // Cover Flow of the queue around the cover: what played before on the left, what's next on the right.
  // Click a card to jump to it.
  function renderFlow() {
    const st = Spicetify.Platform.PlayerAPI.getState?.() || {};
    const prev = (st.previousItems || []).slice(-3);
    const next = (st.nextItems || []).filter((t) => t.uri?.startsWith('spotify:track') || t.uri?.startsWith('spotify:episode')).slice(0, 4);
    const flow = q(np, '.tn-flow');
    const cards = [...prev.map((t, i) => [t, i - prev.length]), ...next.map((t, i) => [t, i + 1])];
    flow.replaceChildren(...cards.map(([t, k]) => {
      const c = el('<button class="tn-card"><img alt=""><span><b></b><small></small></span></button>');
      const a = Math.abs(k), dir = Math.sign(k);
      // fanned out to each side, turned toward the middle, further ones smaller and dimmer
      c.style.transform = `translateX(${dir * (62 + (a - 1) * 34)}%) translateZ(${-a * 160}px) rotateY(${-dir * 32}deg) scale(${1 - a * 0.08})`;
      c.style.opacity = String(1 - a * 0.25);
      c.style.zIndex = String(10 - a);
      q(c, 'img').src = imageUrl(t.images?.[0]?.url || t.album?.images?.[0]?.url || '');
      q(c, 'b').textContent = t.name || '';
      q(c, 'small').textContent = (t.artists || []).map((a) => a.name).join(', ');
      c.onclick = async () => {
        if (k < 0) { for (let n = 0; n < -k; n++) await P.back(); }
        else { for (let n = 0; n < k; n++) await P.next(); }
      };
      return c;
    }));
  }
  q(np, '.tn-devices').onclick = () => spotifyButton('button[aria-label="Connect to a device"]')?.click();
  q(np, '.tn-gear').onclick = openSettings;
  q(np, '.tn-lyr').onclick = () => setMode(np.classList.contains('mode-lyrics') ? 'none' : 'lyrics');
  q(np, '.tn-q').onclick = () => setMode(np.classList.contains('mode-queue') ? 'none' : 'queue');
  q(np, '.tn-play').onclick = () => P.togglePlay();
  q(np, '.tn-prev').onclick = () => P.back();
  q(np, '.tn-next').onclick = () => P.next();
  q(np, '.tn-shuffle').onclick = () => { P.toggleShuffle(); setTimeout(syncState, 150); };
  q(np, '.tn-repeat').onclick = () => { P.toggleRepeat(); setTimeout(syncState, 150); };
  q(np, '.tn-heart').onclick = toggleSave;
  q(np, '.tn-more').onclick = () => {
    const uri = item()?.album?.uri;
    if (uri) { closeNP(); Spicetify.Platform.History.push('/album/' + uri.split(':')[2]); }
  };
  q(np, '.tn-scrub').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    P.seek(Math.round(((e.clientX - r.left) / r.width) * P.getDuration()));
  };
  const npVol = q(np, '.tn-vol');
  npVol.oninput = () => P.setVolume(Number(npVol.value));
  listen(document, 'keydown', (e) => {
    if (!npOpen) return;
    if (e.key === 'Escape') closeNP();
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); P.togglePlay(); }
  });

  // A subtitle only scrolls when it is too long to fit.
  function fitMarquees() {
    for (const box of document.querySelectorAll('.tess-marquee')) {
      const span = box.firstElementChild;
      if (!span) continue;
      const overflow = span.scrollWidth - box.clientWidth;
      box.classList.toggle('scrolling', overflow > 4);
      box.style.setProperty('--tess-marquee-shift', `-${Math.max(0, overflow + 24)}px`);
    }
  }
  listen(window, 'resize', fitMarquees);

  // ---------------- first-run welcome ----------------
  // A single glass sheet on first launch to pick the defaults; everything here is also in Settings → Theme.
  function onboarding() {
    let done = false;
    try { done = !!localStorage.getItem('tess:onboarded'); } catch {}
    if (done) return;
    const sheet = mount(el(`
      <div id="tess-welcome" role="dialog" aria-label="Welcome to Tess">
        <div class="tw-card">
          <div class="tw-step on" data-step="0">
            <div class="tw-mark"></div>
            <h1>Welcome to Tess</h1>
            <p>Spotify, redesigned. Everything Spotify has is still here; it just looks and feels new. Pick a few things and you're set.</p>
          </div>
          <div class="tw-step" data-step="1">
            <h2>Full-screen player</h2>
            <p>What fills the left side when you open a song full screen.</p>
            <div class="tw-choices" data-key="look">
              <button data-v="cover"><i class="tw-ill tw-cover"></i>Artwork</button>
              <button data-v="canvas"><i class="tw-ill tw-video"></i>Video</button>
              <button data-v="vinyl"><i class="tw-ill tw-vinyl"></i>Vinyl</button>
            </div>
          </div>
          <div class="tw-step" data-step="2">
            <h2>The window</h2>
            <div class="tw-toggles">
              <label><span><b>Colour from the music</b><small>The window takes on the colours of what's playing.</small></span><input type="checkbox" data-key="tintWindow"></label>
              <label><span><b>Follow the time of day</b><small>Warm mornings, neutral afternoons, low blue at night.</small></span><input type="checkbox" data-key="circadian"></label>
              <label><span><b>Moving artist pages</b><small>Artist pages open on a looping video when there is one.</small></span><input type="checkbox" data-key="artistVideo"></label>
              <label><span><b>Live lyrics beside the music</b><small>Synced lyrics in the Now Playing panel.</small></span><input type="checkbox" data-key="sideLyrics"></label>
            </div>
          </div>
          <div class="tw-step" data-step="3">
            <h2>You're all set</h2>
            <p>Press <kbd>⌘</kbd><kbd>K</kbd> to search anything, drag the record arm in Vinyl mode, and use the miniplayer button in the bar for a player that floats over every app. Settings → Theme has everything else.</p>
          </div>
          <footer><span class="tw-dots"><i></i><i></i><i></i><i></i></span><button class="tw-skip">Skip</button><button class="tw-next">Continue</button></footer>
        </div>
      </div>`));
    let step = 0;
    const steps = sheet.querySelectorAll('.tw-step');
    const show = () => {
      steps.forEach((s, i) => s.classList.toggle('on', i === step));
      sheet.querySelectorAll('.tw-dots i').forEach((d, i) => d.classList.toggle('on', i === step));
      sheet.querySelector('.tw-next').textContent = step === steps.length - 1 ? 'Start listening' : 'Continue';
    };
    const look = () => (settings.npStyle === 'vinyl' ? 'vinyl' : settings.coverVideo ? 'canvas' : 'cover');
    sheet.querySelectorAll('[data-key="look"] button').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.v === look()));
      b.onclick = () => {
        settings.npStyle = b.dataset.v === 'vinyl' ? 'vinyl' : 'cover';
        if (b.dataset.v !== 'vinyl') settings.coverVideo = b.dataset.v === 'canvas';
        sheet.querySelectorAll('[data-key="look"] button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      };
    });
    sheet.querySelectorAll('input[data-key]').forEach((i) => { i.checked = !!settings[i.dataset.key]; i.onchange = () => { settings[i.dataset.key] = i.checked; }; });
    const finish = () => {
      saveSettings(); applySettings(); syncTrack(); onRoute();
      try { localStorage.setItem('tess:onboarded', '1'); } catch {}
      sheet.classList.add('bye');
      setTimeout(() => sheet.remove(), 400);
    };
    sheet.querySelector('.tw-next').onclick = () => { if (step < steps.length - 1) { step++; show(); } else finish(); };
    sheet.querySelector('.tw-skip').onclick = finish;
    show();
  }

  // ---------------- liquid glass ----------------
  // Apple's Liquid Glass bends what's behind it near its edges (a lens), keeps the middle clear, and catches light on
  // the rim. Each glass surface gets a displacement map drawn for its own size and corner radius: red/green encode how
  // far to push each pixel, strongest in a band along the edge and zero in the centre. The filter is used as the
  // element's backdrop-filter, so it refracts the real content underneath, then softly blurs and saturates it.
  const svgNS = 'http://www.w3.org/2000/svg';
  const glassDefs = document.createElementNS(svgNS, 'svg');
  glassDefs.setAttribute('width', '0');
  glassDefs.setAttribute('height', '0');
  glassDefs.style.position = 'absolute';
  mount(glassDefs);
  function lensMap(w, h, r, edge) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    const img = x.createImageData(w, h);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        // distance to the rounded-rect border, and the outward normal there
        const qx = Math.max(Math.abs(px + 0.5 - w / 2) - (w / 2 - r), 0);
        const qy = Math.max(Math.abs(py + 0.5 - h / 2) - (h / 2 - r), 0);
        const inside = r - Math.hypot(qx, qy);
        const d = Math.min(inside, Math.min(px, w - px, py, h - py) + (qx || qy ? 0 : 0));
        const t = Math.max(0, 1 - Math.max(0, d) / edge); // 1 at the edge, 0 past the band
        const k = t * t * (3 - 2 * t);                     // smooth falloff
        let nx = Math.sign(px + 0.5 - w / 2) * (qx ? qx / (Math.hypot(qx, qy) || 1) : (Math.abs(px + 0.5 - w / 2) > w / 2 - edge ? 1 : 0));
        let ny = Math.sign(py + 0.5 - h / 2) * (qy ? qy / (Math.hypot(qx, qy) || 1) : (Math.abs(py + 0.5 - h / 2) > h / 2 - edge ? 1 : 0));
        const i = (py * w + px) * 4;
        // pull the edge inward: samples come from further inside, which magnifies/bends like a thick lens
        img.data[i] = 128 - nx * k * 127;
        img.data[i + 1] = 128 - ny * k * 127;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
    return c.toDataURL();
  }
  const glassCache = new Map();
  function glassFilter(w, h, r) {
    w = Math.max(8, Math.round(w)); h = Math.max(8, Math.round(h)); r = Math.min(Math.round(r), Math.floor(Math.min(w, h) / 2));
    const key = `${w}x${h}r${r}`;
    if (glassCache.has(key)) return glassCache.get(key);
    const id = 'tess-glass-' + glassCache.size;
    const f = document.createElementNS(svgNS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', '100%'); f.setAttribute('height', '100%');
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.innerHTML = `
      <feImage href="${lensMap(w, h, r, Math.min(22, Math.min(w, h) / 2.4))}" x="0" y="0" width="${w}" height="${h}" result="map"/>
      <feDisplacementMap in="SourceGraphic" in2="map" scale="${Math.min(70, Math.min(w, h) * 1.2)}" xChannelSelector="R" yChannelSelector="G" result="r"/>
      <feDisplacementMap in="SourceGraphic" in2="map" scale="${Math.min(62, Math.min(w, h) * 1.05)}" xChannelSelector="R" yChannelSelector="G" result="g"/>
      <feDisplacementMap in="SourceGraphic" in2="map" scale="${Math.min(54, Math.min(w, h) * 0.9)}" xChannelSelector="R" yChannelSelector="G" result="b"/>
      <feColorMatrix in="r" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="rr"/>
      <feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="gg"/>
      <feColorMatrix in="b" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="bb"/>
      <feBlend in="rr" in2="gg" mode="screen" result="rg"/>
      <feBlend in="rg" in2="bb" mode="screen" result="bent"/>
      <feGaussianBlur in="bent" stdDeviation="0.9" result="soft"/>
      <feColorMatrix in="soft" type="saturate" values="1.8"/>`;
    glassDefs.appendChild(f);
    glassCache.set(key, id);
    return id;
  }
  const GLASS = '#tess-bar, #tess-np .tn-pill, #global-nav-bar form[role="search"], #global-nav-bar button[aria-label="Home"], .tess-hero-switch, #tess-spot .ts-panel';
  const glassed = new WeakMap();
  const glassObserver = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const r = target.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
      const id = glassFilter(r.width, r.height, Math.min(radius, r.height / 2));
      target.style.setProperty('--tess-lens', `url(#${id})`);
    }
  });
  onDispose(() => glassObserver.disconnect());
  const applyGlass = () => {
    for (const n of document.querySelectorAll(GLASS)) {
      if (glassed.has(n)) continue;
      glassed.set(n, true);
      n.classList.add('tess-liquid');
      glassObserver.observe(n);
    }
  };

  // ---------------- Tess miniplayer ----------------
  // A small always-on-top window (Document Picture-in-Picture, the same thing Spotify's own miniplayer uses):
  // the artwork fills it, controls float on liquid glass, the current lyric line sits on top. It resizes from a
  // square "tile" to a slim "strip" depending on how you shape the window.
  let mini = null;
  // Tess Mini (the native app) floats over every app and Space; fall back to the in-app window if it isn't installed
  const MINI = 'http://127.0.0.1:38411';
  let nativeMini = false;
  async function openMini() {
    try { await fetch(MINI + '/toggle', { mode: 'no-cors' }); nativeMini = true; pushedLinesFor = ''; pushedLine = null; renderRibbon(); return; } catch { nativeMini = false; }
    if (mini && !mini.closed) { mini.focus(); return; }
    if (!window.documentPictureInPicture) { spotifyButton('[data-testid="pip-toggle-button"]')?.click(); return; }
    mini = await documentPictureInPicture.requestWindow({ width: 340, height: 380 });
    const d = mini.document;
    const css = d.createElement('style');
    css.textContent = MINI_CSS;
    d.head.appendChild(css);
    d.body.innerHTML = `
      <div class="m-art"><img alt=""><div class="m-glow"></div></div>
      <div class="m-lyric"></div>
      <div class="m-glass">
        <div class="m-text"><b></b><small></small></div>
        <div class="m-prog"><i></i></div>
        <div class="m-ctl">
          <button class="m-prev" aria-label="Previous">${I.prev}</button>
          <button class="m-play" aria-label="Play or pause">${I.pause}</button>
          <button class="m-next" aria-label="Next">${I.next}</button>
        </div>
      </div>`;
    const mq = (sel) => d.querySelector(sel);
    mq('.m-prev').onclick = () => P.back();
    mq('.m-next').onclick = () => P.next();
    mq('.m-play').onclick = () => P.togglePlay();
    mq('.m-prog').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); P.seek(Math.round(((e.clientX - r.left) / r.width) * P.getDuration())); };
    mq('.m-art').ondblclick = () => { window.focus(); openNP('lyrics'); };
    const sync = () => {
      if (!mini || mini.closed) return;
      mq('.m-art img').src = artUrl();
      mq('.m-text b').textContent = item()?.name || meta().title || '';
      mq('.m-text small').textContent = meta().artist_name || '';
      mq('.m-play').innerHTML = P.isPlaying() ? I.pause : I.play;
    };
    const tick = () => {
      if (!mini || mini.closed) return;
      const ms = P.getProgress();
      mq('.m-prog i').style.width = Math.min(100, (ms / (P.getDuration() || 1)) * 100) + '%';
      const i = lyrics.lines.length && lyrics.sync !== 'UNSYNCED' ? lineAt(ms + 120) : -1;
      const text = i >= 0 ? lyrics.lines[i].text : '';
      if (mq('.m-lyric').textContent !== text) mq('.m-lyric').textContent = text;
      d.body.classList.toggle('strip', mini.innerHeight < 200);
    };
    sync();
    const id = setInterval(tick, 250);
    P.addEventListener('songchange', sync);
    P.addEventListener('onplaypause', sync);
    mini.addEventListener('pagehide', () => { clearInterval(id); P.removeEventListener('songchange', sync); P.removeEventListener('onplaypause', sync); mini = null; });
  }
  onDispose(() => { try { mini?.close(); } catch {} });
  const MINI_CSS = `
    *{box-sizing:border-box;margin:0}
    html,body{height:100%;background:#0b0b0e;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;overflow:hidden;user-select:none}
    .m-art{position:absolute;inset:0}
    .m-art img{width:100%;height:100%;object-fit:cover;display:block}
    .m-glow{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.25),transparent 30%,transparent 45%,rgba(0,0,0,.55))}
    .m-lyric{position:absolute;left:16px;right:16px;top:14px;font-weight:750;font-size:17px;line-height:1.25;text-shadow:0 2px 14px rgba(0,0,0,.6);transition:opacity .3s}
    .m-lyric:empty{opacity:0}
    .m-glass{position:absolute;left:10px;right:10px;bottom:10px;padding:12px 14px 10px;border-radius:22px;
      background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.06));
      -webkit-backdrop-filter:blur(26px) saturate(1.9);backdrop-filter:blur(26px) saturate(1.9);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.35),inset 0 -1px 0 rgba(0,0,0,.2),inset 0 0 0 1px rgba(255,255,255,.12),0 10px 30px rgba(0,0,0,.35)}
    .m-text{display:flex;flex-direction:column;gap:2px;min-width:0}
    .m-text b,.m-text small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .m-text b{font-size:15px;font-weight:700}
    .m-text small{font-size:12.5px;color:rgba(255,255,255,.75)}
    .m-prog{position:relative;height:4px;margin:10px 0 8px;border-radius:2px;background:rgba(255,255,255,.25);cursor:pointer}
    .m-prog::before{content:"";position:absolute;inset:-7px 0}
    .m-prog i{display:block;height:100%;width:0;border-radius:2px;background:#fff}
    .m-ctl{display:flex;justify-content:center;align-items:center;gap:30px}
    button{all:unset;cursor:pointer;display:grid;place-items:center;color:#fff;transition:transform .2s}
    button:active{transform:scale(.88)}
    .m-play svg{width:20px;height:22px}
    body.strip .m-lyric{display:none}
    body.strip .m-glass{top:8px;bottom:8px;left:8px;right:8px;display:grid;grid-template-columns:1fr auto;grid-template-rows:auto auto;align-items:center;column-gap:12px;padding:8px 14px}
    body.strip .m-prog{grid-column:1/-1;margin:6px 0 0}
    body.strip .m-ctl{gap:18px}
  `;

  // ---------------- lyrics (Spotify's own, time-synced) ----------------
  let lyrics = { uri: null, sync: 'NONE', lines: [] };
  let lastLine = -2;
  const linesEl = q(np, '.tn-lines');
  const noteEl = q(np, '.tn-note');

  async function loadLyrics() {
    const uri = item()?.uri;
    if (!uri || uri === lyrics.uri) return;
    lyrics = { uri, sync: 'LOADING', lines: [] };
    linesEl.innerHTML = '';
    noteEl.textContent = '';
    lastLine = -2;
    try {
      const id = uri.split(':')[2];
      const res = await Spicetify.CosmosAsync.get(
        `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`
      );
      if (item()?.uri !== uri) return;
      const raw = res?.lyrics?.lines || [];
      lyrics = {
        uri,
        sync: res?.lyrics?.syncType || 'UNSYNCED',
        lines: raw.map((l, i) => ({
          start: Number(l.startTimeMs),
          end: Number(raw[i + 1]?.startTimeMs ?? P.getDuration()),
          text: (l.words || '').trim(),
        })),
      };
    } catch {
      if (item()?.uri !== uri) return;
      lyrics = { uri, sync: 'NONE', lines: [] };
    }
    renderLyrics();
  }

  // The same synced lines drive two views: the full-screen player and the card in the right panel.
  const side = el(`
    <div class="tess-side-lyrics" hidden>
      <div class="tsl-head"><span>Lyrics</span><button class="tsl-open" aria-label="Open lyrics full screen">${I.expand}</button></div>
      <div class="tsl-window"><div class="tsl-lines"></div></div>
    </div>`);
  onDispose(() => side.remove());
  const views = [
    { lines: linesEl, last: -2, active: () => npOpen && np.classList.contains('mode-lyrics') },
    { lines: q(side, '.tsl-lines'), last: -2, active: () => side.isConnected && !npOpen },
  ];
  q(side, '.tsl-open').onclick = () => openNP('lyrics');

  function renderLyrics() {
    np.classList.toggle('unsynced', lyrics.sync === 'UNSYNCED');
    side.classList.toggle('unsynced', lyrics.sync === 'UNSYNCED');
    side.hidden = !lyrics.lines.length;
    noteEl.textContent = lyrics.lines.length || lyrics.sync === 'LOADING' ? '' : 'Lyrics aren’t available for this song';
    for (const v of views) {
      v.lines.innerHTML = '';
      v.lines.style.transform = '';
      v.last = -2;
      for (const l of lyrics.lines) {
        const isGap = !l.text || /^♪+$/.test(l.text.replace(/\s/g, ''));
        const line = el(`<div class="tn-line${isGap ? ' gap' : ''}"></div>`);
        line.textContent = isGap ? '• • •' : l.text;
        if (lyrics.sync !== 'UNSYNCED') line.onclick = () => P.seek(l.start + 1);
        v.lines.appendChild(line);
      }
    }
    lastLine = -2;
    renderRibbon();
  }

  // The lyric ribbon: the progress bar is cut into one segment per sung line, so you can see the song's shape;
  // the line being sung glows, hovering a segment shows its words, clicking jumps there. Instrumental gaps stay thin.
  function renderRibbon() {
    // the plain glass scrubber is used everywhere now (the segmented ribbon was too busy)
    np.classList.remove('has-ribbon');
    q(np, '.tn-ribbon').replaceChildren();
    return;
    const rib = q(np, '.tn-ribbon');
    const dur = P.getDuration() || 1;
    const lines = lyrics.sync === 'LINE_SYNCED' || lyrics.sync === 'SYLLABLE_SYNCED' ? lyrics.lines.filter((l) => l.text && !/^♪+$/.test(l.text)) : [];
    np.classList.toggle('has-ribbon', lines.length > 2);
    rib.replaceChildren(...lines.map((l) => {
      const seg = document.createElement('b');
      seg.style.left = (l.start / dur * 100) + '%';
      seg.style.width = Math.max(0.4, (Math.min(l.end, l.start + 9000) - l.start) / dur * 100 - 0.35) + '%';
      seg.dataset.text = l.text;
      seg.dataset.start = l.start;
      return seg;
    }));
    pushMiniLines(lines, dur);
  }
  const scrub = q(np, '.tn-scrub');
  scrub.addEventListener('mousemove', (e) => {
    const seg = e.target.closest?.('.tn-ribbon b');
    const peek = q(np, '.tn-peek');
    if (!seg) { peek.classList.remove('on'); return; }
    peek.textContent = seg.dataset.text;
    const r = scrub.getBoundingClientRect();
    peek.style.left = Math.min(r.width - 40, Math.max(40, e.clientX - r.left)) + 'px';
    peek.classList.add('on');
  });
  scrub.addEventListener('mouseleave', () => q(np, '.tn-peek').classList.remove('on'));
  function markRibbon(ms) {
    const rib = q(np, '.tn-ribbon');
    for (const seg of rib.children) {
      const st = +seg.dataset.start;
      seg.classList.toggle('past', st <= ms);
    }
    const i = lyrics.lines.length ? lineAt(ms + 120) : -1;
    const cur = i >= 0 ? String(lyrics.lines[i].start) : '';
    for (const seg of rib.children) seg.classList.toggle('on', seg.dataset.start === cur);
  }
  let pushedLinesFor = '';
  function pushMiniLines(lines, dur) {
    if (!nativeMini || pushedLinesFor === lyrics.uri) return;
    pushedLinesFor = lyrics.uri;
    const body = JSON.stringify({ d: dur, l: lines.map((l) => [l.start, Math.min(l.end, l.start + 9000)]) });
    fetch(MINI + '/lines', { method: 'POST', mode: 'no-cors', body }).catch(() => {});
  }

  function lineAt(ms) {
    let lo = 0, hi = lyrics.lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lyrics.lines[mid].start <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  let pushedLine = null;
  function pushMiniLyric(text) {
    if (!nativeMini || text === pushedLine) return;
    pushedLine = text;
    fetch(MINI + '/lyric', { method: 'POST', mode: 'no-cors', body: text }).catch(() => { nativeMini = false; });
  }
  // find out once whether Tess Mini is installed
  fetch(MINI + '/ping', { mode: 'no-cors' }).then(() => { nativeMini = true; }).catch(() => {});
  const LEAD_MS = 120;
  // re-sync: a per-song offset you nudge with the ± buttons (remembered)
  const syncOffsets = (() => { try { return JSON.parse(localStorage.getItem('tess:lyricSync') || '{}'); } catch { return {}; } })();
  const syncOffset = () => syncOffsets[item()?.uri] || 0;
  function nudgeSync(d) {
    const u = item()?.uri; if (!u) return;
    syncOffsets[u] = Math.round(((syncOffsets[u] || 0) + d) * 10) / 10;
    if (!syncOffsets[u]) delete syncOffsets[u];
    try { localStorage.setItem('tess:lyricSync', JSON.stringify(syncOffsets)); } catch {}
    np.querySelectorAll('.tn-sync b').forEach((b) => { b.textContent = syncOffsets[u] ? `${syncOffsets[u] > 0 ? '+' : ''}${syncOffsets[u].toFixed(1)}s` : 'In sync'; });
    lastLine = -2;
  }
  np.querySelectorAll('.tn-sync button').forEach((b) => { b.onclick = () => nudgeSync(+b.dataset.d); });
  // scroll the lyrics yourself; they follow the song again 3 seconds after you stop
  listen(q(np, '.tn-lyrics'), 'wheel', (e) => {
    const v = views[0];
    e.preventDefault();
    v.manualOffset = Math.max(-200, Math.min(v.lines.scrollHeight, (v.manualUntil > performance.now() ? v.manualOffset : (v.lastShift || 0)) + e.deltaY));
    v.manualUntil = performance.now() + 3000;
    v.lines.style.transition = 'none';
    v.lines.style.transform = `translateY(${-v.manualOffset}px)`;
    clearTimeout(v.resume);
    v.resume = setTimeout(() => { v.lines.style.transition = ''; v.manualUntil = 0; v.last = -2; lastLine = -2; }, 3000);
  }, { passive: false });
  function updateLyrics(ms) {
    ms += syncOffset() * 1000;
    if (!lyrics.lines.length || lyrics.sync === 'UNSYNCED') return;
    if (lastLine === -2) views.forEach((v) => (v.last = -2));
    lastLine = -1;
    const t = ms + LEAD_MS;
    const i = lineAt(t);
    pushMiniLyric(i >= 0 ? lyrics.lines[i].text : '');
    for (const v of views) {
      if (!v.active()) continue;
      const nodes = v.lines.children;
      if (i !== v.last) {
        v.last = i;
        for (let j = 0; j < nodes.length; j++) {
          const d = Math.abs(j - Math.max(i, 0));
          nodes[j].classList.toggle('on', j === i);
          nodes[j].classList.toggle('past', j < i);
          // blur only the few lines around the current one; far lines just dim (no filter, no extra GPU layer)
          nodes[j].style.filter = j === i || d > 3 ? 'none' : `blur(${(d * 0.8).toFixed(1)}px)`;
          nodes[j].classList.toggle('far', d > 3);
        }
        const target = nodes[Math.max(i, 0)];
        if (target) {
          let shift = target.offsetTop;
          // in the small panel card, never scroll past the point where the last line reaches the card's bottom,
          // so the end of a song (and its closing "• • •") still shows the final lyrics instead of empty space
          if (v.lines.classList.contains('tsl-lines')) {
            const win = v.lines.parentElement.clientHeight;
            const start = v.lines.offsetTop;
            shift = Math.max(0, Math.min(shift, v.lines.scrollHeight + start - win + 12));
          }
          v.lastShift = shift;
          if (!(v.manualUntil > performance.now())) v.lines.style.transform = `translateY(${-shift}px)`;
        }
      }
      if (i >= 0) {
        const l = lyrics.lines[i];
        const span = Math.max(400, l.end - l.start);
        const p = Math.min(1, Math.max(0, (t - l.start) / Math.min(span, 400 + l.text.length * 130)));
        nodes[i]?.style.setProperty('--p', (p * 100).toFixed(1) + '%');
      }
    }
  }

  // Spotify swaps its cover for a tall Canvas it often can't play here; Tess always shows the square cover,
  // with the Canvas looping inside it when the setting is on, like Apple Music's animated artwork.
  const coverWrap = el(`<div class="tess-cover-wrap"><button class="tess-side-cover" aria-label="Open full screen player"><img alt=""><video class="tess-video" muted loop playsinline></video></button></div>`);
  const sideCover = q(coverWrap, '.tess-side-cover');
  onDispose(() => coverWrap.remove());
  onDispose(() => document.querySelectorAll('.tess-npv-root, .tess-npv-col').forEach((n) => n.classList.remove('tess-npv-root', 'tess-npv-col')));
  function syncSideCover() {
    q(sideCover, 'img').src = artUrl();
    const uri = item()?.uri;
    const v = q(sideCover, 'video');
    sideCover.classList.remove('has-canvas');
    if (!sideCover.isConnected) return;
    (settings.panelVideo ? trackCanvas(uri) : Promise.resolve('')).then((fileId) => {
      if (item()?.uri !== uri) return;
      playCanvas(v, fileId).then((ok) => sideCover.classList.toggle('has-canvas', ok && v.dataset.fileId === fileId));
    });
  }
  // Spotify's own "Expand Now Playing view" and the lyrics buttons open Spotify's old full-screen views; Tess's instead
  listen(document, 'click', (e) => {
    const b = e.target instanceof Element && e.target.closest('button');
    const label = b?.getAttribute('aria-label') || '';
    if (b?.dataset.testid === 'pip-toggle-button' && !b.closest('#tess-bar, #tess-np')) { e.preventDefault(); e.stopImmediatePropagation(); openMini(); return; }
    if (!/^(Expand Now Playing view|Lyrics|Open lyrics|Show lyrics)$/i.test(label) || b.closest('#tess-bar, #tess-np, .tess-side-lyrics')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openNP('lyrics');
  }, true);
  listen(document, 'click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.Root__right-sidebar-peek [data-testid="cover-art-slot"], .tess-side-cover')) return;
    e.preventDefault();
    e.stopPropagation();
    openNP('lyrics');
  }, true);

  // Put the Tess lyrics card in place of Spotify's preview, and make the cover open the full-screen player.
  onDraw(() => {
    // fast path: everything already where it belongs
    if (coverWrap.isConnected && coverWrap.parentElement?.isConnected && (side.isConnected || !document.querySelector('.Root__right-sidebar-peek [data-testid="lyrics-npv-section"]')) && coverWrap.nextElementSibling?.classList.contains('tess-npv-col')) return;
    const spotifyLyrics = document.querySelector('.Root__right-sidebar-peek [data-testid="lyrics-npv-section"]');
    if (spotifyLyrics && side.nextElementSibling !== spotifyLyrics) {
      spotifyLyrics.before(side);
      views[1].last = -2;
    }
    // Tess owns the top of the panel: one square cover (Canvas inside it), whatever Spotify would show there
    // (cover, tall Canvas, music video). The panel's own text column stays as it is.
    // Found from the song title (always present), not the lyrics card (missing on songs without lyrics):
    // the column is the title's ancestor whose previous sibling holds Spotify's cover, Canvas or our cover.
    let column = null;
    const panel = document.querySelector('.Root__right-sidebar-peek');
    const title = panel?.querySelector('a[href^="/album/"], a[href^="/episode/"], a[href^="/show/"]');
    const start = side.isConnected && panel?.contains(side) ? side.parentElement : title;
    for (let a = start; a && a.parentElement && panel?.contains(a.parentElement); a = a.parentElement) {
      const prev = a.previousElementSibling;
      // the media slot: Spotify's cover/Canvas, or (between Canvas loads) a tall block with no text in it
      const isSlot = prev && (prev.classList.contains('tess-cover-wrap') || prev.querySelector('[data-testid="cover-art-slot"], video')
        || (prev.getBoundingClientRect().height > 120 && !prev.textContent.trim()));
      if (isSlot) { column = a; break; }
    }
    if (column) {
      const root = column.parentElement;
      column.classList.add('tess-npv-col');
      root.classList.add('tess-npv-root');
      if (root.firstElementChild !== coverWrap) { root.prepend(coverWrap); coverWrap.classList.toggle('vinyl', settings.npStyle === 'vinyl'); syncSideCover(); }
      // after "Switch to video" Spotify plays the music video here; let it show, framed like the cover
      const videoMode = [...column.querySelectorAll('button')].some((b) => /switch to audio/i.test(b.textContent || b.getAttribute('aria-label') || ''));
      root.classList.toggle('tess-mv-mode', videoMode);
    }
  });

  // ---------------- queue ----------------
  function renderQueue() {
    const list = q(np, '.tn-qlist');
    const next = (Spicetify.Queue?.nextTracks || []).filter((t) => t?.contextTrack?.metadata?.title).slice(0, 30);
    list.innerHTML = '';
    if (!next.length) {
      list.appendChild(el('<p class="tn-qempty">Nothing queued. Spotify Autoplay picks what comes next.</p>'));
      return;
    }
    for (const t of next) {
      const m = t.contextTrack.metadata;
      const row = el('<div class="tn-qrow"><img alt=""><div><b></b><span></span></div></div>');
      row.querySelector('img').src = imageUrl(m.image_url || m.image_small_url);
      row.querySelector('b').textContent = m.title;
      row.querySelector('span').textContent = m.artist_name || '';
      list.appendChild(row);
    }
  }

  // ---------------- canvas video ----------------
  // Spotify's built-in Chromium cannot decode the H.264 canvas MP4s, so this does what
  // Spotify's own player does: read the video manifest and feed the VP9 WebM segments to MediaSource.
  const manifestCache = new Map();
  async function playCanvas(video, fileId) {
    const release = () => { if (video._tessUrl) { URL.revokeObjectURL(video._tessUrl); video._tessUrl = null; } };
    if (!fileId) { delete video.dataset.fileId; release(); video.removeAttribute('src'); video.load(); return false; }
    if (video.dataset.fileId === fileId && video.readyState >= 2) return true;
    video.dataset.fileId = fileId;
    try {
      let m = manifestCache.get(fileId);
      if (!m) {
        m = await Spicetify.CosmosAsync.get(`https://spclient.wg.spotify.com/manifests/v9/json/sources/${fileId}/options/supports_drm`);
        manifestCache.set(fileId, m);
      }
      const c = m.contents[0];
      const profile = c.profiles
        .filter((p) => p.file_type === 'webm' && p.video_codec === 'vp9' && p.video_height <= 1280)
        .sort((a, b) => b.video_height - a.video_height)[0];
      if (!profile) return false;
      const base = m.base_urls[0];
      const fill = (tpl, ts) => base + tpl.replace('{{profile_id}}', profile.id).replace('{{file_type}}', 'webm').replace('{{segment_timestamp}}', ts);
      const urls = [fill(m.initialization_template)];
      for (let t = 0; t * 1000 < c.end_time_millis; t += c.segment_length) urls.push(fill(m.segment_template, t));
      const ms = new MediaSource();
      release();
      video._tessUrl = URL.createObjectURL(ms);
      video.src = video._tessUrl;
      await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
      if (video.dataset.fileId !== fileId) return false;
      const sb = ms.addSourceBuffer('video/webm; codecs="vp9"');
      for (const u of urls) {
        const buf = await (await fetch(u)).arrayBuffer();
        if (video.dataset.fileId !== fileId) return false;
        await new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(buf); });
      }
      ms.endOfStream();
      video.loop = true;
      video.muted = true;
      video.autoplay = true;
      // don't wait on play(): it can sit unresolved while the window is in the background
      video.play().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  // ---------------- state sync ----------------
  function syncTrack() {
    const m = meta();
    const art = artUrl();
    const title = m.title || item()?.name || '';
    const album = m.album_title || '';
    const sub = album && album.toLowerCase() !== title.toLowerCase() ? `${m.artist_name} — ${album}` : m.artist_name || '';
    q(bar, '.tb-art img').src = art;
    q(bar, '.tb-title span').textContent = title;
    q(bar, '.tb-sub span').textContent = sub;
    q(np, '.tn-cover img').src = art;
    q(np, '.tn-text h2').textContent = title;
    q(np, '.tn-text p span').textContent = sub;
    const artCss = art ? `url("${art}")` : 'none';
    np.style.setProperty('--art', artCss);
    loadArt(art).then((img) => {
      if (artUrl() !== art) return;
      npArt = img;
      paintGlow(q(np, '.tn-glow'), img, performance.now() / 1000);
      // the window tint is static: fade out, repaint, fade in
      songColors = paletteOf(img) || songColors;
      if (!artistColors) { auroraColors = songColors; paintAurora(); }
    });
    const video = q(np, '.tn-cover video');
    const uri = item()?.uri;
    np.classList.remove('has-canvas');
    (settings.coverVideo ? trackCanvas(uri) : Promise.resolve('')).then((fileId) => {
      if (item()?.uri !== uri) return;
      playCanvas(video, fileId).then((ok) => {
        np.classList.toggle('has-canvas', ok && video.dataset.fileId === fileId);
        if (!npOpen) video.pause();
      });
    });
    loadLyrics();
    if (npOpen) renderFlow();
    syncSideCover();
    if (npOpen) renderQueue();
    syncState();
    requestAnimationFrame(fitMarquees);
  }

  function syncState() {
    const playing = P.isPlaying();
    // only touch the page when something actually changed
    const setHTML = (n, h) => { if (n.dataset.v !== h) { n.dataset.v = h; n.innerHTML = h; } };
    setHTML(q(bar, '.tb-play'), playing ? I.pause : I.play);
    setHTML(q(np, '.tn-play'), playing ? I.pause : I.play);
    np.classList.toggle('paused', !playing);
    html.classList.toggle('tess-playing', playing);
    const shuffle = P.getShuffle();
    const repeat = P.getRepeat();
    for (const b of [q(bar, '.tb-shuffle'), q(np, '.tn-shuffle')]) b.classList.toggle('active', !!shuffle);
    for (const b of [q(bar, '.tb-repeat'), q(np, '.tn-repeat')]) {
      b.classList.toggle('active', repeat > 0);
      b.classList.toggle('one', repeat === 2);
    }
    const sb = saveButton();
    const saved = sb ? /bright-accent/.test(sb.className) : P.getHeart();
    for (const b of [q(bar, '.tb-heart'), q(np, '.tn-heart')]) {
      b.classList.toggle('active', saved);
      setHTML(b, saved ? I.saved : I.unsaved);
      b.setAttribute('aria-label', saved ? 'Saved — change where it is saved' : 'Add to playlist');
    }
    const vol = P.getVolume();
    barVol.value = vol;
    npVol.value = vol;
    const quality = document.querySelector('[data-testid="context-item-info-quality"]')?.textContent?.trim() || '';
    if (q(bar, '.tb-quality').textContent !== quality) q(bar, '.tb-quality').textContent = quality;
    if (q(np, '.tn-quality').textContent !== quality) q(np, '.tn-quality').textContent = quality;
  }

  function syncProgress() {
    const ms = P.getProgress();
    const dur = P.getDuration() || 1;
    const pct = Math.min(100, (ms / dur) * 100) + '%';
    q(bar, '.tb-prog i').style.width = pct;
    if (npOpen) {
      placeArm(ms);
      markRibbon(ms);
      q(np, '.tn-scrub i').style.width = pct;
      q(np, '.tn-cur').textContent = fmt(ms);
      q(np, '.tn-rem').textContent = '-' + fmt(dur - ms);
      updateLyrics(ms);
    }
  }

  let alive = true;
  onDispose(() => { alive = false; });
  let npArt = null;
  let lastGlow = 0;
  function loop(now = performance.now()) {
    if (!npOpen || !alive) return;
    if (P.isPlaying() && now - lastGlow > 42) { lastGlow = now; paintGlow(q(np, '.tn-glow'), npArt, now / 1000); }
    syncProgress();
    requestAnimationFrame(loop);
  }

  const onSong = () => setTimeout(syncTrack, 50);
  P.addEventListener('songchange', onSong);
  onDispose(() => P.removeEventListener('songchange', onSong));
  P.addEventListener('onplaypause', syncState);
  onDispose(() => P.removeEventListener('onplaypause', syncState));
  every(250, () => { if (!npOpen) { syncProgress(); updateLyrics(P.getProgress()); } });
  // coming back to the window: resume the full-screen Canvas if the player is open (Spotify pauses videos while hidden)
  listen(document, 'visibilitychange', () => {
    if (!document.hidden && npOpen && np.classList.contains('has-canvas')) q(np, '.tn-cover video').play().catch(() => {});
  });
  every(2000, syncState);
  syncTrack();

  // ---------------- library: a timeline of what you've played ----------------
  // Your library as a listening history: Pinned first, then Today / Yesterday / This week / This month / Earlier,
  // on a thread whose node lights up on what's playing. A multi-select filter chooses which kinds of items show.
  // (The expanded and collapsed library modes stay Spotify's own.)
  const KINDS = [
    ['mine', 'Your playlists'], ['others', 'Saved playlists'], ['spotify', 'Made by Spotify'], ['blend', 'Blends'],
    ['album', 'Albums'], ['artist', 'Artists'], ['show', 'Podcasts'], ['audiobook', 'Audiobooks'],
    ['event', 'Events'], ['folder', 'Folders'], ['local', 'Local Files'],
  ];
  const kindOf = (i) => {
    if (i.type === 'playlist') {
      const own = (i.owner?.name || i.owner?.displayName || '').toLowerCase();
      if (own === 'spotify') return / \+ /.test(i.name) ? 'blend' : 'spotify';
      return i.isOwnedBySelf ? 'mine' : 'others';
    }
    if (i.type === 'album' || i.type === 'pre-release-album') return 'album';
    if (i.type === 'concert') return 'event';
    if (i.type === 'local-files') return 'local';
    if (i.type === 'episode' || i.type === 'show') return 'show';
    return i.type;
  };
  const libFilter = new Set((() => { try { return JSON.parse(localStorage.getItem('tess:libFilter') || 'null'); } catch { return null; } })() || KINDS.map((k) => k[0]));
  const saveLibFilter = () => { try { localStorage.setItem('tess:libFilter', JSON.stringify([...libFilter])); } catch {} };

  const timeline = el(`
    <section id="tess-timeline" aria-label="Your Library">
      <header class="tt-river-head"><h2>Your Library</h2><p class="tt-river-sub"></p></header>
      <div class="tt-bar">
        <label class="tt-search"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg><input type="search" placeholder="Search" aria-label="Search your library"></label>
        <button class="tt-filter" aria-haspopup="true" aria-expanded="false"><svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M1.5 3h13l-5 6v4.5l-3 1.5V9z"/></svg><span>Show</span><i></i></button>
      </div>
      <div class="tt-pop" hidden><div class="tt-chips"></div><div class="tt-pop-foot"><button class="tt-all">All</button><button class="tt-none">None</button></div></div>
      <div class="tt-list" role="list"></div>
    </section>`);
  onDispose(() => timeline.remove());
  onDispose(() => document.querySelectorAll('.tess-lib-hidden').forEach((n) => n.classList.remove('tess-lib-hidden')));
  const ttList = q(timeline, '.tt-list');
  const ttPop = q(timeline, '.tt-pop');
  const ttSearch = q(timeline, 'input');
  let libItems = [];
  let libSig = '';

  const libImage = (it) => {
    const u = it.images?.[0]?.url || '';
    if (u.startsWith('spotify:mosaic:')) return 'https://mosaic.scdn.co/300/' + u.split(':').slice(2).join('');
    if (u.startsWith('spotify:image:')) return imageUrl(u);
    return u.startsWith('http') ? u : '';
  };
  const libPath = (uri) => {
    if (uri === 'spotify:local-files') return '/collection/local-files';
    try { return Spicetify.URI.fromString(uri).toURLPath(true); } catch { const [, t, id] = uri.split(':'); return `/${t}/${id}`; }
  };
  const groupOf = (it) => {
    if (it.pinned) return 'Pinned';
    if (!it.lastPlayedAt) return 'Not played yet';
    const then = new Date(it.lastPlayedAt), now = new Date();
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day(now) - day(then)) / 864e5);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return 'This week';
    if (days < 31) return 'This month';
    return then.getFullYear() === now.getFullYear() ? then.toLocaleDateString(undefined, { month: 'long' }) : String(then.getFullYear());
  };
  const subOf = (it) => {
    const k = kindOf(it);
    const label = { mine: 'Playlist', others: 'Playlist', spotify: 'Made by Spotify', blend: 'Blend', album: 'Album', artist: 'Artist', show: 'Podcast', audiobook: 'Audiobook', event: 'Event', folder: 'Folder', local: 'Local Files' }[k] || '';
    const who = k === 'artist' || k === 'spotify' || k === 'blend' || k === 'local' ? '' : (it.artists?.[0]?.name || it.owner?.name || '');
    return who ? `${label} · ${who}` : label;
  };

  async function loadLibrary() {
    try {
      const L = Spicetify.Platform.LibraryAPI;
      let all = [], off = 0, total = 1;
      while (off < total && off < 2000) {
        const r = await L.getContents({ limit: 100, offset: off });
        total = r.totalLength; all = all.concat(r.items || []); off += 100;
      }
      const sig = all.map((i) => i.uri + i.lastPlayedAt + i.pinned + i.name).join('|');
      if (sig === libSig) return;
      libSig = sig;
      libItems = all;
      renderTimeline();
    } catch {}
  }

  function renderChips() {
    const present = new Set(libItems.map(kindOf));
    const box = q(ttPop, '.tt-chips');
    box.innerHTML = '';
    for (const [k, label] of KINDS) {
      if (!present.has(k)) continue;
      const n = libItems.filter((i) => kindOf(i) === k).length;
      const chip = el(`<button class="tt-chip" role="checkbox"><span></span><small></small></button>`);
      chip.setAttribute('aria-checked', String(libFilter.has(k)));
      q(chip, 'span').textContent = label;
      q(chip, 'small').textContent = n;
      chip.onclick = () => { libFilter.has(k) ? libFilter.delete(k) : libFilter.add(k); saveLibFilter(); renderChips(); renderTimeline(); };
      box.appendChild(chip);
    }
    const hiddenKinds = [...present].filter((k) => !libFilter.has(k)).length;
    q(timeline, '.tt-filter i').textContent = hiddenKinds ? String(present.size - hiddenKinds) : '';
    q(timeline, '.tt-filter').classList.toggle('narrowed', hiddenKinds > 0);
  }
  q(ttPop, '.tt-all').onclick = () => { KINDS.forEach(([k]) => libFilter.add(k)); saveLibFilter(); renderChips(); renderTimeline(); };
  q(ttPop, '.tt-none').onclick = () => { libFilter.clear(); saveLibFilter(); renderChips(); renderTimeline(); };
  q(timeline, '.tt-filter').onclick = (e) => {
    e.stopPropagation();
    ttPop.hidden = !ttPop.hidden;
    q(timeline, '.tt-filter').setAttribute('aria-expanded', String(!ttPop.hidden));
  };
  listen(document, 'click', (e) => { if (!ttPop.hidden && !ttPop.contains(e.target)) { ttPop.hidden = true; q(timeline, '.tt-filter').setAttribute('aria-expanded', 'false'); } });
  listen(ttSearch, 'input', () => renderTimeline());

  function renderTimeline() {
    renderChips();
    if (html.classList.contains('tess-lib-wide')) { renderShelves(); return; }
    timeline.classList.remove('shelves');
    const needle = ttSearch.value.trim().toLowerCase();
    const shown = libItems.filter((i) => libFilter.has(kindOf(i)) && (!needle || i.name.toLowerCase().includes(needle)));
    shown.sort((a, b) => (b.pinned - a.pinned) || String(b.lastPlayedAt || '').localeCompare(String(a.lastPlayedAt || '')));
    const frag = document.createDocumentFragment();
    const wide = html.classList.contains('tess-lib-wide');
    timeline.classList.toggle('river', wide);
    if (wide) {
      const kinds = shown.reduce((m, i) => { const k = kindOf(i); m[k] = (m[k] || 0) + 1; return m; }, {});
      q(timeline, '.tt-river-sub').textContent = `${shown.length} items · ${(kinds.artist || 0)} artists · ${(kinds.mine || 0) + (kinds.others || 0) + (kinds.spotify || 0) + (kinds.blend || 0)} playlists · ${kinds.album || 0} albums`;
    }
    let group = '';
    let chapter = null;
    let ruler = wide ? el('<div class="tt-ruler"></div>') : null;
    for (const it of shown) {
      const g = groupOf(it);
      if (g !== group) {
        group = g;
        if (wide) {
          chapter = el('<section class="tt-chapter"><h3></h3><small></small><div class="tt-covers"></div></section>');
          q(chapter, 'h3').textContent = g;
          q(chapter, 'small').textContent = `${shown.filter((x) => groupOf(x) === g).length}`;
          frag.appendChild(chapter);
          const tick = el('<button class="tt-tick"><i></i><span></span></button>');
          q(tick, 'span').textContent = g;
          const target = chapter;
          tick.onclick = () => target.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
          ruler.appendChild(tick);
        } else {
          const h = el('<div class="tt-group" role="presentation"></div>');
          h.textContent = g;
          frag.appendChild(h);
        }
      }
      const row = el('<div class="tt-item" role="listitem" tabindex="0"><span class="tt-art"></span><span class="tt-text"><b></b><small></small></span></div>');
      row.dataset.uri = it.uri;
      row.dataset.name = it.name;
      row.title = it.name;
      const art = q(row, '.tt-art');
      const img = libImage(it);
      if (img) art.style.backgroundImage = `url("${img}")`;
      else art.classList.add('tt-local');
      if (it.type === 'artist') row.classList.add('round');
      q(row, 'b').textContent = it.name;
      q(row, 'small').textContent = subOf(it);
      row.onclick = () => Spicetify.Platform.History.push(libPath(it.uri));
      row.ondblclick = () => Spicetify.Player.playUri(it.uri);
      row.onkeydown = (e) => { if (e.key === 'Enter') row.onclick(); };
      if (wide && chapter) {
        const covers = q(chapter, '.tt-covers');
        if (!covers.children.length) row.classList.add('lead');
        covers.appendChild(row);
      } else frag.appendChild(row);
    }
    q(timeline, '.tt-ruler')?.remove();
    if (ruler) timeline.appendChild(ruler);
    if (!shown.length) {
      const empty = el('<div class="tt-empty"></div>');
      empty.textContent = libItems.length ? 'Nothing matches. Change what’s shown with the filter above.' : '';
      frag.appendChild(empty);
    }
    ttList.replaceChildren(frag);
    markTimeline();
    requestAnimationFrame(flow);
  }

  // Cover Flow: in the river, covers turn toward you as they pass the middle (transforms only, once per frame
  // while scrolling); the mouse wheel moves through time sideways.
  let flowQueued = false;
  function flow() {
    flowQueued = false;
    if (!timeline.classList.contains('river')) return;
    // two rows of covers fill the height the river has
    const cell = Math.max(130, Math.min(380, Math.floor((ttList.clientHeight - 170) / 2)));
    ttList.style.setProperty('--cell', cell + 'px');
    const box = ttList.getBoundingClientRect();
    const mid = box.left + box.width / 2;
    for (const c of ttList.querySelectorAll('.tt-item')) {
      const r = c.getBoundingClientRect();
      if (r.right < box.left - 200 || r.left > box.right + 200) continue;
      const d = Math.max(-1, Math.min(1, (r.left + r.width / 2 - mid) / (box.width / 2)));
      c.style.setProperty('--ry', (-d * 18).toFixed(1) + 'deg');
      c.style.setProperty('--tz', (-Math.abs(d) * 60).toFixed(0) + 'px');
    }
    const ticks = timeline.querySelectorAll('.tt-tick');
    const chapters = ttList.querySelectorAll('.tt-chapter');
    let active = 0;
    chapters.forEach((ch, i) => { if (ch.getBoundingClientRect().left < mid) active = i; });
    ticks.forEach((t, i) => t.classList.toggle('on', i === active));
  }
  listen(ttList, 'scroll', () => { if (!flowQueued) { flowQueued = true; requestAnimationFrame(flow); } }, { passive: true });
  listen(ttList, 'wheel', (e) => {
    if (!timeline.classList.contains('river') || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    ttList.scrollLeft += e.deltaY * 1.4;
  }, { passive: false });

  // ---------------- full-size library: Glass Shelves ----------------
  // One glass shelf per kind. Each record stands by its spine: a strip in the cover's own colour with the title
  // running up it and a small cover at the foot, like a real sleeve on a shelf. Hover (or focus) slides the sleeve
  // out to show the whole cover, with the record peeking from it. Artists stand as round portraits.
  const spineColors = (() => { try { return JSON.parse(localStorage.getItem('tess:spines') || '{}'); } catch { return {}; } })();
  let spineSaveTimer = 0;
  function spineColor(url, apply) {
    if (spineColors[url]) { apply(spineColors[url]); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 6;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, 6, 6);
        const d = x.getImageData(0, 0, 6, 6).data;
        // the most colourful of the cover's tones, not the muddy average
        let best = [40, 40, 46], score = -1;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const sat = Math.max(r, g, b) - Math.min(r, g, b), lum = (r + g + b) / 3;
          const sc = sat * (1 - Math.abs(lum - 120) / 160);
          if (sc > score) { score = sc; best = [r, g, b]; }
        }
        spineColors[url] = best;
        clearTimeout(spineSaveTimer);
        spineSaveTimer = setTimeout(() => { try { localStorage.setItem('tess:spines', JSON.stringify(spineColors)); } catch {} }, 1500);
        apply(best);
      } catch {}
    };
    img.src = url;
  }
  const SHELVES = [
    ['Playlists', (k) => k === 'mine' || k === 'others' || k === 'spotify' || k === 'blend' || k === 'folder' || k === 'local'],
    ['Albums', (k) => k === 'album'],
    ['Artists', (k) => k === 'artist'],
    ['Podcasts & books', (k) => k === 'show' || k === 'audiobook'],
    ['Events', (k) => k === 'event'],
  ];
  // Shelves read like a Mac dock: spines near the pointer swell and their titles grow, so names are easy to read
  // without pulling every record out. Transforms only, once a frame.
  let magQueued = false, magX = 0, magRow = null;
  listen(ttList, 'mousemove', (e) => {
    const row = e.target.closest?.('.ts-shelfrow');
    if (!row) return;
    magRow = row; magX = e.clientX;
    if (!magQueued) { magQueued = true; requestAnimationFrame(magnify); }
  }, { passive: true });
  listen(ttList, 'mouseleave', () => { ttList.querySelectorAll('.ts-sleeve').forEach((s) => s.style.removeProperty('--mag')); });
  function magnify() {
    magQueued = false;
    if (!magRow) return;
    for (const s of magRow.querySelectorAll('.ts-sleeve')) {
      const r = s.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - magX);
      const m = Math.max(0, 1 - d / 170);
      s.style.setProperty('--mag', (m * m * (3 - 2 * m)).toFixed(3));
    }
  }
  // records arrive on the shelf one after another when the library opens full size
  function stagger() {
    let i = 0;
    for (const s of ttList.querySelectorAll('.ts-sleeve, .ts-artist')) {
      if (i > 60) break;
      s.style.animationDelay = (i++ * 14) + 'ms';
      s.classList.add('ts-arrive');
    }
  }

  function renderShelves() {
    timeline.classList.remove('river');
    timeline.classList.add('shelves');
    q(timeline, '.tt-ruler')?.remove();
    const needle = ttSearch.value.trim().toLowerCase();
    const shown = libItems.filter((i) => libFilter.has(kindOf(i)) && (!needle || i.name.toLowerCase().includes(needle)));
    shown.sort((a, b) => (b.pinned - a.pinned) || String(b.lastPlayedAt || '').localeCompare(String(a.lastPlayedAt || '')));
    const kinds = shown.reduce((m, i) => { const k = kindOf(i); m[k] = (m[k] || 0) + 1; return m; }, {});
    q(timeline, '.tt-river-sub').textContent = `${shown.length} items · ${kinds.artist || 0} artists · ${shown.length - (kinds.artist || 0) - (kinds.album || 0)} playlists · ${kinds.album || 0} albums`;
    const frag = document.createDocumentFragment();
    for (const [label, test] of SHELVES) {
      const items = shown.filter((i) => test(kindOf(i)));
      if (!items.length) continue;
      const shelf = el('<section class="ts-shelf"><header><h3></h3><small></small></header><div class="ts-shelfrow"></div><i class="ts-plank"></i></section>');
      q(shelf, 'h3').textContent = label;
      q(shelf, 'small').textContent = items.length;
      const row = q(shelf, '.ts-shelfrow');
      for (const it of items) {
        const img = libImage(it);
        const isArtist = it.type === 'artist';
        const rec = el(isArtist
          ? '<div class="tt-item ts-artist" tabindex="0"><span class="ts-face"></span><b></b></div>'
          : '<div class="tt-item ts-sleeve" tabindex="0"><span class="ts-disc"></span><span class="ts-cover"></span><span class="ts-spine"><b></b><i class="ts-thumb"></i></span></div>');
        rec.dataset.uri = it.uri;
        rec.dataset.name = it.name;
        rec.title = `${it.name} — ${subOf(it)}`;
        q(rec, 'b').textContent = it.name;
        if (isArtist) {
          if (img) q(rec, '.ts-face').style.backgroundImage = `url("${img}")`;
        } else {
          if (img) {
            q(rec, '.ts-cover').style.backgroundImage = `url("${img}")`;
            q(rec, '.ts-thumb').style.backgroundImage = `url("${img}")`;
            spineColor(img, (c) => rec.style.setProperty('--spine', c.join(',')));
          } else rec.classList.add('ts-local');
          if (it.pinned) rec.classList.add('ts-pinned');
        }
        rec.onclick = () => Spicetify.Platform.History.push(libPath(it.uri));
        rec.ondblclick = () => Spicetify.Player.playUri(it.uri);
        rec.onkeydown = (e) => { if (e.key === 'Enter') rec.onclick(); };
        row.appendChild(rec);
      }
      frag.appendChild(shelf);
    }
    ttList.replaceChildren(frag);
    markTimeline();
    stagger();
  }

  function markTimeline() {
    const ctx = P.data?.context?.uri || P.data?.context_uri || '';
    const here = route();
    for (const row of ttList.querySelectorAll('.tt-item')) {
      const u = row.dataset.uri;
      if (!u) continue;
      row.classList.toggle('playing', !!ctx && (ctx === u || (u === 'spotify:local-files' && /local-files/.test(ctx))));
      row.classList.toggle('here', here === libPath(u));
    }
  }

  // Put the timeline in place of Spotify's list (when the library is at its normal width).
  // remove anything an older copy of this script left behind, before placing ours
  const sweepStale = () => {
    for (const [sel, mine] of [['#tess-timeline', timeline], ['.tess-cover-wrap', coverWrap], ['.tess-side-lyrics', side]]) {
      document.querySelectorAll(sel).forEach((n) => { if (n !== mine) n.remove(); });
    }
  };
  let libWidth = 420;
  const libWidthObserver = new ResizeObserver(([e]) => { libWidth = e.contentRect.width; placeTimeline(); });
  onDispose(() => { libWidthObserver.disconnect(); document.querySelectorAll('[data-tess-sized]').forEach((n) => delete n.dataset.tessSized); });
  const placeTimeline = () => {
    sweepStale();
    const lib = document.getElementById('Desktop_LeftSidebar_Id');
    if (!lib) return;
    // width comes from a ResizeObserver, never a forced layout on every draw
    if (!lib.dataset.tessSized) {
      lib.dataset.tessSized = '1';
      libWidthObserver.observe(lib);
      libWidth = lib.getBoundingClientRect().width;
    }
    const width = libWidth;
    const wasWide = html.classList.contains('tess-lib-wide');
    html.classList.toggle('tess-lib-wide', width > 640);
    if (wasWide !== html.classList.contains('tess-lib-wide') && libItems.length) renderTimeline();
    html.classList.toggle('tess-lib-rail', width < 160);
    const head = lib.querySelector('header')?.parentElement;
    const listBlock = head?.nextElementSibling && head.nextElementSibling !== timeline ? head.nextElementSibling : timeline.nextElementSibling;
    if (!head) return;
    if (timeline.previousElementSibling !== head) head.after(timeline);
    head.querySelector('[role="listbox"]')?.closest('header ~ div, header + *')?.classList.add('tess-lib-hidden');
    if (listBlock && listBlock !== timeline) listBlock.classList.add('tess-lib-hidden');
    const sig = route() + '|' + (P.data?.context?.uri || '');
    if (sig !== lastMarkSig) { lastMarkSig = sig; markTimeline(); }
  };
  let lastMarkSig = '';
  onDraw(placeTimeline);
  placeTimeline();
  // Expand / minimise / collapse the library as one morph (View Transitions) instead of a jump.
  let libMorphing = false;
  listen(document, 'click', (e) => {
    const btn = e.target instanceof Element && e.target.closest('#Desktop_LeftSidebar_Id button, #Desktop_LeftSidebar_Id ~ * button');
    const label = btn?.getAttribute('aria-label') || '';
    if (!/^(Expand|Minimize|Collapse|Open) Your Library$/.test(label) || libMorphing || !document.startViewTransition || document.hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    libMorphing = true;
    const lib = document.getElementById('Desktop_LeftSidebar_Id');
    const before = lib?.getBoundingClientRect().width;
    const vt = document.startViewTransition(async () => {
      btn.click();
      await waitFor(() => lib && Math.abs(lib.getBoundingClientRect().width - before) > 20, 400);
      placeTimeline();
    });
    vt.ready.catch(() => {});
    vt.finished.catch(() => {}).finally(() => { libMorphing = false; });
  }, true);
  // Spotify announces every library change (pin, unpin, save, remove, rename); reload right away on those,
  // coalesced so a burst of changes is one reload. The slow timer is only a backup.
  let libReloadQueued = false;
  const onLibChange = (e) => {
    // a pin or unpin carries its answer, so show it immediately; then confirm with one fresh read
    const d = e?.data;
    if (e?.type === 'update_pin' && d?.uri) {
      const it = libItems.find((i) => i.uri === d.uri);
      if (it && it.pinned !== d.isPinned) { it.pinned = d.isPinned; libSig = ''; renderTimeline(); }
    }
    if (libReloadQueued) return;
    libReloadQueued = true;
    Promise.resolve().then(() => { libReloadQueued = false; loadLibrary(); });
  };
  const LIB_EVENTS = ['update', 'update_pin', 'update_item', 'operation_complete'];
  try {
    const libEvents = Spicetify.Platform.LibraryAPI.getEvents();
    for (const name of LIB_EVENTS) libEvents.addListener(name, onLibChange);
    onDispose(() => { for (const name of LIB_EVENTS) libEvents.removeListener(name, onLibChange); });
  } catch {}
  every(60000, loadLibrary);
  loadLibrary();
  // what's playing lights up now; a few seconds later the library reloads so it moves to Today
  const onLibSong = () => { markTimeline(); setTimeout(loadLibrary, 3000); };
  P.addEventListener('songchange', onLibSong);
  onDispose(() => P.removeEventListener('songchange', onLibSong));

  // ---------------- ⌘K spotlight ----------------
  // A floating search over everything: instant results as you type, arrows to move, Enter to play a song or open
  // anything else, ⌘Enter to play an album/playlist/artist straight away. Empty, it offers what you played last.
  const spot = mount(el(`
    <div id="tess-spot" hidden>
      <div class="ts-panel" role="dialog" aria-label="Search">
        <label class="ts-field"><svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg><input placeholder="Search songs, artists, albums, playlists" aria-label="Search"><kbd>esc</kbd></label>
        <div class="ts-results" role="listbox"></div>
        <div class="ts-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> play song / open</span><span><kbd>⌘</kbd><kbd>↵</kbd> play</span></div>
      </div>
    </div>`));
  const spotInput = q(spot, 'input');
  const spotList = q(spot, '.ts-results');
  let spotItems = [];
  let spotSel = 0;
  let spotSeq = 0;
  const typeLabel = { Artist: 'Artist', Album: 'Album', Track: 'Song', Playlist: 'Playlist', Podcast: 'Podcast', Episode: 'Episode', Audiobook: 'Audiobook' };
  function openSpot() {
    spot.hidden = false;
    spotInput.value = '';
    spotInput.focus();
    runSpot('');
  }
  function closeSpot() { spot.hidden = true; }
  function drawSpot() {
    spotList.replaceChildren(...spotItems.map((it, i) => {
      const row = el('<div class="ts-row" role="option"><span class="ts-art"><img alt=""></span><span class="ts-text"><b></b><small></small></span><span class="ts-kind"></span></div>');
      row.setAttribute('aria-selected', String(i === spotSel));
      row.dataset.uri = it.uri;
      row.dataset.name = it.name;
      if (it.img) q(row, 'img').src = it.img;
      if (it.round) row.classList.add('round');
      q(row, 'b').textContent = it.name;
      q(row, 'small').textContent = it.sub;
      q(row, '.ts-kind').textContent = it.kind;
      row.onmouseenter = () => { spotSel = i; spotList.querySelectorAll('.ts-row').forEach((r, k) => r.setAttribute('aria-selected', String(k === i))); };
      row.onclick = (e) => actSpot(it, e.metaKey || e.ctrlKey);
      return row;
    }));
    if (!spotItems.length && spotInput.value.trim()) spotList.appendChild(el('<p class="ts-empty">No results</p>'));
  }
  async function runSpot(term) {
    const seq = ++spotSeq;
    if (!term.trim()) {
      try {
        const recent = await Spicetify.Platform.RecentlyPlayedAPI.getContexts();
        if (seq !== spotSeq) return;
        spotItems = (recent || []).slice(0, 8).map((c) => ({ uri: c.uri, name: c.name, sub: 'Played recently', kind: (c.type || '').replace(/^./, (x) => x.toUpperCase()), img: imageUrl(c.images?.[0]?.url || ''), round: c.type === 'artist' }));
      } catch { spotItems = []; }
    } else {
      try {
        const r = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.searchModalResults, { searchTerm: term, offset: 0, limit: 10, numberOfTopResults: 10, includeAudiobooks: true, includeArtistHasConcertsField: false, includePreReleases: false, includeLocalConcertsField: false, includeAuthors: false });
        if (seq !== spotSeq) return;
        spotItems = (r?.data?.searchV2?.topResultsV2?.itemsV2 || []).map((x) => {
          const d = x.item?.data || {};
          return {
            uri: d.uri,
            name: d.name || d.profile?.name || '',
            sub: d.artists?.items?.map((a) => a.profile?.name).join(', ') || d.ownerV2?.data?.name || d.publisher?.name || '',
            kind: typeLabel[d.__typename] || d.__typename || '',
            img: d.albumOfTrack?.coverArt?.sources?.[0]?.url || d.coverArt?.sources?.[0]?.url || d.visuals?.avatarImage?.sources?.[0]?.url || d.images?.items?.[0]?.sources?.[0]?.url || '',
            round: d.__typename === 'Artist',
            isTrack: d.__typename === 'Track',
          };
        }).filter((i) => i.uri && i.name);
      } catch { spotItems = []; }
    }
    // last row: Spotify's full search page for everything else (songs lists, podcasts, profiles, genres)
    if (term.trim()) spotItems.push({ uri: '', name: `See all results for “${term.trim()}”`, sub: 'Opens Spotify search', kind: '', img: '', all: term.trim() });
    spotSel = 0;
    drawSpot();
  }
  function actSpot(it, playNow) {
    if (!it) return;
    closeSpot();
    if (it.all) { Spicetify.Platform.History.push('/search/' + encodeURIComponent(it.all)); return; }
    if (it.isTrack || playNow) Spicetify.Player.playUri(it.uri);
    else Spicetify.Platform.History.push(Spicetify.URI.fromString(it.uri).toURLPath(true));
  }
  let spotTimer = 0;
  listen(spotInput, 'input', () => { clearTimeout(spotTimer); spotTimer = setTimeout(() => runSpot(spotInput.value), 140); });
  listen(spotInput, 'keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!spotItems.length) return;
      spotSel = (spotSel + (e.key === 'ArrowDown' ? 1 : -1) + spotItems.length) % spotItems.length;
      drawSpot();
      spotList.children[spotSel]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); actSpot(spotItems[spotSel], e.metaKey || e.ctrlKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSpot(); }
  });
  listen(spot, 'pointerdown', (e) => { if (e.target === spot) closeSpot(); });
  // The top search box opens this panel too (Spotify's own dropdown stays closed); typing carries over.
  listen(document, 'pointerdown', (e) => {
    const input = e.target instanceof Element && e.target.closest('#global-nav-bar form[role="search"]') && document.querySelector('#global-nav-bar form[role="search"] input');
    if (!input || e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    openSpot();
  }, true);
  listen(document, 'focusin', (e) => {
    if (e.target instanceof Element && e.target.matches('#global-nav-bar form[role="search"] input') && spot.hidden && !route().startsWith('/search')) { e.target.blur(); openSpot(); }
  }, true);
  listen(document, 'keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); spot.hidden ? openSpot() : closeSpot(); }
  }, true);

  // ---------------- right-click: Spotify's real menus on Tess's own items ----------------
  // Spotify builds its item menus inside its library rows. Tess keeps that list (hidden) and, when you right-click
  // one of its own items, finds Spotify's row for the same thing and right-clicks it at your pointer, so you get the
  // exact Spotify menu (queue, edit, delete, folders, pin, share...). Rows only exist near the top of the list, so if
  // it isn't there Tess types the name into Spotify's (hidden) library filter first and clears it afterwards.
  // Things that aren't in your library (search results, recommendations) get a small Tess menu instead.
  const libRowUri = (u) => (u === 'spotify:local-files' ? 'spotify:collection:local-files' : u);
  // list rows in the sidebar, cards when the library is expanded
  const findSpotifyRow = (uri) => document.getElementById('listrow-title-' + libRowUri(uri))?.closest('[data-encore-id="listRow"]')
    || document.querySelector(`#Desktop_LeftSidebar_Id [id="card-title-${libRowUri(uri)}"]`)?.closest('[data-encore-id="card"]');
  const libFilterInput = () => [...document.querySelectorAll('#Desktop_LeftSidebar_Id input[type="search"], #Desktop_LeftSidebar_Id input[placeholder]')].find((i) => !i.closest('#tess-timeline'));
  const setReactValue = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  async function openItemMenu(it, e) {
    e.preventDefault();
    e.stopPropagation();
    const at = { clientX: e.clientX, clientY: e.clientY };
    let row = findSpotifyRow(it.uri);
    let filtered = null;
    if (!row && it.name && libItems.some((i) => i.uri === it.uri)) {
      filtered = libFilterInput();
      if (filtered) {
        setReactValue(filtered, it.name);
        row = await waitFor(() => findSpotifyRow(it.uri), 1800);
      }
    }
    if (row) {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...at }));
      if (filtered) {
        // clear the filter once the menu has closed
        const clear = setInterval(() => { if (!document.querySelector('#context-menu')) { clearInterval(clear); setReactValue(filtered, ''); } }, 300);
      }
      return;
    }
    if (filtered) setReactValue(filtered, '');
    openTessMenu(it, at);
  }
  const tessMenu = mount(el('<div id="tess-menu" role="menu" hidden></div>'));
  function openTessMenu(it, at) {
    const isTrack = it.uri.startsWith('spotify:track:');
    const path = (() => { try { return Spicetify.URI.fromString(it.uri).toURLPath(true); } catch { return ''; } })();
    const entries = [
      ['Play', () => Spicetify.Player.playUri(it.uri)],
      isTrack && ['Add to queue', () => Spicetify.addToQueue([{ uri: it.uri }])],
      path && ['Open', () => Spicetify.Platform.History.push(path)],
      ['Save to Your Library', () => Spicetify.Platform.LibraryAPI.add({ uris: [it.uri] })],
      ['Copy link', () => navigator.clipboard.writeText('https://open.spotify.com' + (path || ''))],
    ].filter(Boolean);
    tessMenu.replaceChildren(...entries.map(([label, fn]) => {
      const b = el('<button role="menuitem"></button>');
      b.textContent = label;
      b.onclick = () => { tessMenu.hidden = true; fn(); };
      return b;
    }));
    tessMenu.hidden = false;
    const w = 220, h = entries.length * 38 + 12;
    tessMenu.style.left = Math.min(at.clientX, innerWidth - w - 8) + 'px';
    tessMenu.style.top = Math.min(at.clientY, innerHeight - h - 8) + 'px';
  }
  listen(document, 'pointerdown', (e) => { if (!tessMenu.hidden && !tessMenu.contains(e.target)) tessMenu.hidden = true; }, true);
  listen(document, 'keydown', (e) => { if (e.key === 'Escape') tessMenu.hidden = true; });
  // one listener for every Tess-drawn item
  listen(document, 'contextmenu', (e) => {
    const t = e.target instanceof Element && e.target.closest('.tt-item, .td-cover, .ts-row, .otd-song, [data-tess-uri]');
    if (!t) return;
    const uri = t.dataset.uri || t.dataset.tessUri;
    if (!uri) return;
    openItemMenu({ uri, name: t.dataset.name || t.title || t.querySelector('b')?.textContent || '' }, e);
  }, true);

  // ---------------- cover-to-page transition ----------------
  // Click a cover anywhere and it flies into the header of the album or playlist that opens (View Transitions).
  let pendingCover = null;
  listen(document, 'pointerdown', (e) => {
    const holder = e.target instanceof Element && e.target.closest('[data-encore-id="card"], [data-encore-id="listRow"], [role="row"], .tt-item, .td-cover, .view-homeShortcutsGrid-shortcut, .td-open');
    const img = holder?.classList.contains('td-open') ? document.querySelector('.td-cover.on img') : holder?.querySelector('img');
    const art = !img && holder?.querySelector('.tt-art');
    pendingCover = img || art ? { node: img || art, at: performance.now() } : null;
  }, true);
  const History = Spicetify.Platform.History;
  const originalPush = History.push;
  const waitFor = (find, ms) => new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => { const n = find(); if (n || performance.now() - t0 > ms) resolve(n || null); else setTimeout(tick, 16); };
    tick();
  });
  History.push = function tessPush(to, ...rest) {
    const path = typeof to === 'string' ? to : to?.pathname || '';
    const cover = pendingCover && performance.now() - pendingCover.at < 1200 ? pendingCover.node : null;
    pendingCover = null;
    if (!cover || !document.startViewTransition || document.hidden || !/^\/(album|playlist|collection)\b/.test(path) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return originalPush.call(this, to, ...rest);
    }
    let dest = null;
    cover.style.viewTransitionName = 'tess-cover';
    const vt = document.startViewTransition(async () => {
      cover.style.viewTransitionName = '';
      originalPush.call(this, to, ...rest);
      // the screen is frozen while this waits, so never long: if the new page isn't drawn quickly, just cross-fade
      dest = await waitFor(() => document.querySelector('.main-entityHeader-imageContainer img, .main-entityHeader-image'), 220);
      if (dest) dest.style.viewTransitionName = 'tess-cover';
    });
    vt.ready.catch(() => {});
    vt.finished.catch(() => {}).finally(() => { if (dest) dest.style.viewTransitionName = ''; cover.style.viewTransitionName = ''; });
  };
  onDispose(() => { History.push = originalPush; });

  // ---------------- artist pages: full-height motion header ----------------
  const canvasCache = new Map();
  // A song's Canvas: from the player's data when it's the current song, otherwise asked of Spotify.
  async function trackCanvas(trackUri) {
    if (!trackUri) return '';
    const m = item()?.uri === trackUri ? meta() : {};
    if (m['canvas.fileId'] && String(m['canvas.type'] || '').startsWith('VIDEO')) return m['canvas.fileId'];
    if (!trackCanvasCache.has(trackUri)) {
      trackCanvasCache.set(trackUri, Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.canvas, { trackUri })
        .then((c) => { const cv = c?.data?.trackUnion?.canvas; return cv?.fileId && String(cv.type).startsWith('VIDEO') ? cv.fileId : ''; })
        .catch(() => ''));
      if (trackCanvasCache.size > 40) trackCanvasCache.delete(trackCanvasCache.keys().next().value);
    }
    return trackCanvasCache.get(trackUri);
  }

  // Spotify keeps decoding its own Canvas in the panel even though Tess hides it; stop it whenever it starts.
  listen(document, 'play', (e) => {
    const v = e.target;
    if (v instanceof HTMLVideoElement && !v.matches('.tess-video, .tess-hero-video, #tess-np video') && v.closest('.Root__right-sidebar-peek') && !v.checkVisibility()) v.pause();
  }, true);
  async function artistCanvas(artistUri) {
    if (canvasCache.has(artistUri)) return canvasCache.get(artistUri);
    let fileId = '';
    try {
      const r = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.queryArtistOverview, {
        uri: artistUri, locale: '', includePrerelease: false,
      });
      const tracks = r?.data?.artistUnion?.discography?.topTracks?.items || [];
      // ask about all six at once; take the first in chart order that has a video
      const found = await Promise.all(tracks.slice(0, 6).map((t) => Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.canvas, { trackUri: t.track.uri })
        .then((c) => { const cv = c?.data?.trackUnion?.canvas; return cv?.fileId && String(cv.type).startsWith('VIDEO') ? cv.fileId : ''; })
        .catch(() => '')));
      fileId = found.find(Boolean) || '';
    } catch {}
    // remember only real answers; a failed or empty lookup is retried next time
    if (fileId) canvasCache.set(artistUri, fileId);
    return fileId;
  }

  function findHeaderBackground() {
    const root = document.querySelector('.before-scroll-node');
    if (!root) return null;
    return [...root.querySelectorAll('div')].find((d) => /url\(/.test(getComputedStyle(d).backgroundImage));
  }

  // Light or dark text, picked from how bright the bottom of the header is.
  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 12;
  function headerIsLight(source) {
    try {
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      const w = source.videoWidth || source.naturalWidth;
      const h = source.videoHeight || source.naturalHeight;
      if (!w || !h) return null;
      ctx.drawImage(source, 0, h * 0.62, w, h * 0.3, 0, 0, 32, 12);
      const d = ctx.getImageData(0, 0, 32, 12).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return sum / (d.length / 4) > 168;
    } catch {
      return null;
    }
  }

  let heroTimer = 0;
  onDispose(() => clearInterval(heroTimer));
  function setHeroHeight() {
    const mv = document.querySelector('#main-view');
    if (!mv) return;
    // end the header so the play/follow row sits just above the floating bar on the first screen
    const page = document.querySelector('[data-testid="artist-page"]');
    const hdr = page?.querySelector('.main-entityHeader-container');
    const bar = document.getElementById('tess-bar')?.getBoundingClientRect();
    const r = mv.getBoundingClientRect();
    if (!hdr) return html.style.setProperty('--tess-hero-h', Math.round(r.height) + 'px');
    let scroller = hdr.parentElement;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const top0 = hdr.getBoundingClientRect().top + (scroller?.scrollTop || 0);
    const limit = (bar ? bar.top : r.bottom - 80) - 12;
    const actions = page.querySelector('[data-testid="action-bar"]')?.getBoundingClientRect().height || 104;
    html.style.setProperty('--tess-hero-h', Math.round(limit - actions - top0) + 'px');
  }
  onDispose(() => html.style.removeProperty('--tess-hero-h'));

  let lastArtistPage = null;
  async function onRoute() {
    const path = route();
    const isArtist = path.startsWith('/artist/');
    html.classList.toggle('tess-artist', isArtist);
    html.classList.toggle('tess-on-settings', path.startsWith('/preferences'));
    html.classList.remove('tess-hero-light', 'tess-hero-past', 'tess-artist-portrait');
    document.querySelectorAll('.tess-hero-made').forEach((n) => n.remove());
    html.style.setProperty('--tess-scroll-p', '0');
    clearInterval(heroTimer);
    if (!isArtist) {
      html.classList.remove('tess-hero-wait');
      if (artistColors) { artistColors = null; auroraColors = songColors; paintAurora(); }
      return;
    }
    setHeroHeight();
    const artistUri = 'spotify:artist:' + path.split('/')[2];
    // Start the video straight away, before Spotify has even drawn the header, into a video element that waits
    // offstage. Until it's ready (or we know there isn't one) the header picture stays hidden, so you go
    // straight from a dark page to the video instead of photo → cover → video.
    // Per artist you can pick Photo or Video (a small switch on the page); the default is the video.
    const heroPrefs = (() => { try { return JSON.parse(localStorage.getItem('tess:heroPref') || '{}'); } catch { return {}; } })();
    const wantVideo = settings.artistVideo && heroPrefs[artistUri] !== 'photo';
    html.classList.toggle('tess-hero-wait', wantVideo);
    const unwait = () => { if (route() === path) html.classList.remove('tess-hero-wait'); };
    setTimeout(unwait, 3000);
    const early = wantVideo ? (async () => {
      const fileId = await artistCanvas(artistUri);
      if (!fileId) return null;
      // created in the page's own document: a template-made video is inert and never loads media
      const v = document.createElement('video');
      v.className = 'tess-hero-video';
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      return (await playCanvas(v, fileId)) ? v : null;
    })() : Promise.resolve(null);
    // wait for the NEW artist's page; right after a route change the previous page is still in the DOM
    const oldPage = lastArtistPage;
    for (let t = 0; t < 60; t++) {
      const pg = document.querySelector('[data-testid="artist-page"]');
      if (pg && pg !== oldPage && pg.querySelector('.main-entityHeader-container')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    lastArtistPage = document.querySelector('[data-testid="artist-page"]');
    if (route() !== path) return;
    let bg = null;
    for (let tries = 0; tries < 60 && !bg; tries++) {
      // Spotify marks artists without a header photo with a "Norm" header: stop waiting for one
      if (tries > 8 && document.querySelector('[data-testid="artist-page"] .main-entityHeader-container img')) break;
      bg = findHeaderBackground();
      if (!bg) await new Promise((r) => setTimeout(r, tries < 20 ? 50 : 200));
    }
    if (!bg && route() === path) {
      // No header photo (smaller artists): build one from their portrait, softly blurred and enlarged, so the page
      // still opens on a full-height picture; the portrait itself is centred above the name.
      const hdr = document.querySelector('[data-testid="artist-page"] .main-entityHeader-container');
      const portrait = hdr?.querySelector('img')?.src;
      const holder = document.querySelector('.before-scroll-node');
      if (hdr && portrait && holder) {
        holder.querySelectorAll('.tess-hero-made').forEach((n) => n.remove());
        const wrap = el('<div class="tess-hero-made"><div class="tess-hero-bg tess-hero-portrait"></div></div>');
        wrap.firstElementChild.style.backgroundImage = `url("${portrait}")`;
        holder.appendChild(wrap);
        html.classList.add('tess-artist-portrait');
        bg = wrap.firstElementChild;
      }
    }
    if (!bg || route() !== path) { unwait(); return; }
    bg.classList.add('tess-hero-bg');
    // the Photo / Video switch, top right of the header; shown only when this artist has a video
    document.querySelectorAll('.tess-hero-switch').forEach((n) => n.remove());
    const hasVideo = settings.artistVideo && !!(await artistCanvas(artistUri));
    if (hasVideo && route() === path) {
      const sw = el('<div class="tess-hero-switch" role="radiogroup" aria-label="Header"><button data-v="photo">Photo</button><button data-v="video">Video</button></div>');
      const current = heroPrefs[artistUri] === 'photo' ? 'photo' : 'video';
      sw.querySelectorAll('button').forEach((b) => {
        b.setAttribute('aria-checked', String(b.dataset.v === current));
        b.onclick = () => {
          const prefs = (() => { try { return JSON.parse(localStorage.getItem('tess:heroPref') || '{}'); } catch { return {}; } })();
          if (b.dataset.v === 'photo') prefs[artistUri] = 'photo'; else delete prefs[artistUri];
          try { localStorage.setItem('tess:heroPref', JSON.stringify(prefs)); } catch {}
          onRoute();
        };
      });
      (document.querySelector('[data-testid="artist-page"] .main-entityHeader-container') || bg.parentElement).appendChild(sw);
      onDispose(() => sw.remove());
    }
    const fitHero = () => {
      setHeroHeight();
      // the video stays behind the whole page, like Apple Music; scrolling blurs and dims it instead of cutting it off
      const mv = document.querySelector('#main-view');
      if (!mv || !bg.isConnected) return;
      const h = Math.round(mv.getBoundingClientRect().bottom - bg.parentElement.getBoundingClientRect().top);
      // the picture fills the whole page area (CSS); clear any fixed height an older version set
      bg.style.removeProperty('height');
      bg.parentElement.style.removeProperty('height');
      void h;
    };
    fitHero();
    heroScroll(artistScroller());
    setTimeout(fitHero, 400);
    setTimeout(fitHero, 1200);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (route() === path) { artistColors = paletteOf(img); if (artistColors) { auroraColors = artistColors; paintAurora(); } }
      const light = headerIsLight(img);
      if (light !== null && route() === path) html.classList.toggle('tess-hero-light', light);
    };
    img.src = (getComputedStyle(bg).backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || '';

    bg.querySelectorAll('video.tess-hero-video').forEach((old) => old.remove());
    if (!wantVideo) { unwait(); return; }
    const v = await early;
    if (route() !== path) return;
    if (!v) { unwait(); return; }
    bg.appendChild(v);
    v.classList.add('ready');
    unwait();
    {
      heroTimer = setInterval(() => {
        if (!v.isConnected) return clearInterval(heroTimer);
        // reading pixels back from the GPU isn't free: only while the title is over the video and the window is visible
        if (document.hidden || heroP > 0.4) return;
        const light = headerIsLight(v);
        if (light !== null) html.classList.toggle('tess-hero-light', light);
      }, 4000);
    }
  }
  // Scroll drives two things on artist pages: Spotify's top strip stays hidden while the hero fills the page,
  // and --tess-scroll-p (0 at the top, 1 once the header is gone) blurs and dims the video behind.
  let heroP = 0;
  function heroScroll(scroller) {
    if (!html.classList.contains('tess-artist') || !scroller?.contains(document.querySelector('[data-testid="artist-page"]'))) return;
    const hero = parseInt(getComputedStyle(html).getPropertyValue('--tess-hero-h')) || 600;
    html.classList.toggle('tess-hero-past', scroller.scrollTop > hero - 160);
    heroP = Math.min(1, Math.max(0, scroller.scrollTop / (hero * 0.75)));
    html.style.setProperty('--tess-scroll-p', heroP.toFixed(3));
    // once the video is a soft blur there's no point decoding it
    const v = document.querySelector('video.tess-hero-video.ready');
    if (v) { if (heroP > 0.97) { if (!v.paused) v.pause(); } else if (v.paused && !document.hidden) v.play().catch(() => {}); }
  }
  const artistScroller = () => {
    let e = document.querySelector('[data-testid="artist-page"]');
    while (e && !/auto|scroll/.test(getComputedStyle(e).overflowY)) e = e.parentElement;
    return e;
  };
  listen(document, 'scroll', (e) => {
    if (!(e.target instanceof Element)) return;
    heroScroll(e.target);
    // track lists: the sticky column header turns to glass only while it is actually stuck
    const head = e.target.querySelector?.('.main-trackList-trackListHeader');
    if (head) head.classList.toggle('tess-stuck', head.getBoundingClientRect().top <= parseFloat(getComputedStyle(head).top) + e.target.getBoundingClientRect().top + 1 && e.target.scrollTop > 0);
  }, { capture: true, passive: true });
  const unlisten = Spicetify.Platform.History.listen(() => setTimeout(onRoute, 0));
  onDispose(() => typeof unlisten === 'function' && unlisten());
  listen(window, 'resize', () => { setHeroHeight(); setTimeout(onRoute, 100); });
  // for checking things from DevTools: window.__tessDebug.artistCanvas(uri), .playCanvas(video, fileId)
  self.debug = { artistCanvas, playCanvas, trackCanvas, onRoute: () => onRoute() };
  onboarding();
  onDraw(applyGlass, 4000);
  applyGlass();
  startWatch();
  sweepStale();
  placeTimeline();
  onRoute();
})();
