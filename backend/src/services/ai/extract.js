import { env, llmEnabled } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { keyOf, locateQuote, truncate } from '../../lib/text.js';
import { Claim, Evidence, CLAIM_TYPES, CLAIM_STATUSES } from '../../models/index.js';
import { contextBefore } from '../ingest/chunker.js';
import { heuristicExtract } from './heuristics.js';
import { generateJson } from './llm.js';

const ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    type: {
      type: 'STRING',
      enum: ['decision', 'task', 'risk', 'dependency', 'question', 'milestone', 'responsibility', 'next_action'],
    },
    statement: { type: 'STRING' },
    topic: { type: 'STRING' },
    status: { type: 'STRING', enum: CLAIM_STATUSES },
    owner: { type: 'STRING' },
    dueDate: { type: 'STRING' },
    occurredAt: { type: 'STRING' },
    quote: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
    rationale: { type: 'STRING' },
  },
  required: ['type', 'statement', 'quote', 'confidence'],
  propertyOrdering: [
    'type',
    'statement',
    'topic',
    'status',
    'owner',
    'dueDate',
    'occurredAt',
    'quote',
    'confidence',
    'rationale',
  ],
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: { items: { type: 'ARRAY', items: ITEM_SCHEMA } },
  required: ['items'],
  propertyOrdering: ['items'],
};

const SYSTEM_PROMPT = [
  'You extract structured project knowledge for a knowledge-handover system.',
  'Only extract facts that are explicitly stated in the provided chunk.',
  'Never invent owners, dates, reasons or decisions.',
  'The "quote" field must be copied verbatim from the chunk, character for character.',
  'If a sentence is vague, aspirational or has no supporting evidence, do not extract it.',
  'Return at most 12 items. Do not duplicate items that say the same thing.',
].join(' ');

const USER_PROMPT = [
  'Project: {{project}}',
  'Source: {{source}}',
  'Document: {{document}}',
  '',
  'Extract decisions, tasks, risks, dependencies, open questions, milestones and ownership statements.',
  'Rules:',
  '- decision: something explicitly decided, approved or chosen (include the reason if stated).',
  '- task: explicit unfinished work, TODO, action item or checkbox.',
  '- risk: explicit risk, blocker or concern.',
  '- dependency: explicit upstream dependency or external team/tool the work relies on.',
  '- question: an explicit open or unresolved question.',
  '- milestone: an explicit release, deadline or milestone.',
  '- responsibility: an explicit statement of who owns what.',
  '- topic: a short 2-5 word phrase naming the subject area (used to group related items).',
  '- status: open, active, planned, done, resolved, superseded or unknown.',
  '- owner only when a person is named as owner in the text.',
  '- dueDate / occurredAt only as ISO dates that appear in the text.',
  '- occurredAt is the date the decision/event happened, if stated.',
  '- confidence between 0 and 1 reflecting how explicit the evidence is.',
  '',
  'Text before the chunk (context only, do not quote from it):',
  '{{context}}',
  '',
  'Chunk to extract from:',
  '"""',
  '{{chunk}}',
  '"""',
].join('\n');

function fill(template, values) {
  return template.replace(/{{(\w+)}}/g, (_match, key) => values[key] ?? '');
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function normalizeItem(raw, doc) {
  if (!raw || typeof raw !== 'object') return null;
  const type = CLAIM_TYPES.includes(raw.type) ? raw.type : null;
  const statement = String(raw.statement ?? '').trim().slice(0, 600);
  const quote = String(raw.quote ?? '').trim().slice(0, 1200);
  if (!type || !statement || !quote) return null;
  const status = CLAIM_STATUSES.includes(raw.status) ? raw.status : defaultStatusFor(type);
  const dateFromText = quote.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];

  return {
    type,
    statement,
    topic: String(raw.topic ?? '').trim().slice(0, 120),
    status,
    owner: raw.owner ? String(raw.owner).replace(/^@/, '').trim().slice(0, 80) : null,
    dueDate: parseDate(raw.dueDate),
    occurredAt: parseDate(raw.occurredAt) || parseDate(dateFromText) || doc.occurredAt || null,
    quote,
    confidence: clampConfidence(raw.confidence),
    flags: Array.isArray(raw.flags) ? raw.flags.filter((flag) => typeof flag === 'string') : [],
  };
}

function defaultStatusFor(type) {
  if (type === 'decision' || type === 'responsibility') return 'active';
  if (type === 'milestone') return 'planned';
  return 'open';
}

async function llmExtract({ project, source, doc, chunk }) {
  const prompt = fill(USER_PROMPT, {
    project: project.name,
    source: source.name,
    document: doc.title,
    context: truncate(contextBefore(doc.rawText, chunk.start), 600) || '(none)',
    chunk: chunk.text,
  });

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await generateJson({
        system: SYSTEM_PROMPT,
        prompt,
        schema: RESPONSE_SCHEMA,
        temperature: 0.1,
        maxOutputTokens: 2600,
      });
      return Array.isArray(data.items) ? data.items : [];
    } catch (error) {
      lastError = error;
      const retriable = !error.status || error.status === 429 || error.status >= 500;
      if (!retriable || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }
  throw lastError;
}

async function extractItemsForChunk({ project, source, doc, chunk }) {
  if (llmEnabled) {
    try {
      const raw = await llmExtract({ project, source, doc, chunk });
      const items = raw.map((item) => normalizeItem(item, doc)).filter(Boolean);
      if (items.length > 0) {
        return items.map((item) => ({ ...item, method: 'llm', model: env.geminiModel }));
      }
    } catch (error) {
      logger.warn(
        { document: doc.title, chunk: chunk.index, error: error.message },
        'LLM extraction failed, falling back to deterministic extractor',
      );
    }
  }

  return heuristicExtract({ text: chunk.text, docTitle: doc.title }).map((item) => ({
    ...item,
    method: 'heuristic',
    model: 'deterministic-heuristic',
  }));
}

function resolveEvidence({ doc, chunk, quote }) {
  const inChunk = locateQuote(chunk.text, quote);
  if (inChunk.ok) {
    return {
      chunkId: chunk._id,
      charStart: chunk.start + inChunk.start,
      charEnd: chunk.start + inChunk.end,
      quote: doc.rawText.slice(chunk.start + inChunk.start, chunk.start + inChunk.end),
      validation: inChunk.match === 'exact' ? 'exact' : 'normalized',
    };
  }

  const inDocument = locateQuote(doc.rawText, quote);
  if (inDocument.ok) {
    const owningChunk = doc.chunks.find(
      (entry) => inDocument.start >= entry.start && inDocument.start < entry.end,
    );
    return {
      chunkId: owningChunk?._id,
      charStart: inDocument.start,
      charEnd: inDocument.end,
      quote: doc.rawText.slice(inDocument.start, inDocument.end),
      validation: 'normalized',
    };
  }

  return {
    chunkId: chunk._id,
    charStart: chunk.start,
    charEnd: Math.min(chunk.end, chunk.start + quote.length),
    quote: truncate(quote, 500),
    validation: 'failed',
  };
}

function dedupeKey(claim) {
  return `${claim.type}|${claim.topicKey}|${claim.statementKey}`;
}

async function addEvidence({ claim, doc, source, resolved }) {
  try {
    await Evidence.create({
      project: doc.project,
      claim: claim._id,
      source: source._id,
      document: doc._id,
      chunkId: resolved.chunkId,
      quote: resolved.quote,
      charStart: resolved.charStart,
      charEnd: resolved.charEnd,
      locale: {
        path: doc.path,
        url: doc.locator?.url,
        title: doc.title,
      },
      validation: resolved.validation,
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}

async function refreshClaim(claim) {
  const evidence = await Evidence.find({ claim: claim._id }).select('validation').lean();
  claim.evidenceCount = evidence.length;
  claim.verifiedEvidenceCount = evidence.filter((entry) => entry.validation !== 'failed').length;

  const flags = new Set(claim.flags || []);
  if (claim.verifiedEvidenceCount === 0) {
    claim.state = 'needs_review';
    flags.add('unverified_citation');
  } else {
    if (claim.state === 'needs_review' && flags.has('unverified_citation')) claim.state = 'confirmed';
    flags.delete('unverified_citation');
  }

  if (claim.type === 'task' && claim.status === 'open' && !claim.ownerName) {
    flags.add('missing_owner');
  } else {
    flags.delete('missing_owner');
  }

  claim.flags = [...flags];
  await claim.save();
}

export async function extractClaimsForDocuments({ project, source, documents }) {
  const method = llmEnabled ? 'llm' : 'heuristic';
  const model = llmEnabled ? env.geminiModel : 'deterministic-heuristic';
  const existing = await Claim.find({ source: source._id, retiredAt: null });
  const byKey = new Map(existing.map((claim) => [dedupeKey(claim), claim]));

  let created = 0;
  let merged = 0;

  for (const doc of documents) {
    for (const chunk of doc.chunks) {
      const items = await extractItemsForChunk({ project, source, doc, chunk });
      for (const item of items) {
        const statementKey = keyOf(item.statement);
        if (!statementKey) continue;
        const topic = item.topic || doc.title;
        const topicKey = keyOf(topic);
        const key = `${item.type}|${topicKey}|${statementKey}`;

        let claim = byKey.get(key);
        if (!claim) {
          claim = await Claim.create({
            project: project._id,
            source: source._id,
            document: doc._id,
            type: item.type,
            statement: item.statement,
            statementKey,
            topic: topic.slice(0, 160),
            topicKey,
            status: item.status,
            state: 'confirmed',
            confidence: item.confidence,
            sensitivity: source.sensitivity,
            ownerName: item.owner,
            dueAt: item.dueDate,
            occurredAt: item.occurredAt,
            flags: item.flags || [],
            extraction: { method: item.method, model: item.model },
          });
          byKey.set(key, claim);
          created += 1;
        } else {
          merged += 1;
        }

        await addEvidence({
          claim,
          doc,
          source,
          resolved: resolveEvidence({ doc, chunk, quote: item.quote }),
        });
      }
    }
  }

  for (const claim of byKey.values()) {
    await refreshClaim(claim);
  }

  return { created, merged, method, model };
}
