// Tess Music loader — the only Tess code written into Spotify by the installer.
// On every Spotify start it fetches the newest Tess for its channel, checks the release is signed by Tess's key,
// runs it and remembers it. If the network or the check fails it runs the last good copy, and if there is none,
// the copy that came with the installer (appended below as TESS_BASELINE).
(async function tessLoader() {
  const PUBLIC_KEY = '__TESS_PUBLIC_KEY__'; // raw Ed25519 public key, base64
  const REPO = 'Flame119052/tess-music';
  const channel = (() => { try { return JSON.parse(localStorage.getItem('tess:settings') || '{}').channel || 'stable'; } catch { return 'stable'; } })();
  const SOURCES = [
    `https://raw.githubusercontent.com/${REPO}/${channel}/dist/`,
    `https://cdn.jsdelivr.net/gh/${REPO}@${channel}/dist/`,
  ];
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const enc = new TextEncoder();

  async function verify(text, sig) {
    try {
      const key = await crypto.subtle.importKey('raw', b64(PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(sig), enc.encode(text));
    } catch { return false; }
  }
  async function fetchRelease() {
    for (const base of SOURCES) {
      try {
        const bust = `?t=${Math.floor(Date.now() / 300000)}`; // at most 5 minutes stale
        const m = await (await fetch(base + 'manifest.json' + bust, { cache: 'no-store' })).json();
        const cached = JSON.parse(localStorage.getItem('tess:bundle') || 'null');
        if (cached?.version === m.version) return cached;
        const [js, css] = await Promise.all([
          fetch(base + m.js + bust).then((r) => r.text()),
          fetch(base + m.css + bust).then((r) => r.text()),
        ]);
        if (!(await verify(js, m.sig.js)) || !(await verify(css, m.sig.css))) continue;
        const bundle = { version: m.version, js, css };
        try { localStorage.setItem('tess:bundle', JSON.stringify(bundle)); } catch {}
        return bundle;
      } catch {}
    }
    return null;
  }

  const fresh = await Promise.race([fetchRelease(), new Promise((r) => setTimeout(() => r(null), 6000))]);
  let bundle = fresh;
  if (!bundle) { try { bundle = JSON.parse(localStorage.getItem('tess:bundle') || 'null'); } catch {} }
  window.__tessVersion = bundle?.version || 'baseline';
  if (bundle) {
    // the newer CSS replaces the installed stylesheet
    document.querySelectorAll('link.userCSS').forEach((l) => { if (/user\.css/.test(l.href)) l.disabled = true; });
    const style = document.createElement('style');
    style.id = 'tess-css';
    style.textContent = bundle.css;
    document.head.appendChild(style);
    const url = URL.createObjectURL(new Blob([bundle.js], { type: 'text/javascript' }));
    const s = document.createElement('script');
    s.src = url;
    document.head.appendChild(s);
  } else if (typeof TESS_BASELINE === 'function') {
    TESS_BASELINE();
  }
})();
