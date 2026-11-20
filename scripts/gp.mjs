#!/usr/bin/env node
// gated-pipeline CLI. The skills call it; every gate decision is made here.
//   start <feature|fix|hotfix> <item> [--base <branch>]   new worktree + item
//   init  <feature|fix|hotfix> <item> [--base <branch>]   item in the current worktree
//   status [--json] | advance | mutate [--force] | justify <mutant id> <reason>
//   prove <test file> [--finding <id>] | back <spec|test|implementation>
//   approve <spec|merge> (the user only) | merge | summary
import { git } from './lib/git.mjs';
import { openSurvivors } from './lib/mutation.mjs';
import * as pipeline from './lib/pipeline.mjs';
import { findRoot, loadState } from './lib/state.mjs';
import { fail, GateError } from './lib/util.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const [, value] = argv.splice(i, 2);
  return value ?? true;
};
const has = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
// A reader that closes early (`gp status | head`) is not an error.
process.stdout.on('error', (e) => e.code === 'EPIPE' || process.exit(2));
const say = (s) => process.stdout.write(`${s}\n`);
const itemRoot = () => findRoot(process.cwd()) ?? fail('no item in this directory: start one with "start <feature|fix|hotfix> <item>"');
const report = (state) => say(`${state.type} "${state.item}" -> stage "${state.stage}" (round ${state.round})\nNext: ${pipeline.hint(state)}`);

async function main() {
  const base = flag('base');
  const finding = flag('finding');
  const [command, a, b, ...rest] = argv;
  switch (command) {
    case 'start': {
      const dir = pipeline.start(git(process.cwd(), ['rev-parse', '--show-toplevel']), { type: a, item: b, base });
      say(`worktree: ${dir}\nEnter it (EnterWorktree with this path, or cd), then follow the stage.`);
      return report(loadState(dir));
    }
    case 'init':
      return report(pipeline.init(git(process.cwd(), ['rev-parse', '--show-toplevel']), { type: a, item: b, base }));
    case 'status': {
      const state = loadState(itemRoot());
      if (has('json')) return say(JSON.stringify(state, null, 2));
      report(state);
      const open = openSurvivors(state);
      if (open.length) say(`Open survivors: ${open.length}`);
      const findings = state.findings.filter((f) => f.status === 'open');
      for (const f of findings) say(`Blocking finding #${f.id}: ${f.text}`);
      for (const f of state.findings.filter((x) => x.status === 'refuted')) say(`Refuted finding #${f.id}: ${f.text} (test: ${f.test})`);
      return;
    }
    case 'advance':
      return report(pipeline.advance(itemRoot()));
    case 'mutate': {
      const { evidence, reused, open } = await pipeline.runMutation(itemRoot(), { force: has('force') });
      for (const p of evidence.packages) say(`${p.name}: ${p.ran} mutant(s) run, ${p.killed} killed, ${(p.ms / 60_000).toFixed(1)} min${p.complete ? '' : ` — INCOMPLETE: ${p.reason}`}`);
      if (evidence.waitedMs > 1000) say(`Waited ${(evidence.waitedMs / 60_000).toFixed(1)} min for a mutation slot.`);
      if (reused) say('Same code as the last run: result reused.');
      if (evidence.incremental) say('Source and earlier tests unchanged: only the earlier survivors were run again.');
      if (evidence.disabled.length) say(`No mutation gate in: ${evidence.disabled.join(', ')}`);
      for (const s of open.slice(0, 30)) say(`SURVIVED ${s.id}  ${s.mutator} -> ${JSON.stringify(s.replacement)} [${s.status}]`);
      if (open.length > 30) say(`… and ${open.length - 30} more (status --json lists all)`);
      if (!evidence.complete) fail('the mutation run is incomplete');
      if (open.length) fail(`${open.length} surviving mutant(s): add a test that kills each, or "justify <id> <reason>" when no test can (the user sees every justification before merging)`);
      return say('Mutation gate clean.');
    }
    case 'justify': {
      const state = pipeline.justify(itemRoot(), a, [b, ...rest].filter(Boolean).join(' '));
      return say(`Justified ${a}. Open survivors: ${openSurvivors(state).length}`);
    }
    case 'prove': {
      const { failed, state } = pipeline.prove(itemRoot(), a, finding);
      say(failed ? 'The test FAILS: the problem is real. Implementation is reopened with this test frozen.' : `The test PASSES: ${finding === undefined ? 'nothing to fix here' : `finding #${finding} is refuted`}.`);
      return report(state);
    }
    case 'back':
      return report(pipeline.back(itemRoot(), a));
    case 'approve':
      return report(pipeline.approve(itemRoot(), a));
    case 'merge':
      return report(pipeline.merge(itemRoot()));
    case 'summary': {
      const root = itemRoot();
      return say(pipeline.summary(root, pipeline.configFor(root), loadState(root)));
    }
    default:
      fail('usage: gp.mjs <start|init|status|advance|mutate|justify|prove|back|approve|merge|summary>');
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof GateError) {
    process.stderr.write(`BLOCKED: ${e.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${e.stack}\n`);
  process.exit(2);
}
