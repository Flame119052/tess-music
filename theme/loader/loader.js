// Tess Music loader — the only Tess code written into Spotify by the installer.
// On every Spotify start it fetches the newest Tess for its channel, checks the release is signed by Tess's key,
// runs it and remembers it. If the network or the check fails it runs the last good copy, and if there is none,
// the copy that came with the installer (appended below as TESS_BASELINE).
(async function tessLoader() {
  window.__tessLoader = 2; // the theme uses this to tell a current install from an old 0.1.0 one
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
  const ls = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  // The highest release this Mac has actually started, per channel. It only goes up, so a correctly signed but older
  // release served by a mirror or a stale CDN is refused. Per channel: switching stable → dev is not a downgrade.
  const floorKey = `tess:rev:${channel}`;
  const floor = () => { const n = Number(ls(floorKey)); return Number.isFinite(n) && n > 0 ? n : 0; };

  async function verify(text, sig) {
    try {
      const key = await crypto.subtle.importKey('raw', b64(PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(sig), enc.encode(text));
    } catch { return false; }
  }
  // The envelope covers what the loader acts on, including the file contents. `channel` is deliberately not in it: a
  // promote changes only that field, and the signing key must not travel to the promote job.
  const hex = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const envelope = (m) => JSON.stringify({ version: m.version, js: m.js, css: m.css, jsSha: m.jsSha, cssSha: m.cssSha, rev: Number(m.rev) });
  async function verified(b) {
    if (!b || typeof b.js !== 'string' || typeof b.css !== 'string' || typeof b.sigJs !== 'string' || typeof b.sigCss !== 'string') return false;
    if (b.channel !== channel) return false;
    // Stored copies obey the same forward-only rule as downloads.
    const r = Number(b.rev) || 0;
    if (r < floor() || (floor() > 0 && !b.env)) return false;
    if (!(await verify(b.js, b.sigJs)) || !(await verify(b.css, b.sigCss))) return false;
    if (b.env) {
      if (!(await verify(b.env, b.sigEnv))) return false;
      let e;
      try { e = JSON.parse(b.env); } catch { return false; }
      if (e.version !== b.version || Number(e.rev) !== Number(b.rev)) return false;
      if ((await hex(b.js)) !== e.jsSha || (await hex(b.css)) !== e.cssSha) return false;
    } else if ((Number(b.rev) || 0) > 0) {
      // A rev-tagged cache must carry the envelope that binds its version, rev and contents.
      return false;
    }
    return true;
  }
  async function fetchRelease() {
    for (const get of SOURCES) {
      try {
        const m = JSON.parse(await get('manifest.json'));
        const signed = !!(m.sig && typeof m.sig.envelope === 'string');
        const rev = signed ? Number(m.rev) : 0;
        // Once this Mac has run a release with a rev, an older, pre-rev manifest is a downgrade too.
        if (!signed && floor() > 0) continue;
        if (signed) {
          if (!Number.isInteger(rev) || rev < 1) continue;
          if (!(await verify(envelope(m), m.sig.envelope))) continue;
          if (rev < floor()) continue;
        }
        const cached = ls('tess:bundle');
        if (cached && cached.version === m.version && cached.channel === channel && (Number(cached.rev) || 0) === rev && (await verified(cached))) return cached;
        const [js, css] = await Promise.all([get(m.js), get(m.css)]);
        if (!(await verify(js, m.sig.js)) || !(await verify(css, m.sig.css))) continue;
        // The signatures prove each file, the envelope proves which files this rev is allowed to use.
        if (signed && ((await hex(js)) !== m.jsSha || (await hex(css)) !== m.cssSha)) continue;
        const bundle = { version: m.version, channel, rev, js, css, sigJs: m.sig.js, sigCss: m.sig.css, env: signed ? envelope(m) : null, sigEnv: signed ? m.sig.envelope : null };
        put('tess:bundle', bundle);
        return bundle;
      } catch {}
    }
    return null;
  }

  // A release that fails to start (it never reports ready) is remembered as bad and skipped from then on; Tess runs
  // the last copy that did start instead. So one broken release can never leave anyone with a broken Spotify.
  const fresh = await Promise.race([fetchRelease(), new Promise((r) => setTimeout(() => r(null), 6000))]);
  const good = ls('tess:good');
  const goodHere = good && good.channel === channel;
  const bad = ls('tess:bad');
  let bundle = fresh;
  // The cache is only ever a copy the loader verified itself; a value someone else wrote is not run.
  if (!bundle) { const cached = ls('tess:bundle'); if (await verified(cached)) bundle = cached; }
  if (bundle && bad && bundle.version === bad) bundle = goodHere && good.version !== bad && (await verified(good)) ? good : null;

  const run = (b) => {
    window.__tessReady = false;
    window.__tessVersion = b?.version || 'baseline';
    document.getElementById('tess-css')?.remove();
    if (!b) { document.querySelectorAll('link.userCSS').forEach((l) => { l.disabled = false; }); if (typeof TESS_BASELINE === 'function') TESS_BASELINE(); return; }
    // the newer CSS replaces the installed stylesheet
    document.querySelectorAll('link.userCSS').forEach((l) => { if (/user\.css/.test(l.href)) l.disabled = true; });
    const style = document.createElement('style');
    style.id = 'tess-css';
    style.textContent = b.css;
    document.head.appendChild(style);
    const s = document.createElement('script');
    s.src = URL.createObjectURL(new Blob([b.js], { type: 'text/javascript' }));
    document.head.appendChild(s);
  };
  run(bundle);
  if (!bundle || !bundle.js.includes('__tessReady')) return; // the baseline, or a release from before this check

  // Spotify itself can take a while to be ready; only then does the release get 20 seconds to start.
  const spotifyUp = () => window.Spicetify?.Player?.data !== undefined && document.querySelector('[data-testid="now-playing-bar"]');
  for (let i = 0; i < 600 && !spotifyUp(); i++) await new Promise((r) => setTimeout(r, 500));
  for (let i = 0; i < 40 && !window.__tessReady; i++) await new Promise((r) => setTimeout(r, 500));
  if (window.__tessReady) {
    put('tess:good', bundle);
    if (bundle.rev) put(floorKey, Math.max(bundle.rev, floor()));
    if (bad === bundle.version) put('tess:bad', null);
    return;
  }
  put('tess:bad', bundle.version);
  window.__tess?.dispose?.();
  const fallback = goodHere && good.version !== bundle.version && (await verified(good)) ? good : null;
  run(fallback);
})();
