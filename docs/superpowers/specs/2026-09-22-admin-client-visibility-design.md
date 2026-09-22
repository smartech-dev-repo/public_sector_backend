# Admin Client Visibility Design

## 1. Purpose

Today an admin's view of a single client is scattered: `GET
/admin/clients/:id` returns the client + onboarding/KYC, but their loan
requests, loan history, and any notion of "what has this client been
doing" each require separate, currently-nonexistent or unscoped lookups.
This adds three admin-facing, `clientId`-scoped additions so an admin can
see everything about one client without new tooling elsewhere:

1. A `?clientId=` filter on the existing loan-requests list.
2. A new client-scoped loans list.
3. A new merged activity timeline.

Out of scope (explicit choices made during brainstorming, not oversights):
- No single combined "everything at once" endpoint — three separate,
  `clientId`-scoped endpoints instead (matches your call).
- No new documents/signed-URL handling — `GET /admin/clients/:id`
  already returns raw KYC storage keys (`bvnSelfie`/`ninSelfie`/
  `liveSelfieKey`), resolvable via the existing generic
  `GET /admin/documents/files/:key` (`documents:read`) — the same
  raw-key pattern this codebase already uses for Agent's `cvKey`/
  `supportingDocumentKeys`, so there's nothing new to build here.
- No new `ClientActivityLog` table — the activity timeline is derived
  at query time from existing timestamped records (your call), not a
  new persisted feed.
- The existing `GET /admin/clients`/`GET /admin/clients/:id` endpoints
  keep their current `clients:review` permission unchanged — the new
  `clients:read` permission only gates the three additions below, no
  retrofit of already-shipped endpoints.

## 2. Permission

A new `clients:read` permission ("View a client's loan requests, loans,
and activity history"), added to `BOOTSTRAP_PERMISSIONS` following the
existing `<resource>:<action>` convention — mirrors the `agents:read`/
`agents:review` split already established for Agent (view vs. act).

## 3. Client-scoped loan requests and loans

**`GET /admin/loan-requests?clientId=`** — the existing endpoint
(`AdminLoanRequestController.list`, `LoanRequestService.listAll`) gains a
third optional filter alongside `status`/`type`, applied the same way
(`where: { status, type, clientId }`, Prisma ignores an `undefined`
value).

**`GET /admin/client-loans?clientId=`** (new) — `AdminClientLoansController`
currently only has `GET disbursement-summary` and
`GET :id/repayment-plan` (which takes a `ClientLoan`'s own id, not a
`clientId`). Add a `list` method requiring `clientId` (`400` if missing —
unlike the loan-requests filter, this one isn't optional, since an
unscoped "list every ClientLoan ever" isn't a use case here), returning
that client's `ClientLoan` rows ordered by `disbursementDate` descending
— a client can have more than one over time (a closed loan followed by a
new one), so this is a list, not a single object.

Both endpoints require `clients:read`.

## 4. Activities — merged timeline

**`GET /admin/clients/:id/activities`** (new, `clients:read`, added to
the existing `AdminClientReviewController`/`AdminClientReviewModule`
since it's about a client and needs no new module). Returns entries
sorted by `timestamp` descending, `{ timestamp: Date, type: string,
description: string, source: string }[]`, merged from:

- **`AuditLog`** rows where `targetType: 'Client'` and `targetId:
  clientId` (admin actions directly on the client — approve/reject
  review, wallet credit/debit, force session revoke), **plus** rows
  where `targetType: 'LoanRequest'` and `targetId` is one of this
  client's `LoanRequest` ids (admin approve/reject/disburse on their
  requests — resolved via a first query for this client's `LoanRequest`
  ids, then an `IN` filter on `AuditLog`, rather than changing how those
  actions already record `targetType` elsewhere in the codebase).
- **`LoanRequest`** creation/confirmation — synthesized from `createdAt`
  (always) and `confirmedAt` (if set) on each of this client's
  `LoanRequest` rows. These are client-initiated moments that
  `AuditLog` never captures (it only records admin actions); the
  admin-driven state changes on the same requests (approved/rejected/
  disbursed) are already covered by the `AuditLog` merge above, so
  there's no double-counting.
- **`Session`** rows (`principalType: CLIENT`, `principalId: clientId`)
  — one entry per row, `createdAt` as the login timestamp.
- **`WalletEntry`** rows for this client with `actorType: CLIENT` — this
  client's own wallet-to-loan applications (from the just-shipped Loan
  Lifecycle Overhaul phase), `createdAt` as the timestamp.
- **`ClientOnboarding`** — a single entry reflecting current `step`, at
  `updatedAt`. This is a real, acknowledged limitation: there's no
  per-transition history on this model today, so only the *current*
  state shows up, not a full history of every step the client passed
  through. Fixing that would mean adding new tracking, which contradicts
  the "derive from existing records" scope for this pass.

`404` if `clientId` doesn't resolve to a real `Client` (matches this
endpoint's sibling `GET /admin/clients/:id`'s existing behavior).

## 5. Testing

- Unit: the `clientId` filter on `LoanRequestService.listAll`; the new
  `list` method on the client-loans service path (missing `clientId` →
  `400`; correct ordering); the activities-merging logic — each source
  contributing correctly, correct overall sort order, the
  `LoanRequest`-scoped `AuditLog` id-resolution step, and the case of a
  client with zero activity in every source (empty array, not an error).
- e2e: a client with a mix of activity (a loan request with an admin
  approve/reject, a login session, a wallet application) produces a
  correctly-ordered, correctly-sourced timeline via the real endpoint;
  the two new list endpoints return only that client's own rows,
  excluding another client's.

## 6. Postman

Per this repo's `CLAUDE.md`: update the existing `GET /admin/loan-requests`
request/example for the new `clientId` filter, and add new requests for
`GET /admin/client-loans?clientId=` (success, missing-`clientId` `400`)
and `GET /admin/clients/:id/activities` (success, `404`) — each with a
saved response example authored from the actual code once built.
