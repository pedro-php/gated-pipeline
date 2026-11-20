// The spec: numbered acceptance criteria, each with at least one concrete example.
//
//   ### AC-1: short title
//   WHEN <trigger> THEN <observable result>.
//   Example: <input> -> <output>
import fs from 'node:fs';
import { specFile } from './state.mjs';
import { fail, sha256 } from './util.mjs';

const AC_LINE = /^\s*(?:#{1,6}\s*|[-*]\s*)?\*{0,2}(AC-\d+)\*{0,2}\s*[:.\-–—]?\s*(.*)$/;

export function parseSpec(text) {
  const acs = [];
  let current = null;
  for (const line of text.split('\n')) {
    const m = AC_LINE.exec(line);
    if (m) {
      current = { id: m[1], title: m[2].replace(/\*+/g, '').trim(), body: '' };
      acs.push(current);
    } else if (current) current.body += `${line}\n`;
  }
  return acs;
}

export function specProblems(text) {
  const acs = parseSpec(text);
  const problems = [];
  if (acs.length === 0) problems.push('the spec has no acceptance criterion (a line starting with "AC-1")');
  const seen = new Set();
  for (const ac of acs) {
    if (seen.has(ac.id)) problems.push(`${ac.id} is declared twice`);
    seen.add(ac.id);
    if (!/\bexamples?\b/i.test(`${ac.title}\n${ac.body}`)) problems.push(`${ac.id} has no "Example:" with a concrete input and result`);
  }
  return problems;
}

export function readSpec(root) {
  const file = specFile(root);
  if (!fs.existsSync(file)) fail(`no spec yet: write it to ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  return { text, hash: sha256(text), acs: parseSpec(text), problems: specProblems(text) };
}
