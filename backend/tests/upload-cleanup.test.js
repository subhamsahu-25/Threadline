import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { Source } from '../src/models/index.js';
import { removeOrphanUploads } from '../src/services/ingest/uploadJanitor.js';
import { app, auth, registerAndLogin, request, startDb, stopDb, whenIdle } from './helpers.js';

describe('upload file lifecycle', () => {
  let token;
  let userId;
  let projectId;

  async function uploadDirContents() {
    return new Set(await fs.readdir(env.uploadDir));
  }

  beforeAll(async () => {
    await startDb();
    const session = await registerAndLogin('uploader@limits.test', 'Upload Owner');
    token = session.token;
    userId = session.user.id;

    const project = await request(app)
      .post('/api/projects')
      .set(auth(token))
      .send({ key: 'UPL', name: 'Upload lifecycle', description: 'File lifecycle checks' });
    expect(project.status).toBe(201);
    projectId = project.body.project.id;
  });

  afterAll(async () => {
    await stopDb();
  });

  it('deletes written files when request validation fails', async () => {
    const before = await uploadDirContents();
    const response = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(token))
      .field('name', 'Bad visibility')
      .field('visibility', '{not valid json')
      .attach('files', Buffer.from('A readable note that is long enough to parse.'), 'note.md');
    expect(response.status).toBe(400);

    const after = await uploadDirContents();
    expect([...after].filter((name) => !before.has(name))).toEqual([]);
  });

  it('deletes files multer rejects before the handler runs', async () => {
    const before = await uploadDirContents();
    const response = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(token))
      .field('name', 'Executable')
      .attach('files', Buffer.from('MZ executable bytes'), 'payload.exe');
    expect(response.status).toBe(415);

    const after = await uploadDirContents();
    expect([...after].filter((name) => !before.has(name))).toEqual([]);
  });

  it('removes a successful upload but keeps files a source still references', async () => {
    const response = await request(app)
      .post(`/api/projects/${projectId}/sources/upload`)
      .set(auth(token))
      .field('name', 'Kept note')
      .attach(
        'files',
        Buffer.from('Decision: Keep the upload until its source is deleted.'),
        'kept.md',
      );
    expect(response.status).toBe(202);
    await whenIdle({ timeoutMs: 30_000 });

    const keptSource = await Source.findOne({ name: 'Kept note' }).lean();
    // The text is stored with the document, so a successful ingest deletes the
    // original upload instead of leaving it on disk forever.
    await expect(
      fs.stat(path.join(env.uploadDir, path.basename(keptSource.files[0].storedName))),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // A source whose ingest has not finished still needs its file, so the
    // janitor must keep anything a source row references.
    const inFlightName = 'in-flight-reference.md';
    const keptPath = path.join(env.uploadDir, inFlightName);
    await fs.writeFile(keptPath, 'pending');
    await Source.create({
      project: keptSource.project,
      kind: 'upload',
      name: 'Pending note',
      createdBy: userId,
      status: 'queued',
      files: [
        { originalName: 'pending.md', storedName: inFlightName, mime: 'text/markdown', size: 7 },
      ],
    });

    const orphanPath = path.join(env.uploadDir, 'orphan-stale.md');
    const freshPath = path.join(env.uploadDir, 'orphan-fresh.md');
    await fs.writeFile(orphanPath, 'orphan');
    await fs.writeFile(freshPath, 'fresh');
    const longAgo = new Date(Date.now() - 48 * 3_600_000);
    await fs.utimes(orphanPath, longAgo, longAgo);

    const result = await removeOrphanUploads({ olderThanHours: 24 });
    expect(result.removed).toBeGreaterThanOrEqual(1);

    await expect(fs.stat(keptPath)).resolves.toBeTruthy();
    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(freshPath)).resolves.toBeTruthy();

    await fs.unlink(freshPath);
  });
});
