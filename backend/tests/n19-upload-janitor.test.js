import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeOrphanUploads } from '../src/services/ingest/uploadJanitor.js';
import { startDb, stopDb } from './helpers.js';

function generatedName(ext = 'md') {
  return `${Date.now()}-${randomUUID()}.${ext}`;
}

async function stale(file) {
  const old = new Date(Date.now() - 48 * 3_600_000);
  await fs.utimes(file, old, old);
}

describe('N19 upload janitor safety', () => {
  const dirs = [];

  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(prefix) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `threadline-janitor-${prefix}-`));
    dirs.push(dir);
    return dir;
  }

  it('deletes only files that follow the generated upload pattern', async () => {
    const dir = await tempDir('pattern');
    const orphan = path.join(dir, generatedName());
    const unrelated = path.join(dir, 'handover-report.pdf');
    await fs.writeFile(orphan, 'orphan');
    await fs.writeFile(unrelated, 'keep me');
    await stale(orphan);
    await stale(unrelated);

    const result = await removeOrphanUploads({ dir, olderThanHours: 24 });

    expect(result.refused).toBeNull();
    expect(result.removed).toBe(1);
    await expect(fs.stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(unrelated)).resolves.toBeTruthy();
  });

  it('logs the deletion plan in dry-run mode without deleting anything', async () => {
    const dir = await tempDir('dry');
    const orphan = path.join(dir, generatedName());
    await fs.writeFile(orphan, 'orphan');
    await stale(orphan);

    const planned = await removeOrphanUploads({ dir, olderThanHours: 24, dryRun: true });
    expect(planned.dryRun).toBe(true);
    expect(planned.candidates).toBe(1);
    expect(planned.removed).toBe(0);
    await expect(fs.stat(orphan)).resolves.toBeTruthy();

    const actual = await removeOrphanUploads({ dir, olderThanHours: 24 });
    expect(actual.removed).toBe(1);
    await expect(fs.stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to run when the directory is a filesystem root', async () => {
    const result = await removeOrphanUploads({
      dir: path.parse(process.cwd()).root,
      olderThanHours: 24,
    });

    expect(result.refused).toBe('filesystem_root');
    expect(result.removed).toBe(0);
  });

  it('refuses a directory that mostly holds files it did not write', async () => {
    const dir = await tempDir('foreign');
    for (let index = 0; index < 30; index += 1) {
      await fs.writeFile(path.join(dir, `photo-${index}.jpg`), 'not an upload');
    }
    const orphan = path.join(dir, generatedName());
    await fs.writeFile(orphan, 'orphan');
    await stale(orphan);

    const result = await removeOrphanUploads({ dir, olderThanHours: 24 });

    expect(result.refused).toBe('unrecognized_entries');
    expect(result.removed).toBe(0);
    await expect(fs.stat(orphan)).resolves.toBeTruthy();
  });
});
