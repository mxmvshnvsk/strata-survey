// The header, the field notes, and the table-like plates:
// VI knowledge, VII fossils, VIII events, and the footer.

import { $, h, YEAR, DAY } from './dom.ts';
import { D, state, ui, strataColor, periodName, bucketOfTime, person } from './context.ts';
import { renderFact } from '../../i18n.ts';
import type { CommitEvent } from '../../types.ts';

export function renderHeader(): void {
  const { F, T } = ui;
  const m = D.meta;
  $('repo-name').textContent = m.name;
  const meta = $('meta');
  meta.innerHTML = '';
  const item = (k: string, v: string): HTMLElement => h('span', null, k + ' ', h('b', null, v));
  meta.append(
    item(T.surveyed, F.date(m.generatedAt)),
    item(T.head, m.head.slice(0, 10) + (m.branch && m.branch !== 'HEAD' ? ' · ' + m.branch : '')),
    item(T.commits, F.num(m.commits)),
    item(T.people, F.num(m.people)),
    item(T.files, F.num(m.files)),
    item(T.lines, F.num(m.lines)),
  );
  if (m.remote) meta.append(h('span', null, m.remote.replace(/\.git$/, '')));

  // Static texts in the template carry data-i18n="<key>".
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((e) => {
    const text = T[e.getAttribute('data-i18n') as keyof typeof T];
    if (typeof text === 'string') e.textContent = text.replace('{max}', String(D.coupling.maxFiles));
  });
  document.querySelectorAll<HTMLElement>('#lang-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
  document.documentElement.lang = state.lang;

  const notes = $('notes');
  notes.innerHTML = '';
  // renderFact escapes every value; it only emits <b> and <code>.
  for (const fact of D.narrative) notes.append(h('li', null, h('div', { html: renderFact(fact, state.lang) })));
}

// ── VI · Knowledge & bus factor ─────────────────────────────────────────

export function renderKnowledge(): void {
  const { F, T } = ui;
  const busPill = (b: number): HTMLElement => h('span', { class: 'pill ' + (b <= 1 ? 'bad' : b === 2 ? 'mid' : 'good') }, b);

  const mt = $('module-table');
  mt.innerHTML = '';
  mt.append(h('table', null,
    h('thead', null, h('tr', null, h('th', null, T.module), h('th', { class: 'num' }, T.loc), h('th', null, T.bus), h('th', null, T.owner), h('th', { class: 'num' }, T.atRisk))),
    h('tbody', null, D.modules.slice(0, 16).map((m) => {
      const top = m.owners[0];
      return h('tr', null,
        h('td', { class: 'path' }, m.module),
        h('td', { class: 'num' }, F.num(m.loc)),
        h('td', null, busPill(m.busFactor)),
        h('td', null, top ? `${person(top[0])} · ${F.pct(top[1])}` : '—', top ? h('div', { class: 'bar' }, h('span', { style: `width:${top[1] * 100}%` })) : null),
        h('td', { class: 'num' }, F.pct(m.orphan)));
    }))));

  const pt = $('people-table');
  pt.innerHTML = '';
  const total = D.people.reduce((a, p) => a + p.lines, 0) || 1;
  const cut = D.meta.tEnd - YEAR;
  const list = D.people.filter((p) => p.lines > 0).sort((a, b) => b.lines - a.lines).slice(0, 16);
  const year = (t: number): number => new Date(t * 1000).getUTCFullYear();
  pt.append(h('table', null,
    h('thead', null, h('tr', null, h('th', null, T.person), h('th', { class: 'num' }, T.lines), h('th', { class: 'num' }, T.commits), h('th', null, T.firstLast))),
    h('tbody', null, list.map((p) => {
      const inactive = p.last < cut;
      return h('tr', null,
        h('td', null, p.name, p.bot ? h('span', { class: 'muted' }, ' · bot') : null,
          h('div', { class: 'bar' }, h('span', { style: `width:${(p.lines / list[0].lines) * 100}%; background:${inactive ? 'var(--warn)' : 'var(--ink-2)'}` }))),
        h('td', { class: 'num' }, F.num(p.lines), h('div', { class: 'muted' }, F.pct(p.lines / total, 1))),
        h('td', { class: 'num' }, F.num(p.commits)),
        h('td', { class: 'mono', style: `color: ${inactive ? 'var(--warn)' : 'inherit'}` }, `${year(p.first)}–${year(p.last)}`, h('div', { class: 'muted' }, inactive ? T.inactive : T.active)));
    }))));
}

// ── VII · Fossil record ─────────────────────────────────────────────────

export function renderFossils(): void {
  const { F, T } = ui;
  const host = $('fossil-list');
  host.innerHTML = '';
  if (!D.fossils.length) { host.append(h('p', { class: 'empty' }, T.noData)); return; }
  for (const f of D.fossils) {
    const b = bucketOfTime(f.at);
    host.append(h('div', { class: 'specimen' },
      h('div', { class: 'tag' },
        h('span', null, h('span', { class: 'swatch', style: `background:${strataColor(b)}` }), `${F.date(f.at)} · ${periodName(b)}`),
        h('span', null, person(f.author))),
      h('pre', null, f.text.trim()),
      h('div', { class: 'tag' }, h('span', null, `${f.path}:${f.line}`), h('span', null, F.dur((D.meta.tEnd - f.at) / DAY)))));
  }
}

// ── VIII · Extinctions & big bangs ──────────────────────────────────────

export function renderEvents(): void {
  const { F, T } = ui;
  const fill = (id: string, list: CommitEvent[], kind: 'extinction' | 'bang'): void => {
    const ul = $(id);
    ul.innerHTML = '';
    if (!list.length) { ul.append(h('li', { class: 'empty' }, T.noData)); return; }
    for (const e of list) {
      ul.append(h('li', null,
        h('span', { class: 'when' }, F.date(e.t)),
        h('span', { class: 'what' }, h('code', null, e.h.slice(0, 8)), ' ', e.subject, h('span', { class: 'muted' }, ` · ${person(e.author)}${e.merge ? ' · ' + T.merge : ''}`)),
        kind === 'extinction'
          ? h('span', { class: 'n minus', title: `${T.meanAgeRemoved}: ${F.dur(e.meanAgeDays)}` }, '−' + F.num(e.removedOld))
          : h('span', { class: 'n plus' }, '+' + F.num(e.added))));
    }
  };
  fill('ext-list', D.extinctions.slice(0, 8), 'extinction');
  fill('bang-list', D.bigBangs.slice(0, 8), 'bang');
}

// ── Footer ──────────────────────────────────────────────────────────────

export function renderFoot(): void {
  const { T } = ui;
  const dg = D.meta.diagnostics;
  const foot = $('foot');
  foot.innerHTML = '';
  const diag = T.diag.replace('{s}', (dg.durationMs / 1000).toFixed(1)).replace('{g}', dg.gitVersion)
    .replace('{r}', String(dg.repairs)).replace('{m}', String(dg.headMismatchFiles));
  foot.append(
    h('div', null, h('div', { class: 'label' }, T.methodTitle), h('p', null, T.method)),
    h('div', null, h('div', { class: 'label' }, T.diagTitle), h('p', null, diag)),
    h('div', null, h('div', { class: 'label' }, T.excludedTitle), h('p', null, T.excludedText.replace('{n}', String(D.meta.excludes.length))), h('p', { class: 'mono' }, 'strata · ' + D.meta.head.slice(0, 12))),
  );
}
