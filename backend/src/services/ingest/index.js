import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { AppError, IngestCancelledError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { normalizeWhitespace, truncate } from '../../lib/text.js';
import { withOptionalTransaction } from '../../lib/transactions.js';
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
      // The upload directory is ephemeral on some hosts. The extracted text is
      // already in the database, so re-ingest re-chunks that instead of asking
      // the user to upload the file again.
      const stored = await Document.findOne({
        source: source._id,
        retiredAt: null,
        $or: [{ path: file.originalName }, { title: file.originalName }],
      })
        .sort({ revision: -1 })
        .lean();
      if (!stored?.rawText) {
        throw new AppError(
          422,
          'file_missing',
          `Stored upload "${file.originalName}" is no longer available; re-upload it`,
        );
      }
      documents.push({
        kind: 'upload',
        title: stored.title || file.originalName,
        path: stored.path || file.originalName,
        mime: stored.mime || file.mime || 'text/plain',
        size: stored.size || stored.rawText.length,
        rawText: stored.rawText,
        parseWarnings: stored.parseWarnings || [],
        locator: stored.locator || { path: file.originalName },
        meta: stored.meta || {},
      });
      continue;
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

/** Stored documents for a connector section GitHub answered "not modified". */
async function loadConnectorDocuments(source, kinds) {
  const rows = await Document.find({
    source: source._id,
    retiredAt: null,
    kind: { $in: kinds },
  })
    .sort({ title: 1 })
    .lean();
  return rows.map((row) => ({
    kind: row.kind,
    title: row.title,
    path: row.path,
    mime: row.mime,
    size: row.size,
    author: row.author,
    occurredAt: row.occurredAt,
    locator: row.locator,
    rawText: row.rawText,
    parseWarnings: row.parseWarnings || [],
    meta: row.meta || {},
  }));
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new IngestCancelledError('Run was cancelled before it could finish');
  }
}

async function collectDocuments(source, signal) {
  throwIfAborted(signal);
  if (source.kind === 'upload') return collectUploadDocuments(source);
  if (source.kind === 'github') {
    // ETags live on the source cursor so an unchanged repository costs a few
    // conditional requests and no re-download.
    source.sync.cursor = source.sync.cursor || {};
    const cache = source.sync.cursor.httpCache || {};
    source.sync.cursor.httpCache = cache;
    const documents = await collectGithubDocuments(source.externalRef, {
      cache,
      loadPrevious: (kinds) => loadConnectorDocuments(source, kinds),
    });
    throwIfAborted(signal);
    return documents;
  }
  if (source.kind === 'drive') {
    const documents = await collectDriveDocuments(source.externalRef);
    throwIfAborted(signal);
    return documents;
  }
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
    const retryAt = error.retryAt instanceof Date ? error.retryAt : null;
    await Source.updateOne(
      { _id: source._id },
      {
        $set: {
          'sync.lastCheckedAt': new Date(),
          'sync.lastError': truncate(error.message || 'Sync check failed', 300),
          ...(retryAt ? { 'sync.nextAttemptAt': retryAt } : {}),
        },
      },
    );
    logger.warn(
      { source: String(source._id), error: error.message, retryAt },
      'Source sync check failed; previous knowledge kept',
    );
    return { changed: false, error: error.message, retryAt };
  }

  const checksum = documentsChecksum(documents);
  const checkedAt = new Date();
  const httpCache = source.sync?.cursor?.httpCache;
  const previousChecksum = source.sync?.cursor?.checksum;
  if (previousChecksum && previousChecksum === checksum) {
    // The content was fetched successfully and matches what was stored, so the
    // new ETags are safe to keep: a later check can use them.
    await Source.updateOne(
      { _id: source._id },
      {
        $set: {
          'sync.lastCheckedAt': checkedAt,
          'sync.lastError': null,
          ...(httpCache ? { 'sync.cursor.httpCache': httpCache } : {}),
        },
      },
    );
    return { changed: false };
  }

  logger.info({ source: String(source._id) }, 'Connected source changed; re-ingesting');
  // The new ETags stay in memory until ingestion commits. Saving them here
  // meant a failed re-ingest was never retried: the next check got 304 and
  // compared the old stored text with itself.
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
    payload: { sourceId: String(source._id), documents, pendingHttpCache: httpCache || null },
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
    const normalized = normalizeWhitespace(input.rawText);
    if (normalized.length < 20) {
      logger.warn({ source: String(source._id), title: input.title }, 'Skipped empty document');
      continue;
    }
    const parseWarnings = [...(input.parseWarnings || [])];
    const truncatedText = normalized.length > env.maxDocumentChars;
    const rawText = truncatedText ? normalized.slice(0, env.maxDocumentChars) : normalized;
    if (truncatedText) {
      parseWarnings.push(
        `Stored the first ${env.maxDocumentChars.toLocaleString('en-US')} of ${normalized.length.toLocaleString(
          'en-US',
        )} characters; the remainder was not analysed`,
      );
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
      size: input.size || normalized.length,
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
  // Only claims whose document belongs to this run are removed. A superseded
  // run can finish its rollback after a retry already wrote claims; deleting
  // every unseen claim would take those with it.
  await Claim.deleteMany({
    source: source._id,
    document: { $in: documentIds },
    _id: { $nin: previousIds },
  });
  await Document.deleteMany({ _id: { $in: documentIds } });

  if (snapshotClaims.length > 0) {
    // Restore the complete prior row. Field-by-field repair used to leave the
    // status, confidence, state and derived counts at their half-merged values.
    for (const snapshot of snapshotClaims) {
      await Claim.replaceOne({ _id: snapshot._id }, snapshot.toObject()).catch(() => {});
    }
    const survivors = await Claim.find({ _id: { $in: previousIds } });
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
  const signal = job.signal || null;

  // Claim the job atomically so two queued runs cannot process the same source
  // concurrently and retire each other's output. Queue retries may resume a
  // source that the previous attempt marked as failed.
  const runId = randomUUID();
  const claimFilter = {
    _id: sourceId,
    deletedAt: null,
    status: job.attempts > 1 ? { $in: ['queued', 'failed'] } : 'queued',
  };
  const source = await Source.findOneAndUpdate(
    claimFilter,
    {
      $set: {
        status: 'processing',
        statusMessage: 'Collecting and reading source documents',
        ingestRunId: runId,
      },
    },
    { new: true },
  );
  if (!source) {
    logger.info({ source: sourceId }, 'Skipped source job because the source is not queued');
    return;
  }
  // The queue needs the token to clear only the state its own abandoned run
  // wrote, and the run needs it to fence every commit.
  job.ingestRunId = runId;

  const project = await Project.findById(source.project);
  if (!project) {
    await Source.updateOne(
      { _id: source._id, ingestRunId: runId },
      {
        $set: { status: 'failed', statusMessage: 'Project no longer exists' },
        $unset: { ingestRunId: 1 },
      },
    );
    return;
  }

  let createdDocumentIds = [];
  let snapshotClaims = [];
  let resumeActive = false;
  // Tracks the in-flight progress write so the catch block can wait for it
  // before saving the failure state.
  let progressSave = Promise.resolve();

  // Every write this run makes carries the token, so a retry that replaced it
  // cannot be overwritten by a late segment of an abandoned run.
  const stillOwned = async () => Boolean(await Source.exists({ _id: source._id, ingestRunId: runId }));
  const writeOwned = (fields, unset = {}) =>
    Source.updateOne(
      { _id: source._id, ingestRunId: runId },
      { $set: fields, $unset: { ingestRunId: 1, ...unset } },
    );

  try {
    throwIfAborted(signal);
    const precollected = Array.isArray(job.payload?.documents) ? job.payload.documents : null;
    // A sync already fetched the provider's documents to fingerprint them.
    // Reusing that set avoids paying for every GitHub/Drive call twice.
    const documentInputs = precollected || (await collectDocuments(source, signal));
    if (documentInputs.length === 0) {
      throw new AppError(422, 'no_documents', 'No readable documents were found for this source');
    }

    const contentChecksum = documentsChecksum(documentInputs);
    const cursor = source.extractionCursor || {};
    const cursorDocumentIds = (cursor.documentIds || []).map(String);

    // A previous run that stopped on the time budget left its documents and
    // its last finished chunk behind. When the content is byte-identical,
    // continue from that chunk instead of discarding the work.
    let documents = [];
    if (
      cursor.checksum === contentChecksum &&
      cursor.chunkId &&
      cursorDocumentIds.length > 0
    ) {
      const resumed = await Document.find({
        _id: { $in: cursorDocumentIds },
        source: source._id,
      });
      if (resumed.length === cursorDocumentIds.length) {
        const byId = new Map(resumed.map((doc) => [String(doc._id), doc]));
        documents = cursorDocumentIds.map((id) => byId.get(id)).filter(Boolean);
        resumeActive = true;
        logger.info(
          { source: String(source._id), chunk: String(cursor.chunkId) },
          'Resuming partially extracted source from its saved cursor',
        );
      }
    }

    const previousDocuments = await Document.find({
      source: source._id,
      _id: { $nin: resumeActive ? cursorDocumentIds : [] },
    })
      .select('_id')
      .lean();
    const previousDocumentIds = previousDocuments.map((doc) => doc._id);
    snapshotClaims = await Claim.find({ source: source._id, retiredAt: null });

    if (!resumeActive) {
      documents = await persistDocuments({ source, documents: documentInputs });
      if (documents.length === 0) {
        throw new AppError(422, 'no_documents', 'No readable documents were found for this source');
      }
    }
    createdDocumentIds = documents.map((doc) => doc._id);

    let lastProgressSave = 0;
    const extraction = await extractClaimsForDocuments({
      project,
      source,
      documents,
      resume: resumeActive ? { chunkId: cursor.chunkId } : null,
      signal,
      onProgress: ({ chunksProcessed, chunksTotal }) => {
        if (chunksProcessed - lastProgressSave < 15) return;
        lastProgressSave = chunksProcessed;
        // Serialise progress writes and keep them token-gated: a run that
        // lost the source must not keep writing its progress line.
        progressSave = progressSave
          .then(() =>
            Source.updateOne(
              { _id: source._id, ingestRunId: runId },
              { $set: { statusMessage: `Extracting knowledge (${chunksProcessed}/${chunksTotal} chunks)` } },
            ),
          )
          .catch(() => {});
      },
    });

    if (extraction.partial) {
      const now = new Date();
      // Progress is kept: the documents stay, the previous revision is retired,
      // and unseen claims are not touched until a run reaches the last chunk.
      await Document.updateMany(
        { _id: { $in: previousDocumentIds }, retiredAt: null },
        { $set: { retiredAt: now } },
      );
      await refreshSourceStats(source);
      applyExtractionStats(source, extraction);
      source.extractionCursor = {
        checksum: contentChecksum,
        documentIds: createdDocumentIds,
        chunkId: extraction.lastProcessedChunkId || undefined,
        chunksProcessed: extraction.chunksProcessed,
        chunksTotal: extraction.chunksTotal,
        stoppedBy: extraction.stoppedBy || 'time_budget',
        updatedAt: now,
      };
      source.status = 'partial';
      source.statusMessage = truncate(
        `Stopped after ${extraction.chunksProcessed}/${extraction.chunksTotal} chunks (${
          extraction.stoppedBy || 'time_budget'
        }). Progress is saved — continue ingestion to finish the remaining chunks.`,
        400,
      );
      source.parseWarnings = [
        ...new Set([...summarizeWarnings(documents), ...(extraction.warnings || [])]),
      ].slice(0, 10);
      source.lastIngestedAt = now;
      await progressSave;
      const owned = await writeOwned({
        stats: source.stats,
        extractionCursor: source.extractionCursor,
        status: source.status,
        statusMessage: source.statusMessage,
        parseWarnings: source.parseWarnings,
        lastIngestedAt: source.lastIngestedAt,
      });
      if (!owned.matchedCount) {
        logger.info(
          { source: String(source._id), run: runId },
          'Discarded partial progress from a run that no longer owns the source',
        );
        return;
      }

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
          resumed: resumeActive,
          resumable: Boolean(extraction.lastProcessedChunkId),
        },
      });

      await refreshOutdatedHandovers({ projectId: project._id }).catch(() => {});
      return;
    }

    // Commit: the new revision becomes current. Claims that were not seen in
    // this run are retired, and prior evidence for carried-over claims is
    // removed so citations resolve against the fresh documents. A resumed run
    // also counts the claims written by the earlier segment of the same run.
    throwIfAborted(signal);
    if (!(await stillOwned())) {
      throw new IngestCancelledError('Another run claimed this source before the commit');
    }
    const now = new Date();
    const runClaims =
      createdDocumentIds.length > 0
        ? await Claim.find({
            source: source._id,
            retiredAt: null,
            document: { $in: createdDocumentIds },
          })
        : [];
    const keepClaimIds = new Set([
      ...extraction.claimIds.map(String),
      ...runClaims.map((claim) => String(claim._id)),
    ]);

    // Retiring claims and documents, dropping stale evidence and deleting the
    // old revisions are one logical commit. On a replica set they run in a
    // transaction; on a standalone server the same steps run sequentially.
    await withOptionalTransaction(async (session) => {
      const use = (query) => (session ? query.session(session) : query);
      // The first write of the commit re-asserts ownership, so a retry that
      // claimed the source after the check above aborts this commit before any
      // claim or document is touched.
      const guard = await use(
        Source.updateOne(
          { _id: source._id, ingestRunId: runId },
          { $set: { statusMessage: source.statusMessage } },
        ),
      );
      if (!guard.matchedCount) {
        throw new IngestCancelledError('Another run claimed this source during the commit');
      }
      await use(
        Claim.updateMany(
          {
            source: source._id,
            retiredAt: null,
            _id: { $nin: [...keepClaimIds] },
          },
          { $set: { retiredAt: now } },
        ),
      );
      await use(
        Document.updateMany(
          { _id: { $in: previousDocumentIds }, retiredAt: null },
          { $set: { retiredAt: now } },
        ),
      );
      // Evidence attached to the old revision can no longer resolve; handover
      // items keep their own snapshot of the quote (D6).
      const sourceClaimsQuery = Claim.find({ source: source._id }).select('_id').lean();
      const sourceClaims = await (session ? sourceClaimsQuery.session(session) : sourceClaimsQuery);
      const sourceClaimIds = sourceClaims.map((claim) => claim._id);
      await use(
        Evidence.deleteMany({
          claim: { $in: sourceClaimIds },
          document: { $nin: createdDocumentIds },
        }),
      );
      // Retired revisions were never removed before, so full old texts
      // accumulated forever.
      await use(
        Document.deleteMany({
          source: source._id,
          retiredAt: { $ne: null },
          _id: { $nin: createdDocumentIds },
        }),
      );
    });

    await refreshClaims([...extraction.claims, ...runClaims.filter(
      (claim) => !extraction.claims.some((entry) => String(entry._id) === String(claim._id)),
    )]);
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

    const warnings = [
      ...new Set([...summarizeWarnings(documents), ...(extraction.warnings || [])]),
    ].slice(0, 10);
    const previousChecksum = source.sync?.cursor?.checksum;
    const connectorChanged =
      source.kind !== 'upload' && Boolean(previousChecksum) && previousChecksum !== contentChecksum;
    if (source.kind !== 'upload') {
      const pendingHttpCache = job.payload?.pendingHttpCache;
      source.sync.cursor = {
        ...(source.sync.cursor || {}),
        checksum: contentChecksum,
        ...(pendingHttpCache ? { httpCache: pendingHttpCache } : {}),
      };
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
    const syncFields =
      source.kind === 'upload'
        ? {}
        : {
            'sync.cursor': source.sync.cursor,
            'sync.lastCheckedAt': source.sync.lastCheckedAt,
            ...(connectorChanged || !previousChecksum
              ? { 'sync.lastChangedAt': source.sync.lastChangedAt }
              : {}),
          };
    await progressSave;
    const committed = await writeOwned(
      {
        stats: source.stats,
        status: source.status,
        statusMessage: source.statusMessage,
        parseWarnings: source.parseWarnings,
        lastIngestedAt: source.lastIngestedAt,
        ...syncFields,
      },
      { extractionCursor: 1, ...(source.kind !== 'upload' ? { 'sync.lastError': 1 } : {}) },
    );
    if (!committed.matchedCount) {
      logger.warn(
        { source: String(source._id), run: runId },
        'Refused to commit an ingest run that no longer owns the source',
      );
      return;
    }

    // Uploaded originals are not needed after a successful ingest: the text is
    // stored with the document and re-ingest reuses it. This keeps
    // confidential files from lingering on an ephemeral disk.
    if (source.kind === 'upload') {
      await Promise.all(
        (source.files || []).map((file) =>
          fs.rm(path.join(env.uploadDir, path.basename(file.storedName)), { force: true }).catch(() => {}),
        ),
      );
    }

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
        resumed: resumeActive,
        keyFallbacks: extraction.keyFallbacks || 0,
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
        resumed: resumeActive,
      },
      'Source ingested',
    );

    try {
      const marked = await refreshOutdatedHandovers({ projectId: project._id });
      if (marked > 0) {
        logger.info(
          { project: String(project._id), handovers: marked },
          'Marked live handovers outdated after a source change',
        );
      }
    } catch (error) {
      logger.warn(
        { project: String(project._id), error: error.message },
        'Could not refresh handover freshness after a source change',
      );
    }
  } catch (error) {
    // A resumed run already committed earlier chunks; deleting its documents
    // would throw that work away and break its saved cursor.
    if (!resumeActive) {
      await rollbackRun({
        source,
        documentIds: createdDocumentIds,
        snapshotClaims,
      });
    }

    source.status = 'failed';
    source.statusMessage = truncate(error.message || 'Ingestion failed', 400);
    await progressSave;
    // A failure only becomes visible if this run still owns the source. When a
    // retry has replaced the token or the deadline handler already failed it,
    // the abandoned run stays silent instead of overwriting the newer state.
    const failed = await writeOwned({
      status: source.status,
      statusMessage: source.statusMessage,
    });
    if (!failed.matchedCount) {
      logger.info(
        { source: String(source._id), run: runId, error: error.message },
        'Discarded a failure write from a run that no longer owns the source',
      );
      throw error;
    }

    await recordAudit({
      projectId: project._id,
      actor: { name: 'threadline-pipeline' },
      action: 'source.failed',
      targetType: 'source',
      targetId: source._id,
      targetLabel: source.name,
      meta: {
        message: truncate(error.message || 'Ingestion failed', 300),
        resumed: resumeActive,
      },
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
    // The run that wrote the old token is gone; clearing it means a late
    // wake-up from that process cannot commit over the fresh queue entry.
    source.ingestRunId = undefined;
    await source.save();
    const { enqueue } = await import('../queue.js');
    enqueue('ingest_source', { sourceId: String(source._id) });
  }
  return stuck.length;
}
