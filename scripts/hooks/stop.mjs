#!/usr/bin/env node
// Stop: one reminder when the session stops in the middle of a working stage.
// SubagentStop: records the reviewer's closing GATED-REVIEW block, or the
// test-writer's GATED-SPEC-CHECK block, unless the hand-back hook already did
// (see handback.mjs).
import { emit, readInput } from './io.mjs';
import { configFor, hint } from '../lib/pipeline.mjs';
import { findReview, recordReview, recordSpecCheck } from '../lib/review.mjs';
import { findRoot, loadState } from '../lib/state.mjs';

const WORKING = ['test', 'implementation', 'validation', 'docs'];
const input = readInput();
const root = findRoot(input.cwd ?? process.cwd());
if (!root) process.exit(0);

try {
  const state = loadState(root);
  if (input.hook_event_name === 'SubagentStop') {
    const role = /(?:^|:)(reviewer|test-writer)$/.exec(input.agent_type ?? '')?.[1];
    const again = (seen, what) => {
      if (!(input.agent_id && seen?.agentId === input.agent_id) && !input.stop_hook_active) emit({ decision: 'block', reason: `gated-pipeline: end your report with the ${what}, so it can be recorded.` });
    };
    if (role === 'reviewer' && state.stage === 'validation') {
      const report = findReview(input);
      if (report) recordReview(root, configFor(root), report, input.agent_id);
      else again(state.evidence.review, 'GATED-REVIEW block (BLOCKING: / ADVISORY: lines, or none)');
    } else if (role === 'test-writer' && state.stage === 'spec' && configFor(root).specCheck) {
      const report = findReview(input, 'GATED-SPEC-CHECK');
      if (report) recordSpecCheck(root, report, input.agent_id);
      else again(state.evidence.specCheck, 'GATED-SPEC-CHECK block (UNCLEAR: lines, or none)');
    }
  } else if (WORKING.includes(state.stage) && !input.stop_hook_active) {
    emit({ decision: 'block', reason: `gated-pipeline: item "${state.item}" is still at stage "${state.stage}". Next: ${hint(state)}. If you need the user, ask with AskUserQuestion.` });
  }
} catch (e) {
  process.stderr.write(`gated-pipeline stop hook error: ${e.message}\n`);
}
