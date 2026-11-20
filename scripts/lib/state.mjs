// Item state: one JSON file per worktree, in `.gated/state.json`.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';
import { fail } from './util.mjs';

export const STAGES = {
  feature: ['spec', 'test', 'implementation', 'validation', 'docs', 'merge', 'done'],
  fix: ['spec', 'test', 'implementation', 'validation', 'docs', 'merge', 'done'],
  // Emergency button: fix it, prove it builds, ask the human, merge.
  hotfix: ['implementation', 'merge', 'done'],
};

export const stateFile = (root) => path.join(root, STATE_DIR, 'state.json');
export const specFile = (root) => path.join(root, STATE_DIR, 'spec.md');

// The worktree that owns `dir`: the nearest ancestor holding a state file.
export function findRoot(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(stateFile(current))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function loadState(root) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
  } catch (e) {
    fail(`cannot read ${stateFile(root)}: ${e.message}`);
  }
}

export function saveState(root, state) {
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  const tmp = `${stateFile(root)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile(root));
}

export function newState({ type, item, base }) {
  if (!STAGES[type]) fail(`unknown item type "${type}" (feature, fix or hotfix)`);
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(item)) fail('the item name must be kebab-case: letters, digits and dashes');
  return {
    item,
    type,
    base,
    stage: STAGES[type][0],
    round: 1,
    startedAt: new Date().toISOString(),
    approvals: {},
    frozenTests: null,
    evidence: {},
    justified: {},
    findings: [],
    log: [],
  };
}

export function nextStage(state) {
  const stages = STAGES[state.type];
  return stages[stages.indexOf(state.stage) + 1] ?? null;
}

export function logEvent(state, event, detail = {}) {
  state.log.push({ at: new Date().toISOString(), stage: state.stage, round: state.round, event, ...detail });
}
