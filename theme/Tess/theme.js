// Tess Music — Spicetify theme script.
// Adds the floating playing bar, the full-screen Now Playing view with synced lyrics,
// and motion on artist pages. Everything reads from and drives Spotify's own player.
(async function tess() {
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
  const imageUrl = (u) => (u && u.startsWith('spotify:image:') ? 'https://i.scdn.co/image/' + u.split(':')[2] : u || '');
  const item = () => P.data?.item;
  const meta = () => item()?.metadata || {};
  const artUrl = () => imageUrl(meta().image_xlarge_url || meta().image_large_url || meta().image_url);
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const spotifyButton = (sel) => document.querySelector(`[data-testid="now-playing-bar"] ${sel}`);

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
    saved: '<svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.3l3 3 6-6.3" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    unsaved: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 7.5v9M7.5 12h9" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  };

  // ---------------- floating playing bar ----------------
  const bar = el(`
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
          <div class="tb-title"><span></span><button class="tb-heart" aria-label="Save to Liked Songs">${I.unsaved}</button></div>
          <div class="tb-sub"><span></span></div>
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
    </div>`);
  document.body.appendChild(bar);
  document.documentElement.classList.add('tess');

  const q = (root, s) => root.querySelector(s);
  q(bar, '.tb-play').onclick = () => P.togglePlay();
  q(bar, '.tb-prev').onclick = () => P.back();
  q(bar, '.tb-next').onclick = () => P.next();
  q(bar, '.tb-shuffle').onclick = () => { P.toggleShuffle(); setTimeout(syncState, 150); };
  q(bar, '.tb-repeat').onclick = () => { P.toggleRepeat(); setTimeout(syncState, 150); };
  const saveButton = () =>
    [...document.querySelectorAll('[data-testid="now-playing-widget-v2"] button, [data-testid="now-playing-widget"] button')]
      .find((b) => /playlist|liked songs/i.test(b.getAttribute('aria-label') || ''));
  const toggleSave = () => { saveButton()?.click(); setTimeout(syncState, 400); };
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
  const np = el(`
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
      </div>
      <div class="tn-stage">
        <div class="tn-player">
          <div class="tn-cover"><img alt=""><video muted loop playsinline></video></div>
          <div class="tn-meta">
            <div class="tn-text"><h2></h2><p><span></span></p></div>
            <button class="tn-round tn-heart" aria-label="Save to Liked Songs">${I.unsaved}</button>
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
    </div>`);
  document.body.appendChild(np);

  let npOpen = false;
  function openNP(mode) {
    npOpen = true;
    setMode(mode || 'lyrics');
    np.classList.add('open');
    np.setAttribute('aria-hidden', 'false');
    renderQueue();
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
  }
  q(np, '.tn-close').onclick = closeNP;
  q(np, '.tn-mini').onclick = () => { closeNP(); spotifyButton('[data-testid="pip-toggle-button"]')?.click(); };
  q(np, '.tn-devices').onclick = () => spotifyButton('button[aria-label="Connect to a device"]')?.click();
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
  document.addEventListener('keydown', (e) => {
    if (!npOpen) return;
    if (e.key === 'Escape') closeNP();
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); P.togglePlay(); }
  });

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
          syllables: (l.syllables || []).map((s) => ({ start: Number(s.startTimeMs), chars: s.numChars ?? s.charCount })),
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
    for (const [i, l] of lyrics.lines.entries()) {
      const isGap = !l.text || /^♪+$/.test(l.text.replace(/\s/g, ''));
      const line = el(`<div class="tn-line${isGap ? ' gap' : ''}"></div>`);
      line.textContent = isGap ? '• • •' : l.text;
      if (lyrics.sync !== 'UNSYNCED') line.onclick = () => P.seek(l.start + 1);
      line.dataset.i = i;
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

  const LEAD_MS = 120; // highlight slightly ahead of the audio, as Apple Music does
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
      // Fill across the line in time with the song; with no word timings from Spotify,
      // the fill is spread over the time until the next line.
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
    if (!fileId) { video.removeAttribute('src'); video.load(); return false; }
    if (video.dataset.fileId === fileId) return true;
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
    const sub = [m.artist_name, m.album_title].filter(Boolean).join(' — ');
    q(bar, '.tb-art img').src = art;
    q(bar, '.tb-title span').textContent = title;
    q(bar, '.tb-sub span').textContent = sub;
    q(np, '.tn-cover img').src = art;
    q(np, '.tn-text h2').textContent = title;
    q(np, '.tn-text p span').textContent = sub;
    np.style.setProperty('--art', art ? `url("${art}")` : 'none');
    const video = q(np, '.tn-cover video');
    const fileId = String(m['canvas.type'] || '').startsWith('VIDEO') ? m['canvas.fileId'] : '';
    np.classList.remove('has-canvas');
    if (!fileId) delete video.dataset.fileId;
    playCanvas(video, fileId).then((ok) => np.classList.toggle('has-canvas', ok && video.dataset.fileId === fileId));
    loadLyrics();
    if (npOpen) renderQueue();
    syncState();
  }

  function syncState() {
    const playing = P.isPlaying();
    q(bar, '.tb-play').innerHTML = playing ? I.pause : I.play;
    q(np, '.tn-play').innerHTML = (playing ? I.pause : I.play).replace(/width="16" height="18"/, 'width="30" height="34"');
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

  function loop() {
    if (!npOpen) return;
    syncProgress();
    requestAnimationFrame(loop);
  }

  P.addEventListener('songchange', () => setTimeout(syncTrack, 50));
  P.addEventListener('onplaypause', syncState);
  setInterval(() => { if (!npOpen) syncProgress(); }, 250);
  setInterval(syncState, 2000);
  syncTrack();

  // ---------------- artist pages: motion header ----------------
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

  async function onRoute() {
    const path = Spicetify.Platform.History.location?.pathname || '';
    document.documentElement.classList.toggle('tess-artist', path.startsWith('/artist/'));
    if (!path.startsWith('/artist/')) return;
    const artistUri = 'spotify:artist:' + path.split('/')[2];
    let bg = null;
    for (let tries = 0; tries < 20 && !bg; tries++) {
      bg = findHeaderBackground();
      if (!bg) await new Promise((r) => setTimeout(r, 200));
    }
    if (!bg) return;
    bg.classList.add('tess-hero-bg');
    const fitHero = () => {
      const hdr = document.querySelector('[data-testid="artist-page"] .main-entityHeader-container');
      if (!hdr || !bg.isConnected) return;
      const h = hdr.getBoundingClientRect().bottom - bg.getBoundingClientRect().top;
      if (h > 0) bg.style.setProperty('height', h + 'px', 'important');
    };
    fitHero();
    setTimeout(fitHero, 600);
    const fileId = await artistCanvas(artistUri);
    if (!fileId || (Spicetify.Platform.History.location?.pathname || '') !== path) return;
    let v = bg.querySelector('video.tess-hero-video');
    if (!v) {
      v = el('<video class="tess-hero-video" muted loop playsinline></video>');
      bg.appendChild(v);
    }
    v.classList.remove('ready');
    if (await playCanvas(v, fileId)) v.classList.add('ready');
  }
  window.addEventListener('resize', () => setTimeout(onRoute, 100));
  Spicetify.Platform.History.listen(() => setTimeout(onRoute, 50));
  onRoute();
})();
