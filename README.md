# Threadline

**Permission-aware, evidence-linked project handover.**
Built for **Hack With Pune** by **Team ZeusConquers**.

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
curl -X POST "http://localhost:4000/api/demo/seed?reset=true"
```

Pick any of the four demo profiles on the sign-in screen — one click, no
password, no registration. The same password (`Threadline#2026`) still works
for the API, but the UI signs seeded accounts in automatically. The profile
switcher in the top-right corner moves between people without signing out.

| Person | Role | What to try |
| --- | --- | --- |
| **Subham Sahu** | lead | Create a handover for Partho, review items, approve, share, restrict a source, read the audit log |
| **Soumyajit Jena** | contributor | The outgoing team member whose work is being handed over |
| **Partho Prateem Satypatty** | contributor | The incoming recipient — open the share link, acknowledge it |
| **Sabyasachi Behera** | observer | Read-only; confirm that restricted sources and claims stay hidden |

The seed builds **Project Atlas**: 4 people, 6 sources, 28 claims, a superseded
decision, a conflicting decision set and two ownership gaps.

**Suggested walkthrough**

1. Pick **Subham** on the sign-in screen → open *Project Atlas* → **Handovers** →
   create a handover for **Partho** with the `onboarding` template.
2. Accept / edit / reject items, then **Submit for approval**.
3. **Approve** as Subham and **Share**. Copy the share link.
4. Switch to **Partho** in the profile menu, open the link, read the evidence
   previews, acknowledge.
5. Switch back to **Subham**, open **Sources**, restrict `handover-notes.txt` to
   the `lead` role.
6. Switch to **Partho** again and reload the handover — affected items disappear
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
   absolute character offsets.
2. **Extract** — Gemini structured extraction when `GEMINI_API_KEY` is set;
   otherwise a deterministic labelled-line extractor that only reads explicit
   `Decision:`, `Task:`, `Risk:` style content, CSV rows and checkboxes. It never
   invents facts. Every item must quote the source verbatim; quote validation
   marks results `exact`, `normalized` or `failed`.
3. **Reconstruct** — links superseded decisions, flags same-topic conflicts,
   ownership gaps, stale and unverified items, and computes a readiness score,
   project phase and suggested next actions. A lead can confirm the current
   decision on the overview — the other statements become superseded and are
   excluded from every future draft. Every suggested next action is executable
   in place: assign an owner, answer a question, record a mitigation or close a
   task without leaving the overview.
4. **Compose** — builds a recipient-specific draft. Claims are included only if
   all citations point to sources the recipient may read; excluded claims appear
   as withheld counts by type and reason (`permissions`, `template`,
   `unverified`).
5. **Review & share** — `draft → in_review → approved → shared → acknowledged`
   (or `rejected`). Every transition snapshots a version and writes an audit
   event. Share links are recipient-bound and expire after 7 days.

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
  reviewer-only alerts.

Project leads can inspect every sensitive read and write via
`GET /api/projects/:projectId/audit`.

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
│   ├── tests/               Vitest + Supertest suites
│   └── README.md            Full API reference and backend documentation
└── frontend/                React 18 + Vite + Tailwind SPA
    └── src/
        ├── pages/           Login, Projects, Overview, Sources, Claims,
        │                    Handovers, Review, People, Audit, Shared
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
npm test
```

Seven suites, 37 tests, each against its own ephemeral MongoDB — no external
services needed:

- **extraction** — verbatim quote location, heuristic extraction, CSV handling.
- **api-ingestion** — auth, upload → ingestion → claims → evidence preview,
  role-restricted isolation, unsupported files, audit trail.
- **handover-permissions** — recipient withholding, hidden-until-shared, live
  permission re-check, executive template exclusions, review boundaries.
- **handover-workflow** — edit/submit/approve/share/acknowledge, version history,
  pending-item approval guard, transition guards, no restricted text in
  recipient payloads.
- **conflict-resolution** — lead confirms the current decision, the rest become
  superseded, fresh drafts exclude them, audit event, role guards.
- **claim-actions** — assigning an owner, closing tasks, answering questions and
  recording mitigations from the overview; closure notes reach the next draft;
  observer rejection and audit events.
- **llm-fallback** — Gemini model fallback on retired/unavailable models.

The frontend is validated with `npm run build`; the end-to-end demo flow has been
exercised in-browser across all four personas. Full testing notes, including
failure cases and hosted-deployment verification, are in
[`docs/TESTING_NOTES.md`](docs/TESTING_NOTES.md).

---

## Security notes

- JWT authentication with bcrypt hashing; login responses never include hashes.
- Helmet headers, configurable CORS, rate limiting, JSON body limits, upload
  extension allow-list and size caps.
- Fail-closed source visibility, including for leads who are not named in a
  source's role scope.
- Share links are recipient-bound, expire after `SHARE_TTL_DAYS`, and still
  require a valid session for that recipient.
- Audit events record actor, action, target, IP and user agent for project,
  source, document, handover and authentication operations.
- Pipeline failures are logged without exposing document text.

The full privacy, security, accessibility and responsible-design statement is
in [`docs/SECURITY_PRIVACY_DESIGN.md`](docs/SECURITY_PRIVACY_DESIGN.md), and
the disclosure of AI tools used to build Threadline is in
[`docs/AI_DISCLOSURE.md`](docs/AI_DISCLOSURE.md). The project is licensed
under the MIT License ([`LICENSE`](LICENSE)).

---

## Known limitations

Honest scope of the current build — see
[`backend/README.md`](backend/README.md#10-known-limitations-and-roadmap) for
detail:

- No embeddings/semantic retrieval; extraction is per chunk by design.
- Connectors are on-demand read-only snapshots (no webhooks or full OAuth flow).
- The background queue is in-process and does not survive a restart.
- Conflict detection is topic-based, not semantic entailment.
- No SSO/SCIM, per-document ACLs, outbound notifications or hard-erasure API.

Planned next: vector-backed cross-source retrieval, webhook sync, a durable
worker, assignment/SLA reminders and organisation-level SSO.

---

## API

Base path `/api`. Auth, health, shared links and the demo seeder are public; all
other endpoints require `Authorization: Bearer <token>`.

Key groups: `/auth`, `/projects` (state, claims, sources, documents, evidence,
audit), `/handovers` (review, submit, approve, reject, share, acknowledge,
versions, shared links) and `/demo/seed`.

The complete reference — request bodies, status codes, workflow guards and data
model — lives in [`backend/README.md`](backend/README.md#6-api-reference).
