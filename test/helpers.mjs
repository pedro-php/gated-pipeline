// Test helpers: a throwaway git repository with one package and an item worktree.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
export const FAKE_MUTATOR = fileURLToPath(new URL('./fixtures/fake-mutator.mjs', import.meta.url));

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export const sh = (cwd, file, args) => execFileSync(file, args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
export const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
export const commit = (root, message) => {
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', message]);
};

export const DEFAULT_CONFIG = {
  holdout: false, // most tests are about one gate at a time; the held-out tests have their own
  packages: [
    {
      name: 'app',
      source: ['src/**'],
      tests: ['test/**'],
      commands: { test: 'node --test {files}' },
      mutation: { adapter: 'command', command: `node ${FAKE_MUTATOR} {mutate}`, report: '.gated/report.json' },
    },
  ],
};

// The same package, with per-test results: node's own JUnit reporter writes them to {report}.
export const REPORTING_CONFIG = structuredClone(DEFAULT_CONFIG);
REPORTING_CONFIG.packages[0].commands.test = 'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination={report} {files}';
REPORTING_CONFIG.packages[0].testReport = 'junit';

// A repository on `development` with src/math.mjs and a changelog, committed.
export function makeRepo(config = DEFAULT_CONFIG) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gated-test-')));
  sh(root, 'git', ['init', '-q', '-b', 'development', '.']);
  write(root, 'gated.config.json', JSON.stringify(config));
  write(root, 'src/math.mjs', 'export const add = (a, b) => a + b;\n');
  write(root, 'CHANGELOG.md', '# Changelog\n');
  commit(root, 'init');
  return root;
}

export const SPEC = '# Subtract\n\n### AC-1: subtract\nWHEN sub(5, 3) is called THEN it returns 2.\nExample: sub(5, 3) -> 2\n';
export const RED_TEST = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sub } from '../src/math.mjs';\ntest('AC-1: sub(5, 3) is 2', () => assert.equal(sub(5, 3), 2));\n";
export const IMPL = 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n';

export function gp(cwd, ...args) {
  const r = spawnSync('node', [path.join(PLUGIN, 'scripts/gp.mjs'), ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// The approval records of a repository (they live in its shared git directory).
export const approvals = (repo, item = 'sub') => {
  const file = path.join(repo, '.git/gated-approvals', `${item}.jsonl`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

export function hook(name, input) {
  const r = spawnSync('node', [path.join(PLUGIN, 'scripts/hooks', `${name}.mjs`)], { input: JSON.stringify(input), encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}
