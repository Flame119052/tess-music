// Tess companion — the player's state, kept real-time.
// Three layers, in order of trust:
//   1. Your own actions flip the interface at once (optimistic) — a command never delays what you see.
//   2. The progress bar animates frame-by-frame between sync anchors, like the desktop theme's loop.
//   3. State arrives as a push over the same dealer event socket Spotify's own web player listens on;
//      a 1.5 second poll runs behind it as the fallback and as the drift-corrector.
window.TessSync = (function () {
  'use strict';

  const listeners = new Set();
  const state = {
    ready: false,
    active: false,      // something is playing somewhere in your device cluster
    track: null,        // {id, uri, name, artists[], album{name,uri,images}, duration_ms}
    contextUri: null,
    playing: false,
    anchorMs: 0,        // the position at anchorAt
    anchorAt: 0,        // when that position was true
    duration: 0,
    deviceId: null,
    deviceName: '',
    devices: [],
    volume: null,
    shuffle: false,
    repeat: 'off',
    saved: false,
    localDeviceId: null, // this browser, once the Web Playback SDK has connected it as a device
    localReady: false,
  };
  let targetDevice = localStorage.getItem('tc:device') || null;

  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const emit = () => { for (const fn of listeners) { try { fn(); } catch {} } };
  const anchor = (ms, playing) => { state.anchorMs = Math.max(0, ms); state.anchorAt = Date.now(); state.playing = !!playing; };
  // the truth between syncs: one anchor, advanced frame-by-frame
  const progress = () => (state.playing ? state.anchorMs + (Date.now() - state.anchorAt) : state.anchorMs);

  function shapeTrack(t) {
    return {
      id: t.id, uri: t.uri, name: t.name || '',
      artists: (t.artists || []).map((a) => a.name),
      album: t.album ? { name: t.album.name, uri: t.album.uri, images: t.album.images || [] } : null,
      duration_ms: t.duration_ms || 0,
    };
  }

  function applyPlayer(p) {
    if (!p || !p.device) { state.active = false; emit(); return; }
    state.active = true;
    const item = p.item;
    if (item?.uri && item.uri !== state.track?.uri) {
      state.track = shapeTrack(item);
      state.saved = false;
      checkSaved();
    }
    if (item) state.duration = item.duration_ms || 0;
    state.contextUri = p.context?.uri || null;
    state.deviceId = p.device.id;
    state.deviceName = p.device.name || '';
    if (!targetDevice) targetDevice = null;
    state.volume = p.device.volume_percent ?? state.volume;
    state.shuffle = !!p.shuffle_state;
    state.repeat = p.repeat_state || 'off';
    anchor(p.progress_ms || 0, !!p.is_playing);
    state.ready = true;
    emit();
  }

  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq;
    try {
      const p = await TessAPI.player();
      if (seq === refreshSeq) applyPlayer(p); // a newer answer has superseded this one
    } catch {}
  }

  async function checkSaved() {
    const id = state.track?.id;
    if (!id) return;
    try {
      const [s] = (await TessAPI.tracksSaved([id])) || [false];
      if (state.track?.id === id && state.saved !== !!s) { state.saved = !!s; emit(); }
    } catch {}
  }

  async function loadDevices() {
    try {
      const r = await TessAPI.devices();
      state.devices = r?.devices || [];
      emit();
    } catch {}
  }

  // ---------- the dealer socket: push, like the real apps ----------
  let ws = null;
  let wsWant = false;
  let wsTimer = 0;
  async function openDealer() {
    wsWant = true;
    clearTimeout(wsTimer);
    try {
      const token = await TessAuth.token();
      if (ws) { try { ws.close(); } catch {} }
      ws = new WebSocket('wss://dealer.spotify.com/?access_token=' + encodeURIComponent(token));
      ws.onmessage = (e) => { try { onDealer(JSON.parse(e.data)); } catch {} };
      ws.onclose = () => { if (wsWant) wsTimer = setTimeout(openDealer, 4000); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    } catch {
      if (wsWant) wsTimer = setTimeout(openDealer, 8000);
    }
  }
  function closeDealer() { wsWant = false; clearTimeout(wsTimer); try { ws?.close(); } catch {} ws = null; }

  function onDealer(m) {
    if (m.type !== 'state' || !String(m.uri || '').includes('connect-state')) return;
    const cluster = m.payloads?.[0]?.cluster_state;
    const ps = cluster?.player_state;
    if (!ps?.track?.uri) return;
    const uri = ps.track.uri;
    const changed = uri !== state.track?.uri;
    if (changed) {
      // the push names the track before we know anything about it; the fuller record lands a beat later
      state.track = {
        id: uri.split(':')[2], uri, name: '', artists: [], album: null,
        duration_ms: Number(ps.duration?.millis ?? ps.duration ?? 0) || state.duration, loading: true,
      };
      state.saved = false;
      TessAPI.track(state.track.id)
        .then((t) => { if (t && state.track?.id === t.id) { state.track = shapeTrack(t); checkSaved(); emit(); } })
        .catch(() => {});
    }
    if (state.track?.duration_ms) state.duration = state.track.duration_ms;
    if (cluster.active_device_id) { state.deviceId = cluster.active_device_id; }
    // "position_as_of_timestamp" is the epoch moment the position was true; arrival ≈ that moment
    anchor(Date.now() - Number(ps.position_as_of_timestamp || 0), !ps.is_paused);
    state.active = true;
    state.ready = true;
    emit();
  }

  // ---------- in-app playback: Spotify's Web Playback SDK ----------
  // The existing system with the DRM inside (FairPlay through EME on iOS Safari, Widevine on Android
  // Chrome). Once connected, this browser is a Connect device named Tess: it can play full tracks itself,
  // and every flow here — transfer, play with a device target — reaches it like any other device. iOS
  // quirks live in two places: audio starts only when activateElement() runs inside your tap, and volume
  // is not settable (always reports 1).
  let sdkPlayer = null;
  let sdkLoaded = false;
  function loadSdk() {
    if (sdkLoaded) return;
    sdkLoaded = true;
    window.onSpotifyWebPlaybackSDKReady = initSdk;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.async = true;
    document.head.appendChild(s);
  }
  async function initSdk() {
    try {
      sdkPlayer = new window.Spotify.Player({
        name: 'Tess',
        volume: 0.8,
        getOAuthToken: (cb) => TessAuth.token().then(cb).catch(() => {}),
      });
      sdkPlayer.addListener('initialization_error', () => { state.localReady = false; emit(); });
      sdkPlayer.addListener('account_error', () => { state.localReady = false; emit(); });
      sdkPlayer.addListener('ready', ({ device_id }) => {
        state.localDeviceId = device_id;
        state.localReady = true;
        emit();
        loadDevices();
      });
      sdkPlayer.addListener('not_ready', () => { state.localReady = false; emit(); });
      // the local player's own truth: instant when Tess is the device that's playing
      sdkPlayer.addListener('player_state_changed', (ps) => {
        if (!ps?.track_window?.current_track) return;
        const cur = ps.track_window.current_track;
        const uri = cur.uri;
        if (uri && uri !== state.track?.uri) {
          state.track = {
            id: uri.split(':')[2], uri, name: cur.name || '',
            artists: (cur.artists || []).map((a) => a.name),
            album: cur.album ? { name: cur.album.name, uri: cur.album.uri, images: (cur.album.images || []).map((i) => ({ url: i.url, width: i.width })) } : null,
            duration_ms: ps.duration || 0, loading: true,
          };
          state.saved = false;
          TessAPI.track(state.track.id)
            .then((t) => { if (t && state.track?.id === t.id) { state.track = shapeTrack(t); checkSaved(); emit(); } })
            .catch(() => {});
        }
        if (ps.duration) state.duration = ps.duration;
        anchor(ps.position, !ps.paused);
        state.active = true;
        state.ready = true;
        emit();
      });
      await sdkPlayer.connect();
    } catch {
      state.localReady = false;
      emit();
    }
  }

  // ---------- actions: optimistic first, command second, confirmation third ----------
  const deviceArg = () => targetDevice || undefined;

  async function togglePlay() {
    if (!state.ready) return;
    anchor(progress(), !state.playing);
    emit();
    try {
      if (state.playing) await TessAPI.play(deviceArg());
      else await TessAPI.pause(deviceArg());
    } catch {}
    setTimeout(refresh, 700);
  }

  async function play(what = {}) {
    const body = what.context_uri
      ? { context_uri: what.context_uri, position_ms: what.position_ms || 0, ...(what.offsetUri ? { offset: { uri: what.offsetUri } } : {}) }
      : { uris: what.uris, ...(what.position != null ? { offset: { position: what.position } } : {}) };
    state.contextUri = what.context_uri || state.contextUri;
    if (what.track) { state.track = what.track; state.duration = what.track.duration_ms || 0; state.saved = false; checkSaved(); }
    anchor(what.position_ms || 0, true);
    state.active = true;
    state.ready = true;
    emit();
    const start = (deviceId) => TessAPI.play(deviceId, body);
    try {
      await start(deviceArg());
      if (targetDevice === state.localDeviceId) { try { sdkPlayer?.activateElement?.(); } catch {} }
    } catch {
      // no active device: hand playback to the first one that will take it
      try {
        await loadDevices();
        const d = state.devices.find((x) => !x.is_restricted);
        if (d) { targetDevice = d.id; localStorage.setItem('tc:device', d.id); await start(d.id); }
      } catch {}
    }
    setTimeout(refresh, 800);
  }

  async function next() {
    anchor(0, state.playing);
    emit();
    try { await TessAPI.next(); } catch {}
    setTimeout(refresh, 450);
  }
  async function prev() {
    try { await TessAPI.prev(); } catch {}
    anchor(0, state.playing);
    emit();
    setTimeout(refresh, 450);
  }
  async function seek(ms) {
    anchor(ms, state.playing);
    emit();
    try { await TessAPI.seek(ms, deviceArg()); } catch {}
    setTimeout(refresh, 600);
  }
  async function setVolume(v) {
    state.volume = v;
    emit();
    try { await TessAPI.volume(v, deviceArg()); } catch {}
  }
  async function toggleSave() {
    if (!state.track?.id) return;
    const to = !state.saved;
    state.saved = to;
    emit();
    try { to ? await TessAPI.saveTracks([state.track.id]) : await TessAPI.unsaveTracks([state.track.id]); } catch {}
    setTimeout(checkSaved, 900);
  }
  function setTargetDevice(id) {
    targetDevice = id;
    if (id) localStorage.setItem('tc:device', id); else localStorage.removeItem('tc:device');
    emit();
  }
  async function toggleShuffle() {
    state.shuffle = !state.shuffle;
    emit();
    try { await TessAPI.shuffle(state.shuffle); } catch {}
    setTimeout(refresh, 500);
  }
  async function toggleRepeat() {
    const order = ['off', 'context', 'track'];
    const mode = order[(order.indexOf(state.repeat) + 1) % order.length];
    state.repeat = mode;
    emit();
    try { await TessAPI.repeat(mode); } catch {}
    setTimeout(refresh, 500);
  }
  async function transfer(id) {
    setTargetDevice(id);
    emit();
    try { await TessAPI.transfer([id], state.playing); } catch {}
    // iOS: after a transfer to this browser the audio only starts inside the same tap
    if (id === state.localDeviceId) { try { sdkPlayer?.activateElement?.(); } catch {} }
    setTimeout(refresh, 700);
  }

  function start() {
    refresh();
    loadDevices();
    openDealer();
    loadSdk(); // this browser joins the device list as "Tess"; play here whenever you want
    setInterval(() => { if (!document.hidden) refresh(); }, 1500);        // the fallback and drift-corrector
    setInterval(() => { if (!document.hidden) loadDevices(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); loadDevices(); } });
  }
  function stop() { closeDealer(); }

  return {
    state, progress, on, start, stop, refresh, loadDevices,
    togglePlay, play, next, prev, seek, setVolume, toggleSave, toggleShuffle, toggleRepeat, transfer, setTargetDevice,
  };
})();
