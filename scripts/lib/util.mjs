// Small shared helpers. Node built-ins only: the plugin ships with no dependencies.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function fileHash(absPath) {
  try {
    return sha256(fs.readFileSync(absPath));
  } catch {
    return 'absent';
  }
}

// Supports `**`, `*` and `?`. No brace expansion: list two globs instead.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (path, globs) => (globs ?? []).some((g) => globToRegExp(g).test(path));

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The environment for a check. NODE_TEST_CONTEXT is dropped: with it, a nested
// `node --test` reports to an outer runner and exits 0 even when tests fail.
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Runs a shell command and keeps only the tail of its output: hook and CLI
// output goes back to the model, so it stays short.
export function run(command, { cwd, timeoutMs = 15 * 60_000, env } = {}) {
  const started = Date.now();
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: childEnv(env),
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  return {
    command,
    code: timedOut ? 124 : (r.status ?? 1),
    timedOut,
    ms: Date.now() - started,
    tail: out.length > 1500 ? `…${out.slice(-1500)}` : out,
  };
}

export class GateError extends Error {}
export const fail = (message) => {
  throw new GateError(message);
};
