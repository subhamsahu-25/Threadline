# Round 3 improvements — what was promised vs what was delivered

The Round 2 progress report (14 Nov 2026) named exactly three improvements. The
Round 3 rubric scores against that list, so this file maps only those three,
then lists the additional hardening work separately.

**Status of the evidence:** the three improvements were built on 16–17 Nov 2026
and are part of the submitted working tree. They are not attributable to the
15 Nov commits `af8d23f` and `c7fa492`, which landed before this work and are
listed separately below. Where a commit hash is expected, the evidence is the
file, test name and screenshot in the same row.

---

## The three named improvements

| # | Named at Round 2 | Delivered | Evidence |
| --- | --- | --- | --- |
| 1 | Test access rules automatically for every user type, across project details, warnings, suggested actions and handovers; any leak fails the build; the final report shows how often quotes match | Yes | `backend/tests/permission-matrix.test.js` (3 tests, 7 viewer contexts, 5 canaries × every surface); `.github/workflows/ci.yml` runs the suite on every push and pull request; `backend/scripts/eval-quotes.js` + `docs/QUOTE_ACCURACY.md` (29/29 rules, 35/35 Gemini, 0 failed); `docs/screens/round3-observer-restricted-sources.png` |
| 2 | Keep connected GitHub and Drive sources up to date; a change within five minutes marks the approved handover outdated with the new version showing the changes | Yes (connector path tested with a mocked connector; see limits) | `backend/src/services/ingest/sync.js`, `backend/src/services/ingest/index.js`, `backend/src/services/handover/workflow.js`, `frontend/src/pages/SourcesPage.jsx`; `backend/tests/source-sync.test.js` (7 tests); `docs/screens/round3-sources-sync-scope.png`; `docs/SYNC_EVIDENCE.md` |
| 3 | Ask departing members about missing details; at least one ATLAS open question answered, shown as person-confirmed, and approved through review | Yes | `backend/src/services/clarifications.js`, `backend/src/routes/clarification.routes.js`, `frontend/src/pages/QuestionsPage.jsx`; `backend/tests/clarifications.test.js` (7 tests); `docs/CLARIFICATION_FLOW.md`; `docs/screens/round3-recipient-person-confirmed.png` |

### 1. Access-rule testing

**What exists.** `permission-matrix.test.js` plants five canary strings in source
names, document titles, extracted statements and quotes, then walks every API
surface for seven viewer contexts: lead, second lead, contributor, observer,
recipient, outgoing member and non-member. Surfaces include project details and
stats, `/state`, `/claims`, `/sources`, `/documents`, evidence, the handover
list, the author / lead / recipient handover views, shared links, alerts,
recommendations, next actions and the audit log.

Test names:

- `keeps every canary out of every surface before any access change`
- `re-checks every surface after role access is revoked`
- `re-checks every surface after a conflict is resolved`

**Count policy.** The measure is *no content, titles or source names*. Counts
shown to a viewer only ever count rows that viewer can already read. A recipient
whose items disappear sees *"Some items changed since this handover was
approved"* — no withheld number. The permitted-diff button counts only changes
built from sources the recipient may read.

**Quote accuracy.** `npm run eval:quotes` writes `docs/QUOTE_ACCURACY.md`:

| Extraction | Claims | Exact | Normalized | Failed |
| --- | --- | --- | --- | --- |
| Rules-only (ATLAS + messy fixture) | 29 | 29 | 0 | 0 |
| Gemini | 35 | 35 | 0 | 0 |

Person-confirmed answers are excluded from both the Verified count and the
quote-accuracy rate.

**CI.** The workflow runs backend `npm ci && npm test` and frontend
`npm ci && npm run build && npm run smoke` on every push and pull request.
**No red-run screenshot is included**, because the Round 3 branch was not pushed
during this build. The oracle is written to fail if any canary appears in a
response a viewer may not read; the suite runs green locally, with the current
counts taken from the CI JSON test report.

### 2. Connected-source freshness

**What exists.** Connector sources store a `sync` subdocument (enabled,
1–1440-minute interval, default 5, last checked/changed, last error, checksum).
A one-minute scheduler enqueues due sources. Unchanged fingerprints skip
extraction; changed content is re-ingested while claim IDs, owners and statuses
survive for unchanged claims. Approved, shared and acknowledged handovers are
compared with the live claims **the recipient may read** and become `outdated`
with `added` / `updated` / `removed` lines and field-level before/after values.
The recipient sees an Outdated banner and the permitted diff only; regenerating
creates a new draft and invalidates the old link.

Test names in `source-sync.test.js`:

- `checks a connected source on its interval and can be forced`
- `marks approved handovers outdated with a visible diff when content changes`
- `syncs a Drive folder through the same connector pipeline`
- `keeps previous knowledge when a sync check fails`
- `updates sync interval settings and rejects uploads`
- `fingerprints documents regardless of collection order`
- `is due on the configured interval and only for enabled connectors`

**Limits.** No live GitHub or Drive check was possible here: the environment has
no outbound access to those APIs, no tokens, and the seeded workspace is
upload-only. Drive is token-paste, not OAuth, and is covered by a mocked
connector test rather than a live run. Details and a reproduction recipe are in
[`SYNC_EVIDENCE.md`](SYNC_EVIDENCE.md).

### 3. Asking departing members

**What exists.** The lead or a contributor can ask the recorded departing member
about an ownership gap, a conflicting decision or an open question — one item or
"ask for all gaps". Only the addressee can answer or decline, and candidates are
limited to claims that member can read. An answer creates a `confirmation`
source, a document, evidence marked `person_confirmed` and a claim with
`origin: person_confirmed`; it then goes through the normal accept / edit /
reject and lead-approval path. The lead chooses *Share with project* when the
item should reach the recipient; otherwise the all-citations rule withholds it.
Answers are length-capped, treated as text, and redacted before sharing.

Test names in `clarifications.test.js`:

- `lists askable gaps and their answer options for the departing member`
- `asks for all gaps once and skips the ones already open`
- `T-C1 only the addressee can answer or decline`
- `T-C2 refuses to ask about an item the departing member cannot read`
- `T-C3/T-C4 an owner answer creates a person-confirmed claim and clears the gap`
- `T-C5 the recipient sees the confirmed label, name and date after the lead shares it`
- `T-C6 redaction applies to a person-confirmed answer before sharing`

**Recorded ATLAS path.** As Subham, ask Rohan *"Who owns Migrate invoice PDF
templates after Rohan Mehta leaves?"*; as Rohan, answer *"Ananya Rao"*; as Subham,
share it with the project, accept it in a handover and approve. The recipient
then sees the item labelled `PERSON-CONFIRMED` with the person and date, and the
ownership gap closes. Steps and the resulting states are in
[`CLARIFICATION_FLOW.md`](CLARIFICATION_FLOW.md); the recipient view is captured
in `docs/screens/round3-recipient-person-confirmed.png`.

---

## The five Round 3 success measures — result

| Measure from the Round 2 report | Result | Evidence / limit |
| --- | --- | --- |
| Zero restricted items, quotes, counts or labels reach the wrong person | Matrix green locally; no canary crosses a boundary | `permission-matrix.test.js` (3 tests); no red CI run was captured because the branch was not pushed |
| At least 90% of demo claims have a verified source quote | 100% exact, 0 failed | `QUOTE_ACCURACY.md`: 29/29 rules, 35/35 Gemini |
| A source change updates the overview within one refresh cycle (target 5 minutes) | Connector path proven by tests; no live five-minute observation | `source-sync.test.js` (7 tests); `SYNC_EVIDENCE.md` §4 states the environment limit |
| At least one missing detail answered by a departing member and approved | Done in ATLAS: owner answer → person-confirmed claim → shared → approved | `CLARIFICATION_FLOW.md`, `clarifications.test.js` T-C5, `round3-recipient-person-confirmed.png` |
| Zero test failures, existing and new | Full suite green | Local run 19 Nov 2026; exact counts in the CI JSON test report; CI workflow present but not triggered in this build window |

---

## Additional work — listed separately, not counted as the three

| Work | Where |
| --- | --- |
| Redaction of secrets/PII in statements, quotes, alerts and recommendations; certainty labels; scoped demo seed | commit `af8d23f` (15 Nov 2026) |
| Cold-start warning for the Render free tier, repeated after inactivity | commit `c7fa492` (15 Nov 2026) |
| In-place conflict resolution: a lead confirms the current decision and the rest become superseded | commit `20ae468` (13 Nov 2026) |
| Actionable next actions: assign an owner, answer a question, record a mitigation or close a task from the overview | commit `4435a09` (13 Nov 2026) |
| Author/lead handover views filtered by the viewer's permissions; evidence and edited statements redacted | `backend/src/services/handover/workflow.js`, `backend/tests/permission-matrix.test.js` |
| Re-ingestion keeps claim IDs, owners, statuses and resolutions; failures keep prior content; concurrent re-ingest returns 409 | `backend/src/services/ingest/index.js`, `backend/tests/ingest-hardening.test.js` |
| Reconstruction fixes: blocked status, undated claims never auto-supersede, null readiness for an empty project, fuzzy topic conflicts | `backend/src/services/reconstruction/*`, `backend/tests/reconstruction.test.js` |
| Share-token hashing, revocation, rotation confirmation, acknowledgement snapshots, maker-checker, readable version diffs | `backend/tests/round3-hardening.test.js` |
| First-week recipient view (what you own, what is blocked, what to do first) | `frontend/src/components/RecipientHandover.jsx`, `backend/tests/round3-hardening.test.js` |
| Accessibility pass: landmarks, one visible h1 per page, contrast-safe `ink.muted` / `ink.faint`, skip link, labelled controls | `frontend/src/pages/LoginPage.jsx`, `frontend/tailwind.config.js`, `docs/TESTING_NOTES.md` |
