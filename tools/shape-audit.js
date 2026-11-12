// Finds "double shapes": a painted box with a painted child of nearly the same size but a different corner radius.
(() => {
  const painted = (c) => (c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.backgroundColor !== 'transparent') || c.boxShadow !== 'none' || c.backgroundImage !== 'none';
  const hits = new Map();
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect();
    if (r.width < 12 || r.height < 12 || r.bottom < 0 || r.top > innerHeight) continue;
    const c = getComputedStyle(e);
    if (!painted(c) || c.visibility === 'hidden' || +c.opacity === 0) continue;
    for (const k of e.querySelectorAll(':scope > *, :scope > * > *')) {
      const kr = k.getBoundingClientRect();
      if (Math.abs(kr.width - r.width) > 10 || Math.abs(kr.height - r.height) > 10) continue;
      const kc = getComputedStyle(k);
      if (!painted(kc)) continue;
      const a = parseFloat(c.borderTopLeftRadius), b = parseFloat(kc.borderTopLeftRadius);
      if (Math.abs(Math.min(a, 999) - Math.min(b, 999)) < 2) continue;
      const where = (k.closest('[data-testid]')?.dataset.testid || k.closest('[id]')?.id || '') + ' ' + (k.dataset.encoreId || k.getAttribute('role') || k.tagName);
      if (!hits.has(where)) hits.set(where, `${e.tagName}(r=${c.borderTopLeftRadius}) > ${k.tagName}(r=${kc.borderTopLeftRadius}) ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  return [...hits].map(([w, d]) => w + ' :: ' + d);
})()
