# Connected-source freshness — evidence

Commitment 2 from the Round 2 report: *keep connected GitHub and Drive sources up
to date, and mark an approved handover outdated with a visible diff when the
content changes.*

This file records what was built, how it is tested, what was observed in the
browser, and what could not be demonstrated in this environment.

---

## 1. What the code does

| Step | Behaviour | Where |
| --- | --- | --- |
| Sync state | Every source owns `sync: { enabled, intervalMinutes, lastCheckedAt, lastChangedAt, lastError, cursor.checksum }`. Default interval **5 minutes**, allowed range **1–1440**. | `backend/src/models/index.js`, `backend/src/routes/project.routes.js` |
| Scheduler | A one-minute interval scans connected sources and enqueues `sync_source` for each source whose own interval has elapsed. | `backend/src/services/ingest/sync.js` (`runDueSyncs`, `startSyncScheduler`) |
| Cheap change detection | A SHA-256 fingerprint over each document's kind, title, date and text. An unchanged fingerprint touches `lastCheckedAt` only; nothing is re-extracted or re-versioned. | `backend/src/services/ingest/sync.js` (`documentsChecksum`) |
| Re-ingest | A changed fingerprint queues the normal ingestion job. Claims keep their IDs for unchanged content; changed documents get a new revision; owners, statuses and resolutions survive. | `backend/src/services/ingest/index.js`, `backend/tests/ingest-hardening.test.js` |
| Failure behaviour | A failed connector check records `sync.lastError`, keeps the previous knowledge, and leaves the source `ready` rather than emptying it. | `backend/src/services/ingest/index.js` |
| Outdated handovers | After a non-upload ingestion, every approved / shared / acknowledged handover is compared with the live claims the recipient may read. On a difference the handover becomes `outdated` with `added`, `updated` or `removed` lines and a field-level before/after. | `backend/src/services/handover/workflow.js` (`refreshOutdatedHandovers`, `compareHandover`) |
| Recipient view | The recipient sees an **Outdated** banner and the permitted diff only. A change behind a source the recipient cannot read produces no diff line. | `frontend/src/components/RecipientHandover.jsx` |
| Regenerate | *Create updated version* rebuilds a draft from current state, carries over review decisions for surviving claims, and invalidates the old share link. | `backend/src/services/handover/workflow.js` |
| UI controls | **Refresh now**, **Automatic checks** and the interval picker appear only for `kind: github | drive`. Upload sources never show sync controls. | `frontend/src/pages/SourcesPage.jsx` |

---

## 2. Test evidence

`backend/tests/source-sync.test.js` — **7 tests**, all passing:

1. `checks a connected source on its interval and can be forced`
   — asserts `sync.enabled`, a 64-character checksum, `lastChangedAt` moving on
   changed content, and `lastChangedAt` staying put on an unchanged forced check.
2. `marks approved handovers outdated with a visible diff when content changes`
   — before: `freshness.status === "current"`; after: `"outdated"` with a
   field-level `status` change, visible to the author **and** through the
   recipient share link.
3. `syncs a Drive folder through the same connector pipeline`
   — `collectDriveDocuments` is mocked at the connector boundary; the same
   scheduler, checksum, re-ingest and outdated-diff path used by GitHub runs
   end to end.
4. `keeps previous knowledge when a sync check fails` — a network error records
   `sync.lastError` and leaves the source `ready`.
5. `updates sync interval settings and rejects uploads` — `enabled` and
   `intervalMinutes` persist; `PATCH .../sync` on an upload source returns 400.
6. `fingerprints documents regardless of collection order`.
7. `is due on the configured interval and only for enabled connectors` — due
   only when enabled, ready and the interval has elapsed; uploads are never due.

Supporting suite: `backend/tests/ingest-hardening.test.js` proves that a
re-ingest keeps claim IDs, owners, statuses and resolutions, and keeps the
previous content when ingestion fails.

Run it:

```bash
cd backend
npx vitest run tests/source-sync.test.js
```

---

## 3. Browser evidence

- `docs/screens/round3-sources-sync-scope.png` — the lead Sources view. The
  seeded workspace contains upload sources only, so no sync button is rendered;
  the page still states the five-minute re-check and the outdated-handover
  behaviour.
- `docs/screens/round3-observer-restricted-sources.png` — an observer sees five
  readable sources, a `READ-ONLY ROLE` badge and no add, access, re-ingest or
  remove controls.

I also verified in the browser that re-ingesting an **upload** source does not
mark an approved handover outdated: uploads are manual, not polled, and the
freshness refresh runs only after connector ingestion.

---

## 4. What was not demonstrated, and why

- **No live GitHub or Drive check was run.** This development environment has no
  outbound access to `api.github.com` or `googleapis.com`, and no connector
  tokens are configured. The seeded Atlas workspace contains uploaded files
  only, so there is no connected source to poll. The connector path is therefore
  proven by the mocked suite above, not by a live five-minute observation.
- **The three-timestamp recording from the plan was not produced.** It requires a
  reachable public repository and a hosted backend running this build; the
  Round 3 changes were not deployed during the build window.
- **Drive is token-paste, not OAuth.** `GOOGLE_DRIVE_ACCESS_TOKEN` is pasted into
  the environment; the consent flow is future work (`docs/ROADMAP.md`). The
  Drive sync test is mocked at the connector boundary and does not claim a live
  Drive run.
- **An earlier README walkthrough referenced a seeded `atlas-demo` repository.**
  No such source exists. The walkthrough now describes adding a connected source
  instead, or using the mocked suite when no connector credentials are
  available.

These limits are also published in the README's *Known limitations* section.

---

## 5. Reproducing a real five-minute check

1. Create a public synthetic repository (the plan called it `atlas-demo`).
2. Set `GITHUB_TOKEN` and `GITHUB_ALLOWED_REPOS=owner/atlas-demo` on the API.
3. In **Sources → Add source**, connect `owner/atlas-demo`.
4. Create, approve and share a handover that cites it.
5. Push a commit or open an issue. Within one interval (default five minutes)
   the source's `lastChangedAt` moves, the overview shows the new claim, and the
   approved handover flips to **Outdated** with a diff.
6. Record the commit time, the detected time and the time the overview showed
   the change.
