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

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Holds the state lock for the few milliseconds one read-modify-write takes.
function locked(root, work) {
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  const lock = path.join(root, STATE_DIR, 'state.lock');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released in the meantime
      }
      // A lock left by a process that died in the middle of a write is taken over.
      if (age > 10_000) fs.rmSync(lock, { force: true });
      else if (Date.now() > deadline) fail(`the item state is locked by another command (${lock}); run the command again`);
      else pause(20);
    }
  }
  try {
    return work();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function writeState(root, state) {
  const tmp = `${stateFile(root)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, stateFile(root));
}

// The revision on disk, or null when there is no state yet.
function revOnDisk(root) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')).rev ?? 0;
  } catch {
    return null;
  }
}

// Writes a state that was loaded earlier. Every write raises `rev`; a state
// loaded before someone else's write is refused instead of overwriting it
// (a gate can run for minutes between its load and its save).
export function saveState(root, state, { replace = false } = {}) {
  locked(root, () => {
    const onDisk = revOnDisk(root);
    if (!replace && onDisk !== null && onDisk !== (state.rev ?? 0)) {
      fail('the item state changed while this command was running (another pipeline command or a hook wrote it). Nothing was overwritten: run the command again.');
    }
    state.rev = (onDisk ?? 0) + 1;
    writeState(root, state);
  });
}

// Applies one change to the state as it is on disk now. For writers that
// finish long after they started (a mutation run) or cannot retry (a hook).
export function updateState(root, change) {
  return locked(root, () => {
    const state = loadState(root);
    change(state);
    state.rev = (state.rev ?? 0) + 1;
    writeState(root, state);
    return state;
  });
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
    rev: 0,
    startedAt: new Date().toISOString(),
    frozenTests: null,
    // Held-out tests now out of the worktree: { path: sha256 }, or null.
    sealed: null,
    evidence: {},
    justified: {},
    // Rulings of the reviewer on justifications: accepted ones, and the reasons of rejected ones.
    judged: {},
    rejected: {},
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
