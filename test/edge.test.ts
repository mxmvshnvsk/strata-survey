// Regression tests for edge cases found in review: binary↔text transitions, -diff
// attributes, files entering scope from excluded paths, odd names, symlinks, hostile
// user git config, control characters in commit subjects and placeholder injection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepare, survey } from '../src/analyze.ts';
import { renderReport } from '../src/report/render.ts';
import type { Survey } from '../src/types.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'strata-edge-'));
  let clock = Date.UTC(2020, 0, 1) / 1000;
  const env = (who: string): NodeJS.ProcessEnv => ({
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir,
    GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@x.org`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@x.org`,
    GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000`,
  });
  const git = (args: string[], who = 'ann'): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env(who) });
  const w = (p: string, data: string | Buffer): void => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), data); };
  const commit = (msg: string, who?: string): void => { clock += 86400 * 10; git(['add', '-A']); git(['commit', '-q', '--allow-empty', '-m', msg], who); };
  git(['init', '-q', '-b', 'main']);
  return { dir, git, w, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const lines = (p: string, n: number): string => Array.from({ length: n }, (_, i) => `${p} ${i}`).join('\n') + '\n';

async function linesAtHead(dir: string) {
  const P = await prepare(dir, {});
  const out: Record<string, number> = {};
  for (const [p, arr] of P.R.files) out[p] = arr.length;
  return { P, out };
}

test('binary → text transition re-seeds the file', async () => {
  const r = repo();
  try {
    r.w('plain.js', 'a\nb\n'); r.commit('text');
    r.w('plain.js', 'a\0b'); r.commit('binary');
    r.w('plain.js', 'a\nb\nc\n'); r.commit('text again');
    r.w('plain.js', 'a\nB\nc\nd\n'); r.commit('edit');
    const { P, out } = await linesAtHead(r.dir);
    assert.equal(out['plain.js'], 4);
    assert.equal(P.R.repairs, 0);
  } finally { r.cleanup(); }
});

test('-diff attribute and files entering scope from an excluded path', async () => {
  const r = repo();
  try {
    r.w('.gitattributes', 'gen.js -diff\n');
    r.w('gen.js', lines('g', 60));
    r.w('vendor/lib.js', lines('v', 50));
    r.commit('init');
    r.w('gen.js', lines('g', 61));
    mkdirSync(join(r.dir, 'src'), { recursive: true });
    renameSync(join(r.dir, 'vendor/lib.js'), join(r.dir, 'src/lib.js'));
    r.w('src/lib.js', lines('v', 50) + 'extra\n');
    r.commit('edit + move into scope');
    const { P, out } = await linesAtHead(r.dir);
    assert.equal(out['gen.js'], 61);
    assert.equal(out['src/lib.js'], 51);
    assert.equal(P.R.repairs, 0);
    assert.ok(P.R.files.get('src/lib.js')!.every((o) => o >= 0));
  } finally { r.cleanup(); }
});

test('odd names, cross-module binary rename, symlinks, \\x01 in subjects', async () => {
  const r = repo();
  try {
    r.w('x and y.js', 'one\ntwo\n');
    r.w('A/big.txt', lines('big', 200));
    r.w('A/keep.txt', lines('k', 10));
    r.w('B/other.txt', lines('o', 10));
    r.commit('init\x01 with control char');
    r.w('x and y.js', 'bin\0ary');
    renameSync(join(r.dir, 'A/big.txt'), join(r.dir, 'B/big.txt'));
    writeFileSync(join(r.dir, 'B/big.txt'), lines('big', 200) + '\0');
    symlinkSync('A/keep.txt', join(r.dir, 'link.txt'));
    r.commit('go binary\x01 again');
    r.w('A/keep.txt', lines('k', 11)); r.commit('touch');
    const m = await survey(r.dir, {});
    const P = await prepare(r.dir, {});
    assert.ok(!P.R.files.has('x and y.js'));
    assert.ok(!P.R.files.has('link.txt'));
    assert.ok(P.R.aliveMod!.every((x) => x >= 0), 'module tallies never negative');
    const alive = m.strata.alive.reduce((a, b) => a + b, 0);
    assert.equal(alive, m.meta.lines, 'strata and HEAD agree');
    assert.ok(P.H.commits.every((c) => c.files.length > 0), 'control chars in subjects keep file lists');
  } finally { r.cleanup(); }
});

test('hostile user git config does not change the replay', async () => {
  const r = repo();
  const cfg = join(mkdtempSync(join(tmpdir(), 'strata-cfg-')), 'evil.gitconfig');
  writeFileSync(cfg, '[diff]\n\tnoprefix = true\n\tinterHunkContext = 10\n\tmnemonicPrefix = true\n');
  try {
    r.w('src/app.js', lines('a', 40)); r.commit('init');
    r.w('src/app.js', lines('a', 40).replace('a 3\n', 'A3\n').replace('a 9\n', 'A9\n')); r.commit('two nearby edits');
    // Run the CLI in a child process so the hostile config is in its environment from the start.
    const out = join(cfg, '..', 'survey.json');
    execFileSync(process.execPath, [new URL('../bin/strata.ts', import.meta.url).pathname, r.dir, '--no-report', '--json', out, '-q'],
      { env: { ...process.env, GIT_CONFIG_GLOBAL: cfg }, stdio: 'ignore' });
    const m: Survey = JSON.parse(readFileSync(out, 'utf8'));
    const f = m.files.find((x) => x.path === 'src/app.js');
    assert.ok(f, 'paths keep their first characters');
    assert.equal(m.meta.diagnostics.headMismatchFiles, 0);
    const last = m.strata.alive[m.strata.alive.length - 1];
    assert.equal(m.bigBangs[0].added, 40);
    assert.equal(m.extinctions.length, 0);
    assert.ok(m.files.length === 1 && f.loc === 40 && last >= 0);
    const edits = m.bigBangs.find((b) => b.subject === 'two nearby edits');
    assert.equal(edits?.added, 2, 'only the two edited lines are new');
  } finally {
    r.cleanup();
  }
});

test('placeholder-looking strings in data cannot break the report', async () => {
  const r = repo();
  try {
    r.w('a.js', 'x\n'); r.commit('{{CLIENT}} {{I18N}} {{DATA}} </script><img src=x onerror=alert(1)>');
    const m = await survey(r.dir, { name: '{{DATA}}' });
    const html = renderReport(m);
    assert.equal(html.split('(function () {').length, 2, 'client script inserted exactly once');
    assert.ok(!html.includes('<img src=x'), 'markup in commit subjects is escaped');
  } finally { r.cleanup(); }
});

test('pure rename into scope, -diff edits, symlink renames', async () => {
  const r = repo();
  try {
    r.w('.gitattributes', '*.txt -diff\n');
    r.w('lib/x.js', lines('x', 40));
    r.w('data.txt', lines('d', 300));
    r.w('target.js', 't\n');
    symlinkSync('target.js', join(r.dir, 'link.js'));
    r.commit('init');
    mkdirSync(join(r.dir, 'src'), { recursive: true });
    renameSync(join(r.dir, 'lib/x.js'), join(r.dir, 'src/x.js'));
    renameSync(join(r.dir, 'link.js'), join(r.dir, 'link2.js'));
    r.commit('pure renames');
    r.w('src/x.js', lines('x', 40).replace('x 5\n', 'X5\n'));
    r.w('data.txt', lines('d', 300).replace('d 7\n', 'D7\n'));
    r.commit('one-line edits');
    const P = await prepare(r.dir, { include: ['src/**', 'data.txt', 'target.js', 'link2.js'] });
    assert.equal(P.R.files.get('src/x.js')!.length, 40);
    assert.equal(P.R.repairs, 0);
    assert.ok(!P.R.files.has('link2.js'), 'symlinks stay out after a pure rename');
    const head = P.chain[P.chain.length - 1].h;
    const fresh = (p: string): number => P.R.files.get(p)!.filter((o) => P.chain[P.R.oCommit[o]].h === head).length;
    assert.equal(fresh('data.txt'), 1, 'a -diff text file is diffed line by line');
  } finally { r.cleanup(); }
});

test('moves inside merges keep survival and tallies consistent', async () => {
  const r = repo();
  try {
    r.w('a/old.js', lines('long enough moved line', 30));
    r.w('b/keep.js', lines('k', 5));
    r.commit('init');
    r.git(['checkout', '-q', '-b', 'side']);
    mkdirSync(join(r.dir, 'c'), { recursive: true });
    rmSync(join(r.dir, 'a/old.js'));
    r.w('c/new.js', lines('long enough moved line', 30).replace('line 3 ', 'line three ') + lines('fresh side code', 80));
    r.commit('side: move with big edit', 'bob');
    r.git(['checkout', '-q', 'main']);
    r.w('b/keep.js', lines('k', 6)); r.commit('main work');
    r.git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], 'carl');
    const m = await survey(r.dir, {});
    const alive = m.strata.alive.reduce((a, b) => a + b, 0);
    assert.equal(alive, m.meta.lines);
    const last = m.strata.samples[m.strata.samples.length - 1];
    assert.equal(last.c.reduce((a, b) => a + b, 0), m.meta.lines, 'last sample is HEAD');
    assert.equal(m.survival.overall.total, m.strata.written.reduce((a, b) => a + b, 0), 'every written line is counted once in survival');
    const P = await prepare(r.dir, {});
    assert.ok(P.R.aliveMod!.every((x) => x >= 0));
    assert.ok(P.R.movedLines > 0, 'moved lines were recognised');
  } finally { r.cleanup(); }
});
