// The mutation gate: mutate only the lines the item changed, list what survives.
// A survivor passes the gate only when a test kills it or it carries a written
// justification, which the human sees before approving the merge.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { packageOf, STATE_DIR } from './config.mjs';
import { changedRanges, hashes } from './git.mjs';
import { freeze } from './checks.mjs';
import { childEnv, fail, sha256, shellQuote } from './util.mjs';
import { withSlot } from './slots.mjs';
import * as stryker from '../adapters/stryker.mjs';

const SURVIVED = new Set(['Survived', 'NoCoverage']);
const KILLED = new Set(['Killed', 'Timeout']);

export const mutantId = (m) => `${m.file}:${m.line}:${m.col}:${m.mutator}:${sha256(m.replacement ?? '').slice(0, 8)}`;

// Reads a mutation-testing-report-schema JSON (Stryker and others emit it).
// `prefix` turns the report's file names into repo-relative paths.
export function parseReport(report, pkgRoot, prefix) {
  const mutants = [];
  for (const [name, file] of Object.entries(report.files ?? {})) {
    const inside = path.isAbsolute(name) ? path.relative(pkgRoot, name) : name;
    const rel = path.posix.join(prefix === '.' ? '' : prefix, inside.split(path.sep).join('/'));
    for (const m of file.mutants ?? []) {
      mutants.push({
        file: rel,
        line: m.location?.start?.line ?? 0,
        col: m.location?.start?.column ?? 0,
        mutator: m.mutatorName ?? 'unknown',
        replacement: m.replacement ?? '',
        status: m.status,
      });
    }
  }
  return mutants;
}

// Runs a long command in its own process group so a timeout stops the workers too.
function runLong(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, detached: true, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (d) => {
      tail = (tail + d).slice(-1500);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const signal = (s) => {
      try {
        process.kill(-child.pid, s);
      } catch {
        /* already gone */
      }
    };
    // SIGTERM first: Stryker restores files it mutated in place when it can exit cleanly.
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 20_000).unref();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, timedOut, tail, ms: Date.now() - started });
    });
  });
}

// Which lines to mutate, per package. Throws when a touched package has no decision about mutation.
export function targets(root, cfg, state, h, onlyLines = null) {
  const out = new Map();
  const disabled = new Set();
  for (const f of h.source) {
    if (f.deleted || f.kind !== 'source') continue;
    const owner = packageOf(cfg, f.path);
    if (owner.pkg.mutation === false) {
      disabled.add(owner.pkg.name);
      continue;
    }
    if (!owner.pkg.mutation) fail(`package "${owner.pkg.name}" has no "mutation" setting in gated.config.json: configure an adapter, or set it to false to state there is no mutation gate`);
    let ranges = changedRanges(root, state.base, f);
    if (onlyLines) ranges = (onlyLines.get(f.path) ?? []).map((l) => [l, l]);
    if (!out.has(owner.pkg)) out.set(owner.pkg, []);
    for (const [start, end] of ranges) out.get(owner.pkg).push({ file: owner.inside, start, end });
  }
  for (const [pkg, ranges] of out) if (ranges.length === 0) out.delete(pkg);
  return { byPackage: out, disabled: [...disabled] };
}

// One tool run over a batch of ranges.
async function runBatch(root, pkg, ranges, tag) {
  const pkgRoot = path.join(root, pkg.root);
  const stateDir = path.join(root, STATE_DIR);
  const timeoutMs = (pkg.mutation.timeoutMinutes ?? 60) * 60_000;
  let plan;
  if (pkg.mutation.adapter === 'stryker') plan = stryker.prepare({ pkg, pkgRoot, stateDir, ranges, tag });
  else if (pkg.mutation.adapter === 'command') {
    const mutate = ranges.map((r) => shellQuote(`${r.file}:${r.start}-${r.end}`)).join(' ');
    plan = { command: pkg.mutation.command.replaceAll('{mutate}', mutate), env: {}, report: path.resolve(pkgRoot, pkg.mutation.report) };
    fs.rmSync(plan.report, { force: true });
  } else fail(`package "${pkg.name}": unknown mutation adapter "${pkg.mutation.adapter}" (stryker or command)`);

  const r = await runLong(plan.command, { cwd: pkgRoot, env: plan.env, timeoutMs });
  if (r.timedOut) return { complete: false, reason: `stopped at the ${pkg.mutation.timeoutMinutes ?? 60} min budget`, ms: r.ms, mutants: [] };
  if (!fs.existsSync(plan.report)) return { complete: false, reason: `no report (exit ${r.code}):\n${r.tail}`, ms: r.ms, mutants: [] };
  const mutants = parseReport(JSON.parse(fs.readFileSync(plan.report, 'utf8')), pkgRoot, pkg.root);
  const pending = mutants.some((m) => m.status === 'Pending');
  return { complete: !pending, reason: pending ? 'the report has mutants that never ran' : undefined, ms: r.ms, mutants };
}

// Splits ranges into batches of at most `size` files. A tool that instruments
// a whole wide change at once can run out of memory in its first test run.
export function batches(ranges, size) {
  const byFile = new Map();
  for (const r of ranges) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const files = [...byFile.keys()];
  const out = [];
  for (let i = 0; i < files.length; i += size) out.push(files.slice(i, i + size).flatMap((f) => byFile.get(f)));
  return out;
}

async function runPackage(root, pkg, ranges) {
  const parts = batches(ranges, pkg.mutation.maxFilesPerRun ?? 40);
  const result = { name: pkg.name, complete: true, reason: undefined, ms: 0, mutants: [] };
  for (const [i, part] of parts.entries()) {
    const r = await runBatch(root, pkg, part, parts.length > 1 ? `-${i + 1}` : '');
    result.ms += r.ms;
    result.mutants.push(...r.mutants);
    if (!r.complete) {
      result.complete = false;
      result.reason = parts.length > 1 ? `batch ${i + 1} of ${parts.length}: ${r.reason}` : r.reason;
      break;
    }
  }
  return result;
}

// A previous run can be narrowed to its survivors when the source is the same
// and no test it relied on changed (tests were only added).
function carryFrom(root, prev, h) {
  if (!prev?.complete || prev.sourceHash !== h.sourceHash) return null;
  const now = freeze(root, h);
  for (const [p, hash] of Object.entries(prev.testHashes ?? {})) if (now[p] !== hash) return null;
  return prev;
}

export async function mutate(root, cfg, state, { force = false } = {}) {
  const h = hashes(root, cfg, state.base);
  const prev = state.evidence.mutation;
  if (!force && prev?.complete && prev.codeHash === h.codeHash) return { ...prev, reused: true };

  const carry = force ? null : carryFrom(root, prev, h);
  let onlyLines = null;
  if (carry) {
    onlyLines = new Map();
    for (const s of carry.survivors.filter((x) => !state.justified[x.id])) {
      if (!onlyLines.has(s.file)) onlyLines.set(s.file, []);
      if (!onlyLines.get(s.file).includes(s.line)) onlyLines.get(s.file).push(s.line);
    }
  }
  const { byPackage, disabled } = targets(root, cfg, state, h, onlyLines);

  const packages = [];
  let survivors = carry ? carry.survivors.filter((x) => state.justified[x.id]) : [];
  const runAll = async () => {
    for (const [pkg, ranges] of byPackage) {
      const result = await runPackage(root, pkg, ranges);
      const after = hashes(root, cfg, state.base);
      if (after.codeHash !== h.codeHash) fail(`the mutation run left the working tree changed (package ${pkg.name}). Restore the mutated files with git before anything else.`);
      survivors = survivors.concat(result.mutants.filter((m) => SURVIVED.has(m.status)).map((m) => ({ id: mutantId(m), ...m })));
      packages.push({
        name: result.name,
        complete: result.complete,
        reason: result.reason,
        ms: result.ms,
        ran: result.mutants.length,
        killed: result.mutants.filter((m) => KILLED.has(m.status)).length,
      });
    }
  };
  let waitedMs = 0;
  if (byPackage.size > 0) {
    // Mutation is the heavy step: it waits for one of the repository's slots.
    const slot = await withSlot(
      root,
      {
        max: cfg.heavySlots,
        waitMs: cfg.heavySlotWaitMinutes * 60_000,
        owner: { item: state.item },
        pollMs: cfg.heavySlotPollMs,
        onWait: (busy) => process.stderr.write(`Waiting for a mutation slot (${cfg.heavySlots} in use by: ${busy.join(', ')})…\n`),
      },
      runAll,
    );
    waitedMs = slot.waitedMs;
    if (slot.timedOut) packages.push({ name: 'queue', complete: false, reason: `no mutation slot came free in ${cfg.heavySlotWaitMinutes} min (in use by: ${slot.busy.join(', ')})`, ms: 0, ran: 0, killed: 0 });
  }
  return {
    codeHash: h.codeHash,
    sourceHash: h.sourceHash,
    testHashes: freeze(root, h),
    complete: packages.every((p) => p.complete),
    incremental: Boolean(carry),
    total: carry ? carry.total : packages.reduce((n, p) => n + p.ran, 0),
    packages,
    disabled,
    survivors,
    waitedMs,
    at: new Date().toISOString(),
  };
}

export const openSurvivors = (state) => (state.evidence.mutation?.survivors ?? []).filter((s) => !state.justified[s.id]);
