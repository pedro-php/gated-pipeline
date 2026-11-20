#!/usr/bin/env node
// gated-pipeline CLI. The skills call it; every gate decision is made here.
//   start <feature|fix|hotfix> <item> [--base <branch>]   new worktree + item
//   init  <feature|fix|hotfix> <item> [--base <branch>]   item in the current worktree
//   status [--json] | spec (check the spec's form) | advance | mutate [--force] | justify <mutant id> <reason>
//   prove <test file> [--finding <id>] | back <spec|test|implementation>
//   approve <spec|merge> (the user only, in a terminal) | merge | summary
import readline from 'node:readline/promises';
import { loadConfig } from './lib/config.mjs';
import { git } from './lib/git.mjs';
import { openSurvivors } from './lib/mutation.mjs';
import * as pipeline from './lib/pipeline.mjs';
import { awaitingRuling } from './lib/review.mjs';
import { readSpec } from './lib/spec.mjs';
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
      if (state.sealed) say(`Held-out tests: ${Object.keys(state.sealed).length} file(s), hidden until the implementation gate has run them`);
      const open = openSurvivors(state);
      if (open.length) say(`Open survivors: ${open.length}`);
      for (const s of awaitingRuling(state)) say(`Justification awaiting the reviewer's ruling: ${s.id}  ${s.mutator} -> ${JSON.stringify(s.replacement)}: ${state.justified[s.id]}`);
      for (const [id, r] of Object.entries(state.rejected ?? {})) say(`Justification rejected by the reviewer: ${id} (${r.note || 'killable'}). Write the test that kills it.`);
      const check = state.evidence.specCheck;
      if (state.stage === 'spec' && check) for (const u of check.unclear) say(`Unclear in the spec as last read: ${u}`);
      const findings = state.findings.filter((f) => f.status === 'open');
      for (const f of findings) say(`Blocking finding #${f.id}: ${f.text}`);
      for (const f of state.findings.filter((x) => x.status === 'refuted')) say(`Refuted finding #${f.id}: ${f.text} (test: ${f.test})`);
      return;
    }
    case 'config': {
      // What the pipeline understood from gated.config.json: a refusal when the file has a mistake.
      const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
      const cfg = findRoot(process.cwd()) ? pipeline.configFor(findRoot(process.cwd())) : loadConfig(top);
      say(`base branch: ${cfg.baseBranch} · interview: ${cfg.interview} · spec read cold: ${cfg.specCheck ? 'yes' : 'no'} · held-out tests: ${cfg.holdout ? 'yes' : 'no'}`);
      for (const p of cfg.packages) {
        const checks = ['testAll', 'lint', 'typecheck', 'build'].filter((c) => p.commands[c]);
        say(`package "${p.name}" (${p.root}): test ${p.commands.test ? `"${p.commands.test}"` : 'MISSING: no RED or GREEN can be proven'}; per-test results: ${p.testReport ?? 'none (exit code only)'}; checks: ${checks.join(', ') || 'none'}; mutation: ${p.mutation === false ? 'none, by decision' : p.mutation ? p.mutation.adapter : 'UNDECIDED: set an adapter, or false'}`);
      }
      return;
    }
    case 'spec': {
      const spec = readSpec(itemRoot());
      if (spec.problems.length) fail(`the spec is not ready:\n  ${spec.problems.join('\n  ')}`);
      for (const ac of spec.acs) say(`${ac.id}: ${ac.title}`);
      return say('The spec is well-formed: ready to ask the user for approval.');
    }
    case 'advance':
      return report(pipeline.advance(itemRoot()));
    case 'mutate': {
      const { state, evidence, reused, open } = await pipeline.runMutation(itemRoot(), { force: has('force') });
      for (const p of evidence.packages) say(`${p.name}: ${p.ran} mutant(s) run, ${p.killed} killed, ${(p.ms / 60_000).toFixed(1)} min${p.complete ? '' : ` — INCOMPLETE: ${p.reason}`}`);
      if (evidence.waitedMs > 1000) say(`Waited ${(evidence.waitedMs / 60_000).toFixed(1)} min for a mutation slot.`);
      if (reused) say('Same code as the last run: result reused.');
      if (evidence.incremental) say('Source and earlier tests unchanged: only the earlier survivors were run again.');
      if (evidence.disabled.length) say(`No mutation gate in: ${evidence.disabled.join(', ')}`);
      for (const s of open.slice(0, 30)) say(`SURVIVED ${s.id}  ${s.mutator} -> ${JSON.stringify(s.replacement)} [${s.status}]${state.attempts?.[s.id] ? ` (withstood ${state.attempts[s.id]} attempt(s): kill it, or justify it)` : ''}`);
      if (open.length > 30) say(`… and ${open.length - 30} more (status --json lists all)`);
      if (!evidence.complete) fail('the mutation run is incomplete');
      if (open.length) fail(`${open.length} surviving mutant(s): add a test that kills each and run mutate again. One that is still alive after a test went at it can be recorded with "justify <id> <reason>" (the reviewer rules on every justification and the user sees them before merging)`);
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
    case 'approve': {
      // For the user, in their own terminal: the model's shell has no terminal to answer from.
      const root = itemRoot();
      if (!process.stdin.isTTY || !process.stdout.isTTY) fail('"approve" is for the user, typed in a terminal of their own (it shows the text and asks for confirmation there). Inside Claude Code, approval is given by answering the approval question.');
      const subject = pipeline.approvalSubject(root, a);
      say(`${subject.text}\n---\n${a === 'spec' ? subject.where : 'the item tree'} · sha256 ${subject.hash.slice(0, 12)}`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const typed = await rl.question(`Type the item name (${subject.state.item}) to approve this ${a}: `);
      rl.close();
      if (typed.trim() !== subject.state.item) fail('not approved');
      return report(pipeline.approve(root, a, { via: 'terminal', expect: subject.hash }));
    }
    case 'merge': {
      const state = pipeline.merge(itemRoot());
      if (state.evidence.integration) say(`"${state.base}" had moved since the item was proven: the merged result was tested again (the item's tests and the package checks) before it was merged.`);
      return report(state);
    }
    case 'summary': {
      const root = itemRoot();
      return say(pipeline.summary(root, pipeline.configFor(root), loadState(root)));
    }
    default:
      fail('usage: gated <start|init|status|config|spec|advance|mutate|justify|prove|back|approve|merge|summary>');
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
