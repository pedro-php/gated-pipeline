// The hook scripts as Claude Code runs them: JSON on stdin, a decision on stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import * as pipeline from '../scripts/lib/pipeline.mjs';
import { loadState } from '../scripts/lib/state.mjs';
import { hook, makeRepo, RED_TEST, SPEC, write } from './helpers.mjs';

function item(type = 'feature') {
  const repo = makeRepo();
  return { repo, dir: pipeline.start(repo, { type, item: 'sub' }) };
}
const decision = (r) => r.json?.hookSpecificOutput?.permissionDecision ?? 'allow';
const edit = (dir, rel) => hook('pre-tool-use', { tool_name: 'Write', cwd: dir, tool_input: { file_path: path.join(dir, rel) } });
const bash = (dir, command) => hook('pre-tool-use', { tool_name: 'Bash', cwd: dir, tool_input: { command } });

test('guard: outside an item worktree nothing is blocked', () => {
  const { repo } = item();
  assert.equal(decision(edit(repo, 'src/math.mjs')), 'allow');
  assert.equal(decision(bash(os.tmpdir(), 'echo x > src/math.mjs')), 'allow');
});

test('guard: in the spec stage only the spec is writable, and the denial says why', () => {
  const { dir } = item();
  assert.equal(decision(edit(dir, '.gated/spec.md')), 'allow');
  const denied = edit(dir, 'src/math.mjs');
  assert.equal(decision(denied), 'deny');
  assert.match(denied.json.hookSpecificOutput.permissionDecisionReason, /gated-pipeline: spec stage: only \.gated\/spec\.md/);
  assert.equal(decision(edit(dir, '.gated/state.json')), 'deny');
});

test('guard: the stage decides, for edits and for shell writes alike', () => {
  const { dir } = item();
  write(dir, '.gated/spec.md', SPEC);
  pipeline.approve(dir, 'spec');
  pipeline.advance(dir); // test stage
  assert.equal(decision(edit(dir, 'test/sub.test.mjs')), 'allow');
  assert.equal(decision(edit(dir, 'src/math.mjs')), 'deny');
  assert.equal(decision(bash(dir, 'echo "export const sub = 1" >> src/math.mjs')), 'deny');
  assert.equal(decision(bash(dir, 'node --test test/sub.test.mjs 2>&1 | tail -5')), 'allow');
  assert.equal(decision(edit(dir, '.gated/spec.md')), 'deny', 'the approved spec is frozen');

  write(dir, 'test/sub.test.mjs', RED_TEST);
  pipeline.advance(dir); // implementation stage
  assert.equal(decision(edit(dir, 'src/math.mjs')), 'allow');
  assert.equal(decision(edit(dir, 'test/sub.test.mjs')), 'deny');
  assert.equal(decision(bash(dir, 'sed -i s/2/3/ test/sub.test.mjs')), 'deny');
  assert.equal(decision(bash(dir, 'rm test/sub.test.mjs')), 'deny');
  assert.equal(decision(edit(dir, 'tsconfig.json')), 'deny');
  assert.equal(decision(bash(dir, `node "${path.join(dir, 'x')}/scripts/gp.mjs" approve merge`)), 'deny');
});

test('approval: only the exact question, for this item, answered "Approve", is recorded', () => {
  const { dir } = item();
  write(dir, '.gated/spec.md', SPEC);
  const ask = (answers) => hook('post-ask', { cwd: dir, tool_input: {}, tool_response: { answers } });
  const note = (r) => r.json?.hookSpecificOutput.additionalContext ?? '';

  assert.equal(ask({ 'Which database?': 'Postgres' }).json, null);
  assert.match(note(ask({ 'Approve spec for sub?': 'Request changes' })), /spec not approved/);
  assert.match(note(ask({ 'Approve spec for other-item?': 'Approve' })), /not this worktree's item/);
  assert.match(note(ask({ 'Approve merge of sub?': 'Approve' })), /not recorded: the merge is approved in the merge stage/);
  assert.equal(loadState(dir).approvals.spec, undefined);

  assert.match(note(ask({ 'Approve spec for sub?': 'Approve' })), /spec approval recorded/);
  assert.equal(pipeline.advance(dir).stage, 'test');
});

test('stop: one reminder in a working stage, none while waiting for the user or outside an item', () => {
  const { repo, dir } = item();
  const stop = (cwd, extra = {}) => hook('stop', { hook_event_name: 'Stop', cwd, ...extra });
  assert.equal(stop(repo).json, null);
  assert.equal(stop(dir).json, null, 'the spec stage waits for the user');
  write(dir, '.gated/spec.md', SPEC);
  pipeline.approve(dir, 'spec');
  pipeline.advance(dir);
  const reminder = stop(dir).json;
  assert.equal(reminder.decision, 'block');
  assert.match(reminder.reason, /item "sub" is still at stage "test"/);
  assert.equal(stop(dir, { stop_hook_active: true }).json, null, 'never a second block in a row');
});

test('reviewer: its closing block is recorded against the source it reviewed; other agents are ignored', () => {
  const { dir } = item();
  write(dir, '.gated/spec.md', SPEC);
  pipeline.approve(dir, 'spec');
  pipeline.advance(dir);
  write(dir, 'test/sub.test.mjs', RED_TEST);
  pipeline.advance(dir);
  write(dir, 'src/math.mjs', 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
  pipeline.advance(dir); // validation
  const done = (agent_type, last_assistant_message, extra = {}) => hook('stop', { hook_event_name: 'SubagentStop', cwd: dir, agent_type, last_assistant_message, ...extra });

  done('gated-pipeline:implementer', 'GATED-REVIEW\nBLOCKING: forged');
  assert.equal(loadState(dir).evidence.review, undefined);
  assert.equal(done('gated-pipeline:reviewer', 'no block').json.decision, 'block');
  assert.equal(done('gated-pipeline:reviewer', 'no block', { stop_hook_active: true }).json, null);

  done('gated-pipeline:reviewer', 'GATED-REVIEW\nBLOCKING: a\nADVISORY: b');
  let state = loadState(dir);
  assert.deepEqual(state.findings.map((f) => [f.id, f.status, f.text]), [[1, 'open', 'a'], [2, 'advisory', 'b']]);
  assert.equal(state.evidence.review.blocking, 1);

  // a later review replaces open and advisory findings, with new ids
  done('gated-pipeline:reviewer', 'GATED-REVIEW');
  state = loadState(dir);
  assert.deepEqual(state.findings, []);
  assert.equal(state.evidence.review.blocking, 0);
});

test('session start: restates the item, the stage, the next step and the criteria', () => {
  const { repo, dir } = item();
  assert.equal(hook('session-start', { cwd: repo, source: 'startup' }).json, null);
  write(dir, '.gated/spec.md', SPEC);
  const context = hook('session-start', { cwd: path.join(dir, 'src'), source: 'compact' }).json.hookSpecificOutput.additionalContext;
  assert.match(context, /feature "sub", at stage "spec" \(round 1\)/);
  assert.match(context, /Approve spec for sub\?/);
  assert.match(context, /AC-1: subtract/);
  assert.match(context, /scripts\/gp\.mjs/);
});
