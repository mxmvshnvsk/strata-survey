// Assemble the self-contained HTML report: template + survey data + client script.
//
// The browser code is written as TypeScript modules (src/report/client/*.ts) so it is
// pleasant to read and type-check. For the report it is "bundled" the simplest way
// possible: strip the types, drop the import lines and `export` keywords, and
// concatenate the files in dependency order inside one function scope.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as nodeModule from 'node:module';
import type { Lang, Survey } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Browser sources, in dependency order (paths relative to this file, without extension). */
const CLIENT_FILES = [
  '../i18n',
  'client/strings',
  'client/dom',
  'client/context',
  'client/column',
  'client/stratigraphy',
  'client/map',
  'client/charts',
  'client/tables',
  'client/main',
];

type Stripper = (code: string, options?: { mode?: 'strip' | 'transform' }) => string;

/** Read one browser source as plain JavaScript (compiled .js if present, else stripped .ts). */
function loadAsJs(base: string): string {
  const js = join(here, base + '.js');
  if (existsSync(js)) return readFileSync(js, 'utf8');
  const strip = (nodeModule as unknown as { stripTypeScriptTypes?: Stripper }).stripTypeScriptTypes;
  if (!strip) throw new Error('Rendering from TypeScript sources needs Node 22.13+ (or run `npm run build`).');
  return quietly(() => strip(readFileSync(join(here, base + '.ts'), 'utf8'), { mode: 'strip' }));
}

/** Run `fn` without Node's one-time "stripTypeScriptTypes is experimental" warning. */
function quietly<T>(fn: () => T): T {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('stripTypeScriptTypes')) return;
    (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try { return fn(); } finally { process.emitWarning = emit; }
}

/** Turn ES module source into a fragment of one shared script scope. */
function unmodule(js: string): string {
  return js
    .replace(/^\s*import\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '')
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
}

let bundleCache: string | null = null;

/** The whole client as one classic script. */
export function clientBundle(): string {
  if (bundleCache) return bundleCache;
  const parts = CLIENT_FILES.map((f) => `// ── ${f.replace(/^\.\.\//, '')} ──\n${unmodule(loadAsJs(f))}`);
  bundleCache = `(function () {\n'use strict';\n${parts.join('\n')}\n})();`;
  return bundleCache;
}

export function renderReport(model: Survey, { lang = 'en', bare = false }: { lang?: Lang; bare?: boolean } = {}): string {
  const template = readFileSync(join(here, 'template.html'), 'utf8');
  // `<` is escaped so no string in the data can close the <script> element.
  const data = JSON.stringify({ ...model, lang })
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const title = `${model.meta.name} · Strata`;
  // One pass, so a placeholder-looking string inside the data is never expanded.
  const parts: Record<string, string> = { TITLE: escapeHtml(title), DATA: data, SCRIPT: clientBundle().replace(/<\/script/gi, '<\\/script') };
  const body = template.replace(/\{\{(TITLE|DATA|SCRIPT)\}\}/g, (_, k: string) => parts[k]);
  if (bare) return body; // for hosts that provide <html>/<head>/<body> themselves
  return `<!doctype html>\n<html lang="${lang}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${body.replace(/<div class="wrap"/, '</head>\n<body>\n<div class="wrap"')}\n</body>\n</html>\n`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
