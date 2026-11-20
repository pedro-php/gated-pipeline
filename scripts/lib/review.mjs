// The reviewer's verdict: a closing GATED-REVIEW block, read from wherever
// the reviewer's report ended up, and recorded against the source it reviewed.
import fs from 'node:fs';
import { hashes } from './git.mjs';
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

// The reviewer's own words in its transcript, latest first: plain text, and
// a report handed back through the SubagentHandback tool. A fallback only:
// when the run ends, the transcript may not hold its last lines yet.
function* said(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('GATED-REVIEW')) continue;
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
export function findReview({ last_assistant_message: last, agent_transcript_path: transcript }) {
  if (parseReview(last)) return last;
  if (transcript) for (const text of said(transcript)) if (typeof text === 'string' && parseReview(text)) return text;
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
    logEvent(state, 'reviewed', { blocking: state.evidence.review.blocking });
    recorded = findings;
  });
  return recorded;
}
