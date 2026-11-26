# Client Loan Repayment Tracking Design (Loan Lifecycle Overhaul — B3)

## 1. Purpose

The fourth sub-project of the Loan Lifecycle Overhaul phase (B3 of five —
A: Wallet & Ledger, B1: Loan Origination, B2: Topup already shipped; B4:
spend-wallet-toward-a-payment comes after this one). Matches the existing
bulk repayment-schedule upload (`LoanRepaymentRecord`, the same ingestion
pipeline already reconciled against the historical bank-ingested `Loan`
model) against the platform-native `ClientLoan` (from B1/B2), so that:

- overpayment excess is automatically credited to the client's wallet
  (already shipped, sub-project A);
- underpayment is recorded (feeding the loan's status toward `DEFAULT`)
  with no penalty and no automatic remediation — an explicit simplicity
  choice, not an oversight;
- `ClientLoan.principalBalance` and `.status` move forward automatically
  as real repayment data arrives.

Out of scope for B3: spending wallet balance toward a payment (B4) and any
penalty/collections mechanism (explicitly ruled out).

## 2. New model: `ClientLoanRepaymentVariance`

A separate table, not a reuse of the existing `RepaymentVariance` (which
FKs only to the historical ingested `Loan` model) — consistent with B1's
precedent of keeping platform-native loan data in its own tables rather
than retrofitting the ingested-data models:

```prisma
model ClientLoanRepaymentVariance {
  id             String         @id @default(uuid())
  clientLoanId   String
  clientLoan     ClientLoan     @relation(fields: [clientLoanId], references: [id])
  period         String
  expectedAmount Decimal
  actualAmount   Decimal
  variance       Decimal
  status         VarianceStatus
  generatedAt    DateTime       @default(now())

  @@unique([clientLoanId, period])
}
```

Reuses the existing `VarianceStatus` enum (`MATCHED`/`UNDER_PAID`/
`OVER_PAID`/`NO_DEDUCTION_FOUND`) unchanged — same classification, same
meaning, just against a different loan source.

## 3. `ClientLoanReconciliationService`

Lives in the existing `src/reconciliation/` module, alongside
`ReconciliationService` (same domain — matching `LoanRepaymentRecord`
against a loan and writing variance rows — just a different loan source),
not a new top-level module.

`DocumentIngestionProcessor` calls it immediately after the existing
`reconciliationService.reconcileAll()`, on the same trigger
(`DISBURSED_LOANS`/`REPAYMENT_SCHEDULE` upload completing) — no new
trigger point.

**Matching**: for each `ClientLoan`, find `LoanRepaymentRecord` rows
sharing its `agency`+`staffId` (identical key to how
`ReconciliationService` and `ClientLoansService` already match), for
periods between its `disbursementDate` and `maturationDate` — mirrors
`ReconciliationService.reconcileAll()`'s existing period-filtering logic.

**Write-once per period** (your call): for each matched period, if a
`ClientLoanRepaymentVariance` row **doesn't already exist** for that
`(clientLoanId, period)`, compute and create it, applying the balance/
wallet/status effects below exactly once. If one already exists, skip —
no `upsert`, no re-processing, no double-counting from a re-run. A
genuine correction to an already-processed period is a manual admin
action (the admin already has a wallet credit/debit path for exactly this
kind of correction), not something reconciliation re-derives.

**Per period, once**:
- `expectedAmount` — `computeExpectedInstallment()`, unchanged, same
  function the ingested-Loan reconciliation already uses.
- `status` — classified the same way as today's reconciliation (`actualAmount
  === 0` → `NO_DEDUCTION_FOUND`; `|variance| <= tolerance` → `MATCHED`;
  otherwise `OVER_PAID`/`UNDER_PAID` by sign).
- **Balance**: `ClientLoan.principalBalance -= min(actualAmount,
  expectedAmount)`. One formula covers every case — matched pays down the
  scheduled amount; underpaid pays down whatever partial amount actually
  came in (the shortfall isn't credited, but real money received still
  counts — no penalty, but also no free ride); no-deduction leaves the
  balance untouched.
- **Wallet**: if `actualAmount > expectedAmount`, credit the excess
  (`actualAmount - expectedAmount`) to the client's wallet via
  `WalletService.credit(clientId, excess, description, { actorType:
  SYSTEM })` — the `SYSTEM` actor type was reserved for exactly this in
  the wallet design.
- **Status**: recompute and save `ClientLoan.status` —
  `CLOSED` if `principalBalance <= 0`; else `DEFAULT` if `maturationDate`
  has passed with a balance still owed, or this period's own status is
  `UNDER_PAID`/`NO_DEDUCTION_FOUND`; else `ACTIVE`. (Intentionally the
  same logic as `computeLoanStatus()` from the Client Loan History work,
  reimplemented as a small new function since it operates on
  `ClientLoanRepaymentVariance` rather than `RepaymentVariance` — not the
  same table, so the existing function can't be called directly, but the
  policy is identical by design.)

## 4. Visibility endpoints

**`GET /client/client-loans/me`** (Client JWT) — the client's most recent
`ClientLoan` regardless of status (so a `CLOSED` loan's history remains
visible), with a full `schedule` built exactly like
`ClientLoansService.getRepaymentPlan()` already builds one for ingested
loans: `generatePeriodRange(disbursementDate, maturationDate)` +
`computeExpectedInstallment()` for the expected column, overlaid with
`ClientLoanRepaymentVariance` rows where they exist, `"UPCOMING"` (null
`actualAmount`/`variance`) for periods with no data yet. Returns `null`
(not an error) if the client has never had a platform loan.

**`GET /admin/client-loans/:id/repayment-plan`** (Admin JWT, existing
`client-loans:read` permission) — the same shape, for any `ClientLoan` by
id, added as a sibling method on the existing `AdminClientLoansController`
(which already hosts the B1 disbursement-summary export under the same
permission).

## 5. Testing

- Unit: `ClientLoanReconciliationService` — matching (agency+staffId,
  period range filtering), write-once skip behavior (a second run over
  the same data doesn't re-touch an already-processed period), the
  balance formula across all four status outcomes, the wallet credit
  firing only on `OVER_PAID` with the right excess amount, and the status
  recomputation (`CLOSED`/`DEFAULT`/`ACTIVE`, all three branches). A new
  `computeClientLoanStatus()`-style pure function, tested the same way
  `computeLoanStatus()` already is.
- Unit: the two new endpoint handlers/service methods (client "no loan
  yet" → `null`; schedule assembly with `UPCOMING` periods).
- e2e: full cycle — a `ClientLoan` disbursed (reusing the origination/
  topup e2e helpers), a `LoanRepaymentRecord` uploaded for a period
  matching it (matched, underpaid, and overpaid variants across three
  loans), reconciliation triggered via the same document-ingestion path,
  then asserting `principalBalance`/`status`/wallet balance and both new
  GET endpoints' shapes.

## 6. Postman

Per this repo's `CLAUDE.md`: new `GET /client/client-loans/me` request
under Client, and `GET /admin/client-loans/:id/repayment-plan` under
Admin (alongside the existing disbursement-summary export) — each with a
saved response example authored from the actual code once built.
