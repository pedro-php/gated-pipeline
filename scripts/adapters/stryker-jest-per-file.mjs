// Stryker test-runner plugin `gated-jest`: the stock Jest runner, except that a
// mutant only loads the test FILES that cover it.
//
// Why: @stryker-mutator/jest-runner narrows a mutant run by test NAME only
// (`testNamePattern`). Jest still loads every test file of the run and filters
// afterwards, so each mutant pays the import cost of the whole suite. The dry
// run already tells which file each test lives in; this plugin keeps that map
// and hands Jest the covering files. Same mutants, same tests, same verdicts.
//
// The dry run happens in one worker process and mutants run in others, so the
// map is a file (GATED_JEST_MAP, or one keyed by the Stryker main process).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const mapPath = (env = process.env) => env.GATED_JEST_MAP || path.join(os.tmpdir(), `gated-jest-map-${process.ppid}.json`);

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// test id -> the files that declare a test with that id (ids are full test
// names, so two files may share one).
export function buildMap(tests) {
  const map = {};
  for (const t of tests) {
    if (!t.fileName) return null; // without file names the map cannot be trusted
    (map[t.id] ??= []).includes(t.fileName) || map[t.id].push(t.fileName);
  }
  return map;
}

// The Jest path patterns for a mutant's covering tests, or undefined to run as
// the stock runner does (no filter, unknown test, no map).
export function filesFor(map, testFilter) {
  if (!map || !testFilter || testFilter.length === 0) return undefined;
  const files = new Set();
  for (const id of testFilter) {
    if (!map[id]) return undefined;
    for (const f of map[id]) files.add(f);
  }
  return [...files].map((f) => `^${escapeRegExp(f)}$`);
}

// `staticRelated`: a static mutant (it runs when its module loads, so it has no
// covering-test list) is judged by the test files that import the mutated file,
// found by Jest's own dependency graph, instead of by every test file.
export function patchRunner(inner, file = mapPath(), { staticRelated = process.env.GATED_JEST_STATIC === 'related' } = {}) {
  let pending;
  let related;
  let map;
  const loadMap = () => {
    if (map === undefined) {
      try {
        map = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null; // not written yet: try again on the next mutant
      }
    }
    return map;
  };
  const run = inner.run.bind(inner);
  const dryRun = inner.dryRun.bind(inner);
  const mutantRun = inner.mutantRun.bind(inner);
  inner.run = (settings) => {
    if (pending) return run({ ...settings, testFiles: pending });
    if (related) return run({ ...settings, fileNamesUnderTest: related });
    return run(settings);
  };
  inner.dryRun = async (options) => {
    const result = await dryRun(options);
    if (result.status === 'complete' && Array.isArray(result.tests)) {
      map = buildMap(result.tests);
      fs.writeFileSync(file, JSON.stringify(map));
    }
    return result;
  };
  inner.mutantRun = async (options) => {
    pending = filesFor(loadMap(), options.testFilter);
    related = !pending && !options.testFilter && staticRelated && options.sandboxFileName ? [options.sandboxFileName] : undefined;
    try {
      return await mutantRun(options);
    } finally {
      pending = undefined;
      related = undefined;
    }
  };
  return inner;
}

// The stock factory, loaded from the project under test (this file lives in
// the plugin, outside the project's node_modules).
async function loadJestFactory() {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const manifest = require.resolve('@stryker-mutator/jest-runner/package.json');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const entry = pkg.exports?.['.']?.import ?? pkg.module ?? pkg.main;
  const mod = await import(pathToFileURL(path.join(path.dirname(manifest), entry)).href);
  return mod.strykerPlugins.find((p) => p.name === 'jest').factory;
}

let jestFactory = null;
let loadError = null;
try {
  jestFactory = await loadJestFactory();
} catch (e) {
  loadError = e;
}

function gatedJestFactory(injector) {
  if (!jestFactory) throw new Error(`gated-jest needs @stryker-mutator/jest-runner in the project: ${loadError?.message}`);
  return patchRunner(injector.injectFunction(jestFactory));
}
gatedJestFactory.inject = ['$injector'];

export const strykerPlugins = [{ kind: 'TestRunner', name: 'gated-jest', factory: gatedJestFactory }];
