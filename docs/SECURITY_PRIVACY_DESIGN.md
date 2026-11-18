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
  Without a key, extraction stays fully local and deterministic. Before any
  text is sent it goes through the same redaction pass used for handovers, and
  each source carries an external-AI policy: ordinary sources use the model by
  default, while confidential sources stay on the local deterministic
  extractor unless a lead explicitly allows the model. The flag is shown in
  the source detail and every change is audited.
- **Prompt injection is treated as data.** The chunk and its context live in
  one data block whose tag is a fresh random value for every request, and any
  tag-like delimiter copied from the document is removed before the request.
  Text that looks like an instruction is flagged, starts pending, and needs a
  person to accept it before a recipient can see it.
- **Recipients see the minimum.** Recipient payloads never contain withheld
  details, reviewer notes, reviewer-only alerts or the text of sources they
  cannot read.
- **Retention is explicit.** Sources are soft-deleted with revisions kept so
  history can be reconstructed; a formal retention policy and hard-erasure
  endpoint are future work (listed as a limitation, not claimed).
- **Secrets are never committed.** `backend/.env` is gitignored; the demo
  password `Threadline#2026` is scoped to seeded demo accounts only and is
  never presented as a real credential.

### Data flow to the extraction model

1. The source's sensitivity and external-AI policy are checked first. A
   confidential source with no explicit allowance never calls the provider;
   the local deterministic extractor runs instead.
2. The chunk and up to 600 characters of preceding context pass through
   `redactText`, which replaces credentials, API keys, tokens, private keys,
   bearer tokens, connection strings, webhook URLs, emails, phone numbers,
   card numbers, Aadhaar-like numbers and PANs with typed `[REDACTED: …]`
   markers. Unlabelled numbers are left alone unless a checksum (Luhn or
   Verhoeff) or a nearby label justifies redaction.
3. The redacted context and chunk are placed inside a single data block whose
   tag is a new random value for each request. Any `<source_document>` or
   matching delimiter copied from the document is removed first, so document
   text cannot close the block.
4. Only the redacted text leaves the server. A quote that comes back with a
   typed marker is mapped back onto the original document, so the evidence
   stays verifiable without the secret ever leaving the system.
5. Model output is schema-validated, and items that look like instructions are
   flagged for review rather than trusted.

## 2. Security

- **Authentication:** JWT sessions (HS256 pinned on sign and verify) with
  bcrypt-hashed passwords; login responses never include hashes. Tokens
  expire (`JWT_EXPIRES_IN`, 12h default). Every sign-in gets its own session
  row and `jti`, so signing out ends only that browser; "sign out
  everywhere" revokes all sessions and bumps `tokenVersion`.
- **Account protection:** unknown addresses pay the same bcrypt comparison as
  known ones, registration answers identically for new and existing
  addresses, and repeated failures lock an account temporarily with an
  audit event and an in-app notice. New passwords are checked against a
  breached-password list, character variety and name/address reuse.
- **Registration policy:** open sign-up is a demo affordance. Non-demo
  production deployments default to invite-only; `REGISTRATION_INVITE_CODES`
  and `REGISTRATION_EMAIL_DOMAINS` narrow it further. New accounts hold no
  project access until a lead adds them.
- **Transport and headers:** Helmet security headers on every response,
  including a strict API CSP (`default-src 'none'`, `frame-ancestors 'none'`,
  `form-action 'none'`, no referrer); configurable CORS allow-list; JSON body
  limits.
- **Abuse limits:** request rate limiting, separate per-IP and per-email
  sign-in limiters that ignore successful attempts, upload extension
  allow-list and size caps.
- **Fail-closed access model:** visibility is computed from
  `sourceVisibleTo` (project / roles / users scopes) at read time. Unknown
  scopes, soft-deleted sources and unresolvable evidence all resolve to
  hidden. A claim is included only when *every* citation resolves to a
  readable source, so restricted content cannot be inferred from included
  claims.
- **Share links:** recipient-bound, expiring (`SHARE_TTL_DAYS`, 7 days
  default), and still require a valid session for that recipient. The seeded
  demo workspace is the one deliberate exception: its links open read-only
  without a session so judges can evaluate the recipient journey. Anonymous
  views and acknowledgements are audited as an anonymous share-link visitor
  with `channel: public_share_link`, never attributed to the named recipient;
  view events are de-duplicated hourly and repeated permission re-checks are
  aggregated. Every other project refuses anonymous visitors.
- **Auditability:** every sensitive read and write (project, source,
  document, handover, authentication) writes an audit event with actor,
  action, target, IP and user agent. Leads can inspect the full trail via
  `GET /api/projects/:projectId/audit`.
- **Safe logging:** pipeline failures are logged without exposing document
  text.
- **Deployment:** production secrets live only in the hosting platform's
  environment configuration; the database is network-scoped to the backend.

Known, accepted limitations (also in the README): there is no mail provider,
so registration does not send a verification email; the invite/domain gate,
the fact that new accounts start with no project access, and the demo-only
public workspace bound the exposure. Session revocation is per-device, so a
lost device must use "sign out everywhere" (or wait for the 12h expiry). An
existing demo workspace can only be rebuilt by the Atlas lead; the background
queue is in-process, so a crash loses queued jobs. Handover
composition runs a redaction pass over statements, quotes, alerts and
recommendations (emails, phone numbers, API keys and provider tokens, JWTs,
bearer tokens, private keys, connection strings, webhook URLs, passwords and
other named credentials, card numbers and 12-digit national IDs with a label
or a valid checksum).

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
