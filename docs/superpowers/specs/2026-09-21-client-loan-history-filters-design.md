# Client Loan History — Filters, Default Status, and Repayment Plan Design

## 1. Purpose

`GET /client/loans` (shipped in the Client Loan Dashboard/History plan) already
returns a client's matched `Loan`/`LoanRepaymentRecord` rows with no filtering
and no notion of loan status. This extends that feature with:

- a computed **status** per loan (`ACTIVE` / `DEFAULT` / `CLOSED`), and
  filtering the loan list by it, plus by product and disbursement date range;
- a **repayment plan** view per loan — a full expected-vs-actual monthly
  schedule, reusing the reconciliation module's existing amortization
  calculation rather than inventing a second one.

This does not change loan *matching* (agency+staffId+BVN cross-check, from
the original dashboard design) — it only adds status/filtering to the list
and a new per-loan schedule endpoint.

## 2. Loan status derivation

Computed at request time, not persisted. Evaluated in this order for a given
`Loan`:

1. **`CLOSED`** — `principalBalance <= 0`. Fully repaid, regardless of
   whether `maturationDate` has passed.
2. **`DEFAULT`** — not closed, and *either* of:
   - `maturationDate` is in the past and `principalBalance > 0`, **or**
   - the loan's most recent `RepaymentVariance` row (ordered by `period`
     descending — `period` strings are `YYYY-MM`, so lexicographic order is
     chronological order) has `status` of `UNDER_PAID` or
     `NO_DEDUCTION_FOUND`.

   Only the *most recent* period is checked, not the full history — a loan
   that had one bad month but has since caught up (latest period `MATCHED`
   or `OVER_PAID`) is not flagged. A loan with no `RepaymentVariance` rows at
   all only reaches `DEFAULT` via the maturity+balance signal.
3. **`ACTIVE`** — everything else.

The two `DEFAULT` signals are OR'd deliberately: a loan can be flagged as failing before its maturity date (early warning from a bad recent payment), or after maturity purely from an unpaid balance, independent of recent payment behavior.

## 3. `GET /client/loans` — filters and status

**Query params** (all optional):
- `status` — one of `ACTIVE` / `DEFAULT` / `CLOSED`. Filters `loans` by the
  derived status above.
- `product` — exact match against `Loan.product`.
- `disbursedFrom` / `disbursedTo` — ISO 8601 date strings, inclusive range
  filter on `Loan.disbursementDate`.

Because `status` is computed in application code (not a DB column), the
service still fetches all of a client's matched loans first (existing
agency+staffId+BVN-cross-check logic, unchanged), computes each one's status
and, for the `DEFAULT` check, its most recent `RepaymentVariance` row, then
applies `status`/`product`/date filters in memory. This is acceptable
because a single client's loan count is small (a handful at most, unlike the
admin-facing reconciliation list which scans everything).

**Response** — each loan in `loans` gains a `status` field:

```json
{
  "loans": [
    { "id": "...", "customerName": "...", "product": "...", "status": "ACTIVE", "...": "..." }
  ],
  "repayments": [ { "...": "..." } ]
}
```

`repayments` (raw `LoanRepaymentRecord` rows) is unfiltered by the new query
params — those rows aren't tied to a specific `loanId` in the schema (see
§2 of the original dashboard design), so a per-loan filter can't cleanly
apply to them. This is unchanged from the shipped behavior.

An invalid `status` value (not one of the three) is a `400` validation
error, via a `class-validator` DTO on the controller (`@IsIn(['ACTIVE',
'DEFAULT', 'CLOSED'])` — this is not a persisted Prisma enum, so a plain
`@IsIn` decorator is used rather than `@IsEnum`).

## 4. `GET /client/loans/:loanId/repayment-plan` — new endpoint

Returns one loan's full expected-vs-actual schedule, one row per calendar
month from `disbursementDate` to `maturationDate` inclusive (same period
range reconciliation already uses — see §5).

**Ownership check**: the requested `loanId` must be one of the requesting
client's own matched loans (same agency+staffId+BVN-cross-check matching
used by `GET /client/loans`). If it doesn't match — wrong owner, or the ID
doesn't exist at all — the endpoint returns `404`, not `403`, so a client
can't distinguish "not yours" from "doesn't exist" (same never-leak-existence
convention already used by forgot-password across this codebase).

**Response:**

```json
{
  "loanId": "...",
  "schedule": [
    { "period": "2026-01", "expectedAmount": 45000.00, "actualAmount": 45000.00, "variance": 0, "status": "MATCHED" },
    { "period": "2026-02", "expectedAmount": 45000.00, "actualAmount": 30000.00, "variance": -15000.00, "status": "UNDER_PAID" },
    { "period": "2026-03", "expectedAmount": 45000.00, "actualAmount": null, "variance": null, "status": "UPCOMING" }
  ]
}
```

For each period in the full disbursement→maturity range:
- `expectedAmount` — always populated, via
  `computeExpectedInstallment(loanAmount, interestRatePercent,
  disbursementDate, maturationDate)` (existing function, `src/reconciliation
  /amortization.util.ts` — unchanged, reused as-is). This is a fixed value
  across every period for a given loan (a standard reducing-balance/annuity
  payment amount), matching the value reconciliation already stores as
  `RepaymentVariance.expectedAmount` for the same loan/period.
- If a `RepaymentVariance` row exists for that `(loanId, period)` (i.e. the
  period has already been reconciled against actual ingested repayments):
  `actualAmount`, `variance`, and `status` come directly from that row
  (`MATCHED` / `UNDER_PAID` / `OVER_PAID` / `NO_DEDUCTION_FOUND`).
- If no row exists yet (period hasn't been reconciled — typically because
  it's still in the future): `actualAmount: null`, `variance: null`,
  `status: "UPCOMING"`.

`"UPCOMING"` is a schedule-view-only status, not a `VarianceStatus` enum
value — it never gets written to `RepaymentVariance`, it only appears in
this endpoint's response when a period has no matching row.

## 5. Shared refactor: extracting period-key logic

`toPeriodKey()` is currently a private function inside
`src/reconciliation/reconciliation.service.ts`, used to convert a `Date`
into a `YYYY-MM` string. The new repayment-plan schedule needs the same
conversion, plus a new "generate every period between two dates" helper that
reconciliation doesn't currently need (it filters an existing list of
observed periods down to a range, rather than generating the range itself).

Both concerns move into a new `src/reconciliation/period.util.ts`:

```typescript
export function toPeriodKey(date: Date): string;
export function generatePeriodRange(start: Date, end: Date): string[];
```

`reconciliation.service.ts` is updated to import `toPeriodKey` from this new
file instead of defining it locally (no behavior change — pure extraction).
The new client-loans schedule code imports both functions.

## 6. Testing

- Unit tests for the new pure functions: status derivation (all 3 outcomes,
  including the "most recent period only" nuance and the OR-combination),
  and `generatePeriodRange` (single-month loan, multi-year loan, off-by-one
  at the boundary months).
- Unit tests for `ClientLoansService`: filter combinations on the existing
  `getDashboard` (now filtering), and the new `getRepaymentPlan` (ownership
  check — 404 on someone else's loan or a nonexistent one; UPCOMING overlay
  for periods with no `RepaymentVariance` row; correct overlay for periods
  that do have one).
- e2e test extending the existing client-loans e2e coverage: create a client
  with a matched loan and a mix of past `RepaymentVariance` rows (some
  `MATCHED`, one `UNDER_PAID` to trigger `DEFAULT`) and future unreconciled
  periods, hit both endpoints, assert filtering and the schedule shape.

## 7. Postman

Per this repo's `CLAUDE.md`, both endpoints need Postman coverage under the
existing Client → Loan Requests-adjacent area (the existing `GET
/client/loans - Success` request already lives directly under Client, per
`postman/README.md`'s folder structure — the new filtered-list and
repayment-plan requests join it there, not under Loan Requests, since
they're the same "loans" concern, not the loan-request-and-SMS-confirmation
flow). New requests, each with a saved response example:
- `GET /client/loans - Filtered by status`
- `GET /client/loans - Invalid status (400)`
- `GET /client/loans/:loanId/repayment-plan - Success`
- `GET /client/loans/:loanId/repayment-plan - Not found (404)`

The existing `GET /client/loans - Success` request's saved example gets
updated to include the new `status` field on each loan (a changed response
shape for an existing request, per `CLAUDE.md`'s "changed endpoint" rule).
