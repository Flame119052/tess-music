// Tess Music — Spicetify theme script.
// Adds the floating playing bar, the full-screen Now Playing view with synced lyrics,
// the artwork-tinted window, Tess settings, and the full-height artist header.
// Everything reads from and drives Spotify's own player.
(async function tess() {
  window.__tess?.dispose?.();
  const disposers = [];
  const onDispose = (fn) => disposers.push(fn);
  window.__tess = { dispose: () => disposers.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} }) };

  const ready = () =>
    window.Spicetify?.Player?.data !== undefined &&
    Spicetify.Platform?.History &&
    Spicetify.CosmosAsync &&
    Spicetify.GraphQL?.Definitions &&
    document.querySelector('[data-testid="now-playing-bar"]');
  while (!ready()) await new Promise((r) => setTimeout(r, 300));

  const P = Spicetify.Player;
  const el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const mount = (node, parent = document.body) => { parent.appendChild(node); onDispose(() => node.remove()); return node; };
  const every = (ms, fn) => { const id = setInterval(fn, ms); onDispose(() => clearInterval(id)); };
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); onDispose(() => target.removeEventListener(type, fn, opts)); };
  const imageUrl = (u) => (u && u.startsWith('spotify:image:') ? 'https://i.scdn.co/image/' + u.split(':')[2] : u || '');
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
  const DEFAULTS = { coverVideo: true, artistVideo: true, tintWindow: true };
  const settings = (() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tess:settings') || '{}') }; } catch { return { ...DEFAULTS }; }
  })();
  const saveSettings = () => { try { localStorage.setItem('tess:settings', JSON.stringify(settings)); } catch {} };

  const html = document.documentElement;
  html.classList.add('tess');
  onDispose(() => html.classList.remove('tess', 'tess-artist', 'tess-tint', 'tess-hero-light'));
  const applySettings = () => html.classList.toggle('tess-tint', settings.tintWindow);
  applySettings();

  function openSettings() {
    const rows = [
      ['coverVideo', 'Canvas video in the full-screen player', 'Shows the song’s looping Canvas video in place of the album art when it has one.'],
      ['artistVideo', 'Video on artist pages', 'Loops a Canvas video from the artist’s top songs behind their name.'],
      ['tintWindow', 'Tint the window with the album colors', 'The panels pick up the colors of what’s playing.'],
    ];
    const box = el('<div class="tess-settings"></div>');
    for (const [key, title, hint] of rows) {
      const row = el('<label class="tess-set-row"><div><b></b><span></span></div><input type="checkbox" role="switch"></label>');
      row.querySelector('b').textContent = title;
      row.querySelector('span').textContent = hint;
      const input = row.querySelector('input');
      input.checked = settings[key];
      input.onchange = () => { settings[key] = input.checked; saveSettings(); applySettings(); syncTrack(); onRoute(); };
      box.appendChild(row);
    }
    Spicetify.PopupModal.display({ title: 'Tess Music', content: box, isLarge: false });
  }
  if (Spicetify.Menu?.Item) {
    const menuItem = new Spicetify.Menu.Item('Tess Music settings', false, openSettings);
    menuItem.register();
    onDispose(() => menuItem.deregister());
  }

  const I = {
    shuffle: '<svg viewBox="0 0 26 22" width="18" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5h4c6 0 8 12 14 12h3M2 17h4c2.5 0 4-2 5.5-4.5M14.5 9.5C16 7 17.5 5 20 5h3M20 2l3 3-3 3M20 14l3 3-3 3"/></svg>',
    repeat: '<svg viewBox="0 0 26 22" width="18" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10V9a4 4 0 0 1 4-4h14M19 2l3 3-3 3M22 12v1a4 4 0 0 1-4 4H4M7 20l-3-3 3-3"/></svg>',
    prev: '<svg viewBox="0 0 44 28" width="26" height="17" fill="currentColor"><path d="M21 3v22L4 14zM40 3v22L23 14z"/></svg>',
    next: '<svg viewBox="0 0 44 28" width="26" height="17" fill="currentColor"><path d="M4 3v22l17-11zM23 3v22l17-11z"/></svg>',
    pause: '<svg viewBox="0 0 34 36" width="16" height="18" fill="currentColor"><rect x="5" y="3" width="8" height="30" rx="2"/><rect x="21" y="3" width="8" height="30" rx="2"/></svg>',
    play: '<svg viewBox="0 0 34 36" width="16" height="18" fill="currentColor"><path d="M7 3.5v29a1.5 1.5 0 0 0 2.3 1.3l22-14.5a1.5 1.5 0 0 0 0-2.6L9.3 2.2A1.5 1.5 0 0 0 7 3.5z"/></svg>',
    lyrics: '<svg viewBox="0 0 24 22" width="19" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 1.5C6.2 1.5 1.5 5.3 1.5 10c0 2.7 1.5 5.1 3.9 6.6L4.5 20.5l4.3-2.3c1 .3 2.1.4 3.2.4 5.8 0 10.5-3.8 10.5-8.6S17.8 1.5 12 1.5z"/><path d="M7.5 8.5h3v2.5c0 1.3-.6 2.2-1.8 2.6M13.5 8.5h3v2.5c0 1.3-.6 2.2-1.8 2.6" stroke-width="1.5"/></svg>',
    queue: '<svg viewBox="0 0 22 16" width="19" height="15" fill="currentColor"><circle cx="2" cy="2" r="1.6"/><circle cx="2" cy="8" r="1.6"/><circle cx="2" cy="14" r="1.6"/><rect x="6" y="1" width="16" height="2" rx="1"/><rect x="6" y="7" width="16" height="2" rx="1"/><rect x="6" y="13" width="16" height="2" rx="1"/></svg>',
    devices: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="10" r="2.2"/><path d="M7.5 15a6.5 6.5 0 1 1 9 0M4.6 17.8a10.5 10.5 0 1 1 14.8 0"/><path d="M8 22h8l-4-5z" fill="currentColor" stroke="none"/></svg>',
    volume: '<svg viewBox="0 0 26 22" width="20" height="18" fill="currentColor"><path d="M3 8h4l6-5v16l-6-5H3z"/><path d="M16 7a5 5 0 0 1 0 8M19 4a9 9 0 0 1 0 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    mini: '<svg viewBox="0 0 26 22" width="19" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="1.5" y="1.5" width="17" height="13" rx="3"/><rect x="10" y="9" width="14.5" height="11" rx="2.5" fill="currentColor"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1L5.3 5.3"/></svg>',
    saved: '<svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.3l3 3 6-6.3" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    unsaved: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 7.5v9M7.5 12h9" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  };

  // ---------------- window tint (album colors behind the panels) ----------------
  const ambient = mount(el('<div id="tess-ambient" aria-hidden="true"><i></i></div>'));

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
      <div class="tn-bg"><div class="tn-a a1"></div><div class="tn-a a2"></div><div class="tn-a a3"></div><div class="tn-shade"></div></div>
      <div class="tn-pill tl">
        <button class="tn-close" aria-label="Close">${I.close}</button>
        <button class="tn-mini" aria-label="Open Miniplayer">${I.mini}</button>
      </div>
      <div class="tn-pill tr">
        <button class="tn-devices" aria-label="Connect to a device">${I.devices}</button>
        <input class="tn-vol" type="range" min="0" max="1" step="0.01" aria-label="Volume">
        <span class="tn-volicon">${I.volume}</span>
        <button class="tn-gear" aria-label="Tess Music settings">${I.gear}</button>
      </div>
      <div class="tn-stage">
        <div class="tn-player">
          <div class="tn-cover"><img alt=""><video muted loop playsinline></video></div>
          <div class="tn-meta">
            <div class="tn-text"><h2></h2><p class="tess-marquee"><span></span></p></div>
            <button class="tn-round tn-heart" aria-label="Add to playlist">${I.unsaved}</button>
            <button class="tn-round tn-more" aria-label="Go to album">${I.more}</button>
          </div>
          <div class="tn-scrub"><i></i></div>
          <div class="tn-times"><span class="tn-cur">0:00</span><span class="tn-quality"></span><span class="tn-rem">-0:00</span></div>
          <div class="tn-btns">
            <button class="tn-shuffle tn-sm" aria-label="Shuffle">${I.shuffle}</button>
            <button class="tn-prev" aria-label="Previous">${I.prev}</button>
            <button class="tn-play" aria-label="Play or pause">${I.pause}</button>
            <button class="tn-next" aria-label="Next">${I.next}</button>
            <button class="tn-repeat tn-sm" aria-label="Repeat">${I.repeat}</button>
          </div>
        </div>
        <div class="tn-lyrics"><div class="tn-lines"></div><div class="tn-note"></div></div>
        <div class="tn-queue"><h4>Playing Next</h4><div class="tn-qlist"></div></div>
      </div>
      <div class="tn-pill br">
        <button class="tn-lyr on" aria-label="Lyrics">${I.lyrics}</button>
        <button class="tn-q" aria-label="Playing next">${I.queue}</button>
      </div>
    </div>`));

  let npOpen = false;
  function openNP(mode) {
    npOpen = true;
    setMode(mode || 'lyrics');
    np.classList.add('open');
    np.setAttribute('aria-hidden', 'false');
    renderQueue();
    requestAnimationFrame(fitMarquees);
    loop();
  }
  function closeNP() {
    npOpen = false;
    np.classList.remove('open');
    np.setAttribute('aria-hidden', 'true');
  }
  function setMode(m) {
    np.classList.remove('mode-lyrics', 'mode-queue', 'mode-none');
    np.classList.add('mode-' + m);
    q(np, '.tn-lyr').classList.toggle('on', m === 'lyrics');
    q(np, '.tn-q').classList.toggle('on', m === 'queue');
    if (m === 'queue') renderQueue();
    lastLine = -2;
    requestAnimationFrame(fitMarquees);
  }
  q(np, '.tn-close').onclick = closeNP;
  q(np, '.tn-mini').onclick = () => { closeNP(); spotifyButton('[data-testid="pip-toggle-button"]')?.click(); };
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

  function renderLyrics() {
    linesEl.innerHTML = '';
    np.classList.toggle('unsynced', lyrics.sync === 'UNSYNCED');
    if (!lyrics.lines.length) {
      noteEl.textContent = lyrics.sync === 'LOADING' ? '' : 'Lyrics aren’t available for this song';
      return;
    }
    noteEl.textContent = '';
    for (const l of lyrics.lines) {
      const isGap = !l.text || /^♪+$/.test(l.text.replace(/\s/g, ''));
      const line = el(`<div class="tn-line${isGap ? ' gap' : ''}"></div>`);
      line.textContent = isGap ? '• • •' : l.text;
      if (lyrics.sync !== 'UNSYNCED') line.onclick = () => P.seek(l.start + 1);
      linesEl.appendChild(line);
    }
    lastLine = -2;
  }

  function lineAt(ms) {
    let lo = 0, hi = lyrics.lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lyrics.lines[mid].start <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  const LEAD_MS = 120;
  function updateLyrics(ms) {
    if (!lyrics.lines.length || lyrics.sync === 'UNSYNCED' || !np.classList.contains('mode-lyrics')) return;
    const t = ms + LEAD_MS;
    const i = lineAt(t);
    const nodes = linesEl.children;
    if (i !== lastLine) {
      lastLine = i;
      for (let j = 0; j < nodes.length; j++) {
        const d = Math.abs(j - Math.max(i, 0));
        nodes[j].classList.toggle('on', j === i);
        nodes[j].classList.toggle('past', j < i);
        nodes[j].style.filter = j === i ? 'none' : `blur(${Math.min(d * 0.9, 4.5).toFixed(1)}px)`;
      }
      const target = nodes[Math.max(i, 0)];
      if (target) linesEl.style.transform = `translateY(${-target.offsetTop}px)`;
    }
    if (i >= 0) {
      const l = lyrics.lines[i];
      const span = Math.max(400, l.end - l.start);
      const p = Math.min(1, Math.max(0, (t - l.start) / Math.min(span, 400 + l.text.length * 130)));
      nodes[i]?.style.setProperty('--p', (p * 100).toFixed(1) + '%');
    }
  }

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
    if (!fileId) { delete video.dataset.fileId; video.removeAttribute('src'); video.load(); return false; }
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
      video.src = URL.createObjectURL(ms);
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
      await video.play().catch(() => {});
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
    ambient.style.setProperty('--art', artCss);
    const video = q(np, '.tn-cover video');
    const fileId = settings.coverVideo && String(m['canvas.type'] || '').startsWith('VIDEO') ? m['canvas.fileId'] : '';
    np.classList.remove('has-canvas');
    playCanvas(video, fileId).then((ok) => np.classList.toggle('has-canvas', ok && video.dataset.fileId === fileId));
    loadLyrics();
    if (npOpen) renderQueue();
    syncState();
    requestAnimationFrame(fitMarquees);
  }

  function syncState() {
    const playing = P.isPlaying();
    q(bar, '.tb-play').innerHTML = playing ? I.pause : I.play;
    q(np, '.tn-play').innerHTML = playing ? I.pause : I.play;
    np.classList.toggle('paused', !playing);
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
      b.innerHTML = saved ? I.saved : I.unsaved;
      b.setAttribute('aria-label', saved ? 'Saved — change where it is saved' : 'Add to playlist');
    }
    const vol = P.getVolume();
    barVol.value = vol;
    npVol.value = vol;
    const quality = document.querySelector('[data-testid="context-item-info-quality"]')?.textContent?.trim() || '';
    q(bar, '.tb-quality').textContent = quality;
    q(np, '.tn-quality').textContent = quality;
  }

  function syncProgress() {
    const ms = P.getProgress();
    const dur = P.getDuration() || 1;
    const pct = Math.min(100, (ms / dur) * 100) + '%';
    q(bar, '.tb-prog i').style.width = pct;
    if (npOpen) {
      q(np, '.tn-scrub i').style.width = pct;
      q(np, '.tn-cur').textContent = fmt(ms);
      q(np, '.tn-rem').textContent = '-' + fmt(dur - ms);
      updateLyrics(ms);
    }
  }

  let alive = true;
  onDispose(() => { alive = false; });
  function loop() {
    if (!npOpen || !alive) return;
    syncProgress();
    requestAnimationFrame(loop);
  }

  const onSong = () => setTimeout(syncTrack, 50);
  P.addEventListener('songchange', onSong);
  onDispose(() => P.removeEventListener('songchange', onSong));
  P.addEventListener('onplaypause', syncState);
  onDispose(() => P.removeEventListener('onplaypause', syncState));
  every(250, () => { if (!npOpen) syncProgress(); });
  every(2000, syncState);
  syncTrack();

  // ---------------- artist pages: full-height motion header ----------------
  const canvasCache = new Map();
  async function artistCanvas(artistUri) {
    if (canvasCache.has(artistUri)) return canvasCache.get(artistUri);
    let fileId = '';
    try {
      const r = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.queryArtistOverview, {
        uri: artistUri, locale: '', includePrerelease: false,
      });
      const tracks = r?.data?.artistUnion?.discography?.topTracks?.items || [];
      for (const t of tracks.slice(0, 6)) {
        const c = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.canvas, { trackUri: t.track.uri });
        const cv = c?.data?.trackUnion?.canvas;
        if (cv?.fileId && String(cv.type).startsWith('VIDEO')) { fileId = cv.fileId; break; }
      }
    } catch {}
    canvasCache.set(artistUri, fileId);
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
    if (mv) html.style.setProperty('--tess-hero-h', Math.round(mv.getBoundingClientRect().height) + 'px');
  }
  onDispose(() => html.style.removeProperty('--tess-hero-h'));

  async function onRoute() {
    const path = route();
    const isArtist = path.startsWith('/artist/');
    html.classList.toggle('tess-artist', isArtist);
    html.classList.remove('tess-hero-light');
    clearInterval(heroTimer);
    if (!isArtist) return;
    setHeroHeight();
    const artistUri = 'spotify:artist:' + path.split('/')[2];
    let bg = null;
    for (let tries = 0; tries < 25 && !bg; tries++) {
      bg = findHeaderBackground();
      if (!bg) await new Promise((r) => setTimeout(r, 200));
    }
    if (!bg || route() !== path) return;
    bg.classList.add('tess-hero-bg');
    const fitHero = () => {
      const hdr = document.querySelector('[data-testid="artist-page"] .main-entityHeader-container');
      if (!hdr || !bg.isConnected) return;
      const h = Math.round(hdr.getBoundingClientRect().bottom - bg.getBoundingClientRect().top);
      if (h > 0) {
        bg.style.setProperty('height', h + 'px', 'important');
        bg.parentElement.style.setProperty('height', h + 'px', 'important');
      }
    };
    fitHero();
    setTimeout(fitHero, 400);
    setTimeout(fitHero, 1200);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const light = headerIsLight(img);
      if (light !== null && route() === path) html.classList.toggle('tess-hero-light', light);
    };
    img.src = (getComputedStyle(bg).backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1] || '';

    let v = bg.querySelector('video.tess-hero-video');
    if (!settings.artistVideo) { v?.remove(); return; }
    const fileId = await artistCanvas(artistUri);
    if (!fileId || route() !== path) return;
    if (!v) {
      v = el('<video class="tess-hero-video" muted loop playsinline></video>');
      bg.appendChild(v);
    }
    v.classList.remove('ready');
    if (await playCanvas(v, fileId)) {
      v.classList.add('ready');
      heroTimer = setInterval(() => {
        if (!v.isConnected) return clearInterval(heroTimer);
        const light = headerIsLight(v);
        if (light !== null) html.classList.toggle('tess-hero-light', light);
      }, 1500);
    }
  }
  const unlisten = Spicetify.Platform.History.listen(() => setTimeout(onRoute, 50));
  onDispose(() => typeof unlisten === 'function' && unlisten());
  listen(window, 'resize', () => { setHeroHeight(); setTimeout(onRoute, 100); });
  onRoute();
})();
