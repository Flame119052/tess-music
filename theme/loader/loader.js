// Tess Music loader — the only Tess code written into Spotify by the installer.
// On every Spotify start it fetches the newest Tess for its channel, checks the release is signed by Tess's key,
// runs it and remembers it. If the network or the check fails it runs the last good copy, and if there is none,
// the copy that came with the installer (appended below as TESS_BASELINE).
(async function tessLoader() {
  const PUBLIC_KEY = '__TESS_PUBLIC_KEY__'; // raw Ed25519 public key, base64
  const REPO = 'Flame119052/tess-music';
  const channel = (() => { try { return JSON.parse(localStorage.getItem('tess:settings') || '{}').channel || 'stable'; } catch { return 'stable'; } })();
  // The GitHub contents API is read live (raw.githubusercontent and CDNs cache a branch for minutes to hours, which
  // is what made updates arrive late). jsDelivr is only a fallback, pinned to the commit the API reports when it can.
  const API = `https://api.github.com/repos/${REPO}/contents/dist/`;
  const raw = (path) => fetch(`${API}${path}?ref=${channel}`, { cache: 'no-store', headers: { Accept: 'application/vnd.github.raw' } })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); });
  const cdn = (path) => fetch(`https://cdn.jsdelivr.net/gh/${REPO}@${channel}/dist/${path}`, { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); });
  const SOURCES = [raw, cdn];
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const enc = new TextEncoder();

  async function verify(text, sig) {
    try {
      const key = await crypto.subtle.importKey('raw', b64(PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(sig), enc.encode(text));
    } catch { return false; }
  }
  async function fetchRelease() {
    for (const get of SOURCES) {
      try {
        const m = JSON.parse(await get('manifest.json'));
        const cached = JSON.parse(localStorage.getItem('tess:bundle') || 'null');
        if (cached?.version === m.version && cached?.channel === channel) return cached;
        const [js, css] = await Promise.all([get(m.js), get(m.css)]);
        if (!(await verify(js, m.sig.js)) || !(await verify(css, m.sig.css))) continue;
        const bundle = { version: m.version, channel, js, css };
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
