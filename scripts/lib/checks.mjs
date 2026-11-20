// The executable checks behind each gate. Every check either returns its
// evidence or throws a GateError that says what to do next.
import fs from 'node:fs';
import path from 'node:path';
import { packageOf } from './config.mjs';
import { fail, fileHash, run, shellQuote } from './util.mjs';

const timeout = (cfg) => cfg.checkTimeoutMinutes * 60_000;

function testCommand(pkg, insidePaths) {
  const template = pkg.commands.test;
  const files = insidePaths.map(shellQuote).join(' ');
  return template.includes('{files}') ? template.replaceAll('{files}', files) : `${template} ${files}`;
}

// Groups repo-relative test paths by the package that owns them.
function byPackage(cfg, paths) {
  const groups = new Map();
  for (const rel of paths) {
    const owner = packageOf(cfg, rel);
    if (!owner?.pkg.commands.test) fail(`no "commands.test" configured for the package that owns ${rel} (gated.config.json)`);
    if (!groups.has(owner.pkg)) groups.set(owner.pkg, []);
    groups.get(owner.pkg).push(owner.inside);
  }
  return groups;
}

export function runTestFiles(root, cfg, paths) {
  const results = [];
  for (const [pkg, inside] of byPackage(cfg, paths)) {
    results.push({ package: pkg.name, files: inside, ...run(testCommand(pkg, inside), { cwd: path.join(root, pkg.root), timeoutMs: timeout(cfg) }) });
  }
  return results;
}

export const liveTests = (h) => h.tests.filter((f) => !f.deleted).map((f) => f.path);

export function freeze(root, h) {
  return Object.fromEntries(h.tests.map((f) => [f.path, f.deleted ? 'deleted' : fileHash(path.join(root, f.path))]));
}

// Test files that are new or changed since the last freeze.
export function unfrozenTests(root, state, h) {
  const frozen = state.frozenTests ?? {};
  return liveTests(h).filter((p) => frozen[p] !== fileHash(path.join(root, p)));
}

// RED: every new or changed test file must fail before the implementation exists.
export function redCheck(root, cfg, state, h) {
  const candidates = unfrozenTests(root, state, h);
  if (candidates.length === 0) fail('RED needs at least one new or changed test file, and there is none');
  const files = [];
  for (const rel of candidates) {
    const [r] = runTestFiles(root, cfg, [rel]);
    if (r.timedOut) fail(`${rel} timed out: a hang is not a RED proof`);
    files.push({ path: rel, code: r.code });
  }
  const green = files.filter((f) => f.code === 0).map((f) => f.path);
  if (green.length) fail(`not RED: these test files already pass, so they pin nothing yet:\n  ${green.join('\n  ')}`);
  return { files };
}

// Every acceptance criterion must be cited by id in at least one test file of the item.
export function acCoverage(root, acs, h) {
  const text = liveTests(h).map((p) => fs.readFileSync(path.join(root, p), 'utf8')).join('\n');
  const missing = acs.filter((ac) => !new RegExp(`\\b${ac.id}\\b`).test(text)).map((ac) => ac.id);
  if (missing.length) fail(`no test cites ${missing.join(', ')}: name the criterion in the test title (e.g. "AC-1: …")`);
  return { acs: acs.map((ac) => ac.id) };
}

// Tests are frozen at RED: the implementation may not touch them.
export function tamperCheck(root, state, h) {
  const frozen = state.frozenTests ?? {};
  const now = freeze(root, h);
  const changed = [...new Set([...Object.keys(frozen), ...Object.keys(now)])].filter((p) => frozen[p] !== now[p]);
  if (changed.length) fail(`test files changed after they were frozen at RED:\n  ${changed.join('\n  ')}\nRestore them; tests change only in the test or validation stage.`);
}

export function protectedCheck(h) {
  const touched = h.files.filter((f) => f.kind === 'protected').map((f) => f.path);
  if (touched.length) fail(`the item changes protected tool configuration:\n  ${touched.join('\n  ')}\nRevert it, or ask the user to make that change themselves.`);
}

export function greenCheck(root, cfg, h) {
  const tests = liveTests(h);
  if (tests.length === 0) return { runs: [] };
  const runs = runTestFiles(root, cfg, tests);
  const red = runs.filter((r) => r.code !== 0);
  if (red.length) fail(`not GREEN in ${red.map((r) => r.package).join(', ')}:\n${red.map((r) => r.tail).join('\n')}`);
  return { runs: runs.map(({ package: p, code, ms }) => ({ package: p, code, ms })) };
}

// Whole-package commands, for every package the item touches.
export function staticChecks(root, cfg, h, names = ['lint', 'typecheck', 'build', 'testAll']) {
  const touched = new Set(h.files.filter((f) => f.kind !== 'docs').map((f) => packageOf(cfg, f.path)?.pkg).filter(Boolean));
  const results = [];
  for (const pkg of touched) {
    for (const name of names) {
      const command = pkg.commands[name];
      if (!command) {
        results.push({ package: pkg.name, check: name, status: 'not configured' });
        continue;
      }
      const r = run(command, { cwd: path.join(root, pkg.root), timeoutMs: timeout(cfg) });
      if (r.code !== 0) fail(`${name} failed in ${pkg.name} (exit ${r.code}):\n${r.tail}`);
      results.push({ package: pkg.name, check: name, status: 'passed', ms: r.ms });
    }
  }
  return { results };
}
