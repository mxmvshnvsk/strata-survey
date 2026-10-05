// Strata — a geological survey of a git repository.
// Usage: strata [survey] [repo] [options]  |  strata verify [repo]  |  strata --help

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { survey } from './analyze.ts';
import { verify } from './verify.ts';
import { renderReport } from './report/render.ts';
import { renderFact, strataPalette, makeFmt } from './i18n.ts';
import type { Lang, Logger, Survey } from './types.ts';

function readVersion(): string {
  // ../package.json from src/, ../../package.json from dist/src/
  for (const rel of ['../package.json', '../../package.json']) {
    try { return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')).version; } catch { /* try the next one */ }
  }
  return '0.0.0';
}
const VERSION = readVersion();

const HELP = `strata ${VERSION} — a geological survey of a git repository

USAGE
  strata [repo] [options]            survey a repository and write an HTML report
  strata verify [repo] [--files N]   check the line replay against git blame
  strata --help | --version

OPTIONS
  -o, --out <file>        HTML report path (default: strata-<repo>.html)
      --json <file>       also write the raw survey as JSON
      --from-json <file>  render a report from a saved JSON survey (no git needed)
      --lang <en|ru>      language of the report and the terminal summary (default: en)
      --exclude <glob>    exclude paths (repeatable), e.g. --exclude 'docs/**'
      --include <glob>    only include matching paths (repeatable)
      --no-default-excludes  keep lockfiles, vendored, generated and minified files
      --name <name>       display name for the repository
      --fast              skip the content pass that credits merged lines to
                          side-branch authors (faster on huge merge-heavy repos)
      --open              open the report in the default browser when done
      --no-report         skip the HTML report (terminal summary only)
  -q, --quiet             no progress output

EXAMPLES
  strata ~/code/my-project --open
  strata . --exclude 'fixtures/**' --json survey.json
  strata verify ~/code/my-project --files 200
`;

interface CliOptions {
  cmd: 'survey' | 'verify';
  repo: string;
  exclude: string[];
  include: string[];
  lang: Lang;
  report: boolean;
  help?: boolean;
  version?: boolean;
  out?: string;
  json?: string;
  fromJson?: string;
  noDefaultExcludes?: boolean;
  name?: string;
  open?: boolean;
  fast?: boolean;
  files?: number;
  quiet?: boolean;
}

function fail(msg: string): never {
  process.stderr.write(`strata: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { cmd: 'survey', repo: '.', exclude: [], include: [], lang: 'en', report: true };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '-o': case '--out': o.out = val(); break;
      case '--json': o.json = val(); break;
      case '--from-json': o.fromJson = val(); break;
      case '--lang': { const l = val(); if (l !== 'en' && l !== 'ru') fail('--lang must be en or ru'); o.lang = l; break; }
      case '--exclude': o.exclude.push(val()); break;
      case '--include': o.include.push(val()); break;
      case '--no-default-excludes': o.noDefaultExcludes = true; break;
      case '--name': o.name = val(); break;
      case '--open': o.open = true; break;
      case '--fast': o.fast = true; break;
      case '--no-report': o.report = false; break;
      case '--files': o.files = Number(val()); break;
      case '-q': case '--quiet': o.quiet = true; break;
      default:
        if (a.startsWith('-')) fail(`Unknown option ${a}. See strata --help.`);
        rest.push(a);
    }
  }
  if (rest[0] === 'verify' || rest[0] === 'survey') o.cmd = rest.shift() as CliOptions['cmd'];
  if (rest[0]) o.repo = rest[0];
  return o;
}

// ── Terminal output ─────────────────────────────────────────────────────

const tty = !!process.stdout.isTTY && !process.env.NO_COLOR;
const color = {
  bold: (s: string): string => (tty ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string): string => (tty ? `\x1b[2m${s}\x1b[22m` : s),
  cyan: (s: string): string => (tty ? `\x1b[36m${s}\x1b[39m` : s),
  bg: (hex: string, s: string): string => {
    if (!tty) return s;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m`;
  },
};

/** Progress on stderr; counters overwrite each other on a terminal. */
function progress(quiet?: boolean): Logger {
  if (quiet) return () => {};
  const isTTY = process.stderr.isTTY;
  return (msg) => {
    if (isTTY && /^\s+\d/.test(msg)) process.stderr.write(`\r\x1b[2K${color.dim(msg.trim())}`);
    else process.stderr.write((isTTY ? '\r\x1b[2K' : '') + msg + '\n');
  };
}

/** The findings are tiny HTML (<b>, <code>); render them for a terminal. */
function htmlToTerm(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/g, (_, s: string) => color.bold(s))
    .replace(/<code>(.*?)<\/code>/g, (_, s: string) => color.cyan(s))
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function printSummary(model: Survey, lang: Lang): void {
  const out: string[] = [];
  const pal = strataPalette(model.strata.labels.length);
  const f = makeFmt(lang);
  const alive = model.strata.alive;
  const total = alive.reduce((a, b) => a + b, 0) || 1;
  out.push('', color.bold(`  ${lang === 'ru' ? 'СТРАТИГРАФИЯ' : 'STRATIGRAPHY'} · ${model.meta.name}`));
  // A little stratigraphic column, youngest on top.
  const barW = 34;
  for (let i = alive.length - 1; i >= 0; i--) {
    if (model.strata.written[i] <= 0) continue;
    const share = alive[i] / total;
    const w = alive[i] > 0 ? Math.max(1, Math.round(share * barW * 3)) : 0;
    const fill = tty ? color.bg(pal[i][0], ' '.repeat(Math.min(barW, w))) : '█'.repeat(Math.min(barW, w));
    const bar = alive[i] > 0 ? fill + (w > barW ? '…' : '') : color.dim('~'.repeat(6));
    const label = `${model.strata.labels[i].padEnd(8)} ${pal[i][lang === 'ru' ? 2 : 1].padEnd(20)}`;
    const count = alive[i] > 0 ? `${f.num(alive[i])} (${f.pct(share, 1)})` : lang === 'ru' ? 'несогласие' : 'unconformity';
    out.push(`  ${label} ${bar} ${color.dim(count)}`);
  }
  out.push('', color.bold(lang === 'ru' ? '  ПОЛЕВЫЕ ЗАМЕТКИ' : '  FIELD NOTES'));
  model.narrative.forEach((fact, i) => out.push(`  ${color.dim(String(i + 1).padStart(2, '0'))}  ${htmlToTerm(renderFact(fact, lang))}`));
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

function openFile(path: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* no browser: the path is printed anyway */ }
}

// ── Commands ────────────────────────────────────────────────────────────

async function runVerify(o: CliOptions, log: Logger): Promise<void> {
  if (!existsSync(o.repo)) fail(`${o.repo}: no such directory.`);
  const r = await verify(o.repo, { files: o.files || 60, exclude: o.exclude, include: o.include, noDefaultExcludes: o.noDefaultExcludes, noMergeRefine: o.fast, log });
  const pct = (x: number, d: number): string => (x * 100).toFixed(d) + '%';
  process.stdout.write(`\n${color.bold('Replay vs git blame')}\n  files: ${r.files}   lines: ${r.lines}   hunk repairs: ${r.repairs}\n` +
    `  files at HEAD whose replayed length differs: ${color.bold(String(r.headMismatchFiles))} of ${r.headFiles}\n` +
    `  commit per line vs git blame --first-parent: ${color.bold(pct(r.rate, 3))}\n` +
    `  author per line vs plain git blame:          ${color.bold(pct(r.authorRate, 2))}  ${color.dim(`(crediting merges to the merger: ${pct(r.naiveAuthorRate, 2)})`)}\n`);
  for (const w of r.worst) process.stdout.write(color.dim(`  ${w.path}: ${w.agree}/${w.lines}\n`));
  process.exitCode = r.rate >= 0.99 && r.headMismatchFiles === 0 ? 0 : 1;
}

async function runSurvey(o: CliOptions, log: Logger): Promise<void> {
  if (!o.fromJson && !existsSync(o.repo)) fail(`${o.repo}: no such directory.`);
  const model: Survey = o.fromJson
    ? JSON.parse(readFileSync(o.fromJson, 'utf8'))
    : await survey(o.repo, { exclude: o.exclude, include: o.include, noDefaultExcludes: o.noDefaultExcludes, name: o.name, noMergeRefine: o.fast, log });

  if (o.json) { writeFileSync(o.json, JSON.stringify(model)); log(`Survey data → ${o.json}`); }
  printSummary(model, o.lang);
  if (model.meta.shallow) {
    process.stderr.write(`  ⚠ ${o.lang === 'ru'
      ? 'Это shallow-клон: всё, что старше первого доступного коммита, спрессовано в нижний слой. Выполните git fetch --unshallow для полной съёмки.'
      : 'This is a shallow clone: everything older than the first available commit is compressed into the bottom layer. Run git fetch --unshallow for a full survey.'}\n\n`);
  }
  if (o.report) {
    const out = resolve(o.out || `strata-${model.meta.name.replace(/[^\w.-]+/g, '_')}.html`);
    writeFileSync(out, renderReport(model, { lang: o.lang }));
    process.stdout.write(`  ${o.lang === 'ru' ? 'Отчёт' : 'Report'}: ${out}\n\n`);
    if (o.open) openFile(out);
  }
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP); return; }
  if (o.version) { process.stdout.write(VERSION + '\n'); return; }
  const log = progress(o.quiet);
  if (o.cmd === 'verify') await runVerify(o, log);
  else await runSurvey(o, log);
}

main().catch((e: unknown) => {
  const err = e as Error;
  const msg = String(err?.message || e);
  if (/not a git repository/i.test(msg)) fail(`${resolve(process.argv[2] || '.')} is not a git repository.`);
  if (/does not have any commits|unknown revision|ambiguous argument 'HEAD'/i.test(msg)) fail('the repository has no commits yet.');
  process.stderr.write(`strata: ${err?.stack || msg}\n`);
  process.exit(1);
});
