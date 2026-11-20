// Human approvals. They are kept apart from the item state, in the
// repository's shared git directory: the pipeline CLI (which the model runs)
// never needs to write here, so this one folder can be closed to the model's
// shell, by the guard and by the sandbox. Only the approval hook and the
// user's own terminal add a record.
//
// A record binds the approval to what was approved: the item, the kind
// (spec or merge) and the content hash. Any other content is not approved.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

export const APPROVALS_DIR = 'gated-approvals';

export const approvalsDir = (root) => path.join(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])), APPROVALS_DIR);
const fileOf = (root, item) => path.join(approvalsDir(root), `${item}.jsonl`);

// The records of this item. `startedAt` tells it from an earlier item of the same name.
export function readApprovals(root, state) {
  let text = '';
  try {
    text = fs.readFileSync(fileOf(root, state.item), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.item === state.item && entry.instance === state.startedAt) out.push(entry);
    } catch {
      /* a damaged line approves nothing */
    }
  }
  return out;
}

// The latest approval of exactly this content, or null.
export function approvalOf(root, state, what, hash) {
  return readApprovals(root, state).findLast((a) => a.what === what && a.hash === hash) ?? null;
}

// via: 'question' (the approval dialog) | 'terminal' (the user ran `approve` themselves).
// Either way the user was shown the text as the pipeline read it from disk.
export function recordApproval(root, state, { what, hash, via, toolUseId, sessionId }) {
  const entry = { item: state.item, instance: state.startedAt, what, hash, via, toolUseId, sessionId, at: new Date().toISOString() };
  fs.mkdirSync(approvalsDir(root), { recursive: true });
  fs.appendFileSync(fileOf(root, state.item), `${JSON.stringify(entry)}\n`);
  return entry;
}

// What one approval dialog showed. The hook that fills the dialog leaves this
// note under the id of the tool call; the hook that records the answer takes
// it. An answer with no note came from a dialog the pipeline did not fill, and
// approves nothing.
const shownFile = (root, toolUseId) => path.join(approvalsDir(root), `shown-${String(toolUseId ?? 'pending').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export function noteShown(root, toolUseId, shown) {
  fs.mkdirSync(approvalsDir(root), { recursive: true });
  fs.writeFileSync(shownFile(root, toolUseId), JSON.stringify(shown));
}

export function takeShown(root, toolUseId) {
  const file = shownFile(root, toolUseId);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// The approval question. The pipeline adds a tag for the reader: the first 12
// hex digits of the hash of what the dialog shows.
export const QUESTION = /Approve (spec for|merge of) ([a-z0-9-]+)\?/;
const TAG = /\s*\[(?:spec|tree) ([0-9a-f]{12})\]/;
// Claude Code shows an option's preview only up to about 2,000 characters; a
// longer one is replaced by "can't show the full preview" and the user sees
// nothing of it (measured on 2.1.329: 1,997 characters shown, 2,297 not).
export const PREVIEW_LIMIT = 1900;

const clip = (line, width) => (line.length > width ? `${line.slice(0, width - 1)}…` : line);

// Fits a text into the preview. Whole when it fits. Otherwise the parts in
// order, each line clipped, until the room is used up, and a last line that
// says it is cut and where the whole text is. `parts` are arrays of lines,
// most important first.
export function fitPreview(parts, { whole, where, more }) {
  if (whole.length <= PREVIEW_LIMIT) return whole;
  const notice = `\n… cut to fit this dialog (${whole.length} characters in all). ${more}`;
  const room = PREVIEW_LIMIT - notice.length;
  const out = [];
  let used = 0;
  for (const line of parts.flat()) {
    const text = clip(line, 300);
    if (used + text.length + 1 > room) break;
    out.push(text);
    used += text.length + 1;
  }
  return `${out.join('\n')}${notice}`.replaceAll('{where}', where);
}

// Rewrites one approval question so that the dialog shows the text being
// approved as the pipeline reads it, not as the model describes it.
export function presentQuestion(question, what, subject) {
  const short = subject.hash.slice(0, 12);
  const preview = subject.preview ?? subject.text;
  const cut = preview !== subject.text;
  const keep = (question.options ?? []).find((o) => /request changes/i.test(o.label ?? ''));
  return {
    ...question,
    question: `${question.question.replace(TAG, '').trim()} [${what === 'spec' ? 'spec' : 'tree'} ${short}]`,
    multiSelect: false,
    options: [
      {
        label: 'Approve',
        description:
          what === 'spec'
            ? `Approves ${subject.where} as it is on disk (sha256 ${short}). ${cut ? 'The preview is a shortened view' : 'The preview is that file'}; if it is cut or missing, read the file first.`
            : `Approves merging the item exactly as it stands (tree ${short}), with every justified survivor. The preview is the pipeline's summary; the whole evidence is in ${subject.where}.`,
        preview,
      },
      { label: 'Request changes', description: keep?.description ?? 'Nothing is approved; say what should change.' },
    ],
  };
}

export const describeApproval = (a) => `${a.at.slice(0, 10)}, ${a.via === 'terminal' ? 'confirmed in a terminal' : 'answered in the approval dialog'}; the text was shown as the pipeline read it from disk (sha256 ${a.hash.slice(0, 12)})`;
