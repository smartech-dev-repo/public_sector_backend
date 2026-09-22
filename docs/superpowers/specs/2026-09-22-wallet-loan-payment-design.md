# Spend Wallet Balance Toward a Loan Payment Design (Loan Lifecycle Overhaul — B4)

## 1. Purpose

The fifth and final sub-project of the Loan Lifecycle Overhaul phase (A:
Wallet & Ledger, B1: Loan Origination, B2: Topup, B3: Repayment Tracking
all shipped). Lets a client apply their own wallet balance toward their
`ClientLoan`'s outstanding `principalBalance` — the piece of your original
request that's been deferred since sub-project A: *"the user can choose to
use the wallet balances as part of payment or complete underpaid or even
more."*

## 2. Schema — distinguishing a wallet application from a payroll reconciliation

`ClientLoanRepaymentVariance` (from B3) gains a `source` field, so a row
created by a client's own wallet application is distinguishable from one
created by the automatic payroll-based reconciliation:

```prisma
enum VarianceSource {
  PAYROLL_RECONCILIATION
  WALLET_APPLICATION
}
```

Add to the existing `ClientLoanRepaymentVariance` model:

```prisma
  source VarianceSource @default(PAYROLL_RECONCILIATION)
```

The default preserves the meaning of every row `ClientLoanReconciliationService`
(B3) already created — no backfill needed, no behavior change to that
service.

**One row per period, regardless of source** — this extends B3's existing
write-once invariant rather than replacing it. A wallet application is
only permitted when the *current* calendar period (via the same
`toPeriodKey()` format already used everywhere else) has no
`ClientLoanRepaymentVariance` row yet, whichever source it would have come
from. If payroll already reconciled this period, or the client already
applied wallet balance this period, a second wallet-application attempt
is rejected with `409` (matching this codebase's existing convention for
a wrong-state action, e.g. `LoanRequestService.approve`/`.reject`) telling
them to wait for the next period. This keeps "exactly one variance row
per `(clientLoanId, period)`" true everywhere, with no new collision case
to design around.

## 3. `POST /client/client-loans/me/apply-wallet`

Client JWT, `{ amount }` body (positive number, `class-validator`
`@IsNumber() @IsPositive()`, matching this codebase's existing amount-DTO
convention).

**Flow:**
1. The client must have a `ClientLoan` with `principalBalance > 0` — `422`
   otherwise (no active/outstanding loan to pay down; matches the
   existing `UnprocessableEntityException` convention used for other
   business-rule failures throughout this phase).
2. The current period must not already have a
   `ClientLoanRepaymentVariance` row — `409` otherwise (§2).
3. `amount` is **silently capped** at `principalBalance` (per your call)
   — the amount actually applied is `min(requested, principalBalance)`.
4. `WalletService.debit(clientId, appliedAmount, "Applied toward loan
   #<clientLoanId>", { actorType: AuditActorType.CLIENT, actorId:
   clientId })` — reused completely unchanged, including its own existing
   "can't debit more than the wallet's real balance" check (`422`,
   independent of the loan-balance cap in step 3 — a request can be
   within the loan's remaining balance but still exceed what's actually
   in the wallet, and that case is already handled correctly by
   `WalletService.debit`'s existing logic). This is the **first**
   `CLIENT`-actor wallet entry produced anywhere in the system —
   `AuditActorType.CLIENT` already existed as an enum value but nothing
   has used it until now.
5. A `ClientLoanRepaymentVariance` row is created for the current period:
   `source: WALLET_APPLICATION`, `expectedAmount` via the existing
   `computeExpectedInstallment()` (unchanged — used here purely for
   classification/display, not to cap the balance effect, see step 6),
   `actualAmount: appliedAmount`, `variance`/`status` classified the same
   way reconciliation already classifies every other row
   (`MATCHED`/`UNDER_PAID`/`OVER_PAID`/`NO_DEDUCTION_FOUND` — the last one
   can't actually occur here since `appliedAmount` is always positive by
   validation, but the same classify function is reused unchanged rather
   than writing a second one).
6. `ClientLoan.principalBalance -= appliedAmount` — the **full** applied
   amount, deliberately *not* `min(appliedAmount, expectedAmount)` the way
   B3's payroll path works. B3 caps at the expected installment (with the
   excess routed to the wallet) because a payroll deduction is outside
   the loan's control and an unplanned excess needs somewhere sensible to
   go. Here, the client explicitly chose this exact amount, it's already
   capped at what's actually owed (step 3), and it came directly out of
   their own wallet — there's no "excess" to route anywhere; the full
   amount pays down principal.
7. `ClientLoan.status` recomputed via the existing `computeClientLoanStatus()`
   (unchanged), using this new row if it's the loan's most recent
   variance row (it always will be, since it's for the current period).
8. Response: `{ appliedAmount: number, remainingBalance: number, status:
   ClientLoanDerivedStatus }`.

This is implemented as a new method on the existing `LoanRequestService`
(which already owns every `ClientLoan` mutation from B1-B3), consuming
`WalletService` as a new constructor dependency — `LoanRequestModule`
gains a `WalletModule` import, the same small cross-module wiring B3
already needed for `ClientLoanReconciliationService`. The endpoint itself
is a new method on the existing `ClientLoanController`
(`@Controller('client/client-loans')`, from B3).

## 4. Testing

- Unit: the service method — no-active-loan `422`; already-reconciled-
  period `409`; capping at `principalBalance` when the request exceeds
  it; the wallet-insufficient-balance case surfacing `WalletService.debit`'s
  own `422` unchanged; the full (uncapped-by-expectedAmount) balance
  reduction; status recomputation via the existing function; the created
  variance row's `source: WALLET_APPLICATION`.
- e2e: a client with an active loan and wallet balance applies part of it
  (verify `principalBalance`/wallet balance/status all update correctly,
  and the new row shows up in `GET /client/client-loans/me`'s schedule);
  a second application attempt in the same period is rejected `409`; an
  application exceeding wallet balance is rejected `422`; an application
  request exceeding the remaining loan balance is silently capped.

## 5. Postman

Per this repo's `CLAUDE.md`: new `POST /client/client-loans/me/apply-wallet`
request under Client — success, insufficient-wallet-balance (`422`),
already-reconciled-this-period (`409`) — each with a saved response
example authored from the actual code once built.
