// Turns the survey into a handful of structured "findings". Their text lives in
// i18n.ts, so the same facts render in English or Russian, in the CLI and the report.

import type { Fact, Survey } from './types.ts';

const DAY = 86400;
const YEAR = 365.25 * DAY;

export function writeNarrative(m: Omit<Survey, 'narrative'>): Fact[] {
  const facts: Fact[] = [];
  const { meta, strata, survival, files, hotspots, coupling, modules, people, fossils, extinctions, pulse } = m;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const name = (id: number): string => (people[id] ? people[id].name : '?');

  if (meta.shallow) facts.push({ k: 'shallow', v: { since: meta.tStart } });
  facts.push({ k: 'age', v: { years: (meta.tEnd - meta.tStart) / YEAR, since: meta.tStart, commits: meta.commits, people: meta.people, lines: meta.lines, files: meta.files } });

  // How old is the code alive today?
  const alive = strata.alive;
  const total = alive.reduce((s, x) => s + x, 0);
  if (total > 0) {
    let acc = 0, medianIdx = 0;
    for (let i = 0; i < alive.length; i++) { acc += alive[i]; if (acc >= total / 2) { medianIdx = i; break; } }
    const oldestIdx = alive.findIndex((x) => x > 0);
    const lastIdx = alive.length - 1;
    facts.push({
      k: 'strata',
      v: {
        median: strata.labels[medianIdx], unit: strata.unit,
        oldest: strata.labels[oldestIdx], oldestShare: alive[oldestIdx] / total, oldestLines: alive[oldestIdx],
        newest: strata.labels[lastIdx], newestShare: alive[lastIdx] / total,
      },
    });
    // Most and least durable strata (only substantial ones, and not the current one).
    const cand: { i: number; r: number }[] = [];
    for (let i = 0; i < alive.length - 1; i++) if (strata.written[i] > total * 0.02) cand.push({ i, r: alive[i] / strata.written[i] });
    if (cand.length >= 3) {
      cand.sort((a, b) => a.r - b.r);
      const worst = cand[0], best = cand[cand.length - 1];
      facts.push({ k: 'durability', v: { worst: strata.labels[worst.i], worstR: worst.r, best: strata.labels[best.i], bestR: best.r } });
    }
  }

  if (survival.overall.medianDays) {
    const v: Record<string, number> = { days: survival.overall.medianDays };
    const s = survival.byRole.source?.medianDays, t = survival.byRole.tests?.medianDays;
    if (s && t) { v.source = s; v.tests = t; }
    facts.push({ k: 'halfLife', v });
  } else if (survival.overall.total) {
    const last = survival.overall.points[survival.overall.points.length - 1];
    facts.push({ k: 'immortal', v: { share: last ? last[1] : 1, days: last ? last[0] : 0 } });
  }

  if (hotspots.length && hotspots[0].revs >= 3) {
    const h = hotspots[0];
    facts.push({ k: 'hotspot', v: { path: h.path, revs: h.revs, loc: h.loc, recent: meta.useRecent } });
  }

  // Prefer coupling between code files, and across module boundaries.
  const isCode = (p: string): boolean => { const f = byPath.get(p); return !!f && (f.role === 'source' || f.role === 'tests'); };
  const codePairs = coupling.codePairs || coupling.pairs.filter((p) => isCode(p.a) && isCode(p.b));
  const pair = codePairs.find((p) => p.crossModule) || codePairs[0] || coupling.pairs[0];
  if (pair) facts.push({ k: 'coupling', v: { a: pair.a, b: pair.b, shared: pair.shared, degree: pair.degree } });

  const silo = modules.filter((x) => x.busFactor === 1 && x.loc > meta.lines * 0.04).sort((a, b) => b.loc - a.loc)[0];
  const siloOwner = silo?.owners[0];
  facts.push({ k: 'bus', v: { bus: meta.busFactor, silo: silo ? silo.module : null, siloOwner: siloOwner ? name(siloOwner[0]) : null, siloShare: siloOwner ? siloOwner[1] : 0, orphan: meta.orphanShare } });

  if (extinctions.length) {
    const e = extinctions[0];
    facts.push({ k: 'extinction', v: { subject: e.subject, author: name(e.author), t: e.t, removedOld: e.removedOld, h: e.h.slice(0, 10) } });
  }

  if (fossils.length) {
    const f = fossils[0];
    facts.push({ k: 'fossil', v: { path: f.path, line: f.line, t: f.at, author: name(f.author), text: f.text.trim().slice(0, 90) } });
  }

  // Activity trend: the last 52 weeks against the 52 before.
  const w = pulse.weekly;
  if (w.length > 60) {
    const a = w.slice(-52).reduce((s, x) => s + x, 0);
    const b = w.slice(-104, -52).reduce((s, x) => s + x, 0);
    if (a + b > 0) facts.push({ k: 'trend', v: { last: a, prev: b } });
  }
  return facts;
}
