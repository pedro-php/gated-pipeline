#!/usr/bin/env node
// PreToolUse(SubagentHandback): the reviewer's report, at the moment it is
// handed back. In sessions where subagents deliver their report through this
// tool, the report is not the run's last message, so SubagentStop cannot be
// relied on to see it. A report without the closing block is sent back.
import { emit, readInput } from './io.mjs';
import { configFor } from '../lib/pipeline.mjs';
import { parseReview, recordReview } from '../lib/review.mjs';
import { findRoot, loadState } from '../lib/state.mjs';

const input = readInput();
const root = findRoot(input.cwd ?? process.cwd());
if (!root || !/(^|:)reviewer$/.test(input.agent_type ?? '')) process.exit(0);

try {
  if (loadState(root).stage === 'validation') {
    const report = input.tool_input?.message;
    if (parseReview(report)) recordReview(root, configFor(root), report, input.agent_id);
    else emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'gated-pipeline: end your report with the GATED-REVIEW block (BLOCKING: / ADVISORY: lines, or none), so the review can be recorded.' } });
  }
} catch (e) {
  process.stderr.write(`gated-pipeline review hook error: ${e.message}\n`);
}
