// A streaming parser for `git log -p -U0` output.
//
// Strata never needs the text of ordinary lines: hunk headers (`@@ -a,b +c,d @@`)
// say exactly which lines die and how many are born. The parser therefore counts
// content lines to skip them, and only keeps their text when asked to (for merges,
// where Strata looks for code that was moved rather than written).

import { unquotePath } from './git.ts';

export interface Hunk {
  /** 1-based first removed line in the old file (for pure insertions: the line after which to insert). */
  oldStart: number;
  oldCount: number;
  /** 1-based first added line in the new file. */
  newStart: number;
  newCount: number;
  /** Text of removed / added lines, only collected when `captureText` is on. */
  minus?: string[];
  plus?: string[];
}

export interface FileDiff {
  /** Path before the change; null for a new file. */
  oldPath: string | null;
  /** Path after the change; null for a deleted file. */
  newPath: string | null;
  hunks: Hunk[];
  /** git printed "Binary files … differ" instead of hunks. */
  binary: boolean;
  deleted: boolean;
  isNew: boolean;
  renamed: boolean;
  /** A symlink (120000) or submodule (160000), not a text file. */
  special: boolean;
  oldOid?: string;
  newOid?: string;
}

export interface PatchHandlers {
  /** A new commit starts. Return true to collect line text for its hunks. */
  onCommit(hash: string): boolean;
  /** One file of the current commit, complete with all its hunks. */
  onFile(diff: FileDiff): void;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const INDEX_RE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?/;
const SPECIAL_MODE_RE = /(16|12)0000$/;

/**
 * Feed it lines with `push()`, call `end()` at the end of the stream.
 * Commit headers must be printed as `\x01<hash>` (`--format=%x01%H`).
 */
export class PatchParser {
  private handlers: PatchHandlers;
  private file: FileDiff | null = null;
  /** Content lines still expected in the current hunk. */
  private remaining = 0;
  private capture = false;
  private inCommit = false;

  constructor(handlers: PatchHandlers) {
    this.handlers = handlers;
  }

  push(line: string): void {
    if (this.remaining > 0) {
      const ch = line.charCodeAt(0);
      if (ch === 45 /* - */ || ch === 43 /* + */) {
        this.remaining--;
        if (this.capture && this.file) {
          const hunk = this.file.hunks[this.file.hunks.length - 1];
          (ch === 45 ? hunk.minus! : hunk.plus!).push(line.slice(1));
        }
        return;
      }
      if (ch === 92 /* \ No newline at end of file */) return;
      this.remaining = 0; // malformed: treat as a header line
    }

    if (line.charCodeAt(0) === 1) {
      this.flush();
      this.inCommit = true;
      this.capture = this.handlers.onCommit(line.slice(1));
      return;
    }
    if (line.startsWith('@@ ')) {
      const m = HUNK_RE.exec(line);
      if (m && this.file) {
        const hunk: Hunk = {
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
        };
        if (this.capture) { hunk.minus = []; hunk.plus = []; }
        this.file.hunks.push(hunk);
        this.remaining = hunk.oldCount + hunk.newCount;
      }
      return;
    }
    if (line.startsWith('diff --git ')) {
      this.flush();
      const [a, b] = parseGitHeader(line);
      this.file = { oldPath: a, newPath: b, hunks: [], binary: false, deleted: false, isNew: false, renamed: false, special: false };
      return;
    }

    const fd = this.file;
    if (!fd) return;
    if (line.startsWith('--- ')) {
      if (!fd.renamed) fd.oldPath = pathFromHeader(line.slice(4));
      else if (line.slice(4).startsWith('/dev/null')) fd.oldPath = null;
    } else if (line.startsWith('+++ ')) {
      const p = pathFromHeader(line.slice(4));
      if (p === null) fd.deleted = true; else fd.newPath = p;
    } else if (line.startsWith('rename from ')) {
      fd.oldPath = unquotePath(line.slice(12));
      fd.renamed = true;
    } else if (line.startsWith('rename to ')) {
      fd.newPath = unquotePath(line.slice(10));
      fd.renamed = true;
    } else if (line.startsWith('new file mode')) {
      fd.isNew = true;
      fd.oldPath = null;
      if (SPECIAL_MODE_RE.test(line)) fd.special = true;
    } else if (line.startsWith('deleted file mode')) {
      fd.deleted = true;
      if (SPECIAL_MODE_RE.test(line)) fd.special = true;
    } else if (line.startsWith('new mode ')) {
      if (SPECIAL_MODE_RE.test(line)) fd.special = true;
    } else if (line.startsWith('Binary files ')) {
      // Paths come from the headers; only the /dev/null sides matter here.
      fd.binary = true;
      if (line.startsWith('Binary files /dev/null and ')) { fd.isNew = true; if (!fd.renamed) fd.oldPath = null; }
      if (line.endsWith(' and /dev/null differ')) fd.deleted = true;
    } else if (line.startsWith('index ')) {
      const m = INDEX_RE.exec(line);
      if (m) {
        fd.oldOid = m[1];
        fd.newOid = m[2];
        if (m[3] === '160000' || m[3] === '120000') fd.special = true;
      }
    }
  }

  end(): void {
    this.flush();
  }

  /** Hand the finished file to the handler. */
  private flush(): void {
    const fd = this.file;
    this.file = null;
    if (!fd || !this.inCommit) return;
    if (fd.deleted) {
      if (!fd.oldPath) return;
      fd.newPath = null;
    }
    this.handlers.onFile(fd);
  }
}

/** "a/path" or "b/path" (possibly C-quoted, possibly followed by a TAB) → "path". */
function pathFromHeader(s: string): string | null {
  s = s.replace(/\t$/, '');
  if (s === '/dev/null') return null;
  return unquotePath(s).slice(2);
}

/**
 * "diff --git a/X b/Y" is only unambiguous when X === Y (no rename). That is enough:
 * renames always come with "rename from/to" lines, and ordinary changes with ---/+++.
 */
function parseGitHeader(line: string): [string | null, string | null] {
  const rest = line.slice(11);
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|.*)$/);
    if (m) return [unquotePath(m[1]).slice(2), unquotePath(m[2]).slice(2)];
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest.slice(2, half) === rest.slice(half + 3)) {
    const p = rest.slice(2, half);
    return [p, p];
  }
  return [null, null];
}

/** Parse the hunk headers of a plain `git diff -U0` output (no text). */
export function parseHunkHeaders(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of diff.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) hunks.push({ oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return hunks;
}
