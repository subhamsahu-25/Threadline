import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { normalizeWhitespace, truncate } from '../../lib/text.js';
import { Claim, Document, Project, Source } from '../../models/index.js';
import { recordAudit } from '../audit.js';
import { extractClaimsForDocuments } from '../ai/extract.js';
import { linkSupersessions } from '../reconstruction/link.js';
import { chunkText } from './chunker.js';
import { collectDriveDocuments } from './googleDrive.js';
import { collectGithubDocuments } from './github.js';
import { parseFile } from './parsers.js';

function checksumOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function collectUploadDocuments(source) {
  if (!source.files || source.files.length === 0) {
    throw new AppError(422, 'no_files', 'This upload source has no files attached');
  }

  const documents = [];
  for (const file of source.files) {
    const filePath = path.join(env.uploadDir, path.basename(file.storedName));
    let buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch {
      throw new AppError(
        422,
        'file_missing',
        `Stored upload "${file.originalName}" is no longer available; re-upload it`,
      );
    }
    const parsed = await parseFile({ buffer, filename: file.originalName });
    documents.push({
      kind: 'upload',
      title: file.originalName,
      path: file.originalName,
      mime: file.mime || 'text/plain',
      size: file.size || buffer.length,
      rawText: parsed.text,
      parseWarnings: parsed.warnings,
      locator: { path: file.originalName },
      meta: {},
    });
  }
  return documents;
}

async function collectDocuments(source) {
  if (source.kind === 'upload') return collectUploadDocuments(source);
  if (source.kind === 'github') return collectGithubDocuments(source.externalRef);
  if (source.kind === 'drive') return collectDriveDocuments(source.externalRef);
  throw new AppError(400, 'unknown_source', `Unsupported source kind: ${source.kind}`);
}

async function retirePreviousContent(sourceId, now) {
  await Promise.all([
    Document.updateMany({ source: sourceId, retiredAt: null }, { $set: { retiredAt: now } }),
    Claim.updateMany({ source: sourceId, retiredAt: null }, { $set: { retiredAt: now } }),
  ]);
}

async function persistDocuments({ source, documents }) {
  const previous = await Document.findOne({ source: source._id }).sort({ revision: -1 }).lean();
  const revision = (previous?.revision || 0) + 1;
  const seen = new Set();
  const created = [];

  for (const input of documents) {
    const rawText = normalizeWhitespace(input.rawText);
    if (rawText.length < 20) {
      logger.warn({ source: String(source._id), title: input.title }, 'Skipped empty document');
      continue;
    }
    const checksum = checksumOf(rawText);
    if (seen.has(checksum)) {
      logger.info({ source: String(source._id), title: input.title }, 'Skipped duplicate document');
      continue;
    }
    seen.add(checksum);

    const chunks = chunkText(rawText);
    if (chunks.length === 0) continue;

    const document = await Document.create({
      project: source.project,
      source: source._id,
      kind: input.kind,
      title: input.title,
      path: input.path || input.title,
      mime: input.mime || 'text/markdown',
      size: input.size || rawText.length,
      checksum,
      author: input.author,
      occurredAt: input.occurredAt || null,
      locator: input.locator || {},
      rawText,
      chunks,
      revision,
      parseWarnings: input.parseWarnings || [],
      meta: { ...(input.meta || {}), revision },
    });
    created.push(document);
  }

  return created;
}

async function refreshSourceStats(source) {
  const [documents, claims, unverifiedClaims] = await Promise.all([
    Document.countDocuments({ source: source._id, retiredAt: null }),
    Claim.countDocuments({ source: source._id, retiredAt: null }),
    Claim.countDocuments({ source: source._id, retiredAt: null, verifiedEvidenceCount: 0 }),
  ]);
  source.stats = { documents, claims, unverifiedClaims };
  return source.stats;
}

export async function processSourceJob(job) {
  const { sourceId } = job.payload || {};
  const source = await Source.findById(sourceId);
  if (!source || source.deletedAt) return;

  const project = await Project.findById(source.project);
  if (!project) return;

  source.status = 'processing';
  source.statusMessage = 'Collecting and reading source documents';
  await source.save();

  try {
    const documentInputs = await collectDocuments(source);
    const now = new Date();

    await retirePreviousContent(source._id, now);
    const documents = await persistDocuments({ source, documents: documentInputs });
    if (documents.length === 0) {
      throw new AppError(422, 'no_documents', 'No readable documents were found for this source');
    }

    const extraction = await extractClaimsForDocuments({ project, source, documents });
    const superseded = await linkSupersessions(project._id);
    const stats = await refreshSourceStats(source);

    source.status = 'ready';
    source.statusMessage = `${documents.length} document(s), ${stats.claims} item(s) extracted`;
    source.lastIngestedAt = new Date();
    await source.save();

    await recordAudit({
      projectId: project._id,
      actor: { name: 'threadline-pipeline' },
      action: 'source.ingested',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {
        documents: documents.length,
        claims: stats.claims,
        newClaims: extraction.created,
        method: extraction.method,
        superseded,
      },
    });

    logger.info(
      {
        source: String(source._id),
        documents: documents.length,
        claims: stats.claims,
        method: extraction.method,
      },
      'Source ingested',
    );
  } catch (error) {
    source.status = 'failed';
    source.statusMessage = truncate(error.message || 'Ingestion failed', 400);
    await source.save();

    await recordAudit({
      projectId: project._id,
      actor: { name: 'threadline-pipeline' },
      action: 'source.failed',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: { message: truncate(error.message || 'Ingestion failed', 300) },
    });

    throw error;
  }
}

export async function recoverInterruptedSources() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const stuck = await Source.find({
    status: { $in: ['queued', 'processing'] },
    deletedAt: null,
    updatedAt: { $lt: cutoff },
  });

  for (const source of stuck) {
    source.status = 'queued';
    source.statusMessage = 'Re-queued after an interrupted run';
    await source.save();
    const { enqueue } = await import('../queue.js');
    enqueue('ingest_source', { sourceId: String(source._id) });
  }
  return stuck.length;
}
