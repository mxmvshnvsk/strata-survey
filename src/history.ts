// Pass 1: the commit graph. One `git log --numstat -z` over every commit reachable
// from HEAD gives us parents, authors, timestamps and per-file churn.

import { gitStream } from './git.ts';
import type { Commit, FileChange, Person } from './types.ts';

const BOT_RE = /\[bot\]|^dependabot|^renovate|^github-actions|^greenkeeper|^snyk-bot|^semantic-release|^web-flow$|^allcontributors|^pre-commit-ci|^codecov/i;

/** Churn of files we left out, used to decide whether git pathspecs are worth their cost. */
export interface ExcludedStats {
  churn: number;
  keptChurn: number;
  paths: Set<string>;
}

export interface History {
  /** All commits reachable from HEAD, oldest first. */
  commits: Commit[];
  byHash: Map<string, Commit>;
  people: Person[];
  excluded: ExcludedStats;
}

export interface ReadHistoryOptions {
  rev?: string;
  pathspecs?: string[];
  keep?: (path: string) => boolean;
  onProgress?: (commits: number) => void;
}

// A record separator that cannot appear in subjects or names in practice.
const SEP = '\x01\x02\x03';

export async function readHistory(repo: string, { rev = 'HEAD', pathspecs = [], keep = () => true, onProgress }: ReadHistoryOptions = {}): Promise<History> {
  const commits: Commit[] = [];
  const byHash = new Map<string, Commit>();
  // Excluded paths are filtered here rather than with git pathspecs: glob pathspecs
  // make `git log` several times slower on big histories.
  const excluded: ExcludedStats = { churn: 0, keptChurn: 0, paths: new Set() };
  const args = ['log', rev, '-z', '--numstat', '-M', '--no-color', '--date-order', '--full-history', '--sparse',
    '--format=%x01%x02%x03%H%x00%P%x00%at%x00%ct%x00%aN%x00%aE%x00%s', ...pathspecs];

  await gitStream(repo, args, (rec) => {
    if (!rec) return;
    // Fields are NUL-separated: 7 header fields, then numstat entries.
    const t = rec.split('\0');
    if (t.length < 7) return;
    const c: Commit = {
      h: t[0],
      parents: t[1] ? t[1].split(' ') : [],
      at: Number(t[2]),
      ct: Number(t[3]),
      an: t[4],
      ae: t[5].toLowerCase(),
      subject: t[6].replace(/\n+$/, ''),
      files: [],
      author: -1,
    };
    for (let i = 7; i < t.length; i++) {
      let tok = t[i];
      if (tok.startsWith('\n')) tok = tok.replace(/^\n+/, '');
      if (!tok) continue;
      // "added<TAB>deleted<TAB>path", or "added<TAB>deleted<TAB>" followed by two
      // NUL-separated paths (from, to) for a rename.
      const a = tok.indexOf('\t');
      const b = tok.indexOf('\t', a + 1);
      if (a < 0 || b < 0) continue;
      const add = tok.slice(0, a);
      const del = tok.slice(a + 1, b);
      let path = tok.slice(b + 1);
      let from: string | null = null;
      if (path === '') { from = t[++i]; path = t[++i]; }
      if (!path) continue;
      const binary = add === '-';
      const change: FileChange = { path, from, add: binary ? 0 : Number(add), del: del === '-' ? 0 : Number(del), binary };
      const churn = change.add + change.del;
      if (!keep(path)) {
        excluded.churn += churn;
        if (excluded.paths.size < 20000) excluded.paths.add(path);
        continue;
      }
      excluded.keptChurn += churn;
      c.files.push(change);
    }
    commits.push(c);
    byHash.set(c.h, c);
    if (onProgress && commits.length % 2000 === 0) onProgress(commits.length);
  }, { sep: SEP });

  commits.reverse(); // oldest first
  const people = resolveIdentities(commits);
  return { commits, byHash, people, excluded };
}

/** Merge author identities that share a name or an email (mailmap is already applied by %aN). */
function resolveIdentities(commits: Commit[]): Person[] {
  // Union-find over keys "n:<name>" and "e:<email>".
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const add = (x: string): void => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a: string, b: string): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  // Shared placeholder addresses would wrongly merge strangers.
  const genericEmail = (e: string): boolean => !e || (/noreply|no-reply|localhost|\(none\)|^root@|users\.noreply/.test(e) && !/^\d+\+/.test(e));

  for (const c of commits) {
    const n = 'n:' + c.an.trim().toLowerCase();
    add(n);
    if (!genericEmail(c.ae) || /^\d+\+[^@]+@users\.noreply\.github\.com$/.test(c.ae)) {
      const e = 'e:' + c.ae;
      add(e);
      union(n, e);
    }
  }

  interface Draft { id: number; names: Map<string, number>; emails: Set<string>; commits: number; first: number; last: number; added: number; deleted: number }
  const groups = new Map<string, Draft>();
  const drafts: Draft[] = [];
  for (const c of commits) {
    const root = find('n:' + c.an.trim().toLowerCase());
    let p = groups.get(root);
    if (!p) {
      p = { id: drafts.length, names: new Map(), emails: new Set(), commits: 0, first: c.at, last: c.at, added: 0, deleted: 0 };
      groups.set(root, p);
      drafts.push(p);
    }
    p.names.set(c.an, (p.names.get(c.an) || 0) + 1);
    p.emails.add(c.ae);
    if (c.parents.length <= 1) {
      p.commits++;
      for (const f of c.files) { p.added += f.add; p.deleted += f.del; }
    }
    if (c.at < p.first) p.first = c.at;
    if (c.at > p.last) p.last = c.at;
    c.author = p.id;
  }

  return drafts.map((d): Person => {
    // The most frequently used spelling of the name wins.
    const name = [...d.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const emails = [...d.emails];
    return {
      id: d.id, name, names: [...d.names.keys()], emails,
      commits: d.commits, first: d.first, last: d.last, added: d.added, deleted: d.deleted,
      bot: BOT_RE.test(name) || emails.some((e) => /\[bot\]|bot@|noreply@github\.com$/.test(e) && /bot/.test(e)),
    };
  });
}

export interface FirstParentHistory {
  /** The first-parent chain from the root commit to HEAD. */
  chain: Commit[];
  /** For every merge on the chain: the commits it brought in. */
  sideCommits: Map<string, Commit[]>;
}

/**
 * Walk the first-parent chain and, for each merge, find the commits it brought in
 * (reachable from the side parents but not from anything merged before).
 */
export function firstParentChain(byHash: Map<string, Commit>, head: string): FirstParentHistory {
  const chain: Commit[] = [];
  let h: string | undefined = head;
  while (h && byHash.has(h)) {
    const c: Commit = byHash.get(h)!;
    chain.push(c);
    h = c.parents[0];
  }
  chain.reverse();
  const absorbed = new Set<string>();
  const sideCommits = new Map<string, Commit[]>();
  for (const c of chain) {
    if (c.parents.length > 1) {
      const side: Commit[] = [];
      const stack = c.parents.slice(1);
      while (stack.length) {
        const x = stack.pop()!;
        if (absorbed.has(x)) continue;
        const xc = byHash.get(x);
        if (!xc) continue;
        absorbed.add(x);
        side.push(xc);
        for (const p of xc.parents) if (!absorbed.has(p)) stack.push(p);
      }
      sideCommits.set(c.h, side);
    }
    absorbed.add(c.h);
  }
  return { chain, sideCommits };
}
