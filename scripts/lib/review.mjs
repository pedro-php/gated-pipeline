// The reviewer's verdict: a closing GATED-REVIEW block, read from wherever
// the reviewer's report ended up, and recorded against the source it reviewed.
import fs from 'node:fs';
import { hashes } from './git.mjs';
import { readSpec } from './spec.mjs';
import { logEvent, updateState } from './state.mjs';
import { sha256 } from './util.mjs';

// Parses the block a reviewer must end with:
//   GATED-REVIEW
//   BLOCKING: <finding a failing test can demonstrate>
//   ADVISORY: <finding no test can show>
export function parseReview(message) {
  const at = (message ?? '').lastIndexOf('GATED-REVIEW');
  if (at < 0) return null;
  const findings = [];
  for (const m of message.slice(at).matchAll(/^\s*(?:[-*]\s*)?\**(BLOCKING|ADVISORY)\**\s*:\s*(.+)$/gm)) {
    findings.push({ kind: m[1].toLowerCase(), text: m[2].trim() });
  }
  return findings;
}

// The reviewer also rules on every survivor that was justified instead of
// killed. The one who wants the item to move on wrote the justification, so
// someone who does not has to check it:
//   EQUIVALENT: <mutant id>
//   KILLABLE: <mutant id> <the input that tells the mutant from the original>
export function parseRulings(message) {
  const at = (message ?? '').lastIndexOf('GATED-REVIEW');
  if (at < 0) return [];
  return [...message.slice(at).matchAll(/^\s*(?:[-*]\s*)?\**(EQUIVALENT|KILLABLE)\**\s*:\s*(.+)$/gm)].map((m) => ({ verdict: m[1].toLowerCase(), text: m[2].trim() }));
}

// Justified survivors of the last run that have no ruling yet.
export const awaitingRuling = (state) => (state.evidence.mutation?.survivors ?? []).filter((s) => state.justified[s.id] && !state.judged?.[s.id]);

// Those among them that this report does not rule on.
export function unruled(state, report) {
  const rulings = parseRulings(report);
  return awaitingRuling(state).filter((s) => !rulings.some((r) => r.text.includes(s.id)));
}

// The cold read of a spec: an agent that has seen nothing but the spec says
// where two careful readers would write different tests.
//   GATED-SPEC-CHECK
//   UNCLEAR: AC-2 <the two readings>
export function parseSpecCheck(message) {
  const at = (message ?? '').lastIndexOf('GATED-SPEC-CHECK');
  if (at < 0) return null;
  return [...message.slice(at).matchAll(/^\s*(?:[-*]\s*)?\**UNCLEAR\**\s*:\s*(.+)$/gm)].map((m) => m[1].trim());
}

export function recordSpecCheck(root, report, agentId) {
  const unclear = parseSpecCheck(report);
  return updateState(root, (state) => {
    state.evidence.specCheck = { specHash: readSpec(root).hash, unclear, agentId, at: new Date().toISOString() };
    logEvent(state, 'spec-checked', { unclear: unclear.length });
  });
}

// The reviewer's own words in its transcript, latest first: plain text, and
// a report handed back through the SubagentHandback tool. A fallback only:
// when the run ends, the transcript may not hold its last lines yet.
function* said(transcriptPath, marker) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(marker)) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content.toReversed()) {
      if (block.type === 'text') yield block.text;
      else if (block.type === 'tool_use' && block.name === 'SubagentHandback') yield block.input?.message;
    }
  }
}

// The report that carries the block: the last message, or failing that the transcript.
export function findReview({ last_assistant_message: last, agent_transcript_path: transcript }, marker = 'GATED-REVIEW') {
  if ((last ?? '').includes(marker)) return last;
  if (transcript) for (const text of said(transcript, marker)) if (typeof text === 'string' && text.includes(marker)) return text;
  return null;
}

// -> the findings recorded, or null when this same report was recorded already
// (two hooks can see one report: the hand-back, then the end of the run).
export function recordReview(root, cfg, report, agentId) {
  const findings = parseReview(report);
  let recorded = null;
  updateState(root, (state) => {
    const sourceHash = hashes(root, cfg, state.base).sourceHash;
    const digest = sha256(`${agentId ?? ''}\n${sourceHash}\n${report}`);
    if (state.evidence.review?.digest === digest) return;
    let id = Math.max(0, ...state.findings.map((f) => f.id));
    const kept = state.findings.filter((f) => f.status === 'confirmed' || f.status === 'refuted');
    state.findings = kept.concat(findings.map((f) => ({ id: ++id, text: f.text, status: f.kind === 'blocking' ? 'open' : 'advisory', round: state.round })));
    state.evidence.review = { sourceHash, agentId, blocking: findings.filter((f) => f.kind === 'blocking').length, digest, at: new Date().toISOString() };
    // Rulings on justifications. A rejected one is no longer a justification: the survivor is open again.
    state.judged ??= {};
    state.rejected ??= {};
    for (const ruling of parseRulings(report)) {
      const id = Object.keys(state.justified).find((j) => ruling.text.includes(j));
      if (!id) continue;
      const note = ruling.text.replace(id, '').trim();
      if (ruling.verdict === 'equivalent') state.judged[id] = { note, at: new Date().toISOString() };
      else {
        state.rejected[id] = { reason: state.justified[id], note };
        delete state.justified[id];
        delete state.judged[id];
      }
    }
    logEvent(state, 'reviewed', { blocking: state.evidence.review.blocking });
    recorded = findings;
  });
  return recorded;
}
