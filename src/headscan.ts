// Read every tracked text blob at HEAD once (single `git cat-file --batch`)
// to measure size and indentation complexity, and to dig up fossils:
// the oldest non-trivial lines that still survive.

import { gitText, catFileBatch, looksBinary, countLines, type BlobRequest } from './git.ts';
import type { MergeNeeds } from './mergeblame.ts';
import type { Replay } from './replay.ts';
import type { Fossil } from './types.ts';

export interface HeadBlob extends BlobRequest { path: string; oid: string }

export interface FileStats {
  loc: number;
  binary: boolean;
  cx: number;
  cxMax: number;
  /** Very large text: lines counted, per-line analysis skipped. */
  huge?: boolean;
}

export interface HeadScan {
  stats: Map<string, FileStats>;
  fossils: Fossil[];
  /** Files whose replayed length differs from the real file (should be 0). */
  mismatched: number;
  mismatchedLines: number;
  binary: number;
}

/** Tracked regular files at HEAD that pass the path filter (symlinks excluded). */
export function listHeadBlobs(repo: string, keep: (path: string) => boolean): HeadBlob[] {
  const out = gitText(repo, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']);
  const blobs: HeadBlob[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    if (type !== 'blob' || mode === '120000' || !keep(path)) continue;
    blobs.push({ path, oid, spec: oid });
  }
  return blobs;
}

/** Tornhill-style indentation complexity: sum of logical indentation over non-blank lines. */
export function indentationComplexity(lines: string[]): { total: number; max: number } {
  let total = 0, max = 0;
  for (const l of lines) {
    let spaces = 0, tabs = 0, i = 0;
    for (; i < l.length; i++) {
      const c = l.charCodeAt(i);
      if (c === 32) spaces++; else if (c === 9) tabs++; else break;
    }
    if (i === l.length) continue; // blank
    const level = tabs + Math.floor(spaces / 4) + (spaces % 4 >= 2 ? 1 : 0);
    total += level;
    if (level > max) max = level;
  }
  return { total, max };
}

/** Lines too common or too short to be interesting fossils. */
function isTrivial(s: string): boolean {
  const t = s.trim();
  if (t.length < 14) return true;
  if (!/[A-Za-z]{3}/.test(t)) return true;
  if (/^(\/\/|#|\*|\/\*|--|;)\s*[-=*#/]*\s*$/.test(t)) return true;
  if (/^(import|from|require|use|using|#include|package|export \{|\}|\]|\)|module\.exports)\b/.test(t) && t.length < 40) return true;
  return false;
}

export async function scanHead(
  repo: string,
  blobs: HeadBlob[],
  R: Replay,
  { fossilCount = 14, mergeNeeds = null as MergeNeeds | null } = {},
): Promise<HeadScan> {
  const { files, oAt, oAuthor } = R;
  const stats = new Map<string, FileStats>();
  const fossils: Fossil[] = [];
  let mismatched = 0, mismatchedLines = 0, binary = 0;
  const check = (path: string, loc: number): void => {
    const arr = files.get(path);
    if (!arr || arr.length !== loc) { mismatched++; mismatchedLines += Math.abs((arr ? arr.length : 0) - loc); }
  };

  await catFileBatch(repo, blobs, (req, buf) => {
    if (!buf || looksBinary(buf)) {
      stats.set(req.path, { loc: 0, binary: true, cx: 0, cxMax: 0 });
      binary++;
      return;
    }
    if (buf.length > 4 << 20) {
      // Huge text (generated SQL, data dumps): count lines, skip the per-line work.
      const loc = countLines(buf);
      check(req.path, loc);
      stats.set(req.path, { loc, binary: false, cx: 0, cxMax: 0, huge: true });
      return;
    }
    const lines = buf.toString('utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const cx = indentationComplexity(lines);
    check(req.path, lines.length);
    stats.set(req.path, { loc: lines.length, binary: false, cx: cx.total, cxMax: cx.max });

    const arr = files.get(req.path);
    if (!arr) return;
    mergeNeeds?.collect(R, req.path, lines);

    // Fossil candidates: the two oldest non-trivial lines of this file.
    const idx: number[] = [];
    for (let i = 0; i < arr.length && i < lines.length; i++) if (arr[i] >= 0) idx.push(i);
    idx.sort((a, b) => oAt[arr[a]] - oAt[arr[b]]);
    let taken = 0;
    const seen = new Set<string>();
    for (const i of idx) {
      if (taken >= 2) break;
      const s = lines[i];
      if (isTrivial(s)) continue;
      const key = s.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      fossils.push({ path: req.path, line: i + 1, at: oAt[arr[i]], author: oAuthor[arr[i]], text: s.replace(/\t/g, '    ').slice(0, 160) });
      taken++;
    }
  });

  // Prefer variety: no repeated text, at most one fossil per file in the final cut.
  fossils.sort((a, b) => a.at - b.at);
  const out: Fossil[] = [];
  const texts = new Set<string>();
  const perFile = new Set<string>();
  for (const f of fossils) {
    const k = f.text.trim();
    if (texts.has(k) || perFile.has(f.path)) continue;
    texts.add(k);
    perFile.add(f.path);
    out.push(f);
    if (out.length >= fossilCount) break;
  }
  return { stats, fossils: out, mismatched, mismatchedLines, binary };
}
