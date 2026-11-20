// Stage transitions. Each `advance` runs the exit checks of the current stage;
// nothing moves forward on a sentence, only on a check that ran.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, STATE_DIR } from './config.mjs';
import * as checks from './checks.mjs';
import { currentBranch, git, hashes, isClean, resolveBase } from './git.mjs';
import { mutate, openSurvivors } from './mutation.mjs';
import { readSpec } from './spec.mjs';
import { loadState, logEvent, newState, nextStage, saveState, specFile, STAGES } from './state.mjs';
import { fail, run } from './util.mjs';

export const mainRoot = (root) => git(root, ['worktree', 'list', '--porcelain']).split('\n')[0].replace(/^worktree /, '');

// The worktree's own config wins; a config not yet committed to the base branch is read from the main checkout.
export function configFor(root) {
  const main = mainRoot(root);
  return loadConfig(fs.existsSync(path.join(root, 'gated.config.json')) ? root : main);
}

// One file per item: the record Claude writes, with the evidence the pipeline adds.
export const recordFile = (cfg, state) => `${path.posix.join(cfg.docs.records, `${state.startedAt.slice(0, 10)}-${state.item}`)}.md`;

export function start(repoRoot, { type, item, base }) {
  const cfg = loadConfig(repoRoot);
  base ??= (type === 'hotfix' && cfg.hotfix.baseBranch) || cfg.baseBranch;
  const baseRef = resolveBase(repoRoot, base);
  const dir = path.join(mainRoot(repoRoot), '.claude', 'worktrees', item);
  if (fs.existsSync(dir)) fail(`${dir} already exists: enter it, or pick another item name`);
  git(repoRoot, ['worktree', 'add', '-b', `gated/${item}`, dir, baseRef]);
  init(dir, { type, item, base });
  // A new worktree has no installed dependencies: `setup` commands provide them.
  for (const command of cfg.setup) {
    const r = run(command, { cwd: dir, env: { GATED_MAIN_ROOT: mainRoot(repoRoot) }, timeoutMs: cfg.checkTimeoutMinutes * 60_000 });
    if (r.code !== 0) fail(`worktree created at ${dir}, but its setup command failed (exit ${r.code}): ${command}\n${r.tail}`);
  }
  return dir;
}

export function init(root, { type, item, base }) {
  const cfg = configFor(root);
  const state = newState({ type, item, base: base ?? cfg.baseBranch });
  resolveBase(root, state.base);
  if (currentBranch(root) === state.base) fail(`this checkout is on the base branch "${state.base}": an item needs its own branch (use "start")`);
  const exclude = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']));
  const lines = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  const missing = [`${STATE_DIR}/`, '.stryker-tmp/', '.claude/worktrees/', 'node_modules'].filter((l) => !lines.split('\n').includes(l));
  if (missing.length) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${lines.endsWith('\n') || !lines ? '' : '\n'}${missing.join('\n')}\n`);
  }
  logEvent(state, 'started');
  saveState(root, state);
  return state;
}

const HINTS = {
  spec: (s) => `write ${STATE_DIR}/spec.md, then ask the user with AskUserQuestion: "Approve spec for ${s.item}?" (options "Approve" / "Request changes"), then run advance`,
  test: () => 'have the test-writer agent write failing tests that cite every AC id, then run advance (it proves RED)',
  implementation: (s) => (s.type === 'hotfix' ? 'fix the problem, then run advance' : 'have the implementer agent make the frozen tests pass, then run advance (it proves GREEN and runs lint, typecheck and build)'),
  validation: () => 'run mutate, kill or justify survivors, run the reviewer agent, prove each blocking finding with a test, then run advance',
  docs: (s) => `write the item record (docs records folder, named <date>-${s.item}.md), update the project docs and the changelog, then run advance (it adds the evidence section to the record)`,
  merge: (s) => `ask the user with AskUserQuestion: "Approve merge of ${s.item}?" (options "Approve" / "Request changes"), then run merge`,
  done: () => 'the item is merged; nothing left',
};
export const hint = (state) => HINTS[state.stage](state);

function move(root, state, to) {
  logEvent(state, 'advanced', { to });
  state.stage = to;
  saveState(root, state);
  return state;
}

function proveGreen(root, cfg, state, h, staticNames) {
  const green = checks.greenCheck(root, cfg, h);
  const stat = checks.staticChecks(root, cfg, h, staticNames);
  state.evidence.green = { codeHash: h.codeHash, sourceHash: h.sourceHash, runs: green.runs, static: stat.results, at: new Date().toISOString() };
}

export function advance(root) {
  const cfg = configFor(root);
  const state = loadState(root);
  const h = hashes(root, cfg, state.base);
  const to = nextStage(state);

  switch (state.stage) {
    case 'spec': {
      const spec = readSpec(root);
      if (spec.problems.length) fail(`the spec is not ready:\n  ${spec.problems.join('\n  ')}`);
      if (state.approvals.spec?.specHash !== spec.hash) fail(`the user has not approved this version of the spec. ${hint(state)}`);
      if (state.round === 1 && (h.source.length || h.tests.length)) fail('code changed during the spec stage; revert it (the spec comes first)');
      state.snapshot = { sourceHash: h.sourceHash };
      break;
    }
    case 'test': {
      const spec = readSpec(root);
      if (state.approvals.spec?.specHash !== spec.hash) fail('the spec changed after the user approved it: restore it, or go "back spec" and ask again');
      if (h.sourceHash !== state.snapshot?.sourceHash) fail('non-test files changed during the test stage; revert them (tests come before the implementation)');
      const coverage = checks.acCoverage(root, spec.acs, h);
      const red = checks.redCheck(root, cfg, state, h);
      state.evidence.red = { ...red, acs: coverage.acs, round: state.round, at: new Date().toISOString() };
      state.frozenTests = checks.freeze(root, h);
      break;
    }
    case 'implementation': {
      checks.protectedCheck(h);
      if (state.type === 'hotfix') {
        const names = cfg.hotfix.checks.filter((c) => c !== 'test');
        const wantsTests = cfg.hotfix.checks.includes('test');
        const green = wantsTests ? checks.greenCheck(root, cfg, h) : { runs: [] };
        const stat = checks.staticChecks(root, cfg, h, names);
        state.evidence.green = { codeHash: h.codeHash, sourceHash: h.sourceHash, runs: green.runs, static: stat.results, at: new Date().toISOString() };
        writeEvidence(root, cfg, state);
        break;
      }
      checks.tamperCheck(root, state, h);
      proveGreen(root, cfg, state, h);
      break;
    }
    case 'validation': {
      checks.protectedCheck(h);
      if (h.sourceHash !== state.evidence.green?.sourceHash) fail('non-test files changed during validation. Validation only adds tests: prove the problem with a failing test ("prove <test file>"), which reopens implementation.');
      if (h.codeHash !== state.evidence.green.codeHash) {
        try {
          proveGreen(root, cfg, state, h);
        } catch (e) {
          saveState(root, state);
          fail(`${e.message}\nIf a test added in validation fails on purpose, run "prove <test file>" to reopen implementation.`);
        }
      }
      const m = state.evidence.mutation;
      if (!m || m.codeHash !== h.codeHash) fail('no mutation result for this exact code: run "mutate"');
      if (!m.complete) fail(`the mutation run is incomplete (${m.packages.filter((p) => !p.complete).map((p) => `${p.name}: ${p.reason}`).join('; ')}): an unfinished run proves nothing, run "mutate" again`);
      const open = openSurvivors(state);
      if (open.length) fail(`${open.length} surviving mutant(s) without a killing test or a justification:\n  ${open.slice(0, 20).map((s) => `${s.id}  ${s.mutator} -> ${JSON.stringify(s.replacement)}`).join('\n  ')}`);
      if (state.evidence.review?.sourceHash !== h.sourceHash) fail('no review of this exact source: run the reviewer agent (its closing GATED-REVIEW block is recorded by a hook)');
      const blocking = state.findings.filter((f) => f.status === 'open');
      if (blocking.length) fail(`${blocking.length} blocking finding(s) are neither proven nor refuted. For each, write a test and run "prove <test file> --finding <id>":\n  ${blocking.map((f) => `#${f.id} ${f.text}`).join('\n  ')}`);
      break;
    }
    case 'docs': {
      if (h.codeHash !== state.evidence.green?.codeHash) fail('code changed during the docs stage; revert it, or go "back implementation"');
      const record = path.join(root, recordFile(cfg, state));
      if (!fs.existsSync(record)) fail(`the item record is missing: write ${recordFile(cfg, state)}`);
      const text = fs.readFileSync(record, 'utf8');
      const spec = readSpec(root);
      const missing = spec.acs.filter((ac) => !text.includes(ac.id)).map((ac) => ac.id);
      if (missing.length) fail(`the item record does not mention ${missing.join(', ')}`);
      if (cfg.docs.changelog && !h.files.some((f) => f.path === cfg.docs.changelog)) fail(`add an entry to ${cfg.docs.changelog}`);
      writeEvidence(root, cfg, state);
      break;
    }
    case 'merge':
      return fail(`the merge stage ends with "merge", after the user approves. ${hint(state)}`);
    default:
      fail('the item is done');
  }
  return move(root, state, to);
}

// Runs one test file added in validation. Failing = the problem is real:
// implementation reopens with that test frozen. Passing = the finding is refuted.
export function prove(root, file, findingId) {
  const cfg = configFor(root);
  const state = loadState(root);
  if (state.stage !== 'validation') fail('"prove" belongs to the validation stage');
  const h = hashes(root, cfg, state.base);
  const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  if (!checks.liveTests(h).includes(rel)) fail(`${rel} is not a test file of this item`);
  const finding = findingId === undefined ? null : state.findings.find((f) => String(f.id) === String(findingId));
  if (findingId !== undefined && !finding) fail(`no finding #${findingId}`);
  const [r] = checks.runTestFiles(root, cfg, [rel]);
  if (r.timedOut) fail(`${rel} timed out: neither a proof nor a refutation`);
  const failed = r.code !== 0;
  if (finding) Object.assign(finding, { status: failed ? 'confirmed' : 'refuted', test: rel });
  logEvent(state, failed ? 'proved' : 'refuted', { test: rel, finding: finding?.id });
  if (failed) {
    state.frozenTests = checks.freeze(root, h);
    state.round += 1;
    state.stage = 'implementation';
  }
  saveState(root, state);
  return { failed, state, tail: r.tail };
}

export function back(root, target) {
  const state = loadState(root);
  const stages = STAGES[state.type];
  const from = stages.indexOf(state.stage);
  const to = stages.indexOf(target);
  if (to < 0 || !['spec', 'test', 'implementation'].includes(target)) fail(`"back" goes to ${stages.filter((s) => ['spec', 'test', 'implementation'].includes(s)).join(', ')}`);
  if (to >= from || state.stage === 'done') fail(`the item is at "${state.stage}": "${target}" is not behind it`);
  const cfg = configFor(root);
  const h = hashes(root, cfg, state.base);
  if (target === 'spec') delete state.approvals.spec;
  delete state.approvals.merge;
  state.snapshot = { sourceHash: h.sourceHash };
  // The tests as they stand are the baseline: only what changes from here must be RED again.
  state.frozenTests = checks.freeze(root, h);
  state.round += 1;
  logEvent(state, 'back', { to: target });
  state.stage = target;
  saveState(root, state);
  return state;
}

// Recorded when the human answers the approval question (hook), or runs "approve" themselves.
export function approve(root, what) {
  const cfg = configFor(root);
  const state = loadState(root);
  if (what === 'spec') {
    if (state.stage !== 'spec') fail('the spec is approved in the spec stage');
    const spec = readSpec(root);
    if (spec.problems.length) fail(`the spec is not ready:\n  ${spec.problems.join('\n  ')}`);
    state.approvals.spec = { specHash: spec.hash, at: new Date().toISOString() };
  } else if (what === 'merge') {
    if (state.stage !== 'merge') fail('the merge is approved in the merge stage');
    state.approvals.merge = { treeHash: hashes(root, cfg, state.base).treeHash, at: new Date().toISOString() };
  } else fail('approve spec | approve merge');
  logEvent(state, 'approved', { what });
  saveState(root, state);
  return state;
}

export function merge(root) {
  const cfg = configFor(root);
  const state = loadState(root);
  if (state.stage !== 'merge') fail(`the item is at "${state.stage}", not at merge`);
  const h = hashes(root, cfg, state.base);
  if (state.approvals.merge?.treeHash !== h.treeHash) fail(`the user has not approved this exact tree. ${hint(state)}`);
  if (!isClean(root)) fail('commit the item first: the worktree has uncommitted changes');
  const main = mainRoot(root);
  const branch = currentBranch(root);
  if (currentBranch(main) !== state.base) fail(`the main checkout (${main}) is not on "${state.base}". Merge by hand: git merge --no-ff ${branch}`);
  if (!isClean(main)) fail(`the main checkout (${main}) has uncommitted changes. Clean it, then run merge again.`);
  const merged = git(main, ['merge', '--no-ff', '-m', `Merge ${state.type} ${state.item}`, branch], { allowFail: true });
  if (merged === null) {
    git(main, ['merge', '--abort'], { allowFail: true });
    fail(`"${branch}" conflicts with "${state.base}". Merge "${state.base}" into the item branch, go "back implementation", and prove the result again.`);
  }
  logEvent(state, 'merged', { into: state.base });
  state.stage = 'done';
  saveState(root, state);
  return state;
}

// What the pipeline can say about the item from its recorded evidence.
export function evidenceSection(state) {
  const e = state.evidence;
  const lines = ['## Pipeline evidence', '', `Base branch: \`${state.base}\` · rounds: ${state.round} · started ${state.startedAt.slice(0, 10)}`, ''];
  if (state.type === 'hotfix') lines.push('> **Hotfix.** Skipped on purpose: spec, RED proof, mutation gate, review. Open a `/fix` to pay this back with a regression test.', '');
  if (e.red) lines.push(`- RED: ${e.red.files.length} test file(s) failed before the implementation (${e.red.files.map((f) => f.path).join(', ')})`);
  if (e.green) {
    lines.push(`- GREEN: ${e.green.runs.length ? e.green.runs.map((r) => `${r.package} passed`).join(', ') : 'no test run'}`);
    for (const s of e.green.static) lines.push(`- ${s.check} (${s.package}): ${s.status}`);
  }
  if (e.mutation) {
    const m = e.mutation;
    lines.push(`- Mutation: ${m.total} mutant(s) on the changed lines, ${m.survivors.length} surviving${m.disabled.length ? `; no mutation gate in: ${m.disabled.join(', ')}` : ''}`);
  }
  const justified = (e.mutation?.survivors ?? []).filter((s) => state.justified[s.id]);
  if (justified.length) {
    lines.push('', '### Surviving mutants accepted with a justification', '', 'Approving the merge accepts each of these.', '');
    for (const s of justified) lines.push(`- \`${s.id}\` ${s.mutator} -> \`${s.replacement}\`: ${state.justified[s.id]}`);
  }
  const shown = state.findings.filter((f) => f.status !== 'open');
  if (shown.length) {
    lines.push('', '### Review findings', '');
    for (const f of shown) lines.push(`- #${f.id} [${f.status}] ${f.text}${f.test ? ` (test: ${f.test})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

// The whole picture, for `gp summary` and for a hotfix, which has no written record.
export function summary(root, cfg, state) {
  const lines = [`# ${state.type}: ${state.item}`, ''];
  if (state.type !== 'hotfix' && fs.existsSync(specFile(root))) lines.push('## Acceptance criteria', '', ...readSpec(root).acs.map((ac) => `- **${ac.id}** ${ac.title}`), '');
  return `${lines.join('\n')}${evidenceSection(state)}`;
}

const EVIDENCE_START = '<!-- gated-pipeline evidence: generated, do not edit -->';
const EVIDENCE_END = '<!-- end of gated-pipeline evidence -->';

// Puts the evidence into the item record, replacing an earlier copy of it.
function writeEvidence(root, cfg, state) {
  const file = path.join(root, recordFile(cfg, state));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const block = `${EVIDENCE_START}\n${evidenceSection(state)}${EVIDENCE_END}\n`;
  if (!fs.existsSync(file)) return fs.writeFileSync(file, `# ${state.type}: ${state.item}\n\n${block}`);
  let text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(EVIDENCE_START);
  const end = text.indexOf(EVIDENCE_END);
  if (start >= 0 && end > start) text = text.slice(0, start) + text.slice(end + EVIDENCE_END.length).replace(/^\n/, '');
  fs.writeFileSync(file, `${text.replace(/\n*$/, '\n\n')}${block}`);
}

export async function runMutation(root, { force = false } = {}) {
  const state = loadState(root);
  if (state.stage !== 'validation') fail('"mutate" belongs to the validation stage');
  const { reused, ...evidence } = await mutate(root, configFor(root), state, { force });
  state.evidence.mutation = evidence;
  logEvent(state, 'mutated', { total: evidence.total, survivors: evidence.survivors.length, reused: Boolean(reused), incremental: evidence.incremental });
  saveState(root, state);
  return { state, evidence, reused: Boolean(reused), open: openSurvivors(state) };
}

// A survivor no test can kill is accepted with a written reason; the user reads it before merging.
export function justify(root, id, reason) {
  const state = loadState(root);
  if (!(state.evidence.mutation?.survivors ?? []).some((s) => s.id === id)) fail(`"${id}" is not a surviving mutant of the last run`);
  if ((reason ?? '').trim().length < 20) fail('give the reason no test can kill this mutant (a full sentence)');
  state.justified[id] = reason.trim();
  logEvent(state, 'justified', { mutant: id });
  saveState(root, state);
  return state;
}
