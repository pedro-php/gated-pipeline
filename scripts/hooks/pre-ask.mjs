#!/usr/bin/env node
// PreToolUse(AskUserQuestion): when Claude asks for an approval, the dialog is
// rewritten to show the text being approved as the pipeline reads it from disk
// (the spec file, or the item's evidence and changed files), tagged with its
// hash. The user approves what is there, not Claude's account of it.
// "ask" keeps the dialog in front of the user; the hook never answers for them.
import { emit, readInput } from './io.mjs';
import { noteShown, presentQuestion, QUESTION } from '../lib/approvals.mjs';
import { approvalSubject } from '../lib/pipeline.mjs';
import { findRoot, loadState } from '../lib/state.mjs';
import { GateError } from '../lib/util.mjs';

const input = readInput();
const root = findRoot(input.cwd ?? process.cwd());
const questions = input.tool_input?.questions;
if (!root || !Array.isArray(questions)) process.exit(0);

const out = (fields) => emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } });

try {
  const { item } = loadState(root);
  const note = {};
  const shown = questions.map((q) => {
    const m = QUESTION.exec(q?.question ?? '');
    if (!m || m[2] !== item) return q;
    const what = m[1] === 'spec for' ? 'spec' : 'merge';
    const subject = approvalSubject(root, what);
    note[what] = subject.hash;
    return presentQuestion(q, what, subject);
  });
  if (Object.keys(note).length) {
    noteShown(root, input.tool_use_id, note);
    out({ permissionDecision: 'ask', permissionDecisionReason: 'gated-pipeline: the dialog shows the text being approved', updatedInput: { ...input.tool_input, questions: shown } });
  }
} catch (e) {
  // Nothing to approve yet (wrong stage, a spec the gate would refuse): say so before the user is asked.
  if (e instanceof GateError) out({ permissionDecision: 'deny', permissionDecisionReason: `gated-pipeline: ${e.message}` });
  else process.stderr.write(`gated-pipeline approval hook error: ${e.message}\n`);
}
