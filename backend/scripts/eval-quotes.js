#!/usr/bin/env node
/**
 * Quote-accuracy evaluation for Threadline extraction.
 *
 * Runs the real ingestion pipeline over the ATLAS demo corpus plus one messy,
 * unlabelled fixture, then reports how many claims end up with a quote that is
 * exact, whitespace/case-normalised, or failed to locate in the source text.
 *
 * The orchestrator (no arguments) spawns two isolated child runs:
 *   - rules  : GEMINI_API_KEY forced empty, so only the deterministic extractor runs
 *   - gemini : same corpus through the configured Gemini model
 * Both children use a throwaway in-memory database and upload directory, so no
 * real data is touched. Results are written to docs/QUOTE_ACCURACY.md.
 *
 * Internal: `--mode rules|gemini` runs a single pass and prints EVAL_RESULT=<base64>.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '..');
const repoDir = path.resolve(backendDir, '..');
const docsDir = path.join(repoDir, 'docs');
const uploadDir = path.join(backendDir, 'storage', '.eval-quote-uploads');
const scriptPath = fileURLToPath(import.meta.url);

const MESSY_SOURCE_NAME = 'messy-standup-dump.txt';

// Deliberately unlabelled and unstructured: a pasted stand-up thread with no
// "Decision:" / "Task:" prefixes, inconsistent casing and trailing context.
const MESSY_FIXTURE = `standup thread - copied from chat export, sorry for the formatting

Priya 10:02
ok so we decided to keep the retry queue on SQS until the November release, moving it to Kafka would miss the date

Dev 10:04
the nightly reconciliation depends on the old billing cron until finance signs off on the new totals

Priya 10:06
@Dev can you own the cutoff-date validation? it has to land before 2026-11-28 or the migration window closes

Dev 10:07
yes. open question: do we backfill invoices older than 18 months? nobody has answered that since the workshop

Sam 10:09
risk: the vendor renewal lapses on 2026-12-03 if legal doesn't get the redlines back
Sam 10:10
and nobody knows who owns the on-call rotation after the team split
`;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function cleanMode(mode) {
  return mode === 'gemini' ? 'gemini' : 'rules';
}

async function runChild(mode) {
  await fs.mkdir(uploadDir, { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    MONGODB_URI: '',
    DB_NAME: '',
    UPLOAD_DIR: uploadDir,
    EXTRACT_TIME_BUDGET_MS: '300000',
  };
  if (mode === 'rules') env.GEMINI_API_KEY = '';

  const child = spawnSync(process.execPath, [scriptPath, '--mode', mode], {
    cwd: backendDir,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60_000,
  });

  if (child.status !== 0) {
    throw new Error(
      `${mode} run failed (exit ${child.status}):\n${child.stderr || child.stdout || 'no output'}`,
    );
  }

  const marker = child.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith('EVAL_RESULT='));
  if (!marker) throw new Error(`${mode} run produced no EVAL_RESULT marker`);
  return JSON.parse(Buffer.from(marker.slice('EVAL_RESULT='.length), 'base64').toString('utf8'));
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function table(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (cells) =>
    `| ${cells.map((cell, index) => String(cell).padEnd(widths[index])).join(' | ')} |`;
  return [
    line(headers),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
}

function renderResult(result) {
  const engine =
    result.engine.claimMethods.llm > 0
      ? `Gemini (${result.engine.model})`
      : 'deterministic rules extractor (no LLM requests made)';
  return [
    `- Extraction engine used: ${engine}`,
    `- Claims extracted by: ${result.engine.claimMethods.llm} Gemini, ${result.engine.claimMethods.heuristic} deterministic rules`,
    `- Claims evaluated: ${result.totals.claims} (person-confirmed claims excluded)`,
    `- Verified (exact or normalised quote found): ${result.totals.verified} of ${result.totals.claims} — **${pct(result.totals.rate)}**`,
    '',
    'By quote-match method:',
    '',
    table(
      ['Method', 'Claims', 'Share'],
      [
        ['exact', result.byMatch.exact, pct(result.byMatch.exact / Math.max(1, result.totals.claims))],
        [
          'normalized',
          result.byMatch.normalized,
          pct(result.byMatch.normalized / Math.max(1, result.totals.claims)),
        ],
        [
          'failed',
          result.byMatch.failed,
          pct(result.byMatch.failed / Math.max(1, result.totals.claims)),
        ],
      ],
    ),
    '',
    'By claim type:',
    '',
    table(
      ['Claim type', 'Claims', 'Verified', 'Rate', 'Exact', 'Normalized', 'Failed'],
      result.byType.map((row) => [
        row.type,
        row.claims,
        row.verified,
        pct(row.rate),
        row.exact,
        row.normalized,
        row.failed,
      ]),
    ),
    '',
    'Evidence-level validation (every stored quote, including second citations):',
    '',
    table(
      ['Method', 'Quotes', 'Share'],
      [
        ['exact', result.evidenceTotals.exact, pct(result.evidenceTotals.exact / Math.max(1, result.evidenceTotals.total))],
        [
          'normalized',
          result.evidenceTotals.normalized,
          pct(result.evidenceTotals.normalized / Math.max(1, result.evidenceTotals.total)),
        ],
        [
          'failed',
          result.evidenceTotals.failed,
          pct(result.evidenceTotals.failed / Math.max(1, result.evidenceTotals.total)),
        ],
      ],
    ),
    '',
    'Corpus split:',
    '',
    table(
      ['Corpus', 'Claims', 'Verified', 'Rate', 'Failed'],
      result.byCorpus.map((row) => [row.corpus, row.claims, row.verified, pct(row.rate), row.failed]),
    ),
    '',
    'Sources ingested:',
    '',
    table(
      ['Source', 'Status', 'Claims'],
      result.sources.map((source) => [source.name, source.status, source.claims]),
    ),
  ].join('\n');
}

function renderDoc({ rules, gemini, geminiSkipped }) {
  const sections = [
    '# Quote accuracy',
    '',
    `Generated ${todayIso()} by \`npm run eval:quotes\` (backend).`,
    '',
    'Threadline only counts a claim as verified when its stored quote can be located in the source',
    'document, either character-for-character (`exact`) or after whitespace/case normalisation',
    '(`normalized`). Quotes that cannot be located are recorded as `failed` and the claim is flagged',
    'for review. Person-confirmed answers are excluded from this report because they are confirmed by',
    'a named teammate, not validated against a document quote.',
    '',
    'The corpus is the ATLAS demo documents (six labelled uploads) plus `messy-standup-dump.txt`, a',
    'deliberately unlabelled chat export with no decision/task prefixes. A single claim is counted under',
    'its best evidence: `exact` if any quote matched exactly, else `normalized`, else `failed`.',
    '',
    '## Deterministic rules extractor',
    '',
    renderResult(rules),
    '',
    '## Gemini',
    '',
    gemini
      ? renderResult(gemini)
      : `Skipped: ${geminiSkipped || 'GEMINI_API_KEY is not configured'}. The rules-only run above\nstill exercises the full pipeline and the quote validator.`,
    '',
    '## How to reproduce',
    '',
    '```bash',
    'cd backend',
    'npm run eval:quotes',
    '```',
    '',
    'The command uses an ephemeral in-memory MongoDB and a temporary upload directory, so it never',
    'touches configured application data. Without `GEMINI_API_KEY` it runs the rules extractor only.',
    '',
  ];
  return sections.join('\n');
}

async function main() {
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='))?.split('=')[1]
    ?? (process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : null);

  if (modeArg) {
    await runSingle(cleanMode(modeArg));
    return;
  }

  await fs.rm(uploadDir, { recursive: true, force: true });
  const results = {};
  try {
    console.log('Running rules-only extraction…');
    results.rules = await runChild('rules');
    console.log('Rules-only run complete.');

    if (process.env.GEMINI_API_KEY) {
      console.log('Running Gemini extraction…');
      results.gemini = await runChild('gemini');
      console.log('Gemini run complete.');
    } else {
      console.log('GEMINI_API_KEY is not set; skipping the Gemini run.');
    }
  } finally {
    await fs.rm(uploadDir, { recursive: true, force: true });
  }

  await fs.mkdir(docsDir, { recursive: true });
  const output = path.join(docsDir, 'QUOTE_ACCURACY.md');
  await fs.writeFile(
    output,
    renderDoc({
      rules: results.rules,
      gemini: results.gemini,
      geminiSkipped: 'GEMINI_API_KEY is not configured',
    }),
  );
  console.log(`Wrote ${output}`);
}

async function runSingle(mode) {
  const { env } = await import('../src/config/env.js');
  const { connectDB, disconnectDB } = await import('../src/db/connect.js');
  const { seedDemo } = await import('../src/demo/seed.js');
  const { processSourceJob } = await import('../src/services/ingest/index.js');
  const { configureQueue, setJobHandler, enqueue, whenIdle } = await import(
    '../src/services/queue.js'
  );
  const { Claim, Evidence, Project, Source, User } = await import('../src/models/index.js');
  const { llmEnabled } = await import('../src/config/env.js');
  const { randomUUID } = await import('node:crypto');

  setJobHandler(processSourceJob);
  configureQueue({ concurrency: 2 });

  await connectDB();
  try {
    try {
      await seedDemo({ reset: true });
    } catch (error) {
      // The seed waits 180s for the demo sources; a slow model may need longer.
      if (!/Timed out waiting/.test(error.message)) throw error;
      await whenIdle({ timeoutMs: 15 * 60_000 });
    }

    const project = await Project.findOne({ key: 'ATLAS' });
    if (!project) throw new Error('ATLAS demo project was not seeded');
    const owner = await User.findById(project.owner);

    await fs.mkdir(env.uploadDir, { recursive: true });
    const storedName = `${Date.now()}-${randomUUID()}.txt`;
    const buffer = Buffer.from(MESSY_FIXTURE, 'utf8');
    await fs.writeFile(path.join(env.uploadDir, storedName), buffer);
    const messy = await Source.create({
      project: project._id,
      kind: 'upload',
      name: MESSY_SOURCE_NAME,
      externalRef: '',
      visibility: { scope: 'project', roles: [], users: [] },
      sensitivity: 'internal',
      createdBy: owner?._id,
      status: 'queued',
      files: [
        { originalName: MESSY_SOURCE_NAME, storedName, mime: 'text/plain', size: buffer.length },
      ],
    });
    enqueue('ingest_source', { sourceId: String(messy._id) });
    await whenIdle({ timeoutMs: 15 * 60_000 });

    const claims = await Claim.find({
      project: project._id,
      retiredAt: null,
      origin: { $ne: 'person_confirmed' },
    }).lean();
    const evidence = await Evidence.find({
      project: project._id,
      validation: { $in: ['exact', 'normalized', 'failed'] },
    })
      .select('claim validation')
      .lean();

    const sourceById = new Map(
      (await Source.find({ project: project._id }).select('name').lean()).map((source) => [
        String(source._id),
        source.name,
      ]),
    );
    const byClaim = new Map();
    for (const entry of evidence) {
      const key = String(entry.claim);
      if (!byClaim.has(key)) byClaim.set(key, []);
      byClaim.get(key).push(entry.validation);
    }

    const rows = claims.map((claim) => {
      const validations = byClaim.get(String(claim._id)) || [];
      const match = validations.includes('exact')
        ? 'exact'
        : validations.includes('normalized')
          ? 'normalized'
          : 'failed';
      const corpus =
        sourceById.get(String(claim.source)) === MESSY_SOURCE_NAME ? 'messy fixture' : 'ATLAS corpus';
      return {
        type: claim.type,
        match,
        corpus,
        engine: claim.extraction?.method === 'llm' ? 'llm' : 'heuristic',
      };
    });

    const evidenceCounts = { exact: 0, normalized: 0, failed: 0 };
    for (const entry of evidence) evidenceCounts[entry.validation] += 1;

    const group = (key) => {
      const buckets = new Map();
      for (const row of rows) {
        if (!buckets.has(row[key])) {
          buckets.set(row[key], {
            [key]: row[key],
            claims: 0,
            verified: 0,
            exact: 0,
            normalized: 0,
            failed: 0,
          });
        }
        const bucket = buckets.get(row[key]);
        bucket.claims += 1;
        if (row.match !== 'failed') bucket.verified += 1;
        bucket[row.match] += 1;
      }
      return [...buckets.values()]
        .map((bucket) => ({ ...bucket, rate: bucket.verified / Math.max(1, bucket.claims) }))
        .sort((a, b) => String(a[key]).localeCompare(String(b[key])));
    };

    const sources = await Source.find({ project: project._id }).select('name status').lean();
    const claimCountBySource = new Map();
    for (const claim of claims) {
      const name = sourceById.get(String(claim.source));
      claimCountBySource.set(name, (claimCountBySource.get(name) || 0) + 1);
    }

    const totals = {
      claims: rows.length,
      verified: rows.filter((row) => row.match !== 'failed').length,
      exact: rows.filter((row) => row.match === 'exact').length,
      normalized: rows.filter((row) => row.match === 'normalized').length,
      failed: rows.filter((row) => row.match === 'failed').length,
    };
    const result = {
      mode,
      engine: {
        llmEnabled,
        model: env.geminiModel,
        claimMethods: {
          llm: rows.filter((row) => row.engine === 'llm').length,
          heuristic: rows.filter((row) => row.engine === 'heuristic').length,
        },
      },
      totals: { ...totals, rate: totals.verified / Math.max(1, totals.claims) },
      byMatch: { exact: totals.exact, normalized: totals.normalized, failed: totals.failed },
      evidenceTotals: {
        ...evidenceCounts,
        total: evidenceCounts.exact + evidenceCounts.normalized + evidenceCounts.failed,
      },
      byType: group('type'),
      byCorpus: group('corpus'),
      sources: sources.map((source) => ({
        name: source.name,
        status: source.status,
        claims: claimCountBySource.get(source.name) || 0,
      })),
    };

    const outputLines = [
      `${mode} run: ${totals.verified}/${totals.claims} claims verified (${pct(
        result.totals.rate,
      )})`,
      `  exact=${totals.exact} normalized=${totals.normalized} failed=${totals.failed}`,
      ...result.byType.map(
        (row) => `  ${row.type.padEnd(16)} ${row.verified}/${row.claims} verified (${pct(row.rate)})`,
      ),
    ];
    console.log(outputLines.join('\n'));
    console.log(`EVAL_RESULT=${Buffer.from(JSON.stringify(result)).toString('base64')}`);
  } finally {
    await disconnectDB();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
