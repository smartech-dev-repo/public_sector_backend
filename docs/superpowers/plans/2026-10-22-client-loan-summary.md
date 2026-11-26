# Client Loan Summary on Agent/Admin Client Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a loan summary (has a loan or not, status, principal, balance, monthly repayment, next payment date, top-up eligibility) to the agent client list, the admin client list, the admin client detail view, and a brand-new agent client detail view — plus the full payment schedule on the two detail views only.

**Architecture:** A new `ClientLoanSummaryService` (in its own new module, to avoid a circular import between `LoanRequestModule` and `ClientLoansModule`) unifies two loan data sources — app-native `ClientLoan` rows and historical ingested `Loan` rows — behind one `getSummary`/`getSchedule`/`getTopupEligibility` API, built almost entirely by reusing existing methods (`LoanRequestService.getMyLoan`, `ClientLoansService.getRepaymentPlan`, `TopupEligibilityService.check`, `computeExpectedInstallment`). `AgentClientsService` and `AdminClientReviewService` each call it per-row/per-client, the same way they already resolve selfie URLs.

**Tech Stack:** NestJS, Prisma 7.10.0 (custom client output at `src/generated/prisma/client`), Jest (unit + e2e via supertest), PostgreSQL (live shared UAT DB).

**Spec:** `docs/superpowers/specs/2026-10-22-client-loan-summary-design.md`

## Global Constraints

- "Outstanding" and "balance" are the same field (`balance` = outstanding principal balance) — there is no separate arrears concept in this schema.
- `nextPaymentDate` is month-granularity only (first of the next un-reconciled month) — this system never tracks an exact day-of-month due date.
- List endpoints (agent list, admin list) get `loanSummary` + `topupEligibility` only. The two detail/view endpoints (agent view — new — and admin view) additionally get `loanSchedule` (the full month-by-month array).
- `ClientLoan` (app-native) always takes precedence over a matched ingested `Loan` when both exist for the same client.
- An onboarding row, when it exists, always has its `ippisRecord` linked (the schema makes `ippisRecordId` required on `ClientOnboarding`) — so `getTopupEligibility` only needs to special-case a *missing* onboarding, never a missing `ippisRecord` on an existing one.
- A `private static`/private class member can never be referenced from a test file outside the class — every Prisma call-shape assertion in this plan's tests uses literal objects, matching this codebase's existing convention (seen in `loan-request.service.spec.ts`'s `LOAN_REQUEST_RELATIONS_INCLUDE` assertions).

---

### Task 1: `ClientLoanSummaryService` — the shared loan-summary engine

**Files:**
- Modify: `src/client-loans/client-loans.service.ts:92-102` (add `getLatestMatchedLoan`, right after `hasOutstandingMatchedLoan`)
- Modify: `src/client-loans/client-loans.service.spec.ts` (add a `describe('getLatestMatchedLoan', ...)` block)
- Modify: `src/reconciliation/period.util.ts` (add `nextPeriodDate`/`addMonthsToPeriod`)
- Modify: `src/reconciliation/period.util.spec.ts` (add tests, update the import line)
- Modify: `src/loan-request/loan-request.module.ts:55` (add `LoanRequestService` to `exports`)
- Create: `src/client-loan-summary/client-loan-summary.service.ts`
- Create: `src/client-loan-summary/client-loan-summary.service.spec.ts`
- Create: `src/client-loan-summary/client-loan-summary.module.ts`

**Interfaces:**
- Produces: `ClientLoansService.getLatestMatchedLoan(clientId: string)`; `nextPeriodDate(latestPeriod: string | null, disbursementDate: Date, maturationDate: Date): string | null` from `period.util.ts`; `LoanRequestModule` now also exports `LoanRequestService`; `ClientLoanSummaryModule` exporting `ClientLoanSummaryService` with `getSummary(clientId): Promise<LoanSummary>`, `getSchedule(clientId): Promise<ScheduleRow[] | null>`, `getTopupEligibility(client: Client, onboarding: {ippisRecord: IppisRecord} | null): Promise<{eligible: boolean; reason?: string}>` — consumed by Tasks 2 and 3.

This is the foundational task — nothing in Tasks 2/3 can compile until this lands.

**A note on verifying the spec rather than trusting it:** the design spec's `nextPaymentDate` used `next.toISOString().slice(0, 10)` to format the result. That's wrong for this codebase — every other date computation here (`toPeriodKey`, `generatePeriodRange`, `monthsBetween`) builds and reads dates via **local** `getFullYear()`/`getMonth()`/`getDate()`, never UTC. `toISOString()` converts to UTC first, which can shift the date backward by a day depending on the server's timezone offset (e.g. a local midnight in a positive-UTC-offset timezone becomes the previous day in UTC). This plan formats the result using local components instead, matching the existing convention exactly. Also independently verified: `getMatchedLoansWithStatus`'s `candidateLoans` query is already `orderBy: { disbursementDate: 'desc' }`, so `loans[0]` genuinely is the most recent matched loan — no new ordering logic needed.

- [ ] **Step 1: Write the failing test for `ClientLoansService.getLatestMatchedLoan`**

In `src/client-loans/client-loans.service.spec.ts`, add this new `describe` block right after the closing `});` of `describe('hasOutstandingMatchedLoan', ...)` (after line 297), before `describe('getRepaymentPlan', ...)` (line 299):
```typescript

  describe('getLatestMatchedLoan', () => {
    it('returns null when the client has no ClientOnboarding row', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      expect(await service.getLatestMatchedLoan('c1')).toBeNull();
    });

    it('returns null when the client has no ingested loans', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([]);
      expect(await service.getLatestMatchedLoan('c1')).toBeNull();
    });

    it('returns the most recent matched loan with its computed status', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);

      const result = await service.getLatestMatchedLoan('c1');

      expect(result).toEqual(expect.objectContaining({ id: 'loan-1', status: 'ACTIVE' }));
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: FAIL — `service.getLatestMatchedLoan is not a function`.

- [ ] **Step 3: Implement `getLatestMatchedLoan`**

In `src/client-loans/client-loans.service.ts`, insert this method right after `hasOutstandingMatchedLoan` ends (after line 101, before the `private async getMatchedLoansWithStatus` declaration on line 103):
```typescript

  // Unpaginated on purpose — same reasoning as hasActiveLoan above.
  async getLatestMatchedLoan(clientId: string) {
    const matched = await this.getMatchedLoansWithStatus(clientId);
    return matched && matched.loans.length > 0 ? matched.loans[0] : null;
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 5: Write the failing test for `nextPeriodDate`**

In `src/reconciliation/period.util.spec.ts`, change the import on line 1 from:
```typescript
import { toPeriodKey, generatePeriodRange } from './period.util';
```
to:
```typescript
import { toPeriodKey, generatePeriodRange, nextPeriodDate } from './period.util';
```
Then append this new `describe` block at the end of the file (after line 27's closing `});`):
```typescript

describe('nextPeriodDate', () => {
  it('returns the disbursement month when no period has been reconciled yet', () => {
    expect(nextPeriodDate(null, new Date(2026, 0, 15), new Date(2026, 5, 1))).toBe('2026-01-01');
  });

  it('returns the month after the latest reconciled period', () => {
    expect(nextPeriodDate('2026-03', new Date(2026, 0, 1), new Date(2026, 11, 1))).toBe('2026-04-01');
  });

  it('rolls over a December period into January of the next year', () => {
    expect(nextPeriodDate('2025-12', new Date(2025, 0, 1), new Date(2026, 11, 1))).toBe('2026-01-01');
  });

  it('returns null once the next period would fall after maturation', () => {
    expect(nextPeriodDate('2026-05', new Date(2026, 0, 1), new Date(2026, 4, 1))).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx jest src/reconciliation/period.util.spec.ts`
Expected: FAIL — `nextPeriodDate is not exported` / not a function.

- [ ] **Step 7: Implement `nextPeriodDate`**

Append to `src/reconciliation/period.util.ts` (after line 16's closing `}`):
```typescript

export function nextPeriodDate(latestPeriod: string | null, disbursementDate: Date, maturationDate: Date): string | null {
  const next = latestPeriod
    ? addMonthsToPeriod(latestPeriod, 1)
    : new Date(disbursementDate.getFullYear(), disbursementDate.getMonth(), 1);
  if (next > maturationDate) {
    return null;
  }
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

function addMonthsToPeriod(period: string, months: number): Date {
  const [year, month] = period.split('-').map(Number);
  return new Date(year, month - 1 + months, 1);
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx jest src/reconciliation/period.util.spec.ts`
Expected: PASS (all 8 tests — 3 existing + 4 new, plus the 1 existing `toPeriodKey` test).

- [ ] **Step 9: Export `LoanRequestService` from `LoanRequestModule`**

In `src/loan-request/loan-request.module.ts`, change line 55 from:
```typescript
  exports: [EligibilityService, TopupEligibilityService],
```
to:
```typescript
  exports: [EligibilityService, TopupEligibilityService, LoanRequestService],
```

- [ ] **Step 10: Write the failing test for `ClientLoanSummaryService`**

Create `src/client-loan-summary/client-loan-summary.service.spec.ts`:
```typescript
import { Client, IppisRecord } from '../generated/prisma/client';
import { ClientLoanSummaryService } from './client-loan-summary.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestService } from '../loan-request/loan-request.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';

describe('ClientLoanSummaryService', () => {
  let service: ClientLoanSummaryService;
  let prisma: {
    clientLoan: { findFirst: jest.Mock };
    clientLoanRepaymentVariance: { findFirst: jest.Mock };
    repaymentVariance: { findFirst: jest.Mock };
  };
  let loanRequestService: { getMyLoan: jest.Mock };
  let clientLoansService: { getLatestMatchedLoan: jest.Mock; getRepaymentPlan: jest.Mock };
  let topupEligibilityService: { check: jest.Mock };

  beforeEach(() => {
    prisma = {
      clientLoan: { findFirst: jest.fn() },
      clientLoanRepaymentVariance: { findFirst: jest.fn() },
      repaymentVariance: { findFirst: jest.fn() },
    };
    loanRequestService = { getMyLoan: jest.fn() };
    clientLoansService = { getLatestMatchedLoan: jest.fn(), getRepaymentPlan: jest.fn() };
    topupEligibilityService = { check: jest.fn() };

    service = new ClientLoanSummaryService(
      prisma as unknown as PrismaService,
      loanRequestService as unknown as LoanRequestService,
      clientLoansService as unknown as ClientLoansService,
      topupEligibilityService as unknown as TopupEligibilityService,
    );
  });

  describe('getSummary', () => {
    it('returns the no-loan shape when the client has neither an app-native nor an ingested loan', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue(null);

      const result = await service.getSummary('c1');

      expect(result).toEqual({
        hasLoan: false,
        source: null,
        status: null,
        principal: null,
        balance: null,
        monthlyRepayment: null,
        nextPaymentDate: null,
      });
    });

    it('prefers the app-native ClientLoan when both sources exist', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 5, 1),
        status: 'ACTIVE',
      });
      prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue(null);

      const result = await service.getSummary('c1');

      expect(clientLoansService.getLatestMatchedLoan).not.toHaveBeenCalled();
      expect(result).toEqual({
        hasLoan: true,
        source: 'APP',
        status: 'ACTIVE',
        principal: 90000,
        balance: 60000,
        monthlyRepayment: 18000,
        nextPaymentDate: '2026-01-01',
      });
    });

    it('falls back to the latest matched ingested loan when there is no ClientLoan row', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue({
        id: 'loan-1',
        loanAmount: 100000,
        principalBalance: 50000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 4, 1),
        status: 'ACTIVE',
      });
      prisma.repaymentVariance.findFirst.mockResolvedValue(null);

      const result = await service.getSummary('c1');

      expect(result).toEqual({
        hasLoan: true,
        source: 'INGESTED',
        status: 'ACTIVE',
        principal: 100000,
        balance: 50000,
        monthlyRepayment: 25000,
        nextPaymentDate: '2026-01-01',
      });
    });

    it('treats "outstanding" and "balance" as the same field (principalBalance)', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 30000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 5, 1),
        status: 'ACTIVE',
      });
      prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue(null);

      const result = await service.getSummary('c1');

      expect(result.balance).toBe(30000);
    });

    it('does not query for a next payment date once the app loan is CLOSED', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 0,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 5, 1),
        status: 'CLOSED',
      });

      const result = await service.getSummary('c1');

      expect(prisma.clientLoanRepaymentVariance.findFirst).not.toHaveBeenCalled();
      expect(result.nextPaymentDate).toBeNull();
    });

    it('advances nextPaymentDate past an already-reconciled period', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 5, 1),
        status: 'ACTIVE',
      });
      prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ period: '2026-02' });

      const result = await service.getSummary('c1');

      expect(prisma.clientLoanRepaymentVariance.findFirst).toHaveBeenCalledWith({
        where: { clientLoanId: 'cl1' },
        orderBy: { period: 'desc' },
      });
      expect(result.nextPaymentDate).toBe('2026-03-01');
    });
  });

  describe('getSchedule', () => {
    it('delegates to LoanRequestService.getMyLoan for an app-native loan', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });
      loanRequestService.getMyLoan.mockResolvedValue({ id: 'cl1', schedule: [{ period: '2026-01' }] });

      const result = await service.getSchedule('c1');

      expect(loanRequestService.getMyLoan).toHaveBeenCalledWith('c1');
      expect(result).toEqual([{ period: '2026-01' }]);
    });

    it('delegates to ClientLoansService.getRepaymentPlan for an ingested-only loan', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue({ id: 'loan-1' });
      clientLoansService.getRepaymentPlan.mockResolvedValue({ loanId: 'loan-1', schedule: [{ period: '2026-02' }] });

      const result = await service.getSchedule('c1');

      expect(clientLoansService.getRepaymentPlan).toHaveBeenCalledWith('c1', 'loan-1');
      expect(result).toEqual([{ period: '2026-02' }]);
    });

    it('returns null when the client has no loan at all', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.getLatestMatchedLoan.mockResolvedValue(null);

      expect(await service.getSchedule('c1')).toBeNull();
    });
  });

  describe('getTopupEligibility', () => {
    it('short-circuits to ineligible when the client has no onboarding record', async () => {
      const result = await service.getTopupEligibility({ id: 'c1' } as unknown as Client, null);

      expect(topupEligibilityService.check).not.toHaveBeenCalled();
      expect(result).toEqual({ eligible: false, reason: 'Client has not completed onboarding' });
    });

    it('delegates to TopupEligibilityService when onboarding exists', async () => {
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      const client = { id: 'c1' } as unknown as Client;
      const onboarding = { ippisRecord: { agency: 'NPF', staffId: 'S1' } as IppisRecord };

      const result = await service.getTopupEligibility(client, onboarding);

      expect(topupEligibilityService.check).toHaveBeenCalledWith(client, onboarding.ippisRecord, 0);
      expect(result).toEqual({ eligible: true });
    });
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `npx jest src/client-loan-summary/client-loan-summary.service.spec.ts`
Expected: FAIL — `Cannot find module './client-loan-summary.service'`.

- [ ] **Step 12: Implement `ClientLoanSummaryService`**

Create `src/client-loan-summary/client-loan-summary.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestService } from '../loan-request/loan-request.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';
import { computeExpectedInstallment } from '../reconciliation/amortization.util';
import { nextPeriodDate } from '../reconciliation/period.util';
import { Client, ClientLoan, IppisRecord } from '../generated/prisma/client';

type MatchedLoan = NonNullable<Awaited<ReturnType<ClientLoansService['getLatestMatchedLoan']>>>;

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

  private async buildIngestedSummary(loan: MatchedLoan): Promise<LoanSummary> {
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

- [ ] **Step 13: Run it to verify it passes**

Run: `npx jest src/client-loan-summary/client-loan-summary.service.spec.ts`
Expected: PASS (all 12 tests).

- [ ] **Step 14: Create the module**

Create `src/client-loan-summary/client-loan-summary.module.ts`:
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

- [ ] **Step 15: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 16: Commit**

```bash
git add src/client-loans/client-loans.service.ts src/client-loans/client-loans.service.spec.ts src/reconciliation/period.util.ts src/reconciliation/period.util.spec.ts src/loan-request/loan-request.module.ts src/client-loan-summary/client-loan-summary.service.ts src/client-loan-summary/client-loan-summary.service.spec.ts src/client-loan-summary/client-loan-summary.module.ts
git commit -m "feat(client-loan-summary): add shared loan-summary/schedule/eligibility service"
```

---

### Task 2: Agent client list + new agent client view endpoint

**Files:**
- Modify: `src/agent-clients/agent-clients.service.ts` (full current file is 98 lines)
- Modify: `src/agent-clients/agent-clients.service.spec.ts`
- Modify: `src/agent-clients/agent-clients.controller.ts`
- Modify: `src/agent-clients/agent-clients.module.ts`

**Interfaces:**
- Consumes: `ClientLoanSummaryService.getSummary/getSchedule/getTopupEligibility` from Task 1.
- Produces: `AgentClientsService.getOneForAgent(agentId, clientId)`, consumed by the new `GET agent/clients/:clientId` route in this same task (no other task depends on this).

This task is file-disjoint from Task 3 and can run in parallel with it, once Task 1 has landed.

- [ ] **Step 1: Write the failing tests**

In `src/agent-clients/agent-clients.service.spec.ts`, add `NotFoundException` and `ClientLoanSummaryService` to the imports (after line 3):
```typescript
import { NotFoundException } from '@nestjs/common';
import { ClientLoanSummaryService } from '../client-loan-summary/client-loan-summary.service';
```

Replace lines 6-14 (the `service`/`prisma`/`fileStorageProvider` declarations and the `beforeEach` block) with:
```typescript
  let service: AgentClientsService;
  let prisma: { client: { findMany: jest.Mock; count: jest.Mock; findFirst: jest.Mock } };
  let fileStorageProvider: { getSignedDownloadUrl: jest.Mock };
  let clientLoanSummaryService: { getSummary: jest.Mock; getSchedule: jest.Mock; getTopupEligibility: jest.Mock };

  beforeEach(() => {
    prisma = { client: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() } };
    fileStorageProvider = { getSignedDownloadUrl: jest.fn((key: string) => Promise.resolve(`https://storage.example.com/${key}`)) };
    clientLoanSummaryService = {
      getSummary: jest.fn().mockResolvedValue({
        hasLoan: false,
        source: null,
        status: null,
        principal: null,
        balance: null,
        monthlyRepayment: null,
        nextPaymentDate: null,
      }),
      getSchedule: jest.fn().mockResolvedValue(null),
      getTopupEligibility: jest.fn().mockResolvedValue({ eligible: false, reason: 'Client has not completed onboarding' }),
    };
    service = new AgentClientsService(
      prisma as unknown as PrismaService,
      fileStorageProvider as unknown as FileStorageProvider,
      clientLoanSummaryService as unknown as ClientLoanSummaryService,
    );
  });
```

Add this new test to the end of `describe('listMyClients', ...)`, right before its closing `});` (after line 116, before line 117):
```typescript

    it('attaches loanSummary and topupEligibility to each row', async () => {
      prisma.client.findMany.mockResolvedValue([{ id: 'c1', onboarding: null }]);
      prisma.client.count.mockResolvedValue(1);
      clientLoanSummaryService.getSummary.mockResolvedValue({
        hasLoan: true,
        source: 'APP',
        status: 'ACTIVE',
        principal: 90000,
        balance: 60000,
        monthlyRepayment: 18000,
        nextPaymentDate: '2026-01-01',
      });
      clientLoanSummaryService.getTopupEligibility.mockResolvedValue({
        eligible: false,
        reason: 'Existing loan still has an outstanding balance',
      });

      const result = await service.listMyClients('agent-1');

      expect(clientLoanSummaryService.getSummary).toHaveBeenCalledWith('c1');
      expect(result.data[0].loanSummary.hasLoan).toBe(true);
      expect(result.data[0].topupEligibility).toEqual({
        eligible: false,
        reason: 'Existing loan still has an outstanding balance',
      });
    });
```

Add this new `describe` block right before the final closing `});` of the file (after line 117, before line 118):
```typescript

  describe('getOneForAgent', () => {
    it('throws NotFoundException when the client is not onboarded by this agent', async () => {
      prisma.client.findFirst.mockResolvedValue(null);
      await expect(service.getOneForAgent('agent-1', 'client-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the client detail with loanSummary, topupEligibility, and loanSchedule', async () => {
      prisma.client.findFirst.mockResolvedValue({ id: 'client-1', onboarding: null });
      clientLoanSummaryService.getSchedule.mockResolvedValue([{ period: '2026-01' }]);

      const result = await service.getOneForAgent('agent-1', 'client-1');

      expect(prisma.client.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'client-1', onboarding: { onboardedByAgentId: 'agent-1' } } }),
      );
      expect(result.id).toBe('client-1');
      expect(result.loanSchedule).toEqual([{ period: '2026-01' }]);
      expect(result.loanSummary.hasLoan).toBe(false);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/agent-clients/agent-clients.service.spec.ts`
Expected: FAIL — constructor arity mismatch / `service.getOneForAgent is not a function`.

- [ ] **Step 3: Implement the service changes**

In `src/agent-clients/agent-clients.service.ts`, replace the import block (lines 1-6):
```typescript
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Client, ClientStatus, IppisRecord, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { narrowIppisRecord } from '../client-onboarding/narrow-ippis-record.util';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ClientLoanSummaryService } from '../client-loan-summary/client-loan-summary.service';
```

Replace the constructor (lines 17-20):
```typescript
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    private readonly clientLoanSummaryService: ClientLoanSummaryService,
  ) {}
```

Replace `narrowClient` in full (lines 64-97):
```typescript
  private async narrowClient<
    T extends {
      id: string;
      onboarding:
        | ({
            bvnSelfie: string | null;
            ninSelfie: string | null;
            liveSelfieKey: string | null;
            ippisRecord: Parameters<typeof narrowIppisRecord>[0];
          } & Record<string, unknown>)
        | null;
    },
  >(client: T) {
    const [loanSummary, topupEligibility] = await Promise.all([
      this.clientLoanSummaryService.getSummary(client.id),
      this.clientLoanSummaryService.getTopupEligibility(
        client as unknown as Client,
        client.onboarding as { ippisRecord: IppisRecord } | null,
      ),
    ]);

    if (!client.onboarding) {
      return { ...client, onboarding: null, loanSummary, topupEligibility };
    }

    const { bvnSelfie, ninSelfie, liveSelfieKey, ippisRecord, ...restOnboarding } = client.onboarding;
    const [bvnSelfieUrl, ninSelfieUrl, liveSelfieUrl] = await Promise.all([
      bvnSelfie ? this.fileStorageProvider.getSignedDownloadUrl(bvnSelfie) : null,
      ninSelfie ? this.fileStorageProvider.getSignedDownloadUrl(ninSelfie) : null,
      liveSelfieKey ? this.fileStorageProvider.getSignedDownloadUrl(liveSelfieKey) : null,
    ]);

    return {
      ...client,
      onboarding: {
        ...restOnboarding,
        ippisRecord: narrowIppisRecord(ippisRecord),
        bvnSelfieUrl,
        ninSelfieUrl,
        liveSelfieUrl,
      },
      loanSummary,
      topupEligibility,
    };
  }

  async getOneForAgent(agentId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, onboarding: { onboardedByAgentId: agentId } },
      include: {
        onboarding: {
          include: {
            ippisRecord: true,
            reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
            documents: true,
          },
        },
      },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const narrowed = await this.narrowClient(client);
    const loanSchedule = await this.clientLoanSummaryService.getSchedule(clientId);

    return { ...narrowed, loanSchedule };
  }
```
(Everything else in the file — `ListMyClientsFilters`, `listMyClients` itself — is unchanged; `narrowClient` is still called the same way from `listMyClients`'s `Promise.all(data.map((client) => this.narrowClient(client)))`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/agent-clients/agent-clients.service.spec.ts`
Expected: PASS (all tests, including the 3 new ones).

- [ ] **Step 5: Add the new controller route**

In `src/agent-clients/agent-clients.controller.ts`, change the import on line 1 from:
```typescript
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
```
to:
```typescript
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
```
Then add this route right after the existing `list` method (after line 25, before the closing `}` on line 26):
```typescript

  @Get(':clientId')
  getOne(@Param('clientId') clientId: string, @Req() req: { user: JwtPayload }) {
    return this.agentClientsService.getOneForAgent(req.user.sub, clientId);
  }
```

- [ ] **Step 6: Wire the module**

In `src/agent-clients/agent-clients.module.ts`, add the import (after line 1):
```typescript
import { ClientLoanSummaryModule } from '../client-loan-summary/client-loan-summary.module';
```
Change `imports: [FileStorageModule]` to:
```typescript
  imports: [FileStorageModule, ClientLoanSummaryModule],
```

- [ ] **Step 7: Typecheck and run the full agent-clients suite**

Run:
```bash
npx jest src/agent-clients
npx tsc --noEmit
```
Expected: all PASS, no new type errors.

- [ ] **Step 8: Commit**

```bash
git add src/agent-clients/agent-clients.service.ts src/agent-clients/agent-clients.service.spec.ts src/agent-clients/agent-clients.controller.ts src/agent-clients/agent-clients.module.ts
git commit -m "feat(agent-clients): add loan summary to the client list and a new client detail endpoint"
```

---

### Task 3: Admin client list + detail

**Files:**
- Modify: `src/admin-client-review/admin-client-review.service.ts` (full current file is 240 lines)
- Modify: `src/admin-client-review/admin-client-review.service.spec.ts`
- Modify: `src/admin-client-review/admin-client-review.module.ts`

**Interfaces:**
- Consumes: `ClientLoanSummaryService.getSummary/getSchedule/getTopupEligibility` from Task 1.

This task is file-disjoint from Task 2 and can run in parallel with it, once Task 1 has landed. No controller changes are needed here — both `GET admin/clients` and `GET admin/clients/:id` already exist and already call `list()`/`findById()`.

- [ ] **Step 1: Write the failing tests**

In `src/admin-client-review/admin-client-review.service.spec.ts`, add `ClientLoanSummaryService` to the imports (after line 5):
```typescript
import { ClientLoanSummaryService } from '../client-loan-summary/client-loan-summary.service';
```

Replace the `prisma`/`clientOnboardingService`/`fileStorageProvider` declarations and `beforeEach` (lines 9-28):
```typescript
  let prisma: {
    client: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    clientOnboarding: { update: jest.Mock };
  };
  let clientOnboardingService: { determineStepAfterIdentity: jest.Mock };
  let fileStorageProvider: { getSignedDownloadUrl: jest.Mock };
  let clientLoanSummaryService: { getSummary: jest.Mock; getSchedule: jest.Mock; getTopupEligibility: jest.Mock };

  beforeEach(() => {
    prisma = {
      client: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      clientOnboarding: { update: jest.fn() },
    };
    clientOnboardingService = { determineStepAfterIdentity: jest.fn() };
    fileStorageProvider = { getSignedDownloadUrl: jest.fn() };
    clientLoanSummaryService = {
      getSummary: jest.fn().mockResolvedValue({
        hasLoan: false,
        source: null,
        status: null,
        principal: null,
        balance: null,
        monthlyRepayment: null,
        nextPaymentDate: null,
      }),
      getSchedule: jest.fn().mockResolvedValue(null),
      getTopupEligibility: jest.fn().mockResolvedValue({ eligible: false, reason: 'Client has not completed onboarding' }),
    };
    service = new AdminClientReviewService(
      prisma as unknown as PrismaService,
      clientOnboardingService as unknown as ClientOnboardingService,
      fileStorageProvider as unknown as FileStorageProvider,
      clientLoanSummaryService as unknown as ClientLoanSummaryService,
    );
  });
```

Add this new test to the end of `describe('list', ...)`, right before its closing `});` (after line 225, before line 226):
```typescript

    it('attaches loanSummary and topupEligibility to each row', async () => {
      prisma.client.findMany.mockResolvedValue([{ id: 'c1', onboarding: null }]);
      prisma.client.count.mockResolvedValue(1);
      clientLoanSummaryService.getSummary.mockResolvedValue({
        hasLoan: true,
        source: 'INGESTED',
        status: 'DEFAULT',
        principal: 50000,
        balance: 20000,
        monthlyRepayment: 10000,
        nextPaymentDate: null,
      });
      clientLoanSummaryService.getTopupEligibility.mockResolvedValue({ eligible: true });

      const result = await service.list();

      expect(clientLoanSummaryService.getSummary).toHaveBeenCalledWith('c1');
      expect(result.data[0].loanSummary.status).toBe('DEFAULT');
      expect(result.data[0].topupEligibility).toEqual({ eligible: true });
    });
```

Add this new test to the end of `describe('findById', ...)`, right before its closing `});` (after line 399, before line 400 — note the existing block already ends with the `'does not attempt to resolve selfie URLs that are not set'` test):
```typescript

    it('attaches loanSummary, topupEligibility, and loanSchedule', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'VERIFIED', onboarding: null });
      clientLoanSummaryService.getSchedule.mockResolvedValue([{ period: '2026-01' }]);
      clientLoanSummaryService.getTopupEligibility.mockResolvedValue({
        eligible: false,
        reason: 'Client has no existing loan to renew',
      });

      const result = await service.findById('c1');

      expect(clientLoanSummaryService.getSummary).toHaveBeenCalledWith('c1');
      expect(result.topupEligibility).toEqual({ eligible: false, reason: 'Client has no existing loan to renew' });
      expect(result.loanSchedule).toEqual([{ period: '2026-01' }]);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: FAIL — constructor arity mismatch / `result.data[0].loanSummary` is undefined.

- [ ] **Step 3: Implement the service changes**

In `src/admin-client-review/admin-client-review.service.ts`, add the import (after line 9):
```typescript
import { ClientLoanSummaryService } from '../client-loan-summary/client-loan-summary.service';
```

Replace the constructor (lines 27-31):
```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientOnboardingService: ClientOnboardingService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    private readonly clientLoanSummaryService: ClientLoanSummaryService,
  ) {}
```

Replace the `list()` method's `return buildPaginatedResult(...)` block (lines 69-87):
```typescript
    return buildPaginatedResult(
      await Promise.all(
        data.map(async (client) => {
          const [loanSummary, topupEligibility] = await Promise.all([
            this.clientLoanSummaryService.getSummary(client.id),
            this.clientLoanSummaryService.getTopupEligibility(client, client.onboarding),
          ]);

          if (!client.onboarding) {
            return {
              ...client,
              onboardingSource: deriveOnboardingSource(client.onboarding),
              onboarding: null,
              loanSummary,
              topupEligibility,
            };
          }
          const { bvnSelfie, ninSelfie, liveSelfieKey, ippisRecord, ...restOnboarding } = client.onboarding;
          const selfieUrls = await this.resolveSelfieUrls({ bvnSelfie, ninSelfie, liveSelfieKey });
          return {
            ...client,
            onboardingSource: deriveOnboardingSource(client.onboarding),
            onboarding: { ...restOnboarding, ippisRecord: narrowIppisRecord(ippisRecord), ...selfieUrls },
            loanSummary,
            topupEligibility,
          };
        }),
      ),
      total,
      page,
      limit,
    );
```

Replace the body of `findById()` from the `if (!client) {...}` check onward (lines 136-168):
```typescript
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const [loanSummary, topupEligibility, loanSchedule] = await Promise.all([
      this.clientLoanSummaryService.getSummary(id),
      this.clientLoanSummaryService.getTopupEligibility(client, client.onboarding),
      this.clientLoanSummaryService.getSchedule(id),
    ]);

    if (client.onboarding) {
      const documents = await Promise.all(
        (client.onboarding.documents ?? []).map(async (document) => ({
          documentType: document.documentType,
          url: await this.fileStorageProvider.getSignedDownloadUrl(document.storageKey),
          uploadedAt: document.uploadedAt,
        })),
      );
      const lengthOfService = computeLengthOfService(client.onboarding.ippisRecord?.hireDate ?? null);
      const { bvnSelfie, ninSelfie, liveSelfieKey, ippisRecord: rawIppisRecord, ...restOnboarding } = client.onboarding;
      const ippisRecord = narrowIppisRecord(rawIppisRecord);
      const selfieUrls = await this.resolveSelfieUrls({ bvnSelfie, ninSelfie, liveSelfieKey });

      return {
        ...client,
        onboardingSource: deriveOnboardingSource(client.onboarding),
        onboarding: {
          ...restOnboarding,
          documents,
          lengthOfService,
          ippisRecord,
          ...selfieUrls,
        },
        loanSummary,
        topupEligibility,
        loanSchedule,
      };
    }

    return {
      ...client,
      onboardingSource: deriveOnboardingSource(client.onboarding),
      onboarding: null,
      loanSummary,
      topupEligibility,
      loanSchedule,
    };
  }
```
(The method's opening — the `const client = await this.prisma.client.findUnique({...})` call and its `include` — is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS (all tests, including the 2 new ones).

- [ ] **Step 5: Wire the module**

In `src/admin-client-review/admin-client-review.module.ts`, add the import (after line 8):
```typescript
import { ClientLoanSummaryModule } from '../client-loan-summary/client-loan-summary.module';
```
Change `imports: [AuditModule, ClientOnboardingModule, FileStorageModule]` to:
```typescript
  imports: [AuditModule, ClientOnboardingModule, FileStorageModule, ClientLoanSummaryModule],
```

- [ ] **Step 6: Typecheck and run the full admin-client-review suite**

Run:
```bash
npx jest src/admin-client-review
npx tsc --noEmit
```
Expected: all PASS, no new type errors.

- [ ] **Step 7: Commit**

```bash
git add src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts src/admin-client-review/admin-client-review.module.ts
git commit -m "feat(admin-client-review): add loan summary and schedule to the client list and detail views"
```

---

### Task 4: e2e coverage

**Files:**
- Modify: `test/agent-clients.e2e-spec.ts`
- Modify: `test/admin-client-review.e2e-spec.ts`

This task is file-disjoint from Task 5 and can run in parallel with it, once Tasks 2 and 3 have landed. Neither existing e2e fixture file disburses a real loan for its client, so these additions verify the full HTTP-to-database wiring produces the correct "no loan" shape — the loan-bearing cases (app loan, ingested loan, both sources, CLOSED status, reconciled periods) are already covered thoroughly at the unit level in Task 1.

- [ ] **Step 1: Extend the agent-clients list assertion**

In `test/agent-clients.e2e-spec.ts`, add these lines right after the existing `expect(rowA.onboarding).not.toHaveProperty('liveSelfieKey');` assertion (after line 110, before the closing `}, 20000);` on line 111):
```typescript

    expect(rowA.loanSummary).toEqual({
      hasLoan: false,
      source: null,
      status: null,
      principal: null,
      balance: null,
      monthlyRepayment: null,
      nextPaymentDate: null,
    });
    expect(rowA.topupEligibility.eligible).toBe(false);
```

- [ ] **Step 2: Add the new agent client-view e2e test**

Add this new `it(...)` block right after the existing one, before the closing `});` of `describe('Agent own-clients list (e2e)', ...)` (after line 111, before line 112):
```typescript

  it(
    'GET /agent/clients/:clientId returns the client detail with loanSummary/topupEligibility/loanSchedule, and 404s for a client this agent does not own',
    async () => {
      const agentA = await prisma.agent.create({
        data: {
          email: `agent-view-a-${Date.now()}@example.com`,
          phone: '+2348012340004',
          fullName: 'Agent View A',
          address: '1 St',
          status: 'APPROVED',
          cvKey: 'agents/e2e/view-a.pdf',
          canOnboardClients: true,
        },
      });
      createdAgentIds.push(agentA.id);
      const agentB = await prisma.agent.create({
        data: {
          email: `agent-view-b-${Date.now()}@example.com`,
          phone: '+2348012340005',
          fullName: 'Agent View B',
          address: '1 St',
          status: 'APPROVED',
          cvKey: 'agents/e2e/view-b.pdf',
          canOnboardClients: true,
        },
      });
      createdAgentIds.push(agentB.id);
      const agentAToken = tokenService.signAccessToken({ sub: agentA.id, type: 'agent', canOnboardClients: true });
      const agentBToken = tokenService.signAccessToken({ sub: agentB.id, type: 'agent', canOnboardClients: true });

      const staffIdView = `E2E-MYCLIENTS-VIEW-${Date.now()}`;
      createdStaffIds.push(staffIdView);
      await prisma.ippisRecord.create({
        data: {
          agency: 'NPF',
          staffId: staffIdView,
          employeeName: 'Client View Test',
          phone: `+234814${Date.now().toString().slice(-7)}`,
        },
      });

      const createRes = await request(app.getHttpServer())
        .post('/agent/clients/onboarding/ippis-lookup')
        .set('Authorization', `Bearer ${agentAToken}`)
        .send({ ippisNumber: staffIdView })
        .expect(201);
      const clientId = createRes.body.clientId;
      createdClientIds.push(clientId);

      const viewRes = await request(app.getHttpServer())
        .get(`/agent/clients/${clientId}`)
        .set('Authorization', `Bearer ${agentAToken}`)
        .expect(200);
      expect(viewRes.body.id).toBe(clientId);
      expect(viewRes.body.loanSummary.hasLoan).toBe(false);
      expect(viewRes.body).toHaveProperty('topupEligibility');
      expect(viewRes.body).toHaveProperty('loanSchedule', null);

      await request(app.getHttpServer())
        .get(`/agent/clients/${clientId}`)
        .set('Authorization', `Bearer ${agentBToken}`)
        .expect(404);
    },
    20000,
  );
```

- [ ] **Step 3: Extend the admin-client-review list and detail assertions**

In `test/admin-client-review.e2e-spec.ts`, add these lines right after `expect(row.onboarding).not.toHaveProperty('liveSelfieKey');` in the `'lists clients filtered by MANUAL_REVIEW status'` test (after line 124, before the closing `});` on line 125):
```typescript

    expect(row.loanSummary).toEqual({
      hasLoan: false,
      source: null,
      status: null,
      principal: null,
      balance: null,
      monthlyRepayment: null,
      nextPaymentDate: null,
    });
    expect(row.topupEligibility.eligible).toBe(false);
```

Add these lines right after `expect(res.body.onboarding).not.toHaveProperty('liveSelfieKey');` in the `'gets the full client detail including onboarding'` test (after line 141, before the closing `});` on line 142):
```typescript

    expect(res.body.loanSummary.hasLoan).toBe(false);
    expect(res.body).toHaveProperty('topupEligibility');
    expect(res.body).toHaveProperty('loanSchedule', null);
```

- [ ] **Step 4: Run both e2e files**

Run:
```bash
npx jest --config ./test/jest-e2e.json test/agent-clients.e2e-spec.ts test/admin-client-review.e2e-spec.ts
```
Expected: PASS.

- [ ] **Step 5: Run the full e2e suite once to check for cross-suite regressions**

Run: `npx jest --config ./test/jest-e2e.json`
Expected: PASS (isolated re-runs of any transient DB-contention failures should pass alone, per this project's established flakiness baseline).

- [ ] **Step 6: Commit**

```bash
git add test/agent-clients.e2e-spec.ts test/admin-client-review.e2e-spec.ts
git commit -m "test(e2e): cover loan summary on agent/admin client list and detail endpoints"
```

---

### Task 5: Postman sync

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

This task is file-disjoint from Task 4 and can run in parallel with it, once Tasks 2 and 3 have landed.

- [ ] **Step 1: Update the `Agent > Clients` list request's saved response example**

Find the existing `GET /agent/clients` request's saved response example(s) in the collection and add `loanSummary`/`topupEligibility` fields to each client row in the saved JSON body, matching the "no loan" shape:
```json
"loanSummary": {
  "hasLoan": false,
  "source": null,
  "status": null,
  "principal": null,
  "balance": null,
  "monthlyRepayment": null,
  "nextPaymentDate": null
},
"topupEligibility": { "eligible": false, "reason": "Client has not completed onboarding" }
```

- [ ] **Step 2: Add the new `GET /agent/clients/:clientId` request**

Add a new request to the `Agent > Clients` folder (alongside the existing list request), `GET {{base_url}}/agent/clients/:clientId`, authenticated with the collection's agent bearer token variable. Include two saved response examples:
- **Success (200):** the client detail shape (same fields as a list row, plus `loanSchedule: null` for a client with no loan).
- **Not found, not your client (404):** `{ "statusCode": 404, "message": "Client not found", "error": "Not Found" }`.

- [ ] **Step 3: Update the `Admin > Clients` list and `:id` detail requests' saved response examples**

Add the same `loanSummary`/`topupEligibility` fields (and `loanSchedule: null` on the `:id` detail request) to the existing saved response examples for `GET /admin/clients` and `GET /admin/clients/:id`.

- [ ] **Step 4: Validate the collection is still well-formed JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('postman/public-sector-backend.postman_collection.json', 'utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs(postman): add loan summary fields and the new agent client-detail endpoint"
```
