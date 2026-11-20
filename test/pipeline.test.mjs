// The gates, on a real git repository: what each stage refuses and what lets it through.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as pipeline from '../scripts/lib/pipeline.mjs';
import { loadState } from '../scripts/lib/state.mjs';
import { commit, DEFAULT_CONFIG, gp, hook, IMPL, makeRepo, RED_TEST, sh, SPEC, write } from './helpers.mjs';

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

test('back: returns to an earlier stage, voids the merge approval, and changed tests must be RED again', async () => {
  const { dir } = await itemAtMerge();
  pipeline.approve(dir, 'merge');
  blocked(() => pipeline.back(dir, 'docs'), /"back" goes to/);
  const state = pipeline.back(dir, 'test');
  assert.equal(state.stage, 'test');
  assert.equal(state.round, 2);
  assert.equal(state.approvals.merge, undefined);
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
  const s = gp(dir, 'status');
  assert.equal(s.code, 0);
  assert.match(s.out, /feature "sub" -> stage "spec"[\s\S]*Approve spec for sub\?/);
  assert.equal(gp(path.dirname(dir), 'status').code, 1, 'no item outside a worktree');
});
