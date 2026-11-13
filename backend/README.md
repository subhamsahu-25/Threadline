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

Requirements: Node.js 20+ (22 LTS recommended), npm.

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

`POST /api/demo/seed?reset=true` builds the "Project Atlas" demo (4 users, 6
sources, 28 claims, a superseded decision, a conflicting decision set and two
ownership gaps). It returns JWTs so you can drive the API immediately:

```bash
curl -X POST http://localhost:4000/api/demo/seed?reset=true
```

Demo password for all accounts: `Threadline#2026`

| Person | Role | Purpose |
| --- | --- | --- |
| Subham Sahu | lead | reviews, approves and shares handovers |
| Soumyajit Jena | contributor | outgoing team member |
| Partho Prateem Satypatty | contributor | incoming team member / recipient |
| Sabyasachi Behera | observer | read-only stakeholder |

Suggested walkthrough:

1. Sign in as **Subham**, create a handover for **Partho** (`onboarding` template).
2. Review items, accept/edit/reject them, then `submit`.
3. Approve, `share`, and open the share link as **Partho**.
4. As Subham, restrict `handover-notes.txt` to the `lead` role and reload Partho's
   handover — the linked items disappear and `permissionRecheck.revokedItems`
   increases. This is the live permission re-check.

You can also seed from the CLI with `npm run seed` (requires `MONGODB_URI` for
the data to survive the process).

---

## 2. Configuration

All variables are optional in development.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enforces a real `JWT_SECRET` and disables demo seeding by default |
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
| `GOOGLE_DRIVE_ACCESS_TOKEN` | empty | Google Drive connector (OAuth access token) |
| `UPLOAD_DIR` | `backend/storage/uploads` | Uploaded file storage |
| `MAX_UPLOAD_MB` | `15` | Per-file upload limit |
| `MAX_FILES_PER_UPLOAD` | `20` | Files per source |
| `STALE_DAYS` | `30` | Age before an open item is flagged stale |
| `SHARE_TTL_DAYS` | `7` | Share-link lifetime |
| `ALLOW_DEMO_SEED` | true outside production | Enables `POST /api/demo/seed` |
| `INGEST_CONCURRENCY` | `2` | Background ingestion workers |

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
2. **Extract** (`src/services/ai`) — Gemini or heuristic extraction; every item
   carries a verbatim `quote`. `locateQuote` validates it (`exact` /
   `normalized` / `failed`) and stores character offsets used by the evidence
   preview endpoint.
3. **Reconstruct** (`src/services/reconstruction`) — supersession linking,
   conflicts by topic, ownership gaps, stale/unverified items, readiness score,
   phase and inferred next actions.
4. **Compose** (`src/services/handover/compose.js`) — recipient-specific draft.
   Claims are included only when **every** citation resolves to a source the
   recipient may read. Excluded claims are reported as counts only.
5. **Review workflow** (`src/services/handover/workflow.js`) — draft →
   in_review → approved → shared → acknowledged (or rejected). Every transition
   snapshots a `HandoverVersion` and writes an `AuditEvent`.

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
  require a valid session for that recipient.

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
| `acknowledged` | recipient confirmed receipt | terminal |
| `rejected` | lead rejected with a reason | terminal |

Guards enforced by the API:

- the author or a project lead may review, submit, reject, share and view history;
- only a lead can approve or reject; the recipient cannot approve;
- approval is blocked while any item is `pending`;
- sharing requires `approved`; acknowledgement requires `shared` and the
  recipient;
- a handover recipient must be a project member and must differ from the author.

Role templates: `onboarding` (full), `audit` (full, intended for reviewers) and
`executive` (excludes tasks, responsibilities and questions plus confidential
items). Template exclusions are reported in `withheld.byReason.template`.

---

## 6. API reference

Base URL: `/api`. All endpoints except auth, health, shared links and demo
require `Authorization: Bearer <token>`.

### Auth

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/auth/register` | `{ email, name, password }` → `{ token, user }` |
| POST | `/auth/login` | `{ email, password }` → `{ token, user }` |
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
| POST | `/handovers/:id/share` | returns `{ sharePath, shareExpiresAt }` |
| POST | `/handovers/:id/acknowledge` | recipient only |
| GET | `/handovers/:id/versions` | author/lead only; version history |
| GET | `/handovers/shared/:token` | recipient-bound shared view |

### Ops

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | liveness, DB state, extraction mode |
| POST | `/demo/seed?reset=true` | disabled in production unless `ALLOW_DEMO_SEED=true` |

Errors use `{ error: { code, message, details? } }`. Notable statuses: `400`
validation/bad transition, `403` permission boundary, `404` not found, `410`
expired share link, `413` upload too large, `415` unsupported file, `422`
approval blocked by pending items.

---

## 7. Data model (MongoDB)

`Project` → members + transition metadata. `Source` → visibility, sensitivity,
files, ingestion status. `Document` → raw text, offset-preserving chunks,
revision. `Claim` → type, statement, status/state, topic key, flags, evidence
counts, supersession link. `Evidence` → verbatim quote, char offsets, validation
result. `Handover` → recipient-specific items with citation snapshots, alerts,
recommendations, withheld counts, share token. `HandoverVersion` → immutable
snapshots. `AuditEvent` → actor, action, target, metadata, IP.

Evidence uniqueness is enforced per `(claim, document, charStart, charEnd)`.
Re-ingesting a document creates a new revision and retires old chunks rather than
silently rewriting history.

---

## 8. Tests

```bash
npm test          # 23 Vitest + Supertest tests against an in-memory MongoDB
npm run test:watch
```

Suites:

- `tests/extraction.test.js` — verbatim quote location, heuristic extraction,
  CSV normalization.
- `tests/api-ingestion.test.js` — auth, project creation, HTTP upload →
  ingestion → claims → evidence preview, role-restricted source isolation,
  unsupported-file rejection, audit trail.
- `tests/handover-permissions.test.js` — recipient-specific withholding,
  hidden-until-shared, live permission re-check after visibility change,
  executive template exclusions, review boundary, non-member rejection.
- `tests/handover-workflow.test.js` — edit/submit/approve/share/acknowledge,
  version history and audit events, pending-item approval guard, rejection and
  transition guards, no restricted text in recipient payloads.
- `tests/llm-fallback.test.js` — Gemini model fallback retries on retired or
  unavailable models (404 / 429 / 503).

Each suite boots its own ephemeral MongoDB, so no external services are needed.

---

## 9. Security notes

- JWT auth with bcrypt password hashing; login response never includes the hash.
- Helmet security headers, configurable CORS, request rate limiting (disabled in
  tests), JSON body limit, upload extension allow-list and size limits.
- Fail-closed source visibility; no lead override for retrieval of sources that
  do not name the lead's role.
- Recipient payloads never include `withheld` details, reviewer-only alerts or
  reviewer notes.
- Audit events are written for every sensitive read/write; pipeline failures are
  logged but never expose document text.

---

## 10. Known limitations and roadmap

Honest limits of the current backend:

- **No embeddings/semantic retrieval yet.** Extraction works per chunk; there is
  no vector index (e.g. Qdrant) for cross-document semantic linking. Not needed
  for the demo workflow, but it is the next quality lever.
- **Connectors are read-only snapshots.** GitHub ingestion is capped (25 issues,
  15 PRs, 30 commits) and runs on demand; there are no webhooks. Google Drive
  uses a supplied OAuth access token rather than a full OAuth consent flow, and
  non-exportable binary formats are skipped.
- **Background queue is in-process.** Jobs do not survive a crash; stuck jobs
  older than 10 minutes are re-queued on startup, but there is no external
  worker/queue (BullMQ/Redis) yet.
- **Conflict detection is topic-based.** Same-topic decisions are flagged as
  conflicts; it does not attempt semantic entailment or contradiction reasoning
  beyond explicit supersession phrases.
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
