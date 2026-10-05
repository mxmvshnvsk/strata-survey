// Pass 2: the replay engine.
//
// We walk the first-parent history oldest→newest with `git log -p -U0` and keep,
// for every file, an array with one entry per line: the id of the "origin" that
// wrote that line. Hunk headers alone tell us which lines die and which are born,
// so we never look at line contents. At HEAD this reproduces `git blame
// --first-parent` (see `strata verify`), but we also get the whole movie:
// when every line was born, when it died, and who killed it.

import { gitStream, readBlob, countLines, looksBinary, gitTextOrNull } from './git.ts';
import { fileRole } from './filters.ts';
import { PatchParser, parseHunkHeaders, type FileDiff, type Hunk } from './patch-parser.ts';
import { kaplanMeier, type KaplanMeier } from './survival.ts';
import type { Period } from './period.ts';
import type { ModuleOf } from './paths.ts';
import type { Bucket, Commit, OriginId, Person, PersonId, RepairNote, Role, Timestamp } from './types.ts';

const DAY = 86400;
/** Width of the age bins used for survival curves. */
export const AGE_BIN_DAYS = 7;
/** Shorter lines (braces, blanks, `return x`) are too common to prove a move. */
const MOVE_MIN = 12;

/** Per-commit bookkeeping for "extinctions" and "big bangs". */
export interface CommitStats {
  added: number;
  removed: number;
  /** Sum of the ages (seconds) of removed lines. */
  removedAgeSum: number;
  /** Removed lines older than a year. */
  removedOld: number;
  files: number;
}

/** State of the living code at one moment in time. */
export interface Snapshot {
  t: Timestamp;
  /** Living lines per stratum. */
  counts: number[];
  /** Living lines per author, for authors above 0.3% of the total. */
  authors: [PersonId, number][];
  /** Living lines per module × stratum (flattened), on every other snapshot. */
  mods?: number[];
  final?: boolean;
}

export interface ReplayOptions {
  chain: Commit[];
  sideCommits: Map<string, Commit[]>;
  people: Person[];
  keep: (path: string) => boolean;
  period: Period;
  tStart: Timestamp;
  tEnd: Timestamp;
  samples?: number;
  moduleOf?: ModuleOf | null;
  modules?: string[];
}

export interface RunOptions {
  pathspecs?: string[];
  diffMergesFlag?: string[];
  onProgress?: (done: number, total: number) => void;
}

/** A line removed by a merge, remembered in case the merge re-adds it elsewhere. */
type RemovedLine = [OriginId, Role];
/** Lines a merge added: [path, index of the first line, their text, their origin]. */
type BornRun = [string, number, string[], OriginId];

/** Diff two blobs as text; null if either is missing or binary. */
function textHunks(repo: string, a: string, b: string): Hunk[] | null {
  const A = readBlob(repo, a), B = readBlob(repo, b);
  if (!A || !B || looksBinary(A) || looksBinary(B)) return null;
  const out = gitTextOrNull(repo, ['diff', '--no-ext-diff', '--no-textconv', '--text', '-U0', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', a, b]);
  return out === null ? null : parseHunkHeaders(out);
}

const ageBin = (ageSeconds: number, nBins: number): number =>
  Math.min(nBins - 1, Math.floor(ageSeconds / (AGE_BIN_DAYS * DAY)));

export class Replay {
  readonly chain: Commit[];
  readonly sideCommits: Map<string, Commit[]>;
  readonly people: Person[];
  readonly keep: (path: string) => boolean;
  private readonly indexOf: Map<string, number>;
  private repo = '';

  // ── Origins: who wrote a line, and when. Parallel arrays keep memory small. ──
  readonly oAt: Timestamp[] = [];
  readonly oAuthor: PersonId[] = [];
  /** Index into `chain` of the first-parent commit that introduced the line. */
  readonly oCommit: number[] = [];
  /** Hash of the side-branch commit credited (merges only), or null. */
  readonly oSide: (string | null)[] = [];

  /** path → origin of every line (-1 = unknown). */
  readonly files = new Map<string, OriginId[]>();

  // ── Running tallies ──
  readonly period: Period;
  readonly nBuckets: number;
  /** Living lines per stratum. */
  readonly alive: Float64Array;
  /** Lines ever written per stratum. */
  readonly written: Float64Array;
  /** Living lines per author. */
  readonly aliveAuthor: Float64Array;
  /** Living lines per module × stratum, or null when modules are not tracked. */
  readonly aliveMod: Float64Array | null;

  // ── Timeline ──
  readonly tStart: Timestamp;
  readonly tEnd: Timestamp;
  private readonly sampleTimes: Timestamp[] = [];
  private nextSample = 0;
  readonly snapshots: Snapshot[] = [];
  maxCt = -Infinity;

  // ── Survival bookkeeping (Kaplan–Meier): deaths by age bin, per role ──
  readonly nAgeBins: number;
  readonly deaths = new Map<Role, Float64Array>();

  // ── Events and diagnostics ──
  readonly commitStats: CommitStats[];
  /** [time, from, to] for every rename on the first-parent chain. */
  readonly renames: [Timestamp, string, string][] = [];
  repairs = 0;
  readonly repairLog: RepairNote[] = [];

  // ── Merges ──
  trackMoves = true;
  private readonly mergeOriginCache = new Map<string, OriginId>();
  private mergeRemoved = new Map<string, RemovedLine[]>();
  private mergeBorn: BornRun[] = [];
  /** Origins created for lines that moved inside a merge (left alone by mergeblame). */
  readonly moved = new Set<OriginId>();
  movedLines = 0;

  // ── Modules ──
  readonly modules: string[];
  private readonly modIndex: Map<string, number>;
  private readonly moduleOf: ModuleOf | null;
  private readonly modCache = new Map<string, number>();
  /** Symlinks and submodules currently in the tree (they keep their mode through renames). */
  private readonly specialPaths = new Set<string>();

  private curOriginCommit = -1;
  private curOrigin: OriginId = -1;

  constructor({ chain, sideCommits, people, keep, period, tStart, tEnd, samples = 360, moduleOf = null, modules = [] }: ReplayOptions) {
    this.chain = chain;
    this.sideCommits = sideCommits;
    this.people = people;
    this.keep = keep;
    this.indexOf = new Map(chain.map((c, i) => [c.h, i]));

    this.period = period;
    this.nBuckets = period.count;
    this.alive = new Float64Array(this.nBuckets);
    this.written = new Float64Array(this.nBuckets);
    this.aliveAuthor = new Float64Array(people.length);

    this.tStart = tStart;
    this.tEnd = tEnd;
    for (let i = 0; i < samples; i++) this.sampleTimes.push(tStart + ((tEnd - tStart) * i) / (samples - 1));

    this.nAgeBins = Math.ceil((tEnd - tStart) / (AGE_BIN_DAYS * DAY)) + 2;
    this.commitStats = chain.map(() => ({ added: 0, removed: 0, removedAgeSum: 0, removedOld: 0, files: 0 }));

    this.modules = modules;
    this.modIndex = new Map(modules.map((m, i) => [m, i]));
    this.moduleOf = moduleOf;
    this.aliveMod = moduleOf ? new Float64Array(modules.length * this.nBuckets) : null;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Driving the replay
  // ───────────────────────────────────────────────────────────────────────

  async run(repo: string, { pathspecs = [], diffMergesFlag = ['--diff-merges=first-parent'], onProgress }: RunOptions = {}): Promise<void> {
    this.repo = repo;
    let ci = -1;
    let processed = 0;
    let inMerge = false;

    const parser = new PatchParser({
      onCommit: (hash) => {
        if (inMerge) this.finishMerge(ci);
        const idx = this.indexOf.get(hash);
        if (idx === undefined) throw new Error('Commit outside first-parent chain: ' + hash);
        ci = idx;
        const c = this.chain[ci];
        inMerge = c.parents.length > 1 && this.trackMoves;
        this.snapshotUntil(c.ct);
        if (c.ct > this.maxCt) this.maxCt = c.ct;
        if (onProgress && ++processed % 500 === 0) onProgress(processed, this.chain.length);
        // Inside merges we keep the text of lines, to recognise code that only moved.
        return inMerge;
      },
      onFile: (fd) => this.applyFile(ci, fd),
    });

    const args = ['log', '--first-parent', '--reverse', '-p', '-U0', '-M', '--root', '--no-color', '--no-ext-diff',
      '--no-textconv', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--inter-hunk-context=0',
      ...diffMergesFlag, '--format=%x01%H', 'HEAD', ...pathspecs];
    await gitStream(repo, args, (line) => parser.push(line));
    parser.end();
    if (inMerge) this.finishMerge(ci);
    this.finalSnapshot();
  }

  /** Apply one file's hunks for chain commit `ci`. */
  applyFile(ci: number, fd: FileDiff): void {
    const c = this.chain[ci];
    const ct = Math.max(c.ct, this.maxCt);
    const { oldPath, newPath } = fd;

    // Symlinks/submodules keep their mode through pure renames, which print no mode line.
    if (oldPath && this.specialPaths.has(oldPath) && (!fd.hunks.length || fd.renamed)) fd.special = true;
    if (oldPath && oldPath !== newPath) this.specialPaths.delete(oldPath);
    if (fd.special && newPath && !fd.deleted) this.specialPaths.add(newPath);
    else if (newPath) this.specialPaths.delete(newPath);
    const keepNew = !!newPath && !fd.special && this.keep(newPath);

    let arr = oldPath ? this.files.get(oldPath) : undefined;
    if (arr && oldPath && newPath && oldPath !== newPath && keepNew) {
      this.files.delete(oldPath);
      this.renames.push([c.ct, oldPath, newPath]);
      this.moveModuleTallies(arr, oldPath, newPath);
    }

    if (!keepNew || !newPath) {
      // Deleted, turned into a symlink/submodule, or moved out of scope: its lines die.
      if (arr && oldPath) {
        this.kill(arr, ct, oldPath, ci);
        this.files.delete(oldPath);
        if (fd.deleted && fd.hunks.length && fd.hunks[0].minus) {
          this.noteMergeHunk(oldPath, { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, minus: fd.hunks.flatMap((h) => h.minus!), plus: [] }, arr, []);
        }
      }
      return;
    }

    this.commitStats[ci].files++;

    if (fd.binary) {
      // git printed "Binary files differ": either side may be binary, or the file is
      // marked -diff/binary in .gitattributes. If both sides are really text, diff them
      // ourselves; otherwise re-seed the new version whole (or drop it if binary).
      const newSpec = fd.newOid || `${c.h}:${newPath}`;
      const oldSpec = fd.oldOid || (c.parents[0] && oldPath ? `${c.parents[0]}:${oldPath}` : null);
      const hunks = arr && oldSpec && !fd.isNew ? textHunks(this.repo, oldSpec, newSpec) : null;
      if (hunks) {
        fd.hunks = hunks;
      } else {
        if (arr) this.kill(arr, ct, newPath, ci);
        const n = this.blobLineCount(newSpec);
        if (n === null) { this.files.delete(newPath); return; }
        this.files.set(newPath, this.bornLines(ci, newPath, n));
        return;
      }
    }

    if (!arr && oldPath && !fd.isNew) {
      // A file we were not tracking (it came from an excluded path, or used to be binary):
      // seed it from the old blob so the hunks land on real lines.
      const n = this.blobLineCount(fd.oldOid || (c.parents[0] ? `${c.parents[0]}:${oldPath}` : null));
      arr = n ? this.bornLines(ci, newPath, n) : [];
    }
    if (!arr) arr = [];

    // Apply hunks bottom-up, so earlier positions stay valid.
    for (let k = fd.hunks.length - 1; k >= 0; k--) {
      const hunk = fd.hunks[k];
      const { oldStart, oldCount, newCount } = hunk;
      const idx = oldCount === 0 ? oldStart : oldStart - 1;
      if (idx + oldCount > arr.length) {
        // The diff refers to lines we never saw. Should not happen; recorded for `verify`.
        this.repairs++;
        if (this.repairLog.length < 20) this.repairLog.push({ commit: c.h, path: newPath, at: idx, need: oldCount, had: arr.length });
        while (arr.length < idx + oldCount) arr.push(-1);
      }
      const born = this.bornLines(ci, newPath, newCount);
      let removed: OriginId[];
      if (newCount <= 20000 && oldCount <= 20000) {
        removed = arr.splice(idx, oldCount, ...born);
      } else {
        // Spread arguments have limits; rebuild the array for huge hunks.
        removed = arr.slice(idx, idx + oldCount);
        arr = arr.slice(0, idx).concat(born, arr.slice(idx + oldCount));
      }
      if (removed.length) this.kill(removed, ct, newPath, ci);
      if (hunk.minus) this.noteMergeHunk(newPath, hunk, removed, born);
    }
    this.files.set(newPath, arr);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Births and deaths
  // ───────────────────────────────────────────────────────────────────────

  /** `n` new lines written by chain commit `ci` into `path`. */
  private bornLines(ci: number, path: string, n: number): OriginId[] {
    if (n <= 0) return [];
    const o = this.originFor(ci, path);
    this.tally(o, n, path);
    this.written[this.bucketOf(this.oAt[o])] += n;
    this.commitStats[ci].added += n;
    return new Array<OriginId>(n).fill(o);
  }

  /** Lines removed at time `ct` by chain commit `ci`. */
  private kill(origins: OriginId[], ct: Timestamp, path: string, ci: number): void {
    const st = this.commitStats[ci];
    const deaths = this.deathsFor(fileRole(path));
    for (const o of origins) {
      if (o < 0) continue;
      this.tally(o, -1, path);
      const age = Math.max(0, ct - this.oAt[o]);
      deaths[ageBin(age, this.nAgeBins)]++;
      st.removed++;
      st.removedAgeSum += age;
      if (age > 365 * DAY) st.removedOld++;
    }
  }

  newOrigin(at: Timestamp, author: PersonId, commitIdx: number, side: string | null = null): OriginId {
    const id = this.oAt.length;
    this.oAt.push(at);
    this.oAuthor.push(author);
    this.oCommit.push(commitIdx);
    this.oSide.push(side);
    return id;
  }

  /** Origin for lines added by chain commit `ci` to `path`. */
  private originFor(ci: number, path: string): OriginId {
    const c = this.chain[ci];
    if (c.parents.length <= 1) {
      if (this.curOriginCommit !== ci) {
        this.curOriginCommit = ci;
        this.curOrigin = this.newOrigin(c.at, c.author, ci);
      }
      return this.curOrigin;
    }
    // Merge: credit the side-branch commit that put the most lines into this file.
    // (mergeblame.ts later refines this line by line.)
    const key = ci + '\0' + path;
    let o = this.mergeOriginCache.get(key);
    if (o !== undefined) return o;
    let best: Commit | null = null;
    let bestAdd = -1;
    for (const s of this.sideCommits.get(c.h) || []) {
      if (s.parents.length > 1) continue;
      for (const f of s.files) {
        if (f.path === path && (f.add > bestAdd || (f.add === bestAdd && best && s.at > best.at))) { best = s; bestAdd = f.add; }
      }
    }
    o = best ? this.newOrigin(best.at, best.author, ci, best.h) : this.newOrigin(c.at, c.author, ci);
    this.mergeOriginCache.set(key, o);
    return o;
  }

  /** Lines of a blob, or null if it is missing or binary by git's own heuristic. */
  private blobLineCount(spec: string | null | undefined): number | null {
    if (!spec || /^0+$/.test(spec) || !this.repo) return null; // spec: an object id or `rev:path`
    const buf = readBlob(this.repo, spec);
    if (!buf || looksBinary(buf)) return null;
    return countLines(buf);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Tallies
  // ───────────────────────────────────────────────────────────────────────

  bucketOf(t: Timestamp): Bucket {
    const b = this.period.bucketOf(t);
    return b < 0 ? 0 : b >= this.nBuckets ? this.nBuckets - 1 : b;
  }

  private modIdx(path: string): number {
    if (!this.moduleOf) return -1;
    let i = this.modCache.get(path);
    if (i === undefined) {
      i = this.modIndex.get(this.moduleOf(path)) ?? -1;
      this.modCache.set(path, i);
    }
    return i;
  }

  /** Count `n` lines of origin `o` in or out of the running tallies. */
  private tally(o: OriginId, n: number, path: string): void {
    const b = this.bucketOf(this.oAt[o]);
    this.alive[b] += n;
    this.aliveAuthor[this.oAuthor[o]] += n;
    if (this.aliveMod) {
      const m = this.modIdx(path);
      if (m >= 0) this.aliveMod[m * this.nBuckets + b] += n;
    }
  }

  /** Lines moving between modules (by a rename) carry their tallies with them. */
  private moveModuleTallies(arr: OriginId[], from: string, to: string): void {
    const m0 = this.modIdx(from), m1 = this.modIdx(to);
    if (!this.aliveMod || m0 === m1) return;
    for (const o of arr) {
      if (o < 0) continue;
      const b = this.bucketOf(this.oAt[o]);
      if (m0 >= 0) this.aliveMod[m0 * this.nBuckets + b]--;
      if (m1 >= 0) this.aliveMod[m1 * this.nBuckets + b]++;
    }
  }

  /** Re-credit one line in place, keeping every running tally consistent. */
  recredit(arr: OriginId[], i: number, o: OriginId, path: string): void {
    const old = arr[i];
    if (old === o) return;
    if (old >= 0) { this.tally(old, -1, path); this.written[this.bucketOf(this.oAt[old])]--; }
    this.tally(o, +1, path);
    this.written[this.bucketOf(this.oAt[o])]++;
    arr[i] = o;
  }

  private deathsFor(role: Role): Float64Array {
    let d = this.deaths.get(role);
    if (!d) { d = new Float64Array(this.nAgeBins); this.deaths.set(role, d); }
    return d;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Snapshots
  // ───────────────────────────────────────────────────────────────────────

  private snapshotUntil(ct: Timestamp): void {
    // The last sample is reserved for the state at HEAD (see finalSnapshot).
    while (this.nextSample < this.sampleTimes.length - 1 && this.sampleTimes[this.nextSample] <= ct) {
      this.snapshots.push(this.takeSnapshot(this.sampleTimes[this.nextSample], this.nextSample % 2 === 0));
      this.nextSample++;
    }
  }

  /** The state after the last commit (and after merge refinement), always with modules. */
  finalSnapshot(): void {
    this.snapshotUntil(Infinity);
    if (this.snapshots.length && this.snapshots[this.snapshots.length - 1].final) this.snapshots.pop();
    const snap = this.takeSnapshot(this.sampleTimes[this.sampleTimes.length - 1], true);
    snap.final = true;
    this.snapshots.push(snap);
  }

  private takeSnapshot(t: Timestamp, withMods: boolean): Snapshot {
    let total = 0;
    for (const x of this.alive) total += x;
    const cut = Math.max(1, total * 0.003);
    const authors: [PersonId, number][] = [];
    this.aliveAuthor.forEach((n, id) => { if (n >= cut) authors.push([id, Math.round(n)]); });
    const snap: Snapshot = { t, counts: Array.from(this.alive), authors };
    if (this.aliveMod && withMods) snap.mods = Array.from(this.aliveMod, Math.round);
    return snap;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Moves inside merges
  // ───────────────────────────────────────────────────────────────────────
  // A merge diff (against the first parent) often deletes a file and re-adds the same
  // text elsewhere: the side branch moved it. git blame follows such moves through the
  // side branch, so we keep the original author and date for text that merely moved.

  private noteMergeHunk(path: string, hunk: Hunk, removed: OriginId[], born: OriginId[]): void {
    const minus = hunk.minus!, plus = hunk.plus!;
    const role = fileRole(path);
    for (let j = 0; j < removed.length && j < minus.length; j++) {
      const o = removed[j];
      if (o < 0 || minus[j].trim().length < MOVE_MIN) continue;
      let l = this.mergeRemoved.get(minus[j]);
      if (!l) this.mergeRemoved.set(minus[j], (l = []));
      l.push([o, role]);
    }
    if (born.length && plus.length === born.length) this.mergeBorn.push([path, hunk.newStart - 1, plus, born[0]]);
  }

  /** Called when a merge commit is complete: match added text against removed text. */
  private finishMerge(ci: number): void {
    const removedByText = this.mergeRemoved;
    const bornRuns = this.mergeBorn;
    this.mergeBorn = [];
    this.mergeRemoved = new Map();
    if (!bornRuns.length || !removedByText.size) return;

    const remap = new Map<OriginId, OriginId>(); // old origin -> origin credited at this merge
    for (const [path, start, plus, bornO] of bornRuns) {
      const arr = this.files.get(path);
      if (!arr) continue;
      for (let j = 0; j < plus.length; j++) {
        if (plus[j].trim().length < MOVE_MIN) continue;
        const l = removedByText.get(plus[j]);
        if (!l || !l.length || arr[start + j] !== bornO) continue;
        const [old, role] = l.pop()!;

        // It was counted as a death when the merge removed it: take that back.
        const age = Math.max(0, this.maxCt - this.oAt[old]);
        this.deathsFor(role)[ageBin(age, this.nAgeBins)]--;
        const st = this.commitStats[ci];
        st.removed--;
        st.removedAgeSum -= age;
        st.added--;
        if (age > 365 * DAY) st.removedOld--;

        let no = remap.get(old);
        if (no === undefined) {
          no = this.newOrigin(this.oAt[old], this.oAuthor[old], ci, this.oSide[old] ?? this.chain[this.oCommit[old]].h);
          this.moved.add(no);
          remap.set(old, no);
        }
        arr[start + j] = no;
        this.tally(bornO, -1, path);
        this.written[this.bucketOf(this.oAt[bornO])]--;
        this.tally(no, +1, path);
        this.movedLines++;
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Survival
  // ───────────────────────────────────────────────────────────────────────

  /** Kaplan–Meier survival curve for lines (optionally of a single role). */
  survival(role: Role | null = null, tEnd: Timestamp = this.tEnd): KaplanMeier {
    const nb = this.nAgeBins;
    const deaths = new Float64Array(nb);
    const censored = new Float64Array(nb);
    const roles = role ? [role] : [...this.deaths.keys()];
    for (const r of roles) {
      const d = this.deaths.get(r);
      if (d) for (let i = 0; i < nb; i++) deaths[i] += d[i];
    }
    // Lines alive at HEAD are censored at their current age.
    for (const [path, arr] of this.files) {
      if (role && fileRole(path) !== role) continue;
      for (const o of arr) {
        if (o < 0) continue;
        censored[ageBin(Math.max(0, tEnd - this.oAt[o]), nb)]++;
      }
    }
    return kaplanMeier(deaths, censored);
  }
}
