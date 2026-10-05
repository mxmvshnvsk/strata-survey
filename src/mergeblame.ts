// Content-level credit for lines that arrived through merges.
//
// The replay walks first-parent history, so every line a merge brings in is first
// credited by a heuristic (the side commit that added most lines to that file).
// That is fine for squash workflows but blurs authorship in merge-heavy projects.
//
// Here we revisit only the lines that are still alive at HEAD and came from merges:
// we read the side-branch commits of those merges with one `git diff-tree --stdin`
// and credit each line to the latest side commit that added exactly that text.
// It reproduces plain `git blame` closely at a fraction of its cost.

import { gitStream } from './git.ts';
import { PatchParser } from './patch-parser.ts';
import type { Replay } from './replay.ts';
import type { Commit, OriginId } from './types.ts';

/** Shorter lines are matched by position (their neighbours), not by text. */
const TRIVIAL = 12;

/** Lines at HEAD that a merge brought in, waiting to be re-credited. */
export class MergeNeeds {
  /** merge chain index → line text → [path, line index][] */
  readonly byMerge = new Map<number, Map<string, [string, number][]>>();
  /** [path, line index, merge chain index] of short lines. */
  readonly trivial: [string, number, number][] = [];
  /** Upper bound on collected lines, to cap memory on huge repositories. */
  budget = 3_000_000;

  get size(): number {
    return this.byMerge.size + this.trivial.length;
  }

  /** Collect, from one file's content at HEAD, the merge-credited lines worth refining. */
  collect(R: Replay, path: string, lines: string[]): void {
    const arr = R.files.get(path);
    if (!arr) return;
    for (let i = 0; i < arr.length && i < lines.length; i++) {
      const o = arr[i];
      if (o < 0 || R.moved.has(o) || R.chain[R.oCommit[o]].parents.length <= 1) continue;
      if (this.budget <= 0) return;
      const mi = R.oCommit[o];
      if (lines[i].trim().length < TRIVIAL) {
        this.trivial.push([path, i, mi]);
        continue;
      }
      let m = this.byMerge.get(mi);
      if (!m) this.byMerge.set(mi, (m = new Map()));
      let spots = m.get(lines[i]);
      if (!spots) m.set(lines[i], (spots = []));
      spots.push([path, i]);
      this.budget--;
    }
  }
}

/** The best side commit for one line text: overall and per file path. */
interface Candidates { best: Commit; byPath: Map<string | null, Commit> }

/** Among candidates, credit the latest side commit to add the text (what blame would see). */
const later = (a: Commit, b: Commit): boolean => a.at >= b.at;

export interface RefineResult { lines: number; commits: number }

export async function refineMergeLines(
  repo: string,
  R: Replay,
  byHash: Map<string, Commit>,
  needs: MergeNeeds,
  { maxCommits = 200_000, onProgress }: { maxCommits?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<RefineResult> {
  if (!needs.size) return { lines: 0, commits: 0 };

  // Side commits to read, and which merge each belongs to.
  const mergeOfSide = new Map<string, number>();
  for (const mi of needs.byMerge.keys()) {
    for (const s of R.sideCommits.get(R.chain[mi].h) || []) if (s.parents.length <= 1) mergeOfSide.set(s.h, mi);
  }
  let lines = 0;
  if (mergeOfSide.size && mergeOfSide.size <= maxCommits) {
    const found = await findCandidates(repo, byHash, needs, mergeOfSide, onProgress);
    lines += recreditByText(R, needs, found);
  }
  lines += recreditTrivial(R, needs);
  return { lines, commits: mergeOfSide.size };
}

/** Read the side commits once and record, for each needed text, who added it. */
async function findCandidates(
  repo: string,
  byHash: Map<string, Commit>,
  needs: MergeNeeds,
  mergeOfSide: Map<string, number>,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, Map<string, Candidates>>> {
  const found = new Map<number, Map<string, Candidates>>();
  let cur: Commit | null = null;
  let curMerge = -1;
  let seen = 0;

  const parser = new PatchParser({
    onCommit: (hash) => {
      cur = byHash.get(hash) || null;
      curMerge = mergeOfSide.get(hash) ?? -1;
      if (onProgress && ++seen % 2000 === 0) onProgress(seen, mergeOfSide.size);
      return true; // we need the text of added lines
    },
    onFile: (fd) => {
      const want = needs.byMerge.get(curMerge);
      if (!cur || !want) return;
      const commit: Commit = cur;
      for (const hunk of fd.hunks) {
        for (const text of hunk.plus || []) {
          if (!want.has(text)) continue;
          let byText = found.get(curMerge);
          if (!byText) found.set(curMerge, (byText = new Map()));
          let e = byText.get(text);
          if (!e) byText.set(text, (e = { best: commit, byPath: new Map() }));
          if (later(commit, e.best)) e.best = commit;
          const pb = e.byPath.get(fd.newPath);
          if (!pb || later(commit, pb)) e.byPath.set(fd.newPath, commit);
        }
      }
    },
  });

  const HASH_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
  await gitStream(repo, ['diff-tree', '--stdin', '-p', '-U0', '-M', '--root', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', '--inter-hunk-context=0'],
  // diff-tree prints each commit id on its own line; the parser expects "\x01<hash>".
  (line) => parser.push(HASH_RE.test(line) ? '\x01' + line : line),
  { input: [...mergeOfSide.keys()] });
  parser.end();
  return found;
}

function recreditByText(R: Replay, needs: MergeNeeds, found: Map<number, Map<string, Candidates>>): number {
  const originOf = new Map<string, OriginId>(); // side hash + merge → origin
  let lines = 0;
  for (const [mi, want] of needs.byMerge) {
    const byText = found.get(mi);
    if (!byText) continue;
    for (const [text, spots] of want) {
      const e = byText.get(text);
      if (!e) continue;
      for (const [path, i] of spots) {
        // Prefer a side commit that added this text to this very file.
        const pick = e.byPath.get(path) || e.best;
        const key = pick.h + ':' + mi;
        let o = originOf.get(key);
        if (o === undefined) { o = R.newOrigin(pick.at, pick.author, mi, pick.h); originOf.set(key, o); }
        const arr = R.files.get(path);
        if (arr && arr[i] !== o) { R.recredit(arr, i, o, path); lines++; }
      }
    }
  }
  return lines;
}

/**
 * Short lines (braces, blanks) prove nothing on their own: they follow their
 * neighbours from the same merge — first the line above, then the line below.
 */
function recreditTrivial(R: Replay, needs: MergeNeeds): number {
  const sameMerge = (arr: OriginId[], j: number, mi: number): boolean =>
    j >= 0 && j < arr.length && arr[j] >= 0 && R.oCommit[arr[j]] === mi && R.oSide[arr[j]] !== null;
  let lines = 0;
  const left: [string, number, number][] = [];
  for (const t of needs.trivial) {
    const [path, i, mi] = t;
    const arr = R.files.get(path);
    if (!arr) continue;
    if (sameMerge(arr, i - 1, mi)) { R.recredit(arr, i, arr[i - 1], path); lines++; } else left.push(t);
  }
  for (let k = left.length - 1; k >= 0; k--) {
    const [path, i, mi] = left[k];
    const arr = R.files.get(path)!;
    if (sameMerge(arr, i + 1, mi)) { R.recredit(arr, i, arr[i + 1], path); lines++; }
  }
  return lines;
}
