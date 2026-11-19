# Threadline Backend

Threadline turns scattered, authorised project activity into a **permission-aware,
evidence-linked handover** when someone leaves a project. This service ingests
project sources, extracts decisions/tasks/risks/dependencies/questions, validates
every claim against a verbatim source quote, reconstructs the current project
state, and lets a responsible person review, approve, share and track
acknowledgement of the handover.

The guiding rule: **no claim without evidence, no evidence without permission.**

---

## 1. Quick start

Requirements: Node.js 22+, npm.

```bash
cd backend
npm install
npm run dev                 # http://localhost:4000
```

Create `backend/.env` only when you need overrides; it is gitignored.

With `MONGODB_URI` empty, the server starts an **ephemeral in-memory MongoDB**
using `mongodb-memory-server` — no database setup required. Data disappears when
the process exits. Set `MONGODB_URI` (e.g. MongoDB Atlas) for persistence.

Health check:

```bash
curl http://localhost:4000/api/health
```

### Seed the demo project

`POST /api/demo/seed` builds the "Project Atlas" demo (4 users, 6 sources, 28
claims, a superseded decision, a conflicting decision set and two ownership
gaps). When the workspace already exists it reconciles membership, the owner and
the outgoing member to the seeded personas without touching sources, claims or
handovers, so an older deployment repairs itself instead of showing stale names.
It only creates data when the workspace is missing, so it is safe to call
publicly and on sign-in retries. The server also runs the same reconciliation at
startup when Atlas exists. It returns JWTs so you can drive the API immediately:

```bash
curl -X POST http://localhost:4000/api/demo/seed
```

`?reset=true` rebuilds the six **seeded** sources and their derived findings and
therefore requires the Atlas lead's bearer token (`403` for any other role,
`401` without a session). It does not delete visitor uploads or handovers, and
it does not sign anyone out.

Rohan, Ananya and Vikram are fictional demo profiles; only the author's name is
real.

Demo sign-in uses `POST /api/demo/session` with the profile's email. The route
exists only while demo seeding is enabled (`DEMO_MODE=true` in production or
`ALLOW_DEMO_SEED=true` in development), is rate limited, and returns a session
for seeded personas only. Seeded accounts have random passwords that are never
returned or published, so there is no shared demo password.

| Person | Role | Purpose |
| --- | --- | --- |
| Subham Sahu | lead | reviews, approves and shares handovers |
| Rohan Mehta | contributor | outgoing team member |
| Ananya Rao | contributor (incoming) | recipient; read-only: shared handovers and permitted sources only, no handover creation or project actions |
| Vikram Nair | observer | read-only stakeholder |

Suggested walkthrough:

1. Sign in as **Subham**, create a handover for **Ananya** (`onboarding` template).
2. Review items, accept/edit/reject them, then `submit`.
3. Approve, `share`, and open the share link as **Ananya**.
4. As Subham, restrict `handover-notes.txt` to the `lead` role and reload Ananya's
   handover — the linked items disappear and `permissionRecheck.revokedItems`
   increases. This is the live permission re-check.

You can also seed from the CLI with `npm run seed` (requires `MONGODB_URI` for
the data to survive the process).

---

## 2. Configuration

All variables are optional in development.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enforces a real `JWT_SECRET`; demo seeding is off in production unless `DEMO_MODE=true` |
| `PORT` | `4000` | HTTP port |
| `MONGODB_URI` | empty (in-memory) | MongoDB connection string |
| `DB_NAME` | path in `MONGODB_URI` | Overrides the database name; set to `Threadline` for Atlas |
| `JWT_SECRET` | dev-only value | JWT signing secret; **required** in production |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime |
| `CORS_ORIGINS` | empty (reflect origin) | Comma-separated allowed origins |
| `GEMINI_API_KEY` | empty | Enables LLM extraction (Gemini structured JSON) |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model used for extraction |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | Retried once when the primary model is unavailable (404/429/503) |
| `GITHUB_TOKEN` | empty | GitHub connector (public repos work without it) |
| `GITHUB_ALLOWED_REPOS` | empty (none allowed) | Comma-separated `owner/repo` allow-list |
| `GOOGLE_DRIVE_ACCESS_TOKEN` | empty | Google Drive connector (OAuth access token) |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` | empty | Optional OAuth refresh flow so the one-hour access token renews automatically |
| `DRIVE_ALLOWED_FOLDERS` | empty (none allowed) | Comma-separated Drive folder allow-list |
| `MAX_CONNECTOR_SOURCES` | `10` | Connector sources allowed per project |
| `UPLOAD_DIR` | `backend/storage/uploads` | Uploaded file storage |
| `MAX_UPLOAD_MB` | `15` | Per-file upload limit |
| `MAX_FILES_PER_UPLOAD` | `20` | Files per source |
| `MAX_DOCUMENT_CHARS` | `1000000` | Parsed text kept per document; anything beyond is dropped with a visible warning |
| `UPLOAD_JANITOR_ENABLED` | `true` | Removes upload files no source references (runs on boot and every `UPLOAD_JANITOR_INTERVAL_HOURS`) |
| `UPLOAD_JANITOR_INTERVAL_HOURS` | `6` | Janitor interval |
| `UPLOAD_ORPHAN_HOURS` | `24` | Age before an unreferenced upload is deleted |
| `REGISTRATION_MODE` | `open` (dev/demo), `invite` (production) | `open`, `invite` or `closed` |
| `REGISTRATION_INVITE_CODES` | empty | Comma-separated codes accepted in invite mode |
| `REGISTRATION_EMAIL_DOMAINS` | empty | Comma-separated domains allowed to register |
| `LOGIN_MAX_ATTEMPTS` | `5` | Failed sign-ins before a temporary lockout (minimum 3) |
| `LOGIN_LOCKOUT_MINUTES` | `15` | Lockout duration |
| `EXTRACT_CONCURRENCY` | `3` | Parallel extraction calls |
| `EXTRACT_TIME_BUDGET_MS` | `120000` | Time budget for one extraction pass |
| `STALE_DAYS` | `30` | Age before an open item is flagged stale |
| `OLD_QUESTION_DAYS` | `14` | Open questions older than this count against readiness |
| `READINESS_PENALTY_UNVERIFIED` | `3` | Points off the 100-point readiness score per category (caps apply) |
| `READINESS_PENALTY_OWNERSHIP_GAP` | `8` | Ownership-gap penalty |
| `READINESS_PENALTY_CONFLICT` | `10` | Conflict penalty |
| `READINESS_PENALTY_OLD_QUESTION` | `4` | Old-question penalty |
| `SHARE_TTL_DAYS` | `7` | Share-link lifetime |
| `OUTBOUND_WEBHOOK_URL` | empty | Optional webhook for share, acknowledgement, clarification and reminder delivery; when empty every delivery is recorded as `skipped`, never as sent |
| `OUTBOUND_WEBHOOK_TIMEOUT_MS` | `5000` | Webhook request timeout |
| `HANDOVER_REMINDER_ENABLED` | `true` | Sends one in-app notice and one outbound delivery for a shared handover that is still unacknowledged |
| `HANDOVER_REMINDER_DAYS` | `3` | Days after sharing before the reminder fires |
| `ALLOW_DEMO_SEED` | `true` | Enables `POST /api/demo/seed`; creating a missing workspace is public, rebuilding requires the Atlas lead |
| `DEMO_MODE` | `false` | Production additionally requires this flag before the demo seed is allowed |
| `INGEST_CONCURRENCY` | `2` | Background ingestion workers |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

The template at [`backend/.env.example`](.env.example) contains placeholders
only; `backend/.env` is gitignored.

**Extraction modes**

- With `GEMINI_API_KEY`: chunk → Gemini structured extraction → quote validation.
- Without a key (or if the LLM call fails): deterministic **labelled-line
  heuristic** extraction. It only reads explicit lines such as
  `Decision: ...`, `Task: ... (owner: ..., due: ...)`, `Risk: ...`, CSV rows and
  checkboxes, so it never invents facts. All demo data works in this mode.

---

## 3. Request flow

```
connect source            ingest                       reconstruct              review                handover
──────────────           ─────────                    ───────────              ───────               ────────
upload / GitHub /   →   parse → chunk → extract  →   claims + evidence    →   accept/edit/     →   approve → share
Google Drive            claims → validate quotes      supersession,            reject/pending       → acknowledge
                        → link evidence → index       conflicts, gaps,         (versioned)
                                                      readiness
```

Pipeline stages:

1. **Ingest** (`src/services/ingest`) — parsers for TXT/MD/CSV/JSON/PDF/DOCX,
   GitHub (README, issues, PRs, commits) and Google Drive. Documents are
   checksum-deduplicated, revisioned and chunked with absolute character offsets.
   Re-ingestion retires previous chunks instead of deleting history.
   Connected sources carry a `sync` subdocument (enabled, interval, last
   checked/changed, last error, checksum cursor). A one-minute scheduler checks
   each source against its own interval (default **5 minutes**); an unchanged
   checksum skips re-extraction, a changed one re-ingests and marks live
   handovers outdated with a readable diff.
2. **Extract** (`src/services/ai`) — Gemini or heuristic extraction; every item
   carries a verbatim `quote`. `locateQuote` validates it (`exact` /
   `normalized` / `failed`) and stores character offsets used by the evidence
   preview endpoint.
3. **Reconstruct** (`src/services/reconstruction`) — supersession linking,
   conflicts by topic, ownership gaps, stale/unverified items, readiness score,
   phase and inferred next actions.
4. **Compose** (`src/services/handover/compose.js`) — recipient-specific draft.
   Claims are included only when **every** citation resolves to a source the
   recipient may read. Excluded claims are reported as counts only. Every
   statement, quote, alert and recommendation passes a redaction pass
   (emails, phone numbers, API keys/tokens, credentials and 12-digit IDs become
   `[REDACTED: kind]`); counts are stored per item and per handover so the UI can
   show what was removed.
5. **Review workflow** (`src/services/handover/workflow.js`) — draft →
   in_review → approved → shared → acknowledged (or rejected, then reopened).
   Every transition snapshots a `HandoverVersion` and writes an `AuditEvent`;
   every version can be compared with the previous one through a field-level
   diff. Approved handovers are checked against the live claims; when content
   changes they become `outdated` with a change list and can be regenerated
   back to `draft`.
6. **Clarifications** (`src/services/clarifications.js`) — a lead or
   contributor can ask the recorded departing member about ownership gaps,
   conflicts and open questions. Only that member can answer or decline. An
   answer creates a `confirmation` source, document, evidence row and
   `origin: person_confirmed` claim, then goes through normal review.

---

## 4. Permission model

Visibility is evaluated on **sources**, and claims inherit the strictest
constraint:

- A claim is visible only if **all** of its evidence citations point to visible
  sources. Partial visibility is treated as no visibility, so a restricted
  document can never be inferred from an included claim.
- Source visibility scopes: `project` (all members), `roles` (lead /
  contributor / observer) or `users` (explicit allow-list). Unknown scopes and
  soft-deleted sources are hidden (fail closed).
- Extraction and state endpoints (`/state`, `/claims`, `/documents`) return only
  visible claims/documents. Handover composition stores a recipient-specific
  item set and reports withheld counts by type and reason
  (`permissions`, `template`, `unverified`) without leaking text.
- **Read-time re-check:** every recipient view re-evaluates source visibility.
  Items, alerts and recommendations that reference now-restricted claims are
  removed, and the event is audited
  (`handover.recipient_viewed`, `handover.permissions_rechecked`).
- Reviewers cannot accept an item whose evidence they cannot read; a lead
  cannot approve a handover containing accepted items they cannot access.
- Share links are recipient-bound, expire after `SHARE_TTL_DAYS`, and still
  require a valid session for that recipient. Only a SHA-256 hash is stored;
  links can be revoked, and rotation of a live link requires explicit
  confirmation. The seeded demo workspace is the one exception: its links open
  read-only without a session so evaluators can try the recipient journey, and
  any acknowledgement made that way is audited with
  `channel: "public_share_link"`. Other projects refuse anonymous visitors.
- Clarification candidates are filtered to items the departing member can read;
  only the addressee can answer or decline. Person-confirmed claims are scoped
  to the answering member and the project leads.
- Audit entries whose target source the reader cannot access are redacted to
  `Restricted item` (no id, title or metadata).

Audit events capture actor, action, target, IP and user-agent for project,
source, document, handover and authentication operations. Project leads can read
the audit log via `GET /api/projects/:projectId/audit`.

---

## 5. Handover workflow

| Status | Meaning | Allowed transitions |
| --- | --- | --- |
| `draft` | generated, under review | review items → `in_review` / `rejected` |
| `in_review` | submitted for approval | `approved` / `rejected` |
| `approved` | signed off by a lead | `shared` |
| `shared` | share link issued to recipient | `acknowledged` |
| `acknowledged` | recipient confirmed receipt | can be re-acknowledged after a re-share; every open records the exact items and statement hashes shown |
| `rejected` | lead rejected with a reason | `draft` via reopen |

Approved and shared handovers carry a `freshness` block. It starts `current`,
becomes `outdated` when live claims behind the snapshot change, and records a
human-readable `changes` list (`added` / `updated` / `removed` with field-level
before/after values). Regenerating rebuilds a draft from current state, keeps
reviewer decisions where the claim still exists, and invalidates the old share
link.

Guards enforced by the API:

- the author or a project lead may review, submit, reject, share and view history;
- only a lead can approve or reject; the recipient cannot approve;
- with `requireSeparateApprover`, the approver must not be the author;
- approval is blocked while any item is `pending`;
- sharing requires `approved`, and re-sharing a live link requires
  `confirmRotation: true`;
- revocation requires the author or a lead and is idempotent;
- acknowledgement requires `shared` and the recipient;
- a handover recipient must be a project member and must differ from the author.

Role templates: `onboarding` (full), `audit` (full, intended for reviewers) and
`executive` (excludes tasks, responsibilities and questions plus confidential
items). Template exclusions are reported in `withheld.byReason.template`.

Certainty is visible, not just stored. Each handover item carries a plain label
derived from its citations: **Verified** (quotes matched across two or more
sources), **Single source**, **Partly verified**, **Conflicting** (topic has
competing decisions) or **Not found in source**. Redacted items also carry a
`redactionCount` and the handover records `redactions: { count, kinds }`.

---

## 6. API reference

Base URL: `/api`. All endpoints except auth, health, shared links and demo
require `Authorization: Bearer <token>`.

### Auth

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/auth/register` | `{ email, name, password, inviteCode? }` → `{ registered, message }`; uniform for new and existing addresses and does not start a session |
| POST | `/auth/login` | `{ email, password }` → `{ token, user }`; identical failures for unknown addresses and wrong passwords, temporary lockout after repeated failures |
| POST | `/auth/logout` | ends the current session only |
| POST | `/auth/logout-all` | revokes every session for the account |
| GET | `/auth/me` | current user |

### Projects

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects` | projects the caller belongs to |
| POST | `/projects` | `{ key, name, description?, members?, transition?, startedAt?, targetDate? }` |
| GET | `/projects/:projectId` | project + visible source/handover counts |
| PATCH | `/projects/:projectId` | lead only |
| POST | `/projects/:projectId/members` | lead only; `{ email \| userId, role }` |
| DELETE | `/projects/:projectId/members/:userId` | lead only |
| GET | `/projects/:projectId/state` | reconstructed state, timeline, conflicts, next actions |
| GET | `/projects/:projectId/claims?type=&limit=` | visible, decorated claims |
| POST | `/projects/:projectId/claims/:claimId/resolve` | lead or contributor; `{ ownerName? , status?: "done" \| "resolved", note? }` — assigns an owner and/or closes the item, audited |
| POST | `/projects/:projectId/conflicts/resolve` | lead only; `{ topicKey, keepClaimId }` — confirms the current decision, supersedes the rest |
| GET | `/projects/:projectId/clarifications/candidates` | lead or contributor; gaps the departing member can be asked about |
| POST | `/projects/:projectId/clarifications` | lead or contributor; `{ askForAll: true }` or `{ claimIds, prompt? }` (custom prompt only for one item) |
| GET | `/projects/:projectId/clarifications` | lead or contributor; every question asked in the project |
| GET | `/projects/:projectId/audit?limit=` | lead only |

### Sources and evidence

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:projectId/sources` | visible sources |
| POST | `/projects/:projectId/sources` | `{ kind: "github" \| "drive", externalRef, name?, visibility?, sensitivity? }` |
| POST | `/projects/:projectId/sources/upload` | multipart: `files[]`, `name?`, `sensitivity?`, `visibility?` (JSON string) |
| GET | `/projects/:projectId/sources/:sourceId` | 403 when not visible |
| PATCH | `/projects/:projectId/sources/:sourceId` | lead only; change name/sensitivity/visibility |
| DELETE | `/projects/:projectId/sources/:sourceId` | lead only; soft delete |
| POST | `/projects/:projectId/sources/:sourceId/reingest` | re-queue ingestion |
| POST | `/projects/:projectId/sources/:sourceId/sync` | lead or contributor; force a check of a GitHub/Drive source |
| PATCH | `/projects/:projectId/sources/:sourceId/sync` | lead only; `{ enabled, intervalMinutes (1–1440) }` |
| GET | `/projects/:projectId/documents?sourceId=` | visible documents |
| GET | `/projects/:projectId/documents/:documentId` | full text gated by source visibility |
| GET | `/projects/:projectId/evidence/:evidenceId` | quote, ±600 char context and highlight offsets |

### Handovers

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/handovers?projectId=&scope=all\|created\|received` | role-aware list |
| POST | `/handovers` | `{ projectId, recipientId, roleTemplate }` → author view |
| GET | `/handovers/:id` | reviewer view, or recipient view after sharing |
| PATCH | `/handovers/:id/items/:claimId` | `{ decision, editedStatement?, note? }` |
| POST | `/handovers/:id/submit` | requires ≥1 accepted/edited item |
| POST | `/handovers/:id/approve` | lead only; `{ note? }` |
| POST | `/handovers/:id/reject` | lead only; `{ note }` required |
| POST | `/handovers/:id/reopen` | author or lead; rejected → draft |
| GET | `/handovers/:id/freshness` | author/lead; live comparison with a field-level diff |
| POST | `/handovers/:id/regenerate` | author/lead; rebuild a draft and invalidate the old link |
| POST | `/handovers/:id/share` | returns `{ sharePath, shareExpiresAt }`; re-sharing needs `{ confirmRotation: true }` |
| POST | `/handovers/:id/share/revoke` | author/lead; `{ reason? }`, idempotent |
| POST | `/handovers/:id/acknowledge` | recipient only; records the items and statement hashes shown |
| GET | `/handovers/:id/versions` | author/lead only; version history |
| GET | `/handovers/:id/versions/:version` | author/lead only; readable diff against the previous version |
| GET | `/handovers/shared/:token` | shared view; recipient session required, except the public demo workspace |
| POST | `/handovers/shared/:token/acknowledge` | acknowledges through the link; public only for the demo workspace |

### Clarifications

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/clarifications?status=open` | the addressee's inbox (`mine` defaults to true) |
| POST | `/clarifications/:id/answer` | addressee only; `{ answer }` creates person-confirmed evidence |
| POST | `/clarifications/:id/decline` | addressee only; `{ note? }` |

### Ops

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | liveness, DB state, extraction mode |
| POST | `/demo/seed` | seeds only when the workspace is missing; `?reset=true` requires the Atlas lead |

Errors use `{ error: { code, message, details? } }`. Notable statuses: `400`
validation/bad transition, `403` permission boundary, `404` not found, `410`
expired share link, `413` upload too large, `415` unsupported file, `422`
approval blocked by pending items.

---

## 7. Data model (MongoDB)

`Project` → members + transition metadata + lead-only settings. `Source` →
visibility, sensitivity, files, ingestion status, `sync` subdocument.
`Document` → raw text, offset-preserving chunks, revision. `Claim` → type,
statement, status/state, topic key, flags, evidence counts, origin
(`document` / `person_confirmed`), supersession link. `Evidence` → verbatim
quote, char offsets, validation result (`exact` / `normalized` / `failed` /
`person_confirmed`). `Clarification` → project, claim, kind
(`missing_owner` / `conflict` / `open_question`), prompt, addressee, status,
answer, result claim. `Handover` → recipient-specific items with citation
snapshots, alerts, recommendations, withheld counts, `shareTokenHash`,
`acknowledgement` snapshot, `freshness` block. `HandoverVersion` → immutable
snapshots with a computed diff. `AuditEvent` → actor, action, target, metadata,
IP.

Evidence uniqueness is enforced per `(claim, document, charStart, charEnd)`.
Re-ingesting a document creates a new revision and retires old chunks rather than
silently rewriting history.

---

## 8. Tests

```bash
npm test          # 374 Vitest + Supertest tests across 56 suites
npm run test:watch
npm run eval:quotes   # quote-accuracy report
```

Suites:

- `tests/permission-matrix.test.js` — seven viewer contexts × content, handover,
  shared-link and audit surfaces; five canaries, re-checked after revocation and
  conflict resolution.
- `tests/round3-hardening.test.js` — acknowledgement snapshots, first-week view,
  version diffs, token hashing/revocation, maker-checker, regenerate.
- `tests/source-sync.test.js` — interval scheduling, checksum skip, failure
  retention, sync settings, outdated handovers with a diff, and the Drive path
  through the same pipeline with a mocked connector.
- `tests/clarifications.test.js` — candidate gating, ask one/all, addressee-only
  answer/decline, person-confirmed claims, review of the result.
- `tests/extraction.test.js` — verbatim quote location, heuristic extraction,
  CSV normalization.
- `tests/ingest-hardening.test.js` — re-ingestion, truncation, allow-lists,
  parser warnings.
- `tests/api-ingestion.test.js` — auth, HTTP upload → ingestion → claims →
  evidence preview, role-restricted isolation, unsupported files, audit trail.
- `tests/handover-permissions.test.js` — recipient-specific withholding,
  hidden-until-shared, live permission re-check, template exclusions, review
  boundaries.
- `tests/handover-workflow.test.js` — edit/submit/approve/share/acknowledge,
  version history, pending-item guard, rejection/reopen, share rotation, and
  the public demo link (anonymous read and acknowledgement, refused elsewhere).
- `tests/reconstruction.test.js` — supersession, conflicts, ownership gaps,
  readiness, next actions.
- `tests/redaction.test.js` — secrets and PII removed before review.
- `tests/conflict-resolution.test.js` — current decision confirmed, conflicts
  clear, fresh drafts exclude superseded statements.
- `tests/claim-actions.test.js` — owner assignment, task closure, question
  answers, mitigation notes, observer rejection.
- `tests/demo-seed.test.js`, `tests/membership.test.js`,
  `tests/llm-fallback.test.js` — seed authorization and scoped reset, role
  changes, Gemini fallback.
- `tests/findings-h.test.js`, `tests/l-findings.test.js`,
  `tests/d-findings.test.js`, `tests/r-findings.test.js` — the fault-report
  findings H1–H12 (permission), L1–L12 (API consistency), D1–D10 (data
  correctness) and R1–R8 (reliability) kept as regression tests.
- `tests/auth-hardening.test.js`, `tests/ingest-limits.test.js`,
  `tests/ai-privacy.test.js` — login enumeration, lockout, password policy,
  invite and domain modes; DOCX/PDF parsing caps and magic-byte checks; local
  processing for confidential sources and redaction before external model calls.
- `tests/connector-refs.test.js`, `tests/share-audit.test.js`,
  `tests/upload-cleanup.test.js`, `tests/audit-labels.test.js`,
  `tests/redaction-samples.test.js` — connector reference parsing, anonymous
  share-link audit rows, upload cleanup, complete audit labels, and 36 secret/PII
  samples.
- `tests/notifications.test.js`, `tests/handover-extras.test.js` — notices,
  exports, feedback, delivery rows and reminders.

Each suite boots its own ephemeral MongoDB, so no external services are needed.
CI runs the same command on every push and pull request
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

---

## 9. Security notes

- JWT auth with bcrypt password hashing; login response never includes the hash.
- Helmet security headers, configurable CORS, request rate limiting (disabled in
  tests), JSON body limit, upload extension allow-list and size limits.
- Fail-closed source visibility; no lead override for retrieval of sources that
  do not name the lead's role.
- Recipient payloads never include `withheld` details, reviewer-only alerts or
  reviewer notes.
- Demo seeding is idempotent and public only while the workspace is empty; a
  seeded-source rebuild requires the Atlas lead. An existing workspace is
  reconciled to the current persona set at startup and on every non-reset seed,
  so stale member ids cannot lock a demo profile out. A rebuild removes only the
  six seeded sources and their derived data, so other visitors' uploads and
  handovers are preserved. The UI seeds only through the explicit demo action,
  never silently on a failed login.
- Share tokens are stored as a SHA-256 hash only; links expire and can be
  revoked. Clarifications are addressee-only and person-confirmed evidence is
  scoped to the answering member plus project leads.
- Handover composition redacts emails, phone numbers, API keys/tokens,
  credentials, private keys, bearer tokens and 12-digit IDs before anything
  reaches a reviewer or recipient.
- Audit events are written for every sensitive read/write; pipeline failures are
  logged but never expose document text.

---

## 10. Known limitations and roadmap

Honest limits of the current backend:

- **No embeddings/semantic retrieval yet.** Extraction works per chunk; there is
  no vector index (e.g. Qdrant) for cross-document semantic linking. Not needed
  for the demo workflow, but it is the next quality lever.
- **Connectors are synchronised snapshots, not webhooks.** GitHub ingestion is
  capped (25 issues, 15 PRs, 30 commits). A one-minute scheduler re-checks each
  connected source on its own interval (default five minutes; 1–1440
  configurable), but changes below the connector caps and webhook timing are
  not guaranteed. Google Drive uses a supplied OAuth access token rather than a
  full OAuth consent flow, and non-exportable binary formats are skipped.
  Connectors share one server-wide credential (`GITHUB_TOKEN` /
  `GOOGLE_DRIVE_ACCESS_TOKEN`) across projects.
- **The hosted demo workspace is shared** between evaluators. The scoped rebuild
  restores the seeded sources without touching visitor uploads or handovers.
- **Redaction is pattern-based.** Emails, phone numbers, API keys/tokens,
  credentials, private keys and 12-digit IDs are removed; personal names,
  addresses and salary figures are not reliably detected.
- **Background queue is in-process.** Jobs do not survive a crash; stuck jobs
  older than 10 minutes are re-queued on startup, but there is no external
  worker/queue (BullMQ/Redis) yet.
- **Conflict detection is topic-based.** Same-topic decisions are flagged as
  conflicts; it does not attempt semantic entailment or contradiction reasoning
  beyond explicit supersession phrases.
- **Rules-only mode reads labelled lines only.** Without `GEMINI_API_KEY`,
  free-form prose yields no claims; only explicit `Decision:` / `Task:` /
  `Risk:` style lines, CSV rows and checkboxes are extracted.
- **SSO/SCIM, per-document ACLs, and external sharing** are not implemented;
  permissions are project/role/user scoped inside one organisation.
- **No outbound notifications.** Acknowledgement is pull-based via the API.
- **Retention/erasure** is soft-delete plus audit history; a formal data
  retention policy and hard-erasure endpoint are future work.

Planned next steps: vector-backed retrieval for cross-source questions,
webhook-driven GitHub/Drive sync, a durable worker, reviewer assignment and
SLA reminders, and organisation-level SSO with audit export.

---

## 11. Project layout

```
backend/
  src/
    app.js                 Express app wiring
    server.js              HTTP server + background queue
    config/env.js          Environment configuration
    models/index.js        Mongoose schemas
    middleware/            Auth, project roles, validation, uploads, errors
    routes/                auth, projects, handovers, demo
    services/
      access/policy.js     Fail-closed visibility rules
      ingest/              Parsers, chunker, GitHub/Drive connectors, pipeline
      ai/                  LLM + heuristic extraction, quote validation
      reconstruction/      Supersession, state, next actions
      handover/            Compose, review workflow, permissions re-check
      queue.js             In-process background job queue
      audit.js             Audit event writer
  tests/                   Vitest + Supertest suites
```
