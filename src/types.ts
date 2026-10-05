// Shared types. Everything Strata produces ends up in one `Survey` object: the CLI
// prints it, `--json` saves it, and the HTML report embeds it.

/** Unix time in seconds. */
export type Timestamp = number;
/** Index into `Survey.people` (and into the people array of the commit graph). */
export type PersonId = number;
/** Index into the replay's origin table: who wrote a line, and when. */
export type OriginId = number;
/** Index into the strata (one stratum per year, quarter or month). */
export type Bucket = number;

export type Lang = 'en' | 'ru';
export type Role = 'source' | 'tests' | 'docs' | 'config & tooling';

/** Progress callback used by every long-running step. */
export type Logger = (message: string) => void;

// ── Commit graph (pass 1) ─────────────────────────────────────────────

export interface FileChange {
  path: string;
  /** Previous path when git detected a rename. */
  from: string | null;
  add: number;
  del: number;
  binary: boolean;
}

export interface Commit {
  h: string;
  parents: string[];
  /** Author time. */
  at: Timestamp;
  /** Committer time. */
  ct: Timestamp;
  /** Author name and email, after .mailmap. */
  an: string;
  ae: string;
  subject: string;
  files: FileChange[];
  author: PersonId;
}

export interface Person {
  id: PersonId;
  name: string;
  names: string[];
  emails: string[];
  commits: number;
  first: Timestamp;
  last: Timestamp;
  added: number;
  deleted: number;
  bot: boolean;
}

// ── Survey (the result) ───────────────────────────────────────────────

export interface SurveyOptions {
  exclude?: string[];
  include?: string[];
  noDefaultExcludes?: boolean;
  name?: string;
  /** Skip the content pass that credits merged lines to side-branch authors. */
  noMergeRefine?: boolean;
  samples?: number;
  minShared?: number;
  log?: Logger;
}

export interface RepairNote { commit: string; path: string; at: number; need: number; had: number }

export interface Diagnostics {
  mergeLinesMoved: number;
  mergeLinesRefined: number;
  sideCommitsRead: number;
  repairs: number;
  repairLog: RepairNote[];
  unknownLines: number;
  headMismatchFiles: number;
  headMismatchLines: number;
  durationMs: number;
  gitVersion: string;
}

export interface SurveyMeta {
  name: string;
  remote: string;
  head: string;
  branch: string;
  generatedAt: Timestamp;
  shallow: boolean;
  tStart: Timestamp;
  tEnd: Timestamp;
  /** Non-merge commits. */
  commits: number;
  merges: number;
  firstParent: number;
  files: number;
  lines: number;
  people: number;
  bots: number;
  modules: number;
  /** Hotspots use the last 12 months (true) or the whole history (false). */
  useRecent: boolean;
  ageBinDays: number;
  orphanShare: number;
  busFactor: number;
  excludes: string[];
  excludedChurnShare: number;
  diagnostics: Diagnostics;
}

export interface StrataSample {
  t: Timestamp;
  /** Living lines per stratum. */
  c: number[];
  /** Living lines per author (only authors above 0.3% of the total). */
  a: [PersonId, number][];
}

export interface ModuleStrata {
  /** Which entries of `samples` these series belong to. */
  sampleIdx: number[];
  names: string[];
  /** data[module][sample][stratum] */
  data: number[][][];
}

export interface Strata {
  unit: 'year' | 'quarter' | 'month';
  labels: string[];
  starts: Timestamp[];
  samples: StrataSample[];
  modules: ModuleStrata | null;
  written: number[];
  alive: number[];
  /** Top authors of the surviving lines in each stratum. */
  authors: [PersonId, number][][];
}

export interface SurvivalCurve {
  total: number;
  medianDays: number | null;
  /** [age in days, share still alive] */
  points: [number, number][];
}

export interface Survival {
  overall: SurvivalCurve;
  byRole: Partial<Record<Role, SurvivalCurve>>;
}

/** [partner path, shared commits, share of this file's commits] */
export type Partner = [string, number, number];

export interface FileReport {
  path: string;
  loc: number;
  /** Indentation complexity: total and deepest level. */
  cx: number;
  cxMax: number;
  revs: number;
  recent: number;
  churn: number;
  recentChurn: number;
  nAuthors: number;
  last: Timestamp;
  born: Timestamp;
  medianAt: Timestamp;
  p10At: Timestamp;
  /** [stratum, lines] runs, oldest first. */
  core: [Bucket, number][];
  /** Top owners: [person, lines]. */
  owners: [PersonId, number][];
  ownerShare: number;
  orphan: number;
  role: Role;
  ext: string;
  module: string;
  hot?: number;
  cpl?: Partner[];
}

export interface Hotspot {
  path: string;
  hot: number;
  revs: number;
  cx: number;
  loc: number;
  owner: PersonId;
  ownerShare: number;
}

export interface CouplingPair {
  a: string;
  b: string;
  shared: number;
  degree: number;
  revsA: number;
  revsB: number;
  crossModule: boolean;
}

export interface ModuleLink { a: string; b: string; shared: number; degree: number }

export interface CouplingReport {
  commitsUsed: number;
  maxFiles: number;
  pairs: CouplingPair[];
  codePairs: CouplingPair[];
  modules: { module: string; revs: number }[];
  moduleLinks: ModuleLink[];
}

export interface ModuleReport {
  module: string;
  files: number;
  loc: number;
  revs: number;
  recent: number;
  busFactor: number;
  /** [person, share of the module's lines] */
  owners: [PersonId, number][];
  orphan: number;
  meanAgeDays: number;
}

export interface PersonReport {
  id: PersonId;
  name: string;
  commits: number;
  first: Timestamp;
  last: Timestamp;
  bot: boolean;
  added: number;
  deleted: number;
  /** Lines this person wrote that are alive at HEAD. */
  lines: number;
}

export interface Fossil { path: string; line: number; at: Timestamp; author: PersonId; text: string }

export interface CommitEvent {
  h: string;
  subject: string;
  author: PersonId;
  t: Timestamp;
  added: number;
  removed: number;
  removedOld: number;
  meanAgeDays: number;
  merge: boolean;
}

export interface Pulse {
  weekStart: Timestamp;
  weekly: number[];
  /** [year * 12 + month, active people] */
  monthly: [number, number][];
}

/** A finding, rendered to text by `i18n.ts` in either language. */
export interface Fact { k: string; v: Record<string, any> }

export interface Survey {
  version: 1;
  meta: SurveyMeta;
  strata: Strata;
  survival: Survival;
  files: FileReport[];
  hotspots: Hotspot[];
  coupling: CouplingReport;
  modules: ModuleReport[];
  people: PersonReport[];
  fossils: Fossil[];
  extinctions: CommitEvent[];
  bigBangs: CommitEvent[];
  pulse: Pulse;
  languages: [string, number][];
  narrative: Fact[];
  /** Initial language of the HTML report. */
  lang?: Lang;
}
