// Per-test results, read from the report file a test runner writes. With them
// the gates can tell a test that ran and failed from one that never ran (a
// skipped test, a criterion named only in a comment).
//   jest, vitest: their JSON reporter (--json / --reporter=json, --outputFile)
//   junit: JUnit XML, which nearly every other runner can write
import fs from 'node:fs';

export const FORMATS = ['jest', 'vitest', 'junit'];
export const extension = (format) => (format === 'junit' ? 'xml' : 'json');

// -> [{ name, status: 'passed' | 'failed' | 'skipped' }], one per test that the runner knows of.
export function parseJestJson(report) {
  const cases = [];
  for (const file of report.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      const name = a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(' ');
      // pending, todo, skipped, disabled: known to the runner, never run
      cases.push({ name, status: a.status === 'passed' || a.status === 'failed' ? a.status : 'skipped' });
    }
  }
  return cases;
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseJunit(xml) {
  const cases = [];
  // Attribute values may hold a raw ">", so attributes are matched one by one.
  const open = /<testcase\b((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescapeXml(a[2] ?? a[3]);
    let body = '';
    if (!m[2]) {
      const end = xml.indexOf('</testcase>', open.lastIndex);
      body = xml.slice(open.lastIndex, end < 0 ? undefined : end);
    }
    const status = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    // Some writers put the describe() titles in classname and the test title in name.
    cases.push({ name: [attrs.classname, attrs.name].filter(Boolean).join(' '), status });
  }
  return cases;
}

// -> the cases, or null when the run left no readable report (it crashed before writing one).
export function readReport(format, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return format === 'junit' ? parseJunit(text) : parseJestJson(JSON.parse(text));
  } catch {
    return null;
  }
}

export const cites = (text, id) => new RegExp(`\\b${id}\\b`).test(text);
