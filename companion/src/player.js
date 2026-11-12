// Tess companion — the playing bar and the full-screen player.
// A slim glass bar pinned above the tab bar, and a full-screen player with the theme's rotating artwork
// light, a record that spins while music plays, synced lyrics when Spotify has them, and the queue.
// The progress runs on rAF between sync anchors, so it never steps.
window.TessPlayer = (function () {
  'use strict';

  const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const I = {
    prev: '<svg viewBox="0 0 44 28" width="22" height="14" fill="currentColor"><path d="M21 3v22L4 14zM40 3v22L23 14z"/></svg>',
    next: '<svg viewBox="0 0 44 28" width="22" height="14" fill="currentColor"><path d="M4 3v22l17-11zM23 3v22l17-11z"/></svg>',
    pause: '<svg viewBox="0 0 34 36" width="15" height="17" fill="currentColor"><rect x="5" y="3" width="8" height="30" rx="2"/><rect x="21" y="3" width="8" height="30" rx="2"/></svg>',
    play: '<svg viewBox="0 0 34 36" width="15" height="17" fill="currentColor"><path d="M7 3.5v29a1.5 1.5 0 0 0 2.3 1.3l22-14.5a1.5 1.5 0 0 0 0-2.6L9.3 2.2A1.5 1.5 0 0 0 7 3.5z"/></svg>',
    heart: '<svg viewBox="0 0 24 22" width="17" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20S2.5 14.5 2.5 8.2C2.5 5 5 2.8 7.7 2.8c1.8 0 3.4 1 4.3 2.5.9-1.5 2.5-2.5 4.3-2.5 2.7 0 5.2 2.2 5.2 5.4C21.5 14.5 12 20 12 20z"/></svg>',
    saved: '<svg viewBox="0 0 24 22" width="17" height="16" fill="currentColor"><path d="M12 20S2.5 14.5 2.5 8.2C2.5 5 5 2.8 7.7 2.8c1.8 0 3.4 1 4.3 2.5.9-1.5 2.5-2.5 4.3-2.5 2.7 0 5.2 2.2 5.2 5.4C21.5 14.5 12 20 12 20z"/></svg>',
    shuffle: '<svg viewBox="0 0 26 22" width="17" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5h4c6 0 8 12 14 12h3M2 17h4c2.5 0 4-2 5.5-4.5M14.5 9.5C16 7 17.5 5 20 5h3M20 2l3 3-3 3M20 14l3 3-3 3"/></svg>',
    repeat: '<svg viewBox="0 0 26 22" width="17" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10V9a4 4 0 0 1 4-4h14M19 2l3 3-3 3M22 12v1a4 4 0 0 1-4 4H4M7 20l-3-3 3-3"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
    devices: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6.2 15.6a7.6 7.6 0 1 1 11.6 0"/><path d="M8.9 13.2a4.1 4.1 0 1 1 6.2 0"/><circle cx="12" cy="10" r="1.4" fill="currentColor" stroke="none"/><path d="M12 15.4l3.6 4.6H8.4z" fill="currentColor" stroke="none"/></svg>',
  };

  // ---------------- bottom bar ----------------
  let bar = null;
  function mountBar(parent) {
    bar = el(`
      <div id="tcp" role="region" aria-label="Now playing">
        <div class="tcp-prog"><i></i></div>
        <button class="tcp-art"><img alt="" draggable="false"></button>
        <div class="tcp-text"><b></b><small></small></div>
        <button class="tcp-play" aria-label="Play or pause"></button>
        <button class="tcp-next" aria-label="Next"></button>
      </div>`);
    bar.querySelector('.tcp-play').innerHTML = I.play;
    bar.querySelector('.tcp-next').innerHTML = I.next;
    bar.querySelector('.tcp-play').onclick = () => TessSync.togglePlay();
    bar.querySelector('.tcp-next').onclick = () => TessSync.next();
    bar.onclick = (e) => { if (!e.target.closest('button')) open(); };
    parent.appendChild(bar);
    return bar;
  }

  // ---------------- full-screen player ----------------
  let np = null;
  let glow = null;
  let npOpen = false;
  let raf = 0;
  let lastGlow = 0;
  let lastNpUri = '';

  function mountNp(parent) {
    np = el(`
      <div id="tcnp" aria-hidden="true">
        <canvas class="tcnp-glow" width="128" height="72"></canvas>
        <div class="tcnp-shade"></div>
        <div class="tcnp-top">
          <button class="tcnp-close" aria-label="Close">${I.close}</button>
          <button class="tcnp-devices" aria-label="Devices">${I.devices}</button>
        </div>
        <div class="tcnp-stage">
          <div class="tcnp-disc"><img alt="" draggable="false"></div>
          <div class="tcnp-meta"><div class="tcnp-text"><b></b><small></small></div><button class="tcnp-heart" aria-label="Save"></button></div>
          <div class="tcnp-scrub"><i></i></div>
          <div class="tcnp-times"><span class="cur">0:00</span><span class="rem">-0:00</span></div>
          <div class="tcnp-btns">
            <button class="b-shuffle" aria-label="Shuffle">${I.shuffle}</button>
            <button class="b-prev" aria-label="Previous">${I.prev}</button>
            <button class="b-play" aria-label="Play or pause"></button>
            <button class="b-next" aria-label="Next">${I.next}</button>
            <button class="b-repeat" aria-label="Repeat">${I.repeat}</button>
          </div>
          <div class="tcnp-tabs"><button class="t-lyr on">Lyrics</button><button class="t-q">Playing next</button></div>
          <div class="tcnp-panels">
            <div class="tcnp-lyrics"><div class="lines"></div><p class="tcnp-note" hidden>Lyrics aren't available for this song</p></div>
            <div class="tcnp-queue" hidden><div class="qlist"></div></div>
          </div>
        </div>
      </div>`);
    glow = TessAurora.Glow(np.querySelector('.tcnp-glow'));
    np.querySelector('.tcnp-close').onclick = close;
    np.querySelector('.tcnp-devices').onclick = () => TessApp.openDevices();
    np.querySelector('.tcnp-heart').onclick = () => TessSync.toggleSave();
    np.querySelector('.b-play').onclick = () => TessSync.togglePlay();
    np.querySelector('.b-prev').onclick = () => TessSync.prev();
    np.querySelector('.b-next').onclick = () => TessSync.next();
    np.querySelector('.b-shuffle').onclick = () => TessSync.toggleShuffle();
    np.querySelector('.b-repeat').onclick = () => TessSync.toggleRepeat();
    np.querySelector('.t-lyr').onclick = () => setMode('lyrics');
    np.querySelector('.t-q').onclick = () => setMode('queue');
    scrubGestures(np.querySelector('.tcnp-scrub'));
    parent.appendChild(np);
  }

  function setMode(m) {
    np.querySelector('.tcnp-lyrics').hidden = m !== 'lyrics';
    np.querySelector('.tcnp-queue').hidden = m !== 'queue';
    np.querySelector('.t-lyr').classList.toggle('on', m === 'lyrics');
    np.querySelector('.t-q').classList.toggle('on', m === 'queue');
    if (m === 'queue') fillQueue();
  }

  // tap / drag anywhere on the scrub line to seek
  function scrubGestures(box) {
    const at = (e) => {
      const r = box.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    };
    let dragging = false;
    box.addEventListener('pointerdown', (e) => { dragging = true; box.setPointerCapture(e.pointerId); const d = TessSync.state.duration || 1; TessSync.seek(at(e) * d); });
    box.addEventListener('pointermove', (e) => { if (!dragging) return; const d = TessSync.state.duration || 1; TessSync.seek(at(e) * d); });
    box.addEventListener('pointerup', () => { dragging = false; });
  }

  function open() {
    npOpen = true;
    np.setAttribute('aria-hidden', 'false');
    np.classList.add('open');
    syncUi();
    loop();
  }
  function close() {
    npOpen = false;
    np.classList.remove('open');
    np.setAttribute('aria-hidden', 'true');
    cancelAnimationFrame(raf);
  }
  const isOpen = () => npOpen;

  function loop() {
    if (!npOpen) return;
    const st = TessSync.state;
    const p = TessSync.progress();
    const d = st.duration || 1;
    np.querySelector('.tcnp-scrub i').style.width = Math.min(100, (p / d) * 100) + '%';
    np.querySelector('.cur').textContent = fmt(p);
    np.querySelector('.rem').textContent = '-' + fmt(Math.max(0, d - p));
    if (st.playing && performance.now() - lastGlow > 42) { lastGlow = performance.now(); glow.paint(performance.now() / 1000); }
    updateLyrics(p);
    raf = requestAnimationFrame(loop);
  }

  // ---------------- lyrics ----------------
  let lyrics = { uri: null, sync: 'NONE', lines: [] };
  let lastLine = -2;
  async function loadLyrics(t) {
    if (!t?.id || t.uri === lyrics.uri) return;
    lyrics = { uri: t.uri, sync: 'LOADING', lines: [] };
    lastLine = -2;
    const linesBox = np.querySelector('.lines');
    linesBox.replaceChildren();
    const res = await TessAPI.lyrics(t.id);
    if (TessSync.state.track?.uri !== t.uri) return;
    if (!res || !res.lines.length) { lyrics = { uri: t.uri, sync: 'NONE', lines: [] }; np.querySelector('.tcnp-note').hidden = false; return; }
    np.querySelector('.tcnp-note').hidden = true;
    lyrics = { uri: t.uri, sync: res.sync, lines: res.lines };
    const frag = document.createDocumentFragment();
    for (const l of res.lines) {
      const line = el('<div class="tn-line"></div>');
      line.textContent = l.text || '• • •';
      if (lyrics.sync !== 'UNSYNCED' && l.text) line.onclick = () => TessSync.seek(l.start + 1);
      frag.appendChild(line);
    }
    linesBox.appendChild(frag);
  }
  function lineAt(ms) {
    let lo = 0, hi = lyrics.lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lyrics.lines[mid].start <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function updateLyrics(ms) {
    if (!npOpen || !lyrics.lines.length || lyrics.sync === 'UNSYNCED') return;
    const i = lineAt(ms);
    if (i === lastLine) return;
    lastLine = i;
    const nodes = np.querySelectorAll('.lines .tn-line');
    nodes.forEach((n, j) => {
      n.classList.toggle('on', j === i);
      n.classList.toggle('past', j < i);
    });
    nodes[Math.max(i, 0)]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ---------------- queue ----------------
  async function fillQueue() {
    const list = np.querySelector('.qlist');
    list.replaceChildren();
    let items = [];
    try {
      const r = await TessAPI.queue();
      items = r?.queue || [];
    } catch {}
    if (!items.length) { list.appendChild(el('<p class="tcnp-note">Nothing queued.</p>')); return; }
    const frag = document.createDocumentFragment();
    items.slice(0, 30).forEach((t) => {
      const row = el('<button class="tv-row"><span class="tv-art"><img alt="" draggable="false"></span><span class="tv-text"><b></b><small></small></span></button>');
      const img = row.querySelector('img');
      const url = TessViews.pick(t.album?.images, 100);
      if (url) img.src = url;
      row.querySelector('b').textContent = t.name;
      row.querySelector('small').textContent = (t.artists || []).map((a) => a.name).join(', ');
      row.onclick = () => TessSync.play({ uris: [t.uri] });
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }

  // ---------------- one paint per state change ----------------
  function syncUi() {
    const st = TessSync.state;
    const t = st.track;
    const art = TessViews.pick(t?.album?.images, 300);
    bar.classList.toggle('live', !!t);
    if (t) {
      bar.querySelector('.tcp-art img').src = art;
      bar.querySelector('b').textContent = t.name || '…';
      bar.querySelector('small').textContent = (t.artists || []).join(', ');
    } else {
      bar.querySelector('b').textContent = st.active ? '' : 'Nothing playing';
      bar.querySelector('small').textContent = st.active ? '' : 'Play something from the Dial';
    }
    bar.querySelector('.tcp-play').innerHTML = st.playing ? I.pause : I.play;
    if (npOpen) {
      if (t?.uri !== lastNpUri) {
        lastNpUri = t?.uri || '';
        const img = np.querySelector('.tcnp-disc img');
        if (art) img.src = art;
        np.querySelector('.tcnp-text b').textContent = t?.name || '';
        np.querySelector('.tcnp-text small').textContent = (t?.artists || []).join(', ');
        glow.setArtwork(art);
        loadLyrics(t);
        window.TessApp?.aurora?.setArtwork(art);
      }
      np.querySelector('.b-play').innerHTML = st.playing ? I.pause : I.play;
      np.querySelector('.tcnp-disc').classList.toggle('spin', st.playing);
      const heart = np.querySelector('.tcnp-heart');
      heart.innerHTML = st.saved ? I.saved : I.heart;
      heart.classList.toggle('on', st.saved);
      np.querySelector('.b-shuffle').classList.toggle('active', st.shuffle);
      np.querySelector('.b-repeat').classList.toggle('active', st.repeat !== 'off');
      np.querySelector('.b-repeat').classList.toggle('one', st.repeat === 'track');
    }
    TessRemote.update();
  }

  function mount(parent) {
    mountBar(parent);
    mountNp(document.body);
    TessSync.on(syncUi);
    syncUi();
  }

  return { mount, open, close, isOpen };
})();
