import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, makePathFilter, fileRole } from '../src/filters.ts';
import { unquotePath } from '../src/git.ts';
import { kaplanMeier } from '../src/survival.ts';
import { makePeriod } from '../src/period.ts';
import { PathResolver, buildModules } from '../src/paths.ts';
import { indentationComplexity } from '../src/headscan.ts';
import { renderFact, strataPalette, makeFmt, pluralRu } from '../src/i18n.ts';

test('globs match like gitignore-style patterns', () => {
  assert.ok(globToRegExp('**/package-lock.json').test('package-lock.json'));
  assert.ok(globToRegExp('**/package-lock.json').test('a/b/package-lock.json'));
  assert.ok(globToRegExp('**/vendor/**').test('src/vendor/x/y.c'));
  assert.ok(!globToRegExp('**/vendor/**').test('src/vendors/x.c'));
  assert.ok(globToRegExp('**/*.min.js').test('static/app.min.js'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'));
  const keep = makePathFilter({ extraExcludes: ['fixtures/**'] });
  assert.equal(keep('src/index.ts'), true);
  assert.equal(keep('yarn.lock'), false);
  assert.equal(keep('logo.png'), false);
  assert.equal(keep('fixtures/a.json'), false);
});

test('file roles', () => {
  assert.equal(fileRole('src/app.ts'), 'source');
  assert.equal(fileRole('test/app.js'), 'tests');
  assert.equal(fileRole('pkg/foo_test.go'), 'tests');
  assert.equal(fileRole('src/a.spec.tsx'), 'tests');
  assert.equal(fileRole('README.md'), 'docs');
  assert.equal(fileRole('.github/workflows/ci.yml'), 'config & tooling');
});

test('git C-quoted paths are decoded', () => {
  assert.equal(unquotePath('"caf\\303\\251.txt"'), 'café.txt');
  assert.equal(unquotePath('"a\\"b\\\\c\\tz"'), 'a"b\\c\tz');
  assert.equal(unquotePath('plain.txt'), 'plain.txt');
});

test('Kaplan–Meier handles censoring', () => {
  // 4 subjects: deaths at bin 0 and 2, censored at bins 1 and 3.
  const r = kaplanMeier([1, 0, 1, 0], [0, 1, 0, 1]);
  // S0 = 1 - 1/4 = .75; S1 = .75; S2 = .75 * (1 - 1/2) = .375; S3 = .375
  assert.deepEqual(r.curve.map((x) => +x.toFixed(4)), [0.75, 0.75, 0.375, 0.375]);
  assert.ok(Math.abs(r.median! - 8 / 3) < 1e-9); // survival crosses 50% two-thirds into bin 2
  const none = kaplanMeier([0, 0], [3, 0]);
  assert.equal(none.median, null);
});

test('periods pick a readable stratum width', () => {
  const y = (yy: number, m = 0): number => Date.UTC(yy, m, 1) / 1000;
  const p1 = makePeriod(y(2010), y(2020, 5));
  assert.equal(p1.unit, 'year');
  assert.equal(p1.count, 11);
  assert.equal(p1.label(3), '2013');
  const p2 = makePeriod(y(2023, 1), y(2025, 4));
  assert.equal(p2.unit, 'quarter');
  assert.equal(p2.label(p2.bucketOf(y(2024, 7))), '2024 Q3');
  const p3 = makePeriod(y(2025, 1), y(2025, 9));
  assert.equal(p3.unit, 'month');
});

test('rename resolution is time-aware', () => {
  const r = new PathResolver([[100, 'a.js', 'b.js'], [300, 'b.js', 'c.js']]);
  assert.equal(r.resolve('a.js', 50), 'c.js');
  assert.equal(r.resolve('b.js', 200), 'c.js');
  assert.equal(r.resolve('a.js', 150), 'a.js'); // a later, unrelated a.js
  assert.equal(r.resolve('c.js', 400), 'c.js');
  const cyc = new PathResolver([[1, 'x', 'y'], [2, 'y', 'x']]);
  assert.equal(cyc.resolve('x', 0), 'x');
});

test('adaptive modules split the dominant folder', () => {
  const paths = [];
  for (let i = 0; i < 50; i++) paths.push(`packages/core/src/f${i}.ts`);
  for (let i = 0; i < 30; i++) paths.push(`packages/ui/f${i}.ts`);
  for (let i = 0; i < 5; i++) paths.push(`docs/d${i}.md`);
  paths.push('README.md');
  const mod = buildModules(paths);
  assert.equal(mod('packages/core/src/f1.ts'), 'packages/core/src');
  assert.equal(mod('packages/ui/f1.ts'), 'packages/ui');
  assert.equal(mod('README.md'), '(root)');
  assert.equal(mod('docs/d1.md'), 'docs');
});

test('indentation complexity', () => {
  const r = indentationComplexity(['a', '    b', '\t\tc', '', '      d']);
  assert.equal(r.total, 0 + 1 + 2 + 2);
  assert.equal(r.max, 2);
});

test('i18n: plurals, facts and palette', () => {
  assert.equal(pluralRu(1, 'a', 'b', 'c'), 'a');
  assert.equal(pluralRu(3, 'a', 'b', 'c'), 'b');
  assert.equal(pluralRu(11, 'a', 'b', 'c'), 'c');
  assert.equal(pluralRu(22, 'a', 'b', 'c'), 'b');
  assert.equal(makeFmt('ru').dur(400), '1,1 года');
  assert.equal(makeFmt('en').dur(3), '3 days');
  const fact = { k: 'hotspot', v: { path: '<x>.js', revs: 3, loc: 10, recent: true } };
  assert.match(renderFact(fact, 'en'), /&lt;x&gt;\.js/);
  assert.match(renderFact(fact, 'ru'), /10 строк, 3 изменения/);
  const pal = strataPalette(20);
  assert.equal(pal.length, 20);
  assert.equal(new Set(pal.map((p) => p[1])).size, 20, 'stratum names are unique');
  assert.equal(strataPalette(3)[2][1], 'Quaternary');
});
