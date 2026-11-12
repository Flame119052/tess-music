// Tess companion — the lock-screen remote.
// The honest trick, kept in one small box and off by default: iOS only shows lock-screen controls for a page
// that is itself producing sound, so a generated wav of pure silence loops at zero volume to keep the page
// eligible, and every press of the lock-screen buttons is forwarded to the chosen device over Spotify Connect.
// An iOS update can take this away at any time — it is a favour the browser does us, not a right.
window.TessRemote = (function () {
  'use strict';

  const KEY = 'tc:lockscreen';
  let audio = null;
  let bound = false;
  let grace = 0;

  // on unless turned off: background listening and the lock-screen remote are the point of the app
  const enabled = () => localStorage.getItem(KEY) !== '0';
  const setEnabled = (v) => {
    localStorage.setItem(KEY, v ? '1' : '0');
    if (v) start();
    else stop();
  };

  function silenceUrl() {
    const rate = 22050;
    const n = rate * 2; // two seconds of nothing, looped
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
    ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  // Must begin from a tap: iOS only grants audio playback inside a user gesture. The first tap anywhere
  // counts, so arming at boot is enough.
  function start() {
    if (!enabled() || !('mediaSession' in navigator)) return;
    clearTimeout(grace);
    if (!audio) {
      audio = new Audio(silenceUrl());
      audio.loop = true;
      audio.volume = 0;
    }
    audio.play().catch(() => {});
    bind();
  }
  // stop only after a pause has held for a moment, so a track gap doesn't flash the controls away
  function idleStop() {
    clearTimeout(grace);
    grace = setTimeout(stop, 5000);
  }
  function stop() {
    try { audio?.pause(); } catch {}
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  // the lock-screen timeline: one position claim, refreshed while playing
  function position() {
    if (!('mediaSession' in navigator) || !enabled()) return;
    const st = TessSync.state;
    const d = (st.duration || 0) / 1000;
    if (!d) return;
    try {
      navigator.mediaSession.setPositionState({ duration: d, position: Math.min(TessSync.progress() / 1000, d), playbackRate: 1 });
    } catch {}
  }

  function bind() {
    if (bound || !('mediaSession' in navigator)) return;
    bound = true;
    const ms = navigator.mediaSession;
    const guard = (name, fn) => { try { ms.setActionHandler(name, fn); } catch {} };
    guard('play', () => TessSync.togglePlay());
    guard('pause', () => TessSync.togglePlay());
    guard('previoustrack', () => TessSync.prev());
    guard('nexttrack', () => TessSync.next());
    guard('seekto', (d) => d.seekTime != null && TessSync.seek(d.seekTime * 1000));
    guard('seekbackward', () => TessSync.seek(Math.max(0, TessSync.progress() - 10000)));
    guard('seekforward', () => TessSync.seek(TessSync.progress() + 10000));
  }

  function update() {
    if (!enabled() || !('mediaSession' in navigator)) return;
    const st = TessSync.state;
    const t = st.track;
    navigator.mediaSession.playbackState = st.playing ? 'playing' : 'paused';
    if (!t) { navigator.mediaSession.metadata = null; return; }
    // the largest art there is: iOS stretches it full-bleed behind the lock-screen controls
    const art = (t.album?.images || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
    const artwork = art.length ? [{ src: art[0].url, sizes: '512x512', type: 'image/jpeg' }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.name || '…',
      artist: (t.artists || []).join(', '),
      album: t.album?.name || 'Tess',
      artwork,
    });
  }

  // arming: the first tap anywhere satisfies the gesture rule, then playback state runs the keepalive
  function arm() {
    if (arm.done) return;
    arm.done = true;
    document.addEventListener('pointerdown', () => { if (enabled()) start(); });
    if (window.TessSync) {
      TessSync.on(() => {
        const st = TessSync.state;
        if (!enabled()) return;
        if (st.playing) start();
        else if (st.active) idleStop();
        else idleStop();
        position();
        update();
      });
      setInterval(position, 5000);
    }
  }

  return { enabled, setEnabled, start, stop, update, arm };
})();
