# Testing Notes

Living document — last updated 19 Nov 2026. Supersedes the Round 2 notes and the
earlier Round 3 notes. All results below were observed directly; no metric is
projected or estimated. Every automated result was produced on the local stack;
the hosted deployment is checked separately and called out where it differs.

---

## 1. Automated tests

`cd backend && npm test` — **56 suites, 374 tests**, green on the last full run
(19 Nov 2026, Node 22, 296 s). Each suite boots its own ephemeral MongoDB
(`mongodb-memory-server`), so no external services are required.

| Suite | Tests | What it proves |
| --- | ---: | --- |
| `permission-matrix.test.js` | 3 | Seven viewer contexts × every content, handover, shared-link and audit surface; five canaries only reach the roles allowed to read them, before and after role revocation and after a conflict is resolved |
| `round3-hardening.test.js` | 12 | Live status/owner refresh for recipients, source purge with `source_removed`, freshness compare + regenerate, hashed share tokens and revocation, expired share links, maker-checker approval, accept-without-evidence note, acknowledgement snapshots, logout token revocation, distinct executive/audit scopes, first-week view, readable version diffs |
| `findings-h.test.js` | 9 | H1–H12 permission fixes: version reasons and diffs never quote unreadable text, reviewer counts and freshness use readable claims only, clarifications about unreadable claims become stubs, re-classification and re-ingest stay within readable scope, purge erases text from claims/handovers/questions, sensitivity cascades to claims, removing an addressee closes their questions, simultaneous answers produce one confirmation |
| `l-findings.test.js` | 13 | L1–L12 API consistency: handover-list scoping per role, outgoing person must be a member, member removal clears live references, critical actions fail closed when audit cannot be written while routine views still work, note-only decisions, no-op role changes, outsider counts hidden, second-lead approval, long question context, exact-name owner linking, folded document-open rows, readiness weights and the old-question window |
| `d-findings.test.js` | 19 | D1–D10 data correctness: Unicode-safe comparison keys, invented quote tails rejected, case-folded matches, invalid dates dropped with a warning, plural labels and owner lines, truncation reported, contradiction-aware conflict grouping, supersession restore, unique-name/email owner resolution, citations surviving re-ingest, resumable extraction, restricted sources marking drafts outdated, stored recipient owner id, regenerate resetting only changed decisions |
| `r-findings.test.js` | 7 | R1–R8 reliability: bulk review in one request and one history row, single review returning only the changed item, stale save mapped to 409, connector sync opt-in with backoff, cursor paging for claims, handovers and versions with visibility-aware totals, stored-text caps with a truncation warning |
| `ingest-limits.test.js` | 12 | Real DOCX and PDF parsing in a worker process, page-count and uncompressed-size caps, magic-byte checks rejecting renamed binaries, and a huge declared DOCX size refused |
| `ai-privacy.test.js` | 8 | Confidential sources default to local processing, ordinary sources stay external unless opted out, secrets and identifiers are redacted before text leaves the server, one random data block wraps context and chunk, and delimiter strings inside the document cannot break out |
| `auth-hardening.test.js` | 7 | Identical answers for unknown addresses and wrong passwords, weak/short/personal passwords rejected with a reason, invite-only and approved-domain modes, lockout after repeated failures, and a strict API content security policy |
| `source-sync.test.js` | 8 | Interval scheduling, forced checks, checksum skip, outdated handovers with a diff (author and recipient), mocked Drive path, failure retention, sync settings rejected for uploads, collection-order-independent fingerprints |
| `clarifications.test.js` | 7 | Askable gaps and answer options, ask-all dedupe, addressee-only answer/decline, refusal for unreadable items, person-confirmed claim clears the gap, recipient label after sharing, redaction of answers |
| `claim-actions.test.js` | 10 | Owner assignment closes the gap, done tasks leave open work, question answers and mitigations, closure notes in the next draft, observer and incoming-recipient rejection, only the lead or departing member can answer a question, an answer note is required, validation and 404 guards |
| `conflict-resolution.test.js` | 8 | Lead confirms the current decision, the rest are superseded, conflict clears, drafts exclude superseded statements, audit event, contributor/observer rejection, and restore/supersede edge cases |
| `handover-permissions.test.js` | 14 | Recipient-specific withholding, hidden-until-shared, live re-check after visibility changes, template exclusions, review boundaries, non-member rejection, refusal for incoming-recipient handover creation, the incoming seat limited to the shared handover plus readable sources, and no view of a draft they authored under the old seat |
| `handover-workflow.test.js` | 7 | Edit/submit/approve/share/acknowledge, version history and audit, pending-item guard, transition guards, share rotation, and the public demo link: anonymous read and acknowledgement, audited with `channel: public_share_link`, refused for non-demo projects |
| `handover-extras.test.js` | 12 | Recipient and reviewer PDF exports hide restricted evidence; export access control; share-open counts reset on rotation; feedback create/list/notify/resolve and rejection before sharing, from non-recipients, on items that became unreadable, and below the minimum length; honest `skipped`, `sent` and `failed` delivery rows with no webhook URL leaked; clarification delivery; reminder once-only, delay, acknowledgement and switch |
| `ingest-hardening.test.js` | 11 | Low-confidence and injection-like flags, truncation warnings, re-ingest preserves IDs/owners/statuses/resolutions, extraction method counts, 409 while processing, connector allow-list, confidential uploads lead-only, large-upload reporting, failed re-ingest keeps content, hiding a source removes it and its claims from every reader |
| `reconstruction.test.js` | 11 | Blocked status, no ingestion-time dates, no stale undated items, null readiness when empty, execution phase while anything is open, blockers list, fuzzy topic conflicts, identical restatements, critical unblock actions |
| `extraction.test.js` | 9 | Verbatim quote location (`exact` / `normalized` / `failed`), paraphrase rejection, heuristic extraction, CSV normalization |
| `redaction.test.js` | 4 | Emails, phones, credentials and 12-digit IDs; no double-redaction; ordinary text untouched; compose-time redaction of statements and quotes |
| `redaction-samples.test.js` | 36 | A corpus of 36 secrets and PII samples (GitHub, Stripe, AWS, private keys, emails, labelled Aadhaar numbers and more) replaced with typed placeholders and absent from the output |
| `api-ingestion.test.js` | 3 | Auth, upload → ingestion → claims → evidence preview, role-restricted isolation, unsupported files, audit trail |
| `upload-cleanup.test.js` | 3 | Written files deleted when request validation fails, when multer rejects before the handler, and when a successful upload is superseded while still referenced files are kept |
| `connector-refs.test.js` | 15 | GitHub `owner/repo` and pasted URL forms, length and character limits, no network call for traversal references, and fail-closed behavior with no allowlist for GitHub and Drive |
| `share-audit.test.js` | 3 | Anonymous demo share-link views and acknowledgements attributed to an anonymous actor, one row per hour, repeated permission re-checks folded into one hourly row |
| `audit-labels.test.js` | 2 | Every action the backend can write has a label, and no label exists for an action that is never written |
| `demo-seed.test.js` | 13 | Public seed only when the workspace is missing, scoped reset requires the lead, retired accounts, stale membership/owner/outgoing repaired without losing content, startup reconciliation leaves a missing workspace alone, reset removes only flagged seeded sources and adopts pre-flag workspaces by content |
| `membership.test.js` | 4 | Role changes and access boundaries, adding an existing account, duplicate and unknown invitations, and member removal |
| `llm-fallback.test.js` | 3 | Gemini retry on 404 (retired model), 429 and 503 |
| `notifications.test.js` | 10 | Notices routed by role and event, one per recipient and event, removed when access ends, read state isolated per user, payload limited to a title, detail, project key and link |
| `n2-lockout.test.js` | 4 | Demo personas cannot be locked out by strangers; failures are charged per client, counted atomically, and cleared by a session the owner already holds |
| `n3-quote-scan.test.js` | 6 | Marker-quote scanning is bounded: fails fast on a large document, caps markers, refuses distant fragments, short label-only matches and matches that re-redact differently or jump lines |
| `n5-jobs.test.js` | 5 | An abandoned job runs once, live leases and future retries are untouched, orphan rows are dropped, and a recovered job keeps its durable id |
| `n6-share-expiry.test.js` | 3 | An acknowledged recipient keeps access after the public link expires, revocation still closes the route, and the expiry warning fires once |
| `n8-verification.test.js` | 6 | Unverified accounts cannot join or create a project, expired or misaddressed links fail, invite codes bind to one address, and responses never leak tokens |
| `n9-purge.test.js` | 2 | Purging scrubs documents, options, feedback, audit labels, summaries and versions, and restores a decision the purged claim had superseded |
| `n10-clarification-visibility.test.js` | 2 | Questions whose options quote an unreadable decision are hidden from both the project and personal lists |
| `n11-answering-recovery.test.js` | 3 | A stale `answering` row re-opens on read, a fresh in-flight answer is left alone, and legacy rows without a timestamp recover |
| `n12-external-ai.test.js` | 4 | AI-policy changes require a readable source and a written reason for confidential ones, notify other readers, and do not re-ask on a no-op save |
| `n13-anonymous-feedback.test.js` | 3 | Anonymous feedback is labelled, capped per link, and never attributed to the recipient; signed-in notes keep their author |
| `n14-demo-share-preview.test.js` | 3 | A different demo profile still gets the public preview, anonymous access remains, and a non-demo project keeps its 403 |
| `n15-registration-limit.test.js` | 1 | Successful registrations are counted and the sixth in an hour stops |
| `n16-job-timeout.test.js` | 2 | A hung job fails, frees its worker slot and marks the source failed; a job inside the deadline is untouched |
| `n17-handover-supersession.test.js` | 3 | Regeneration references the previous acknowledgement, supersedes the old release, revokes its link and closes the whole chain |
| `n18-owner-resolution.test.js` | 4 | Owners link only on an exact email or full name, observers are excluded, and first names stay unconfirmed |
| `n19-upload-janitor.test.js` | 4 | The janitor deletes only generated upload names, supports dry-run, and refuses filesystem roots or directories it did not write |
| `n20-handover-list-scan.test.js` | 2 | Recipient filtering happens in the query, and the scan stops after a fixed number of batches |
| `n21-parser-limits.test.js` | 3 | Honest deflated DOCX reads succeed, real inflated size is measured rather than declared size, and one character cap covers every parser |
| `n22-demo-dates.test.js` | 5 | Seed content is relative to the supplied day, never a frozen corpus; reset refreshes dates, and an older corpus is still adopted |
| `n22-health.test.js` | 5 | The health answer is cached, degraded is reported when the probe fails, and demo availability exposes neither accounts nor secrets |
| `n22-password-policy.test.js` | 6 | Passwords are capped at bcrypt's 72 bytes, breach checks send only a hash prefix and fail open, and over-long registration is refused |
| `n22-pdf-fonts.test.js` | 2 | The handover PDF embeds Noto faces for Tamil, Bengali, Gujarati, Telugu and Devanagari; real text survives extraction with no missing glyphs |
| `n22-sessions.test.js` | 3 | Sessions are cached after the first request, `lastSeenAt` is written at most once a minute, and device listing hides token ids while revoking immediately |
| `n22-share-counter.test.js` | 1 | Concurrent share-link opens are counted without lost updates |
| `n23-demo-session.test.js` | 6 | The demo sign-in route issues sessions for seeded personas only, disappears when demo mode is off, never returns a password, and no demo credential ships in browser sources |
| `release-archive.test.js` | 3 | The archive flags environment files, dependencies, storage and build output, never tracks a real env file and contains tracked files only |

Frontend validation: `npm run build` (clean Vite production build, 1,619 modules,
533.65 kB JS with the 500 kB size warning, 144.61 kB gzip; 50.35 kB CSS), `npm run smoke`
(the built `index.html` mounts and every asset exists) and `npm run e2e`
(Playwright/Chromium, one spec covering the four core journeys). The Playwright
run starts its own backend on a spare port with an empty `MONGODB_URI` (fresh
in-memory database), seeds through the public demo endpoint, and keeps
`OUTBOUND_WEBHOOK_URL` empty and reminders disabled so the delivery and reminder
assertions are deterministic. There is still no component test suite.

Production dependency audits (`npm audit --omit=dev --audit-level=high`) report
**0 vulnerabilities** in both workspaces after upgrading `unpdf` to 1.9.1,
`zod` to 4.6.7 and `react-router-dom` to 7.18.5.

CI (`.github/workflows/ci.yml`) runs on Node 22 on every push and pull request:

| Job | What it runs |
| --- | --- |
| `backend` | `npm ci && npm test` |
| `frontend` | `npm ci && npm run build && npm run smoke` |
| `e2e` | `npm ci` in both workspaces, `npx playwright install --with-deps chromium`, `npm run e2e`; the HTML report is uploaded when the job fails |
| `audit` | `npm audit --omit=dev --audit-level=high` for backend and frontend |
| `secrets` | `node scripts/check-secrets.mjs` over every tracked file |

The secret scan checks 178 tracked files, skips dependencies, lockfiles, test
fixtures and binaries, flags private keys, cloud and API tokens, and fails if a
non-example `.env` file is tracked.

---

## 2. Quote accuracy

`npm run eval:quotes` (see [`QUOTE_ACCURACY.md`](QUOTE_ACCURACY.md)):

| Extraction | Claims | Exact | Normalized | Failed |
| --- | ---: | ---: | ---: | ---: |
| Rules-only — ATLAS corpus + one messy unlabelled fixture | 29 | 29 | 0 | 0 |
| Gemini | 35 | 35 | 0 | 0 |

Person-confirmed answers are excluded from the verified rate by design; they
carry `validation: person_confirmed`, not `exact`.

---

## 3. Main journeys — tested in a real browser

Exercised on the local dev stack at desktop 1440×900 and mobile 390×844. The
hosted build was exercised in earlier rounds; the Round 3 deployment is checked
in the release notes rather than duplicated here.

1. **Onboarding a recipient.** Lead creates a handover for the incoming member →
   accepts / edits / rejects items → submits → approves → shares → the recipient
   opens the share link, reads evidence previews and acknowledges.
2. **One-click demo sign-in and persona switching.** All four profiles sign in
   without credentials; switching profiles re-evaluates every view live and lands
   on the project root.
3. **Permission revocation mid-flight.** Restricting a source the recipient could
   read removes the affected items on reload, shows *"Some items changed since
   this handover was approved"* without a withheld count, and writes an audit
   event.
4. **Observer restrictions.** As Vikram, Sources shows five readable sources, a
   `READ-ONLY ROLE` badge and no add, access, re-ingest or remove controls
   (`docs/screens/round3-observer-restricted-sources.png`).
5. **Person-confirmed answer.** As Subham, ask Rohan about an ownership gap; as
   Rohan, answer with an owner; as Subham, share with the project, accept and
   approve. The recipient sees the confirmed label, name and date, and the gap
   closes (`docs/screens/round3-recipient-person-confirmed.png`).
6. **First-week view.** The recipient sees what they own, what is blocked and
   what to do first (`docs/screens/round3-recipient-first-week.png`).
7. **Upload re-ingest does not stale a handover.** Uploads are manual, not
   polled; re-ingesting one leaves an approved handover `current`. Connector
   changes are the path that marks it outdated (proved by `source-sync`).
8. **Sync controls are connector-only.** With upload-only seeded sources the
   Sources page renders no sync buttons while still stating the five-minute
   re-check (`docs/screens/round3-sources-sync-scope.png`).
9. **Conflict resolution.** The lead clicks *Keep as current*, confirms; the
   other statement becomes superseded, the conflict card disappears, and the
   audit log records `claim.conflict_resolved`.
10. **Deck actions.** Assign owner → the ownership gap count drops and readiness
    rises; answer question → the item leaves the deck. Both write an audit event.
11. **Deep links.** `/login`, `/projects/...` and `/shared/:token` resolve on the
    hosted SPA via `frontend/vercel.json` rewrites.
12. **Judge journey without an account.** With local storage cleared, the demo
    share link opens read-only in a fresh tab: "Prepared for Ananya Rao", the
    full approved content and the evidence previews appear, and *Acknowledge
    receipt* records the acknowledgement (audit `channel: public_share_link`).
13. **Incoming recipient is receive-only.** Signed in as Ananya, opening the
    project lands on **Handovers**, the only sections are Sources and Handovers,
    and the shared handover is the only one listed. There is no *New handover*,
    no *Prepare handover* and no *Mitigate*; direct URLs for overview, claims,
    questions and people redirect back to handovers; Sources shows the five
    readable sources with a `READ-ONLY ROLE` badge and no add control. The API
    returns 403 for project state, claims, clarifications and handover creation
    (`handover-permissions.test.js`, `claim-actions.test.js`).

### 3.1 Recorded Playwright run — 19 Nov 2026

Command (from `frontend/`):

```bash
npm run e2e
```

Result: **2 passed (18.2 s)**, one Chromium worker, no retries. The spec
(`e2e/handover-journey.spec.js`) runs these steps in order:

| Step | What it asserts |
| --- | --- |
| Seed | `POST /api/demo/seed` succeeds against the fresh in-memory database |
| 1. Lead sign-in | One-click Subham profile lands on the Atlas project card; opening it shows **New handover** |
| 2. Compose–approve–share | Create a draft for Ananya Rao, accept all 25 items, submit, approve, create the share link |
| 3. Recipient open | The link opens in a clean guest context; **Download PDF** produces `handover-ananya-rao-YYYY-MM-DD.pdf` containing the recipient view, and without a restricted source name; flagging an item sends a note |
| 4. Acknowledge | **Acknowledge receipt** shows the acknowledged state |
| Lead re-check | After reload: open count, the feedback text, a `skipped` delivery row, then **Mark resolved** changes the note to Resolved |
| Audit CSV | **Export CSV** downloads `atlas-audit-YYYY-MM-DD.csv` containing `handover.feedback_received` and `handover.acknowledged` |
| Incoming sign-in | One-click Ananya lands on `/handovers` with the **Incoming recipient** badge and the shared handover |
| Receive-only | No **New handover**, no **Prepare handover**, no **Mitigate**; nav lists only Sources and Handovers |
| Deep links | `/projects/:id`, `/claims`, `/questions` and `/people` all redirect to `/handovers` |
| Read-only sources | Sources loads with a `READ-ONLY ROLE` badge and no **Add source** control |

Artifacts on failure (trace, screenshot, video) are written under
`frontend/test-results/`; a passing run keeps the HTML report under
`frontend/playwright-report/`. Both directories are gitignored. The same command
runs in the CI `e2e` job.

---

## 4. Accessibility

Method: axe-core 4.10.2 (WCAG A/AA rules) injected into a real Chromium page,
run against **50 page/persona/viewport combinations** — every main screen for
lead, contributor, observer and incoming recipient, at desktop 1440×900 and
mobile 390×844 — plus scripted focus-order walkthroughs, horizontal-overflow
measurements and console-error capture.

| Check | Result |
| --- | --- |
| axe-core violations across 50 combinations | 0 |
| Horizontal overflow at 390 px | 0 pages |
| Console errors during the pass | 0 |
| Tab order visible on every focus stop | Pass on all audited screens |
| Landmarks and page heading | One `main` and one `h1` per screen; the desktop toolbar is a labelled `region` |
| Form fields without a label | 0 |
| Controls without an accessible name | 0 |
| Images without `alt` | 0 |
| Positive `tabindex` values | 0 |
| Text contrast | `ink.muted` `#5b6a7e` = 5.52:1 on white, 5.19:1 on canvas; `ink.faint` `#63718a` = 4.93:1 on white, 4.64:1 on canvas (both ≥ 4.5:1) |

Fixes made from this pass:

- The desktop project toolbar is now a labelled `region` landmark.
- The project key field has a visible label and an `id`.
- Superseded claim cards no longer dim text with `opacity`, restoring contrast.
- Empty-state headings use `h2`, removing a heading-order violation.
- The access-capabilities table is a focusable, labelled scroll region.
- Overview and People grids use `minmax(0, 1fr)` / single-column mobile layout,
  removing 12–142 px of horizontal overflow at 390 px.

The recipient view after these fixes is captured in
`docs/screens/round3-recipient-accessible.png`. axe-core was installed with
`--no-save`; it is not a project dependency.

---

## 5. Failure cases — verified behaviour

| Failure | Observed result |
| --- | --- |
| Unsupported / oversized upload | Rejected with a specific error code; nothing ingested |
| Renamed binary (PDF or DOCX bytes behind another extension) | Refused by the magic-byte check before parsing |
| PDF above the page cap, or DOCX declaring a huge uncompressed size | Rejected with a limit error; the parser worker does not load the document |
| `GEMINI_API_KEY` missing | Deterministic heuristic extractor runs; it only reads explicit `Decision:` / `Task:` / `Risk:` lines, CSV rows and checkboxes |
| Confidential source with AI enabled | Processed locally; text is not sent to the external model |
| Primary Gemini model unavailable (404 / 429 / 503) | Automatic retry on the fallback model, logged as a warning |
| GitHub repo not found / unreachable | Typed 404 / 502 errors surfaced in the UI |
| GitHub/Drive repo or folder not allow-listed | 403 with a clear error |
| Google Drive not configured | Explicit 501 explaining the required token |
| Connector sync fails | Previous knowledge kept, `sync.lastError` recorded, source stays `ready` |
| Re-ingest while processing | 409; no duplicate claims |
| Failed re-ingest | Previous content kept |
| Share link opened by the wrong person or after expiry | Access denied; links are recipient-bound and expire after `SHARE_TTL_DAYS` |
| Share link opened with no session outside the demo workspace | 403 asking for the named recipient to sign in |
| Demo share link opened with no session | 200, read-only; an acknowledgement from it is audited as `public_share_link` |
| Restricted citation on an otherwise visible claim | Whole claim withheld — partial visibility counts as no visibility |
| Quote cannot be matched in the source | Marked unverified; excluded from handovers until a reviewer resolves it |
| Clarification addressed to someone other than the departing member | Refused (400/403) |
| Critical action whose audit row cannot be written | Action fails closed; routine document views still succeed |
| Stale save from a second tab | 409 with a reload prompt, not a 500 |
| Backend cold start (Render free tier) | First request is slow (~60 s) but succeeds; the UI warns about it and repeats the notice after inactivity |

---

## 6. Permission guarantees

- **Fail closed:** unknown scopes, soft-deleted sources and missing evidence
  resolve to *hidden*, never *visible*.
- **All citations:** a claim is included only when every citation resolves to a
  source the recipient can read.
- **Counts:** viewers only ever see counts of rows they can already read. A
  recipient whose items disappear is told content changed, without a withheld
  number.
- **Review boundaries:** a reviewer cannot accept an item whose evidence they
  cannot read; a lead cannot approve a handover containing such accepted items.
- **Read-time re-check:** visibility is recomputed on every recipient open, so a
  revocation takes effect immediately with an audit event.
- **Canary matrix:** five unique strings are planted across every restriction
  type and asserted absent from every surface a viewer may not read.
- **Versions and diffs:** reasons and diffs are filtered by the reader's
  visibility, so a change to a hidden item does not leak its text.

---

## 7. Not yet covered / known gaps

- No live GitHub or Drive sync demonstration here (no outbound API access, no
  tokens, upload-only seed). The connector path is covered by mocked tests; see
  [`SYNC_EVIDENCE.md`](SYNC_EVIDENCE.md).
- No load testing; concurrency beyond demo scale is unmeasured.
- The in-process queue does not survive a hard crash; startup recovery only
  re-queues sources stuck for more than 10 minutes.
- No component tests. Playwright covers the core handover journey and the new
  export, feedback, delivery and CSV paths, but not every screen.
- Accessibility numbers come from the axe-core/DOM pass in section 4, not a
  Lighthouse score.
- Outbound delivery is a single webhook POST with no retry queue. Without
  `OUTBOUND_WEBHOOK_URL`, rows say `skipped` and nothing leaves the server, so
  the hosted demo does not send real email.
