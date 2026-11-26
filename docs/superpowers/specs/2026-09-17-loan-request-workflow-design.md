# Loan Request & Confirmation Workflow — Design

**Date:** 2026-09-17
**Status:** Approved for planning
**Depends on:** Client/IPPIS Onboarding Pipeline (`docs/superpowers/specs/2026-09-17-client-onboarding-pipeline-design.md`, built and shipped — a client must be `VERIFIED` to request a loan).

This is sub-project 2 of 3 in the larger "Client Onboarding, Login, and Loan Request" feature. Sub-project 1 (Onboarding) is done; sub-project 3 (Client Loan Dashboard/History) depends on this one and is a separate future spec.

## 1. Purpose and scope

Let a verified client request a loan, run an eligibility check, push it to the database as `PENDING`, send a two-way SMS asking the client to confirm, and resolve the request to `CONFIRMED` (via an inbound SMS reply) or `FAILED` (via a 24-hour timeout), with a resend option if the confirmation SMS was never delivered.

**In scope:**
- A new `LoanRequest` model — deliberately distinct from the existing `Loan` model, which holds historical/already-disbursed loans ingested from bank reports (a client-submitted request is a different concept: unapproved, pending, client-initiated).
- An extensible eligibility rule-list: `VERIFIED` status check + a salary-multiple cap now, structured so more criteria (to be specified later) can be appended without a redesign.
- A pluggable `TwoWaySmsProvider` interface with a mock implementation (matching every other external integration in this codebase) plus a public inbound webhook endpoint for a real vendor's reply forwarding.
- A 24-hour BullMQ-delayed expiry job, reusing the existing document-ingestion queue infrastructure's pattern (a new queue, not new infrastructure).
- A resend endpoint that re-sends the same confirmation SMS without resetting the expiry clock.
- A minimal `GET /client/loan-requests` listing scoped to this model only.

**Explicitly out of scope / deferred:**
- Disbursement — turning a `CONFIRMED` `LoanRequest` into a real `Loan` row is a separate future concern (presumably an admin/back-office action), confirmed out of scope for this round.
- The full Client Loan Dashboard (combining this with the ingested `Loan`/`LoanRepaymentRecord` history) — sub-project 3.
- The real SMS vendor integration and its webhook signature verification — mock-first this round, matching the `DojahIdentityVerificationProvider` precedent (interface + mock now, real implementation once a vendor is specified).
- The exact salary-cap ratio and any further eligibility criteria beyond the two shipping now — both explicitly flagged as provisional, to be supplied later.

## 2. Data model

```prisma
enum LoanRequestStatus {
  PENDING
  CONFIRMED
  FAILED
}

model LoanRequest {
  id                    String            @id @default(uuid())
  clientId              String
  client                Client            @relation(fields: [clientId], references: [id])
  amount                Decimal
  status                LoanRequestStatus @default(PENDING)
  confirmationSmsSentAt DateTime?
  confirmedAt           DateTime?
  expiresAt             DateTime
  createdAt             DateTime          @default(now())
  updatedAt             DateTime          @updatedAt
}
```

(`Client` needs the reciprocal `loanRequests LoanRequest[]` relation field added alongside its existing `onboarding` field — a small, mechanical addition, not a redesign.)

## 3. Eligibility

A small, composable rule-list — not a full pluggable-provider abstraction, since these are internal business rules, not external I/O. Each rule has the shape:

```typescript
interface EligibilityRule {
  check(client: Client, ippisRecord: IppisRecord, amount: number): { eligible: boolean; reason?: string };
}
```

Two rules ship now, run in sequence, first failure wins:
1. **`ClientMustBeVerifiedRule`** — `client.status === 'VERIFIED'`.
2. **`AmountWithinSalaryCapRule`** — `amount <= ippisRecord.salary * LOAN_SALARY_MULTIPLE_CAP` (env var, default `3` — an explicitly provisional placeholder pending the real ratio).

The `ippisRecord` used here is the one linked via the client's `ClientOnboarding.ippisRecordId` — a client with no `ClientOnboarding` row (never onboarded) fails eligibility trivially since there's no linked `IppisRecord` to check the salary cap against (this is subsumed by the `VERIFIED` check anyway, since onboarding must complete before `VERIFIED` is ever set).

Adding a future rule (e.g. "no existing active loan," "no delinquency on record") is appending one more class to the array passed into the eligibility service's constructor — no changes to the two existing rules or the calling code.

## 4. `TwoWaySmsProvider`

```typescript
export interface TwoWaySmsProvider {
  send(phone: string, message: string): Promise<void>;
}
```

Single-provider for now (no ordered-list failover — same reasoning as `FaceVerificationProvider`: only one vendor is in play). `MockTwoWaySmsProvider` logs the message (matching the existing mock `OtpProvider` console-logging precedent) rather than sending anything real.

The **inbound** side (the vendor forwarding a client's SMS reply to us) doesn't go through this interface at all — it's a plain public HTTP endpoint (`POST /webhooks/sms/inbound`) that any real vendor would be configured to call. This endpoint takes `{ phone, message }` (a generic shape standing in for whatever a real vendor's actual payload looks like — that mapping, plus signature verification, is deferred to when a real vendor is chosen, same treatment as the real Dojah provider's rollout).

## 5. Pipeline

1. **`POST /client/loan-requests`** (Client JWT, body `{ amount }`) — loads the client's `ClientOnboarding`/`IppisRecord`, runs the eligibility rule-list. Any failure → `422` with the failing rule's reason (unprocessable, not a validation error — the request body itself is well-formed, the business rule check failed). On success: creates `LoanRequest` at `PENDING` with `expiresAt = now + 24h`, sends `"Reply YES to confirm your loan request of ₦{amount}"` via `TwoWaySmsProvider`, records `confirmationSmsSentAt`, and enqueues a BullMQ job on a new `loan-request-expiry` queue delayed by 24 hours (`{ delay: 24 * 60 * 60 * 1000 }`, carrying `{ loanRequestId }`).
2. **Expiry job**: on firing, loads the `LoanRequest`; if still `PENDING`, sets `status = FAILED`. If already `CONFIRMED` (or somehow already `FAILED`), no-op — this handles the natural race between a late-arriving confirmation and the timer.
3. **`POST /webhooks/sms/inbound`** (public, no JWT) — body `{ phone, message }`. Finds the most recent `PENDING` `LoanRequest` for a client whose phone matches. No match → `200` anyway (never leak whether a phone number exists to an unauthenticated caller; just log and ignore). A case-insensitive match against `"YES"` or `"1"` → `status = CONFIRMED`, `confirmedAt = now`. Anything else → logged, left `PENDING` (no explicit "declined" outcome exists — only confirm-or-expire, per your original description).
4. **`POST /client/loan-requests/:id/resend`** (Client JWT) — only valid for a `PENDING` request belonging to the calling client (`404` if not theirs or doesn't exist, `409` if not `PENDING`). Re-sends the same message via `TwoWaySmsProvider`, updates `confirmationSmsSentAt`. Does **not** reset `expiresAt` or re-enqueue a new expiry job — the original 24-hour window from the first send still governs.
5. **`GET /client/loan-requests`** (Client JWT) — lists the calling client's own `LoanRequest` rows, most recent first. This is the only listing this sub-project ships; the full loan dashboard (ingested `Loan` + `LoanRepaymentRecord` history combined with this) is sub-project 3.

## 6. Error handling

- `amount` missing/not a positive number → `400` (DTO validation).
- Eligibility failure → `422` with the failing rule's `reason`.
- `resend`/inspecting a `LoanRequest` that doesn't belong to the calling client → `404` (never reveal another client's request exists via a `403` — `404` is indistinguishable from "doesn't exist" to an unauthorized caller).
- `resend` on a non-`PENDING` request → `409`.
- Inbound webhook with no matching `PENDING` request for the given phone → `200`, silently ignored (§5, point 3 — deliberate, not an oversight).
- `TwoWaySmsProvider.send` failure during the initial request → the whole `POST /client/loan-requests` call fails (`502`-style); the `LoanRequest` row and its expiry job are **not** created — a client should never end up with a stuck `PENDING` request that never got an SMS at all. `resend`'s own send failure similarly fails that request but leaves the original `LoanRequest` untouched (still `PENDING`, same `expiresAt`) — the client can retry `resend` again.

## 7. Testing strategy

Unit tests: each `EligibilityRule` independently (pure function, trivial to test in isolation), the eligibility-list orchestrator (first-failure-wins ordering), `MockTwoWaySmsProvider`, and a `LoanRequestService` suite (mocked Prisma + mocked queue) covering create/resend/webhook-confirm/expiry-job-handler, including the race case in §5 point 2 (job fires after the request was already confirmed). One e2e test: request → confirm via the inbound webhook → verify `CONFIRMED`; a second e2e test exercises `resend` on a still-`PENDING` request. The 24-hour expiry itself isn't exercised end-to-end in real time — the expiry job handler's own unit test covers that logic directly instead.
