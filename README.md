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
you about this, and the request completes normally. The four demo profiles stay
available because the seeded workspace already exists; rebuilding it from the
UI additionally needs `DEMO_MODE=true` on the backend, which is off by default
so a production deployment never exposes public seeding.

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

Requirements: Node.js 22+ and npm.

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
| **Ananya Rao** | contributor (incoming) | The recipient — sees only handovers shared with her and the sources she may read; cannot prepare a handover, act on claims or upload |
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
6. **Hand over and close the loop** — both the reviewer and the recipient can
   download the handover as a PDF, rendered on the server from the same
   permission-filtered view they are looking at. The sender sees how many times
   the share link was
   opened, the first and last open times, and any recipient notes; the recipient
   can flag a single item or send a general note. Notes are audited and the lead
   can mark them resolved. Sharing, acknowledgement, clarification asks and
   reminders are queued through one delivery service: with
   `OUTBOUND_WEBHOOK_URL` set they are POSTed to that webhook and the result is
   shown on the handover as `sent`, `failed` or `skipped`; with no URL every row
   says `skipped` and that nothing left the server. A shared handover still
   unacknowledged after `HANDOVER_REMINDER_DAYS` (default 3) produces one
   in-app notice and one delivery row. The audit log exports to CSV from the
   lead-only, redaction-filtered rows currently on screen.

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
│   ├── tests/               Vitest + Supertest suites (17 files, 124 tests)
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
npm test               # 281 Vitest + Supertest tests, 30 suites
npm run eval:quotes    # quote-accuracy report (rules extractor; Gemini when configured)

cd ../frontend
npm run build          # production build
npm run smoke          # built page mounts, every asset resolves
npm run e2e            # Playwright: four journeys against a fresh in-memory API
```

**30 suites, 281 tests**, each against its own ephemeral MongoDB — no external
services needed. CI runs every suite on each push and pull request, alongside
the Playwright journeys, a production-dependency audit and a secret scan.

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
- **handover-extras** — permission-filtered PDF exports, access control on
  exports, share-open counters and reset on rotation, recipient feedback
  (including rejection of notes on items that became unreadable), honest
  `skipped` / `sent` / `failed` delivery rows, and once-only reminders that
  respect the delay, acknowledgement and switch.
- **reconstruction** — supersession, conflicts, ownership gaps, readiness,
  next actions.
- **redaction** — secrets and PII are replaced before reviewers or recipients
  see a statement or quote.
- **conflict-resolution** — lead confirms the current decision, conflicts clear,
  fresh drafts exclude superseded versions.
- **claim-actions** — owner assignment, task closure, question answers,
  mitigation notes, observer rejection.
- **auth-hardening** — identical answers for unknown addresses and wrong
  passwords, a breached-password blocklist, invite-only and domain-allow-list
  modes, lockout after repeated failures, and a strict API content security
  policy.
- **ingest-limits** — real DOCX and PDF parsing in a worker process, page and
  uncompressed-size caps, and magic-byte checks so a renamed binary cannot pass
  as a document.
- **ai-privacy** — confidential sources stay local, secrets and identifiers are
  redacted before text leaves the server, and document text cannot break out of
  the model's data block.
- **d-findings**, **findings-h**, **l-findings**, **r-findings** — the fault
  report's findings as regression tests: Unicode-safe comparison keys, quote
  verification, permission filtering of versions and counts, source purge across
  claims and handovers, handover-list scoping, audit fail-closed for critical
  actions, bulk review, stale-save conflicts, cursor paging and text caps.
- **connector-refs**, **share-audit**, **upload-cleanup**, **audit-labels**,
  **redaction-samples** — reference parsing that fails closed, anonymous
  share-link audit rows, upload file cleanup on every failure path, complete
  audit action labels, and a corpus of secrets and PII samples.
- **demo-seed**, **membership**, **llm-fallback** — seed authorization and
  scoped reset, role changes, and Gemini fallback on 404/429/503.

The frontend is validated with `npm run build`, `npm run smoke` (the built page
mounts and every bundled asset exists) and a Playwright run over the four core
journeys: one-click lead sign-in, compose → approve → share, guest recipient
opens the link, and acknowledges it. The same run downloads the PDF copy,
flags an item, resolves it as the lead, checks the `skipped` delivery row and
exports the audit CSV. `npm run e2e` starts both servers itself against a fresh
in-memory database and records traces, screenshots and video on failure; the
green run is also summarized in
[`docs/TESTING_NOTES.md`](docs/TESTING_NOTES.md). Quote accuracy is reported in
[`docs/QUOTE_ACCURACY.md`](docs/QUOTE_ACCURACY.md): 29/29 rules-extracted claims
and 35/35 Gemini-extracted claims matched their source verbatim (100% exact,
0 failed).

---

## Security notes

- JWT authentication with bcrypt hashing; login responses never include hashes.
  Registration and sign-in give identical answers for unknown addresses and
  wrong passwords, common/breached passwords are refused, and repeated failures
  pause sign-in for that account.
- Helmet headers, configurable CORS, rate limiting, JSON body limits, upload
  extension allow-list, magic-byte checks and size/page caps. Documents are
  parsed in a worker process, and written upload files are deleted on every
  failure path.
- The frontend ships a strict CSP, HSTS, `X-Frame-Options`, `nosniff` and a
  permissions policy from [`frontend/vercel.json`](frontend/vercel.json), and
  serves its three fonts from `frontend/public/fonts` — no third-party font CDN.
- Text sent to an external model is redacted first, and confidential sources
  stay on the local extractor unless the workspace explicitly opts in.
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
  may not access are redacted. Actions that must not proceed without a trace
  fail closed if their audit row cannot be written; anonymous share-link views
  and acknowledgements are attributed to an anonymous actor.
- Purging a source erases its text from claims, handover versions and questions,
  not just its visibility.
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
- **Outbound delivery is webhook-only and opt-in.** Without
  `OUTBOUND_WEBHOOK_URL` the product records `skipped` rows and sends nothing;
  there is no bundled email provider. With a URL set, delivery is a single POST
  with no retry queue.
- **Browser automation covers one journey, not every screen.** Playwright runs
  the lead-compose-share-recipient-acknowledge path plus export, feedback and
  audit CSV; other screens are covered by the scripted manual journeys and an
  axe-core pass over 50 page/persona/viewport combinations. There is no
  component test suite.
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
