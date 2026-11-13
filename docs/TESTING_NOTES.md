# Testing Notes — Round 3

How Threadline was tested across the main journeys, failure cases, permission
boundaries and reliability fixes. All results below were observed directly;
no metric is projected or estimated.

---

## 1. Automated tests

`cd backend && npm test` — **5 suites, 23 tests**, green on every run during
the build window. Each suite boots its own ephemeral
(`mongodb-memory-server`) database, so no external services are required.

| Suite | What it proves |
| --- | --- |
| `extraction.test.js` (8) | Verbatim quote location, `exact` / `normalized` / `failed` match states, heuristic extraction, CSV normalization |
| `api-ingestion.test.js` | Auth, project creation, upload → ingestion → claims → evidence preview, role-restricted source isolation, unsupported-file rejection, audit trail |
| `handover-permissions.test.js` | Recipient-specific withholding, hidden-until-shared, **live permission re-check after a visibility change**, executive template exclusions, review boundaries, non-member rejection |
| `handover-workflow.test.js` | Edit / submit / approve / share / acknowledge, version history + audit events, pending-item approval guard, transition guards, **no restricted text in recipient payloads** |
| `llm-fallback.test.js` (3) | Gemini model fallback retries on 404 (retired model), 429 and 503 instead of failing extraction |

The frontend is validated with `npm run build` (clean Vite production
build) and by the in-browser journeys below.

---

## 2. Main journeys — tested in a real browser

Exercised against both the local dev servers and the deployed production
stack (Vercel frontend + Render backend + hosted MongoDB), at desktop
1440×900 and mobile 390×844 viewports:

1. **Onboarding a recipient (core workflow)**
   Lead creates a handover for the incoming member → reviews items
   (accept / edit / reject) → submits → approves → shares → recipient opens
   the link, reads evidence previews, acknowledges. Run end-to-end on the
   hosted deployment with a 25-item handover; final state `acknowledged`,
   share link valid with expiry set.
2. **One-click demo sign-in** — all four seeded profiles sign in without
   credentials; auto-seed fallback on first 401 works on the hosted build.
3. **Persona switching** — switching profiles mid-session re-evaluates every
   view live; the observer loses the audit nav and upload actions, the lead
   regains them; routes land safely on the project root.
4. **Permission revocation mid-flight** — restricting a source the recipient
   could previously read removes the affected items on their next reload,
   shows a withheld count (never text), and writes an audit event.
5. **Deep links** — `/login`, `/projects/...` and `/shared/:token` resolve on
   the hosted SPA (fixed via `frontend/vercel.json` rewrites after a real
   404 was observed in production).
6. **Version history** — every workflow transition snapshots a version;
   the review screen's version drawer lists them with actor and reason.

---

## 3. Failure cases — verified behaviour

| Failure | Observed result |
| --- | --- |
| Unsupported / oversized upload | Rejected with a specific error code; nothing ingested |
| `GEMINI_API_KEY` missing | Deterministic heuristic extractor runs; it only labels explicit `Decision:` / `Task:` / `Risk:` style lines and never invents facts |
| Primary Gemini model unavailable (404 / 429 / 503) | Automatic retry on the fallback model, logged as a warning |
| GitHub repo not found / unreachable | Typed 404 / 502 errors surfaced in the UI |
| Google Drive not configured | Explicit 501 explaining the required token — no silent failure |
| Share link opened by the wrong person or after expiry | Access denied; links are recipient-bound and expire after `SHARE_TTL_DAYS` |
| Restricted citation on an otherwise visible claim | Whole claim withheld — partial visibility counts as no visibility |
| Claim whose quote cannot be matched in the source | Marked unverified; excluded from handovers until a reviewer resolves it |
| Demo reset with retired accounts | Retired demo emails return 401; stale users are removed from the database |
| Backend cold start (Render free tier) | First request is slow (~60 s) but succeeds; noted as a known limitation, not a failure |

---

## 4. Permission tests — summary of guarantees

- **Fail-closed:** unknown scopes, soft-deleted sources and missing evidence
  all resolve to *hidden*, never to *visible*.
- **All-citations rule:** a claim is included only when every citation
  resolves to a source the recipient can read.
- **No leakage in payloads:** recipient API responses were inspected for
  restricted text, withheld details, reviewer notes and reviewer-only alerts
  — none present.
- **Review boundaries:** a reviewer cannot accept an item whose evidence
  they cannot read; a lead cannot approve a handover containing such items.
- **Read-time re-check:** visibility is recomputed on every recipient open,
  so a revocation takes effect immediately, with an audit event.

---

## 5. Reliability improvements made during the build

- Gemini model fallback chain (primary → fallback model → heuristic
  extractor) so extraction degrades gracefully instead of failing.
- SPA rewrites on the hosted frontend so share/profile deep links work.
- Demo seed cleanup that removes retired demo accounts on reset.
- Interrupted ingestion jobs older than 10 minutes are re-queued on startup.
- Per-suite ephemeral databases keep the test suite hermetic and repeatable.

## 6. Not yet covered / known gaps

- No automated frontend tests; the UI is validated by build + scripted
  browser journeys.
- No load testing; concurrency beyond the demo scale is unmeasured.
- The in-process queue does not survive a hard crash (jobs in flight at the
  moment of the crash are lost) — a durable worker is on the roadmap.
