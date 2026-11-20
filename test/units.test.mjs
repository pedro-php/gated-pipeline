// Pure logic: globs, file classification, spec parsing, stage rules, review parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, loadConfig, packageOf } from '../scripts/lib/config.mjs';
import { bashWriteTargets, decideBash, decidePath, parseReview } from '../scripts/lib/guard.mjs';
import { parseSpec, specProblems } from '../scripts/lib/spec.mjs';
import { globToRegExp } from '../scripts/lib/util.mjs';
import { makeRepo } from './helpers.mjs';

test('globs: ** crosses directories, * and ? stay inside one segment', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.ts'));
  assert.ok(globToRegExp('**/*.spec.ts').test('a.spec.ts'));
  assert.ok(globToRegExp('**/*.spec.ts').test('src/x/a.spec.ts'));
  assert.ok(!globToRegExp('*.ts').test('src/a.ts'));
  assert.ok(globToRegExp('tsconfig*.json').test('tsconfig.build.json'));
  assert.ok(!globToRegExp('a.ts').test('aXts'));
  assert.ok(globToRegExp('f?.js').test('f1.js'));
  assert.ok(!globToRegExp('f?.js').test('f/.js'));
});

const cfg = loadConfig(
  makeRepo({
    packages: [
      { name: 'server', root: 'server', source: ['src/**'], tests: ['**/*.spec.ts'] },
      { name: 'tools', root: 'server/tools' },
    ],
  }),
);

test('a path belongs to the package with the longest matching root', () => {
  assert.equal(packageOf(cfg, 'server/src/a.ts').pkg.name, 'server');
  assert.equal(packageOf(cfg, 'server/tools/src/a.ts').pkg.name, 'tools');
  assert.equal(packageOf(cfg, 'serverless/a.ts'), null);
});

test('classification: state, test, protected, docs, source, other', () => {
  assert.equal(classify(cfg, '.gated/state.json'), 'state');
  assert.equal(classify(cfg, 'server/src/user.spec.ts'), 'test');
  assert.equal(classify(cfg, 'server/tsconfig.build.json'), 'protected');
  assert.equal(classify(cfg, 'server/stryker.config.mjs'), 'protected');
  assert.equal(classify(cfg, 'docs/items/x.md'), 'docs');
  assert.equal(classify(cfg, 'server/README.md'), 'docs');
  assert.equal(classify(cfg, 'server/src/user.ts'), 'source');
  assert.equal(classify(cfg, 'server/package.json'), 'other');
  assert.equal(classify(cfg, 'outside/file.ts'), 'other');
});

test('spec: criteria are parsed in the heading, list and bold forms', () => {
  const acs = parseSpec('# T\n### AC-1: first\nExample: a -> b\n- **AC-2** second\nExample: c -> d\nAC-3 - third\nexample: e\n');
  assert.deepEqual(acs.map((a) => [a.id, a.title]), [['AC-1', 'first'], ['AC-2', 'second'], ['AC-3', 'third']]);
});

test('spec: no criterion, a duplicate, and a criterion without an example are problems', () => {
  assert.match(specProblems('# nothing here')[0], /no acceptance criterion/);
  assert.match(specProblems('### AC-1: a\nExample: x\n### AC-1: b\nExample: y\n').join(), /AC-1 is declared twice/);
  assert.match(specProblems('### AC-1: a\nWHEN x THEN y\n').join(), /AC-1 has no "Example:"/);
  assert.deepEqual(specProblems('### AC-1: a\nExample: 1 -> 2\n'), []);
});

// rel path -> the stages in which a write is allowed
const WRITES = {
  '.gated/spec.md': ['spec'],
  '.gated/state.json': [],
  'server/src/a.spec.ts': ['test', 'validation'],
  'server/src/a.ts': ['implementation'],
  'server/package.json': ['implementation'],
  'server/tsconfig.json': [],
  'docs/guide.md': ['implementation', 'docs'],
};
for (const [rel, allowed] of Object.entries(WRITES)) {
  test(`stage rules: ${rel} is writable only in [${allowed.join(', ')}]`, () => {
    for (const stage of ['spec', 'test', 'implementation', 'validation', 'docs', 'merge', 'done']) {
      const reason = decidePath(cfg, { stage, type: 'feature' }, rel);
      assert.equal(reason === null, allowed.includes(stage), `${stage}: ${reason}`);
    }
  });
}

test('stage rules: a hotfix may touch tests, but never protected configuration', () => {
  const state = { stage: 'implementation', type: 'hotfix' };
  assert.equal(decidePath(cfg, state, 'server/src/a.spec.ts'), null);
  assert.match(decidePath(cfg, state, 'server/tsconfig.json'), /protected/);
});

test('bash: redirects, tee, touch, mv/cp destinations are write targets; reads are not', () => {
  const t = (c) => bashWriteTargets(c, '/nowhere');
  assert.deepEqual(t('echo x > src/a.ts'), ['src/a.ts']);
  assert.deepEqual(t('cat a >> "src/b c.ts" && ls'), ['src/b c.ts']);
  assert.deepEqual(t('npm test 2>&1 | tee out.log'), ['out.log']);
  assert.deepEqual(t('cp src/a.ts src/b.ts; touch src/c.ts'), ['src/b.ts', 'src/c.ts']);
  assert.deepEqual(t('grep -r "a > b; rm x" src; cat src/a.ts 2>/dev/null; git diff > /dev/null; ls 2>&1'), []);
  assert.deepEqual(t('echo x>src/a.ts'), ['src/a.ts']);
  assert.deepEqual(t('cat src/a.ts && npm run build'), []);
});

test('bash: a write to a file the stage forbids is denied; the model cannot approve', () => {
  const state = { stage: 'implementation', type: 'feature' };
  assert.match(decideBash('/r', cfg, state, 'echo x > server/src/a.spec.ts', '/r'), /tests are frozen/);
  assert.equal(decideBash('/r', cfg, state, 'echo x > server/src/a.ts', '/r'), null);
  assert.equal(decideBash('/r', cfg, state, 'echo x > /tmp/elsewhere.txt', '/r'), null);
  assert.match(decideBash('/r', cfg, state, 'node "/p/scripts/gp.mjs" approve merge', '/r'), /only the user approves/);
});

test('review block: findings are read by kind; no block means no review', () => {
  assert.equal(parseReview('looks fine to me'), null);
  assert.deepEqual(parseReview('all good\nGATED-REVIEW'), []);
  assert.deepEqual(parseReview('GATED-REVIEW\nBLOCKING: a.ts:3 empty input -> crash, but AC-2\n- **ADVISORY**: b.ts:9 slow on big lists\n'), [
    { kind: 'blocking', text: 'a.ts:3 empty input -> crash, but AC-2' },
    { kind: 'advisory', text: 'b.ts:9 slow on big lists' },
  ]);
});
