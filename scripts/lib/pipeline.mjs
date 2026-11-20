// Stage transitions. Each `advance` runs the exit checks of the current stage;
// nothing moves forward on a sentence, only on a check that ran.
import fs from 'node:fs';
import path from 'node:path';
import { approvalOf, describeApproval, recordApproval } from './approvals.mjs';
import { isHoldout, loadConfig, STATE_DIR } from './config.mjs';
import * as checks from './checks.mjs';
import { currentBranch, git, hashes, isClean, mergeBase, resolveBase, tryMerge } from './git.mjs';
import * as holdout from './holdout.mjs';
import { mutate, openSurvivors } from './mutation.mjs';
import { awaitingRuling } from './review.mjs';
import { readSpec } from './spec.mjs';
import { loadState, logEvent, newState, nextStage, saveState, specFile, STAGES, updateState } from './state.mjs';
import { cites } from './test-report.mjs';
import { fail, GateError, run } from './util.mjs';

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
  saveState(root, state, { replace: true });
  return state;
}

const HINTS = {
  spec: (s) => `write ${STATE_DIR}/spec.md, check it with "spec", then ask the user with AskUserQuestion: "Approve spec for ${s.item}?" (options "Approve" / "Request changes"), then run advance`,
  test: () => 'have the test-writer agent write failing tests that cite every AC id (visible tests, and held-out tests in *.holdout.* files when the project uses them), then run advance (it proves RED)',
  implementation: (s) => (s.type === 'hotfix' ? 'fix the problem, then run advance' : `have the implementer agent make the frozen tests pass, then run advance (it proves GREEN${s.sealed ? ', runs the held-out tests the implementer has not seen,' : ''} and runs lint, typecheck and build)`),
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

// Brings the held-out tests back and runs them against an implementation
// written without them. Passing: they stay, as ordinary tests of the item.
// Failing: they go back into hiding, and the refusal names the criteria only.
function proveHoldout(root, cfg, state) {
  const acs = readSpec(root).acs;
  const files = holdout.restore(root, state.item);
  const attempt = (state.evidence.holdout?.attempts ?? 0) + 1;
  let failed;
  try {
    const runs = files.map((rel) => ({ rel, ...checks.runTestFiles(root, cfg, [rel])[0] }));
    failed = runs.filter((r) => r.code !== 0);
    if (failed.length) {
      const failing = failed.flatMap((r) => (r.cases ? r.cases.filter((c) => c.status === 'failed').map((c) => c.name) : [fs.readFileSync(path.join(root, r.rel), 'utf8')]));
      state.evidence.holdout = { files: files.length, attempts: attempt, passed: false, acs: acs.filter((ac) => failing.some((text) => cites(text, ac.id))).map((ac) => ac.id) };
    }
  } finally {
    if (failed?.length !== 0) holdout.hide(root, state.item);
  }
  if (failed.length) {
    saveState(root, state);
    const named = state.evidence.holdout.acs;
    fail(`the visible tests pass, but ${failed.length} of ${files.length} held-out test file(s) fail${named.length ? `, for ${named.join(', ')}` : ''} (attempt ${attempt}). They stay hidden. The code meets the examples it was shown and not the rule behind them: read ${named.length ? 'those criteria' : 'the criteria'} in the spec again and implement what they say for every input. If the spec itself is unclear there, tell the user.`);
  }
  state.evidence.holdout = { files: files.length, attempts: attempt, passed: true };
  state.sealed = null;
  holdout.dropStore(root, state.item);
  // Saved now: the held-out tests have done their work, whatever the later checks say.
  saveState(root, state);
}

function proveGreen(root, cfg, state, h, staticNames) {
  const green = checks.greenCheck(root, cfg, h, readSpec(root).acs);
  if (state.sealed) {
    proveHoldout(root, cfg, state);
    h = hashes(root, cfg, state.base);
  }
  const stat = checks.staticChecks(root, cfg, h, staticNames);
  state.evidence.green = { codeHash: h.codeHash, sourceHash: h.sourceHash, base: mergeBase(root, state.base), runs: green.runs, tests: green.tests, acs: green.acs, static: stat.results, at: new Date().toISOString() };
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
      if (!approvalOf(root, state, 'spec', spec.hash)) fail(`the user has not approved this version of the spec. ${hint(state)}`);
      if (state.round === 1 && (h.source.length || h.tests.length)) fail('code changed during the spec stage; revert it (the spec comes first)');
      state.snapshot = { sourceHash: h.sourceHash };
      break;
    }
    case 'test': {
      const spec = readSpec(root);
      if (!approvalOf(root, state, 'spec', spec.hash)) fail('the spec changed after the user approved it: restore it, or go "back spec" and ask again');
      if (h.sourceHash !== state.snapshot?.sourceHash) fail('non-test files changed during the test stage; revert them (tests come before the implementation)');
      const red = checks.redCheck(root, cfg, state, h);
      const live = checks.liveTests(h);
      const hidden = live.filter((p) => isHoldout(cfg, p));
      const coverage = checks.acCoverage(root, spec.acs, live.filter((p) => !hidden.includes(p)), red.cases, cfg.holdout ? 'visible test' : 'test');
      if (cfg.holdout) {
        try {
          checks.acCoverage(root, spec.acs, hidden, red.cases, 'held-out test');
        } catch (e) {
          e.message += '\nHeld-out tests go in test files with ".holdout." in the name (sub.holdout.test.ts). They test the same criteria with other inputs, and the implementation stage never sees them.';
          throw e;
        }
      }
      state.evidence.red = { files: red.files, acs: coverage.acs, round: state.round, at: new Date().toISOString() };
      state.frozenTests = checks.freeze(root, h);
      // Only files this item adds can be hidden: one that is already in the base branch is in git for all to read.
      const sealable = hidden.filter((p) => git(root, ['cat-file', '-e', `${mergeBase(root, state.base)}:${p}`], { allowFail: true }) === null);
      if (sealable.length) state.sealed = holdout.seal(root, state.item, sealable);
      break;
    }
    case 'implementation': {
      checks.protectedCheck(h);
      if (state.type === 'hotfix') {
        const names = cfg.hotfix.checks.filter((c) => c !== 'test');
        const wantsTests = cfg.hotfix.checks.includes('test');
        const green = wantsTests ? checks.greenCheck(root, cfg, h) : { runs: [] };
        const stat = checks.staticChecks(root, cfg, h, names);
        state.evidence.green = { codeHash: h.codeHash, sourceHash: h.sourceHash, base: mergeBase(root, state.base), runs: green.runs, static: stat.results, at: new Date().toISOString() };
        writeEvidence(root, cfg, state);
        break;
      }
      checks.tamperCheck(root, state, h, state.sealed ? holdout.sealedHashes(root, state.item) : {});
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
      const unruled = awaitingRuling(state);
      if (unruled.length) fail(`${unruled.length} justification(s) the reviewer has not ruled on. Run the reviewer agent again: it must end with "EQUIVALENT: <id>" or "KILLABLE: <id> <input>" for each:\n  ${unruled.map((s) => `${s.id}: ${state.justified[s.id]}`).join('\n  ')}`);
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
  // Going back shows the held-out tests again: whoever changes the tests needs all of them.
  if (state.sealed) {
    holdout.restore(root, state.item);
    holdout.dropStore(root, state.item);
    state.sealed = null;
  }
  const h = hashes(root, cfg, state.base);
  // Approvals need no voiding: each is tied to a content hash, so whatever changes from here is not approved.
  state.snapshot = { sourceHash: h.sourceHash };
  // The tests as they stand are the baseline: only what changes from here must be RED again.
  state.frozenTests = checks.freeze(root, h);
  state.round += 1;
  logEvent(state, 'back', { to: target });
  state.stage = target;
  saveState(root, state);
  return state;
}

// What the user is asked to approve, as the pipeline reads it from disk. The
// approval dialog and the terminal both show this text, so the user sees the
// thing itself and not the model's account of it.
export function approvalSubject(root, what) {
  const cfg = configFor(root);
  const state = loadState(root);
  if (what === 'spec') {
    if (state.stage !== 'spec') fail('the spec is approved in the spec stage');
    const spec = readSpec(root);
    if (spec.problems.length) fail(`the spec is not ready:\n  ${spec.problems.join('\n  ')}`);
    let text = spec.text;
    if (cfg.specCheck) {
      const check = state.evidence.specCheck;
      if (check?.specHash !== spec.hash) fail('nobody has read this version of the spec cold yet. Have the test-writer agent check it (job "read the spec cold"; its closing GATED-SPEC-CHECK block is recorded by a hook), settle what it finds unclear, then ask again');
      if (check.unclear.length) text += `\n\n---\nStill unclear to a reader who saw only this spec (approving accepts the spec as it is):\n${check.unclear.map((u) => `- ${u}`).join('\n')}\n`;
    }
    return { state, hash: spec.hash, where: `${STATE_DIR}/spec.md`, text };
  }
  if (what === 'merge') {
    if (state.stage !== 'merge') fail('the merge is approved in the merge stage');
    const h = hashes(root, cfg, state.base);
    const files = h.files.map((f) => `- ${f.path}${f.deleted ? ' (deleted)' : ''}${f.kind === 'source' || f.kind === 'test' || f.kind === 'docs' ? '' : ` [${f.kind}]`}`);
    return { state, hash: h.treeHash, where: recordFile(cfg, state), text: `${summary(root, cfg, state)}\n### Files this item changes (${files.length})\n\n${files.join('\n')}\n` };
  }
  return fail('approve spec | approve merge');
}

// Records a human approval of the content as it is now. Called by the approval
// hook when the user answers the question, and by "approve" in the user's terminal.
// `expect` is the hash (or its start) of what the user was shown.
export function approve(root, what, { via = 'terminal', expect, toolUseId, sessionId } = {}) {
  const { state, hash } = approvalSubject(root, what);
  if (expect && !hash.startsWith(expect)) fail(`the ${what === 'spec' ? 'spec' : 'item'} changed after it was shown for approval: ask again`);
  recordApproval(root, state, { what, hash, via, toolUseId, sessionId });
  return updateState(root, (s) => logEvent(s, 'approved', { what, via }));
}

// The proofs were run on the item branch as it stood on one base commit. When
// the base branch has moved since, the merged result is a tree nobody tested,
// and two changes that each pass can break each other without a textual
// conflict. So the result is built and checked before the base branch moves:
// the base is merged into the item branch, and the item's tests and the
// package checks run on that. Any failure puts the item branch back.
function integrate(root, cfg, state, h, baseTip) {
  const head = git(root, ['rev-parse', 'HEAD']);
  const undo = () => git(root, ['reset', '--hard', head], { allowFail: true });
  if (git(root, ['merge-base', 'HEAD', baseTip]) !== baseTip) {
    const failed = tryMerge(root, baseTip, `Merge ${state.base} into ${currentBranch(root)}`);
    if (failed) fail(mergeRefusal(currentBranch(root), state.base, failed));
  }
  try {
    const after = hashes(root, cfg, state.base);
    if (after.treeHash !== h.treeHash) fail(`"${state.base}" has since changed files this item also changes, so the merged files are not the ones that were proven and approved. Merge "${state.base}" into the item branch, go "back implementation", and prove the result again.`);
    const names = state.type === 'hotfix' ? cfg.hotfix.checks.filter((c) => c !== 'test') : undefined;
    if (state.type !== 'hotfix' || cfg.hotfix.checks.includes('test')) checks.greenCheck(root, cfg, after);
    const stat = checks.staticChecks(root, cfg, after, names);
    if (!isClean(root)) fail('a check changed tracked files while testing the merged result; nothing was merged');
    return { base: baseTip, static: stat.results, at: new Date().toISOString() };
  } catch (e) {
    undo();
    if (e instanceof GateError) e.message = `"${state.base}" has moved since this item was proven, and the merged result does not pass:\n${e.message}\nNothing was merged and the item branch is as it was. Merge "${state.base}" into the item branch, go "back implementation", and fix it there.`;
    throw e;
  }
}

const mergeRefusal = (branch, base, failed) =>
  failed.conflict
    ? `"${branch}" conflicts with "${base}". Merge "${base}" into the item branch, go "back implementation", and prove the result again.`
    : `git could not merge "${branch}" and "${base}", and not because of a conflict. Nothing was merged. git said:\n${failed.error}`;

export function merge(root) {
  const cfg = configFor(root);
  const state = loadState(root);
  if (state.stage !== 'merge') fail(`the item is at "${state.stage}", not at merge`);
  const h = hashes(root, cfg, state.base);
  if (!approvalOf(root, state, 'merge', h.treeHash)) fail(`the user has not approved this exact tree. ${hint(state)}`);
  if (!isClean(root)) fail('commit the item first: the worktree has uncommitted changes');
  const main = mainRoot(root);
  const branch = currentBranch(root);
  if (currentBranch(main) !== state.base) fail(`the main checkout (${main}) is not on "${state.base}". Merge by hand: git merge --no-ff ${branch}`);
  if (!isClean(main)) fail(`the main checkout (${main}) has uncommitted changes. Clean it, then run merge again.`);
  const baseTip = git(main, ['rev-parse', 'HEAD']);
  if (state.evidence.green?.base !== baseTip) state.evidence.integration = integrate(root, cfg, state, h, baseTip);
  const failed = tryMerge(main, branch, `Merge ${state.type} ${state.item}`);
  if (failed) fail(mergeRefusal(branch, state.base, failed));
  if (state.evidence.integration) logEvent(state, 'integrated', { base: baseTip });
  logEvent(state, 'merged', { into: state.base });
  state.stage = 'done';
  saveState(root, state);
  return state;
}

// What the pipeline can say about the item from its recorded evidence.
export function evidenceSection(state, { specApproval = null } = {}) {
  const e = state.evidence;
  const lines = ['## Pipeline evidence', '', `Base branch: \`${state.base}\` · rounds: ${state.round} · started ${state.startedAt.slice(0, 10)}`, ''];
  if (state.type === 'hotfix') lines.push('> **Hotfix.** Skipped on purpose: spec, RED proof, mutation gate, review. Open a `/fix` to pay this back with a regression test.', '');
  if (specApproval) lines.push(`- Spec approved by the user: ${describeApproval(specApproval)}`);
  if (e.red) lines.push(`- RED: ${e.red.files.length} test file(s) failed before the implementation (${e.red.files.map((f) => f.path).join(', ')})`);
  if (e.green) {
    lines.push(`- GREEN: ${e.green.runs.length ? e.green.runs.map((r) => `${r.package} passed`).join(', ') : 'no test run'}${e.green.tests ? ` (${e.green.tests.passed} test(s) ran and passed${e.green.tests.skipped ? `, ${e.green.tests.skipped} in the same files did not run` : ''})` : ''}`);
    if (e.holdout?.passed) lines.push(`- Held-out tests: ${e.holdout.files} test file(s) the implementation stage never saw; they passed on attempt ${e.holdout.attempts}`);
    const before = { failed: 'a test naming it failed', passed: 'its tests passed already, so they pin behaviour that held', unknown: 'its test file failed as a whole' };
    if (e.green.acs && e.red?.acs?.[0]?.red) for (const ac of e.red.acs) lines.push(`- ${ac.id}: before the implementation ${before[ac.red]}; after it${e.green.acs.includes(ac.id) ? ' a test naming it runs and passes' : ' not checked per test'}`);
    for (const s of e.green.static) lines.push(`- ${s.check} (${s.package}): ${s.status}`);
  }
  if (e.mutation) {
    const m = e.mutation;
    lines.push(`- Mutation: ${m.total} mutant(s) on the changed lines, ${m.survivors.length} surviving${m.disabled.length ? `; no mutation gate in: ${m.disabled.join(', ')}` : ''}`);
  }
  const justified = (e.mutation?.survivors ?? []).filter((s) => state.justified[s.id]);
  if (justified.length) {
    lines.push('', '### Surviving mutants accepted with a justification', '', 'Approving the merge accepts each of these.', '');
    for (const s of justified) lines.push(`- \`${s.id}\` ${s.mutator} -> \`${s.replacement}\`: ${state.justified[s.id]}${state.judged?.[s.id] ? ' (the reviewer agreed that no test can tell them apart)' : ''}`);
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
  return `${lines.join('\n')}${evidenceSection(state, { specApproval: specApproval(root, state) })}`;
}

// The approval of the spec as it stands, if the user gave one.
function specApproval(root, state) {
  if (state.type === 'hotfix' || !fs.existsSync(specFile(root))) return null;
  return approvalOf(root, state, 'spec', readSpec(root).hash);
}

const EVIDENCE_START = '<!-- gated-pipeline evidence: generated, do not edit -->';
const EVIDENCE_END = '<!-- end of gated-pipeline evidence -->';

// Puts the evidence into the item record, replacing an earlier copy of it.
function writeEvidence(root, cfg, state) {
  const file = path.join(root, recordFile(cfg, state));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const block = `${EVIDENCE_START}\n${evidenceSection(state, { specApproval: specApproval(root, state) })}${EVIDENCE_END}\n`;
  if (!fs.existsSync(file)) return fs.writeFileSync(file, `# ${state.type}: ${state.item}\n\n${block}`);
  let text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(EVIDENCE_START);
  const end = text.indexOf(EVIDENCE_END);
  if (start >= 0 && end > start) text = text.slice(0, start) + text.slice(end + EVIDENCE_END.length).replace(/^\n/, '');
  fs.writeFileSync(file, `${text.replace(/\n*$/, '\n\n')}${block}`);
}

export async function runMutation(root, { force = false } = {}) {
  const started = loadState(root);
  if (started.stage !== 'validation') fail('"mutate" belongs to the validation stage');
  const { reused, ...evidence } = await mutate(root, configFor(root), started, { force });
  // The run can take a long time, and a review or a justification may have
  // been recorded meanwhile: the result goes into the state as it is now.
  const state = updateState(root, (s) => {
    s.evidence.mutation = evidence;
    logEvent(s, 'mutated', { total: evidence.total, survivors: evidence.survivors.length, reused: Boolean(reused), incremental: evidence.incremental });
  });
  return { state, evidence, reused: Boolean(reused), open: openSurvivors(state) };
}

// A survivor no test can kill is accepted with a written reason; the user reads it before merging.
export function justify(root, id, reason) {
  if ((reason ?? '').trim().length < 20) fail('give the reason no test can kill this mutant (a full sentence)');
  return updateState(root, (state) => {
    if (!(state.evidence.mutation?.survivors ?? []).some((s) => s.id === id)) fail(`"${id}" is not a surviving mutant of the last run`);
    // A new reason needs a new ruling.
    delete state.judged?.[id];
    delete state.rejected?.[id];
    state.justified[id] = reason.trim();
    logEvent(state, 'justified', { mutant: id });
  });
}
