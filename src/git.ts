// Thin, dependency-free wrappers around the git CLI.
// Everything is streamed: Strata never holds a full `git log -p` in memory.

import { spawn, execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Writable } from 'node:stream';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
};

// Pin every config knob that changes the shape of diff/log output, so a user's
// ~/.gitconfig (noprefix, interHunkContext, …) cannot skew the replay.
const BASE_FLAGS = [
  '-c', 'core.quotePath=false', '-c', 'diff.renameLimit=2000', '-c', 'color.ui=never',
  '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.interHunkContext=0',
  '-c', 'diff.relative=false', '-c', 'log.showSignature=false', '-c', 'diff.suppressBlankEmpty=false',
];

/** Run git synchronously and return stdout as a string (for small outputs). */
export function gitText(repo: string, args: string[]): string {
  return execFileSync('git', [...BASE_FLAGS, '-C', repo, ...args], {
    env: GIT_ENV,
    maxBuffer: 1 << 30,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Like gitText, but returns null on failure. */
export function gitTextOrNull(repo: string, args: string[]): string | null {
  try {
    return gitText(repo, args);
  } catch (e) {
    // `git diff` between blobs exits 1 when they differ — that still carries output.
    const err = e as { stdout?: unknown; status?: number };
    return typeof err.stdout === 'string' && err.status === 1 ? err.stdout : null;
  }
}

/**
 * Stream git's stdout and call `onRecord` for every `sep`-terminated record
 * (lines by default). Resolves when git exits successfully.
 */
export function gitStream(
  repo: string,
  args: string[],
  onRecord: (record: string) => void,
  { sep = '\n', input }: { sep?: string; input?: string[] } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...BASE_FLAGS, '-C', repo, ...args], { env: GIT_ENV, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (input && child.stdin) writeLines(child.stdin, input);
    const decoder = new StringDecoder('utf8');
    let buf = '';
    let stderr = '';
    let failed: unknown = null;
    child.stdout!.on('data', (chunk: Buffer) => {
      if (failed) return;
      buf += decoder.write(chunk);
      let start = 0;
      let idx: number;
      try {
        while ((idx = buf.indexOf(sep, start)) !== -1) {
          onRecord(buf.slice(start, idx));
          start = idx + sep.length;
        }
      } catch (e) {
        failed = e;
        child.kill();
        return;
      }
      buf = buf.slice(start);
    });
    child.stderr!.on('data', (c: Buffer) => {
      stderr += c;
      if (stderr.length > 1e5) stderr = stderr.slice(-1e5);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (failed) return reject(failed);
      buf += decoder.end();
      try {
        if (buf.length) onRecord(buf);
      } catch (e) {
        return reject(e);
      }
      if (code !== 0) return reject(new Error(`git ${args.slice(0, 3).join(' ')} exited ${code}: ${stderr.trim().slice(0, 2000)}`));
      resolve();
    });
  });
}

/** Something `git cat-file --batch` can look up: an object id or `rev:path`. */
export interface BlobRequest { spec: string }

/**
 * `git cat-file --batch` reader: fetch many blobs through a single process.
 * Calls `onBlob(request, content | null)` in request order.
 */
export function catFileBatch<T extends BlobRequest>(
  repo: string,
  requests: T[],
  onBlob: (request: T, content: Buffer | null) => void,
  { maxSize = 256 << 20 } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...BASE_FLAGS, '-C', repo, 'cat-file', '--batch'], { env: GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
    let queue: Buffer = Buffer.alloc(0);
    let i = 0;
    let want: { size: number } | null = null;
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c; });
    child.on('error', reject);
    child.stdout.on('data', (chunk: Buffer) => {
      queue = queue.length ? Buffer.concat([queue, chunk]) : chunk;
      for (;;) {
        if (!want) {
          const nl = queue.indexOf(10);
          if (nl === -1) break;
          const header = queue.subarray(0, nl).toString('utf8');
          queue = queue.subarray(nl + 1);
          if (header.endsWith(' missing')) { onBlob(requests[i++], null); continue; }
          const parts = header.split(' ');
          want = { size: Number(parts[2]) };
        }
        if (queue.length < want.size + 1) break;
        const content = queue.subarray(0, want.size);
        queue = queue.subarray(want.size + 1);
        want = null;
        onBlob(requests[i++], content.length > maxSize ? null : Buffer.from(content));
      }
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('git cat-file failed: ' + stderr));
      resolve();
    });
    writeLines(child.stdin, requests.map((r) => r.spec));
  });
}

/** Write lines to a child's stdin, respecting backpressure, then close it. */
function writeLines(stdin: Writable, lines: string[]): void {
  let k = 0;
  stdin.on('error', () => { /* the child exited early; its exit code reports the problem */ });
  const feed = (): void => {
    while (k < lines.length) {
      if (!stdin.write(lines[k++] + '\n')) { stdin.once('drain', feed); return; }
    }
    stdin.end();
  };
  feed();
}

/** Decode a git C-style quoted path ("a\303\251.txt") into a JS string. */
export function unquotePath(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const inner = s.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') { for (const b of Buffer.from(c, 'utf8')) bytes.push(b); continue; }
    const n = inner[++i];
    if (n >= '0' && n <= '7') { bytes.push(parseInt(inner.slice(i, i + 3), 8)); i += 2; continue; }
    bytes.push(escapes[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Read one blob synchronously (rare: only when a file re-enters the replay). */
export function readBlob(repo: string, spec: string): Buffer | null {
  try {
    return execFileSync('git', [...BASE_FLAGS, '-C', repo, 'cat-file', 'blob', spec], { env: GIT_ENV, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Count lines the way git diff does (a final line without '\n' still counts). */
export function countLines(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
  if (buf.length && buf[buf.length - 1] !== 10) n++;
  return n;
}

/** Git's own binary heuristic: a NUL byte in the first 8000 bytes. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** [major, minor] of the installed git. */
export function gitVersion(): [number, number] {
  const out = execFileSync('git', ['--version'], { encoding: 'utf8' });
  const m = out.match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}
