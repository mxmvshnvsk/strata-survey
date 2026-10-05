// The survey data, the page state and the helpers every plate needs.

import { makeFmt, strataPalette, type Fmt } from '../../i18n.ts';
import { UI, type UiStrings } from './strings.ts';
import { $ } from './dom.ts';
import type { Lang, Survey } from '../../types.ts';

/** The survey, embedded in the page by render.ts. */
export const D: Survey = JSON.parse($('strata-data').textContent || '{}');

export type MapMode = 'age' | 'hot' | 'owner' | 'orphan' | 'churn';

export const state = {
  lang: (D.lang || 'en') as Lang,
  mapMode: 'age' as MapMode,
  /** Folder the geological map is zoomed into ('' = whole repository). */
  mapRoot: '',
  strataBy: 'period' as 'period' | 'author',
  strataModule: '',
  /** File whose borehole panel is open. */
  selected: null as string | null,
  /** Sample shown by the column's time scrubber (null = HEAD). */
  colSample: null as number | null,
};
try {
  const saved = localStorage.getItem('strata-lang');
  if (saved === 'en' || saved === 'ru') state.lang = saved;
} catch { /* storage unavailable */ }

/** Current formatters (F) and UI strings (T); swapped when the language changes. */
export const ui: { F: Fmt; T: UiStrings } = { F: makeFmt(state.lang), T: UI[state.lang] };

export function setLanguage(lang: Lang): void {
  state.lang = lang;
  ui.F = makeFmt(lang);
  ui.T = UI[lang] || UI.en;
}

/** Categorical colours for people (owner mode, layers by author). */
export const OWNER_COLORS = ['#3b6fd8', '#e0743a', '#3f9e6a', '#c24d8f', '#8a6dd6', '#c9a227', '#2aa6b5', '#a8553a', '#6b8e23'];

export const nStrata = D.strata.labels.length;
const palette = strataPalette(nStrata);
const clampStratum = (i: number): number => Math.max(0, Math.min(nStrata - 1, i));

export const strataColor = (i: number): string => palette[clampStratum(i)][0];
export const periodName = (i: number): string => palette[clampStratum(i)][state.lang === 'ru' ? 2 : 1];

/** Stratum index of a moment in time. */
export function bucketOfTime(t: number): number {
  let b = 0;
  for (let i = 0; i < D.strata.starts.length; i++) if (D.strata.starts[i] <= t) b = i;
  return b;
}

export const person = (id: number): string => (D.people[id] ? D.people[id].name : '?');

/** The people with the most surviving lines, who get their own colours. */
export const topOwners = (): number[] =>
  D.people.filter((p) => !p.bot && p.lines > 0).sort((a, b) => b.lines - a.lines).slice(0, OWNER_COLORS.length).map((p) => p.id);

// ── Linked highlighting between the column and the stratigraphy chart ──

export const linked = {
  columnLayers: [] as SVGGElement[],
  strataPaths: [] as (SVGPathElement | null)[],
};

/** Emphasise stratum `i` in both views (-1 clears). */
export function highlightStratum(i: number): void {
  linked.strataPaths.forEach((p, j) => { if (p) p.style.opacity = i < 0 || i === j ? '1' : '0.25'; });
  linked.columnLayers.forEach((g) => { g.style.opacity = i < 0 || Number(g.dataset.i) === i ? '1' : '0.3'; });
}
