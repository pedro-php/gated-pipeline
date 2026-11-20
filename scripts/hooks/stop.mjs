#!/usr/bin/env node
// Stop: one reminder when the session stops in the middle of a working stage.
// SubagentStop: records the reviewer's closing GATED-REVIEW block as evidence,
// unless the hand-back hook already did (see handback.mjs).
import { emit, readInput } from './io.mjs';
import { configFor, hint } from '../lib/pipeline.mjs';
import { findReview, recordReview } from '../lib/review.mjs';
import { findRoot, loadState } from '../lib/state.mjs';

const WORKING = ['test', 'implementation', 'validation', 'docs'];
const input = readInput();
const root = findRoot(input.cwd ?? process.cwd());
if (!root) process.exit(0);

try {
  const state = loadState(root);
  if (input.hook_event_name === 'SubagentStop') {
    if (/(^|:)reviewer$/.test(input.agent_type ?? '') && state.stage === 'validation') {
      const report = findReview(input);
      if (report) recordReview(root, configFor(root), report, input.agent_id);
      else if (!(input.agent_id && state.evidence.review?.agentId === input.agent_id) && !input.stop_hook_active) emit({ decision: 'block', reason: 'gated-pipeline: end your report with the GATED-REVIEW block (BLOCKING: / ADVISORY: lines, or none), so the review can be recorded.' });
    }
  } else if (WORKING.includes(state.stage) && !input.stop_hook_active) {
    emit({ decision: 'block', reason: `gated-pipeline: item "${state.item}" is still at stage "${state.stage}". Next: ${hint(state)}. If you need the user, ask with AskUserQuestion.` });
  }
} catch (e) {
  process.stderr.write(`gated-pipeline stop hook error: ${e.message}\n`);
}
