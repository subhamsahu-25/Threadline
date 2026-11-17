# Roadmap

Phases are ordered by the risk they remove from the current build. Effort is a
single-developer estimate in working days and includes tests and documentation.
Dates are relative to the Round 3 submission (17 Nov 2026); nothing below is
claimed as built.

## Phase 1 — Survive a restart (2–3 days)

| Item | Why it matters | Risk |
| --- | --- | --- |
| Durable queue (BullMQ + Redis or a Mongo-backed worker) | The in-process queue loses jobs on restart; startup recovery only re-queues sources stuck over 10 minutes. | Medium: adds a service to operate and a second failure mode. |
| Object storage for uploads (S3/R2) | Render's disk is ephemeral, so a re-ingest after a deploy fails with `file_missing`. | Low–medium: presigned uploads and a migration for existing files. |
| Startup self-check | Surface queue, storage and connector configuration in `/api/health`. | Low. |

## Phase 2 — Make connectors first-class (5–7 days)

| Item | Why it matters | Risk |
| --- | --- | --- |
| Google Drive OAuth consent flow | Today the connector needs a pasted access token, which expires. | Medium: redirect handling, token storage and per-user grants. |
| GitHub/Drive webhooks | Polling every five minutes is a floor, not a guarantee; webhooks make changes arrive in seconds. | Medium–high: signature verification, replay protection, per-repo setup. |
| Per-user connector credentials | The current `GITHUB_TOKEN` / `GOOGLE_DRIVE_ACCESS_TOKEN` is server-wide. | High: this is an authorisation-model change, not just storage. |
| Connector health UI | Show last error, next check and allow-list state per source. | Low. |

## Phase 3 — Stronger privacy and identity (6–8 days)

| Item | Why it matters | Risk |
| --- | --- | --- |
| SSO/SCIM | Organisations need central identity and deprovisioning. | High: provider matrix, group-to-role mapping. |
| Retention and hard erasure | Current deletion is soft delete plus audit history; there is no erasure endpoint. | High: must reconcile audit immutability with data-subject requests. |
| PII classifier for redaction | Pattern redaction misses names, addresses and salaries. | Medium: false positives can hide legitimate content; needs review UI. |
| Audit export and tamper evidence | Leads can read the log but cannot export or verify it. | Low–medium: signed batches. |

## Phase 4 — Better recall and reasoning (6–10 days)

| Item | Why it matters | Risk |
| --- | --- | --- |
| Vector retrieval for cross-source questions | Extraction is per chunk; there is no semantic index for "what changed across these sources?". | Medium: an index to operate, plus evaluation for retrieval quality. |
| Semantic conflict detection | Current conflicts are topic-key based, not entailment. | High: model quality and explainability. |
| Notification delivery | Questions, approvals and acknowledgements are pull-based. | Low: email/Slack delivery plus preference handling. |
| Reviewer assignment and SLA reminders | Handovers have no due date or escalation. | Low. |

## Phase 5 — Evaluation depth (ongoing)

| Item | Why it matters | Risk |
| --- | --- | --- |
| Frontend component and accessibility tests | Today the UI gate is the production build, a smoke test and scripted browser journeys. | Low–medium: test infrastructure and stable fixtures. |
| Load and concurrency testing | Behaviour beyond demo scale is unmeasured. | Medium: needs a staging environment and representative data. |
| Extraction quality benchmark | Quote accuracy is measured; statement completeness and precision are not. | Medium: requires a labelled corpus. |

## Sequencing rationale

Phase 1 fixes the two failures that lose user work. Phase 2 closes the gap
between "scheduled snapshot" and "live source". Phase 3 is required before
handling real workplace data at scale. Phase 4 improves usefulness once the
foundation is reliable. Phase 5 keeps the quality claims honest as the product
grows.
