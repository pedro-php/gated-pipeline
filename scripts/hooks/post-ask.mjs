#!/usr/bin/env node
// PostToolUse(AskUserQuestion): records a human approval. This is the only
// automatic way an approval is written, so the model cannot approve for the user.
//   "Approve spec for <item>?"  -> "Approve"
//   "Approve merge of <item>?"  -> "Approve"
import { emit, readInput } from './io.mjs';
import { approve } from '../lib/pipeline.mjs';
import { findRoot, loadState } from '../lib/state.mjs';

const input = readInput();
const answers = input.tool_response?.answers ?? input.tool_input?.answers;
const root = findRoot(input.cwd ?? process.cwd());
const notes = [];

if (root && answers && typeof answers === 'object') {
  for (const [question, answer] of Object.entries(answers)) {
    const m = /Approve (spec for|merge of) ([a-z0-9-]+)\?/.exec(question);
    if (!m) continue;
    const what = m[1] === 'spec for' ? 'spec' : 'merge';
    try {
      if (m[2] !== loadState(root).item) notes.push(`the question names "${m[2]}", which is not this worktree's item`);
      else if (String(answer).trim() !== 'Approve') notes.push(`${what} not approved (the user answered: ${String(answer)})`);
      else {
        approve(root, what);
        notes.push(`${what} approval recorded`);
      }
    } catch (e) {
      notes.push(`${what} approval not recorded: ${e.message}`);
    }
  }
}

if (notes.length) emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `gated-pipeline: ${notes.join('; ')}` } });
