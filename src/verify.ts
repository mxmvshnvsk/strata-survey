// `strata verify`: check the replay engine against git itself.
//
// 1. Every text file at HEAD must have exactly as many replayed lines as it really has.
// 2. For a sample of files, the commit credited for every line must match
//    `git blame --first-parent` (the replay walks exactly that history).
// 3. The author credited for every line is compared with plain `git blame`, which
//    follows merges into side branches; this measures the merge attribution.

import { spawn } from 'node:child_process';
import { prepare } from './analyze.ts';
import { listHeadBlobs, scanHead } from './headscan.ts';
import { MergeNeeds, refineMergeLines } from './mergeblame.ts';
import type { SurveyOptions } from './types.ts';

interface BlameLines {
  /** Commit hash per line. */
  commits: string[];
  /** Author email per line. */
  mails: string[];
}

function blame(repo: string, path: string, firstParent: boolean): Promise<BlameLines | null> {
  return new Promise((resolve) => {
    const args = ['-C', repo, '-c', 'blame.ignoreRevsFile=', '-c', 'blame.markIgnoredLines=false', 'blame', '--line-porcelain'];
    if (firstParent) args.push('--first-parent');
    args.push('HEAD', '--', path);
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { out += c; });
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const commits: string[] = [];
      const mails: string[] = [];
      let cur = -1;
      for (const l of out.split('\n')) {
        const m = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(l);
        if (m) { cur = Number(m[2]) - 1; commits[cur] = m[1]; continue; }
        if (l.startsWith('author-mail ') && cur >= 0) mails[cur] = l.slice(13, -1).toLowerCase();
      }
      resolve({ commits, mails });
    });
  });
}

export interface VerifyOptions extends SurveyOptions {
  /** How many files to blame. */
  files?: number;
  seed?: number;
  concurrency?: number;
}

export interface VerifyResult {
  files: number;
  lines: number;
  agree: number;
  /** Share of lines whose commit matches `git blame --first-parent`. */
  rate: number;
  /** Share of lines whose author matches plain `git blame`. */
  authorRate: number;
  /** The same, if merged lines were simply credited to whoever merged them. */
  naiveAuthorRate: number;
  worst: { path: string; agree: number; lines: number }[];
  repairs: number;
  headMismatchFiles: number;
  headMismatchLines: number;
  headFiles: number;
}

export async function verify(repoPath: string, { files: sampleSize = 60, seed = 1, concurrency = 4, ...opts }: VerifyOptions = {}): Promise<VerifyResult> {
  const log = opts.log || (() => {});
  const P = await prepare(repoPath, opts);
  const { R, chain, repo } = P;

  // A deterministic shuffle, so runs are reproducible.
  const paths = [...R.files.keys()].filter((p) => R.files.get(p)!.length > 0).sort();
  let x = seed >>> 0 || 1;
  const rnd = (): number => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = paths.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [paths[i], paths[j]] = [paths[j], paths[i]]; }
  const sample = sampleSize >= paths.length ? paths : paths.slice(0, sampleSize);

  // Same HEAD scan and merge refinement as `survey`, so we measure what the report shows.
  const mergeNeeds = new MergeNeeds();
  const scan = await scanHead(repo, listHeadBlobs(repo, P.keep), R, { mergeNeeds });
  if (!opts.noMergeRefine) await refineMergeLines(repo, R, P.H.byHash, mergeNeeds);

  log(`Blaming ${sample.length} files…`);
  let agree = 0, total = 0, done = 0, authorAgree = 0, authorTotal = 0, naiveAgree = 0;
  const emailsOf = P.people.map((p) => new Set(p.emails));
  const worst: VerifyResult['worst'] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sample.length) {
      const p = sample[next++];
      const b = await blame(repo, p, true);
      done++;
      if (!b) continue;
      const arr = R.files.get(p)!;
      const n = Math.max(arr.length, b.commits.length);
      let a = 0;
      for (let i = 0; i < n; i++) { const o = arr[i]; if (o !== undefined && o >= 0 && chain[R.oCommit[o]].h === b.commits[i]) a++; }
      agree += a;
      total += n;
      if (a < n) worst.push({ path: p, agree: a, lines: n });

      const full = await blame(repo, p, false);
      if (full) {
        for (let i = 0; i < full.commits.length; i++) {
          const o = arr[i];
          authorTotal++;
          if (o === undefined || o < 0) continue;
          if (emailsOf[R.oAuthor[o]].has(full.mails[i])) authorAgree++;
          // Baseline: credit merged lines to whoever made the merge commit.
          if (emailsOf[chain[R.oCommit[o]].author].has(full.mails[i])) naiveAgree++;
        }
      }
      if (done % 10 === 0) log(`  ${done}/${sample.length}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (total === 0 && sample.length) throw new Error('git blame produced no lines to compare — is this a work tree with files at HEAD?');

  worst.sort((p, q) => p.agree / p.lines - q.agree / q.lines);
  return {
    files: sample.length, lines: total, agree,
    rate: total ? agree / total : 1,
    authorRate: authorTotal ? authorAgree / authorTotal : 1,
    naiveAuthorRate: authorTotal ? naiveAgree / authorTotal : 1,
    worst: worst.slice(0, 10), repairs: R.repairs,
    headMismatchFiles: scan.mismatched, headMismatchLines: scan.mismatchedLines, headFiles: scan.stats.size,
  };
}
