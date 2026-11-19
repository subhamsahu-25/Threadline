# Quote accuracy

Generated 2026-11-16 by `npm run eval:quotes` (backend).

Threadline only counts a claim as verified when its stored quote can be located in the source
document, either character-for-character (`exact`) or after whitespace/case normalisation
(`normalized`). Quotes that cannot be located are recorded as `failed` and the claim is flagged
for review. Person-confirmed answers are excluded from this report because they are confirmed by
a named teammate, not validated against a document quote.

Quotes that contain redaction markers (`[REDACTED: kind]`) cannot be compared literally with the
raw document, so they are checked differently: a linear scan locates the passages around each
marker within a fixed time budget, and the quote is accepted only when re-running the redactor on
the located passage reproduces the model's quote exactly. A marker quote whose located passage
does not re-redact to the same text, or that resolves to a single short fragment, is recorded as
`failed` rather than credited at the wrong offset.

The corpus is the ATLAS demo documents (six labelled uploads) plus `messy-standup-dump.txt`, a
deliberately unlabelled chat export with no decision/task prefixes. A single claim is counted under
its best evidence: `exact` if any quote matched exactly, else `normalized`, else `failed`.

## Deterministic rules extractor

- Extraction engine used: deterministic rules extractor (no LLM requests made)
- Claims extracted by: 0 Gemini, 29 deterministic rules
- Claims evaluated: 29 (person-confirmed claims excluded)
- Verified (exact or normalised quote found): 29 of 29 — **100.0%**

By quote-match method:

| Method     | Claims | Share  |
| ---------- | ------ | ------ |
| exact      | 29     | 100.0% |
| normalized | 0      | 0.0%   |
| failed     | 0      | 0.0%   |

By claim type:

| Claim type | Claims | Verified | Rate   | Exact | Normalized | Failed |
| ---------- | ------ | -------- | ------ | ----- | ---------- | ------ |
| decision   | 7      | 7        | 100.0% | 7     | 0          | 0      |
| dependency | 3      | 3        | 100.0% | 3     | 0          | 0      |
| milestone  | 1      | 1        | 100.0% | 1     | 0          | 0      |
| question   | 3      | 3        | 100.0% | 3     | 0          | 0      |
| risk       | 5      | 5        | 100.0% | 5     | 0          | 0      |
| task       | 10     | 10       | 100.0% | 10    | 0          | 0      |

Evidence-level validation (every stored quote, including second citations):

| Method     | Quotes | Share  |
| ---------- | ------ | ------ |
| exact      | 29     | 100.0% |
| normalized | 0      | 0.0%   |
| failed     | 0      | 0.0%   |

Corpus split:

| Corpus        | Claims | Verified | Rate   | Failed |
| ------------- | ------ | -------- | ------ | ------ |
| ATLAS corpus  | 28     | 28       | 100.0% | 0      |
| messy fixture | 1      | 1        | 100.0% | 0      |

Sources ingested:

| Source                     | Status | Claims |
| -------------------------- | ------ | ------ |
| kickoff-notes.md           | ready  | 7      |
| architecture-decisions.md  | ready  | 5      |
| sprint-board.csv           | ready  | 5      |
| incident-review.md         | ready  | 4      |
| handover-notes.txt         | ready  | 4      |
| vendor-contract-summary.md | ready  | 3      |
| messy-standup-dump.txt     | ready  | 1      |

## Gemini

- Extraction engine used: Gemini (gemini-3.8-flash)
- Claims extracted by: 35 Gemini, 0 deterministic rules
- Claims evaluated: 35 (person-confirmed claims excluded)
- Verified (exact or normalised quote found): 35 of 35 — **100.0%**

By quote-match method:

| Method     | Claims | Share  |
| ---------- | ------ | ------ |
| exact      | 35     | 100.0% |
| normalized | 0      | 0.0%   |
| failed     | 0      | 0.0%   |

By claim type:

| Claim type     | Claims | Verified | Rate   | Exact | Normalized | Failed |
| -------------- | ------ | -------- | ------ | ----- | ---------- | ------ |
| decision       | 8      | 8        | 100.0% | 8     | 0          | 0      |
| dependency     | 4      | 4        | 100.0% | 4     | 0          | 0      |
| milestone      | 2      | 2        | 100.0% | 2     | 0          | 0      |
| question       | 5      | 5        | 100.0% | 5     | 0          | 0      |
| responsibility | 1      | 1        | 100.0% | 1     | 0          | 0      |
| risk           | 5      | 5        | 100.0% | 5     | 0          | 0      |
| task           | 10     | 10       | 100.0% | 10    | 0          | 0      |

Evidence-level validation (every stored quote, including second citations):

| Method     | Quotes | Share  |
| ---------- | ------ | ------ |
| exact      | 35     | 100.0% |
| normalized | 0      | 0.0%   |
| failed     | 0      | 0.0%   |

Corpus split:

| Corpus        | Claims | Verified | Rate   | Failed |
| ------------- | ------ | -------- | ------ | ------ |
| ATLAS corpus  | 28     | 28       | 100.0% | 0      |
| messy fixture | 7      | 7        | 100.0% | 0      |

Sources ingested:

| Source                     | Status | Claims |
| -------------------------- | ------ | ------ |
| kickoff-notes.md           | ready  | 7      |
| architecture-decisions.md  | ready  | 5      |
| sprint-board.csv           | ready  | 5      |
| incident-review.md         | ready  | 4      |
| handover-notes.txt         | ready  | 4      |
| vendor-contract-summary.md | ready  | 3      |
| messy-standup-dump.txt     | ready  | 7      |

## How to reproduce

```bash
cd backend
npm run eval:quotes
```

The command uses an ephemeral in-memory MongoDB and a temporary upload directory, so it never
touches configured application data. Without `GEMINI_API_KEY` it runs the rules extractor only.
