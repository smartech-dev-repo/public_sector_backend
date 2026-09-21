# Loan Origination Design (Loan Lifecycle Overhaul — B1)

## 1. Purpose

The second sub-project of the Loan Lifecycle Overhaul phase (B1 of four —
sub-project A, Wallet & Ledger, already shipped; B2 topup, B3 repayment
tracking + wallet integration, and B4 spend-wallet come after this one, each
with their own design+plan cycle). This evolves today's `LoanRequest`
(currently just amount + `PENDING`/`CONFIRMED`/`FAILED` + SMS confirmation +
24h expiry, with no ongoing lifecycle after confirmation) into a full
request → approve → disburse pipeline that produces a real, trackable
`ClientLoan` — the platform-native "single active loan" a client can later
top up (B2) and repay against (B3).

Out of scope for B1: topup, repayment tracking/reconciliation, the
overpaid/underpaid wallet integration, and spending wallet balance toward a
payment. B1 only builds the origination pipeline and the resulting
`ClientLoan` record.

## 2. Loan Terms Catalog

Loan terms (tenor, interest rate, management charge) are admin-configured
per `agency` (the same field already on `IppisRecord`/`Loan` — e.g. `NPF`,
`CUSTOMS`) rather than being a single fixed platform-wide product. A new
model:

```prisma
enum ManagementChargeType {
  PERCENTAGE
  FLAT
}

enum ManagementChargeApplication {
  DEDUCT_FROM_DISBURSEMENT
  ADD_TO_REPAYMENT
}

model LoanTermOption {
  id                           String                       @id @default(uuid())
  agency                       String
  tenorMonths                  Int
  interestRatePercent          Decimal
  managementChargeType         ManagementChargeType
  managementChargeValue        Decimal
  managementChargeApplication  ManagementChargeApplication
  isActive                     Boolean                      @default(true)
  createdAt                    DateTime                     @default(now())
  updatedAt                    DateTime                     @updatedAt

  @@unique([agency, tenorMonths])
}
```

`managementChargeType`/`managementChargeValue` together express either a
percentage of the loan amount or a flat currency amount — admin's choice per
option. `managementChargeApplication` decides whether that charge is
deducted from what the client actually receives, or left in place with the
full requested amount disbursed and the charge instead added to what's
repaid (exact repayment-schedule math for the `ADD_TO_REPAYMENT` case is a
B3 concern; B1 only needs to compute and store the currency amounts
correctly — see §4).

Admin CRUD, gated by a new `loan-terms:manage` permission:
`POST /admin/loan-terms`, `GET /admin/loan-terms?agency=`,
`PATCH /admin/loan-terms/:id` (including toggling `isActive` — options are
deactivated, never deleted, since a past `LoanRequest` may reference one via
its snapshot — see §3). `GET /client/loan-terms` (Client JWT) returns the
active options for the *caller's own* agency, derived from their
`ClientOnboarding.ippisRecord.agency` — an empty array (not an error) if
they haven't completed onboarding yet, matching this codebase's
established convention for a client-facing endpoint with no data yet to
show (e.g. `ClientLoansService.getDashboard`, `WalletService.getWallet`).

## 3. `LoanRequest` changes

`CreateLoanRequestDto` gains a required `tenorMonths` — validated at request
creation against an active `LoanTermOption` for the client's own agency
(`422` if no active option exists for that agency+tenor combination, same
convention as the existing eligibility-failure responses). The matched
option's rate/charge fields are **snapshotted onto the `LoanRequest` itself**
at creation time — not re-derived later — so an admin editing or
deactivating a `LoanTermOption` afterward never silently changes the terms
of a request already in flight:

```prisma
enum LoanRequestStatus {
  PENDING
  CONFIRMED
  APPROVED
  DISBURSED
  REJECTED
  FAILED
}

model LoanRequest {
  id                            String               @id @default(uuid())
  clientId                      String
  client                        Client               @relation(fields: [clientId], references: [id])
  amount                        Decimal
  status                        LoanRequestStatus    @default(PENDING)
  tenorMonths                   Int
  interestRatePercent           Decimal
  managementChargeType          ManagementChargeType
  managementChargeValue         Decimal
  managementChargeApplication   ManagementChargeApplication
  managementChargeAmount        Decimal
  rejectionReason                String?
  confirmationSmsSentAt         DateTime?
  confirmedAt                   DateTime?
  approvedAt                    DateTime?
  disbursedAt                   DateTime?
  expiresAt                     DateTime
  createdAt                     DateTime             @default(now())
  updatedAt                     DateTime             @updatedAt

  clientLoan                    ClientLoan?
}
```

(`managementChargeAmount` is the computed currency value —
`amount * managementChargeValue / 100` for `PERCENTAGE`, or
`managementChargeValue` directly for `FLAT` — computed once at request
creation from the snapshot, so it never needs recomputing later.)

**Status flow:**
1. `PENDING` → `CONFIRMED` on the client's SMS "YES" reply — unchanged from
   today (`LoanRequestService.confirmByPhone`).
2. On confirmation, the amount is checked against
   `LOAN_AUTO_APPROVE_THRESHOLD` (a new env var, unset/`0` meaning "always
   manual review", matching this codebase's config-driven pattern like
   `LOAN_SALARY_MULTIPLE_CAP`):
   - **Below threshold**: `APPROVED` and `DISBURSED` fire together,
     synchronously, in the same handler — no admin step at all. A
     `ClientLoan` is created immediately (§4).
   - **At or above threshold**: stays `CONFIRMED`, waiting for an admin.
     `POST /admin/loan-requests/:id/approve` (→ `APPROVED`) or
     `POST /admin/loan-requests/:id/reject` with a required `{ reason }`
     body (→ `REJECTED`, following the same reason-required pattern as
     `AdminAgentReviewService.reject`). Only valid from `CONFIRMED` —
     `409` otherwise (matches `LoanRequestService.resend`'s existing
     `ConflictException` convention for a wrong-state action).
   - Once `APPROVED` (manually), a separate
     `POST /admin/loan-requests/:id/disburse` (only valid from `APPROVED`,
     `409` otherwise) moves it to `DISBURSED`, creating the `ClientLoan` at
     that point — the same creation logic as the auto path in §4, just
     triggered manually.
3. `FAILED` — unchanged: the existing 24h-expiry queue job, unaffected by
   any of the above (it only ever fires while still `PENDING`).

`GET /admin/loan-requests` (new `loan-requests:review` permission, shared
with approve/reject/disburse) lists requests, filterable by `?status=`, so
an admin can find the `CONFIRMED` review queue.

## 4. `ClientLoan` creation and the single-active-loan rule

A `ClientLoan` is created exactly once, 1:1 with its `LoanRequest`, the
moment that request transitions into `DISBURSED` (whether that happened
automatically or via the manual admin action):

```prisma
enum ClientLoanStatus {
  ACTIVE
  CLOSED
  DEFAULT
}

model ClientLoan {
  id                            String                       @id @default(uuid())
  clientId                      String
  client                        Client                       @relation(fields: [clientId], references: [id])
  loanRequestId                 String                       @unique
  loanRequest                   LoanRequest                  @relation(fields: [loanRequestId], references: [id])
  agency                        String
  staffId                       String
  principalAmount                Decimal
  disbursedAmount                Decimal
  principalBalance                Decimal
  tenorMonths                     Int
  interestRatePercent             Decimal
  managementChargeType            ManagementChargeType
  managementChargeValue           Decimal
  managementChargeApplication     ManagementChargeApplication
  managementChargeAmount          Decimal
  disbursementDate                DateTime
  maturationDate                   DateTime
  status                           ClientLoanStatus            @default(ACTIVE)
  createdAt                        DateTime                    @default(now())
  updatedAt                        DateTime                    @updatedAt
}
```

`agency`/`staffId` are copied from the client's `IppisRecord` at disbursement
time (the same denormalization the ingested `Loan` model already uses) —
this is what B3 will later match bulk repayment-schedule uploads against,
via the same `agency`+`staffId` pairing `ClientLoansService` already uses
for the historical data.

Computed at creation: `disbursedAmount = principalAmount -
managementChargeAmount` if `managementChargeApplication ===
DEDUCT_FROM_DISBURSEMENT`, else `disbursedAmount = principalAmount`.
`principalBalance` starts equal to `principalAmount`. `disbursementDate =
now()`; `maturationDate = disbursementDate + tenorMonths` (same month-based
math as `generatePeriodRange`/`toPeriodKey` from the Client Loan History
work, reused rather than reinvented). `status` starts `ACTIVE` — its
ongoing derivation (matching `computeLoanStatus`'s `ACTIVE`/`DEFAULT`/
`CLOSED` logic) is a B3 concern once repayment data exists to derive it
from; B1 just sets the initial value.

**Single-active-loan rule**: enforced when a client *creates* a new
`LoanRequest` (`POST /client/loan-requests`, unchanged route). Rejected
with `422` if the client already has:
- any non-terminal `LoanRequest` (`PENDING`/`CONFIRMED`/`APPROVED`) of
  their own, **or**
- a `ClientLoan` with `status: ACTIVE`, **or**
- an `ACTIVE` loan in their ingested bank history — reusing
  `computeLoanStatus()` from `src/client-loans/loan-status.util.ts`
  unchanged, matched the same way `ClientLoansService.getDashboard` already
  matches historical loans (agency+staffId+BVN cross-check).

Implemented as a new `NoActiveLoanRule` (`src/loan-request/eligibility/`).
Since this rule needs database access — unlike today's two rules, which are
pure synchronous functions — `EligibilityRule.check()`'s return type widens
from `EligibilityCheckResult` to `Promise<EligibilityCheckResult> |
EligibilityCheckResult`, and `EligibilityService.check()`'s loop `await`s
each result. This is a non-breaking change: the two existing rules keep
returning a plain (non-Promise) result, and `await`ing a non-Promise value
is a no-op pass-through in JavaScript.

## 5. Disbursement summary export

`GET /admin/client-loans/disbursement-summary?month=YYYY-MM` (new
`client-loans:read` permission) streams a CSV directly in the response
(`Content-Type: text/csv`, `Content-Disposition: attachment`) — unlike the
document-ingestion snapshot feature (`SnapshotExportService`/
`DataSnapshotExport`), this is a lightweight filtered report with no stored
export record, since a monthly disbursement view doesn't need permanent
history the way a full-table ingestion snapshot does. `month` is required;
`400` if missing or not a valid `YYYY-MM`. One row per `ClientLoan` whose
`disbursementDate` falls within that month: client name, client phone,
agency, principal amount, disbursed amount, tenor, interest rate,
management charge amount, disbursement date.

## 6. Endpoints summary

| Endpoint | Auth | Permission |
|---|---|---|
| `GET /client/loan-terms` | Client JWT | — |
| `POST /client/loan-requests` (unchanged route, `tenorMonths` added to body) | Client JWT | — |
| `POST /admin/loan-terms` | Admin JWT | `loan-terms:manage` |
| `GET /admin/loan-terms?agency=` | Admin JWT | `loan-terms:manage` |
| `PATCH /admin/loan-terms/:id` | Admin JWT | `loan-terms:manage` |
| `GET /admin/loan-requests?status=` | Admin JWT | `loan-requests:review` |
| `POST /admin/loan-requests/:id/approve` | Admin JWT | `loan-requests:review` |
| `POST /admin/loan-requests/:id/reject` (`{ reason }`) | Admin JWT | `loan-requests:review` |
| `POST /admin/loan-requests/:id/disburse` | Admin JWT | `loan-requests:review` |
| `GET /admin/client-loans/disbursement-summary?month=` | Admin JWT | `client-loans:read` |

Three new permission keys added to `BOOTSTRAP_PERMISSIONS`:
`loan-terms:manage`, `loan-requests:review`, `client-loans:read`.

## 7. Testing

- Unit tests: `LoanTermOption` CRUD service; `NoActiveLoanRule` (all three
  blocking conditions, and the pass-through case); `LoanRequestService`'s
  extended `create` (tenor validation, snapshot computation for both
  `ManagementChargeType`/`ManagementChargeApplication` combinations),
  `confirmByPhone` (both the below-threshold auto path and the
  at/above-threshold stays-`CONFIRMED` path), new `approve`/`reject`/
  `disburse` methods (including wrong-state `409`s), and `ClientLoan`
  creation math (`disbursedAmount`, `maturationDate`).
- e2e: full below-threshold flow (request → confirm → auto-disbursed →
  `ClientLoan` exists); full at/above-threshold flow (request → confirm →
  admin approve → admin disburse → `ClientLoan` exists); reject flow;
  single-active-loan rejection (both against an existing `ClientLoan` and
  against ingested bank history); disbursement summary CSV shape.

## 8. Postman

Per this repo's `CLAUDE.md`: new **Loan Terms** requests under both Client
and Admin, updated `POST /client/loan-requests` request/example (new
`tenorMonths` field), new **Loan Requests** admin review requests
(approve/reject/disburse, list), and the disbursement-summary export —
each with a saved response example authored from the actual code once
built.
