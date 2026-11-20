// What may be written in each stage. Pure decisions, used by the PreToolUse hook.
// The Bash side is a heuristic for the obvious cases; the real backstop is the
// hash checks in `advance`, which no shell trick gets around.
import fs from 'node:fs';
import path from 'node:path';
import { APPROVALS_DIR } from './approvals.mjs';
import { classify, STATE_DIR } from './config.mjs';

const SPEC = `${STATE_DIR}/spec.md`;

// -> null when the write is allowed, otherwise the reason it is not.
export function decidePath(cfg, state, rel) {
  const kind = classify(cfg, rel);
  const { stage } = state;
  if (kind === 'state') {
    if (rel === SPEC && stage === 'spec') return null;
    return rel === SPEC ? 'the spec is frozen once approved (go "back spec" to change it)' : `${STATE_DIR}/ is written by the pipeline CLI only`;
  }
  switch (stage) {
    case 'spec':
      return `spec stage: only ${SPEC} is written now; code comes after the user approves the spec`;
    case 'test':
      return kind === 'test' ? null : 'test stage: only test files are written now (failing tests first, implementation after)';
    case 'implementation':
      if (kind === 'protected') return 'tool configuration is protected: do not loosen a check to pass it (ask the user if the change is really needed)';
      if (kind === 'test' && state.type !== 'hotfix') return 'tests are frozen during implementation: make them pass, do not change them';
      return null;
    case 'validation':
      return kind === 'test' ? null : 'validation stage: only tests are added now. A real problem is proven with a failing test ("prove"), which reopens implementation';
    case 'docs':
      return kind === 'docs' ? null : 'docs stage: only documentation is written now (go "back implementation" to change code)';
    default:
      return `the item is at "${stage}": the tree is what the user approves; go "back" to change it`;
  }
}

export function decideEdit(root, cfg, state, absPath) {
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return decidePath(cfg, state, rel);
}

// Splits a command line into words, remembering which were quoted (a quoted
// ">" or ";" is text, not shell syntax).
function words(command) {
  const out = [];
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    out.push(m[3] === undefined ? { text: m[1] ?? m[2], quoted: true } : { text: m[3], quoted: false });
  }
  return out;
}

// Drops heredoc bodies: their text is data, not shell syntax (a ">" in it is not a redirect).
export function withoutHeredocs(command) {
  const out = [];
  let until = null;
  for (const line of command.split('\n')) {
    if (until !== null) {
      if (line.trim() === until) until = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m) until = m[2];
  }
  return out.join('\n');
}

function segments(command) {
  const all = [[]];
  for (const w of words(withoutHeredocs(command).replace(/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/g, ' '))) {
    if (!w.quoted && /^(&&|\|\||;|\|)$/.test(w.text)) all.push([]);
    else if (!w.quoted && w.text.endsWith(';')) {
      all.at(-1).push({ ...w, text: w.text.slice(0, -1) });
      all.push([]);
    } else all.at(-1).push(w);
  }
  return all;
}

// Paths a shell command would write, for the common write commands.
export function bashWriteTargets(command, cwd) {
  const targets = [];
  for (const segment of segments(command)) {
    const plain = [];
    for (let i = 0; i < segment.length; i++) {
      const w = segment[i];
      const redirect = w.quoted ? null : /^[^>]*?>{1,2}(.*)$/.exec(w.text);
      if (!redirect) {
        plain.push(w.text);
        continue;
      }
      const target = redirect[1] || segment[++i]?.text;
      if (target && !target.startsWith('&') && !target.startsWith('/dev/')) targets.push(target);
    }
    const [cmd, ...rest] = plain.filter((t) => !/^\w+=/.test(t) && t !== 'sudo');
    const args = rest.filter((t) => !t.startsWith('-'));
    const existing = args.filter((a) => fs.existsSync(path.resolve(cwd, a)));
    if (cmd === 'tee' || cmd === 'touch' || cmd === 'truncate') targets.push(...args);
    else if (cmd === 'rm') targets.push(...existing);
    else if (cmd === 'mv') targets.push(...new Set([...existing, ...args.slice(-1)]));
    else if (cmd === 'cp') targets.push(...args.slice(-1));
    else if (cmd === 'sed' && rest.some((t) => /^-[a-zA-Z]*i|^--in-place/.test(t))) targets.push(...existing);
    else if (cmd === 'git' && (args[0] === 'restore' || (args[0] === 'checkout' && rest.includes('--')))) targets.push(...existing);
  }
  return targets;
}

// Shell text that reaches for an approval or for the pipeline's own records.
// Checked on the whole command, whatever the stage and wherever it runs: no
// step of the pipeline needs the shell for any of this, so naming these is
// enough to refuse (a variable holding the CLI path does not get around it).
const CLI = /gp\.mjs|pipeline\.mjs|approvals\.mjs|(?:^|[\s;&|('"`/])gp(?=$|[\s'"`])/;
export function decideRecords(command) {
  if (command.includes(APPROVALS_DIR)) return 'approvals are recorded only when the user answers the approval question';
  if (/\bapprove\b|recordApproval/.test(command) && CLI.test(command)) return 'only the user approves: ask with AskUserQuestion (the answer is recorded by a hook)';
  if (new RegExp(`${STATE_DIR.replace('.', '\\.')}/state\\.(json|lock)`).test(command)) return `${STATE_DIR}/state.json is written by the pipeline CLI only (read it with "status --json")`;
  return null;
}

// A file tool aimed at the approval records, in any checkout.
export const decideRecordsPath = (absPath) => (absPath.split(/[\\/]/).includes(APPROVALS_DIR) ? 'approvals are recorded only when the user answers the approval question' : null);

export function decideBash(root, cfg, state, command, cwd) {
  for (const target of bashWriteTargets(command, cwd)) {
    const reason = decideEdit(root, cfg, state, path.resolve(cwd, target));
    if (reason) return `${target}: ${reason}`;
  }
  return null;
}
