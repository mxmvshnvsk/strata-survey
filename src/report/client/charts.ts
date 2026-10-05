// Plates III, IV, V and IX: half-life curves, the hotspot scatter,
// the fault-line ring and the seismograph.

import { $, h, s, esc, lin, niceTicks, timeTicks, maxOf, basename, clip, cssVar, showTip, hideTip, tipRow, DAY } from './dom.ts';
import { D, state, ui, person } from './context.ts';
import { fileTip } from './map.ts';
import type { FileReport, SurvivalCurve } from '../../types.ts';

const empty = (): HTMLElement => h('p', { class: 'empty' }, ui.T.noData);

// ── III · Half-life (Kaplan–Meier) ──────────────────────────────────────

export function renderHalfLife(): void {
  const { F, T } = ui;
  const host = $('hl-fig');
  host.innerHTML = '';
  const series: [string, SurvivalCurve][] = [['all', D.survival.overall], ...Object.entries(D.survival.byRole) as [string, SurvivalCurve][]];
  if (!D.survival.overall.points.length) { host.append(empty()); return; }

  const W = Math.max(320, host.clientWidth);
  const H = W < 600 ? 280 : 340;
  const m = { l: 46, r: 18, t: 12, b: 34 };
  const maxDays = maxOf(0, series.map(([, v]) => (v.points.length ? v.points[v.points.length - 1][0] : 0)));
  const inYears = maxDays > 540;
  const unit = inYears ? 365.25 : 30.44;
  const x = lin(0, maxDays / unit, m.l, W - m.r), y = lin(0, 1, H - m.b, m.t);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': T.hlTitle });
  const grid = s('g', { class: 'grid' }), axis = s('g', { class: 'axis' });
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    axis.append(s('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, F.pct(v)));
  }
  for (const v of niceTicks(0, maxDays / unit, W < 600 ? 5 : 10)) {
    axis.append(s('line', { x1: x(v), x2: x(v), y1: H - m.b, y2: H - m.b + 4 }));
    axis.append(s('text', { x: x(v), y: H - m.b + 17, 'text-anchor': 'middle' }, String(v)));
  }
  const unitName = inYears ? (state.lang === 'ru' ? 'лет' : 'years') : (state.lang === 'ru' ? 'месяцев' : 'months');
  axis.append(s('text', { x: W - m.r, y: H - 2, 'text-anchor': 'end' }, `${T.yearsAxis}, ${unitName} →`));
  svg.append(grid, axis);
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(0.5), y2: y(0.5), style: 'stroke: var(--ink); stroke-dasharray: 4 3; opacity: .5' }));

  const colors: Record<string, string> = { all: 'var(--ink)', source: 'var(--accent)', tests: 'var(--ok)', docs: 'var(--warn)', 'config & tooling': 'var(--muted)' };
  const legend = $('hl-legend');
  legend.innerHTML = '';
  for (const [name, v] of series) {
    if (!v.points.length) continue;
    // A step function, as Kaplan–Meier curves are drawn.
    let d = `M${x(0)} ${y(1)}`;
    let prev = 1;
    for (const [days, sv] of v.points) {
      const px = x(days / unit).toFixed(1);
      d += `L${px} ${y(prev).toFixed(1)}L${px} ${y(sv).toFixed(1)}`;
      prev = sv;
    }
    const col = colors[name] || 'var(--ink-2)';
    svg.append(s('path', { d, style: `fill: none; stroke: ${col}; stroke-width: ${name === 'all' ? 2.4 : 1.5}` }));
    if (v.medianDays) {
      const cx = x(v.medianDays / unit);
      svg.append(s('circle', { cx, cy: y(0.5), r: name === 'all' ? 5 : 3.5, style: `fill: ${col}; stroke: var(--paper); stroke-width: 1.5` }));
      if (name === 'all') {
        svg.append(s('text', { x: cx + 10, y: y(0.5) - 10, style: 'font: 600 14px var(--font-display); fill: var(--ink); paint-order: stroke; stroke: var(--paper); stroke-width: 4' }, `t½ = ${F.dur(v.medianDays)}`));
      }
    }
    const label = name === 'all' ? T.allAges : (T.roles[name as keyof typeof T.roles] || name);
    legend.append(h('span', null, h('i', { style: `background:${col}` }), `${label}${v.medianDays ? ' · t½ ' + F.dur(v.medianDays) : ''} · n=${F.num(v.total)}`));
  }
  host.append(svg);
}

// ── IV · Hotspots ───────────────────────────────────────────────────────

/** Keep only values whose positions are at least `minGap` pixels apart. */
function spaced(values: number[], pos: (v: number) => number, minGap: number): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (const v of values) { const p = pos(v); if (Math.abs(p - last) >= minGap) { out.push(v); last = p; } }
  return out;
}

export function renderHotspots(): void {
  const { F, T } = ui;
  const host = $('hot-fig');
  host.innerHTML = '';
  const freq = (f: FileReport): number => (D.meta.useRecent ? f.recent : f.revs);
  const pts = D.files.filter((f) => (f.role === 'source' || f.role === 'tests') && f.cx > 0 && freq(f) > 0);

  if (!pts.length) host.append(empty());
  else {
    const W = Math.max(300, host.clientWidth);
    const H = Math.min(440, Math.max(300, W * 0.78));
    const m = { l: 48, r: 14, t: 12, b: 36 };
    const mxF = maxOf(0, pts.map(freq)), mxC = maxOf(0, pts.map((f) => f.cx));
    const lg = (v: number): number => Math.log10(v + 1);
    const x = lin(0, lg(mxF) * 1.05, m.l, W - m.r), y = lin(0, lg(mxC) * 1.05, H - m.b, m.t);

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': T.hotTitle });
    const grid = s('g', { class: 'grid' }), axis = s('g', { class: 'axis' });
    for (const v of spaced([1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000].filter((v) => v <= mxF * 1.1), (v) => x(lg(v)), 34)) {
      grid.append(s('line', { x1: x(lg(v)), x2: x(lg(v)), y1: m.t, y2: H - m.b }));
      axis.append(s('text', { x: x(lg(v)), y: H - m.b + 16, 'text-anchor': 'middle' }, F.num(v)));
    }
    for (const v of spaced([3, 10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000].filter((v) => v <= mxC * 1.1), (v) => -y(lg(v)), 26)) {
      grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(lg(v)), y2: y(lg(v)) }));
      axis.append(s('text', { x: m.l - 6, y: y(lg(v)) + 4, 'text-anchor': 'end' }, F.num(v)));
    }
    axis.append(s('text', { x: W - m.r, y: H - 4, 'text-anchor': 'end' }, `${D.meta.useRecent ? T.recentRevs : T.revs} →`));
    axis.append(s('text', { x: m.l, y: m.t - 2 }, `↑ ${T.complexity}`));
    svg.append(grid, axis);

    // Bubbles, biggest first so small ones stay on top.
    const maxLoc = maxOf(1, pts.map((f) => f.loc));
    const hot = cssVar('--hot');
    for (const f of [...pts].sort((a, b) => b.loc - a.loc)) {
      const c = s('circle', {
        cx: x(lg(freq(f))), cy: y(lg(f.cx)), r: 2 + 14 * Math.sqrt(f.loc / maxLoc),
        fill: hot, 'fill-opacity': 0.12 + 0.75 * (f.hot || 0), style: 'stroke: var(--ink); stroke-width: 0.5; stroke-opacity: .5',
      });
      c.addEventListener('mousemove', (e) => showTip(e, fileTip(f)));
      c.addEventListener('mouseleave', hideTip);
      svg.append(c);
    }

    // Name the top hotspots, skipping labels that would overlap.
    const boxes: [number, number, number][] = [];
    for (const hs of D.hotspots.slice(0, 10)) {
      const f = pts.find((p) => p.path === hs.path);
      if (!f) continue;
      const cx = x(lg(freq(f))), cy = y(lg(f.cx));
      const right = cx < W * 0.7;
      const name = basename(f.path), tw = name.length * 6.6;
      const bx = right ? cx + 9 : cx - 9 - tw, by = cy - 16;
      if (boxes.some(([x0, y0, w0]) => bx < x0 + w0 && bx + tw > x0 && by < y0 + 13 && by + 13 > y0)) continue;
      boxes.push([bx, by, tw]);
      svg.append(s('text', { x: cx + (right ? 9 : -9), y: cy - 6, 'text-anchor': right ? 'start' : 'end', style: 'font: 11px var(--font-data); fill: var(--ink); paint-order: stroke; stroke: var(--paper); stroke-width: 3' }, name));
    }
    host.append(svg);
  }

  const tbl = $('hot-table');
  tbl.innerHTML = '';
  if (!D.hotspots.length) return;
  tbl.append(h('table', null,
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, T.file), h('th', { class: 'num', title: D.meta.useRecent ? T.recentRevs : T.revs }, T.revsShort), h('th', { class: 'num' }, T.complexity))),
    h('tbody', null, D.hotspots.slice(0, 12).map((x, i) => h('tr', null,
      h('td', { class: 'num muted' }, i + 1),
      h('td', { class: 'path' }, x.path, x.owner >= 0 ? h('div', { class: 'muted', style: 'font-family: var(--font-body)' }, `${person(x.owner)} · ${F.pct(x.ownerShare)}`) : null),
      h('td', { class: 'num' }, F.num(x.revs)),
      h('td', { class: 'num' }, F.num(x.cx)))))));
}

// ── V · Fault lines (temporal coupling) ─────────────────────────────────

export function renderFaults(): void {
  const { F, T } = ui;
  const host = $('fault-fig');
  host.innerHTML = '';
  const links = D.coupling.moduleLinks;
  const modRevs = new Map(D.coupling.modules.map((m) => [m.module, m.revs]));
  const linked = new Set<string>();
  for (const l of links) { linked.add(l.a); linked.add(l.b); }
  const nodes = [...linked].sort((a, b) => (modRevs.get(b) || 0) - (modRevs.get(a) || 0)).slice(0, 22);
  const set = new Set(nodes);
  const use = links.filter((l) => set.has(l.a) && set.has(l.b)).slice(0, 70);

  if (nodes.length < 2 || !use.length) host.append(empty());
  else {
    const W = Math.max(300, host.clientWidth);
    const H = Math.min(520, W * 0.95);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - Math.min(120, W * 0.2);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': T.faultTitle });

    // Modules sit on a ring (alphabetically, so related paths are neighbours).
    const pos = new Map<string, [number, number, number]>();
    const order = [...nodes].sort();
    order.forEach((n, i) => {
      const a = (i / order.length) * Math.PI * 2 - Math.PI / 2;
      pos.set(n, [cx + R * Math.cos(a), cy + R * Math.sin(a), a]);
    });

    const maxShared = maxOf(1, use.map((l) => l.shared));
    const linkEls: [typeof use[number], SVGPathElement][] = [];
    const accent = cssVar('--accent');
    for (const l of use) {
      const [x1, y1] = pos.get(l.a)!, [x2, y2] = pos.get(l.b)!;
      const p = s('path', {
        d: `M${x1} ${y1}Q${cx + (x1 + x2 - 2 * cx) * 0.15} ${cy + (y1 + y2 - 2 * cy) * 0.15} ${x2} ${y2}`,
        style: `fill: none; stroke: ${accent}; stroke-width: ${0.6 + 7 * Math.sqrt(l.shared / maxShared)}; stroke-opacity: ${0.12 + 0.6 * Math.min(1, l.degree)}`,
        class: 'layer-anim',
      });
      p.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(l.a)}</b> ⟷ <b>${esc(l.b)}</b><hr>${tipRow(T.shared, F.num(l.shared) + ' ' + T.commits)}${tipRow(T.degree, F.pct(l.degree))}`));
      p.addEventListener('mouseleave', hideTip);
      linkEls.push([l, p]);
      svg.append(p);
    }

    const maxRevs = maxOf(1, nodes.map((k) => modRevs.get(k) || 1));
    for (const n of order) {
      const [x, y, a] = pos.get(n)!;
      const r = 3 + 6 * Math.sqrt((modRevs.get(n) || 1) / maxRevs);
      const g = s('g', { style: 'cursor: default' });
      g.append(s('circle', { cx: x, cy: y, r, style: 'fill: var(--ink); stroke: var(--paper); stroke-width: 1.5' }));
      const lx = cx + (R + r + 6) * Math.cos(a), ly = cy + (R + r + 6) * Math.sin(a);
      const vertical = Math.abs(Math.cos(a)) < 0.2;
      const anchor = vertical ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
      const short = n.split('/').length > 2 ? '…/' + n.split('/').slice(-2).join('/') : n;
      const room = Math.max(30, vertical ? 140 : (Math.cos(a) > 0 ? W - lx : lx) - 4);
      g.append(s('text', { x: lx, y: ly + 4 + (vertical ? (Math.sin(a) > 0 ? 8 : -4) : 0), 'text-anchor': anchor, style: 'font: 11px var(--font-data); fill: var(--ink)' }, clip(short, room, 6.7)));
      g.addEventListener('mouseenter', () => linkEls.forEach(([l, p]) => { p.style.opacity = l.a === n || l.b === n ? '1' : '0.08'; }));
      g.addEventListener('mouseleave', () => linkEls.forEach(([, p]) => { p.style.opacity = '1'; }));
      g.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(n)}</b><hr>${tipRow(T.commits, F.num(modRevs.get(n) || 0))}`));
      g.addEventListener('mouseout', hideTip);
      svg.append(g);
    }
    host.append(svg);
  }

  const tbl = $('fault-table');
  tbl.innerHTML = '';
  const pairs = D.coupling.codePairs && D.coupling.codePairs.length >= 5 ? D.coupling.codePairs : D.coupling.pairs;
  if (!pairs.length) { tbl.append(empty()); return; }
  tbl.append(h('table', null,
    h('thead', null, h('tr', null, h('th', null, T.pair), h('th', { class: 'num' }, T.shared), h('th', null, T.degree))),
    h('tbody', null, pairs.slice(0, 14).map((p) => h('tr', null,
      h('td', { class: 'path' }, p.a, h('br'), h('span', { class: 'muted' }, '⟷ '), p.b),
      h('td', { class: 'num' }, F.num(p.shared)),
      h('td', null, F.pct(p.degree), h('div', { class: 'bar' }, h('span', { style: `width:${Math.min(100, p.degree * 100)}%; background: ${p.crossModule ? 'var(--hot)' : 'var(--ink-2)'}` }))))))));
}

// ── IX · Seismograph ────────────────────────────────────────────────────

export function renderSeismo(): void {
  const { F, T } = ui;
  const host = $('seis-fig');
  host.innerHTML = '';
  const w = D.pulse.weekly;
  if (w.length < 3) { host.append(empty()); return; }

  const W = Math.max(320, host.clientWidth);
  const H = 244;
  const m = { l: 46, r: 14, t: 8, b: 24 };
  const WEEK = 7 * DAY;
  const t0 = D.pulse.weekStart, t1 = t0 + w.length * WEEK;
  const x = lin(t0, t1, m.l, W - m.r);
  const mid = 80, amp = 66;
  const mx = maxOf(0, w);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': T.seisTitle });
  const axis = s('g', { class: 'axis' });

  // Monthly active people: a shaded area along the bottom.
  const mp = D.pulse.monthly;
  const monthStart = (k: number): number => Date.UTC(Math.floor(k / 12), k % 12, 1) / 1000;
  const yb = lin(0, maxOf(1, mp.map((q) => q[1])), H - m.b, mid + amp + 20);
  if (mp.length) {
    const d = mp.map(([k, n], i) => (i ? 'L' : 'M') + x(monthStart(k)).toFixed(1) + ' ' + yb(n).toFixed(1)).join('');
    const close = `L${x(monthStart(mp[mp.length - 1][0]))} ${yb(0)}L${x(monthStart(mp[0][0]))} ${yb(0)}Z`;
    svg.append(s('path', { d: d + close, style: 'fill: var(--accent); fill-opacity: .18; stroke: var(--accent); stroke-width: 1' }));
    const peak = maxOf(0, mp.map((q) => q[1]));
    axis.append(s('text', { x: m.l - 6, y: yb(peak) + 4, 'text-anchor': 'end' }, String(peak)));
  }

  // The seismogram: an up/down stroke per week, scaled by √commits.
  let d = `M${x(t0)} ${mid}`;
  w.forEach((n, i) => {
    const a = (Math.sqrt(n) / Math.sqrt(mx || 1)) * amp;
    const tx = x(t0 + (i + 0.5) * WEEK);
    d += `L${tx.toFixed(1)} ${(mid - a).toFixed(1)}L${(tx + 0.01).toFixed(2)} ${(mid + a * 0.85).toFixed(1)}`;
  });
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: mid, y2: mid, style: 'stroke: var(--rule-strong)' }));
  svg.append(s('path', { d, style: 'fill: none; stroke: var(--ink); stroke-width: 0.9; stroke-linejoin: round' }));
  axis.append(s('text', { x: m.l - 6, y: mid - amp + 4, 'text-anchor': 'end' }, String(mx)));
  for (const [t, lab] of timeTicks(t0, t1, W < 600 ? 5 : 12, state.lang)) {
    axis.append(s('line', { x1: x(t), x2: x(t), y1: H - m.b, y2: H - m.b + 4 }));
    axis.append(s('text', { x: x(t), y: H - m.b + 17, 'text-anchor': 'middle' }, lab));
  }
  axis.append(s('text', { x: m.l + 4, y: m.t + 6 }, T.byWeek));
  axis.append(s('text', { x: m.l + 4, y: mid + amp + 13 }, T.activePeople));
  svg.append(axis);

  const overlay = s('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H - m.b, fill: 'transparent' });
  overlay.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const t = x.inv(((e.clientX - r.left) / r.width) * W);
    const i = Math.max(0, Math.min(w.length - 1, Math.floor((t - t0) / WEEK)));
    const date = new Date(t * 1000);
    const month = mp.find((q) => q[0] === date.getUTCFullYear() * 12 + date.getUTCMonth());
    showTip(e, `<b>${F.date(t0 + i * WEEK)}</b><hr>${tipRow(T.byWeek, w[i])}${month ? tipRow(T.activePeople, month[1]) : ''}`);
  });
  overlay.addEventListener('mouseleave', hideTip);
  svg.append(overlay);
  host.append(svg);
}
