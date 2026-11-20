#!/usr/bin/env node
// Stop: one reminder when the session stops in the middle of a working stage.
// SubagentStop: records the reviewer's closing GATED-REVIEW block as evidence.
import { emit, readInput } from './io.mjs';
import { parseReview } from '../lib/guard.mjs';
import { hashes } from '../lib/git.mjs';
import { configFor, hint } from '../lib/pipeline.mjs';
import { findRoot, loadState, logEvent, saveState } from '../lib/state.mjs';

const WORKING = ['test', 'implementation', 'validation', 'docs'];
const input = readInput();
const root = findRoot(input.cwd ?? process.cwd());
if (!root) process.exit(0);

try {
  const state = loadState(root);
  if (input.hook_event_name === 'SubagentStop') {
    if (/(^|:)reviewer$/.test(input.agent_type ?? '') && state.stage === 'validation') {
      const findings = parseReview(input.last_assistant_message);
      if (!findings) {
        if (!input.stop_hook_active) emit({ decision: 'block', reason: 'gated-pipeline: end your report with the GATED-REVIEW block (BLOCKING: / ADVISORY: lines, or none), so the review can be recorded.' });
      } else {
        let id = Math.max(0, ...state.findings.map((f) => f.id));
        const kept = state.findings.filter((f) => f.status === 'confirmed' || f.status === 'refuted');
        state.findings = kept.concat(findings.map((f) => ({ id: ++id, text: f.text, status: f.kind === 'blocking' ? 'open' : 'advisory', round: state.round })));
        state.evidence.review = { sourceHash: hashes(root, configFor(root), state.base).sourceHash, blocking: findings.filter((f) => f.kind === 'blocking').length, at: new Date().toISOString() };
        logEvent(state, 'reviewed', { blocking: state.evidence.review.blocking });
        saveState(root, state);
      }
    }
  } else if (WORKING.includes(state.stage) && !input.stop_hook_active) {
    emit({ decision: 'block', reason: `gated-pipeline: item "${state.item}" is still at stage "${state.stage}". Next: ${hint(state)}. If you need the user, ask with AskUserQuestion.` });
  }
} catch (e) {
  process.stderr.write(`gated-pipeline stop hook error: ${e.message}\n`);
}
