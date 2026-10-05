// Orchestrator: runs both git passes, the HEAD scan and every analysis,
// and returns one plain JSON `Survey` that the report and the CLI render.

import { basename, resolve } from 'node:path';
import { gitText, gitVersion } from './git.ts';
import { readHistory, firstParentChain, type History } from './history.ts';
import { Replay, AGE_BIN_DAYS } from './replay.ts';
import { makePeriod, type Period } from './period.ts';
import { makePathFilter, DEFAULT_EXCLUDES, excludePathspecs, fileRole, extOf, globToRegExp, type PathFilter } from './filters.ts';
import { PathResolver, buildModules, type ModuleOf } from './paths.ts';
import { listHeadBlobs, scanHead } from './headscan.ts';
import { MergeNeeds, refineMergeLines } from './mergeblame.ts';
import { analyzeCoupling } from './coupling.ts';
import { writeNarrative } from './narrative.ts';
import type {
  Commit, CommitEvent, FileReport, Hotspot, Logger, ModuleReport, ModuleStrata, Person, PersonId, PersonReport,
  Pulse, Role, Strata, Survey, SurveyOptions, Survival, SurvivalCurve, Timestamp,
} from './types.ts';

const DAY = 86400;
const YEAR = 365.25 * DAY;

/** Everything pass 1 and pass 2 produce. Shared by `survey` and `verify`. */
export interface Prepared {
  t0: number;
  log: Logger;
  repo: string;
  head: string;
  branch: string;
  remote: string;
  name: string;
  shallow: boolean;
  excludes: readonly string[];
  keep: PathFilter;
  pathspecs: string[];
  H: History;
  chain: Commit[];
  people: Person[];
  tStart: Timestamp;
  tEnd: Timestamp;
  period: Period;
  R: Replay;
  gitVersion: [number, number];
  moduleOf: ModuleOf;
}

/** Pass 1 + pass 2: commit graph and line replay. */
export async function prepare(repoPath: string, opts: SurveyOptions = {}): Promise<Prepared> {
  const t0 = Date.now();
  const log = opts.log || (() => {});
  // Always work from the top of the work tree, whatever folder we were pointed at.
  const repo = gitText(resolve(repoPath), ['rev-parse', '--show-toplevel']).trim();
  const head = gitText(repo, ['rev-parse', 'HEAD']).trim();
  const optional = (args: string[]): string => { try { return gitText(repo, args).trim(); } catch { return ''; } };
  const branch = optional(['rev-parse', '--abbrev-ref', 'HEAD']);
  const remote = optional(['config', '--get', 'remote.origin.url']);
  const shallow = optional(['rev-parse', '--is-shallow-repository']) === 'true';
  const name = opts.name || basename(repo) || 'repository';

  const excludes = opts.noDefaultExcludes ? [] : DEFAULT_EXCLUDES;
  const keep = makePathFilter({ excludes, extraExcludes: opts.exclude || [], includes: opts.include || [] });

  // ── Pass 1: commit graph ──────────────────────────────────────────────
  log('Reading commit graph…');
  const H = await readHistory(repo, { keep, onProgress: (n) => log(`  ${n} commits`) });
  if (!H.commits.length) throw new Error('No commits found.');
  // Only when excluded files carry a lot of churn (big lockfiles, vendored trees) is it
  // worth asking git to skip them in the expensive diff pass, and then only with the
  // patterns that actually occur in this history.
  const allExcludes = [...excludes, ...(opts.exclude || [])];
  const used = allExcludes.filter((g) => { const re = globToRegExp(g); for (const p of H.excluded.paths) if (re.test(p)) return true; return false; });
  const heavy = H.excluded.churn > 0.15 * (H.excluded.churn + H.excluded.keptChurn);
  const pathspecs = heavy && used.length ? excludePathspecs(used) : [];
  const { chain, sideCommits } = firstParentChain(H.byHash, head);

  let tStart = Infinity, tEnd = -Infinity;
  for (const c of chain) { tStart = Math.min(tStart, c.at, c.ct); tEnd = Math.max(tEnd, c.at, c.ct); }
  // A commit with a clock far in the future would stretch the timeline into emptiness.
  tEnd = Math.min(tEnd, Math.max(tStart + DAY, Date.now() / 1000 + DAY));
  if (tEnd - tStart < DAY) tEnd = tStart + DAY; // a one-day minimum keeps the axes sane
  const period = makePeriod(tStart, tEnd);

  // ── Pass 2: line replay ───────────────────────────────────────────────
  log(`Replaying first-parent history line by line (${chain.length} commits)…`);
  const version = gitVersion();
  const [maj, min] = version;
  const diffMergesFlag = maj > 2 || (maj === 2 && min >= 31) ? ['--diff-merges=first-parent'] : ['-m'];
  // Module boundaries come from the tree at HEAD (needed during the replay).
  const headPaths = gitText(repo, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD']).split('\0').filter((p) => p && keep(p));
  const moduleOf = buildModules(headPaths);
  const R = new Replay({ chain, sideCommits, people: H.people, keep, period, tStart, tEnd, samples: opts.samples || 320, moduleOf, modules: moduleOf.list });
  await R.run(repo, { pathspecs, diffMergesFlag, onProgress: (n, total) => log(`  ${n}/${total} commits`) });

  return { t0, log, repo, head, branch, remote, name, shallow, excludes, keep, pathspecs, H, chain, people: H.people, tStart, tEnd, period, R, gitVersion: version, moduleOf };
}

/** Survey a repository: the whole pipeline, returning one JSON-serialisable object. */
export async function survey(repoPath: string, opts: SurveyOptions = {}): Promise<Survey> {
  const P = await prepare(repoPath, opts);
  const { t0, log, repo, keep, H, chain, people, tEnd, period, R, moduleOf } = P;

  // ── HEAD scan and merge refinement ────────────────────────────────────
  log('Scanning HEAD…');
  const blobs = listHeadBlobs(repo, keep);
  const mergeNeeds = new MergeNeeds();
  const scan = await scanHead(repo, blobs, R, { mergeNeeds });
  let refined = { lines: 0, commits: 0 };
  if (mergeNeeds.size && !opts.noMergeRefine) {
    log('Crediting merged lines to their side-branch authors…');
    refined = await refineMergeLines(repo, R, H.byHash, mergeNeeds, { onProgress: (n, t) => log(`  ${n}/${t} commits`) });
  }
  R.finalSnapshot(); // the HEAD sample reflects re-credited lines

  // ── Per-file state at HEAD ────────────────────────────────────────────
  const resolver = new PathResolver([
    ...H.commits.flatMap((c) => c.files.filter((f) => f.from).map((f): [Timestamp, string, string] => [c.ct, f.from!, f.path])),
    ...R.renames,
  ]);
  const headSet = new Set<string>();
  for (const b of blobs) { const s = scan.stats.get(b.path); if (s && !s.binary) headSet.add(b.path); }

  const fileRevs = countRevisions(H.commits, resolver, headSet, tEnd - YEAR);
  const nb = period.count;
  const stratumAuthors = Array.from({ length: nb }, () => new Map<PersonId, number>());
  const inactiveCut = tEnd - YEAR;
  const files: FileReport[] = [];
  let totalLines = 0, orphanLines = 0, unknownLines = 0;
  const ownerTotals = new Map<PersonId, number>();

  for (const path of [...headSet].sort()) {
    const arr = R.files.get(path) || [];
    const st = scan.stats.get(path);
    const owners = new Map<PersonId, number>();
    const ats: Timestamp[] = [];
    let orphan = 0;
    for (const o of arr) {
      if (o < 0) { unknownLines++; continue; }
      const a = R.oAuthor[o];
      const at = R.oAt[o];
      owners.set(a, (owners.get(a) || 0) + 1);
      ownerTotals.set(a, (ownerTotals.get(a) || 0) + 1);
      ats.push(at);
      const sa = stratumAuthors[R.bucketOf(at)];
      sa.set(a, (sa.get(a) || 0) + 1);
      if (people[a].last < inactiveCut) orphan++;
    }
    totalLines += arr.length;
    orphanLines += orphan;
    ats.sort((x, y) => x - y);
    const ownerList = [...owners.entries()].sort((x, y) => y[1] - x[1]);
    const rv = fileRevs.get(path) || emptyRevs();
    files.push({
      path,
      loc: st ? st.loc : arr.length,
      cx: st ? st.cx : 0,
      cxMax: st ? st.cxMax : 0,
      revs: rv.revs,
      recent: rv.recent,
      churn: rv.churn,
      recentChurn: rv.recentChurn,
      nAuthors: rv.authors.size,
      last: rv.lastT,
      born: ats.length ? ats[0] : rv.firstT === Infinity ? 0 : rv.firstT,
      medianAt: ats.length ? ats[ats.length >> 1] : 0,
      p10At: ats.length ? ats[Math.floor(ats.length * 0.1)] : 0,
      core: coreSample(ats, R),
      owners: ownerList.slice(0, 4),
      ownerShare: arr.length && ownerList.length ? ownerList[0][1] / arr.length : 0,
      orphan: arr.length ? orphan / arr.length : 0,
      role: fileRole(path),
      ext: extOf(path),
      module: moduleOf(path),
    });
  }

  // ── Hotspots: change frequency × complexity ───────────────────────────
  const useRecent = files.reduce((s, f) => s + f.recent, 0) >= Math.max(20, files.length * 0.05);
  const hotspots = scoreHotspots(files, useRecent);

  // ── Temporal coupling ─────────────────────────────────────────────────
  log('Measuring temporal coupling…');
  const isCode = (p: string): boolean => { const r = fileRole(p); return r === 'source' || r === 'tests'; };
  const { partners, ...coupling } = analyzeCoupling(H.commits, {
    resolver, isCode, moduleOf, minShared: opts.minShared || 5,
    headSet: new Set(files.filter((f) => f.role !== 'docs').map((f) => f.path)),
  });
  for (const f of files) { const l = partners.get(f.path); if (l) f.cpl = l; }

  // ── Knowledge & bus factor ────────────────────────────────────────────
  const modules = summarizeModules(files, R, people, tEnd);
  const repoBus = busFactor(ownerTotals, [...ownerTotals.values()].reduce((s, n) => s + n, 0), people);

  // ── Survival / half-life ──────────────────────────────────────────────
  const survival = summarizeSurvival(R);

  // ── Strata ────────────────────────────────────────────────────────────
  const strata: Strata = {
    unit: period.unit,
    labels: Array.from({ length: nb }, (_, i) => period.label(i)),
    starts: Array.from({ length: nb }, (_, i) => period.startOf(i)),
    samples: R.snapshots.map((s) => ({ t: Math.round(s.t), c: s.counts.map((x) => Math.max(0, Math.round(x))), a: s.authors })),
    modules: moduleStrata(R, nb, totalLines),
    written: Array.from(R.written, Math.round),
    alive: Array.from(R.alive, (x) => Math.max(0, Math.round(x))),
    authors: stratumAuthors.map((m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)),
  };

  // ── Events: extinctions and big bangs ─────────────────────────────────
  const { extinctions, bigBangs } = commitEvents(chain, R);

  // ── Pulse, people, languages ──────────────────────────────────────────
  const pulse = activityPulse(H.commits, people, P.tStart, tEnd);
  const peopleOut: PersonReport[] = people.map((p) => ({
    id: p.id, name: p.name, commits: p.commits, first: p.first, last: p.last, bot: p.bot,
    added: p.added, deleted: p.deleted, lines: ownerTotals.get(p.id) || 0,
  }));
  const langs = new Map<string, number>();
  for (const f of files) langs.set(f.ext, (langs.get(f.ext) || 0) + f.loc);
  const languages = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  const nonMerge = H.commits.filter((c) => c.parents.length <= 1).length;
  const [maj, min] = P.gitVersion;
  const model: Omit<Survey, 'narrative'> = {
    version: 1,
    meta: {
      name: P.name, remote: redactRemote(P.remote), head: P.head, branch: P.branch, generatedAt: Math.floor(Date.now() / 1000),
      shallow: P.shallow, tStart: P.tStart, tEnd, commits: nonMerge, merges: H.commits.length - nonMerge, firstParent: chain.length,
      files: files.length, lines: totalLines, people: people.filter((p) => !p.bot).length, bots: people.filter((p) => p.bot).length,
      modules: moduleOf.list.length, useRecent, ageBinDays: AGE_BIN_DAYS,
      orphanShare: totalLines ? orphanLines / totalLines : 0, busFactor: repoBus,
      excludes: [...P.excludes, ...(opts.exclude || [])],
      excludedChurnShare: H.excluded.churn / Math.max(1, H.excluded.churn + H.excluded.keptChurn),
      diagnostics: {
        mergeLinesMoved: R.movedLines, mergeLinesRefined: refined.lines, sideCommitsRead: refined.commits,
        repairs: R.repairs, repairLog: R.repairLog.slice(0, 5), unknownLines,
        headMismatchFiles: scan.mismatched, headMismatchLines: scan.mismatchedLines,
        durationMs: 0, gitVersion: `${maj}.${min}`,
      },
    },
    strata, survival, files, hotspots, coupling, modules, people: peopleOut,
    fossils: scan.fossils, extinctions, bigBangs, pulse, languages,
  };
  const result: Survey = { ...model, narrative: writeNarrative(model) };
  result.meta.diagnostics.durationMs = Date.now() - t0;
  log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────

interface Revisions {
  revs: number;
  recent: number;
  churn: number;
  recentChurn: number;
  authors: Set<PersonId>;
  lastT: Timestamp;
  firstT: Timestamp;
}

const emptyRevs = (): Revisions => ({ revs: 0, recent: 0, churn: 0, recentChurn: 0, authors: new Set(), lastT: 0, firstT: Infinity });

/** How often each file at HEAD changed (following renames), overall and recently. */
function countRevisions(commits: Commit[], resolver: PathResolver, headSet: Set<string>, recentFrom: Timestamp): Map<string, Revisions> {
  const fileRevs = new Map<string, Revisions>();
  for (const c of commits) {
    if (c.parents.length > 1) continue;
    const seen = new Set<string>();
    for (const f of c.files) {
      const p = resolver.resolve(f.path, c.ct);
      if (!headSet.has(p) || seen.has(p)) continue;
      seen.add(p);
      let r = fileRevs.get(p);
      if (!r) fileRevs.set(p, (r = emptyRevs()));
      r.revs++;
      r.churn += f.add + f.del;
      r.authors.add(c.author);
      if (c.ct > r.lastT) r.lastT = c.ct;
      if (c.at < r.firstT) r.firstT = c.at;
      if (c.ct >= recentFrom) { r.recent++; r.recentChurn += f.add + f.del; }
    }
  }
  return fileRevs;
}

/** Log-scaled frequency × complexity; source and test files only. */
function scoreHotspots(files: FileReport[], useRecent: boolean): Hotspot[] {
  const freq = (f: FileReport): number => (useRecent ? f.recent : f.revs);
  const maxF = files.reduce((m, f) => Math.max(m, freq(f)), 1);
  const maxC = files.reduce((m, f) => Math.max(m, f.cx), 1);
  for (const f of files) {
    f.hot = +((Math.log1p(freq(f)) / Math.log1p(maxF)) * (Math.log1p(f.cx) / Math.log1p(maxC))).toFixed(4);
  }
  return files
    .filter((f) => (f.role === 'source' || f.role === 'tests') && freq(f) > 0 && f.cx > 0)
    .sort((a, b) => b.hot! - a.hot!)
    .slice(0, 25)
    .map((f) => ({ path: f.path, hot: f.hot!, revs: freq(f), cx: f.cx, loc: f.loc, owner: f.owners[0]?.[0] ?? -1, ownerShare: f.ownerShare }));
}

/** The smallest number of (human) people who together own more than half of the lines. */
function busFactor(owned: Map<PersonId, number>, total: number, people: Person[]): number {
  const shares = [...owned.entries()].filter(([a]) => !people[a].bot).map(([, n]) => n).sort((a, b) => b - a);
  let acc = 0, k = 0;
  for (const n of shares) { acc += n; k++; if (acc > total * 0.5) break; }
  return k;
}

function summarizeModules(files: FileReport[], R: Replay, people: Person[], tEnd: Timestamp): ModuleReport[] {
  interface Acc { module: string; files: number; loc: number; owners: Map<PersonId, number>; orphan: number; revs: number; recent: number; ageSum: number; ageN: number }
  const modules = new Map<string, Acc>();
  for (const f of files) {
    let m = modules.get(f.module);
    if (!m) modules.set(f.module, (m = { module: f.module, files: 0, loc: 0, owners: new Map(), orphan: 0, revs: 0, recent: 0, ageSum: 0, ageN: 0 }));
    m.files++;
    m.loc += f.loc;
    m.revs += f.revs;
    m.recent += f.recent;
    m.orphan += f.orphan * f.loc;
    if (f.medianAt) { m.ageSum += (tEnd - f.medianAt) * f.loc; m.ageN += f.loc; }
    for (const o of R.files.get(f.path) || []) {
      if (o < 0) continue;
      const a = R.oAuthor[o];
      m.owners.set(a, (m.owners.get(a) || 0) + 1);
    }
  }
  return [...modules.values()].map((m): ModuleReport => {
    const owned = [...m.owners.values()].reduce((s, n) => s + n, 0);
    return {
      module: m.module, files: m.files, loc: m.loc, revs: m.revs, recent: m.recent,
      busFactor: busFactor(m.owners, owned, people),
      owners: [...m.owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => [a, n / Math.max(1, owned)]),
      orphan: m.loc ? m.orphan / m.loc : 0,
      meanAgeDays: m.ageN ? m.ageSum / m.ageN / DAY : 0,
    };
  }).sort((a, b) => b.loc - a.loc);
}

function summarizeSurvival(R: Replay): Survival {
  const curve = (role: Role | null): SurvivalCurve => {
    const r = R.survival(role);
    // Down-sample to about 260 points.
    const step = Math.max(1, Math.ceil(r.curve.length / 260));
    const points: [number, number][] = [];
    for (let i = 0; i < r.curve.length; i += step) points.push([(i + 1) * AGE_BIN_DAYS, +r.curve[i].toFixed(5)]);
    return { total: r.total, medianDays: r.median === null ? null : r.median * AGE_BIN_DAYS, points };
  };
  const survival: Survival = { overall: curve(null), byRole: {} };
  for (const role of R.deaths.keys()) {
    const s = curve(role);
    if (s.total > 500) survival.byRole[role] = s;
  }
  return survival;
}

function commitEvents(chain: Commit[], R: Replay): { extinctions: CommitEvent[]; bigBangs: CommitEvent[] } {
  const events = chain.map((c, i) => ({ c, s: R.commitStats[i] })).filter((e) => e.c.parents.length <= 1);
  const toEvent = ({ c, s }: (typeof events)[number]): CommitEvent => ({
    h: c.h, subject: c.subject.slice(0, 140), author: c.author, t: c.ct,
    added: s.added, removed: s.removed, removedOld: s.removedOld,
    meanAgeDays: s.removed ? s.removedAgeSum / s.removed / DAY : 0, merge: c.parents.length > 1,
  });
  return {
    extinctions: events.filter((e) => e.s.removedOld > 0).sort((a, b) => b.s.removedOld - a.s.removedOld).slice(0, 10).map(toEvent),
    bigBangs: events.filter((e) => e.s.added > 0).sort((a, b) => b.s.added - a.s.added).slice(0, 10).map(toEvent),
  };
}

/** Weekly commits and monthly active (human) people. */
function activityPulse(commits: Commit[], people: Person[], tStart: Timestamp, tEnd: Timestamp): Pulse {
  const WEEK = 7 * DAY;
  const nWeeks = Math.max(1, Math.ceil((tEnd - tStart) / WEEK) + 1);
  const weekly = new Array<number>(nWeeks).fill(0);
  const monthlyPeople = new Map<number, Set<PersonId>>();
  for (const c of commits) {
    if (c.parents.length > 1) continue;
    const w = Math.floor((c.at - tStart) / WEEK);
    if (w >= 0 && w < nWeeks) weekly[w]++;
    if (people[c.author].bot) continue;
    const d = new Date(c.at * 1000);
    const k = d.getUTCFullYear() * 12 + d.getUTCMonth();
    let s = monthlyPeople.get(k);
    if (!s) monthlyPeople.set(k, (s = new Set()));
    s.add(c.author);
  }
  const months = [...monthlyPeople.keys()].sort((a, b) => a - b);
  const monthly: [number, number][] = [];
  if (months.length) for (let k = months[0]; k <= months[months.length - 1]; k++) monthly.push([k, monthlyPeople.get(k)?.size || 0]);
  return { weekStart: tStart, weekly, monthly };
}

/** A file's "core sample": how many of its lines belong to each stratum, oldest first. */
function coreSample(sortedAts: Timestamp[], R: Replay): [number, number][] {
  const out: [number, number][] = [];
  for (const at of sortedAts) {
    const b = R.bucketOf(at);
    if (out.length && out[out.length - 1][0] === b) out[out.length - 1][1]++;
    else out.push([b, 1]);
  }
  return out;
}

/** Stratigraphy per module (every other snapshot), for modules holding ≥ 1% of the code. */
function moduleStrata(R: Replay, nb: number, totalLines: number): ModuleStrata | null {
  const snaps = R.snapshots.map((s, i) => [i, s] as const).filter(([, s]) => s.mods);
  if (!snaps.length) return null;
  const last = snaps[snaps.length - 1][1].mods!;
  const out: ModuleStrata = { sampleIdx: snaps.map(([i]) => i), names: [], data: [] };
  R.modules.forEach((name, m) => {
    let alive = 0;
    for (let b = 0; b < nb; b++) alive += last[m * nb + b];
    if (alive < Math.max(1, totalLines * 0.01)) return;
    out.names.push(name);
    out.data.push(snaps.map(([, s]) => s.mods!.slice(m * nb, (m + 1) * nb).map((x) => Math.max(0, x))));
  });
  return out;
}

/** Never leak credentials embedded in a remote URL. */
function redactRemote(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//');
}
