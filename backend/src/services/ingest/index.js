import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { normalizeWhitespace, truncate } from '../../lib/text.js';
import { Claim, Document, Evidence, Project, Source } from '../../models/index.js';
import { recordAudit } from '../audit.js';
import { extractClaimsForDocuments, refreshClaims } from '../ai/extract.js';
import { refreshOutdatedHandovers } from '../handover/workflow.js';
import { linkSupersessions } from '../reconstruction/link.js';
import { chunkTextWithMeta } from './chunker.js';
import { collectDriveDocuments } from './googleDrive.js';
import { collectGithubDocuments } from './github.js';
import { parseFile } from './parsers.js';
import { documentsChecksum, isSyncable } from './sync.js';

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

/**
 * Checks whether a connected source changed without extracting anything when
 * it did not. A transient fetch failure is recorded on the sync cursor and
 * leaves the existing knowledge in place; the next interval retries.
 */
async function syncSourceJob(sourceId) {
  if (!sourceId) return { changed: false };
  const source = await Source.findOne({ _id: sourceId, deletedAt: null });
  if (!source || !isSyncable(source)) return { changed: false };
  if (['queued', 'processing'].includes(source.status)) {
    logger.info({ source: String(source._id) }, 'Skipped sync because ingestion is already running');
    return { changed: false };
  }

  const project = await Project.findById(source.project);
  if (!project) return { changed: false };

  let documents;
  try {
    documents = await collectDocuments(source);
  } catch (error) {
    await Source.updateOne(
      { _id: source._id },
      {
        $set: {
          'sync.lastCheckedAt': new Date(),
          'sync.lastError': truncate(error.message || 'Sync check failed', 300),
        },
      },
    );
    logger.warn(
      { source: String(source._id), error: error.message },
      'Source sync check failed; previous knowledge kept',
    );
    return { changed: false, error: error.message };
  }

  const checksum = documentsChecksum(documents);
  const checkedAt = new Date();
  const previousChecksum = source.sync?.cursor?.checksum;
  if (previousChecksum && previousChecksum === checksum) {
    await Source.updateOne(
      { _id: source._id },
      { $set: { 'sync.lastCheckedAt': checkedAt, 'sync.lastError': null } },
    );
    return { changed: false };
  }

  logger.info({ source: String(source._id) }, 'Connected source changed; re-ingesting');
  await Source.updateOne(
    { _id: source._id },
    {
      $set: {
        status: 'queued',
        statusMessage: 'Source changed; refreshing knowledge',
        'sync.lastCheckedAt': checkedAt,
        'sync.lastError': null,
      },
    },
  );
  await ingestSourceJob({
    name: 'ingest_source',
    payload: { sourceId: String(source._id) },
    attempts: 1,
  });
  return { changed: true };
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

    const plan = chunkTextWithMeta(rawText);
    const chunks = plan.chunks;
    if (chunks.length === 0) continue;

    const parseWarnings = [...(input.parseWarnings || [])];
    if (plan.droppedSections > 0) {
      parseWarnings.push(
        `Processed ${chunks.length} of ${plan.totalSections} text sections (${plan.keptChars.toLocaleString(
          'en-US',
        )} of ${plan.totalChars.toLocaleString('en-US')} characters); the remainder was not analysed`,
      );
    } else {
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk.end < rawText.length) {
        parseWarnings.push(
          `Only the first ${lastChunk.end.toLocaleString('en-US')} of ${rawText.length.toLocaleString(
            'en-US',
          )} characters were analysed`,
        );
      }
    }

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
      parseWarnings,
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
    Claim.countDocuments({
      source: source._id,
      retiredAt: null,
      verifiedEvidenceCount: 0,
      origin: { $ne: 'person_confirmed' },
    }),
  ]);
  source.stats = { documents, claims, unverifiedClaims };
  return source.stats;
}

function summarizeWarnings(documents) {
  return [...new Set(documents.flatMap((doc) => doc.parseWarnings || []))].slice(0, 10);
}

function applyExtractionStats(source, extraction) {
  source.stats.llmChunks = extraction.llmChunks;
  source.stats.heuristicChunks = extraction.heuristicChunks;
  source.stats.chunksProcessed = extraction.chunksProcessed;
  source.stats.chunksTotal = extraction.chunksTotal;
}

async function rollbackRun({ source, documentIds, snapshotClaims }) {
  if (documentIds.length === 0) return;

  await Evidence.deleteMany({ document: { $in: documentIds } });
  const previousIds = snapshotClaims.map((claim) => claim._id);
  await Claim.deleteMany({ source: source._id, _id: { $nin: previousIds } });
  await Document.deleteMany({ _id: { $in: documentIds } });

  if (snapshotClaims.length > 0) {
    const byId = new Map(snapshotClaims.map((claim) => [String(claim._id), claim]));
    const survivors = await Claim.find({ _id: { $in: [...byId.keys()] } });
    for (const claim of survivors) {
      const snapshot = byId.get(String(claim._id));
      claim.ownerName = snapshot.ownerName;
      claim.ownerUser = snapshot.ownerUser;
      claim.dueAt = snapshot.dueAt;
      claim.occurredAt = snapshot.occurredAt;
      claim.sensitivity = snapshot.sensitivity;
      claim.flags = snapshot.flags;
      claim.document = snapshot.document;
      claim.retiredAt = snapshot.retiredAt;
      await claim.save();
    }
    await refreshClaims(survivors);
  }
}

export async function processSourceJob(job) {
  if (job?.name === 'sync_source') {
    return syncSourceJob(job.payload?.sourceId);
  }
  return ingestSourceJob(job);
}

async function ingestSourceJob(job) {
  const { sourceId } = job.payload || {};

  // Claim the job atomically so two queued runs cannot process the same source
  // concurrently and retire each other's output. Queue retries may resume a
  // source that the previous attempt marked as failed.
  const claimFilter = {
    _id: sourceId,
    deletedAt: null,
    status: job.attempts > 1 ? { $in: ['queued', 'failed'] } : 'queued',
  };
  const source = await Source.findOneAndUpdate(
    claimFilter,
    { $set: { status: 'processing', statusMessage: 'Collecting and reading source documents' } },
    { new: true },
  );
  if (!source) {
    logger.info({ source: sourceId }, 'Skipped source job because the source is not queued');
    return;
  }

  const project = await Project.findById(source.project);
  if (!project) {
    source.status = 'failed';
    source.statusMessage = 'Project no longer exists';
    await source.save();
    return;
  }

  let createdDocumentIds = [];
  let snapshotClaims = [];

  try {
    const documentInputs = await collectDocuments(source);
    if (documentInputs.length === 0) {
      throw new AppError(422, 'no_documents', 'No readable documents were found for this source');
    }

    const previousDocuments = await Document.find({ source: source._id }).select('_id').lean();
    const previousDocumentIds = previousDocuments.map((doc) => doc._id);
    snapshotClaims = await Claim.find({ source: source._id, retiredAt: null });

    const documents = await persistDocuments({ source, documents: documentInputs });
    createdDocumentIds = documents.map((doc) => doc._id);
    if (documents.length === 0) {
      throw new AppError(422, 'no_documents', 'No readable documents were found for this source');
    }

    let lastProgressSave = 0;
    const extraction = await extractClaimsForDocuments({
      project,
      source,
      documents,
      onProgress: ({ chunksProcessed, chunksTotal }) => {
        if (chunksProcessed - lastProgressSave < 15) return;
        lastProgressSave = chunksProcessed;
        source.statusMessage = `Extracting knowledge (${chunksProcessed}/${chunksTotal} chunks)`;
        source.save().catch(() => {});
      },
    });

    if (extraction.partial) {
      await rollbackRun({
        source,
        documentIds: createdDocumentIds,
        snapshotClaims,
      });
      createdDocumentIds = [];
      await refreshSourceStats(source);
      applyExtractionStats(source, extraction);
      source.status = 'partial';
      source.statusMessage = truncate(
        `Extraction stopped after ${extraction.chunksProcessed}/${extraction.chunksTotal} chunks (${extraction.stoppedBy}). Previous content was kept; re-ingest when the backend has more time.`,
        400,
      );
      source.lastIngestedAt = new Date();
      await source.save();

      await recordAudit({
        projectId: project._id,
        actor: { name: 'threadline-pipeline' },
        action: 'source.partial',
        targetType: 'source',
        targetId: source._id,
        targetLabel: source.name,
        meta: {
          chunksProcessed: extraction.chunksProcessed,
          chunksTotal: extraction.chunksTotal,
          stoppedBy: extraction.stoppedBy,
        },
      });
      return;
    }

    // Commit: the new revision becomes current. Claims that were not seen in
    // this run are retired, and prior evidence for carried-over claims is
    // removed so citations resolve against the fresh documents.
    const now = new Date();
    await Claim.updateMany(
      { source: source._id, retiredAt: null, _id: { $nin: extraction.claimIds } },
      { $set: { retiredAt: now } },
    );
    await Document.updateMany(
      { _id: { $in: previousDocumentIds }, retiredAt: null },
      { $set: { retiredAt: now } },
    );
    if (extraction.claimIds.length > 0) {
      await Evidence.deleteMany({
        claim: { $in: extraction.claimIds },
        document: { $nin: createdDocumentIds },
      });
    }

    await refreshClaims(extraction.claims);
    const stats = await refreshSourceStats(source);
    applyExtractionStats(source, extraction);

    let superseded = 0;
    try {
      superseded = await linkSupersessions(project._id);
    } catch (error) {
      logger.warn(
        { source: String(source._id), error: error.message },
        'Supersession linking failed after an otherwise successful ingestion',
      );
    }

    const warnings = summarizeWarnings(documents);
    const contentChecksum = documentsChecksum(documentInputs);
    const previousChecksum = source.sync?.cursor?.checksum;
    const connectorChanged =
      source.kind !== 'upload' && Boolean(previousChecksum) && previousChecksum !== contentChecksum;
    if (source.kind !== 'upload') {
      source.sync.cursor = { ...(source.sync.cursor || {}), checksum: contentChecksum };
      source.sync.lastCheckedAt = new Date();
      source.sync.lastError = undefined;
      if (connectorChanged || !previousChecksum) source.sync.lastChangedAt = new Date();
    }

    source.status = 'ready';
    source.statusMessage = truncate(
      `${documents.length} document(s), ${stats.claims} item(s) extracted · ${extraction.llmChunks} LLM chunk(s), ${extraction.heuristicChunks} heuristic chunk(s)`,
      400,
    );
    source.parseWarnings = warnings;
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
        mergedClaims: extraction.merged,
        method: extraction.method,
        chunks: extraction.chunksTotal,
        llmChunks: extraction.llmChunks,
        heuristicChunks: extraction.heuristicChunks,
        superseded,
        parseWarnings: warnings,
      },
    });

    logger.info(
      {
        source: String(source._id),
        documents: documents.length,
        claims: stats.claims,
        method: extraction.method,
        llmChunks: extraction.llmChunks,
        heuristicChunks: extraction.heuristicChunks,
      },
      'Source ingested',
    );

    if (source.kind !== 'upload') {
      try {
        const marked = await refreshOutdatedHandovers({ projectId: project._id });
        if (marked > 0) {
          logger.info(
            { project: String(project._id), handovers: marked },
            'Marked live handovers outdated after a connected source changed',
          );
        }
      } catch (error) {
        logger.warn(
          { project: String(project._id), error: error.message },
          'Could not refresh handover freshness after a source change',
        );
      }
    }
  } catch (error) {
    await rollbackRun({
      source,
      documentIds: createdDocumentIds,
      snapshotClaims,
    });

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
