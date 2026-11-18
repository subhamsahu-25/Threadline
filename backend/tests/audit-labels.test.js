import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_LABELS } from '../../frontend/src/lib/constants.js';

const SOURCE_DIR = fileURLToPath(new URL('../src', import.meta.url));

// Matches the `action:` value inside a recordAudit call, up to the next
// named field. The value may be a literal or a ternary spanning lines.
const ACTION_VALUE =
  /action:\s*([\s\S]*?)(?=,\s*(?:targetType|targetId|targetLabel|meta|req|critical)\b)/g;

async function javascriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await javascriptFiles(entryPath)));
    else if (entryPath.endsWith('.js')) files.push(entryPath);
  }
  return files;
}

async function emittedActions() {
  const actions = new Set();
  for (const file of await javascriptFiles(SOURCE_DIR)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(ACTION_VALUE)) {
      for (const quoted of match[1].matchAll(/'([a-z]+\.[a-z_]+)'/g)) {
        actions.add(quoted[1]);
      }
    }
  }
  return actions;
}

describe('audit action labels', () => {
  it('labels every action the backend can write', async () => {
    const emitted = await emittedActions();
    expect(emitted.size).toBeGreaterThan(20);
    const unlabelled = [...emitted].filter((action) => !AUDIT_ACTION_LABELS[action]);
    expect(unlabelled).toEqual([]);
  });

  it('does not list actions that are never written', async () => {
    const emitted = await emittedActions();
    const stale = Object.keys(AUDIT_ACTION_LABELS).filter((action) => !emitted.has(action));
    expect(stale).toEqual([]);
  });
});
