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
  // false = this package has no mutation gate. Otherwise { adapter, ... }.
  mutation: undefined,
};

const DEFAULTS = {
  baseBranch: 'development',
  // 'always' = interview before every spec; 'auto' = only when the request is ambiguous.
  interview: 'always',
  // Optional cap on interview rounds (one round = one batch of questions). null = no cap.
  interviewMaxRounds: null,
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

export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      fail(`${CONFIG_FILE} is not valid JSON: ${e.message}`);
    }
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
