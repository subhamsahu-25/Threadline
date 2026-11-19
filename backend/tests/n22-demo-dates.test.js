import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seed, startDb, stopDb } from './helpers.js';
import {
  DEMO_PROJECT_KEY,
  buildDemoDocuments,
  seedDemo,
} from '../src/demo/seed.js';
import { Document, Project, Source } from '../src/models/index.js';

function dayIso(now, offsetDays) {
  const date = new Date(now);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

describe('demo seed relative dates', () => {
  beforeAll(async () => {
    await startDb();
  });

  afterAll(async () => {
    await stopDb();
  });

  beforeEach(async () => {
    await seed();
  });

  it('builds seeded content from the supplied day', () => {
    const docs = buildDemoDocuments({ now: new Date('2030-06-15T00:00:00Z') });
    const byName = Object.fromEntries(docs.map((doc) => [doc.name, doc.content]));

    expect(byName['kickoff-notes.md']).toContain('date: 2030-03-15');
    expect(byName['kickoff-notes.md']).toContain('by 2030-07-11');
    expect(byName['kickoff-notes.md']).toContain('due: 2030-06-16');

    const board = byName['sprint-board.csv'];
    expect(board).toContain('2030-06-08');
    expect(board).toContain('2030-06-04');
    expect(board).toContain('2030-06-21');
    expect(board).toContain('2030-05-26');

    expect(byName['vendor-contract-summary.md']).toContain('before 2030-06-27');
  });

  it('does not reuse a frozen corpus across different seed days', () => {
    const today = buildDemoDocuments({ now: new Date('2030-06-15T00:00:00Z') });
    const later = buildDemoDocuments({ now: new Date('2031-01-05T00:00:00Z') });
    expect(today[0].content).not.toBe(later[0].content);
    expect(later[0].content).toContain('date: 2030-10-05');
  });

  it('refreshes project dates on reset', async () => {
    const project = await Project.findOne({ key: DEMO_PROJECT_KEY });
    project.startedAt = new Date('2024-01-01T00:00:00Z');
    project.targetDate = new Date('2024-02-01T00:00:00Z');
    await project.save();

    await seedDemo({ reset: true });

    const refreshed = await Project.findOne({ key: DEMO_PROJECT_KEY });
    const today = new Date();
    expect(refreshed.startedAt.toISOString().slice(0, 10)).toBe(dayIso(today, -92));
    expect(refreshed.targetDate.toISOString().slice(0, 10)).toBe(dayIso(today, 26));
  });

  it('reseeds source text with dates relative to today', async () => {
    const project = await Project.findOne({ key: DEMO_PROJECT_KEY });
    const source = await Source.findOne({ project: project._id, name: 'kickoff-notes.md' });
    const document = await Document.findOne({ source: source._id });

    expect(document.rawText).toContain(dayIso(new Date(), -92));
    expect(document.rawText).not.toContain('2025-');
  });

  it('still adopts a corpus seeded on an earlier day when resetting', async () => {
    const project = await Project.findOne({ key: DEMO_PROJECT_KEY });

    // Simulate a workspace whose sources predate the `seeded` flag and whose
    // text carries the dates of the day it was actually seeded.
    await Source.updateMany({ project: project._id }, { $unset: { seeded: 1 } });
    const documents = await Document.find({ project: project._id }).select('_id rawText');
    for (const document of documents) {
      const shifted = document.rawText.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '2024-01-01');
      await Document.updateOne({ _id: document._id }, { $set: { rawText: shifted } });
    }

    await seedDemo({ reset: true });

    expect(await Source.countDocuments({ project: project._id })).toBe(6);
    expect(await Source.countDocuments({ project: project._id, seeded: true })).toBe(6);
  });
});
