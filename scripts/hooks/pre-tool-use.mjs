#!/usr/bin/env node
// PreToolUse: blocks a write that does not belong to the item's current stage.
// Does nothing outside a worktree that holds an item.
import path from 'node:path';
import { readInput } from './io.mjs';
import { decideBash, decideEdit, decideRecords, decideRecordsPath } from '../lib/guard.mjs';
import { configFor } from '../lib/pipeline.mjs';
import { findRoot, loadState } from '../lib/state.mjs';

const input = readInput();
const tool = input.tool_name;
const cwd = input.cwd ?? process.cwd();
let reason = null;

try {
  if (tool === 'Bash') {
    const root = findRoot(cwd);
    reason = decideRecords(input.tool_input?.command ?? '');
    if (!reason && root) reason = decideBash(root, configFor(root), loadState(root), input.tool_input?.command ?? '', cwd, input.agent_type);
  } else {
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (file) {
      const abs = path.resolve(cwd, file);
      const root = findRoot(path.dirname(abs));
      reason = decideRecordsPath(abs);
      if (!reason && root) reason = decideEdit(root, configFor(root), loadState(root), abs, input.agent_type);
    }
  }
} catch (e) {
  // A broken guard must not lock the session; `advance` still checks everything.
  process.stderr.write(`gated-pipeline guard error: ${e.message}\n`);
}

if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `gated-pipeline: ${reason}` },
    }),
  );
}
