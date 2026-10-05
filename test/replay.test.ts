// Integration test: build a small repository with awkward history (renames, merges,
// spaces and non-ASCII in paths, binary files, deletions, lockfiles, missing final
// newlines) and check the replay line-for-line against `git blame --first-parent`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepare, survey } from '../src/analyze.ts';
import { renderReport } from '../src/report/render.ts';

let clock = Date.UTC(2019, 0, 1) / 1000;
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'strata-test-'));
  const git = (args: string[], who = 'Alice'): string => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase()}@example.com`,
      GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who.toLowerCase()}@example.com`,
      GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000`,
      GIT_CONFIG_NOSYSTEM: '1', HOME: dir,
    },
  });
  const write = (p: string, text: string): void => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), text); };
  const lines = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1} with some words`).join('\n') + '\n';
  const commit = (msg: string, who?: string): void => { clock += 86400 * 20; git(['add', '-A']); git(['commit', '-q', '--allow-empty', '-m', msg], who); };
  git(['init', '-q', '-b', 'main']);
  write('src/a.js', lines('a', 30));
  write('dir with space/b.txt', lines('b', 12));
  write('café.md', lines('café', 5));
  write('package-lock.json', '{\n"lock": 1\n}\n');
  commit('initial');
  write('src/a.js', lines('a', 30).replace('a line 10 with', 'A LINE 10 with').replace('a line 20 with some words\n', '') + 'tail\n');
  write('dir with space/b.txt', lines('b', 12).replace('b line 3', 'B line 3'));
  write('package-lock.json', '{\n"lock": 2\n}\n');
  commit('edit', 'Bob');
  // rename with a small modification, plus a pure rename
  renameSync(join(dir, 'src/a.js'), join(dir, 'src/core.js'));
  write('src/core.js', lines('a', 30).replace('a line 10 with', 'A LINE 10 with').replace('a line 20 with some words\n', '') + 'tail\nmore tail\n');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  renameSync(join(dir, 'café.md'), join(dir, 'docs/café.md'));
  commit('rename');
  // binary file and a file without a trailing newline
  writeFileSync(join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 10, 0]));
  write('src/no-newline.txt', 'one\ntwo\nthree');
  commit('binary + no newline');
  // feature branch by Carol, merged with --no-ff
  git(['checkout', '-q', '-b', 'feature']);
  write('src/feature.js', lines('feature', 15));
  commit('feature: add', 'Carol');
  write('dir with space/b.txt', lines('b', 12).replace('b line 3', 'B line 3').replace('b line 9', 'feature line 9'));
  commit('feature: tweak b', 'Carol');
  git(['checkout', '-q', 'main']);
  write('src/core.js', 'header\n' + lines('a', 30).replace('a line 10 with', 'A LINE 10 with').replace('a line 20 with some words\n', '') + 'tail\nmore tail\n');
  commit('main: header');
  clock += 86400;
  git(['merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature'], 'Dave');
  // delete and later re-create a file at the same path
  rmSync(join(dir, 'docs/café.md'));
  commit('delete café');
  write('src/no-newline.txt', 'one\nTWO\nthree\nfour');
  chmodSync(join(dir, 'src/core.js'), 0o755);
  commit('mode change + edit');
  write('docs/café.md', lines('new café', 3));
  write('empty.txt', '');
  commit('re-create café');
  return { dir, git };
}

function blame(dir: string, path: string): string[] {
  const out = execFileSync('git', ['-C', dir, 'blame', '--first-parent', '--porcelain', 'HEAD', '--', path], { encoding: 'utf8' });
  const res: string[] = [];
  for (const l of out.split('\n')) { const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l); if (m) res[Number(m[2]) - 1] = m[1]; }
  return res;
}

test('replay reproduces git blame --first-parent on awkward history', async () => {
  const { dir, git } = makeRepo();
  try {
    const P = await prepare(dir, {});
    const { R, chain } = P;
    const tracked = git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean);
    const expected = tracked.filter((p) => P.keep(p) && p !== 'logo.bin');
    assert.deepEqual([...R.files.keys()].sort(), expected.sort(), 'tracked files at HEAD');
    for (const p of expected) {
      const b = blame(dir, p);
      const got = R.files.get(p)!.map((o) => chain[R.oCommit[o]].h);
      assert.deepEqual(got, b, `blame mismatch in ${p}`);
    }
    assert.equal(R.repairs, 0);
    // Lines that arrived through the merge are credited to Carol (side branch), not Dave.
    const feat = R.files.get('src/feature.js')!;
    assert.ok(feat.every((o) => P.people[R.oAuthor[o]].name === 'Carol'));
    const bLines = R.files.get('dir with space/b.txt')!;
    assert.equal(P.people[R.oAuthor[bLines[8]]].name, 'Carol');
    assert.equal(P.people[R.oAuthor[bLines[2]]].name, 'Bob');
    assert.equal(P.people[R.oAuthor[bLines[0]]].name, 'Alice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('survey and report render end to end', async () => {
  const { dir } = makeRepo();
  try {
    const m = await survey(dir, {});
    assert.equal(m.meta.files, 6); // core.js, feature.js, no-newline.txt, b.txt, café.md, empty.txt
    assert.ok(m.narrative.length >= 4);
    assert.ok(m.strata.labels.length >= 1);
    assert.equal(m.meta.diagnostics.headMismatchFiles, 0);
    const html = renderReport(m, { lang: 'ru' });
    assert.match(html, /<script type="application\/json" id="strata-data">/);
    const data = html.slice(html.indexOf('id="strata-data">'), html.indexOf('</script>', html.indexOf('id="strata-data">')));
    assert.ok(!data.slice(20).includes('<'), 'data block must not contain raw <');
    const bare = renderReport(m, { bare: true });
    assert.ok(!/<html|<body|<!doctype/i.test(bare.slice(0, 2000)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
