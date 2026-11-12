// Lists solid (fully opaque) surfaces inside the three panels: with Tess, panels should be glass, so anything
// opaque and large there is a regression (e.g. Spotify painting its own page colour).
(() => {
  const out = [];
  for (const root of document.querySelectorAll('#main-view, #Desktop_LeftSidebar_Id, .Root__right-sidebar-peek')) {
    const R = root.getBoundingClientRect();
    for (const e of root.querySelectorAll('*')) {
      const c = getComputedStyle(e).backgroundColor;
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const parts = m[1].split(',').map(Number);
      if (parts.length === 4 && parts[3] < 0.95) continue;
      if (parts.length === 3 && c === 'rgba(0, 0, 0, 0)') continue;
      const r = e.getBoundingClientRect();
      if (r.width * r.height < R.width * R.height * 0.15) continue;
      out.push(`${root.id || 'right-panel'}: ${e.tagName}.${String(e.className).slice(0, 30)} [${e.dataset.testid || ''}] ${c} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  return out;
})()
