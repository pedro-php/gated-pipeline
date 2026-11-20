// The Stryker side: report parsing, the generated config, and the per-file Jest runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configSource, findBaseConfig, prepare } from '../scripts/adapters/stryker.mjs';
import { buildMap, filesFor, patchRunner } from '../scripts/adapters/stryker-jest-per-file.mjs';
import { batches, mutantId, parseReport } from '../scripts/lib/mutation.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gated-stryker-')));

test('report: mutants get repo-relative paths, whatever form the report uses', () => {
  const mutant = (line, status) => ({ mutatorName: 'ArithmeticOperator', replacement: 'a - b', status, location: { start: { line, column: 4 } } });
  const report = { files: { 'src/a.ts': { mutants: [mutant(3, 'Survived'), mutant(9, 'Killed')] }, '/repo/server/src/b.ts': { mutants: [mutant(1, 'NoCoverage')] } } };
  const mutants = parseReport(report, '/repo/server', 'server');
  assert.deepEqual(mutants.map((m) => [m.file, m.line, m.status]), [['server/src/a.ts', 3, 'Survived'], ['server/src/a.ts', 9, 'Killed'], ['server/src/b.ts', 1, 'NoCoverage']]);
  assert.equal(parseReport(report, '/repo/server', '.')[0].file, 'src/a.ts');
});

test('batches: a wide change is split by file, and a file is never split across batches', () => {
  const r = (file, start) => ({ file, start, end: start });
  const parts = batches([r('a.ts', 1), r('b.ts', 1), r('a.ts', 9), r('c.ts', 1)], 2);
  assert.deepEqual(parts.map((p) => p.map((x) => `${x.file}:${x.start}`)), [['a.ts:1', 'a.ts:9', 'b.ts:1'], ['c.ts:1']]);
  assert.equal(batches([r('a.ts', 1)], 40).length, 1);
});

test('mutant id: stable for the same mutant, different when the replacement differs', () => {
  const m = { file: 'src/a.ts', line: 3, col: 4, mutator: 'ArithmeticOperator', replacement: 'a - b' };
  assert.equal(mutantId(m), mutantId({ ...m }));
  assert.notEqual(mutantId(m), mutantId({ ...m, replacement: 'a * b' }));
  assert.match(mutantId(m), /^src\/a\.ts:3:4:ArithmeticOperator:[0-9a-f]{8}$/);
});

test('generated config: keeps the package config, narrows mutate to the changed lines, adds the per-file runner for Jest', async () => {
  const pkgRoot = tmp();
  const stateDir = path.join(pkgRoot, '.gated');
  fs.mkdirSync(stateDir);
  assert.equal(findBaseConfig(pkgRoot), null);
  fs.writeFileSync(path.join(pkgRoot, 'stryker.config.mjs'), "export default { inPlace: true, mutate: ['src/**'], concurrency: 9, jest: { projectType: 'custom' } };\n");
  const ranges = [{ file: 'src/a.ts', start: 3, end: 7 }, { file: 'src/a.ts', start: 20, end: 20 }];
  const plan = prepare({ pkg: { name: 'server', mutation: { adapter: 'stryker', runner: 'jest', concurrency: 4 } }, pkgRoot, stateDir, ranges });
  assert.match(plan.command, /^npx stryker run '.*stryker-server\.config\.mjs'$/);
  assert.equal(plan.env.GATED_JEST_MAP, path.join(stateDir, 'jest-map-server.json'));

  const config = (await import(pathToFileURL(path.join(stateDir, 'stryker-server.config.mjs')).href)).default;
  assert.deepEqual(config.mutate, ['src/a.ts:3-7', 'src/a.ts:20-20']);
  assert.equal(config.inPlace, true, 'the package setting survives');
  assert.deepEqual(config.jest, { projectType: 'custom' });
  assert.equal(config.concurrency, 4, 'the pipeline setting wins');
  assert.equal(config.testRunner, 'gated-jest');
  assert.equal(config.coverageAnalysis, 'perTest');
  assert.equal(config.plugins[0], '@stryker-mutator/*');
  assert.match(config.plugins[1], /stryker-jest-per-file\.mjs$/);
  assert.deepEqual(config.reporters, ['json']);
  assert.equal(config.jsonReporter.fileName, plan.report);
});

test('generated config: another runner is left as the package configured it', () => {
  const source = configSource({ basePath: null, mutate: ['src/a.ts:1-2'], report: '/r.json', options: { adapter: 'stryker' } });
  assert.doesNotMatch(source, /gated-jest|coverageAnalysis|plugins/);
});

const tests = [
  { id: 'user creates', fileName: '/p/test/user.spec.ts' },
  { id: 'user deletes', fileName: '/p/test/user.spec.ts' },
  { id: 'shared name', fileName: '/p/test/a.spec.ts' },
  { id: 'shared name', fileName: '/p/test/b.spec.ts' },
];

test('per-file runner: a mutant gets exactly the files of its covering tests', () => {
  const map = buildMap(tests);
  assert.deepEqual(filesFor(map, ['user creates', 'user deletes']), ['^/p/test/user\\.spec\\.ts$']);
  assert.deepEqual(filesFor(map, ['shared name']), ['^/p/test/a\\.spec\\.ts$', '^/p/test/b\\.spec\\.ts$'], 'a name used in two files runs both');
});

test('per-file runner: without certainty it runs as the stock runner does', () => {
  const map = buildMap(tests);
  assert.equal(filesFor(map, undefined), undefined, 'no filter: a static mutant runs every test');
  assert.equal(filesFor(map, []), undefined);
  assert.equal(filesFor(map, ['user creates', 'unknown test']), undefined, 'an unknown test id');
  assert.equal(filesFor(null, ['user creates']), undefined, 'no map');
  assert.equal(buildMap([{ id: 'x' }]), null, 'a dry run without file names gives no map');
});

// A stand-in for the stock JestTestRunner: mutantRun and dryRun both go through run().
function fakeRunner(seen) {
  return {
    async run(settings) {
      seen.push(settings);
      return { dryRunResult: { status: 'complete', tests }, jestResult: {} };
    },
    async dryRun() {
      return (await this.run({ dry: true })).dryRunResult;
    },
    async mutantRun({ testFilter }) {
      await this.run({ testNamePattern: testFilter?.join('|') });
      return { status: 'killed' };
    },
  };
}

test('per-file runner: the dry run writes the map; another process reads it and narrows each mutant', async () => {
  const mapFile = path.join(tmp(), 'map.json');
  const drySeen = [];
  await patchRunner(fakeRunner(drySeen), mapFile).dryRun({});
  assert.equal(drySeen[0].testFiles, undefined, 'the dry run itself is not narrowed');
  assert.deepEqual(JSON.parse(fs.readFileSync(mapFile, 'utf8'))['user creates'], ['/p/test/user.spec.ts']);

  const seen = [];
  const worker = patchRunner(fakeRunner(seen), mapFile); // a fresh worker: no dry run of its own
  assert.deepEqual(await worker.mutantRun({ testFilter: ['user deletes'] }), { status: 'killed' });
  assert.deepEqual(seen[0], { testNamePattern: 'user deletes', testFiles: ['^/p/test/user\\.spec\\.ts$'] });
  await worker.mutantRun({ testFilter: undefined });
  assert.equal(seen[1].testFiles, undefined, 'the filter of one mutant never leaks into the next');
});

test('per-file runner: a static mutant runs every test by default, or the tests related to its file when asked', async () => {
  const mapFile = path.join(tmp(), 'map.json');
  await patchRunner(fakeRunner([]), mapFile).dryRun({});
  const all = [];
  await patchRunner(fakeRunner(all), mapFile, { staticRelated: false }).mutantRun({ testFilter: undefined, sandboxFileName: '/p/src/app.module.ts' });
  assert.deepEqual(all[0], { testNamePattern: undefined });
  const seen = [];
  const worker = patchRunner(fakeRunner(seen), mapFile, { staticRelated: true });
  await worker.mutantRun({ testFilter: undefined, sandboxFileName: '/p/src/app.module.ts' });
  assert.deepEqual(seen[0].fileNamesUnderTest, ['/p/src/app.module.ts']);
  assert.equal(seen[0].testFiles, undefined);
  await worker.mutantRun({ testFilter: ['user creates'], sandboxFileName: '/p/src/app.module.ts' });
  assert.deepEqual(seen[1].testFiles, ['^/p/test/user\\.spec\\.ts$'], 'a covered mutant still gets its covering files');
  assert.equal(seen[1].fileNamesUnderTest, undefined);
});

test('per-file runner: no map file means every mutant runs unfiltered', async () => {
  const seen = [];
  await patchRunner(fakeRunner(seen), path.join(tmp(), 'missing.json')).mutantRun({ testFilter: ['user creates'] });
  assert.equal(seen[0].testFiles, undefined);
});
