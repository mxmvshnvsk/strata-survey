// Path bookkeeping: rename resolution through time, and module boundaries.

import type { Timestamp } from './types.ts';

/**
 * Time-aware rename resolution: map (historical path, time) → path at HEAD.
 * A naive old→new alias map breaks when a path is re-used after a rename
 * (a.js → b.js in 2015, a fresh a.js in 2018), so every rename carries its time.
 */
export class PathResolver {
  private readonly byFrom = new Map<string, [Timestamp, string][]>();
  private readonly cache = new Map<string, string>();

  /** renames: [time, from, to] */
  constructor(renames: Iterable<[Timestamp, string, string]>) {
    for (const [t, from, to] of renames) {
      if (from === to) continue;
      let l = this.byFrom.get(from);
      if (!l) this.byFrom.set(from, (l = []));
      l.push([t, to]);
    }
    for (const l of this.byFrom.values()) l.sort((a, b) => a[0] - b[0]);
  }

  /** The path at HEAD of the file that was called `path` at time `t`. */
  resolve(path: string, t: Timestamp): string {
    const key = path + '\0' + t;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let p = path;
    let time = t;
    for (let hops = 0; hops < 64; hops++) {
      const l = this.byFrom.get(p);
      if (!l) break;
      // first rename of p strictly after `time` (binary search)
      let lo = 0, hi = l.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (l[mid][0] > time) hi = mid; else lo = mid + 1; }
      if (lo === l.length) break;
      time = l[lo][0];
      p = l[lo][1];
    }
    if (this.cache.size < 2_000_000) this.cache.set(key, p);
    return p;
  }
}

/** Maps a path to its module name; `list` holds all module names. */
export interface ModuleOf {
  (path: string): string;
  list: string[];
}

interface ModuleDraft { depth: number; files: string[] }

/**
 * Adaptive module boundaries: start from top-level directories and keep splitting
 * the biggest one into its subdirectories while that keeps the map readable
 * (≤ maxModules). Files directly in the root belong to "(root)".
 */
export function buildModules(paths: string[], { maxModules = 32, minShare = 0.12 } = {}): ModuleOf {
  const total = paths.length || 1;
  const dirOf = (p: string, depth: number): string | null => {
    const parts = p.split('/');
    return parts.length - 1 < depth ? null : parts.slice(0, depth).join('/');
  };

  const modules = new Map<string, ModuleDraft>();
  for (const p of paths) {
    const d = dirOf(p, 1) ?? '(root)';
    let m = modules.get(d);
    if (!m) modules.set(d, (m = { depth: d === '(root)' ? 0 : 1, files: [] }));
    m.files.push(p);
  }

  const frozen = new Set(['(root)']);
  for (let iter = 0; iter < 200; iter++) {
    const cand = [...modules.entries()].filter(([n]) => !frozen.has(n)).sort((a, b) => b[1].files.length - a[1].files.length)[0];
    if (!cand || cand[1].files.length / total < minShare) break;
    const [name, m] = cand;

    // Group the module's files by the next directory level.
    const kids = new Map<string, ModuleDraft>();
    for (const p of m.files) {
      const d = dirOf(p, m.depth + 1) ?? name;
      let k = kids.get(d);
      if (!k) kids.set(d, (k = { depth: d === name ? m.depth : m.depth + 1, files: [] }));
      k.files.push(p);
    }
    if (kids.size <= 1) {
      // A single subdirectory: descend without changing the count.
      const [only] = kids.keys();
      if (only === name) { frozen.add(name); continue; }
      modules.delete(name);
      modules.set(only, kids.get(only)!);
      continue;
    }

    modules.delete(name);
    let entries = [...kids.entries()].sort((a, b) => b[1].files.length - a[1].files.length);
    const room = maxModules - modules.size;
    if (entries.length > room) {
      // Too many subfolders: promote the biggest, fold the rest back into the parent.
      const keepN = Math.max(0, Math.min(room - 1, 8));
      const rest: ModuleDraft = { depth: m.depth, files: [] };
      for (const [, v] of entries.slice(keepN)) rest.files.push(...v.files);
      entries = [...entries.slice(0, keepN), [name, rest]];
    }
    for (const [k, v] of entries) {
      modules.set(k, v);
      if (k === name) frozen.add(k);
    }
  }

  // Longest prefix wins, so "packages/core/src" beats "packages".
  const names = [...modules.keys()].filter((n) => n !== '(root)').sort((a, b) => b.length - a.length);
  const cache = new Map<string, string>();
  const moduleOf = ((p: string): string => {
    let r = cache.get(p);
    if (r) return r;
    r = names.find((n) => p.startsWith(n + '/')) || '(root)';
    cache.set(p, r);
    return r;
  }) as ModuleOf;
  moduleOf.list = [...modules.keys()];
  return moduleOf;
}
