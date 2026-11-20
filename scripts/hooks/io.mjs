import fs from 'node:fs';

// Hook input arrives as one JSON document on stdin.
export function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

export const emit = (value) => process.stdout.write(JSON.stringify(value));
