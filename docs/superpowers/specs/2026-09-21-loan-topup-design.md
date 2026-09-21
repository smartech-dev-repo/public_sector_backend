# Loan Topup Design (Loan Lifecycle Overhaul — B2)

## 1. Purpose

The third sub-project of the Loan Lifecycle Overhaul phase (B2 of four —
A: Wallet & Ledger and B1: Loan Origination already shipped; B3 repayment
tracking + wallet integration and B4 spend-wallet come after this one).
Lets a client add more funds to their existing single active `ClientLoan`
(shipped in B1), reusing that same origination-style request → confirm →
approve → disburse pipeline rather than building a second one from
scratch.

Out of scope for B2: anything about actual repayment/overpaid/underpaid
tracking (B3) or spending wallet balance (B4) — this sub-project only
covers getting more money onto an existing loan.

## 2. Schema — `LoanRequest` gains a type discriminator

```prisma
enum LoanRequestType {
  ORIGINATION
  TOPUP
}
```

Add to the existing `LoanRequest` model:

```prisma
  type          LoanRequestType @default(ORIGINATION)
  clientLoanId  String?
  clientLoan    ClientLoan?     @relation(fields: [clientLoanId], references: [id])
```

`clientLoanId` is set only for `TOPUP` requests (the loan being topped up)
— `null` for `ORIGINATION`. Every other `LoanRequest` field (`amount`,
`tenorMonths`, the rate/management-charge snapshot, the full status
machine, `approvedAt`/`disbursedAt`/`rejectionReason`) is reused unchanged
for both types — a topup's own terms (its own tenor, its own computed
management charge) live on its own `LoanRequest` row, distinct from
whatever terms the loan originally disbursed with.

`GET /admin/loan-requests` gains an optional `?type=` filter alongside its
existing `?status=` one.

## 3. Topup eligibility

A new, separate `TopupEligibilityService` — not a branch inside the
existing `EligibilityService` — since origination and topup have opposite
conditions on "does the client already have an active loan," branching one
chain by type would be less clear than two small, focused rule lists.
Reuses `ClientMustBeVerifiedRule` and `AmountWithinSalaryCapRule` exactly
as they are today (the salary cap applies to the topup amount alone, not
combined with existing principal — per your call), plus two new rules:

- **`HasActiveLoanRule`** — fails unless the client has exactly one
  `ACTIVE` `ClientLoan`. The inverse of B1's `NoActiveLoanRule`.
- **`NoTopupInProgressRule`** — fails if the client has any non-terminal
  `LoanRequest` at all (`PENDING`/`CONFIRMED`/`APPROVED`, of either type).
  This is what "topup cannot be done when a previous [request] is pending
  completion" means, per your confirmation — a prior topup (or even a
  still-in-flight origination, though that shouldn't coexist with an
  active loan in practice) must fully resolve first.

## 4. Topup request creation, confirmation, and disbursement

**`POST /client/loan-requests/topup`** (`{ amount, tenorMonths }`, Client
JWT) — no loan ID in the request; the service looks up the client's one
`ACTIVE` `ClientLoan` itself, already guaranteed unique by
`HasActiveLoanRule` passing. Same `LoanTermOption` lookup (by the client's
agency + the chosen `tenorMonths`) and rate/management-charge snapshot
pattern as origination (B1 §3), computed against the topup amount. The SMS
confirmation text is adjusted for clarity ("Reply YES to confirm your loan
top-up of ₦{amount}" vs. origination's "...loan request of...") but reuses
the exact same `POST /webhooks/sms/inbound` → `confirmByPhone` flow,
completely unchanged — since `NoTopupInProgressRule` (§3) guarantees at
most one non-terminal `LoanRequest` per client at any time regardless of
type, `confirmByPhone`'s existing "most recent `PENDING` request for this
client" lookup keeps resolving correctly with no code change needed there.

Auto-approval/manual-approval/reject/disburse (B1 §3's status machine and
`LOAN_AUTO_APPROVE_THRESHOLD`) apply unchanged, evaluated against the topup
amount.

**On disbursement**, instead of creating a new `ClientLoan` (B1's
origination behavior), the existing one is updated:
- `principalAmount += topup.amount`; `principalBalance += topup.amount`
- `disbursedAmount` increases by the topup's own disbursed amount (same
  `DEDUCT_FROM_DISBURSEMENT`/`ADD_TO_REPAYMENT` logic from B1, applied to
  the topup amount)
- `maturationDate = max(current maturationDate, topup.disbursementDate +
  topup.tenorMonths)` — per your confirmed math, a topup only ever extends
  maturity, never shortens it
- the loan's own `tenorMonths`/`interestRatePercent`/management-charge
  fields (set at original disbursement) are untouched — they describe the
  loan's original origination terms; a topup's own terms remain queryable
  via its own `LoanRequest` row (`clientLoanId` back-reference)

This reuses B1's shared disbursement-creation private method, now
branching on `loanRequest.type`: `ORIGINATION` creates a new `ClientLoan`
(unchanged from B1); `TOPUP` updates the existing one as described above.

## 5. Testing

- Unit: `TopupEligibilityService`/`HasActiveLoanRule`/
  `NoTopupInProgressRule` (all pass/fail branches); `LoanRequestService`'s
  new `createTopup` (term lookup, snapshot, SMS text, `type`/
  `clientLoanId` set correctly); the disbursement helper's `TOPUP` branch
  (amount/balance increments, the `maturationDate` max-of-two-dates rule
  in both directions — topup tenor longer and shorter than remaining
  term).
- e2e: full topup flow (origination already active → topup request →
  confirm → auto or manual disburse → `ClientLoan` amounts/maturity
  updated); a second topup rejected while the first is still in flight;
  a topup rejected when the client has no active loan at all.

## 6. Postman

Per this repo's `CLAUDE.md`: new `POST /client/loan-requests/topup`
request (success + the two new rejection scenarios) under Client, and the
existing `GET /admin/loan-requests` request/example updated for the new
optional `?type=` filter — each with a saved response example authored
from the actual code once built.
