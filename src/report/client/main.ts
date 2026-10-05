// Entry point of the report: draw every plate, and redraw on language,
// size or theme changes.

import { $ } from './dom.ts';
import { state, setLanguage } from './context.ts';
import { renderColumn } from './column.ts';
import { renderStrataControls, renderStrata } from './stratigraphy.ts';
import { renderMap, renderBorehole } from './map.ts';
import { renderHalfLife, renderHotspots, renderFaults, renderSeismo } from './charts.ts';
import { renderHeader, renderKnowledge, renderFossils, renderEvents, renderFoot } from './tables.ts';
import type { Lang } from '../../types.ts';

function renderAll(): void {
  setLanguage(state.lang);
  renderHeader(); // first: the column matches the height of the field notes
  renderColumn();
  renderStrataControls();
  renderStrata();
  renderMap();
  renderBorehole();
  renderHalfLife();
  renderHotspots();
  renderFaults();
  renderKnowledge();
  renderFossils();
  renderEvents();
  renderSeismo();
  renderFoot();
}

document.querySelectorAll<HTMLButtonElement>('#lang-seg button').forEach((b) => b.addEventListener('click', () => {
  state.lang = b.dataset.lang as Lang;
  try { localStorage.setItem('strata-lang', state.lang); } catch { /* storage unavailable */ }
  renderAll();
}));

renderAll();

// Charts are drawn at the container's pixel width: redraw when it changes.
let lastWidth = $('app').clientWidth;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
const onResize = (): void => {
  const width = $('app').clientWidth;
  if (Math.abs(width - lastWidth) < 4) return;
  lastWidth = width;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderAll, 120);
};
if (window.ResizeObserver) new ResizeObserver(onResize).observe($('app'));
else window.addEventListener('resize', onResize);

// Colours are read from CSS variables, so a theme flip needs a redraw.
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', renderAll);
new MutationObserver(renderAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
