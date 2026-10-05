// Path filtering: lockfiles, vendored and generated code are excluded by default,
// because they distort every metric (a 30k-line lockfile is not "code").

import type { Role } from './types.ts';

export const DEFAULT_EXCLUDES: readonly string[] = [
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/npm-shrinkwrap.json', '**/bun.lockb',
  '**/Cargo.lock', '**/go.sum', '**/poetry.lock', '**/Pipfile.lock', '**/Gemfile.lock', '**/composer.lock',
  '**/uv.lock', '**/flake.lock', '**/mix.lock', '**/pubspec.lock', '**/Podfile.lock', '**/packages.lock.json',
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.snap',
  '**/node_modules/**', '**/vendor/**', '**/third_party/**', '**/third-party/**',
  '**/dist/**', '**/*.pb.go', '**/*_pb2.py', '**/*.generated.*', '**/*.po', '**/*.pot',
];

// Extensions that are almost never hand-written source text.
const BINARYISH = new Set(('png jpg jpeg gif webp ico icns bmp tiff svgz pdf zip gz tgz bz2 xz 7z rar jar war ' +
  'class o a so dylib dll exe bin wasm woff woff2 ttf otf eot mp3 mp4 mov avi webm ogg wav flac psd ai sketch ' +
  'fig xcf blend db sqlite pyc').split(' '));

/** Convert a glob ("**", "*", "?") into an anchored RegExp over a '/'-separated path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories; a trailing "**" matches anything.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Decides whether a path takes part in the survey. */
export type PathFilter = (path: string) => boolean;

export function makePathFilter({ excludes = DEFAULT_EXCLUDES, extraExcludes = [] as readonly string[], includes = [] as readonly string[] } = {}): PathFilter {
  const ex = [...excludes, ...extraExcludes].map(globToRegExp);
  const inc = includes.map(globToRegExp);
  const cache = new Map<string, boolean>();
  return function keep(path: string): boolean {
    let v = cache.get(path);
    if (v !== undefined) return v;
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    v = !BINARYISH.has(ext) && !ex.some((r) => r.test(path)) && (inc.length === 0 || inc.some((r) => r.test(path)));
    if (cache.size < 500000) cache.set(path, v);
    return v;
  };
}

/** Pathspecs passed to git so heavy excluded files never even get diffed. */
export function excludePathspecs(globs: readonly string[]): string[] {
  return ['--', ':(top)', ...globs.map((g) => `:(top,exclude,glob)${g}`)];
}

const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|testing|fixtures?)(\/|$)|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|exs?)$/i;
const DOC_RE = /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst|txt|adoc)$/i;
const CONFIG_RE = /(^|\/)(\.github|\.circleci|ci|scripts?|build|tools?)(\/|$)|(^|\/)(Makefile|Dockerfile|Rakefile)$|\.(ya?ml|toml|ini|cfg|json)$/i;

/** Coarse role of a file, used for survival comparisons and hotspot ranking. */
export function fileRole(path: string): Role {
  if (TEST_RE.test(path)) return 'tests';
  if (DOC_RE.test(path)) return 'docs';
  if (CONFIG_RE.test(path)) return 'config & tooling';
  return 'source';
}

/** Lower-case extension, or the whole base name when there is none (Makefile). */
export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base;
}
