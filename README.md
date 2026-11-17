# Threadline

[![CI](https://github.com/subhamsahu-25/Threadline/actions/workflows/ci.yml/badge.svg)](https://github.com/subhamsahu-25/Threadline/actions/workflows/ci.yml)

**Permission-aware, evidence-linked project handover.**
Built for **Hack With Pune** by **Subham Sahu** (solo, Team ZeusConquers).
Submission archive: **CodePuneThinkers**.

When someone leaves a project, the knowledge that mattered is rarely in the
ticket tracker. It lives in the decision that was reversed in a call, the risk
nobody wrote down, the dependency that only one person understood. Threadline
reads the project sources you already authorised, extracts the decisions, tasks,
risks, dependencies and open questions, and assembles a handover that is
**traceable to a verbatim source quote** and **filtered by what the recipient is
allowed to see**.

> **No claim without evidence. No evidence without permission.**

- Every extracted item carries a verbatim quote, validated against the source
  text, with character offsets for inline preview.
- A claim is included only when **every** citation resolves to a source the
  recipient can read. Partial visibility counts as no visibility.
- Withheld content is reported as counts by reason only — never as leaked text.
- Permissions are re-evaluated every time a recipient opens a handover. Revoked
  access removes items live and writes an audit event.

### Live demo

**https://threadline-snowy.vercel.app**

The API runs on Render's free tier. After about 15 minutes of inactivity the
first request can take roughly a minute while the instance wakes; the UI warns
you about this, and the request completes normally.

### 90-second walkthrough

1. Open the live URL and pick **Subham Sahu** on the profile picker.
2. Open **Project Atlas → Handovers** and create a handover for **Ananya Rao**.
   Use **Accept all verified**, then submit, approve and share it.
3. Switch to **Ananya** in the profile menu and open the share link. She sees
   only items backed by sources she may read, plus a first-week view.
4. **Connected-source freshness.** The seeded workspace contains uploads only,
   so no sync control is rendered: uploads are manual, while GitHub and Drive
   sources are re-checked every five minutes, skipped on an unchanged checksum,
   and flip approved handovers to **Outdated** with a diff when content changes.
   To exercise the connector path, add an allow-listed GitHub source with
   `GITHUB_TOKEN` configured; `docs/SYNC_EVIDENCE.md` records the mocked test
   evidence and why no live connector run is claimed here.
5. Open **Questions**, ask the departing member about an ownership gap, switch
   to **Rohan Mehta**, answer it, then approve the person-confirmed answer.
6. Open [`docs/QUOTE_ACCURACY.md`](docs/QUOTE_ACCURACY.md) for the quote report
   and the GitHub Actions badge above for the permission-matrix CI run.

The walkthrough above is the Round 3 demo path; the local walkthrough below
covers the same product from a fresh clone.

---

## Demo in 60 seconds

Requirements: Node.js 20+ (22 LTS recommended) and npm.

```bash
# Terminal 1 — API on http://localhost:4000 (in-memory MongoDB, no setup)
cd backend
npm install
npm run dev

# Terminal 2 — UI on http://localhost:5173
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, then seed the demo dataset:

```bash
curl -X POST "http://localhost:4000/api/demo/seed"
```

This only creates the workspace when it is missing; it never overwrites an
existing project. Rebuilding with `?reset=true` requires the Atlas lead's
bearer token.

Pick any of the four demo profiles on the sign-in screen — one click, no
password, no registration. The same password (`Threadline#2026`) still works
for the API, but the UI signs seeded accounts in automatically. The profile
switcher in the top-right corner moves between people without signing out.

| Person | Role | What to try |
| --- | --- | --- |
| **Subham Sahu** | lead | Create a handover for Ananya, review items, approve, share, restrict a source, read the audit log |
| **Rohan Mehta** | contributor | The outgoing team member whose work is being handed over |
| **Ananya Rao** | contributor | The incoming recipient — open the share link, acknowledge it |
| **Vikram Nair** | observer | Read-only; confirm that restricted sources and claims stay hidden |

Rohan, Ananya and Vikram are **fictional demo profiles**. Only the author's name
is real; no other person's identity or workplace data is used.

The seed builds **Project Atlas**: 4 people, 6 sources, 28 claims, a superseded
decision, a conflicting decision set and two ownership gaps.

The hosted workspace is shared between visitors, so the app shows a persistent
notice. **Rebuild seeded data** re-creates only the six seeded sources and
leaves every upload and handover made by another visitor untouched; the current
session stays signed in.

**Suggested walkthrough**

1. Pick **Subham** on the sign-in screen → open *Project Atlas* → **Handovers** →
   create a handover for **Ananya** with the `onboarding` template.
2. Accept / edit / reject items, then **Submit for approval**.
3. **Approve** as Subham and **Share**. Copy the share link.
4. Switch to **Ananya** in the profile menu, open the link, read the evidence
   previews, acknowledge.
5. Switch back to **Subham**, open **Sources**, restrict `handover-notes.txt` to
   the `lead` role.
6. Switch to **Ananya** again and reload the handover — affected items disappear
   and the recipient sees *"Some items are no longer shown"*. The event is
   recorded in the audit log.

No real project data is used. The demo is entirely synthetic and seeded from the
application itself.

---

## How it works

```
Sources                 Ingest                    Extract                  Reconstruct            Review              Handover
───────                 ──────                    ───────                  ───────────            ──────              ────────
upload / GitHub /  →    parse → dedupe →     →    Gemini or heuristic  →   supersession,      →   accept / edit / →   approve →
Google Drive            chunk + offsets           extraction + quote       conflicts, gaps,       reject / pending    share →
                        (revisions kept)          validation → evidence    readiness, phase       (versioned)         acknowledge
```

1. **Ingest** — TXT, MD, CSV, JSON, PDF, DOCX, GitHub (README, issues, PRs,
   commits) and Google Drive. Checksum-deduplicated, revisioned, chunked with
   absolute character offsets. Connected GitHub/Drive sources are re-checked on
   a five-minute default interval (1–1440 minutes, configurable per source);
   unchanged content is skipped by checksum, changed content is re-ingested and
   approved handovers are marked outdated with a readable diff.
2. **Extract** — Gemini structured extraction when `GEMINI_API_KEY` is set;
   otherwise a deterministic labelled-line extractor that only reads explicit
   `Decision:`, `Task:`, `Risk:` style content, CSV rows and checkboxes. It never
   invents facts. Every item must quote the source verbatim; quote validation
   marks results `exact`, `normalized` or `failed`.
3. **Reconstruct** — links superseded decisions, flags same-topic conflicts,
   ownership gaps, stale and unverified items, and computes a readiness score,
   project phase and suggested next actions. A lead can confirm the current
   decision on the overview — the other statements become superseded and are
   excluded from every future draft. The departing member can be asked about
   ownership gaps, conflicts and open questions; an answer becomes
   **person-confirmed** evidence, and only that person can give it. Every
   suggested next action is also executable in place: assign an owner, answer a
   question, record a mitigation or close a task without leaving the overview.
4. **Compose** — builds a recipient-specific draft. Claims are included only if
   all citations point to sources the recipient may read; excluded claims appear
   as withheld counts by type and reason (`permissions`, `template`,
   `unverified`).
5. **Review & share** — `draft → in_review → approved → shared → acknowledged`
   (or `rejected`, then reopened). Every transition snapshots a version with a
   readable diff and writes an audit event. Share links are recipient-bound,
   expire after 7 days, can be revoked, and rotating one requires explicit
   confirmation. One exception is deliberate: in the seeded demo workspace a
   link opens read-only without sign-in so an evaluator can try the recipient
   journey; every other project keeps the recipient-only rule. The recipient
   view adds a first-week summary of what they own, what is blocked and what to
   do first.

---

## Permission model

Visibility is evaluated on **sources**, and claims inherit the strictest
constraint:

- Source scopes: `project` (all members), `roles` (lead / contributor /
  observer) or `users` (explicit allow-list).
- Unknown scopes and soft-deleted sources are hidden — **fail closed**.
- A claim with any citation the recipient cannot read is withheld entirely, so a
  restricted document can never be inferred from an included claim.
- **Read-time re-check** — every recipient view re-evaluates source visibility;
  affected items, alerts and recommendations are removed and audited.
- Reviewers cannot accept an item whose evidence they cannot read, and a lead
  cannot approve a handover containing accepted items they cannot access.
- Recipient payloads never contain `withheld` details, reviewer notes or
  reviewer-only alerts; handover lists omit item counts for recipient-only
  viewers.
- Clarifications are only offered for items the departing member can read, and
  only the addressee can answer or decline. Person-confirmed claims are scoped
  to the answering member and the project leads.
- Share tokens are stored as a SHA-256 hash, expire after `SHARE_TTL_DAYS`, and
  can be revoked; rotating a live link requires `confirmRotation`.
- Audit entries that reference a source the reader cannot access are redacted to
  `Restricted item` with no title, id or metadata.

Project leads can inspect every sensitive read and write via
`GET /api/projects/:projectId/audit`. A permission canary matrix runs in CI and
fails the build if any restricted string appears on any surface for any role.

---

## Repository layout

```
.
├── backend/                 Express API (Node 22, ESM, MongoDB)
│   ├── src/
│   │   ├── app.js           App wiring (helmet, CORS, rate limit)
│   │   ├── models/          Mongoose schemas
│   │   ├── routes/          auth, projects, handovers, demo
│   │   ├── middleware/      auth, project roles, validation, uploads, errors
│   │   └── services/
│   │       ├── access/      fail-closed visibility policy
│   │       ├── ingest/      parsers, chunker, GitHub/Drive, pipeline, queue
│   │       ├── ai/          Gemini + heuristic extraction, quote validation
│   │       ├── reconstruction/  supersession, state, next actions
│   │       └── handover/    compose, workflow, permission re-check
│   ├── tests/               Vitest + Supertest suites (17 files, 117 tests)
│   └── README.md            Full API reference and backend documentation
├── docs/                    Architecture, testing, quote accuracy, sync and
│                            clarification evidence, roadmap, improvement map
└── frontend/                React 18 + Vite + Tailwind SPA
    └── src/
        ├── pages/           Login, Projects, Overview, Sources, Claims,
        │                    Handovers, Review, Questions, People, Audit, Shared
        ├── components/      AppShell, claim cards, evidence drawer, UI kit
        ├── context/         auth, workspace, toasts
        └── lib/             API client, formatters, constants
```

Backend and frontend are independently installable; the frontend proxies `/api`
to `http://localhost:4000` in development.

---

## Configuration

**Backend** — create `backend/.env` for overrides; it is gitignored. Everything is
optional in development: with `MONGODB_URI` empty the server starts an ephemeral
in-memory MongoDB, and without `GEMINI_API_KEY` extraction uses the deterministic
heuristic. Production requires a strong `JWT_SECRET`. See
[`backend/README.md`](backend/README.md#2-configuration) for the full table.

**Frontend** — copy `frontend/.env.example` to `frontend/.env`. Leave
`VITE_API_URL` empty in development; set it to the deployed API origin for
production builds. `VITE_API_PROXY` overrides the local dev proxy target.

---

## Testing

```bash
cd backend
npm test               # 117 Vitest + Supertest tests, 17 suites
npm run eval:quotes    # quote-accuracy report (rules extractor; Gemini when configured)
```

**17 suites, 117 tests**, each against its own ephemeral MongoDB — no external
services needed. The permission canary matrix and the Round 3 suite run in CI on
every push and pull request.

- **permission-matrix** — seven viewer contexts × every content, handover,
  shared-link and audit surface; five canary strings must never cross a
  boundary, before and after revocation and conflict resolution.
- **round3-hardening** — recipient acknowledgement snapshots, first-week view,
  version diffs, share-token hashing/revocation, maker-checker approval,
  regenerate, and acknowledgement without new versions.
- **source-sync** — five-minute interval scheduling, checksum skip, failure
  retention, interval settings, and outdated handovers with a visible diff; the
  Drive path is exercised through the same pipeline with a mocked connector.
- **clarifications** — candidate gating, asking one/all, only-addressee
  answer/decline, person-confirmed evidence, and review of the result.
- **extraction** — verbatim quote location, `exact` / `normalized` / `failed`,
  heuristic extraction, CSV handling.
- **ingest-hardening** — re-ingestion, truncation, allow-lists, parser warnings.
- **api-ingestion** — auth, upload → ingestion → claims → evidence preview,
  role-restricted isolation, unsupported files, audit trail.
- **handover-permissions** — recipient withholding, hidden-until-shared, live
  permission re-check, template exclusions, review boundaries.
- **handover-workflow** — edit/submit/approve/share/acknowledge, version
  history, pending-item guard, transition guards, share rotation, and the public
  demo link (opens without sign-in, still refused for non-demo projects).
- **reconstruction** — supersession, conflicts, ownership gaps, readiness,
  next actions.
- **redaction** — secrets and PII are replaced before reviewers or recipients
  see a statement or quote.
- **conflict-resolution** — lead confirms the current decision, conflicts clear,
  fresh drafts exclude superseded versions.
- **claim-actions** — owner assignment, task closure, question answers,
  mitigation notes, observer rejection.
- **demo-seed**, **membership**, **llm-fallback** — seed authorization and
  scoped reset, role changes, and Gemini fallback on 404/429/503.

The frontend is validated with `npm run build`, `npm run smoke` (the built page
mounts and every bundled asset exists) and by the in-browser journeys in
[`docs/TESTING_NOTES.md`](docs/TESTING_NOTES.md). Quote accuracy is reported in
[`docs/QUOTE_ACCURACY.md`](docs/QUOTE_ACCURACY.md): 29/29 rules-extracted claims
and 35/35 Gemini-extracted claims matched their source verbatim (100% exact,
0 failed).

---

## Security notes

- JWT authentication with bcrypt hashing; login responses never include hashes.
- Helmet headers, configurable CORS, rate limiting, JSON body limits, upload
  extension allow-list and size caps.
- Fail-closed source visibility, including for leads who are not named in a
  source's role scope.
- Share links are recipient-bound, expire after `SHARE_TTL_DAYS`, are stored only
  as a SHA-256 token hash, and can be revoked; rotation requires confirmation.
  The seeded demo workspace is the single exception: its links open read-only
  without sign-in so evaluators can try the recipient journey, and the audit
  trail marks those acknowledgements as `public_share_link`.
- Clarifications can only be addressed to the recorded departing member, and
  only that member can answer or decline.
- Audit events record actor, action, target, IP and user agent for project,
  source, document, handover and authentication operations. Targets the reader
  may not access are redacted.
- Pipeline failures are logged without exposing document text.

The full privacy, security, accessibility and responsible-design statement is
in [`docs/SECURITY_PRIVACY_DESIGN.md`](docs/SECURITY_PRIVACY_DESIGN.md), and
the disclosure of AI tools used to build Threadline is in
[`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md). The project is licensed
under the MIT License ([`LICENSE`](LICENSE)).

---

## Known limitations

Honest scope of the current build — see [`docs/ROADMAP.md`](docs/ROADMAP.md) for
phasing and [`backend/README.md`](backend/README.md#10-known-limitations-and-roadmap)
for backend detail:

- **Redaction is pattern-based.** It catches emails, phone numbers, API
  keys/tokens, credentials, private keys and 12-digit IDs, but it does not
  reliably catch personal names, postal addresses or salary figures.
- **The demo workspace is shared.** Other evaluators can see and change the
  seeded Atlas data. The in-app notice says so; **Rebuild seeded data** only
  re-creates the seeded sources and preserves visitor uploads and handovers.
- **The queue is in-process.** Jobs are lost if the server restarts; startup
  recovery only re-queues sources stuck for more than 10 minutes.
- **Rules-only mode reads labelled lines only.** Without a Gemini key it
  extracts explicit `Decision:` / `Task:` / `Risk:` style lines, CSV rows and
  checkboxes; free-form prose yields nothing until a model is configured.
- **Connectors use a server-wide credential.** `GITHUB_TOKEN` and
  `GOOGLE_DRIVE_ACCESS_TOKEN` are shared by every project; there is no
  per-user OAuth consent flow.
- **Conflict detection is topic-based.** It compares topic keys and explicit
  supersession phrases, not semantic entailment.
- **There is no outbound notification.** Questions, approvals and
  acknowledgements are pull-based; nothing is emailed or pushed.
- **Frontend tests are limited to a smoke test.** The production build plus the
  scripted browser journeys are the main UI gate; there is no component test
  suite.
- No embeddings/semantic retrieval; extraction is per chunk by design.
- No SSO/SCIM, per-document ACLs or hard-erasure API; retention is soft delete
  plus audit history.

### Build timeline

Round 1 proposal (31 Oct) → Round 2 working product and progress report
(14 Nov) → Round 2 follow-up commits (15 Nov) → Round 3 improvements and
submission pack (16–17 Nov 2026). The three Round 3 improvements, tests and docs
are part of this submission tree; [`docs/IMPROVEMENTS.md`](docs/IMPROVEMENTS.md)
maps each one to its files, tests and screenshots.

---

## API

Base path `/api`. Auth, health and shared links are public; all other endpoints
require `Authorization: Bearer <token>`. The demo seeder is public only while
the workspace is missing — rebuilding requires the Atlas lead, and an existing
workspace is reconciled to the current demo personas without losing content.

Key groups: `/auth`, `/projects` (state, claims, sources, sync, clarifications,
documents, evidence, audit), `/handovers` (review, submit, approve, reject,
reopen, freshness, regenerate, share, revoke, acknowledge, versions, diffs,
shared links) and `/demo/seed`. Backend `.env` is gitignored;
[`backend/.env.example`](backend/.env.example) contains placeholders only.

The complete reference — request bodies, status codes, workflow guards and data
model — lives in [`backend/README.md`](backend/README.md#6-api-reference).
Architecture, trust boundaries and permission evaluation are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
