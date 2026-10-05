// Plate II: the geological map (a squarified treemap of every file) and the
// "borehole" panel that opens when a file is clicked.

import { $, h, s, esc, clip, inkOn, maxOf, cssVar, showTip, hideTip, tipRow } from './dom.ts';
import { D, state, ui, nStrata, OWNER_COLORS, strataColor, periodName, bucketOfTime, person, topOwners, type MapMode } from './context.ts';
import type { FileReport } from '../../types.ts';

// ── The folder tree ─────────────────────────────────────────────────────

interface TreeNode {
  /** Display name (may span several folders after compression: "packages/vite"). */
  name: string;
  path: string;
  kids: Map<string, TreeNode>;
  /** Lines in this subtree. */
  size: number;
  file: FileReport | null;
}

const tree: TreeNode = { name: '', path: '', kids: new Map(), size: 0, file: null };
for (const f of D.files) {
  if (f.loc <= 0) continue;
  const parts = f.path.split('/');
  let n = tree;
  n.size += f.loc;
  for (let i = 0; i < parts.length; i++) {
    let c = n.kids.get(parts[i]);
    if (!c) { c = { name: parts[i], path: parts.slice(0, i + 1).join('/'), kids: new Map(), size: 0, file: null }; n.kids.set(parts[i], c); }
    c.size += f.loc;
    n = c;
  }
  n.file = f;
}

// Collapse chains of single-subfolder directories (packages/vite/src → one header).
const nodeByPath = new Map<string, TreeNode>([['', tree]]);
(function compress(node: TreeNode): void {
  for (const [key, c] of [...node.kids]) {
    let cur = c;
    while (!cur.file && cur.kids.size === 1) {
      const only = [...cur.kids.values()][0];
      if (only.file || !only.kids.size) break;
      only.name = cur.name + '/' + only.name;
      cur = only;
    }
    if (cur !== c) { node.kids.delete(key); node.kids.set(cur.name, cur); }
    nodeByPath.set(cur.path, cur);
    compress(cur);
  }
})(tree);

/** The node for a path; for a folder hidden by compression, its nearest shown descendant. */
function findNode(path: string): TreeNode {
  const hit = nodeByPath.get(path);
  if (hit) return hit;
  let best: TreeNode | null = null;
  for (const [k, n] of nodeByPath) if (k.startsWith(path + '/') && (!best || k.length < best.path.length)) best = n;
  return best || tree;
}

export const fileByPath = new Map(D.files.map((f) => [f.path, f]));

// ── Squarified treemap layout (Bruls, Huizing & van Wijk) ───────────────

interface Placed<T> { item: T; x: number; y: number; w: number; h: number }

function squarify<T extends { size: number }>(items: T[], x: number, y: number, w: number, hgt: number): Placed<T>[] {
  const out: Placed<T>[] = [];
  const total = items.reduce((a, b) => a + b.size, 0);
  if (total <= 0 || w <= 0 || hgt <= 0) return out;
  const scale = (w * hgt) / total;
  let rest = items.map((it) => ({ it, a: it.size * scale }));
  while (rest.length) {
    // Grow a row along the short side while the worst aspect ratio improves.
    const short = Math.min(w, hgt);
    const row: typeof rest = [];
    let best = Infinity, sum = 0, mx = 0, mn = Infinity;
    for (const r of rest) {
      const s2 = sum + r.a;
      const mx2 = Math.max(mx, r.a), mn2 = Math.min(mn, r.a);
      const worst = Math.max((short * short * mx2) / (s2 * s2), (s2 * s2) / (short * short * mn2));
      if (worst > best && row.length) break;
      best = worst; row.push(r); sum = s2; mx = mx2; mn = mn2;
    }
    rest = rest.slice(row.length);
    const thick = sum / short;
    let off = 0;
    for (const r of row) {
      const len = r.a / thick;
      if (w >= hgt) out.push({ item: r.it, x, y: y + off, w: thick, h: len });
      else out.push({ item: r.it, x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= hgt) { x += thick; w -= thick; } else { y += thick; hgt -= thick; }
  }
  return out;
}

// ── Colouring ───────────────────────────────────────────────────────────

/** [colour, opacity] of a file tile in the current mode. */
type TileColor = (f: FileReport) => [string, number];

function mapColorFn(mode: MapMode): TileColor {
  const sheet = cssVar('--sheet');
  switch (mode) {
    case 'age': return (f) => [f.medianAt ? strataColor(bucketOfTime(f.medianAt)) : sheet, 1];
    case 'hot': { const hot = cssVar('--hot'); return (f) => [hot, 0.06 + 0.94 * Math.pow(f.hot || 0, 1.3)]; }
    case 'orphan': { const warn = cssVar('--warn'); return (f) => [warn, 0.06 + 0.94 * f.orphan]; }
    case 'churn': {
      const accent = cssVar('--accent');
      const mx = maxOf(1, D.files.map((f) => f.recent));
      return (f) => [accent, 0.06 + 0.94 * (Math.log1p(f.recent) / Math.log1p(mx))];
    }
    case 'owner': {
      const top = topOwners();
      const muted = cssVar('--muted');
      return (f) => {
        const o = f.owners[0];
        if (!o) return [sheet, 1];
        const k = top.indexOf(o[0]);
        return k < 0 ? [muted, 0.25 + 0.5 * f.ownerShare] : [OWNER_COLORS[k], 0.3 + 0.7 * f.ownerShare];
      };
    }
  }
}

// ── Rendering ───────────────────────────────────────────────────────────

export function renderMap(): void {
  const { F, T } = ui;

  const modes = $('map-mode');
  modes.innerHTML = '';
  for (const k of Object.keys(T.modes) as MapMode[]) {
    modes.append(h('button', { type: 'button', 'aria-pressed': String(state.mapMode === k), onclick: () => { state.mapMode = k; renderMap(); } }, T.modes[k]));
  }

  // Breadcrumbs of the zoomed folder.
  const crumbs = $('map-crumbs');
  crumbs.innerHTML = '';
  const parts = state.mapRoot ? state.mapRoot.split('/') : [];
  crumbs.append(h('button', { type: 'button', onclick: () => { state.mapRoot = ''; renderMap(); } }, T.zoomOut));
  parts.forEach((p, i) => {
    crumbs.append(h('span', null, '/'));
    const path = parts.slice(0, i + 1).join('/');
    crumbs.append(i === parts.length - 1 ? h('span', null, p) : h('button', { type: 'button', onclick: () => { state.mapRoot = path; renderMap(); } }, p));
  });

  ensureSearchBox(crumbs);

  const host = $('map-fig');
  host.innerHTML = '';
  const W = Math.max(320, host.clientWidth);
  const H = W < 600 ? 420 : 600;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': T.mapTitle });
  const colorOf = mapColorFn(state.mapMode);
  const sheet = cssVar('--sheet');

  const drawFile = (n: TreeNode, f: FileReport, r: Placed<TreeNode>): void => {
    const [col, op] = colorOf(f);
    const g = s('g', { style: 'cursor: pointer' });
    const w = Math.max(0, r.w), hh = Math.max(0, r.h);
    g.append(s('rect', { x: r.x, y: r.y, width: w, height: hh, fill: sheet }));
    g.append(s('rect', { x: r.x, y: r.y, width: w, height: hh, fill: col, 'fill-opacity': op, style: 'stroke: var(--paper); stroke-width: 0.6' }));
    if (r.w > 64 && r.h > 16) {
      g.append(s('text', { x: r.x + 4, y: r.y + 12, style: `font: 10.5px var(--font-data); fill: ${inkOn(col, op, sheet)}; pointer-events: none` }, clip(n.name, r.w - 8, 6.4)));
    }
    if (f.path === state.selected) {
      g.append(s('rect', { x: r.x + 1, y: r.y + 1, width: Math.max(0, r.w - 2), height: Math.max(0, r.h - 2), style: 'fill: none; stroke: var(--ink); stroke-width: 2.5; pointer-events: none' }));
    }
    g.addEventListener('mousemove', (e) => showTip(e, fileTip(f)));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', () => { hideTip(); openBorehole(f.path, true); });
    svg.append(g);
  };

  const drawFolder = (n: TreeNode, r: Placed<TreeNode>, depth: number): void => {
    const header = r.w > 70 && r.h > 34 ? 15 : 0;
    const pad = depth === 0 ? 2 : 1;
    const g = s('g', { style: 'cursor: zoom-in' });
    g.append(s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, style: `fill: var(--sheet); stroke: var(--ink); stroke-width: ${depth === 0 ? 1.2 : 0.5}` }));
    if (header) {
      g.append(s('text', { x: r.x + 4, y: r.y + 11.5, style: `font: ${depth === 0 ? 600 : 500} 11px var(--font-display); letter-spacing: 0.04em; fill: var(--ink); text-transform: uppercase` }, clip(n.name + '/', r.w - 8, 6.2)));
    }
    g.addEventListener('click', () => { state.mapRoot = n.path; hideTip(); renderMap(); });
    g.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(n.path)}/</b><hr>${tipRow(T.lines, F.num(n.size))}<div class="muted">${T.clickZoom}</div>`));
    g.addEventListener('mouseleave', hideTip);
    svg.append(g);
    drawChildren(n, r.x + pad, r.y + pad + header, r.w - 2 * pad, r.h - 2 * pad - header, depth + 1);
  };

  const drawChildren = (node: TreeNode, x: number, y: number, w: number, hh: number, depth: number): void => {
    const kids = [...node.kids.values()].filter((k) => k.size > 0).sort((a, b) => b.size - a.size);
    for (const r of squarify(kids, x, y, w, hh)) {
      const n = r.item;
      if (n.file && !n.kids.size) drawFile(n, n.file, r);
      else drawFolder(n, r, depth);
    }
  };

  const root = findNode(state.mapRoot);
  if (root.file && !root.kids.size) drawFile(root, root.file, { item: root, x: 0, y: 0, w: W, h: H });
  else drawChildren(root, 0, 0, W, H, 0);
  host.append(svg);
  renderMapLegend();
}

function renderMapLegend(): void {
  const { T } = ui;
  const legend = $('map-legend');
  legend.innerHTML = '';
  if (state.mapMode === 'age') {
    for (let i = nStrata - 1; i >= 0; i--) if (D.strata.written[i]) legend.append(h('span', null, h('i', { style: `background:${strataColor(i)}` }), D.strata.labels[i]));
    legend.append(h('span', { class: 'muted' }, '(' + T.medianLine + ')'));
  } else if (state.mapMode === 'owner') {
    topOwners().forEach((id, k) => legend.append(h('span', null, h('i', { style: `background:${OWNER_COLORS[k]}` }), person(id))));
    legend.append(h('span', null, h('i', { style: 'background: var(--muted); opacity: .5' }), T.other));
  } else {
    const col = state.mapMode === 'hot' ? 'var(--hot)' : state.mapMode === 'orphan' ? 'var(--warn)' : 'var(--accent)';
    const label = state.mapMode === 'hot' ? T.hotLegend : state.mapMode === 'orphan' ? T.orphanLegend : T.churnLegend;
    legend.append(h('span', null, h('i', { style: `background: linear-gradient(90deg, transparent, ${col}); width: 90px` }), label));
  }
}

/** The "find file" box next to the breadcrumbs (created once, relabelled on language change). */
function ensureSearchBox(crumbs: HTMLElement): void {
  const { T } = ui;
  let search = document.getElementById('map-search') as HTMLInputElement | null;
  if (!search) {
    const list = h('datalist', { id: 'map-files' }, D.files.filter((f) => f.loc > 0).map((f) => h('option', { value: f.path })));
    const input = h('input', { id: 'map-search', type: 'search', list: 'map-files', autocomplete: 'off', spellcheck: 'false' });
    const go = (): void => { if (fileByPath.has(input.value)) openBorehole(input.value, true, true); };
    input.addEventListener('change', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    crumbs.parentElement!.append(h('div', { class: 'map-search' }, h('label', { class: 'label', for: 'map-search', id: 'map-search-label' }, T.findFile), input, list));
    search = input;
  }
  $('map-search-label').textContent = T.findFile;
  search.placeholder = T.findPlaceholder;
}

/** Tooltip for a file (used by the map and the hotspot chart). */
export function fileTip(f: FileReport): string {
  const { F, T } = ui;
  const ownerRows = f.owners.map(([a, n]) => tipRow(person(a), F.pct(n / Math.max(1, f.loc)))).join('');
  const b = f.medianAt ? bucketOfTime(f.medianAt) : -1;
  const core = f.core && f.core.length
    ? `<hr><div class="muted">${T.coreSample}</div><div style="display:flex;height:10px;margin-top:4px">${f.core.map(([k, n]) => `<span style="flex:${n} 0 0;background:${strataColor(k)}"></span>`).join('')}</div>`
    : '';
  return `<b>${esc(f.path)}</b><hr>` +
    tipRow(T.loc, F.num(f.loc)) + tipRow(T.complexity, F.num(f.cx)) +
    tipRow(T.revs, F.num(f.revs)) + tipRow(T.recentRevs, F.num(f.recent)) +
    (f.medianAt ? tipRow(T.medianLine, `${F.month(f.medianAt)} · ${esc(b >= 0 ? periodName(b) : '')}`) : '') +
    (f.last ? tipRow(T.lastChange, F.date(f.last)) : '') +
    tipRow(T.atRisk, F.pct(f.orphan)) + tipRow(T.role, esc(T.roles[f.role] || f.role)) +
    core + (ownerRows ? '<hr>' + ownerRows : '');
}

// ── Borehole: one file's own geology ────────────────────────────────────

/** Select a file: highlight it on the map and open its panel. */
export function openBorehole(path: string, scroll: boolean, zoom = false): void {
  const box = $('borehole');
  if (!fileByPath.has(path)) { box.hidden = true; state.selected = null; return; }
  state.selected = path;
  if (zoom) {
    // Zoom to the deepest shown folder (after chain compression) that contains the file.
    let dir = path;
    do { dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''; } while (dir && !nodeByPath.has(dir));
    state.mapRoot = dir;
  }
  renderMap();
  renderBorehole();
  box.hidden = false;
  if (scroll) box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
}

export function renderBorehole(): void {
  const { F, T } = ui;
  const box = $('borehole');
  const f = state.selected ? fileByPath.get(state.selected) : undefined;
  if (!f) { box.hidden = true; return; }
  box.innerHTML = '';

  const coreRuns = f.core || [];
  const total = coreRuns.reduce((a, [, n]) => a + n, 0) || 1;
  const core = h('div', { class: 'core', role: 'img', 'aria-label': T.coreSample });
  for (const [b, n] of coreRuns) {
    core.append(h('span', { style: `flex:${n} 0 0;background:${strataColor(b)}`, title: `${D.strata.labels[b]} · ${periodName(b)} · ${F.num(n)} ${T.lines} (${F.pct(n / total)})` }));
  }
  const first = coreRuns.length ? D.strata.labels[coreRuns[0][0]] : '';
  const last = coreRuns.length ? D.strata.labels[coreRuns[coreRuns.length - 1][0]] : '';
  const b = f.medianAt ? bucketOfTime(f.medianAt) : -1;
  const stat = (k: string, v: string): HTMLElement[] => [h('dt', null, k), h('dd', null, v)];

  const left = h('div', null,
    h('div', { class: 'label' }, T.borehole),
    h('h3', null, f.path),
    core,
    h('div', { class: 'core-labels' }, h('span', null, '↓ ' + first), h('span', null, T.coreSample), h('span', null, last + ' ↑')),
    h('dl', null,
      stat(T.loc, F.num(f.loc)), stat(T.complexity, F.num(f.cx)),
      stat(T.revs, `${F.num(f.revs)} · ${F.num(f.recent)} ${T.inLastYear}`),
      stat(T.authors, F.num(f.nAuthors)),
      f.born ? stat(T.born, F.date(f.born)) : null,
      f.last ? stat(T.lastChange, F.date(f.last)) : null,
      f.medianAt ? stat(T.medianLine, `${F.month(f.medianAt)} · ${b >= 0 ? periodName(b) : ''}`) : null,
      stat(T.atRisk, F.pct(f.orphan)),
      stat(T.module, f.module), stat(T.role, T.roles[f.role] || f.role)));

  const owners = h('ul', null, f.owners.map(([a, n]) => h('li', null,
    h('span', null, person(a), h('div', { class: 'bar' }, h('span', { style: `width:${(n / Math.max(1, f.loc)) * 100}%` }))),
    h('span', { class: 'mono' }, F.pct(n / Math.max(1, f.loc))))));
  const partners = f.cpl && f.cpl.length
    ? h('ul', null, f.cpl.map(([p, shared, conf]) => h('li', null,
      h('span', { class: 'p' }, fileByPath.has(p) ? h('button', { type: 'button', onclick: () => openBorehole(p, false, true) }, p) : p),
      h('span', { class: 'mono' }, `${F.num(shared)} · ${F.pct(conf)}`))))
    : h('p', { class: 'muted' }, T.noPartners);

  const right = h('div', null,
    h('button', { type: 'button', class: 'close', onclick: () => { state.selected = null; box.hidden = true; renderMap(); } }, T.close),
    h('div', { class: 'label' }, T.owners), owners,
    h('div', { class: 'label', style: 'margin-top: 14px' }, T.changesWith), partners);
  box.append(left, right);
}
