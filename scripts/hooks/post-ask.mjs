#!/usr/bin/env node
// PostToolUse(AskUserQuestion): records a human approval. This is the only
// automatic way an approval is written, so the model cannot approve for the user.
//   "Approve spec for <item>? [spec <hash>]"  -> "Approve"
//   "Approve merge of <item>? [tree <hash>]"  -> "Approve"
// The approval is of what the dialog showed: the PreToolUse hook that filled
// this very call left a note of it. Without the note, nothing is recorded.
import { emit, readInput } from './io.mjs';
import { QUESTION, takeShown } from '../lib/approvals.mjs';
import { approve } from '../lib/pipeline.mjs';
import { findRoot, loadState } from '../lib/state.mjs';

const input = readInput();
const answers = input.tool_response?.answers ?? input.tool_input?.answers;
const root = findRoot(input.cwd ?? process.cwd());
const notes = [];
const shown = root ? takeShown(root, input.tool_use_id) : null;

if (root && answers && typeof answers === 'object') {
  for (const [question, answer] of Object.entries(answers)) {
    const m = QUESTION.exec(question);
    if (!m) continue;
    const what = m[1] === 'spec for' ? 'spec' : 'merge';
    try {
      if (m[2] !== loadState(root).item) notes.push(`the question names "${m[2]}", which is not this worktree's item`);
      else if (String(answer).trim() !== 'Approve') notes.push(`${what} not approved (the user answered: ${String(answer)})`);
      else if (!shown?.[what]) notes.push(`${what} approval not recorded: this dialog was not filled in by the pipeline, so the user did not see the text itself. Ask again; if it keeps happening, the user can run "approve ${what}" in a terminal of their own`);
      else {
        approve(root, what, { via: 'question', expect: shown[what], toolUseId: input.tool_use_id, sessionId: input.session_id });
        notes.push(`${what} approval recorded`);
      }
    } catch (e) {
      notes.push(`${what} approval not recorded: ${e.message}`);
    }
  }
}

if (notes.length) emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `gated-pipeline: ${notes.join('; ')}` } });
