# Client Loan Summary on Agent/Admin Client Screens — Design

## Overview

Agents and admins viewing clients today see onboarding/KYC data only — nothing
about whether the client has a loan. This adds a loan summary to all four
client-facing agent/admin screens:

1. `GET agent/clients` (list, existing — modify)
2. `GET agent/clients/:clientId` (view — **new**, doesn't exist today)
3. `GET admin/clients` (list, existing — modify)
4. `GET admin/clients/:id` (view, existing — modify)

Every row/response gets whether the client has a loan, its status, principal,
outstanding balance, monthly repayment, next payment date, and whether the
client is eligible for a top-up. The single-client view endpoints (2 and 4)
additionally get the full month-by-month payment schedule.

## "Has a loan" — two data sources, one precedence

A client's loan can come from either:

- **App-native** (`ClientLoan` table) — created when they originate or
  top-up/renew through this app.
- **Ingested** (`Loan` table) — historical payroll-ingested loan data,
  matched to the client by agency + staffId (+ BVN when both sides have one),
  for clients who had a loan before ever using the app.

This is exactly the precedence the existing top-up eligibility rules already
use (`HasActiveLoanRule`, `has-lifetime-loan.util.ts`): check `ClientLoan`
first; if none exists, fall back to the latest matched ingested `Loan`; if
neither, the client has no loan. This design reuses that precedence rather
than inventing a new one.

## Response shape

Every client row (list **and** view) gains two fields:

```typescript
loanSummary: {
  hasLoan: boolean;
  source: 'APP' | 'INGESTED' | null;
  status: 'ACTIVE' | 'DEFAULT' | 'CLOSED' | null;
  principal: number | null;
  balance: number | null;           // the outstanding principal balance
  monthlyRepayment: number | null;  // expected installment amount
  nextPaymentDate: string | null;   // 'YYYY-MM-DD' (first of month), null once CLOSED or no loan
}
topupEligibility: {
  eligible: boolean;
  reason?: string;                 // the exact existing eligibility-rule message when ineligible
}
```

When `hasLoan` is `false`, every other `loanSummary` field is `null`.

The **view** endpoints (2 and 4 above) additionally get:
```typescript
loanSchedule: Array<{
  period: string;                 // 'YYYY-MM'
  expectedAmount: number;
  actualAmount: number | null;
  variance: number | null;
  status: 'MATCHED' | 'UNDER_PAID' | 'OVER_PAID' | 'NO_DEDUCTION_FOUND' | 'UPCOMING';
}> | null
```
List endpoints do **not** get `loanSchedule` — a dozen+ schedule rows per
client would bloat a 25-row page for no benefit; the schedule only loads when
an agent/admin opens one client's detail page.

**Naming note:** "outstanding" and "balance" are treated as the same field
(`balance`) — there's no concept in this schema of arrears distinct from
principal balance + per-period variance status.

**`nextPaymentDate` precision:** this system reconciles at monthly
granularity only (no specific day-of-month due date is tracked anywhere), so
`nextPaymentDate` is always the 1st of the next un-reconciled month, not an
exact due day.

## Architecture

### New module: `ClientLoanSummaryModule`

A circular-import constraint drives this: `LoanRequestModule` already
imports `ClientLoansModule` (for `ClientLoansService`, used by the top-up
eligibility rules). A new service needing both `LoanRequestService` and
`ClientLoansService` can't live inside either of those modules without
creating a cycle, so it gets its own thin module.

`src/client-loan-summary/client-loan-summary.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { LoanRequestModule } from '../loan-request/loan-request.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';
import { ClientLoanSummaryService } from './client-loan-summary.service';

@Module({
  imports: [LoanRequestModule, ClientLoansModule],
  providers: [ClientLoanSummaryService],
  exports: [ClientLoanSummaryService],
})
export class ClientLoanSummaryModule {}
```

This requires `LoanRequestModule` to export `LoanRequestService` itself —
today it only exports `EligibilityService`/`TopupEligibilityService`. Add
`LoanRequestService` to that `exports` array (one-line change, no behavior
change to existing consumers).

### `ClientLoanSummaryService`

Built almost entirely by **reusing existing public methods** — only two
small new methods are needed anywhere in the codebase (both listed below).

```typescript
// src/client-loan-summary/client-loan-summary.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestService } from '../loan-request/loan-request.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';
import { computeExpectedInstallment } from '../reconciliation/amortization.util';
import { nextPeriodDate } from '../reconciliation/period.util';
import { Client, ClientLoan, IppisRecord } from '../generated/prisma/client';

export interface LoanSummary {
  hasLoan: boolean;
  source: 'APP' | 'INGESTED' | null;
  status: 'ACTIVE' | 'DEFAULT' | 'CLOSED' | null;
  principal: number | null;
  balance: number | null;
  monthlyRepayment: number | null;
  nextPaymentDate: string | null;
}

const NO_LOAN_SUMMARY: LoanSummary = {
  hasLoan: false,
  source: null,
  status: null,
  principal: null,
  balance: null,
  monthlyRepayment: null,
  nextPaymentDate: null,
};

@Injectable()
export class ClientLoanSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanRequestService: LoanRequestService,
    private readonly clientLoansService: ClientLoansService,
    private readonly topupEligibilityService: TopupEligibilityService,
  ) {}

  async getSummary(clientId: string): Promise<LoanSummary> {
    const clientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId },
      orderBy: { disbursementDate: 'desc' },
    });
    if (clientLoan) {
      return this.buildAppSummary(clientLoan);
    }

    const matched = await this.clientLoansService.getLatestMatchedLoan(clientId);
    if (matched) {
      return this.buildIngestedSummary(matched);
    }

    return NO_LOAN_SUMMARY;
  }

  async getSchedule(clientId: string) {
    const clientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId },
      orderBy: { disbursementDate: 'desc' },
    });
    if (clientLoan) {
      const loanWithSchedule = await this.loanRequestService.getMyLoan(clientId);
      return loanWithSchedule?.schedule ?? null;
    }

    const matched = await this.clientLoansService.getLatestMatchedLoan(clientId);
    if (!matched) {
      return null;
    }
    const { schedule } = await this.clientLoansService.getRepaymentPlan(clientId, matched.id);
    return schedule;
  }

  async getTopupEligibility(
    client: Client,
    onboarding: { ippisRecord: IppisRecord } | null,
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (!onboarding) {
      return { eligible: false, reason: 'Client has not completed onboarding' };
    }
    return this.topupEligibilityService.check(client, onboarding.ippisRecord, 0);
  }

  private async buildAppSummary(clientLoan: ClientLoan): Promise<LoanSummary> {
    const principal = Number(clientLoan.principalAmount);
    const balance = Number(clientLoan.principalBalance);
    const monthlyRepayment = computeExpectedInstallment(
      principal,
      Number(clientLoan.interestRatePercent),
      clientLoan.disbursementDate,
      clientLoan.maturationDate,
    );

    let nextPaymentDate: string | null = null;
    if (clientLoan.status !== 'CLOSED') {
      const latestVariance = await this.prisma.clientLoanRepaymentVariance.findFirst({
        where: { clientLoanId: clientLoan.id },
        orderBy: { period: 'desc' },
      });
      nextPaymentDate = nextPeriodDate(
        latestVariance?.period ?? null,
        clientLoan.disbursementDate,
        clientLoan.maturationDate,
      );
    }

    return {
      hasLoan: true,
      source: 'APP',
      status: clientLoan.status,
      principal,
      balance,
      monthlyRepayment,
      nextPaymentDate,
    };
  }

  private async buildIngestedSummary(loan: {
    id: string;
    loanAmount: unknown;
    principalBalance: unknown;
    interestRatePercent: unknown;
    disbursementDate: Date;
    maturationDate: Date;
    status: 'ACTIVE' | 'DEFAULT' | 'CLOSED';
  }): Promise<LoanSummary> {
    const principal = Number(loan.loanAmount);
    const balance = Number(loan.principalBalance);
    const monthlyRepayment = computeExpectedInstallment(
      principal,
      Number(loan.interestRatePercent),
      loan.disbursementDate,
      loan.maturationDate,
    );

    let nextPaymentDate: string | null = null;
    if (loan.status !== 'CLOSED') {
      const latestVariance = await this.prisma.repaymentVariance.findFirst({
        where: { loanId: loan.id },
        orderBy: { period: 'desc' },
      });
      nextPaymentDate = nextPeriodDate(latestVariance?.period ?? null, loan.disbursementDate, loan.maturationDate);
    }

    return {
      hasLoan: true,
      source: 'INGESTED',
      status: loan.status,
      principal,
      balance,
      monthlyRepayment,
      nextPaymentDate,
    };
  }
}
```

Two small additions this relies on:

**1. `ClientLoansService.getLatestMatchedLoan(clientId)`** — a new public
method that just exposes the top result of the existing private
`getMatchedLoansWithStatus` (already ordered by `disbursementDate: 'desc'`),
zero new query logic:
```typescript
async getLatestMatchedLoan(clientId: string) {
  const matched = await this.getMatchedLoansWithStatus(clientId);
  return matched && matched.loans.length > 0 ? matched.loans[0] : null;
}
```

**2. `nextPeriodDate` in `src/reconciliation/period.util.ts`** — a new small
helper (alongside the existing `toPeriodKey`/`generatePeriodRange`):
```typescript
export function nextPeriodDate(latestPeriod: string | null, disbursementDate: Date, maturationDate: Date): string | null {
  const next = latestPeriod
    ? addMonthsToPeriod(latestPeriod, 1)
    : new Date(disbursementDate.getFullYear(), disbursementDate.getMonth(), 1);
  if (next > maturationDate) {
    return null;
  }
  return next.toISOString().slice(0, 10);
}

function addMonthsToPeriod(period: string, months: number): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(year, month - 1 + months, 1);
}
```

Everything else (`computeExpectedInstallment`, `LoanRequestService.getMyLoan`,
`ClientLoansService.getRepaymentPlan`, `TopupEligibilityService`) is existing,
unmodified code — this feature is pure orchestration on top of it.

### Wiring into the four endpoints

**`AgentClientsService.listMyClients`** (`src/agent-clients/agent-clients.service.ts`):
inject `ClientLoanSummaryService`; in `narrowClient`, alongside the existing
`Promise.all` for selfie URLs, add `this.clientLoanSummaryService.getSummary(client.id)`
and `this.clientLoanSummaryService.getTopupEligibility(client, client.onboarding)`,
spreading `loanSummary`/`topupEligibility` onto the returned object.

**New `GET agent/clients/:clientId`** — add to the existing
`AgentClientsController`/`AgentClientsService` (same controller the list
route already lives in, so the new route sits right alongside it):
```typescript
// AgentClientsController
@Get(':clientId')
getOne(@Param('clientId') clientId: string, @Req() req: { user: JwtPayload }) {
  return this.agentClientsService.getOneForAgent(req.user.sub, clientId);
}
```
```typescript
// AgentClientsService
async getOneForAgent(agentId: string, clientId: string) {
  const client = await this.prisma.client.findFirst({
    where: { id: clientId, onboarding: { onboardedByAgentId: agentId } },
    include: {
      onboarding: {
        include: { ippisRecord: true, reviewedByAdmin: { select: { id: true, fullName: true, email: true } }, documents: true },
      },
    },
  });
  if (!client) {
    throw new NotFoundException('Client not found');
  }

  const narrowed = await this.narrowClient(client);
  const [loanSchedule, topupEligibility] = await Promise.all([
    this.clientLoanSummaryService.getSchedule(clientId),
    this.clientLoanSummaryService.getTopupEligibility(client, client.onboarding),
  ]);

  return { ...narrowed, topupEligibility, loanSchedule };
}
```
(Mirrors the exact ownership-check pattern already used by
`AgentLoanProductsController`/`AgentLoanRequestController` — `findFirst` +
`NotFoundException('Client not found')`. `documents` and length-of-service
are added to the include/response here, matching how admin's single-client
view is richer than its list.)

**`AdminClientReviewService.list` and `.findById`**
(`src/admin-client-review/admin-client-review.service.ts`): inject
`ClientLoanSummaryService`; add the same `loanSummary`/`topupEligibility`
spread to both methods' per-client mapping (both already map over a
`client.onboarding` shape, so this slots into the same `Promise.all` that
already resolves selfie URLs); `findById` additionally resolves and spreads
`loanSchedule`.

## Module wiring

- `LoanRequestModule`: add `LoanRequestService` to `exports`.
- `AgentClientsModule`: add `ClientLoanSummaryModule` to `imports`.
- `AdminClientReviewModule`: add `ClientLoanSummaryModule` to `imports`.

## Error handling / edge cases

- Client with no onboarding at all → `loanSummary` all nulls, `hasLoan: false`,
  `topupEligibility: { eligible: false, reason: 'Client has not completed onboarding' }`.
- Client onboarded but never had any loan (no `ClientLoan`, no matched
  ingested `Loan`) → same no-loan shape, but `topupEligibility` reflects the
  real rule chain (likely ineligible: "Client has no existing loan to renew",
  since top-up is renewal-only in this system's current policy).
- Client with a `CLOSED` app loan (fully repaid) → `hasLoan: true`,
  `status: 'CLOSED'`, `nextPaymentDate: null`, and (assuming verified status
  and no in-progress request) `topupEligibility.eligible: true` — this is
  exactly the renewal path.
- Both an app-native `ClientLoan` and matched ingested `Loan` exist for the
  same client (a client who had a payroll-ingested loan and has since
  originated a new one through the app) → `ClientLoan` wins, per the existing
  precedence used elsewhere in this codebase.

## Testing

- `client-loan-summary.service.spec.ts` (new): `getSummary` for all four
  cases (app loan, ingested-only loan, no loan, both sources present → app
  wins); `nextPaymentDate` computation for a fresh loan (no variance rows
  yet) vs. a partially-reconciled one vs. a `CLOSED` one; `getSchedule`
  delegating correctly to each source; `getTopupEligibility`'s
  no-onboarding short-circuit.
- `period.util.spec.ts`: add cases for `nextPeriodDate` (first period when
  none reconciled yet, next-month rollover including a December→January
  year rollover, `null` once past `maturationDate`).
- `client-loans.service.spec.ts`: add a case for the new
  `getLatestMatchedLoan` method.
- `agent-clients.service.spec.ts`: existing `listMyClients` tests updated to
  expect `loanSummary`/`topupEligibility` on each row; new tests for
  `getOneForAgent` (ownership 404, success shape including `loanSchedule`).
- `admin-client-review.service.spec.ts`: existing `list`/`findById` tests
  updated the same way.
- e2e: extend one of the existing agent-clients/admin-client-review e2e
  suites with a case that originates and disburses a real loan for a client,
  then asserts the list and view responses both carry the correct
  `loanSummary`/`topupEligibility`, and the view additionally carries a
  non-null `loanSchedule`.

## Postman

Per this project's standing rule: update the existing `Agent > Clients`
list request's saved response example to include the new fields; add a new
`GET agent/clients/:clientId` request (success + ownership 404 examples) to
that same folder; update `Admin > Clients` list and `:id` detail requests'
saved examples the same way.
