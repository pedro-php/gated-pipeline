// The gates, on a real git repository: what each stage refuses and what lets it through.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as pipeline from '../scripts/lib/pipeline.mjs';
import { loadState, saveState, updateState } from '../scripts/lib/state.mjs';
import { approvals, commit, DEFAULT_CONFIG, gp, hook, IMPL, makeRepo, RED_TEST, REPORTING_CONFIG, sh, SPEC, write } from './helpers.mjs';

const blocked = (fn, pattern) => assert.throws(fn, (e) => e.name === 'Error' && pattern.test(e.message) ? true : assert.fail(`unexpected: ${e.message}`));
const stage = (dir) => loadState(dir).stage;
const KILL_LINE_2 = "import test from 'node:test';\ntest('kills:src/math.mjs:2', () => {});\n";

function review(dir, message) {
  return hook('stop', { hook_event_name: 'SubagentStop', agent_type: 'gated-pipeline:reviewer', cwd: dir, last_assistant_message: message });
}

// Drives a fresh item up to the named stage.
function itemAt(target, config = DEFAULT_CONFIG) {
  const repo = makeRepo(config);
  const dir = pipeline.start(repo, { type: 'feature', item: 'sub' });
  const steps = {
    spec: () => {},
    test: () => {
      write(dir, '.gated/spec.md', SPEC);
      pipeline.approve(dir, 'spec');
      pipeline.advance(dir);
    },
    implementation: () => {
      write(dir, 'test/sub.test.mjs', RED_TEST);
      pipeline.advance(dir);
    },
    validation: () => {
      write(dir, 'src/math.mjs', IMPL);
      pipeline.advance(dir);
    },
  };
  for (const name of Object.keys(steps)) {
    steps[name]();
    if (name === target) break;
  }
  return { repo, dir };
}

async function toDocs(dir) {
  write(dir, 'test/kill.test.mjs', KILL_LINE_2);
  await pipeline.runMutation(dir);
  review(dir, 'fine\nGATED-REVIEW');
  pipeline.advance(dir);
}

test('start: the item gets its own worktree and branch from the base branch, at the spec stage', () => {
  const { repo, dir } = itemAt('spec');
  assert.equal(dir, path.join(repo, '.claude/worktrees/sub'));
  assert.equal(sh(dir, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'gated/sub');
  assert.equal(stage(dir), 'spec');
  assert.equal(sh(repo, 'git', ['status', '--porcelain']), '', 'the main checkout stays clean');
});

test('start: setup commands run in the new worktree and can reach the main checkout; a failure is reported', () => {
  const config = { ...structuredClone(DEFAULT_CONFIG), setup: ['ln -s "$GATED_MAIN_ROOT/deps" node_modules'] };
  const repo = makeRepo(config);
  fs.mkdirSync(path.join(repo, 'deps'));
  write(repo, 'deps/marker', 'x');
  commit(repo, 'deps');
  const dir = pipeline.start(repo, { type: 'feature', item: 'sub' });
  assert.ok(fs.existsSync(path.join(dir, 'node_modules/marker')));
  write(dir, '.gated/spec.md', SPEC);
  pipeline.approve(dir, 'spec');
  assert.equal(pipeline.advance(dir).stage, 'test', 'linked dependencies do not count as a change of the item');

  const broken = makeRepo({ ...structuredClone(DEFAULT_CONFIG), setup: ['echo no network >&2; exit 7'] });
  blocked(() => pipeline.start(broken, { type: 'feature', item: 'sub' }), /setup command failed \(exit 7\)[\s\S]*no network/);
});

test('spec gate: needs a valid spec and the approval of that exact text', () => {
  const { dir } = itemAt('spec');
  blocked(() => pipeline.advance(dir), /no spec yet/);
  write(dir, '.gated/spec.md', '### AC-1: subtract\nWHEN called THEN works\n');
  blocked(() => pipeline.advance(dir), /AC-1 has no "Example:"/);
  blocked(() => pipeline.approve(dir, 'spec'), /not ready/);
  write(dir, '.gated/spec.md', SPEC);
  blocked(() => pipeline.advance(dir), /has not approved this version/);
  pipeline.approve(dir, 'spec');
  write(dir, '.gated/spec.md', `${SPEC}\nmore\n`);
  blocked(() => pipeline.advance(dir), /has not approved this version/);
  pipeline.approve(dir, 'spec');
  assert.equal(pipeline.advance(dir).stage, 'test');
});

test('spec gate: code written before the spec is approved blocks', () => {
  const { dir } = itemAt('spec');
  write(dir, '.gated/spec.md', SPEC);
  pipeline.approve(dir, 'spec');
  write(dir, 'src/math.mjs', IMPL);
  blocked(() => pipeline.advance(dir), /code changed during the spec stage/);
});

test('test gate: every criterion is cited, every new test file fails, and no code is written yet', () => {
  const { dir } = itemAt('test');
  write(dir, 'test/sub.test.mjs', RED_TEST.replace('AC-1', 'case'));
  blocked(() => pipeline.advance(dir), /no test cites AC-1/);
  write(dir, 'test/sub.test.mjs', "import test from 'node:test';\ntest('AC-1: passes already', () => {});\n");
  blocked(() => pipeline.advance(dir), /not RED[\s\S]*test\/sub\.test\.mjs/);
  write(dir, 'test/sub.test.mjs', RED_TEST);
  write(dir, 'src/math.mjs', IMPL);
  blocked(() => pipeline.advance(dir), /non-test files changed during the test stage/);
  sh(dir, 'git', ['checkout', '--', 'src/math.mjs']);
  const state = pipeline.advance(dir);
  assert.equal(state.stage, 'implementation');
  assert.deepEqual(Object.keys(state.frozenTests), ['test/sub.test.mjs']);
  assert.deepEqual(state.evidence.red.files, [{ path: 'test/sub.test.mjs', code: 1 }]);
});

const SPEC_2 = `${SPEC}\n### AC-2: add still works\nWHEN add(1, 2) is called THEN it returns 3.\nExample: add(1, 2) -> 3\n`;
const T = "import test from 'node:test';\nimport assert from 'node:assert';\nimport * as math from '../src/math.mjs';\n";
const AC1 = "test('AC-1: sub(5, 3) is 2', () => assert.equal(math.sub(5, 3), 2));\n";
const AC2 = "test('AC-2: add(1, 2) is 3', () => assert.equal(math.add(1, 2), 3));\n";

function reportingItem() {
  const repo = makeRepo(REPORTING_CONFIG);
  const dir = pipeline.start(repo, { type: 'feature', item: 'sub' });
  write(dir, '.gated/spec.md', SPEC_2);
  pipeline.approve(dir, 'spec');
  pipeline.advance(dir);
  return dir;
}

test('per-test results: a criterion counts only when a test that runs has it in its title', () => {
  const dir = reportingItem();
  write(dir, 'test/sub.test.mjs', `${T}// AC-2: add still works\n${AC1}`);
  blocked(() => pipeline.advance(dir), /no test cites AC-2: name the criterion in the test title \(e\.g\. "AC-1: …"\); a comment does not count/);
  write(dir, 'test/sub.test.mjs', `${T}${AC1}test.skip('AC-2: add(1, 2) is 3', () => {});\n`);
  blocked(() => pipeline.advance(dir), /AC-2: cited only by tests that do not run \(skipped or todo\)/);
  write(dir, 'test/sub.test.mjs', `${T}${AC1}test.todo('AC-2: add(1, 2) is 3');\n`);
  blocked(() => pipeline.advance(dir), /AC-2: cited only by tests that do not run/);

  write(dir, 'test/sub.test.mjs', `${T}${AC1}${AC2}`);
  const red = pipeline.advance(dir);
  assert.deepEqual(red.evidence.red.acs, [{ id: 'AC-1', red: 'failed' }, { id: 'AC-2', red: 'passed' }], 'each criterion is recorded as it stood before the implementation');

  write(dir, 'src/math.mjs', IMPL);
  const green = pipeline.advance(dir);
  assert.deepEqual(green.evidence.green.tests, { passed: 2, skipped: 0 });
  const evidence = pipeline.summary(dir, pipeline.configFor(dir), green);
  assert.match(evidence, /GREEN: app passed \(2 test\(s\) ran and passed\)/);
  assert.match(evidence, /- AC-1: before the implementation a test naming it failed; after it a test naming it runs and passes/);
  assert.match(evidence, /- AC-2: before the implementation its tests passed already, so they pin behaviour that held; after it/);
});

test('per-test results: a test file that cannot load yet is RED by its text, and GREEN then needs the titles', () => {
  const dir = reportingItem();
  // a named import that does not exist yet: the whole file fails before any test is known
  const named = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add, sub } from '../src/math.mjs';\n";
  write(dir, 'test/sub.test.mjs', `${named}// AC-1 and AC-2\ntest('subtracts', () => assert.equal(sub(5, 3), 2));\ntest('adds', () => assert.equal(add(1, 2), 3));\n`);
  const red = pipeline.advance(dir);
  assert.deepEqual(red.evidence.red.acs, [{ id: 'AC-1', red: 'unknown' }, { id: 'AC-2', red: 'unknown' }]);
  write(dir, 'src/math.mjs', IMPL);
  blocked(() => pipeline.advance(dir), /no test that ran and passed names AC-1, AC-2/);
});

test('per-test results: a failing run names the tests that failed, and a run with no test is not GREEN', () => {
  const dir = reportingItem();
  write(dir, 'test/sub.test.mjs', `${T}${AC1}${AC2}`);
  pipeline.advance(dir);
  blocked(() => pipeline.advance(dir), /not GREEN in app:\n  failing: test AC-1: sub\(5, 3\) is 2\n/);

  const config = structuredClone(REPORTING_CONFIG);
  config.packages[0].commands.test = 'echo "<testsuites></testsuites>" > {report}; true';
  const repo = makeRepo(config);
  const d2 = pipeline.start(repo, { type: 'hotfix', item: 'quick' });
  write(d2, 'src/math.mjs', IMPL);
  write(d2, 'test/quick.test.mjs', `${T}${AC1}`);
  blocked(() => pipeline.advance(d2), /app: the run passed without running a single test/);
});

test('held-out tests: hidden once RED is proven, run by the implementation gate, and only the criterion is named when they fail', () => {
  const config = { ...structuredClone(REPORTING_CONFIG), holdout: true };
  const repo = makeRepo(config);
  const dir = pipeline.start(repo, { type: 'feature', item: 'sub' });
  write(dir, '.gated/spec.md', SPEC);
  pipeline.approve(dir, 'spec');
  pipeline.advance(dir);
  const HIDDEN = `${T}test('AC-1: sub(10, 4) is 6', () => assert.equal(math.sub(10, 4), 6));\n`;
  const hidden = path.join(dir, 'test/sub.holdout.test.mjs');
  const store = path.join(repo, '.git/gated-holdout/sub.bin');

  write(dir, 'test/sub.test.mjs', `${T}${AC1}`);
  blocked(() => pipeline.advance(dir), /no held-out test cites AC-1[\s\S]*".holdout." in the name/);
  write(dir, 'test/sub.holdout.test.mjs', HIDDEN);
  let state = pipeline.advance(dir);
  assert.equal(state.stage, 'implementation');
  assert.deepEqual(Object.keys(state.sealed), ['test/sub.holdout.test.mjs']);
  assert.equal(fs.existsSync(hidden), false, 'out of the worktree');
  assert.equal(fs.readFileSync(store).includes('sub(10, 4)'), false, 'and not lying around as plain text');
  assert.match(gp(dir, 'status').out, /Held-out tests: 1 file\(s\), hidden until the implementation gate/);

  // code fitted to the one example it was shown
  write(dir, 'src/math.mjs', 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => (a === 5 && b === 3 ? 2 : 0);\n');
  const refusal = gp(dir, 'advance').out;
  assert.match(refusal, /BLOCKED: the visible tests pass, but 1 of 1 held-out test file\(s\) fail, for AC-1 \(attempt 1\)\. They stay hidden/);
  assert.doesNotMatch(refusal, /10|6 !==|sub\(10/, 'nothing of the hidden test leaks into the refusal');
  assert.equal(fs.existsSync(hidden), false);
  assert.match(gp(dir, 'advance').out, /attempt 2/);

  // a file put where the hidden one belongs does not replace it
  write(dir, 'test/sub.holdout.test.mjs', "import test from 'node:test';\ntest('AC-1: fine', () => {});\n");
  blocked(() => pipeline.advance(dir), /test files changed after they were frozen[\s\S]*sub\.holdout\.test\.mjs/);
  fs.rmSync(hidden);

  write(dir, 'src/math.mjs', IMPL);
  state = pipeline.advance(dir);
  assert.equal(state.stage, 'validation');
  assert.equal(state.sealed, null);
  assert.equal(fs.readFileSync(hidden, 'utf8'), HIDDEN, 'once passed, they are ordinary tests of the item');
  assert.equal(fs.existsSync(store), false);
  assert.deepEqual(state.evidence.holdout, { files: 1, attempts: 3, passed: true });
  assert.deepEqual(state.evidence.green.tests, { passed: 1, skipped: 0 }, 'the visible run; the held-out run is counted apart');
  assert.match(pipeline.summary(dir, pipeline.configFor(dir), state), /Held-out tests: 1 test file\(s\) the implementation stage never saw; they passed on attempt 3/);
});

test('held-out tests: going back shows them again, and they are hidden again at the next RED', () => {
  const config = { ...structuredClone(DEFAULT_CONFIG), holdout: true };
  const repo = makeRepo(config);
  const dir = pipeline.start(repo, { type: 'feature', item: 'sub' });
  write(dir, '.gated/spec.md', SPEC);
  pipeline.approve(dir, 'spec');
  pipeline.advance(dir);
  write(dir, 'test/sub.test.mjs', RED_TEST);
  write(dir, 'test/sub.holdout.test.mjs', RED_TEST.replace('sub(5, 3), 2', 'sub(9, 1), 8'));
  pipeline.advance(dir);
  const hidden = path.join(dir, 'test/sub.holdout.test.mjs');
  assert.equal(fs.existsSync(hidden), false);
  assert.equal(pipeline.back(dir, 'test').sealed, null);
  assert.ok(fs.existsSync(hidden));
  write(dir, 'test/sub.holdout.test.mjs', RED_TEST.replace('sub(5, 3), 2', 'sub(7, 7), 0'));
  assert.deepEqual(Object.keys(pipeline.advance(dir).sealed), ['test/sub.holdout.test.mjs']);
  assert.equal(fs.existsSync(hidden), false);
});

test('file names with accents are tracked like any other', () => {
  const { dir } = itemAt('test');
  write(dir, 'test/subtração.test.mjs', RED_TEST);
  const state = pipeline.advance(dir);
  assert.deepEqual(Object.keys(state.frozenTests), ['test/subtração.test.mjs']);
  write(dir, 'src/math.mjs', IMPL);
  assert.equal(pipeline.advance(dir).stage, 'validation');
});

test('test gate: an approved spec that changed afterwards blocks', () => {
  const { dir } = itemAt('test');
  write(dir, 'test/sub.test.mjs', RED_TEST);
  write(dir, '.gated/spec.md', `${SPEC}\n### AC-2: extra\nExample: x\n`);
  blocked(() => pipeline.advance(dir), /spec changed after the user approved it/);
});

test('implementation gate: tests must pass, untouched, with no protected file changed', () => {
  const { dir } = itemAt('implementation');
  blocked(() => pipeline.advance(dir), /not GREEN in app/);
  write(dir, 'src/math.mjs', IMPL);
  write(dir, 'test/sub.test.mjs', `${RED_TEST}// weakened\n`);
  blocked(() => pipeline.advance(dir), /changed after they were frozen[\s\S]*test\/sub\.test\.mjs/);
  write(dir, 'test/sub.test.mjs', RED_TEST);
  write(dir, 'test/extra.test.mjs', "import test from 'node:test';\ntest('x', () => {});\n");
  blocked(() => pipeline.advance(dir), /changed after they were frozen[\s\S]*test\/extra\.test\.mjs/);
  fs.rmSync(path.join(dir, 'test/extra.test.mjs'));
  write(dir, 'tsconfig.json', '{ "strict": false }');
  blocked(() => pipeline.advance(dir), /protected tool configuration[\s\S]*tsconfig\.json/);
  fs.rmSync(path.join(dir, 'tsconfig.json'));
  const state = pipeline.advance(dir);
  assert.equal(state.stage, 'validation');
  assert.equal(state.evidence.green.runs[0].code, 0);
});

test('implementation gate: a failing lint, typecheck or build command blocks', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.packages[0].commands.typecheck = 'node -e "process.exit(3)"';
  const { dir } = itemAt('implementation', config);
  write(dir, 'src/math.mjs', IMPL);
  blocked(() => pipeline.advance(dir), /typecheck failed in app \(exit 3\)/);
});

test('validation gate: needs a mutation result for this exact code, with no open survivor', async () => {
  const { dir } = itemAt('validation');
  blocked(() => pipeline.advance(dir), /no mutation result for this exact code/);
  const first = await pipeline.runMutation(dir);
  assert.deepEqual(first.open.map((s) => [s.file, s.line]), [['src/math.mjs', 2]], 'only the changed line is mutated');
  blocked(() => pipeline.advance(dir), /1 surviving mutant/);
  write(dir, 'test/kill.test.mjs', KILL_LINE_2);
  blocked(() => pipeline.advance(dir), /no mutation result for this exact code/);
  const second = await pipeline.runMutation(dir);
  assert.equal(second.open.length, 0);
  blocked(() => pipeline.advance(dir), /no review of this exact source/);
});

test('validation gate: a survivor passes with a real justification, which the summary shows', async () => {
  const { dir } = itemAt('validation');
  const { open } = await pipeline.runMutation(dir);
  blocked(() => pipeline.justify(dir, open[0].id, 'equivalent'), /full sentence/);
  blocked(() => pipeline.justify(dir, 'nope', 'this mutant only changes a log message'), /not a surviving mutant/);
  pipeline.justify(dir, open[0].id, 'this mutant only changes a log message');
  review(dir, 'GATED-REVIEW');
  assert.equal(pipeline.advance(dir).stage, 'docs');
  assert.match(pipeline.summary(dir, pipeline.configFor(dir), loadState(dir)), /accepted with a justification[\s\S]*only changes a log message/);
});

test('validation gate: an unfinished mutation run proves nothing', async () => {
  const { dir } = itemAt('validation');
  process.env.FAKE_MUTATOR_PENDING = '1';
  try {
    assert.equal((await pipeline.runMutation(dir)).evidence.complete, false);
  } finally {
    delete process.env.FAKE_MUTATOR_PENDING;
  }
  blocked(() => pipeline.advance(dir), /mutation run is incomplete/);
});

test('mutation: the same code reuses the result; added tests rerun only the survivors', async () => {
  const { dir } = itemAt('validation');
  write(dir, 'src/math.mjs', `${IMPL}export const neg = (a) => -a;\n`);
  blocked(() => pipeline.advance(dir), /non-test files changed during validation/);
  // start over with a two-line change so one survivor can be killed and one left
  const { dir: d2 } = itemAt('implementation');
  write(d2, 'src/math.mjs', `${IMPL}export const neg = (a) => -a;\n`);
  pipeline.advance(d2);
  const calls = () => fs.readFileSync(path.join(d2, '.gated/mutator-calls.log'), 'utf8').trim().split('\n');
  assert.equal((await pipeline.runMutation(d2)).open.length, 2);
  assert.equal((await pipeline.runMutation(d2)).reused, true);
  assert.equal(calls().length, 1, 'no second run for the same code');
  write(d2, 'test/kill.test.mjs', KILL_LINE_2);
  const third = await pipeline.runMutation(d2);
  assert.equal(third.evidence.incremental, true);
  assert.deepEqual(third.open.map((s) => s.line), [3]);
  assert.equal(calls().at(-1), 'src/math.mjs:2-2 src/math.mjs:3-3', 'only the lines that had survivors');
});

test('state: what is recorded while a long command runs is kept, and a stale write is refused', async () => {
  const { dir } = itemAt('validation');
  const before = loadState(dir);
  const running = pipeline.runMutation(dir); // loads the state, then waits for the tool
  review(dir, 'GATED-REVIEW\nADVISORY: recorded while the mutation run was going');
  const { state, open } = await running;
  assert.equal(open.length, 1);
  assert.deepEqual(state.findings.map((f) => f.status), ['advisory'], 'the review survived the end of the mutation run');
  assert.ok(loadState(dir).evidence.review && loadState(dir).evidence.mutation);

  blocked(() => saveState(dir, before), /state changed while this command was running/);
  assert.ok(loadState(dir).evidence.mutation, 'nothing was overwritten');
  updateState(dir, (s) => s.log.push({ event: 'note' }));
  assert.equal(loadState(dir).rev, state.rev + 1);
});

test('mutation: a wide change runs in batches of files and the results are merged', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.packages[0].mutation.maxFilesPerRun = 1;
  const { dir } = itemAt('implementation', config);
  write(dir, 'src/math.mjs', IMPL);
  write(dir, 'src/other.mjs', 'export const one = 1;\n');
  pipeline.advance(dir);
  const r = await pipeline.runMutation(dir);
  assert.deepEqual(r.open.map((s) => `${s.file}:${s.line}`).sort(), ['src/math.mjs:2', 'src/other.mjs:1']);
  const calls = fs.readFileSync(path.join(dir, '.gated/mutator-calls.log'), 'utf8').trim().split('\n');
  assert.deepEqual(calls, ['src/math.mjs:2-2', 'src/other.mjs:1-1'], 'one tool run per batch');
});

test('heavy slots: a mutation run waits for a free slot, gives up as incomplete, and frees its slot when done', async () => {
  const config = { ...structuredClone(DEFAULT_CONFIG), heavySlots: 1, heavySlotWaitMinutes: 0.005, heavySlotPollMs: 50 };
  const { repo, dir } = itemAt('validation', config);
  const slots = path.join(repo, '.git/gated-slots');
  fs.mkdirSync(slots, { recursive: true });
  const held = path.join(slots, 'slot-1.lock');
  fs.writeFileSync(held, JSON.stringify({ pid: process.pid, item: 'other-item' }));

  const waiting = await pipeline.runMutation(dir);
  assert.equal(waiting.evidence.complete, false);
  assert.match(waiting.evidence.packages[0].reason, /no mutation slot came free[\s\S]*other-item/);
  assert.equal(fs.existsSync(path.join(dir, '.gated/mutator-calls.log')), false, 'the tool never ran');

  // the holder is gone: its slot is taken over, and released after the run
  fs.writeFileSync(held, JSON.stringify({ pid: 2 ** 22 + 12345, item: 'crashed-item' }));
  const ran = await pipeline.runMutation(dir);
  assert.equal(ran.evidence.complete, true);
  assert.deepEqual(fs.readdirSync(slots), []);
});

test('mutation: a touched package must say whether it has a mutation gate', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  delete config.packages[0].mutation;
  const { dir } = itemAt('validation', config);
  await assert.rejects(pipeline.runMutation(dir), /has no "mutation" setting/);
  const off = structuredClone(DEFAULT_CONFIG);
  off.packages[0].mutation = false;
  const { dir: d2 } = itemAt('validation', off);
  const r = await pipeline.runMutation(d2);
  assert.deepEqual(r.evidence.disabled, ['app']);
  assert.equal(r.open.length, 0);
});

test('review: a blocking finding must be proven or refuted by a test', async () => {
  const { dir } = itemAt('validation');
  write(dir, 'test/kill.test.mjs', KILL_LINE_2);
  await pipeline.runMutation(dir);
  assert.equal(review(dir, 'no closing block').json.decision, 'block', 'the reviewer is asked for the block');
  review(dir, 'GATED-REVIEW\nBLOCKING: src/math.mjs:2 sub(1, 2) -> 1, but AC-1 says -1\nADVISORY: src/math.mjs:2 terse name');
  blocked(() => pipeline.advance(dir), /1 blocking finding[\s\S]*#1 src\/math\.mjs:2/);

  // a passing test refutes the finding
  write(dir, 'test/neg.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sub } from '../src/math.mjs';\ntest('sub(1, 2) is -1', () => assert.equal(sub(1, 2), -1));\n");
  const refuted = pipeline.prove(dir, 'test/neg.test.mjs', 1);
  assert.equal(refuted.failed, false);
  assert.deepEqual(refuted.state.findings.map((f) => f.status), ['refuted', 'advisory']);
  await pipeline.runMutation(dir);
  assert.equal(pipeline.advance(dir).stage, 'docs');
});

test('review: a failing test confirms the finding and reopens implementation with that test frozen', async () => {
  const { dir } = itemAt('validation');
  review(dir, 'GATED-REVIEW\nBLOCKING: src/math.mjs:2 sub(1, 2) -> wrong');
  write(dir, 'test/bug.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sub } from '../src/math.mjs';\ntest('sub is wrong on purpose', () => assert.equal(sub(1, 2), 99));\n");
  blocked(() => pipeline.prove(dir, 'src/math.mjs', 1), /not a test file of this item/);
  const proved = pipeline.prove(dir, 'test/bug.test.mjs', 1);
  assert.equal(proved.failed, true);
  assert.equal(proved.state.stage, 'implementation');
  assert.equal(proved.state.round, 2);
  assert.ok(proved.state.frozenTests['test/bug.test.mjs']);
  assert.equal(proved.state.findings[0].status, 'confirmed');
  blocked(() => pipeline.advance(dir), /not GREEN/);
});

test('docs gate: needs the item record with every criterion and a changelog entry; writes the summary', async () => {
  const { dir } = itemAt('validation');
  await toDocs(dir);
  const record = pipeline.recordFile(pipeline.configFor(dir), loadState(dir));
  blocked(() => pipeline.advance(dir), /item record is missing/);
  write(dir, record, '# sub\n');
  blocked(() => pipeline.advance(dir), /does not mention AC-1/);
  write(dir, record, '# sub\nAC-1 done\n');
  blocked(() => pipeline.advance(dir), /add an entry to CHANGELOG\.md/);
  write(dir, 'CHANGELOG.md', '# Changelog\n- sub\n');
  write(dir, 'src/math.mjs', `${IMPL}// late edit\n`);
  blocked(() => pipeline.advance(dir), /code changed during the docs stage/);
  write(dir, 'src/math.mjs', IMPL);
  assert.equal(pipeline.advance(dir).stage, 'merge');
  const text = fs.readFileSync(path.join(dir, record), 'utf8');
  assert.match(text, /^# sub\nAC-1 done\n\n<!-- gated-pipeline evidence/, 'what Claude wrote stays, the evidence is added below it');
  assert.match(text, /## Pipeline evidence/);
  assert.match(text, /RED: 1 test file/);
  assert.match(text, /Mutation: 1 mutant\(s\) on the changed lines, 0 surviving/);

  // going back and through docs again replaces the evidence instead of stacking it
  pipeline.back(dir, 'implementation');
  pipeline.advance(dir);
  await pipeline.runMutation(dir);
  pipeline.advance(dir);
  pipeline.advance(dir);
  const again = fs.readFileSync(path.join(dir, record), 'utf8');
  assert.equal(again.match(/## Pipeline evidence/g).length, 1);
  assert.match(again, /rounds: 2/);
});

async function itemAtMerge() {
  const { repo, dir } = itemAt('validation');
  await toDocs(dir);
  write(dir, pipeline.recordFile(pipeline.configFor(dir), loadState(dir)), '# sub\nAC-1 done\n');
  write(dir, 'CHANGELOG.md', '# Changelog\n- sub\n');
  pipeline.advance(dir);
  return { repo, dir };
}

test('merge: needs the approval of the exact tree, a committed item, and merges into the base branch', async () => {
  const { repo, dir } = await itemAtMerge();
  blocked(() => pipeline.merge(dir), /has not approved this exact tree/);
  pipeline.approve(dir, 'merge');
  write(dir, 'docs/late.md', 'changed after approval\n');
  blocked(() => pipeline.merge(dir), /has not approved this exact tree/);
  fs.rmSync(path.join(dir, 'docs/late.md'));
  blocked(() => pipeline.merge(dir), /commit the item first/);
  commit(dir, 'feat(sub): subtract');
  assert.equal(pipeline.merge(dir).stage, 'done');
  assert.equal(fs.readFileSync(path.join(repo, 'src/math.mjs'), 'utf8'), IMPL);
  assert.match(sh(repo, 'git', ['log', '-1', '--format=%s']), /Merge feature sub/);
});

test('merge: when the base branch has moved, the merged result is tested before the base branch moves', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  // stands in for a check that only the combination of both changes can fail
  config.packages[0].commands.typecheck = 'test ! -e src/clash.mjs';
  const repo = makeRepo(config);
  const dir = pipeline.start(repo, { type: 'feature', item: 'sub' });
  write(dir, '.gated/spec.md', SPEC);
  pipeline.approve(dir, 'spec');
  pipeline.advance(dir);
  write(dir, 'test/sub.test.mjs', RED_TEST);
  pipeline.advance(dir);
  write(dir, 'src/math.mjs', IMPL);
  pipeline.advance(dir);
  await toDocs(dir);
  write(dir, pipeline.recordFile(pipeline.configFor(dir), loadState(dir)), '# sub\nAC-1 done\n');
  write(dir, 'CHANGELOG.md', '# Changelog\n- sub\n');
  pipeline.advance(dir);
  pipeline.approve(dir, 'merge');
  commit(dir, 'feat(sub): subtract');
  const head = () => sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
  const itemHead = head();

  // another change lands on the base branch: no textual conflict, but the two do not work together
  write(repo, 'src/clash.mjs', 'export const clash = 1;\n');
  commit(repo, 'feat: something else');
  const baseHead = sh(repo, 'git', ['rev-parse', 'HEAD']).trim();
  blocked(() => pipeline.merge(dir), /"development" has moved since this item was proven, and the merged result does not pass:\ntypecheck failed in app[\s\S]*Nothing was merged/);
  assert.equal(head(), itemHead, 'the item branch is put back');
  assert.equal(sh(repo, 'git', ['rev-parse', 'HEAD']).trim(), baseHead, 'the base branch did not move');
  assert.equal(stage(dir), 'merge');

  // the clash is removed from the base branch: the merged result passes, and the approval of the same tree still holds
  sh(repo, 'git', ['rm', '-q', 'src/clash.mjs']);
  write(repo, 'src/other.mjs', 'export const other = 1;\n');
  commit(repo, 'fix: remove the clash');
  const done = pipeline.merge(dir);
  assert.equal(done.stage, 'done');
  assert.deepEqual(done.evidence.integration.static.map((s) => [s.check, s.status]).find(([c]) => c === 'typecheck'), ['typecheck', 'passed']);
  assert.ok(fs.existsSync(path.join(repo, 'src/other.mjs')) && fs.readFileSync(path.join(repo, 'src/math.mjs'), 'utf8') === IMPL);
  assert.equal(sh(repo, 'git', ['status', '--porcelain']), '');
});

test('merge: a base branch that changed the same lines is a conflict, and nothing moves', async () => {
  const { repo, dir } = await itemAtMerge();
  pipeline.approve(dir, 'merge');
  commit(dir, 'feat(sub): subtract');
  write(repo, 'src/math.mjs', 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  commit(repo, 'feat: multiply');
  const baseHead = sh(repo, 'git', ['rev-parse', 'HEAD']).trim();
  blocked(() => pipeline.merge(dir), /"gated\/sub" conflicts with "development"/);
  assert.equal(sh(dir, 'git', ['status', '--porcelain']), '', 'no half-finished merge is left behind');
  assert.equal(sh(repo, 'git', ['rev-parse', 'HEAD']).trim(), baseHead);
});

test('back: returns to an earlier stage; the approval stays with the tree it was given for, and changed tests must be RED again', async () => {
  const { repo, dir } = await itemAtMerge();
  pipeline.approve(dir, 'merge');
  blocked(() => pipeline.back(dir, 'docs'), /"back" goes to/);
  const state = pipeline.back(dir, 'test');
  assert.equal(state.stage, 'test');
  assert.equal(state.round, 2);
  assert.deepEqual(approvals(repo).map((a) => a.what), ['spec', 'merge'], 'records are never rewritten');
  blocked(() => pipeline.advance(dir), /RED needs at least one new or changed test file/);
  write(dir, 'test/sub.test.mjs', `${RED_TEST}// reworded, still passing\n`);
  blocked(() => pipeline.advance(dir), /not RED/);
});

test('hotfix: starts at implementation, checks the build, and goes straight to the merge approval', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.packages[0].commands.build = 'node -e "process.exit(0)"';
  config.packages[0].commands.lint = 'node -e "process.exit(1)"'; // not part of a hotfix
  const repo = makeRepo(config);
  const dir = pipeline.start(repo, { type: 'hotfix', item: 'fix-add' });
  assert.equal(stage(dir), 'implementation');
  write(dir, 'src/math.mjs', 'export const add = (a, b) => Number(a) + Number(b);\n');
  const state = pipeline.advance(dir);
  assert.equal(state.stage, 'merge');
  assert.deepEqual(state.evidence.green.static.map((s) => [s.check, s.status]), [['typecheck', 'not configured'], ['build', 'passed']]);
  const record = fs.readFileSync(path.join(dir, pipeline.recordFile(pipeline.configFor(dir), state)), 'utf8');
  assert.match(record, /^# hotfix: fix-add/);
  assert.match(record, /Skipped on purpose: spec, RED proof, mutation gate, review/);
  pipeline.approve(dir, 'merge');
  commit(dir, 'fix: add');
  assert.equal(pipeline.merge(dir).stage, 'done');
});

test('hotfix: uses its own base branch when configured', () => {
  const config = { ...structuredClone(DEFAULT_CONFIG), hotfix: { baseBranch: 'main' } };
  const repo = makeRepo(config);
  sh(repo, 'git', ['branch', 'main']);
  const dir = pipeline.start(repo, { type: 'hotfix', item: 'prod-down' });
  assert.equal(loadState(dir).base, 'main');
});

test('cli: a blocked gate exits 1 with the reason; status names the next step', () => {
  const { dir } = itemAt('spec');
  const r = gp(dir, 'advance');
  assert.equal(r.code, 1);
  assert.match(r.out, /^BLOCKED: no spec yet/);
  write(dir, '.gated/spec.md', '### AC-1: subtract\nWHEN called THEN works\n');
  assert.match(gp(dir, 'spec').out, /^BLOCKED: the spec is not ready:\n  AC-1 has no "Example:"/);
  write(dir, '.gated/spec.md', SPEC);
  assert.match(gp(dir, 'spec').out, /AC-1: subtract\nThe spec is well-formed/);
  const s = gp(dir, 'status');
  assert.equal(s.code, 0);
  assert.match(s.out, /feature "sub" -> stage "spec"[\s\S]*Approve spec for sub\?/);
  assert.equal(gp(path.dirname(dir), 'status').code, 1, 'no item outside a worktree');
});
