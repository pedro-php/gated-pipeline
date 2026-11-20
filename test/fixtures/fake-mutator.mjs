// A stand-in mutation tool for the `command` adapter. One mutant per line of
// each `file:start-end` argument. A mutant is killed when some file under
// test/ contains the marker `kills:<file>:<line>`; otherwise it survives.
// FAKE_MUTATOR_PENDING=1 leaves every mutant unrun.
import fs from 'node:fs';
import path from 'node:path';

const tests = fs.existsSync('test')
  ? fs.readdirSync('test').map((f) => fs.readFileSync(path.join('test', f), 'utf8')).join('\n')
  : '';
const files = {};
for (const arg of process.argv.slice(2)) {
  const [, file, start, end] = /^(.*):(\d+)-(\d+)$/.exec(arg);
  files[file] ??= { mutants: [] };
  for (let line = Number(start); line <= Number(end); line++) {
    const killed = tests.includes(`kills:${file}:${line}`);
    files[file].mutants.push({
      id: `${file}:${line}`,
      mutatorName: 'Fake',
      replacement: `mutated line ${line}`,
      location: { start: { line, column: 0 }, end: { line, column: 1 } },
      status: process.env.FAKE_MUTATOR_PENDING ? 'Pending' : killed ? 'Killed' : 'Survived',
    });
  }
}
fs.mkdirSync('.gated', { recursive: true });
fs.writeFileSync('.gated/report.json', JSON.stringify({ schemaVersion: '2', files }));
fs.appendFileSync('.gated/mutator-calls.log', `${process.argv.slice(2).join(' ')}\n`);
