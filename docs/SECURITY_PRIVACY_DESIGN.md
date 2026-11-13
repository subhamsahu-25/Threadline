# Privacy, Security, Accessibility and Responsible Design — Round 3

How Threadline handles the data it is trusted with, and the design choices
that keep a handover honest.

---

## 1. Privacy

- **Synthetic demo data only.** The demonstration dataset (Project Atlas) is
  entirely fictional and seeded by the application itself. No real workplace
  documents, chats or credentials are used anywhere in the repository or the
  deployed demo.
- **No data leaves the system except to the configured extraction model.**
  Ingested text is sent to the Gemini API when `GEMINI_API_KEY` is set, for
  structured extraction only; nothing is stored with the model provider.
  Without a key, extraction stays fully local and deterministic.
- **Recipients see the minimum.** Recipient payloads never contain withheld
  details, reviewer notes, reviewer-only alerts or the text of sources they
  cannot read.
- **Retention is explicit.** Sources are soft-deleted with revisions kept so
  history can be reconstructed; a formal retention policy and hard-erasure
  endpoint are future work (listed as a limitation, not claimed).
- **Secrets are never committed.** `backend/.env` is gitignored; the demo
  password `Threadline#2026` is scoped to seeded demo accounts only and is
  never presented as a real credential.

## 2. Security

- **Authentication:** JWT sessions with bcrypt-hashed passwords; login
  responses never include hashes. Tokens expire (`JWT_EXPIRES_IN`, 12h
  default).
- **Transport and headers:** Helmet security headers on every response;
  configurable CORS allow-list; JSON body limits.
- **Abuse limits:** request rate limiting, upload extension allow-list and
  size caps.
- **Fail-closed access model:** visibility is computed from
  `sourceVisibleTo` (project / roles / users scopes) at read time. Unknown
  scopes, soft-deleted sources and unresolvable evidence all resolve to
  hidden. A claim is included only when *every* citation resolves to a
  readable source, so restricted content cannot be inferred from included
  claims.
- **Share links:** recipient-bound, expiring (`SHARE_TTL_DAYS`, 7 days
  default), and still require a valid session for that recipient.
- **Auditability:** every sensitive read and write (project, source,
  document, handover, authentication) writes an audit event with actor,
  action, target, IP and user agent. Leads can inspect the full trail via
  `GET /api/projects/:projectId/audit`.
- **Safe logging:** pipeline failures are logged without exposing document
  text.
- **Deployment:** production secrets live only in the hosting platform's
  environment configuration; the database is network-scoped to the backend.

Known, accepted demo-scope limitations (also in the README): JWTs are
stateless with no revocation list; the demo seeder endpoint is gated by
`ALLOW_DEMO_SEED` rather than authentication; the background queue is
in-process.

## 3. Accessibility

What the current build does:

- Semantic HTML structure with a single `h1` per screen and real headings
  for document outline.
- Keyboard-operable profile menu (`role="menu"` /
  `role="menuitemradio"` with `aria-checked`), closing on Escape and outside
  pointer events.
- Visible focus states, 44px+ touch targets on mobile, and responsive
  layouts verified at 390×844.
- Colour-coded states always pair colour with text labels or icons, not
  colour alone.

What it does not yet do (stated honestly): a full WCAG 2.1 AA audit has not
been performed; mobile drawer focus trapping is partial; contrast has been
checked informally rather than with an automated tool.

## 4. Responsible design

- **Human approval is mandatory.** A handover stays a draft until a
  reviewer edits, accepts or rejects items and explicitly approves. Nothing
  is shared automatically, and approval never grants access to an underlying
  source.
- **Uncertainty is labelled, never hidden.** Conflicting decisions, ownership
  gaps, unverified claims and stale items are surfaced as first-class states
  (`conflicting_decisions`, `ownership_gap`, unverified) and reduce the
  readiness score. Missing evidence is shown as missing — the system never
  presents a guess as fact.
- **Generated content is bounded by evidence.** Every extracted item must
  quote the source verbatim; quotes are validated against the source text
  with character offsets, and items that fail validation are excluded from
  handovers until a human resolves them.
- **Automation does not override access.** The AI layer only sees chunks the
  system already holds; the permission filter is applied downstream of
  extraction at read time, so revoking access removes items even from
  already-shared handovers.
- **No dark patterns.** Withheld content is reported as counts by reason;
  the product never reveals protected details to demonstrate that it could.
