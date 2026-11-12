// Tess companion — the app.
// Boot (setup → login → shell), the hash router, Home (greeting, the Dial, on this day), the tab bar,
// the settings and device sheets, and the one app-level aurora everything tints.
window.TessApp = (function () {
  'use strict';

  const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
  const view = () => {
    let v = document.getElementById('view');
    if (!v) { v = el('<main id="view"></main>'); document.getElementById('app').appendChild(v); }
    return v;
  };
  let profile = null;
  let aurora = null;
  let sheet = null;

  const greeting = () => {
    const h = new Date().getHours();
    return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  };

  // ---------- toasts ----------
  let toastTimer = 0;
  function toast(msg) {
    let t = document.getElementById('tc-toast');
    if (!t) { t = el('<div id="tc-toast" role="status"></div>'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---------- sheets (settings, devices) ----------
  function openSheet(content) {
    closeSheet();
    sheet = el('<div class="tc-sheet"><div class="tc-sheet-card" role="dialog" aria-modal="true"></div></div>');
    sheet.querySelector('.tc-sheet-card').appendChild(content);
    sheet.addEventListener('pointerdown', (e) => { if (e.target === sheet) closeSheet(); });
    document.body.appendChild(sheet);
    requestAnimationFrame(() => sheet.classList.add('open'));
  }
  function closeSheet() {
    if (!sheet) return;
    const s = sheet;
    sheet = null;
    s.classList.remove('open');
    setTimeout(() => s.remove(), 220);
  }

  function toggleRow(key, title, hint, checked, onChange) {
    const row = el(`<label class="tc-row"><span><b></b><small></small></span><input type="checkbox"><i class="tc-switch"></i></label>`);
    row.querySelector('b').textContent = title;
    row.querySelector('small').textContent = hint;
    const input = row.querySelector('input');
    input.checked = checked;
    input.onchange = () => onChange(input.checked);
    return row;
  }

  function openSettings() {
    const box = el('<div><h3 class="tc-sheet-title">Settings</h3></div>');
    box.appendChild(toggleRow('circadian', 'Follow the time of day', 'Warm mornings, golden evenings, dim nights.', localStorage.getItem('tc:circadian') !== '0',
      (v) => { localStorage.setItem('tc:circadian', v ? '1' : '0'); }));
    const ls = toggleRow('lockscreen', 'Background & lock screen', 'Keeps the connection alive in the background, puts the artwork and controls on the lock screen. Needs one tap to start.', TessRemote.enabled(),
      (v) => TessRemote.setEnabled(v));
    box.appendChild(ls);
    const devicesRow = el('<button class="tc-row tc-rowbtn"><span><b>Playback device</b><small>Where the music comes out</small></span><span class="tc-val"></span></button>');
    devicesRow.querySelector('.tc-val').textContent = deviceLabel();
    devicesRow.onclick = () => openDevices();
    box.appendChild(devicesRow);
    const signout = el('<button class="tc-row tc-rowbtn"><span><b>Sign out</b><small id="tc-acct"></small></span></button>');
    signout.querySelector('small').textContent = profile ? `${profile.display_name} · ${profile.id}` : '';
    signout.onclick = () => { TessAuth.logout(); location.reload(); };
    box.appendChild(signout);
    openSheet(box);
  }

  function deviceLabel() {
    const id = localStorage.getItem('tc:device');
    if (!id) return 'Automatic';
    const d = TessSync.state.devices.find((x) => x.id === id);
    return d ? d.name : 'Remembered device';
  }

  function openDevices() {
    const box = el('<div><h3 class="tc-sheet-title">Play on</h3><div class="tc-devs"></div></div>');
    const list = box.querySelector('.tc-devs');
    const chosen = localStorage.getItem('tc:device');
    const row = (label, sub, active, onClick) => {
      const r = el('<button class="tc-row tc-rowbtn"><span><b></b><small></small></span><span class="tc-dot"></span></button>');
      r.querySelector('b').textContent = label;
      r.querySelector('small').textContent = sub;
      r.querySelector('.tc-dot').classList.toggle('on', active);
      r.onclick = onClick;
      return r;
    };
    list.appendChild(row('Automatic', 'Let Spotify pick the active device', !chosen, () => { TessSync.setTargetDevice(null); closeSheet(); }));
    for (const d of TessSync.state.devices) {
      list.appendChild(row(d.name, d.type + (d.is_restricted ? ' · unavailable' : ''), chosen === d.id, () => { TessSync.transfer(d.id); toast('Playing on ' + d.name); closeSheet(); }));
    }
    const foot = el('<p class="tc-foot">Devices appear when Spotify is running on them.</p>');
    list.appendChild(foot);
    TessSync.loadDevices().then(() => {
      if (!sheet || !sheet.isConnected) return;
      for (const d of TessSync.state.devices) {
        if ([...list.children].some((r) => r.querySelector('b')?.textContent === d.name)) continue;
        list.insertBefore(row(d.name, d.type + (d.is_restricted ? ' · unavailable' : ''), chosen === d.id, () => { TessSync.transfer(d.id); toast('Playing on ' + d.name); closeSheet(); }), foot);
      }
    });
    openSheet(box);
  }

  // ---------- first-run screens ----------
  function setupScreen() {
    const box = el(`
      <div class="tc-boot">
        <div class="tc-boot-mark"></div>
        <h1>Tess</h1>
        <p>Your library and the Dial, in Tess's style, driving Spotify wherever it plays.</p>
        <ol class="tc-steps">
          <li>Create an app at <b>developer.spotify.com/dashboard</b>.</li>
          <li>Add this exact redirect URI:<br><code class="tc-copy">${TessAuth.redirectUri()}</code></li>
          <li>Paste its <b>Client ID</b> here.</li>
        </ol>
        <input class="tc-field" placeholder="Client ID" autocapitalize="off" spellcheck="false">
        <button class="tc-cta">Continue</button>
      </div>`);
    const input = box.querySelector('.tc-field');
    const code = box.querySelector('.tc-copy');
    code.onclick = () => { navigator.clipboard?.writeText(TessAuth.redirectUri()); toast('Redirect URI copied'); };
    box.querySelector('.tc-cta').onclick = () => {
      if (!input.value.trim()) { toast('Paste the Client ID from the dashboard first'); return; }
      TessAuth.setClientId(input.value);
      boot();
    };
    view().replaceChildren(box);
  }

  function loginScreen() {
    const box = el(`
      <div class="tc-boot">
        <div class="tc-boot-mark"></div>
        <h1>Tess</h1>
        <p>One sign-in with Spotify and everything here becomes yours: the Dial, the timeline, the DNA of every playlist.</p>
        <button class="tc-cta">Sign in with Spotify</button>
      </div>`);
    box.querySelector('.tc-cta').onclick = () => TessAuth.login().catch((e) => toast(e.message));
    view().replaceChildren(box);
  }

  // ---------- home ----------
  function renderHome() {
    TessDial.unmount();
    const box = el(`
      <section class="tv-page tv-home">
        <header class="tc-masthead">
          <div><small></small><h1></h1></div>
          <button class="tc-gear" aria-label="Settings"></button>
        </header>
      </section>`);
    const date = box.querySelector('small');
    date.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const name = (profile?.display_name || '').split(' ')[0];
    box.querySelector('h1').textContent = name ? `${greeting()}, ${name}` : greeting();
    const gear = box.querySelector('.tc-gear');
    gear.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1L5.3 5.3"/></svg>';
    gear.onclick = () => openSettings();
    const v = view();
    v.replaceChildren(box);
    TessDial.mount(box);
    const otd = el('<div class="tv-otd-slot"></div>');
    box.appendChild(otd);
    TessViews.onThisDay(otd);
    aurora?.setArtwork(TessSync.state.track?.album?.images ? TessViews.pick(TessSync.state.track.album.images, 300) : '');
  }

  // ---------- routing ----------
  let routeSeq = 0;
  async function render() {
    const seq = ++routeSeq;
    const hash = location.hash || '#/';
    const path = hash.replace(/^#/, '');
    closeSheet();
    if (path === '/' || path === '' || path === '/home') { renderHome(); return; }
    TessDial.unmount();
    const box = el('<section class="tv-page"><div class="tv-loading"><i></i></div></section>');
    view().replaceChildren(box);
    const out = await TessViews.route(hash, box);
    if (seq !== routeSeq) return; // the user kept moving; drop the stale page
    if (out === 'home') renderHome();
  }

  // ---------- the shell ----------
  function buildShell() {
    document.getElementById('app').replaceChildren(el('<main id="view"></main>'));
    const tabs = el(`
      <nav id="tctabs" aria-label="Tabs">
        <button data-h="#/" class="on"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.2"/><path d="M4.6 9.2a8.5 8.5 0 0 1 14.8 0M2 5.6a12.5 12.5 0 0 1 20 0" opacity=".5"/></svg><span>Home</span></button>
        <button data-h="#/search"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/></svg><span>Search</span></button>
        <button data-h="#/library"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 4v16M10 4v16M14.5 5l4.5 15"/></svg><span>Library</span></button>
      </nav>`);
    tabs.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { location.hash = b.dataset.h; };
    });
    document.getElementById('app').appendChild(tabs);
    TessPlayer.mount(document.getElementById('app'));
    const markActive = () => {
      const path = (location.hash || '#/').replace(/^#/, '');
      const key = path.startsWith('/search') ? '#/search' : path.startsWith('/library') ? '#/library' : '#/';
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.h === key));
    };
    window.addEventListener('hashchange', () => { render(); markActive(); window.scrollTo(0, 0); });
    markActive();
  }

  // ---------- sync → aurora ----------
  let lastAuroraUri = '';
  function onSync() {
    const st = TessSync.state;
    const art = st.track?.album?.images ? TessViews.pick(st.track.album.images, 300) : '';
    if (st.track?.uri !== lastAuroraUri) {
      lastAuroraUri = st.track?.uri || '';
      // pages set their own artwork on open; the playing track takes the light back when it changes
      if (art) aurora?.setArtwork(art);
    }
  }

  // ---------- boot ----------
  async function boot() {
    try {
      await TessAuth.handleRedirect();
    } catch (e) { toast(e.message); }
    if (!TessAuth.clientId()) return setupScreen();
    if (!TessAuth.signedIn()) return loginScreen();

    buildShell();
    aurora = TessAurora.Aurora(document.querySelector('#aurora canvas'), {
      circadian: () => localStorage.getItem('tc:circadian') !== '0',
      playing: () => window.TessSync?.state.playing,
      visible: () => true,
    });
    try { profile = await TessAPI.me(); } catch {}
    TessSync.start();
    TessSync.on(onSync);
    TessRemote.arm();
    render();
  }

  document.addEventListener('DOMContentLoaded', boot);

  const app = {
    boot, render, toast, openDevices, openSettings, closeSheet,
    go: (path) => { location.hash = '#' + path; },
    profile: () => profile,
  };
  // dial.js and views.js tint the light through this property; it stays live after boot creates it
  Object.defineProperty(app, 'aurora', { get: () => aurora, configurable: true });
  return app;
})();
