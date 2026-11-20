// Held-out tests: tests the implementation stage never sees.
//
// An implementer that can read every test can satisfy the tests instead of
// the spec (special-casing the examples). So part of the tests, written from
// the same spec with other inputs, is taken out of the worktree once RED is
// proven and kept, packed, in the repository's git directory. The
// implementation gate brings it back and runs it. If it fails, it is taken
// out again and only the criteria concerned are named: every detail given
// about a hidden test is one the code can then be fitted to.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { git } from './git.mjs';
import { fileHash, sha256 } from './util.mjs';

export const HOLDOUT_DIR = 'gated-holdout';
const storeOf = (root, item) => path.join(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])), HOLDOUT_DIR, `${item}.bin`);

function readStore(root, item) {
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(storeOf(root, item))).toString('utf8'));
  } catch {
    return {};
  }
}

// Takes the files out of the worktree. -> { path: sha256 } of what was sealed.
export function seal(root, item, paths) {
  const files = {};
  for (const rel of paths) files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
  fs.mkdirSync(path.dirname(storeOf(root, item)), { recursive: true });
  fs.writeFileSync(storeOf(root, item), zlib.gzipSync(JSON.stringify(files)));
  for (const rel of paths) fs.rmSync(path.join(root, rel), { force: true });
  return Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, sha256(Buffer.from(text))]));
}

// Hashes of the sealed files as they are in the store (to compare with the frozen ones).
export function sealedHashes(root, item) {
  return Object.fromEntries(Object.entries(readStore(root, item)).map(([rel, text]) => [rel, sha256(Buffer.from(text))]));
}

// Puts the sealed files back into the worktree. -> their paths.
export function restore(root, item) {
  const files = readStore(root, item);
  for (const [rel, text] of Object.entries(files)) {
    // A file the implementer put at a sealed path is not overwritten: the tamper check reports it.
    if (fs.existsSync(path.join(root, rel))) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return Object.keys(files);
}

// Takes restored files out again (the store still holds them).
export function hide(root, item) {
  for (const [rel, text] of Object.entries(readStore(root, item))) {
    const abs = path.join(root, rel);
    if (fileHash(abs) === sha256(Buffer.from(text))) fs.rmSync(abs, { force: true });
  }
}

export const dropStore = (root, item) => fs.rmSync(storeOf(root, item), { force: true });
