# Architecture

Threadline is a single-node web application with three moving parts:

- a React single-page app, served as static files by Vercel;
- an Express API that owns all permission decisions and runs the ingestion
  pipeline in-process;
- MongoDB (Atlas in the hosted demo) for projects, sources, documents, claims,
  evidence, clarifications, handovers, versions and audit events.

The API is the only component that talks to the database. The browser never
receives a database credential, a connector token or another user's session.

---

## 1. System context

```
                    ┌──────────────────────────────┐
                    │ Browser (React 18 + Vite)     │
                    │ Vercel static hosting         │
                    │ - no permission logic         │
                    │ - renders what the API returns│
                    └──────────────┬───────────────┘
                                   │ HTTPS, Bearer JWT
                                   ▼
┌───────────────────────────────────────────────────────────────────┐
│ Express API (Render)                                              │
│                                                                   │
│  auth → project role guard → route → service → Mongoose model     │
│                          │                                        │
│              ┌───────────┴────────────┬──────────────┐            │
│              ▼                        ▼              ▼            │
│       access/policy.js          ingest queue    handover/compose  │
│       (fail closed)             (in-process)    + workflow        │
└──────────────┬────────────────────────┬──────────────────────────┘
               │                        │
               ▼                        ▼
        MongoDB Atlas            GitHub / Google Drive
        (all app data)           (read-only connector APIs)
               │
               ▼
        Gemini API (optional; heuristic extractor otherwise)
```

Trust boundaries are marked by the arrows: the browser is untrusted input, the
connector and model responses are untrusted content, and everything the API
serialises passes the permission policy first.

---

## 2. Runtime flow

```
connect                 ingest                     extract
───────                 ──────                     ───────
upload / GitHub /  →    parse → checksum skip →    Gemini or labelled-line
Drive source            revision → chunk +         extraction → quote
                        character offsets          validation (exact /
                                                   normalized / failed)

      │                                               │
      │  sync every N minutes (default 5)             ▼
      └──────────────► fingerprint changed? ──► reconstruct
                       yes → re-ingest            supersession, conflicts,
                       no  → touch checkedAt      ownership gaps, readiness,
                                                  phase, next actions
                                                        │
                          clarification answer ◄────────┤ (gap / conflict /
                          (person-confirmed)            │  open question)
                                                        ▼
                                                     compose
                                             recipient-specific draft:
                                             every citation must be visible;
                                             withheld only as counts
                                                        │
                                                        ▼
                                  draft → in_review → approved → shared → acknowledged
                                           │             │
                                           │             ├─ freshness: current / outdated + diff
                                           │             ├─ share link: hashed, expiring, revocable
                                           │             └─ regenerate → new draft, old link invalid
                                           ▼
                                       rejected → reopen → draft
```

Every transition writes an audit event. Approved handovers are compared with
live claims when a connected source changes; a difference marks them `outdated`
and records a field-level change list.

---

## 3. Permission evaluation

The rule is **no claim without evidence, no evidence without permission**, and
the default is denial.

### 3.1 Source visibility

`sourceVisibleTo(source, project, userId)` in
`backend/src/services/access/policy.js`:

1. No source, a soft-deleted source, or a non-member → **hidden**.
2. A `confirmation` source (a person-confirmed answer) → visible to the
   answering member and any project lead.
3. `scope: project` → visible to members.
4. `scope: roles` → visible only when the user's role is listed.
5. `scope: users` → visible only when the user is listed.
6. Unknown or missing scope → **hidden** (fail closed).

### 3.2 Claim visibility

A claim is visible only when **all** of its evidence citations resolve to
visible sources. Partial visibility is treated as no visibility, so a restricted
document cannot be inferred through an included claim.

### 3.3 Surfaces that must agree

| Surface | Filter |
| --- | --- |
| `/projects/:id` stats | counts only visible sources and claims |
| `/state`, `/claims`, `/sources`, `/documents` | visible rows only |
| source / document / evidence detail | 403 or 404 when not visible |
| handover composition | item included only when every citation is visible |
| handover list | no item counts for recipient-only viewers |
| shared link | recipient-bound session + read-time re-check; the seeded demo workspace alone allows a read-only public open |
| audit log | entries targeting unreadable sources are redacted |
| clarifications | candidates only for claims the departing member can read |

### 3.4 Read-time re-check

A share link does not freeze the item list. Each recipient open re-evaluates
visibility; removed items are dropped from the response and the event is
audited. The payload reports that content changed, never how many items or
which sources, because a count could itself describe unreadable content.

### 3.5 Redaction

Statements, quotes, alerts and recommendations pass a pattern redaction pass
(emails, phone numbers, API keys/tokens, credentials, private keys, 12-digit
IDs) before review or sharing. Redaction is pattern-based; names, addresses and
salaries are not reliably detected (see `docs/ROADMAP.md`).

### 3.6 Verification

`backend/tests/permission-matrix.test.js` plants five canary strings in source
names, document titles, statements and quotes, then asserts every API surface
for seven viewer contexts (lead, second lead, contributor, observer, recipient,
outgoing member, non-member). A single leaked string fails CI. The matrix runs
again after role revocation and after conflict resolution.

---

## 4. Data model

```
User ────────┐
             │ members[]
Project ─────┼──< Source ──< Document ──< chunk[]
  │          │       │            │
  │          │       └──< Evidence >── Claim ──< supersedes
  │          │                        │
  │          │                        └──< Clarification >── resultClaim
  │          │
  │          └──< Handover ──< HandoverVersion
  │                 │
  │                 └── shareTokenHash, acknowledgement, freshness
  │
  └──< AuditEvent
```

| Collection | Purpose |
| --- | --- |
| `Project` | members, roles, transition metadata, lead-only settings |
| `Source` | upload / GitHub / Drive / confirmation; visibility, sensitivity, status, `sync` |
| `Document` | raw text, revision, offset-preserving chunks, parse warnings |
| `Claim` | type, statement, topic, status/state, origin, flags, owner, resolution |
| `Evidence` | verbatim quote, character offsets, validation result |
| `Clarification` | question kind, prompt, addressee, answer/decline, result claim |
| `Handover` | recipient items, citation snapshots, withheld counts, share hash, acknowledgement, freshness |
| `HandoverVersion` | immutable snapshot + reason + computed diff |
| `AuditEvent` | actor, action, target, metadata, IP, user agent |

Evidence uniqueness is enforced per `(claim, document, charStart, charEnd)`.
Re-ingesting creates a new document revision and retires old chunks; history is
not silently rewritten.

---

## 5. Trust boundaries and failure behaviour

| Boundary | What is untrusted | Mitigation |
| --- | --- | --- |
| Browser → API | any request body, id or token | Zod validation, JWT auth, project role guard, fail-closed policy |
| Uploaded file | text, size, extension, structure | extension allow-list and size cap; parsers isolate failures; parse warnings surfaced |
| GitHub / Drive content | titles, text, metadata | same extraction path; allow-lists for repos and folders; connector errors are typed |
| Gemini output | statements, quotes, ids | every quote is located in the source text; unlocatable claims are `failed` and excluded from handovers |
| Share link | token, recipient identity | token stored as SHA-256 hash, recipient-bound session, expiry, revocation, read-time re-check; demo-workspace links open read-only without a session and log `channel: public_share_link` when acknowledged |
| Audit reader | lead with partial access | unreadable targets are redacted to `Restricted item` |
| Clarification | answer text | only the addressee can answer; answer is redacted, stored as evidence, typed as `person_confirmed` |
| Demo reset | anonymous caller | public seed only when the workspace is missing; an existing workspace is reconciled to the current personas at startup and on a non-reset seed; scoped rebuild requires the Atlas lead |

Known residual risks and roadmap items are listed in
[`ROADMAP.md`](ROADMAP.md).

---

## 6. Deployment

- **Frontend** — Vercel; `vercel.json` rewrites deep links (`/shared/:token`,
  `/projects/...`, `/login`) to `index.html`.
- **API** — Render free tier; cold start after ~15 minutes of inactivity is
  surfaced in the UI. `CORS_ORIGINS` and a strong `JWT_SECRET` are required in
  production.
- **Database** — MongoDB Atlas.
- **Queue** — in-process; `INGEST_CONCURRENCY` workers, one retry, startup
  recovery for sources stuck over 10 minutes.
- **Scheduler** — a one-minute interval scans connected sources and enqueues
  those whose own interval has elapsed.
- **Extraction** — Gemini when `GEMINI_API_KEY` is set, otherwise the
  deterministic labelled-line extractor.
- **CI** — GitHub Actions runs the backend suite (publishing the exact count as
  a JSON test report) and the frontend production build plus smoke check on
  every push and pull request.

## 7. Deliberate trade-offs

- **Full-corpus extraction instead of RAG.** Documents are chunked and extracted
  directly; there is no vector index. This keeps evidence traceable to exact
  character offsets and avoids an approximate retrieval layer, at the cost of
  not answering open-ended cross-source questions.
- **Composition-time filtering instead of per-recipient documents.** One
  handover stores reviewer decisions and recipient-specific snapshots; live
  visibility is re-checked on read. This keeps review state authoritative while
  making revocation immediate.
- **In-process queue.** Simple to run and demo, but jobs do not survive a
  restart; a durable queue is the first roadmap item.
- **Pattern redaction.** Deterministic and explainable, but narrower than a PII
  classifier.
