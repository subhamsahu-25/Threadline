# Clarification flow

Round 3 commitment: **ask the departing member about missing details, and route
the answer through the same evidence and review rules as document-derived
claims.** This document describes the flow, the guards, and how to reproduce it
on the demo workspace.

## 1. What counts as a missing detail

The overview rebuild (`buildClarificationCandidates`) offers three kinds of
candidate:

| Kind | Source | Default question |
| --- | --- | --- |
| `missing_owner` | an ownership gap (open task/responsibility with no owner) | “Who owns *…* after Rohan leaves?” |
| `conflict` | two active statements on the same topic | “Which decision is current for *…*?” |
| `open_question` | a claim of type `question` that is still open | the question statement itself |

A candidate is **askable** only when the recorded departing member can read the
underlying claim(s). If a restricted source holds the item, the card says so and
the API refuses the request — asking would disclose the item's existence or
content to someone who may not read it.

## 2. Asking

1. Sign in as **Subham Sahu** (lead) or a contributor, open **Project Atlas →
   Questions**.
2. The page lists candidates under *Ask the departing member*. Use **Ask this**
   on one card, or **Ask all open gaps (N)**.
3. `POST /api/projects/:projectId/clarifications` accepts
   `{ claimIds: [...] }` or `{ askForAll: true }`. A custom prompt is allowed
   for a single item only.
4. Duplicate open questions are skipped (`already_open`), unreadable items are
   skipped with `outgoing_member_lacks_access`, and every creation writes
   `clarification.asked` to the audit log.
5. The addressee gets a count badge next to **Questions** in the sidebar and a
   violet banner on the project overview.

Only the project's recorded outgoing member is offered as the addressee
(`project.transition.outgoingUserId`). If no departing member is recorded, the
candidate list is empty and the API returns `422 no_outgoing_member`.

## 3. Answering

1. Switch to **Rohan Mehta** (the recorded outgoing member) and open
   **Questions → Questions for you**.
2. Pick a suggested owner/statement chip or type an answer. Submit.
3. `POST /api/clarifications/:id/answer` checks:
   - the caller is `askedOf` (otherwise `403`);
   - the question is still `open` (otherwise `409`);
   - the answer is non-empty after sanitising (otherwise `400`).
4. The answer creates, in one operation:
   - a `Source` of kind `confirmation`, visible to the answering member and all
     project leads;
   - a `Document` whose raw text is the answer (marked `personConfirmed`);
   - an `Evidence` row with `validation: person_confirmed` and the answer as the
     quote;
   - a `Claim` with `origin: person_confirmed`, `state: confirmed` and the
     `person_confirmed` flag.

   For `missing_owner`, the referenced claim's owner is set to the named project
   member. For `open_question`, the original claim is marked `resolved`. For a
   `conflict`, the answer becomes a new decision claim.
5. The clarification becomes `answered` and the result claim id is stored on
   the record. Audit events: `clarification.answered` plus the relevant
   `claim.*` event.
6. The answer is **excluded from quote accuracy** because it is confirmed by a
   named person, not located in a document, and it is excluded from “Verified”
   counts until a reviewer accepts it.

## 4. Declining

The addressee may decline with an optional note. The clarification becomes
`declined`, the note is redacted and stored, and the claim is flagged
`clarification_declined` so the gap stays visible to the lead instead of
silently disappearing.

## 5. Reviewing the result

The person-confirmed claim behaves like any other claim:

- it appears in claims and state views for viewers allowed to read it;
- a lead creates a handover and accepts, edits or rejects it;
- handovers show a **Person confirmed** label and quote the answer;
- approving and sharing follow the normal workflow, including the permission
  re-check.

## 6. Reproducing on the demo workspace

1. As Subham, open **Questions** and ask all open gaps.
2. As Rohan, answer the ownership gap by choosing **Ananya Rao**.
3. As Subham, open the overview: the ownership gap count drops, and the new
   statement is labelled person-confirmed.
4. Create a handover for Ananya, accept the person-confirmed item, submit,
   approve and share.
5. As Ananya, open the share link: the item is present and labelled as
   person-confirmed guidance rather than a document quote.

## 7. Verification

`backend/tests/clarifications.test.js` covers candidate gating, ask-one and
ask-all, addressee-only answer/decline, validation, person-confirmed evidence
creation, the owner assignment, the resolved question, and the resulting claim
appearing in a reviewed handover. The clarification routes are also exercised
for role boundaries in the API suite.
