#!/usr/bin/env node
// End-to-end proof with the real tools (needs network for `npm install`):
// a Jest project goes through the whole pipeline with the Stryker adapter, and
// the per-file runner is compared with the stock Jest runner on the same
// mutants. It must give the same verdict for every mutant, in less time.
//
//   node test/e2e/stryker-jest.e2e.mjs [--keep]
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pipeline from '../../scripts/lib/pipeline.mjs';

const GP = fileURLToPath(new URL('../../scripts/gp.mjs', import.meta.url));
const BASE_TEST_FILES = 30; // existing suite: every stock mutant run loads all of these
const LOAD_MS = 100; // cost of importing the "application" in each test file

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gated-e2e-')));
const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@e2e', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@e2e' };
delete env.NODE_TEST_CONTEXT;
const sh = (cwd, file, args) => execFileSync(file, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const gp = (cwd, ...args) => {
  const r = spawnSync('node', [GP, ...args], { cwd, env, encoding: 'utf8' });
  process.stdout.write(`$ gp ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r;
};
const testFile = (name, body) => `require('../src/heavy');\nconst c = require('../src/calc');\ntest('${name}', () => { ${body} });\n`;

// --- the project, on the base branch ---
write(repo, 'package.json', JSON.stringify({ name: 'e2e', private: true, jest: { testEnvironment: 'node' } }));
write(repo, '.gitignore', 'node_modules\n.stryker-tmp\n');
write(repo, 'src/heavy.js', `const end = Date.now() + ${LOAD_MS};\nwhile (Date.now() < end);\nmodule.exports = {};\n`);
write(repo, 'src/calc.js', 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
for (let i = 0; i < BASE_TEST_FILES; i++) write(repo, `test/base${i}.test.js`, testFile(`base ${i} add`, 'expect(c.add(2, 3)).toBe(5);'));
write(
  repo,
  'gated.config.json',
  JSON.stringify({
    setup: ['ln -s "$GATED_MAIN_ROOT/node_modules" node_modules'],
    docs: { changelog: false },
    holdout: false,
    packages: [{ name: 'app', source: ['src/**'], tests: ['test/**'], commands: { test: 'npx jest {files} --json --outputFile={report}' }, testReport: 'jest', mutation: { adapter: 'stryker', runner: 'jest', concurrency: 2 } }],
  }),
);
write(repo, 'stryker.config.mjs', 'export default { jest: { enableFindRelatedTests: false } };\n');
console.log(`project: ${repo}\ninstalling jest and stryker…`);
sh(repo, 'npm', ['install', '--no-audit', '--no-fund', '--save-dev', 'jest@29', '@stryker-mutator/core@10.1.1', '@stryker-mutator/jest-runner@10.1.1']);
sh(repo, 'git', ['init', '-q', '-b', 'development', '.']);
sh(repo, 'git', ['add', '-A']);
sh(repo, 'git', ['commit', '-qm', 'init']);

// --- one item through the pipeline ---
const dir = pipeline.start(repo, { type: 'feature', item: 'more-math' });
write(dir, '.gated/spec.md', '# More math\n\n### AC-1: max\nWHEN max(a, b) is called THEN it returns the larger.\nExample: max(2, 3) -> 3\n\n### AC-2: clamp\nWHEN clamp(n, lo, hi) is called THEN n is limited to [lo, hi].\nExample: clamp(5, 0, 3) -> 3\n');
pipeline.approve(dir, 'spec'); // stands in for the user's answer
assert.equal(gp(dir, 'advance').status, 0);
write(dir, 'test/max.test.js', testFile('AC-1: max', 'expect(c.max(2, 3)).toBe(3); expect(c.max(3, 2)).toBe(3);'));
write(dir, 'test/clamp.test.js', testFile('AC-2: clamp', 'expect(c.clamp(5, 0, 3)).toBe(3); expect(c.clamp(-1, 0, 3)).toBe(0);'));
assert.equal(gp(dir, 'advance').status, 0, 'RED');
const stateNow = () => JSON.parse(fs.readFileSync(path.join(dir, '.gated/state.json'), 'utf8'));
assert.deepEqual(stateNow().evidence.red.acs, [{ id: 'AC-1', red: 'failed' }, { id: 'AC-2', red: 'failed' }], "Jest's JSON report gives a result per test");
write(
  dir,
  'src/calc.js',
  'function add(a, b) { return a + b; }\nfunction max(a, b) { return a > b ? a : b; }\nfunction clamp(n, lo, hi) {\n  if (n < lo) return lo;\n  if (n > hi) return hi;\n  return n;\n}\nmodule.exports = { add, max, clamp };\n',
);
assert.equal(gp(dir, 'advance').status, 0, 'GREEN');
assert.deepEqual(stateNow().evidence.green.tests, { passed: 2, skipped: 0 });
assert.deepEqual(stateNow().evidence.green.acs, ['AC-1', 'AC-2']);

const t0 = Date.now();
const mutateRun = gp(dir, 'mutate');
const gatedMs = Date.now() - t0;
assert.equal(mutateRun.status, 1, 'the weak tests leave survivors, so the gate blocks');
const evidence = JSON.parse(fs.readFileSync(path.join(dir, '.gated/state.json'), 'utf8')).evidence.mutation;
assert.equal(evidence.complete, true);
assert.ok(evidence.survivors.length > 0);
assert.ok(evidence.survivors.every((s) => s.file === 'src/calc.js' && s.line >= 2 && s.line <= 8), 'only changed lines are mutated');

// --- the same mutants with the stock Jest runner ---
const generated = (await import(path.join(dir, '.gated/stryker-app.config.mjs'))).default;
write(dir, '.gated/stock.config.mjs', `export default ${JSON.stringify({ testRunner: 'jest', coverageAnalysis: 'perTest', concurrency: 2, mutate: generated.mutate, reporters: ['json'], jsonReporter: { fileName: path.join(dir, '.gated/stock.json') }, jest: { enableFindRelatedTests: false } })};\n`);
const t1 = Date.now();
sh(dir, 'npx', ['stryker', 'run', path.join(dir, '.gated/stock.config.mjs')]);
const stockMs = Date.now() - t1;

const verdicts = (file) => {
  const out = {};
  for (const f of Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).files)) {
    for (const m of f.mutants) out[`${m.location.start.line}:${m.location.start.column}:${m.mutatorName}:${m.replacement}`] = m.status;
  }
  return out;
};
const stock = verdicts(path.join(dir, '.gated/stock.json'));
const gated = verdicts(path.join(dir, '.gated/mutation-app.json'));
assert.deepEqual(gated, stock, 'the per-file runner must give the stock verdict for every mutant');
console.log(`\n${Object.keys(stock).length} mutants, identical verdicts. stock runner: ${(stockMs / 1000).toFixed(1)} s, per-file runner: ${(gatedMs / 1000).toFixed(1)} s (${(stockMs / gatedMs).toFixed(1)}x)`);
assert.ok(gatedMs < stockMs, 'and be faster');

// --- kill the survivors: only they run again ---
write(dir, 'test/kill.test.js', testFile('boundaries', 'expect(c.max(2, 2)).toBe(2); expect(c.max(-1, -2)).toBe(-1); expect(c.clamp(2, 0, 3)).toBe(2); expect(c.clamp(0, 0, 3)).toBe(0); expect(c.clamp(3, 0, 3)).toBe(3); expect(c.clamp(4, 0, 3)).toBe(3);'));
const again = gp(dir, 'mutate');
const after = JSON.parse(fs.readFileSync(path.join(dir, '.gated/state.json'), 'utf8')).evidence.mutation;
assert.equal(after.incremental, true, 'tests were only added, so only the survivors run again');
console.log(`after the killing tests: ${after.survivors.length} survivor(s) (exit ${again.status})`);

if (!process.argv.includes('--keep')) fs.rmSync(repo, { recursive: true, force: true });
console.log('e2e OK');
