// Pure logic: globs, file classification, spec parsing, stage rules, review parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, loadConfig, packageOf } from '../scripts/lib/config.mjs';
import { bashWriteTargets, decideAgent, decideBash, decidePath, decideRecords, decideRecordsPath } from '../scripts/lib/guard.mjs';
import { parseReview } from '../scripts/lib/review.mjs';
import { parseSpec, specProblems } from '../scripts/lib/spec.mjs';
import { parseJestJson, parseJunit } from '../scripts/lib/test-report.mjs';
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

test('bash: the text of a heredoc is data; only its real target counts', () => {
  const doc = "cat > docs/items/x.md <<'EOF'\n# Title\n> quoted line -> result\nrm src/a.ts; echo y > src/b.ts\nEOF\necho done";
  assert.deepEqual(bashWriteTargets(doc, '/nowhere'), ['docs/items/x.md']);
  assert.equal(decideBash('/r', cfg, { stage: 'docs', type: 'feature' }, doc, '/r'), null);
  assert.match(decideBash('/r', cfg, { stage: 'docs', type: 'feature' }, doc.replace('docs/items/x.md', 'server/src/a.ts'), '/r'), /docs stage/);
});

test('bash: a write to a file the stage forbids is denied; the model cannot approve', () => {
  const state = { stage: 'implementation', type: 'feature' };
  assert.match(decideBash('/r', cfg, state, 'echo x > server/src/a.spec.ts', '/r'), /tests are frozen/);
  assert.equal(decideBash('/r', cfg, state, 'echo x > server/src/a.ts', '/r'), null);
  assert.equal(decideBash('/r', cfg, state, 'echo x > /tmp/elsewhere.txt', '/r'), null);
});

test('bash: no command may approve, or reach the approval records or the state file, however it is spelled', () => {
  for (const command of [
    'node "/p/scripts/gp.mjs" approve merge',
    'G=/p/scripts/gp.mjs; node $G approve spec',
    'gp approve spec',
    'bash -c "node /p/scripts/gp.mjs approve spec"',
    `node -e "import('/p/scripts/lib/pipeline.mjs').then((p) => p.approve('.', 'spec'))"`,
  ]) assert.match(decideRecords(command), /only the user approves/, command);
  assert.match(decideRecords('echo {} >> "$(git rev-parse --git-common-dir)/gated-approvals/sub.jsonl"'), /approvals are recorded only when the user answers/);
  assert.match(decideRecords(`node -e "require('fs').writeFileSync('.gated/state.json', '{}')"`), /written by the pipeline CLI only/);
  assert.match(decideRecords(`python3 -c "open('.gated/state.json', 'w')"`), /written by the pipeline CLI only/);
  for (const command of ['node /p/scripts/gp.mjs status --json', 'node /p/scripts/gp.mjs advance', 'git commit -m "feat: approve button"', 'ls .gated', 'npm test -- gp']) {
    assert.equal(decideRecords(command), null, command);
  }
  assert.match(decideRecordsPath('/r/.git/gated-approvals/sub.jsonl'), /approvals are recorded only/);
  assert.equal(decideRecordsPath('/r/src/gated-approvals.ts'), null);
});

test('test reports: JUnit XML and the Jest/Vitest JSON give one result per test', () => {
  const xml = `<?xml version="1.0"?><testsuites>
    <testcase name="AC-1: adds" time="0.1" classname="test" file="/r/a.test.mjs"/>
    <testcase name="AC-2: fails &lt;on> &quot;purpose&quot; &amp; more" classname="test"><failure type="x" message="3 == 4">trace</failure></testcase>
    <testcase name="AC-3: skipped" classname="test"><skipped type="skipped"/></testcase>
    <testsuite name="group"><testcase name='AC-5: nested' classname='group'/></testsuite>
    <testcase name="test/b.test.mjs" classname="test"><error message="cannot load"/></testcase>
  </testsuites>`;
  assert.deepEqual(parseJunit(xml), [
    { name: 'test AC-1: adds', status: 'passed' },
    { name: 'test AC-2: fails <on> "purpose" & more', status: 'failed' },
    { name: 'test AC-3: skipped', status: 'skipped' },
    { name: 'group AC-5: nested', status: 'passed' },
    { name: 'test test/b.test.mjs', status: 'failed' },
  ]);
  const json = {
    testResults: [
      { name: '/r/a.test.ts', status: 'failed', assertionResults: [{ ancestorTitles: ['math'], title: 'AC-1: adds', fullName: 'math AC-1: adds', status: 'passed' }, { ancestorTitles: ['math'], title: 'AC-2: subtracts', status: 'failed' }, { fullName: 'AC-3: later', status: 'todo' }, { fullName: 'AC-4: off', status: 'pending' }] },
      { name: '/r/b.test.ts', status: 'failed', message: 'Cannot find module', assertionResults: [] },
    ],
  };
  assert.deepEqual(parseJestJson(json), [
    { name: 'math AC-1: adds', status: 'passed' },
    { name: 'math AC-2: subtracts', status: 'failed' },
    { name: 'AC-3: later', status: 'skipped' },
    { name: 'AC-4: off', status: 'skipped' },
  ]);
});

test('config: a per-test report needs a known format and a {report} in the test command', () => {
  const load = (pkg) => {
    const repo = makeRepo({ packages: [{ name: 'app', ...pkg }] });
    return loadConfig(repo);
  };
  assert.throws(() => load({ commands: { test: 'npx jest {files}' }, testReport: 'jest' }), /must contain \{report\}/);
  assert.throws(() => load({ commands: { test: 'x {files} {report}' }, testReport: 'tap' }), /"testReport" is one of jest, vitest, junit/);
  assert.equal(load({ commands: { test: 'npx jest {files} --json --outputFile={report}' }, testReport: 'jest' }).packages[0].testReport, 'jest');
});

test('agents: the reviewer writes nothing, the test-writer only tests, the implementer no tests, in any stage', () => {
  assert.match(decideAgent('gated-pipeline:reviewer', 'test'), /reviewer reports and does not change files/);
  assert.match(decideAgent('reviewer', 'source'), /does not change files/);
  assert.match(decideAgent('gated-pipeline:test-writer', 'source'), /test files only/);
  assert.equal(decideAgent('gated-pipeline:test-writer', 'test'), null);
  assert.match(decideAgent('gated-pipeline:implementer', 'test'), /does not write tests/);
  assert.equal(decideAgent('gated-pipeline:implementer', 'source'), null);
  for (const other of [undefined, '', 'general-purpose', 'my-reviewer-bot']) assert.equal(decideAgent(other, 'source'), null, String(other));
  // a hotfix lets the main session touch tests during implementation; the implementer agent still may not
  assert.equal(decidePath(cfg, { stage: 'implementation', type: 'hotfix' }, 'server/src/a.spec.ts'), null);
  assert.match(decidePath(cfg, { stage: 'implementation', type: 'hotfix' }, 'server/src/a.spec.ts', 'gated-pipeline:implementer'), /does not write tests/);
  assert.match(decidePath(cfg, { stage: 'validation', type: 'feature' }, 'server/src/a.spec.ts', 'gated-pipeline:reviewer'), /does not change files/);
  assert.match(decideRecords('zcat .git/gated-holdout/sub.bin'), /held-out tests stay hidden/);
  assert.match(decideRecordsPath('/r/.git/gated-holdout/sub.bin'), /held-out tests stay hidden/);
});

test('review block: findings are read by kind; no block means no review', () => {
  assert.equal(parseReview('looks fine to me'), null);
  assert.deepEqual(parseReview('all good\nGATED-REVIEW'), []);
  assert.deepEqual(parseReview('I will end with GATED-REVIEW.\nBLOCKING: a draft, dropped\n\nGATED-REVIEW\nADVISORY: kept'), [{ kind: 'advisory', text: 'kept' }], 'the closing block counts');
  assert.deepEqual(parseReview('GATED-REVIEW\nBLOCKING: a.ts:3 empty input -> crash, but AC-2\n- **ADVISORY**: b.ts:9 slow on big lists\n'), [
    { kind: 'blocking', text: 'a.ts:3 empty input -> crash, but AC-2' },
    { kind: 'advisory', text: 'b.ts:9 slow on big lists' },
  ]);
});
