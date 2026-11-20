#!/usr/bin/env node
// SessionStart: restates the item, its stage and the next step. Cheap, and it
// survives a compaction.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emit, readInput } from './io.mjs';
import { hint } from '../lib/pipeline.mjs';
import { parseSpec } from '../lib/spec.mjs';
import { findRoot, loadState, specFile } from '../lib/state.mjs';

const input = readInput();
const root = findRoot(input.cwd ?? process.cwd());
if (!root) process.exit(0);

try {
  const state = loadState(root);
  const gp = fileURLToPath(new URL('../gp.mjs', import.meta.url));
  const acs = fs.existsSync(specFile(root)) ? parseSpec(fs.readFileSync(specFile(root), 'utf8')) : [];
  const lines = [
    `gated-pipeline: this worktree holds the ${state.type} "${state.item}", at stage "${state.stage}" (round ${state.round}).`,
    `Next: ${hint(state)}.`,
    `Pipeline CLI: node "${gp}" <status|spec|advance|mutate|justify|prove|back|merge>`,
    ...acs.map((ac) => `${ac.id}: ${ac.title}`),
  ];
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
} catch (e) {
  process.stderr.write(`gated-pipeline session hook error: ${e.message}\n`);
}
