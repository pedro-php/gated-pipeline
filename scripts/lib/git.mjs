// Git facts about an item: what changed against the base branch, and hashes of it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classify } from './config.mjs';
import { fail, fileHash, sha256 } from './util.mjs';

export function git(root, args, { allowFail = false } = {}) {
  try {
    // quotepath off: names with accents come back as they are, not octal-escaped.
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).replace(/\n$/, '');
  } catch (e) {
    if (allowFail) return null;
    fail(`git ${args.join(' ')} failed: ${(e.stderr || e.message).trim()}`);
  }
}

export const currentBranch = (root) => git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

export function resolveBase(root, base) {
  for (const ref of [base, `origin/${base}`]) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true })) return ref;
  }
  fail(`base branch "${base}" not found (set "baseBranch" in gated.config.json)`);
}

export const mergeBase = (root, base) => git(root, ['merge-base', 'HEAD', resolveBase(root, base)]);

// Every file that differs from the merge base: committed, staged, unstaged and untracked.
export function changedFiles(root, base) {
  const mb = mergeBase(root, base);
  const files = new Map();
  for (const line of git(root, ['diff', '--name-status', '--no-renames', mb]).split('\n')) {
    if (!line) continue;
    const [status, file] = line.split('\t');
    files.set(file, { path: file, deleted: status === 'D', untracked: false });
  }
  for (const file of git(root, ['ls-files', '--others', '--exclude-standard']).split('\n')) {
    if (file) files.set(file, { path: file, deleted: false, untracked: true });
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// Line ranges the item added or changed in one file, as [start, end] pairs (1-based, inclusive).
export function changedRanges(root, base, file) {
  const abs = path.join(root, file.path);
  if (file.deleted) return [];
  if (file.untracked) {
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return lines > 0 ? [[1, lines]] : [];
  }
  const diff = git(root, ['diff', '-U0', '--no-renames', mergeBase(root, base), '--', file.path]);
  const ranges = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

function hashOf(root, files) {
  return sha256(files.map((f) => `${f.path}:${f.deleted ? 'deleted' : fileHash(path.join(root, f.path))}`).join('\n'));
}

// Hashes of the item's change, by kind of file. Documentation and pipeline
// state are outside `code`, so writing docs does not void the proof of the code.
export function hashes(root, cfg, base) {
  const all = changedFiles(root, base).map((f) => ({ ...f, kind: classify(cfg, f.path) }));
  const tracked = all.filter((f) => f.kind !== 'state');
  const tests = tracked.filter((f) => f.kind === 'test');
  const source = tracked.filter((f) => f.kind !== 'test' && f.kind !== 'docs');
  return {
    files: tracked,
    tests,
    source,
    testHash: hashOf(root, tests),
    sourceHash: hashOf(root, source),
    codeHash: hashOf(root, [...source, ...tests]),
    treeHash: hashOf(root, tracked),
  };
}

export function isClean(root) {
  return git(root, ['status', '--porcelain']) === '';
}
