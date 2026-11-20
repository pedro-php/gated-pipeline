// Heavy slots: at most N mutation runs at a time across the worktrees of one
// repository, so parallel items do not exhaust the machine's memory. A slot is
// a lock file in the repository's shared git directory; a slot whose owner
// process is gone is free again.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

export const slotsDir = (root) => path.join(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])), 'gated-slots');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function holder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // being written, or removed in the meantime
  }
}

// One attempt at each slot. -> the lock file taken, or null with who holds the slots.
export function tryAcquire(dir, max, owner) {
  fs.mkdirSync(dir, { recursive: true });
  const busy = [];
  for (let n = 1; n <= max; n++) {
    const file = path.join(dir, `slot-${n}.lock`);
    const current = fs.existsSync(file) ? holder(file) : null;
    if (current && !alive(current.pid)) fs.rmSync(file, { force: true });
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, ...owner, since: new Date().toISOString() }), { flag: 'wx' });
      return { file, busy: [] };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      busy.push(holder(file)?.item ?? 'unknown');
    }
  }
  return { file: null, busy };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for a slot, runs `work`, and frees the slot however `work` ends.
// -> { waitedMs, result }, or { timedOut: true, busy } when no slot came free in time.
export async function withSlot(root, { max, waitMs, owner, pollMs = 5_000, onWait = () => {} }, work) {
  if (!max) return { waitedMs: 0, result: await work() };
  const dir = slotsDir(root);
  const started = Date.now();
  let told = false;
  for (;;) {
    const { file, busy } = tryAcquire(dir, max, owner);
    if (file) {
      const release = () => fs.rmSync(file, { force: true });
      const onSignal = () => {
        release();
        process.exit(130);
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      try {
        return { waitedMs: Date.now() - started, result: await work() };
      } finally {
        release();
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    }
    if (Date.now() - started >= waitMs) return { timedOut: true, busy, waitedMs: Date.now() - started };
    if (!told) onWait(busy);
    told = true;
    await sleep(Math.min(pollMs, Math.max(50, waitMs - (Date.now() - started))));
  }
}
