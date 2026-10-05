// The stratigraphic column in the hero: code alive today, layered by age,
// with a time scrubber that replays how it grew and eroded.

import { $, h, s, clip, esc, showTip, hideTip, tipRow } from './dom.ts';
import { D, state, ui, nStrata, strataColor, periodName, person, linked, highlightStratum } from './context.ts';

/** Lithology patterns (sandstone, limestone, shale…) laid over the strata colours. */
function lithologyPatterns(): SVGDefsElement {
  const defs = s('defs');
  const pattern = (id: string, w: number, hgt: number, ...kids: SVGElement[]): void => {
    defs.append(s('pattern', { id, width: w, height: hgt, patternUnits: 'userSpaceOnUse' }, ...kids));
  };
  const stroke = 'stroke: var(--hatch); fill: none; stroke-width: 1';
  const fill = 'fill: var(--hatch)';
  pattern('lith0', 8, 8, s('circle', { cx: 2, cy: 2, r: 0.9, style: fill }), s('circle', { cx: 6, cy: 6, r: 0.9, style: fill })); // sandstone
  pattern('lith1', 16, 8, s('path', { d: 'M0 0.5H16M0 4.5H16M4 0.5V4.5M12 4.5V8.5', style: stroke })); // limestone
  pattern('lith2', 12, 5, s('path', { d: 'M1 2.5H6M8 2.5H11', style: stroke })); // shale
  pattern('lith3', 10, 10, s('path', { d: 'M0 10L10 0M-2 2L2 -2M8 12L12 8', style: stroke })); // dolomite
  pattern('lith4', 10, 8, s('circle', { cx: 3, cy: 3, r: 1.8, style: stroke }), s('circle', { cx: 8, cy: 7, r: 1.2, style: stroke })); // conglomerate
  pattern('lith5', 14, 6, s('path', { d: 'M0 3Q3.5 0 7 3T14 3', style: stroke })); // siltstone
  return defs;
}

export function renderColumn(): void {
  const { F, T } = ui;
  const host = $('column');
  host.innerHTML = '';
  const W = Math.max(250, host.clientWidth || 300);
  const S = D.strata.samples;
  const lastK = S.length - 1;
  const k = state.colSample == null || state.colSample >= lastK ? lastK : state.colSample;
  const atHead = k === lastK;
  const tNow = S.length ? S[k].t : D.meta.tEnd;
  const alive = atHead ? D.strata.alive : S[k].c;
  const written = D.strata.written;
  // Scale by the largest the codebase has ever been, so scrubbing shows growth and erosion.
  const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
  const total = Math.max(1, ...S.map((x) => sum(x.c)), sum(D.strata.alive));
  renderColumnControls(k, lastK);

  // As tall as the field notes beside it (or a fixed height when stacked on phones).
  const notes = $('notes');
  const twoCol = host.getBoundingClientRect().left < notes.getBoundingClientRect().left - 20;
  const H = twoCol ? Math.min(980, Math.max(380, notes.offsetHeight)) : Math.min(620, Math.max(360, nStrata * 26));
  const colX = 6, colW = Math.min(96, W * 0.32);
  const minH = 3, unconformityH = 6;

  // Strata with no surviving lines become thin wavy "unconformities".
  const rows: number[] = [];
  for (let i = 0; i < nStrata; i++) if ((written[i] > 0 || alive[i] > 0) && (atHead || D.strata.starts[i] <= tNow)) rows.push(i);
  const fixed = rows.reduce((a, i) => a + (alive[i] > 0 ? minH : unconformityH), 0);
  const avail = H - 20 - fixed;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': T.columnTitle });
  svg.append(lithologyPatterns());
  let y = H - 10;
  const layerEls: SVGGElement[] = [];
  for (const i of rows) {
    const hh = alive[i] > 0 ? minH + (alive[i] / total) * avail : unconformityH;
    y -= hh;
    const g = s('g', { class: 'layer-anim', 'data-i': i });
    if (alive[i] > 0) {
      g.append(s('rect', { x: colX, y, width: colW, height: hh, fill: strataColor(i) }));
      g.append(s('rect', { x: colX, y, width: colW, height: hh, fill: `url(#lith${i % 6})` }));
    } else {
      let d = `M${colX} ${y + hh / 2}`;
      for (let x = colX; x < colX + colW; x += 6) d += ' q1.5 -2.5 3 0 t3 0';
      g.append(s('path', { d, style: 'stroke: var(--muted); fill: none; stroke-width: 1' }));
    }

    // Labels: year, then period name, lines and survival when there is room.
    if (hh >= 15 || alive[i] === 0) {
      const ly = y + hh / 2;
      const tx = colX + colW + 12;
      if (alive[i] > 0) {
        g.append(s('text', { x: tx, y: ly - (hh >= 30 ? 3 : -4), style: 'font: 600 15px var(--font-display); fill: var(--ink)' }, D.strata.labels[i]));
        if (hh >= 30) {
          const detail = atHead
            ? `${periodName(i)} · ${F.num(alive[i])} · ${F.pct(alive[i] / Math.max(1, written[i]))} ${T.survived}`
            : `${periodName(i)} · ${F.num(alive[i])}`;
          g.append(s('text', { x: tx, y: ly + 12, class: 'svg-text' }, clip(detail, W - tx - 2, 6.7)));
        } else {
          g.append(s('text', { x: W - 4, y: ly + 4, 'text-anchor': 'end', class: 'svg-text' }, F.num(alive[i])));
        }
      } else if (rows.length < 30) {
        g.append(s('text', { x: tx, y: ly + 4, class: 'svg-text', style: 'font-style: italic' }, clip(`${D.strata.labels[i]} · ${T.unconformity}`, W - tx - 2, 6.7)));
      }
    }

    g.addEventListener('mousemove', (e) => {
      highlightStratum(i);
      const authors = D.strata.authors[i];
      showTip(e, `<b>${esc(D.strata.labels[i])}</b> · ${esc(periodName(i))}<hr>` +
        tipRow(T.written, F.num(written[i])) + tipRow(T.alive, F.num(alive[i])) +
        tipRow(T.survived, F.pct(alive[i] / Math.max(1, written[i]))) + tipRow(T.share, F.pct(alive[i] / total, 1)) +
        (authors.length ? '<hr>' + authors.map(([a, n]) => tipRow(person(a), F.num(n))).join('') : ''));
    });
    g.addEventListener('mouseleave', () => { highlightStratum(-1); hideTip(); });
    svg.append(g);
    layerEls.push(g);
  }

  svg.append(s('rect', { x: colX, y, width: colW, height: H - 10 - y, style: 'fill: none; stroke: var(--ink); stroke-width: 1.2' }));
  const caption = '↓ ' + F.num(alive.reduce((a, b) => a + b, 0)) + ' ' + T.lines + (atHead ? '' : ' · ' + F.date(tNow));
  svg.append(s('text', { x: colX, y: H, class: 'svg-text' }, caption));
  host.append(svg);
  linked.columnLayers = layerEls;
}

// ── Time scrubber: drag (or play) through history ──────────────────────

let playTimer: ReturnType<typeof setInterval> | null = null;

function stopPlay(): void {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
}

function renderColumnControls(k: number, lastK: number): void {
  const { F, T } = ui;
  if (!document.getElementById('column-controls')) {
    const play = h('button', { type: 'button', id: 'col-play' });
    const range = h('input', { type: 'range', id: 'col-time', min: '0', step: '1' });
    const out = h('output', { id: 'col-date', for: 'col-time' });
    range.addEventListener('input', () => { stopPlay(); state.colSample = Number(range.value); renderColumn(); });
    play.addEventListener('click', () => {
      if (playTimer) { stopPlay(); renderColumn(); return; }
      const n = D.strata.samples.length - 1;
      let at = state.colSample == null || state.colSample >= n ? 0 : state.colSample;
      state.colSample = at;
      play.textContent = '❚❚';
      playTimer = setInterval(() => {
        at = Math.min(n, at + Math.max(1, Math.round(n / 160)));
        state.colSample = at;
        if (at >= n) stopPlay();
        renderColumn();
      }, 40);
    });
    $('column').after(h('div', { id: 'column-controls', class: 'scrub' }, play, range, out));
  }
  const range = $<HTMLInputElement>('col-time');
  range.max = String(lastK);
  range.value = String(k);
  range.setAttribute('aria-label', T.scrub);
  const play = $('col-play');
  play.textContent = playTimer ? '❚❚' : '▶';
  play.setAttribute('aria-label', playTimer ? T.pause : T.play);
  $('col-date').textContent = k === lastK ? 'HEAD' : F.month(D.strata.samples[k].t);
}
