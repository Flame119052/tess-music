// Visible text or icons whose colour is (nearly) transparent: a sign a colour variable went clear.
(() => {
  const out = new Map();
  for (const e of document.querySelectorAll('#main-view *, #Desktop_LeftSidebar_Id *, .Root__right-sidebar-peek *, #global-nav-bar *')) {
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
    const c = getComputedStyle(e);
    if (c.visibility !== 'visible' || +c.opacity === 0) continue;
    const isIcon = e.tagName === 'path' || e.tagName === 'svg';
    const hasText = !isIcon && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!isIcon && !hasText) continue;
    const col = isIcon ? c.fill : c.color;
    const a = col.startsWith('rgba') ? Number(col.split(',')[3]) : 1;
    if (col !== 'none' && a < 0.15) {
      const where = (e.closest('[data-testid]')?.dataset.testid || e.closest('[id]')?.id || '') + ' ' + (isIcon ? 'icon' : 'text');
      if (!out.has(where)) out.set(where, `${col} «${(e.textContent || e.closest('button')?.getAttribute('aria-label') || '').trim().slice(0, 30)}»`);
    }
  }
  return [...out].map(([k, v]) => k + ': ' + v);
})()
