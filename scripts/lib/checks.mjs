// The executable checks behind each gate. Every check either returns its
// evidence or throws a GateError that says what to do next.
import fs from 'node:fs';
import path from 'node:path';
import { packageOf, STATE_DIR } from './config.mjs';
import { cites, extension, readReport } from './test-report.mjs';
import { fail, fileHash, run, shellQuote } from './util.mjs';

const timeout = (cfg) => cfg.checkTimeoutMinutes * 60_000;

function testCommand(pkg, insidePaths, report) {
  const template = pkg.commands.test;
  const files = insidePaths.map(shellQuote).join(' ');
  const command = template.includes('{files}') ? template.replaceAll('{files}', files) : `${template} ${files}`;
  return command.replaceAll('{report}', shellQuote(report ?? ''));
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

// One run per package. `cases` are the per-test results when the package has
// a "testReport": an array, or null when the run left no readable report.
// Without "testReport" there is no `cases`, and only the exit code speaks.
export function runTestFiles(root, cfg, paths) {
  const results = [];
  for (const [pkg, inside] of byPackage(cfg, paths)) {
    const report = pkg.testReport ? path.join(root, STATE_DIR, `test-report-${pkg.name}.${extension(pkg.testReport)}`) : null;
    if (report) {
      fs.mkdirSync(path.dirname(report), { recursive: true });
      fs.rmSync(report, { force: true });
    }
    const r = run(testCommand(pkg, inside, report), { cwd: path.join(root, pkg.root), timeoutMs: timeout(cfg) });
    results.push({ package: pkg.name, files: inside, ...r, ...(report ? { cases: readReport(pkg.testReport, report) } : {}) });
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
  const cases = {};
  for (const rel of candidates) {
    const [r] = runTestFiles(root, cfg, [rel]);
    if (r.timedOut) fail(`${rel} timed out: a hang is not a RED proof`);
    files.push({ path: rel, code: r.code });
    if (r.cases) cases[rel] = r.cases;
  }
  const green = files.filter((f) => f.code === 0).map((f) => f.path);
  if (green.length) fail(`not RED: these test files already pass, so they pin nothing yet:\n  ${green.join('\n  ')}`);
  return { files, cases };
}

// Every acceptance criterion must be cited by id by a test of the item.
// `ran` holds the per-test results of the files just run (path -> cases).
// Where a file ran its tests, only a test's title counts, and the test must be
// one that runs: a criterion named in a comment or in a skipped test is not
// tested. A file that failed as a whole (the module it imports does not exist
// yet) has no titles to read, so its text is searched instead, as it is for
// every file when the package has no "testReport".
// -> for each criterion, how it stood before the implementation:
//    'failed' (a test naming it failed), 'passed' (its tests pass already),
//    'unknown' (cited in a file with no per-test results).
export function acCoverage(root, acs, h, ran = {}) {
  const named = (c) => acs.some((ac) => cites(c.name, ac.id));
  const withTitles = Object.keys(ran).filter((p) => ran[p].some(named));
  const titles = withTitles.flatMap((p) => ran[p]);
  const text = liveTests(h).filter((p) => !withTitles.includes(p)).map((p) => fs.readFileSync(path.join(root, p), 'utf8')).join('\n');
  const missing = [];
  const idle = [];
  const out = [];
  for (const ac of acs) {
    const mine = titles.filter((c) => cites(c.name, ac.id));
    if (mine.length && mine.every((c) => c.status === 'skipped')) idle.push(ac.id);
    else if (mine.length) out.push({ id: ac.id, red: mine.some((c) => c.status === 'failed') ? 'failed' : 'passed' });
    else if (cites(text, ac.id)) out.push({ id: ac.id, red: 'unknown' });
    else missing.push(ac.id);
  }
  if (missing.length) fail(`no test cites ${missing.join(', ')}: name the criterion in the test title (e.g. "AC-1: …")${withTitles.length ? '; a comment does not count' : ''}`);
  if (idle.length) fail(`${idle.join(', ')}: cited only by tests that do not run (skipped or todo), which prove nothing`);
  return { acs: out };
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

// GREEN: the item's tests pass. With per-test results it also means that tests
// ran at all, and (given the criteria) that each one is named by a test that
// ran and passed.
export function greenCheck(root, cfg, h, acs = null) {
  const tests = liveTests(h);
  if (tests.length === 0) return { runs: [] };
  const runs = runTestFiles(root, cfg, tests);
  const red = runs.filter((r) => r.code !== 0);
  if (red.length) {
    const names = red.flatMap((r) => (r.cases ?? []).filter((c) => c.status === 'failed').map((c) => c.name));
    fail(`not GREEN in ${red.map((r) => r.package).join(', ')}:${names.length ? `\n  failing: ${names.slice(0, 20).join('\n  failing: ')}` : ''}\n${red.map((r) => r.tail).join('\n')}`);
  }
  const reported = runs.filter((r) => 'cases' in r);
  for (const r of reported) {
    if (!r.cases) fail(`${r.package}: the tests passed but left no readable report: check that "commands.test" writes its report to {report} in the "testReport" format`);
    if (!r.cases.some((c) => c.status === 'passed')) fail(`${r.package}: the run passed without running a single test`);
  }
  const out = { runs: runs.map(({ package: p, code, ms }) => ({ package: p, code, ms })) };
  if (reported.length === 0) return out;
  const cases = reported.flatMap((r) => r.cases);
  out.tests = { passed: cases.filter((c) => c.status === 'passed').length, skipped: cases.filter((c) => c.status === 'skipped').length };
  if (acs) {
    // Files of a package without per-test results can only be searched as text.
    const untitled = runs.filter((r) => !('cases' in r)).flatMap((r) => r.files.map((f) => fs.readFileSync(path.join(root, cfg.packages.find((p) => p.name === r.package).root, f), 'utf8'))).join('\n');
    const missing = acs.filter((ac) => !cases.some((c) => c.status === 'passed' && cites(c.name, ac.id)) && !cites(untitled, ac.id)).map((ac) => ac.id);
    if (missing.length) fail(`no test that ran and passed names ${missing.join(', ')}: a criterion counts as tested only when a test with its id in the title runs (not skipped, not a comment)`);
    out.acs = acs.map((ac) => ac.id);
  }
  return out;
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
