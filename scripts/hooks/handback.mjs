#!/usr/bin/env node
// PreToolUse(SubagentHandback): the report of one of the pipeline's judges, at
// the moment it is handed back: the reviewer's review (validation stage) and
// the test-writer's cold read of the spec (spec stage). In sessions where
// subagents deliver their report through this tool, the report is not the
// run's last message, so SubagentStop cannot be relied on to see it. A report
// without what the pipeline needs from it is sent back.
import { emit, readInput } from './io.mjs';
import { configFor } from '../lib/pipeline.mjs';
import { parseReview, parseSpecCheck, recordReview, recordSpecCheck, unruled } from '../lib/review.mjs';
import { findRoot, loadState } from '../lib/state.mjs';

const input = readInput();
const root = findRoot(input.cwd ?? process.cwd());
const role = /(?:^|:)(reviewer|test-writer)$/.exec(input.agent_type ?? '')?.[1];
if (!root || !role) process.exit(0);

const sendBack = (reason) => emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `gated-pipeline: ${reason}` } });

try {
  const state = loadState(root);
  const report = input.tool_input?.message;
  if (role === 'reviewer' && state.stage === 'validation') {
    const missing = parseReview(report) ? unruled(state, report) : [];
    if (!parseReview(report)) sendBack('end your report with the GATED-REVIEW block (BLOCKING: / ADVISORY: lines, or none), so the review can be recorded.');
    else if (missing.length) sendBack(`rule on every justified survivor in the GATED-REVIEW block, with "EQUIVALENT: <id>" or "KILLABLE: <id> <the input that tells them apart>". Missing: ${missing.map((s) => s.id).join(', ')}`);
    else recordReview(root, configFor(root), report, input.agent_id);
  } else if (role === 'test-writer' && state.stage === 'spec' && configFor(root).specCheck) {
    if (parseSpecCheck(report)) recordSpecCheck(root, report, input.agent_id);
    else sendBack('end your report with the GATED-SPEC-CHECK block (UNCLEAR: lines, or none), so the check can be recorded.');
  }
} catch (e) {
  process.stderr.write(`gated-pipeline hand-back hook error: ${e.message}\n`);
}
