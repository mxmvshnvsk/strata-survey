// Plate I: every living line over time, as a stacked area chart.
// Layers are strata (optionally of one module) or authors.

import { $, h, s, esc, lin, niceTicks, timeTicks, maxOf, cssVar, showTip, hideTip } from './dom.ts';
import { D, state, ui, OWNER_COLORS, strataColor, periodName, person, linked, highlightStratum } from './context.ts';

interface Layer {
  /** Stratum index, person id, or 'others'. */
  key: number | string;
  label: string;
  color: string;
  values: number[];
}

interface Series {
  times: number[];
  layers: Layer[];
  /** Layers are strata (so the column can be highlighted in sync). */
  periodLayers: boolean;
}

function strataSeries(): Series {
  const { T } = ui;
  const S = D.strata.samples;

  if (state.strataBy === 'author') {
    // The people who were ever among the biggest owners get their own layer.
    const peak = new Map<number, number>();
    for (const smp of S) for (const [id, n] of smp.a || []) peak.set(id, Math.max(peak.get(id) || 0, n));
    const top = [...peak.entries()].sort((x, y) => y[1] - x[1]).slice(0, OWNER_COLORS.length).map(([id]) => id);
    // Order layers by when each author first appears, so the oldest sit at the bottom.
    const firstSeen = (id: number): number => S.findIndex((smp) => (smp.a || []).some(([a, n]) => a === id && n > 0));
    top.sort((x, y) => firstSeen(x) - firstSeen(y));
    const totals = S.map((x) => x.c.reduce((p, q) => p + q, 0));
    const layers: Layer[] = top.map((id, k) => ({
      key: id, label: person(id), color: OWNER_COLORS[k],
      values: S.map((smp) => (smp.a || []).find(([a]) => a === id)?.[1] ?? 0),
    }));
    const others = S.map((_, k) => Math.max(0, totals[k] - layers.reduce((p, l) => p + l.values[k], 0)));
    layers.unshift({ key: 'others', label: T.other, color: cssVar('--rule-strong'), values: others });
    return { times: S.map((x) => x.t), layers, periodLayers: false };
  }

  const M = D.strata.modules;
  const mi = state.strataModule && M ? M.names.indexOf(state.strataModule) : -1;
  if (M && mi >= 0) {
    return {
      times: M.sampleIdx.map((i) => S[i].t),
      periodLayers: true,
      layers: D.strata.labels.map((label, b) => ({ key: b, label, color: strataColor(b), values: M.data[mi].map((r) => r[b] || 0) })),
    };
  }
  return {
    times: S.map((x) => x.t),
    periodLayers: true,
    layers: D.strata.labels.map((label, b) => ({ key: b, label, color: strataColor(b), values: S.map((x) => x.c[b] || 0) })),
  };
}

export function renderStrataControls(): void {
  const { T } = ui;
  const bar = $('strata-tools');
  bar.innerHTML = '';
  const seg = h('div', { class: 'seg', role: 'group' });
  for (const k of ['period', 'author'] as const) {
    seg.append(h('button', {
      type: 'button', 'aria-pressed': String(state.strataBy === k),
      onclick: () => { state.strataBy = k; renderStrataControls(); renderStrata(); },
    }, T.layersBy[k]));
  }
  bar.append(h('span', { class: 'label' }, T.layers), seg);
  const M = D.strata.modules;
  if (M && M.names.length > 1 && state.strataBy === 'period') {
    const sel = h('select', { id: 'strata-module', onchange: (e: Event) => { state.strataModule = (e.target as HTMLSelectElement).value; renderStrata(); } },
      h('option', { value: '' }, T.zoomOut),
      M.names.map((n) => h('option', { value: n }, n)));
    sel.value = state.strataModule || '';
    bar.append(h('label', { class: 'label', for: 'strata-module' }, T.moduleLabel), sel);
  }
}

export function renderStrata(): void {
  const { F, T } = ui;
  const host = $('strata-fig');
  host.innerHTML = '';
  const { times, layers, periodLayers } = strataSeries();
  if (times.length < 2) { host.append(h('p', { class: 'empty' }, T.noData)); return; }

  const W = Math.max(320, host.clientWidth);
  const H = W < 600 ? 300 : 400;
  const t0 = times[0], t1 = times[times.length - 1];
  const totals = times.map((_, k) => layers.reduce((p, l) => p + l.values[k], 0));
  const maxY = maxOf(1, totals);
  const yTicks = niceTicks(0, maxY * 1.04, 5);
  const m = { l: 16 + 6.8 * maxOf(0, yTicks.map((v) => F.num(v).length)), r: 14, t: 10, b: 26 };
  const x = lin(t0, t1, m.l, W - m.r), y = lin(0, maxY * 1.04, H - m.b, m.t);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': T.strataTitle });
  const grid = s('g', { class: 'grid' });
  const axis = s('g', { class: 'axis' });
  for (const v of yTicks) {
    grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    axis.append(s('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, F.num(v)));
  }
  for (const [t, lab] of timeTicks(t0, t1, W < 600 ? 5 : 12, state.lang)) {
    axis.append(s('line', { x1: x(t), x2: x(t), y1: H - m.b, y2: H - m.b + 4 }));
    axis.append(s('text', { x: x(t), y: H - m.b + 17, 'text-anchor': 'middle' }, lab));
  }
  svg.append(grid);

  // Stack the layers bottom-up: each path runs along its top edge and back along its bottom.
  const g = s('g');
  const cum = times.map(() => 0);
  const paths: (SVGPathElement | null)[] = [];
  for (const L of layers) {
    let top = '', bottom = '', any = false;
    for (let k = 0; k < times.length; k++) {
      const v = L.values[k] || 0;
      if (v > 0) any = true;
      top += (k ? 'L' : 'M') + x(times[k]).toFixed(1) + ' ' + y(cum[k] + v).toFixed(1);
      bottom = 'L' + x(times[k]).toFixed(1) + ' ' + y(cum[k]).toFixed(1) + bottom;
      cum[k] += v;
    }
    if (!any) { paths.push(null); continue; }
    const p = s('path', { d: top + bottom + 'Z', fill: L.color, class: 'layer-anim', style: 'stroke: var(--paper); stroke-width: 0.4' });
    g.append(p);
    paths.push(p);
  }
  svg.append(g, axis);
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, style: 'stroke: var(--ink)' }));

  // Hover: a crosshair, the layer under the pointer, and the composition at that moment.
  const cross = s('line', { y1: m.t, y2: H - m.b, style: 'stroke: var(--ink); stroke-width: 1; opacity: 0', 'pointer-events': 'none' });
  svg.append(cross);
  const setOpacity = (which: number): void => {
    if (periodLayers) highlightStratum(which);
    else paths.forEach((p, j) => { if (p) p.style.opacity = which < 0 || j === which ? '1' : '0.3'; });
  };
  const overlay = s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
  overlay.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
    const t = x.inv(px);
    let k = 0;
    for (let j = 0; j < times.length; j++) if (Math.abs(times[j] - t) < Math.abs(times[k] - t)) k = j;
    cross.setAttribute('x1', String(x(times[k])));
    cross.setAttribute('x2', String(x(times[k])));
    cross.style.opacity = '0.6';
    const val = y.inv(py);
    let acc = 0, which = -1;
    for (let i = 0; i < layers.length; i++) {
      const v = layers[i].values[k] || 0;
      acc += v;
      if (val <= acc && v > 0) { which = i; break; }
    }
    setOpacity(which);
    const comp = layers.map((L, i) => [i, L.values[k] || 0] as const).filter(([, v]) => v > 0).reverse();
    const tot = totals[k] || 1;
    const rows = comp.slice(0, 9).map(([i, v]) => {
      const label = i === which ? `<b>${esc(layers[i].label)}</b>` : esc(layers[i].label);
      return `<div class="row"><span><i style="display:inline-block;width:9px;height:9px;background:${layers[i].color};margin-right:6px"></i>${label}</span><span>${F.num(v)} · ${F.pct(v / tot)}</span></div>`;
    }).join('');
    showTip(e, `<b>${F.date(times[k])}</b> · ${F.num(totals[k])} ${T.lines}<hr>${rows}${comp.length > 9 ? '<div class="muted">…</div>' : ''}`);
  });
  overlay.addEventListener('mouseleave', () => { cross.style.opacity = '0'; setOpacity(-1); hideTip(); });
  svg.append(overlay);
  host.append(svg);
  linked.strataPaths = periodLayers ? paths : [];

  const legend = $('strata-legend');
  legend.innerHTML = '';
  for (let i = layers.length - 1; i >= 0; i--) {
    if (!paths[i]) continue;
    const L = layers[i];
    legend.append(h('span', null, h('i', { style: `background:${L.color}` }), periodLayers ? `${L.label} · ${periodName(L.key as number)}` : L.label));
  }
}
