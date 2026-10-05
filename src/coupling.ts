// Temporal (change) coupling: files that keep changing in the same commits
// share a hidden dependency, whatever the import graph says.
//
//   degree(a, b) = shared(a, b) / mean(revs(a), revs(b))      (as in code-maat)
//
// Commits touching more than `maxFiles` files are mass edits (renames, reformatting,
// license headers) and carry no signal, so they are ignored.

import type { PathResolver, ModuleOf } from './paths.ts';
import type { Commit, CouplingPair, CouplingReport, ModuleLink, Partner } from './types.ts';

export interface CouplingOptions {
  resolver: PathResolver;
  /** Files at HEAD that take part. */
  headSet: Set<string>;
  moduleOf: ModuleOf;
  isCode?: (path: string) => boolean;
  maxFiles?: number;
  minShared?: number;
  minDegree?: number;
  top?: number;
}

/** The report, plus per-file partners (moved onto the files by the caller). */
export interface CouplingResult extends CouplingReport {
  partners: Map<string, Partner[]>;
}

// Pair keys are a * N + b, exact as long as there are fewer than 2M files.
const N = 1 << 21;

export function analyzeCoupling(commits: Commit[], { resolver, headSet, moduleOf, isCode = () => true, maxFiles = 30, minShared = 5, minDegree = 0.3, top = 60 }: CouplingOptions): CouplingResult {
  const ids = new Map<string, number>();
  const names: string[] = [];
  const idOf = (p: string): number => {
    let i = ids.get(p);
    if (i === undefined) { i = names.length; ids.set(p, i); names.push(p); }
    return i;
  };
  const revs: number[] = [];
  const pairs = new Map<number, number>();

  const modIds = new Map<string, number>();
  const modNames: string[] = [];
  const modRevs: number[] = [];
  const modPairs = new Map<number, number>();
  const modIdOf = (m: string): number => {
    let i = modIds.get(m);
    if (i === undefined) { i = modNames.length; modIds.set(m, i); modNames.push(m); modRevs.push(0); }
    return i;
  };

  let used = 0;
  for (const c of commits) {
    if (c.parents.length > 1 || c.files.length === 0) continue;
    const set = new Set<number>();
    for (const f of c.files) {
      const p = resolver.resolve(f.path, c.ct);
      if (headSet.has(p)) set.add(idOf(p));
    }
    if (set.size === 0 || set.size > maxFiles) continue;
    used++;
    const list = [...set].sort((a, b) => a - b);
    for (const a of list) revs[a] = (revs[a] || 0) + 1;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = list[i] * N + list[j];
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
    }
    const mods = [...new Set(list.map((i) => modIdOf(moduleOf(names[i]))))].sort((a, b) => a - b);
    for (const m of mods) modRevs[m]++;
    for (let i = 0; i < mods.length; i++) {
      for (let j = i + 1; j < mods.length; j++) {
        const k = mods[i] * N + mods[j];
        modPairs.set(k, (modPairs.get(k) || 0) + 1);
      }
    }
  }

  // Per-file partners for the "borehole" panel: how often the partner changes when
  // this file changes (confidence, as in association rules).
  const partners = new Map<string, Partner[]>();
  const addPartner = (p: string, q: string, shared: number, confidence: number): void => {
    let l = partners.get(p);
    if (!l) partners.set(p, (l = []));
    l.push([q, shared, +confidence.toFixed(3)]);
  };
  for (const [k, shared] of pairs) {
    if (shared < 3) continue;
    const a = Math.floor(k / N), b = k % N;
    if (shared / revs[a] >= 0.05) addPartner(names[a], names[b], shared, shared / revs[a]);
    if (shared / revs[b] >= 0.05) addPartner(names[b], names[a], shared, shared / revs[b]);
  }
  for (const l of partners.values()) {
    l.sort((x, y) => y[2] * Math.log1p(y[1]) - x[2] * Math.log1p(x[1]));
    l.length = Math.min(l.length, 6);
  }

  const filePairs: CouplingPair[] = [];
  for (const [k, shared] of pairs) {
    if (shared < minShared) continue;
    const a = Math.floor(k / N), b = k % N;
    const degree = shared / ((revs[a] + revs[b]) / 2);
    if (degree < minDegree) continue;
    const pa = names[a], pb = names[b];
    filePairs.push({ a: pa, b: pb, shared, degree: +degree.toFixed(3), revsA: revs[a], revsB: revs[b], crossModule: moduleOf(pa) !== moduleOf(pb) });
  }
  // Rank by evidence-weighted strength.
  filePairs.sort((x, y) => y.degree * Math.log1p(y.shared) - x.degree * Math.log1p(x.shared));

  const modLinks: ModuleLink[] = [];
  for (const [k, shared] of modPairs) {
    if (shared < 3) continue;
    const a = Math.floor(k / N), b = k % N;
    modLinks.push({ a: modNames[a], b: modNames[b], shared, degree: +(shared / Math.min(modRevs[a], modRevs[b])).toFixed(3) });
  }
  modLinks.sort((x, y) => y.shared - x.shared);

  return {
    commitsUsed: used,
    partners,
    maxFiles,
    pairs: filePairs.slice(0, top),
    codePairs: filePairs.filter((p) => isCode(p.a) && isCode(p.b)).slice(0, top),
    modules: modNames.map((m, i) => ({ module: m, revs: modRevs[i] })).sort((a, b) => b.revs - a.revs),
    moduleLinks: modLinks.slice(0, 400),
  };
}
