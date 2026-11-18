# Testing Notes

Living document — last updated 18 Nov 2026. Supersedes the Round 2 notes.
All results below were observed directly; no metric is projected or estimated.
Every automated result was produced on the local stack; the hosted deployment is
checked separately and called out where it differs.

---

## 1. Automated tests

`cd backend && npm test` — **18 suites, 138 tests**, green on the last full run
(18 Nov 2026, 134.83 s). Each suite boots its own ephemeral MongoDB
(`mongodb-memory-server`), so no external services are required.

| Suite | Tests | What it proves |
| --- | ---: | --- |
| `permission-matrix.test.js` | 3 | Seven viewer contexts × every content, handover, shared-link and audit surface; five canaries only reach the roles allowed to read them, before and after role revocation and after a conflict is resolved |
| `round3-hardening.test.js` | 12 | Live status/owner refresh for recipients, source purge with `source_removed`, freshness compare + regenerate, hashed share tokens and revocation, expired share links, maker-checker approval, accept-without-evidence note, acknowledgement snapshots, logout token revocation, distinct executive/audit scopes, first-week view, readable version diffs |
| `source-sync.test.js` | 7 | Interval scheduling, forced checks, checksum skip, outdated handovers with a diff (author and recipient), mocked Drive path, failure retention, sync settings rejected for uploads, collection-order-independent fingerprints |
| `clarifications.test.js` | 7 | Askable gaps and answer options, ask-all dedupe, addressee-only answer/decline, refusal for unreadable items, person-confirmed claim clears the gap, recipient label after sharing, redaction of answers |
| `claim-actions.test.js` | 10 | Owner assignment closes the gap, done tasks leave open work, question answers and mitigations, closure notes in the next draft, observer and incoming-recipient rejection, only the lead or departing member can answer a question, an answer note is required, validation and 404 guards |
| `conflict-resolution.test.js` | 6 | Lead confirms the current decision, the rest are superseded, conflict clears, drafts exclude superseded statements, audit event, contributor/observer rejection |
| `handover-permissions.test.js` | 13 | Recipient-specific withholding, hidden-until-shared, live re-check after visibility changes, template exclusions, review boundaries, non-member rejection, refusal for incoming-recipient handover creation, the incoming seat limited to the shared handover plus readable sources, and no view of a draft they authored under the old seat |
| `handover-workflow.test.js` | 7 | Edit/submit/approve/share/acknowledge, version history and audit, pending-item guard, transition guards, share rotation, and the public demo link: anonymous read and acknowledgement, audited with `channel: public_share_link`, refused for non-demo projects |
| `handover-extras.test.js` | 11 | Recipient and reviewer Markdown exports hide restricted evidence; export access control; share-open counts reset on rotation; feedback create/list/notify/resolve and rejection before sharing, from non-recipients, on items that became unreadable, and below the minimum length; honest `skipped`, `sent` and `failed` delivery rows with no webhook URL leaked; clarification delivery; reminder once-only, delay, acknowledgement and switch |
| `ingest-hardening.test.js` | 11 | Low-confidence and injection-like flags, truncation warnings, re-ingest preserves IDs/owners/statuses/resolutions, extraction method counts, 409 while processing, connector allow-list, confidential uploads lead-only, large-upload reporting, failed re-ingest keeps content, hiding a source removes it and its claims from every reader |
| `reconstruction.test.js` | 11 | Blocked status, no ingestion-time dates, no stale undated items, null readiness when empty, execution phase while anything is open, blockers list, fuzzy topic conflicts, identical restatements, critical unblock actions |
| `extraction.test.js` | 9 | Verbatim quote location (`exact` / `normalized` / `failed`), paraphrase rejection, heuristic extraction, CSV normalization |
| `redaction.test.js` | 4 | Emails, phones, credentials and 12-digit IDs; no double-redaction; ordinary text untouched; compose-time redaction of statements and quotes |
| `api-ingestion.test.js` | 3 | Auth, upload → ingestion → claims → evidence preview, role-restricted isolation, unsupported files, audit trail |
| `demo-seed.test.js` | 7 | Public seed only when the workspace is missing, scoped reset requires the lead, retired accounts, stale membership/owner/outgoing repaired without losing content, startup reconciliation leaves a missing workspace alone |
| `membership.test.js` | 4 | Role changes and access boundaries, adding an existing account, duplicate and unknown invitations, and member removal |
| `llm-fallback.test.js` | 3 | Gemini retry on 404 (retired model), 429 and 503 |
| `notifications.test.js` | 10 | Notices routed by role and event, one per recipient and event, removed when access ends, read state isolated per user, payload limited to a title, detail, project key and link |

Frontend validation: `npm run build` (clean Vite production build, 1,610 modules,
496.94 kB JS), `npm run smoke` (the built `index.html` mounts and every asset
exists) and `npm run e2e` (Playwright/Chromium, one spec covering the four core
journeys). The Playwright run starts its own backend on a spare port with an
empty `MONGODB_URI` (fresh in-memory database), seeds through the public demo
endpoint, and keeps `OUTBOUND_WEBHOOK_URL` empty and reminders disabled so the
delivery and reminder assertions are deterministic. There is still no component
test suite.

CI (`.github/workflows/ci.yml`) runs backend `npm ci && npm test` and frontend
`npm ci && npm run build && npm run smoke` on every push and pull request. The
Playwright run is a local gate, not yet a CI job.

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

### 3.1 Recorded Playwright run — 18 Nov 2026

Command (from `frontend/`):

```bash
E2E_BACKEND_PORT=4200 E2E_FRONTEND_PORT=5190 npx playwright test
```

Result: **2 passed (34.3 s)**, one Chromium worker, no retries. The spec
(`e2e/handover-journey.spec.js`) runs these steps in order:

| Step | What it asserts |
| --- | --- |
| Seed | `POST /api/demo/seed` succeeds against the fresh in-memory database |
| 1. Lead sign-in | One-click Subham profile lands on the Atlas project card; opening it shows **New handover** |
| 2. Compose–approve–share | Create a draft for Ananya Rao, accept all 25 items, submit, approve, create the share link |
| 3. Recipient open | The link opens in a clean guest context; **Download Markdown** produces `handover-ananya-rao-YYYY-MM-DD.md` containing the recipient view, and without a restricted source name; flagging an item sends a note |
| 4. Acknowledge | **Acknowledge receipt** shows the acknowledged state |
| Lead re-check | After reload: open count, the feedback text, a `skipped` delivery row, then **Mark resolved** changes the note to Resolved |
| Audit CSV | **Export CSV** downloads `atlas-audit-YYYY-MM-DD.csv` containing `handover.feedback_received` and `handover.acknowledged` |
| Incoming sign-in | One-click Ananya lands on `/handovers` with the **Incoming recipient** badge and the shared handover |
| Receive-only | No **New handover**, no **Prepare handover**, no **Mitigate**; nav lists only Sources and Handovers |
| Deep links | `/projects/:id`, `/claims`, `/questions` and `/people` all redirect to `/handovers` |
| Read-only sources | Sources loads with a `READ-ONLY ROLE` badge and no **Add source** control |

Artifacts on failure (trace, screenshot, video) are written under
`frontend/test-results/`; a passing run keeps the HTML report under
`frontend/playwright-report/`. Both directories are gitignored.

---

## 4. Accessibility

Method: an in-page DOM audit on four screens (login, overview, review, recipient
view) plus a WCAG contrast calculation for the text tokens. **axe and Lighthouse
could not be installed** — this environment has no outbound access to npm or the
CDN — so no automated accessibility score is claimed.

| Check | Result |
| --- | --- |
| Interactive elements audited | 134 (login 4, overview 49, review 46, recipient 35) |
| Controls without an accessible name | 0 |
| Form fields without a label | 0 |
| Images without `alt` | 0 |
| Positive `tabindex` values | 0 |
| Focusable elements inside `aria-hidden` | 0 |
| Landmarks and page heading | `main` = 1 and a visible `h1` on every audited screen; login now uses `main`/`aside` and a single `h1` |
| Text contrast | `ink.muted` `#5b6a7e` = 5.52:1 on white, 5.19:1 on canvas; `ink.faint` `#63718a` = 4.93:1 on white, 4.64:1 on canvas (both ≥ 4.5:1) |

Known gap: automated tooling was unavailable, so these numbers come from a
targeted DOM audit, not axe/Lighthouse. The recipient view after the contrast
and landmark fixes is captured in
`docs/screens/round3-recipient-accessible.png`.

---

## 5. Failure cases — verified behaviour

| Failure | Observed result |
| --- | --- |
| Unsupported / oversized upload | Rejected with a specific error code; nothing ingested |
| `GEMINI_API_KEY` missing | Deterministic heuristic extractor runs; it only reads explicit `Decision:` / `Task:` / `Risk:` lines, CSV rows and checkboxes |
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

---

## 7. Not yet covered / known gaps

- No live GitHub or Drive sync demonstration here (no outbound API access, no
  tokens, upload-only seed). The connector path is covered by mocked tests; see
  [`SYNC_EVIDENCE.md`](SYNC_EVIDENCE.md).
- No load testing; concurrency beyond demo scale is unmeasured.
- The in-process queue does not survive a hard crash; startup recovery only
  re-queues sources stuck for more than 10 minutes.
- No component tests. Playwright covers the core handover journey and the new
  export, feedback, delivery and CSV paths, but not every screen, and the E2E run
  is not yet a CI job.
- No axe/Lighthouse run; accessibility numbers come from the DOM audit in
  section 4.
- Outbound delivery is a single webhook POST with no retry queue. Without
  `OUTBOUND_WEBHOOK_URL`, rows say `skipped` and nothing leaves the server, so
  the hosted demo does not send real email.
