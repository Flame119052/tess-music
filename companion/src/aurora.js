// Tess companion — the light behind the glass.
// Ported from the theme's core.js: artwork becomes a few soft colour fields that drift on a small canvas the
// GPU stretches. The hour bends the colours (warm mornings, neutral midday, golden evenings, dim nights),
// vivid artwork moves faster, and a paused player barely drifts. The Glow is the full-screen player's slower,
// rotating artwork light from the same file.
window.TessAurora = (function () {
  'use strict';

  // Colour psychology. The artwork sets the hue; the hour bends it (soft warm light in the morning, clean
  // neutral light midday, golden in the evening, dim and low in blue at night so it doesn't fight sleep).
  const DAYPARTS = [
    // [from hour, tone rgb, how much tone to mix in, brightness, blue kept]
    [5, [255, 176, 110], 0.22, 1.05, 0.95],  // morning: warm, gentle sunrise light
    [11, [200, 215, 235], 0.1, 1.08, 1],     // midday: clean, neutral, bright
    [16, [255, 150, 90], 0.26, 1.0, 0.9],    // golden hour / evening: warm amber
    [20, [120, 70, 60], 0.3, 0.72, 0.6],     // night: dim, warm, little blue
  ];
  const daypart = () => {
    const h = new Date().getHours();
    return [...DAYPARTS].reverse().find((d) => h >= d[0]) || DAYPARTS[3];
  };

  function paletteOf(img) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 4;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, 4, 4);
      const d = x.getImageData(0, 0, 4, 4).data;
      return [0, 12, 40, 52].map((k) => [d[k], d[k + 1], d[k + 2]]);
    } catch { return null; }
  }

  // settings: { circadian(): bool, playing(): bool, visible(): bool }
  function Aurora(canvas, settings = {}) {
    const w = canvas.width = 96;
    const h = canvas.height = 54;
    let colors = [[40, 50, 90], [70, 40, 90], [30, 60, 80], [20, 20, 30]];
    let shown = colors.map((c) => [...c]);
    let phase = 0;
    let last = 0;
    let url = '';
    const palettes = new Map();

    function setArtwork(src) {
      if (!src) return;
      url = src;
      if (palettes.has(src)) { colors = palettes.get(src); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const p = paletteOf(img);
          if (!p) return;
          palettes.set(src, p);
          if (url === src) colors = p;
        } catch {}
      };
      img.src = src;
    }

    function paint(t) {
      const [, tone, mix, bright, blue] = settings.circadian?.() ? daypart() : [0, [0, 0, 0], 0, 1, 1];
      // ease toward the new artwork instead of jumping, through the time-of-day tone
      shown = shown.map((c, i) => c.map((v, j) => {
        const target = (colors[i][j] * (1 - mix) + tone[j] * mix) * bright * (j === 2 ? blue : 1);
        return v + (Math.min(255, target) - v) * 0.08;
      }));
      // vivid artwork moves more; paused barely drifts
      const sat = colors.reduce((s, c) => s + (Math.max(...c) - Math.min(...c)), 0) / (colors.length * 255);
      const speed = (settings.playing?.() ? 1 : 0.15) * (0.6 + sat * 1.2);
      phase += (last ? t - last : 0) * speed;
      last = t;
      t = phase;
      const x = canvas.getContext('2d');
      x.filter = 'none';
      x.fillStyle = '#07070a';
      x.fillRect(0, 0, w, h);
      x.filter = 'blur(9px) saturate(140%)';
      shown.forEach((c, i) => {
        const a = t * 0.00009 * (i % 2 ? 1 : -1) + i * 1.7;
        x.fillStyle = `rgba(${c.map(Math.round).join(',')},0.8)`;
        x.beginPath();
        x.ellipse(w * (0.5 + 0.4 * Math.cos(a)), h * (0.5 + 0.42 * Math.sin(a * 1.3)), w * 0.42, h * 0.55, a, 0, Math.PI * 2);
        x.fill();
      });
    }

    const timer = setInterval(() => { if (!document.hidden && settings.visible?.() !== false) paint(performance.now()); }, 110);
    return { setArtwork, paint, stop: () => clearInterval(timer) };
  }

  // The full-screen player: rotating blurred artwork behind the record. Blurred-artwork backgrounds are
  // painted small and stretched by the GPU — like a huge CSS blur at a fraction of the cost.
  const GLOW_LAYERS = [[0.5, 0.5, 1.5, 0.85, 1 / 70], [0.7, 0.5, 1.1, 0.55, -1 / 95], [0.25, 0.75, 0.9, 0.45, 1 / 120]];
  function Glow(canvas) {
    let img = null;
    function setArtwork(src) {
      if (!src) { img = null; return; }
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => { img = i; paint(performance.now() / 1000); };
      i.src = src;
    }
    function paint(seconds) {
      const ctx = canvas.getContext('2d');
      const { width: w, height: h } = canvas;
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b0b0d';
      ctx.fillRect(0, 0, w, h);
      if (!img) return;
      ctx.filter = 'blur(5px) saturate(160%)';
      for (const [cx, cy, size, alpha, speed] of GLOW_LAYERS) {
        const d = size * Math.max(w, h);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(cx * w, cy * h);
        ctx.rotate(seconds * speed * 2 * Math.PI);
        ctx.drawImage(img, -d / 2, -d / 2, d, d);
        ctx.restore();
      }
    }
    return { setArtwork, paint };
  }

  return { Aurora, Glow, paletteOf, daypart, DAYPARTS };
})();
