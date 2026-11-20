// Project configuration: `gated.config.json` at the repository root.
import fs from 'node:fs';
import path from 'node:path';
import { FORMATS } from './test-report.mjs';
import { fail, matchesAny } from './util.mjs';

export const CONFIG_FILE = 'gated.config.json';
export const STATE_DIR = '.gated';

const PACKAGE_DEFAULTS = {
  root: '.',
  source: ['src/**'],
  tests: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
  // Files an implementer could loosen to make a check pass.
  protected: [
    'jest.config.*',
    'vitest.config.*',
    'stryker.config.*',
    'stryker.conf.*',
    'tsconfig*.json',
    '.eslintrc*',
    'eslint.config.*',
  ],
  // test: runs the given test files, `{files}` is replaced by their paths.
  // testAll, lint, typecheck, build: optional whole-package commands.
  commands: {},
  // 'jest' | 'vitest' | 'junit': the per-test report `commands.test` writes to `{report}`.
  testReport: undefined,
  // Test files with this in their name are held out: hidden from the implementation stage.
  holdout: ['**/*.holdout.*'],
  // false = this package has no mutation gate. Otherwise { adapter, ... }.
  mutation: undefined,
};

const DEFAULTS = {
  baseBranch: 'development',
  // 'always' = interview before every spec; 'auto' = only when the request is ambiguous.
  interview: 'always',
  // Optional cap on interview rounds (one round = one batch of questions). null = no cap.
  interviewMaxRounds: null,
  // true = before the user is asked to approve a spec, an agent that has seen nothing else reads it.
  specCheck: true,
  // true = every item needs held-out tests for each criterion (see lib/holdout.mjs).
  holdout: true,
  // Mutation runs allowed at the same time across the repository's worktrees. 0 = no limit.
  heavySlots: 2,
  // How long a mutation run waits for a free slot before it gives up.
  heavySlotWaitMinutes: 120,
  docs: {
    records: 'docs/items',
    changelog: 'CHANGELOG.md',
    // Paths that are documentation: editable in the docs stage, and outside the code hash.
    paths: ['docs/**', '**/*.md'],
  },
  hotfix: { checks: ['typecheck', 'build', 'test'] },
  checkTimeoutMinutes: 15,
  // Shell commands run in a new worktree (install or link dependencies).
  // GATED_MAIN_ROOT is the main checkout.
  setup: [],
  packages: [{ name: 'root' }],
};

// Every setting the pipeline reads. A key that is not here is a mistake in the
// file (a typo, a setting put one level too high), and a mistake that is
// silently ignored turns a gate off without anyone deciding to.
const KNOWN = {
  '': ['$schema', 'baseBranch', 'interview', 'interviewMaxRounds', 'specCheck', 'holdout', 'heavySlots', 'heavySlotWaitMinutes', 'heavySlotPollMs', 'docs', 'hotfix', 'checkTimeoutMinutes', 'setup', 'packages'],
  docs: ['records', 'changelog', 'paths'],
  hotfix: ['checks', 'baseBranch'],
  package: ['name', 'root', 'source', 'tests', 'protected', 'holdout', 'commands', 'testReport', 'mutation'],
  commands: ['test', 'testAll', 'lint', 'typecheck', 'build'],
  mutation: ['adapter', 'runner', 'staticTests', 'concurrency', 'timeoutMinutes', 'maxFilesPerRun', 'command', 'report'],
};

// Edit distance, for "did you mean".
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

function unknownKeys(value, kind, where, problems) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (KNOWN[kind].includes(key)) continue;
    const near = KNOWN[kind].map((k) => [distance(key.toLowerCase(), k.toLowerCase()), k]).sort((a, b) => a[0] - b[0])[0];
    const elsewhere = Object.entries(KNOWN).find(([k, keys]) => k !== kind && keys.includes(key))?.[0];
    const hint = near[0] <= 2 ? ` (did you mean "${near[1]}"?)` : elsewhere !== undefined ? ` (it belongs ${elsewhere === '' ? 'at the top level' : elsewhere === 'package' ? 'in a package' : `under "${elsewhere}"`})` : '';
    problems.push(`${where}"${key}" is not a setting${hint}`);
  }
}

// -> what is wrong with the file as the user wrote it; empty when nothing is.
export function configProblems(user) {
  const problems = [];
  unknownKeys(user, '', '', problems);
  unknownKeys(user.docs, 'docs', 'docs: ', problems);
  unknownKeys(user.hotfix, 'hotfix', 'hotfix: ', problems);
  if (user.interview !== undefined && !['always', 'auto'].includes(user.interview)) problems.push('"interview" is "always" or "auto"');
  if (user.packages !== undefined && !Array.isArray(user.packages)) problems.push('"packages" is a list');
  for (const [i, p] of (Array.isArray(user.packages) ? user.packages : []).entries()) {
    const where = `package ${p?.name ? `"${p.name}"` : `#${i + 1}`}: `;
    unknownKeys(p, 'package', where, problems);
    unknownKeys(p?.commands, 'commands', `${where}commands: `, problems);
    unknownKeys(p?.mutation, 'mutation', `${where}mutation: `, problems);
    for (const key of ['source', 'tests', 'protected', 'holdout']) if (p?.[key] !== undefined && !Array.isArray(p[key])) problems.push(`${where}"${key}" is a list of globs`);
    if (p?.mutation && typeof p.mutation === 'object' && !['stryker', 'command'].includes(p.mutation.adapter)) problems.push(`${where}mutation: "adapter" is "stryker" or "command"`);
  }
  return problems;
}

export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      fail(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
    }
    const problems = configProblems(user);
    if (problems.length) fail(`${CONFIG_FILE}:\n  ${problems.join('\n  ')}`);
  }
  const cfg = {
    ...DEFAULTS,
    ...user,
    docs: { ...DEFAULTS.docs, ...user.docs },
    hotfix: { ...DEFAULTS.hotfix, ...user.hotfix },
  };
  cfg.packages = (user.packages ?? DEFAULTS.packages).map((p) => ({
    ...PACKAGE_DEFAULTS,
    ...p,
    root: (p.root ?? '.').replace(/\/+$/, '') || '.',
    commands: { ...p.commands },
  }));
  for (const p of cfg.packages) {
    if (!p.name) fail(`${CONFIG_FILE}: every package needs a "name"`);
    if (p.testReport && !FORMATS.includes(p.testReport)) fail(`${CONFIG_FILE}: package "${p.name}": "testReport" is one of ${FORMATS.join(', ')}`);
    if (p.testReport && !p.commands.test?.includes('{report}')) fail(`${CONFIG_FILE}: package "${p.name}": with "testReport", "commands.test" must contain {report}, the file the runner writes its report to`);
  }
  return cfg;
}

// The package that owns a repo-relative path (longest root wins), with the path inside it.
export function packageOf(cfg, rel) {
  let best = null;
  for (const p of cfg.packages) {
    const inside = p.root === '.' ? rel : rel.startsWith(`${p.root}/`) ? rel.slice(p.root.length + 1) : null;
    if (inside === null) continue;
    if (!best || p.root.length > best.pkg.root.length) best = { pkg: p, inside };
  }
  return best;
}

// A test file of the kind that is hidden from the implementation stage.
export function isHoldout(cfg, rel) {
  const owner = packageOf(cfg, rel);
  return Boolean(cfg.holdout && owner && matchesAny(owner.inside, owner.pkg.holdout) && matchesAny(owner.inside, owner.pkg.tests));
}

// state | test | protected | docs | source | other
export function classify(cfg, rel) {
  if (rel === STATE_DIR || rel.startsWith(`${STATE_DIR}/`)) return 'state';
  const owner = packageOf(cfg, rel);
  if (owner && matchesAny(owner.inside, owner.pkg.tests)) return 'test';
  if (owner && matchesAny(owner.inside, owner.pkg.protected)) return 'protected';
  if (matchesAny(rel, cfg.docs.paths)) return 'docs';
  if (owner && matchesAny(owner.inside, owner.pkg.source)) return 'source';
  return 'other';
}
