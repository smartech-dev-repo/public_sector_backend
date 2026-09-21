# Client Loan History — Filters, Default Status, and Repayment Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the already-shipped `GET /client/loans` with a computed loan status (`ACTIVE`/`DEFAULT`/`CLOSED`) and filtering by it plus product/date range, and add a new `GET /client/loans/:loanId/repayment-plan` endpoint returning a full expected-vs-actual monthly schedule per loan.

**Architecture:** Extends `ClientLoansService`/`ClientLoansController` (no new module). A new pure `computeLoanStatus()` helper derives status from `Loan` fields plus the loan's most recent `RepaymentVariance` row. A new pure `generatePeriodRange()` helper (alongside `toPeriodKey()`, extracted from `ReconciliationService` into a shared `period.util.ts`) generates the full period list for the repayment-plan schedule, which reuses `computeExpectedInstallment()` from the reconciliation module unchanged.

**Tech Stack:** NestJS 10, Prisma 7, Jest, class-validator.

**Spec:** `docs/superpowers/specs/2026-09-21-client-loan-history-filters-design.md`

## Global Constraints

- Loan status is computed at request time, never persisted (spec §2).
- Status evaluation order: `CLOSED` (`principalBalance <= 0`) → `DEFAULT` (past-maturity-with-balance OR most-recent-`RepaymentVariance`-row is `UNDER_PAID`/`NO_DEDUCTION_FOUND`) → `ACTIVE` (spec §2).
- Only the loan's *most recent* `RepaymentVariance` period counts for the default check, not its full history (spec §2).
- `GET /client/loans` filters (`status`, `product`, `disbursedFrom`, `disbursedTo`) are all optional; an invalid `status` is a `400` via DTO validation (spec §3).
- `repayments` in the `GET /client/loans` response stays unfiltered by the new params — those rows aren't tied to a `loanId` (spec §3).
- `GET /client/loans/:loanId/repayment-plan` returns `404` (never `403`) for a `loanId` that doesn't exist or isn't the caller's own, reusing the same agency+staffId+BVN-cross-check matching as the dashboard (spec §4).
- The repayment-plan schedule covers every calendar month from `disbursementDate` to `maturationDate` inclusive; `expectedAmount` comes from the existing `computeExpectedInstallment()`, unchanged; periods with no `RepaymentVariance` row get `status: "UPCOMING"`, `actualAmount: null`, `variance: null` (spec §4).
- `toPeriodKey()`/`generatePeriodRange()` live in a new shared `src/reconciliation/period.util.ts`; `ReconciliationService` is updated to import `toPeriodKey` from there instead of defining it locally — pure extraction, no behavior change (spec §5).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the API-surface changes, with a saved response example per request, and the existing `GET /client/loans - Success` example needs its saved response updated for the new `status` field.
- Per this session's standing testing preference: run only the test file(s) relevant to what changed in each task, not the full suite — save full unit+e2e runs for the very end of this plan.

---

### Task 1: Extract shared period utilities

**Files:**
- Create: `src/reconciliation/period.util.ts`
- Test: `src/reconciliation/period.util.spec.ts`
- Modify: `src/reconciliation/reconciliation.service.ts`

**Interfaces:**
- Produces: `toPeriodKey(date: Date): string`, `generatePeriodRange(start: Date, end: Date): string[]` — Task 3 consumes both.

- [ ] **Step 1: Write the failing tests**

`src/reconciliation/period.util.spec.ts`:

```typescript
import { toPeriodKey, generatePeriodRange } from './period.util';

describe('toPeriodKey', () => {
  it('formats a date as YYYY-MM, zero-padding single-digit months', () => {
    expect(toPeriodKey(new Date(2026, 0, 15))).toBe('2026-01');
    expect(toPeriodKey(new Date(2026, 10, 3))).toBe('2026-11');
  });
});

describe('generatePeriodRange', () => {
  it('returns a single period when start and end fall in the same month', () => {
    expect(generatePeriodRange(new Date(2026, 2, 1), new Date(2026, 2, 28))).toEqual(['2026-03']);
  });

  it('returns every month inclusive, spanning a year boundary', () => {
    expect(generatePeriodRange(new Date(2025, 10, 15), new Date(2026, 1, 1))).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('returns an empty array when end is before start', () => {
    expect(generatePeriodRange(new Date(2026, 5, 1), new Date(2026, 2, 1))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/reconciliation/period.util.spec.ts`
Expected: FAIL — `Cannot find module './period.util'`.

- [ ] **Step 3: Implement the utilities**

`src/reconciliation/period.util.ts`:

```typescript
export function toPeriodKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function generatePeriodRange(start: Date, end: Date): string[] {
  const periods: string[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const endCursor = new Date(end.getFullYear(), end.getMonth(), 1);

  while (cursor <= endCursor) {
    periods.push(toPeriodKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return periods;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/reconciliation/period.util.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Update `ReconciliationService` to use the shared `toPeriodKey`**

In `src/reconciliation/reconciliation.service.ts`, remove the local `toPeriodKey` function definition (currently lines 8-10) and add an import instead:

```typescript
import { toPeriodKey } from './period.util';
```

Place it alongside the existing imports at the top of the file. The two call sites (`toPeriodKey(loan.disbursementDate)` and `toPeriodKey(loan.maturationDate)`) are unchanged.

- [ ] **Step 6: Run the reconciliation suite to confirm no regression**

Run: `npx jest src/reconciliation/reconciliation.service.spec.ts`
Expected: PASS — same test count as before this change (pure extraction, no behavior change).

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/reconciliation/period.util.ts src/reconciliation/period.util.spec.ts src/reconciliation/reconciliation.service.ts
git commit -m "refactor: extract toPeriodKey/generatePeriodRange into a shared period util"
```

---

### Task 2: Loan status derivation and `GET /client/loans` filters

**Files:**
- Create: `src/client-loans/loan-status.util.ts`
- Test: `src/client-loans/loan-status.util.spec.ts`
- Modify: `src/client-loans/client-loans.service.ts`
- Modify: `src/client-loans/client-loans.service.spec.ts`

**Interfaces:**
- Produces: `type LoanStatus = 'ACTIVE' | 'DEFAULT' | 'CLOSED'`, `computeLoanStatus(loan: { principalBalance: unknown; maturationDate: Date }, latestVarianceStatus: VarianceStatus | null): LoanStatus`, `ClientLoansService.getDashboard(clientId: string, filters?: ListLoansFilters)` where `interface ListLoansFilters { status?: LoanStatus; product?: string; disbursedFrom?: Date; disbursedTo?: Date }` — Task 4's controller consumes `ListLoansFilters`.

- [ ] **Step 1: Write the failing tests for `computeLoanStatus`**

`src/client-loans/loan-status.util.spec.ts`:

```typescript
import { computeLoanStatus } from './loan-status.util';
import { VarianceStatus } from '../generated/prisma/client';

describe('computeLoanStatus', () => {
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);

  it('returns CLOSED when the principal balance is paid off, regardless of maturity', () => {
    expect(computeLoanStatus({ principalBalance: 0, maturationDate: future }, null)).toBe('CLOSED');
    expect(computeLoanStatus({ principalBalance: 0, maturationDate: past }, VarianceStatus.UNDER_PAID)).toBe(
      'CLOSED',
    );
  });

  it('returns DEFAULT when maturity has passed and a balance remains, even with no variance history', () => {
    expect(computeLoanStatus({ principalBalance: 5000, maturationDate: past }, null)).toBe('DEFAULT');
  });

  it('returns DEFAULT when the most recent variance is UNDER_PAID or NO_DEDUCTION_FOUND, even before maturity', () => {
    expect(computeLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.UNDER_PAID)).toBe(
      'DEFAULT',
    );
    expect(
      computeLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.NO_DEDUCTION_FOUND),
    ).toBe('DEFAULT');
  });

  it('returns ACTIVE when not past maturity and the most recent variance is healthy', () => {
    expect(computeLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.MATCHED)).toBe(
      'ACTIVE',
    );
    expect(computeLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.OVER_PAID)).toBe(
      'ACTIVE',
    );
    expect(computeLoanStatus({ principalBalance: 5000, maturationDate: future }, null)).toBe('ACTIVE');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/client-loans/loan-status.util.spec.ts`
Expected: FAIL — `Cannot find module './loan-status.util'`.

- [ ] **Step 3: Implement `computeLoanStatus`**

`src/client-loans/loan-status.util.ts`:

```typescript
import { VarianceStatus } from '../generated/prisma/client';

export type LoanStatus = 'ACTIVE' | 'DEFAULT' | 'CLOSED';

export function computeLoanStatus(
  loan: { principalBalance: unknown; maturationDate: Date },
  latestVarianceStatus: VarianceStatus | null,
): LoanStatus {
  if (Number(loan.principalBalance) <= 0) {
    return 'CLOSED';
  }

  const pastMaturity = loan.maturationDate.getTime() < Date.now();
  const badVariance =
    latestVarianceStatus === VarianceStatus.UNDER_PAID || latestVarianceStatus === VarianceStatus.NO_DEDUCTION_FOUND;

  if (pastMaturity || badVariance) {
    return 'DEFAULT';
  }

  return 'ACTIVE';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/client-loans/loan-status.util.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Write the failing tests for filtering on `getDashboard`**

Read `src/client-loans/client-loans.service.spec.ts` in full first (it currently has 4 tests, using a `prisma` mock with `clientOnboarding`/`loan`/`loanRepaymentRecord`). Replace the file's `prisma` mock setup and add filter-related tests — the full updated file:

```typescript
import { ClientLoansService } from './client-loans.service';
import { PrismaService } from '../prisma/prisma.service';
import { VarianceStatus } from '../generated/prisma/client';

describe('ClientLoansService', () => {
  let service: ClientLoansService;
  let prisma: {
    clientOnboarding: { findUnique: jest.Mock };
    loan: { findMany: jest.Mock; findFirst: jest.Mock };
    loanRepaymentRecord: { findMany: jest.Mock };
    repaymentVariance: { findMany: jest.Mock };
  };

  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

  beforeEach(() => {
    prisma = {
      clientOnboarding: { findUnique: jest.fn() },
      loan: { findMany: jest.fn(), findFirst: jest.fn() },
      loanRepaymentRecord: { findMany: jest.fn() },
      repaymentVariance: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new ClientLoansService(prisma as unknown as PrismaService);
  });

  describe('getDashboard', () => {
    it('returns empty lists when the client has no ClientOnboarding row', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.getDashboard('c1');

      expect(result).toEqual({ loans: [], repayments: [] });
      expect(prisma.loan.findMany).not.toHaveBeenCalled();
      expect(prisma.loanRepaymentRecord.findMany).not.toHaveBeenCalled();
    });

    it('matches loans and repayments by the linked IppisRecord agency+staffId, tagging each loan with a status', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([{ id: 'rep-1' }]);

      const result = await service.getDashboard('c1');

      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agency: 'NPF', ippisNumber: 'NPF-001' }) }),
      );
      expect(prisma.loanRepaymentRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: 'NPF', staffId: 'NPF-001' } }),
      );
      expect(result.loans).toEqual([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future, status: 'ACTIVE' },
      ]);
      expect(result.repayments).toEqual([{ id: 'rep-1' }]);
    });

    it('applies the bvn cross-check when the client has a verified bvn on file', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: '11111111111',
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-no-bvn', bvn: null, principalBalance: 5000, maturationDate: future },
        { id: 'loan-match', bvn: '11111111111', principalBalance: 5000, maturationDate: future },
        { id: 'loan-mismatch', bvn: '99999999999', principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const result = await service.getDashboard('c1');

      expect(result.loans.map((loan: { id: string }) => loan.id)).toEqual(['loan-no-bvn', 'loan-match']);
    });

    it('skips the bvn cross-check entirely when the client has no verified bvn on file', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: '22222222222', principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const result = await service.getDashboard('c1');

      expect(result.loans.map((loan: { id: string }) => loan.id)).toEqual(['loan-1']);
    });

    it('pushes product and disbursement date range filters into the loan query', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const disbursedFrom = new Date('2025-01-01');
      const disbursedTo = new Date('2025-12-31');
      await service.getDashboard('c1', { product: 'Salary Advance', disbursedFrom, disbursedTo });

      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            product: 'Salary Advance',
            disbursementDate: { gte: disbursedFrom, lte: disbursedTo },
          }),
        }),
      );
    });

    it('filters the computed status in memory using the most recent variance per loan', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-active', bvn: null, principalBalance: 5000, maturationDate: future },
        { id: 'loan-default', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);
      prisma.repaymentVariance.findMany.mockResolvedValue([
        { loanId: 'loan-default', period: '2026-02', status: VarianceStatus.UNDER_PAID },
        { loanId: 'loan-default', period: '2026-01', status: VarianceStatus.MATCHED },
      ]);

      const result = await service.getDashboard('c1', { status: 'DEFAULT' });

      expect(result.loans.map((loan: { id: string }) => loan.id)).toEqual(['loan-default']);
    });
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: FAIL — `getDashboard` doesn't accept a second argument / doesn't query `repaymentVariance` / loans aren't tagged with `status`.

- [ ] **Step 7: Implement filtering and status tagging in `ClientLoansService`**

Replace `src/client-loans/client-loans.service.ts` in full:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VarianceStatus } from '../generated/prisma/client';
import { computeLoanStatus, LoanStatus } from './loan-status.util';

const LOAN_SELECT = {
  id: true,
  customerId: true,
  customerName: true,
  accountNumber: true,
  address: true,
  branch: true,
  gender: true,
  phone: true,
  ippisNumber: true,
  agency: true,
  loanAmount: true,
  principalBalance: true,
  disbursementDate: true,
  maturationDate: true,
  effectiveDate: true,
  moratoriumDays: true,
  product: true,
  linkedAccountNumber: true,
  bvn: true,
  interestRatePercent: true,
  accountOfficer: true,
  hasPreviouslyTakenLoan: true,
  createdAt: true,
  updatedAt: true,
} as const;

const REPAYMENT_SELECT = {
  id: true,
  agency: true,
  staffId: true,
  period: true,
  elementName: true,
  elementDetail: true,
  amount: true,
  createdAt: true,
} as const;

export interface ListLoansFilters {
  status?: LoanStatus;
  product?: string;
  disbursedFrom?: Date;
  disbursedTo?: Date;
}

@Injectable()
export class ClientLoansService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(clientId: string, filters: ListLoansFilters = {}) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return { loans: [], repayments: [] };
    }

    const { agency, staffId } = onboarding.ippisRecord;

    const candidateLoans = await this.prisma.loan.findMany({
      where: {
        agency,
        ippisNumber: staffId,
        product: filters.product,
        disbursementDate:
          filters.disbursedFrom || filters.disbursedTo
            ? { gte: filters.disbursedFrom, lte: filters.disbursedTo }
            : undefined,
      },
      select: LOAN_SELECT,
      orderBy: { disbursementDate: 'desc' },
    });

    const matchedLoans = candidateLoans.filter((loan) => this.loanMatchesOnboarding(loan, onboarding));

    const latestVarianceByLoanId = await this.getLatestVarianceStatuses(matchedLoans.map((loan) => loan.id));

    const loansWithStatus = matchedLoans.map((loan) => ({
      ...loan,
      status: computeLoanStatus(loan, latestVarianceByLoanId.get(loan.id) ?? null),
    }));

    const loans = filters.status
      ? loansWithStatus.filter((loan) => loan.status === filters.status)
      : loansWithStatus;

    const repayments = await this.prisma.loanRepaymentRecord.findMany({
      where: { agency, staffId },
      select: REPAYMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return { loans, repayments };
  }

  private loanMatchesOnboarding(loan: { bvn: string | null }, onboarding: { bvn: string | null }): boolean {
    if (!loan.bvn || !onboarding.bvn) {
      return true;
    }
    return loan.bvn === onboarding.bvn;
  }

  private async getLatestVarianceStatuses(loanIds: string[]): Promise<Map<string, VarianceStatus>> {
    if (loanIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.repaymentVariance.findMany({
      where: { loanId: { in: loanIds } },
      orderBy: { period: 'desc' },
      select: { loanId: true, status: true },
    });

    const latest = new Map<string, VarianceStatus>();
    for (const row of rows) {
      if (!latest.has(row.loanId)) {
        latest.set(row.loanId, row.status);
      }
    }
    return latest;
  }
}
```

Note: `filters.disbursedFrom || filters.disbursedTo ? {...} : undefined` (rather than always passing `{ gte: filters.disbursedFrom, lte: filters.disbursedTo }`) avoids sending an empty `{}` object as the `disbursementDate` filter when neither bound is set — Prisma treats an explicit `{}` differently from an omitted key on some versions, so this is a deliberate guard, not an oversight.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/client-loans/loan-status.util.ts src/client-loans/loan-status.util.spec.ts src/client-loans/client-loans.service.ts src/client-loans/client-loans.service.spec.ts
git commit -m "feat: add computed loan status and list filters to ClientLoansService"
```

---

### Task 3: `getRepaymentPlan`

**Files:**
- Modify: `src/client-loans/client-loans.service.ts`
- Modify: `src/client-loans/client-loans.service.spec.ts`

**Interfaces:**
- Consumes: `toPeriodKey`/`generatePeriodRange` (Task 1, `src/reconciliation/period.util.ts`), `computeExpectedInstallment` (`src/reconciliation/amortization.util.ts`, already exists — unchanged).
- Produces: `ClientLoansService.getRepaymentPlan(clientId: string, loanId: string): Promise<{ loanId: string; schedule: Array<{ period: string; expectedAmount: number; actualAmount: number | null; variance: number | null; status: VarianceStatus | 'UPCOMING' }> }>` — Task 4's controller consumes this.

- [ ] **Step 1: Add the failing tests**

Append to `src/client-loans/client-loans.service.spec.ts`, inside the outer `describe('ClientLoansService', ...)` block, after the `getDashboard` describe block added in Task 2. Add `NotFoundException` to a new import line and add this new describe block:

```typescript
  describe('getRepaymentPlan', () => {
    it('throws NotFoundException when the client has no ClientOnboarding row', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      await expect(service.getRepaymentPlan('c1', 'loan-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the loan does not match the client agency+staffId', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findFirst.mockResolvedValue(null);

      await expect(service.getRepaymentPlan('c1', 'loan-1')).rejects.toThrow(NotFoundException);
      expect(prisma.loan.findFirst).toHaveBeenCalledWith({
        where: { id: 'loan-1', agency: 'NPF', ippisNumber: 'NPF-001' },
      });
    });

    it('throws NotFoundException when the loan fails the bvn cross-check', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: '11111111111',
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findFirst.mockResolvedValue({ id: 'loan-1', bvn: '99999999999' });

      await expect(service.getRepaymentPlan('c1', 'loan-1')).rejects.toThrow(NotFoundException);
    });

    it('builds the full period range, overlaying actual variance data and marking unreconciled periods UPCOMING', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findFirst.mockResolvedValue({
        id: 'loan-1',
        bvn: null,
        loanAmount: 100000,
        interestRatePercent: 12,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 2, 1),
      });
      prisma.repaymentVariance.findMany.mockResolvedValue([
        { period: '2026-01', actualAmount: 34000, variance: 0, status: VarianceStatus.MATCHED },
      ]);

      const result = await service.getRepaymentPlan('c1', 'loan-1');

      expect(prisma.repaymentVariance.findMany).toHaveBeenCalledWith({ where: { loanId: 'loan-1' } });
      expect(result.loanId).toBe('loan-1');
      expect(result.schedule.map((row: { period: string }) => row.period)).toEqual(['2026-01', '2026-02', '2026-03']);
      expect(result.schedule[0]).toEqual(
        expect.objectContaining({ period: '2026-01', actualAmount: 34000, variance: 0, status: VarianceStatus.MATCHED }),
      );
      expect(result.schedule[1]).toEqual(
        expect.objectContaining({ period: '2026-02', actualAmount: null, variance: null, status: 'UPCOMING' }),
      );
      expect(result.schedule.every((row: { expectedAmount: number }) => row.expectedAmount === result.schedule[0].expectedAmount)).toBe(true);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: FAIL — `service.getRepaymentPlan is not a function`.

- [ ] **Step 3: Implement `getRepaymentPlan`**

Add these imports to the top of `src/client-loans/client-loans.service.ts`:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { generatePeriodRange } from '../reconciliation/period.util';
import { computeExpectedInstallment } from '../reconciliation/amortization.util';
```

(This replaces the existing `import { Injectable } from '@nestjs/common';` line — merge `NotFoundException` into it.)

Add this method to the `ClientLoansService` class, after `getDashboard`:

```typescript
  async getRepaymentPlan(clientId: string, loanId: string) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      throw new NotFoundException('Loan not found');
    }

    const { agency, staffId } = onboarding.ippisRecord;

    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, agency, ippisNumber: staffId },
    });
    if (!loan || !this.loanMatchesOnboarding(loan, onboarding)) {
      throw new NotFoundException('Loan not found');
    }

    const periods = generatePeriodRange(loan.disbursementDate, loan.maturationDate);
    const expectedAmount = computeExpectedInstallment(
      Number(loan.loanAmount),
      Number(loan.interestRatePercent),
      loan.disbursementDate,
      loan.maturationDate,
    );

    const varianceRows = await this.prisma.repaymentVariance.findMany({ where: { loanId: loan.id } });
    const varianceByPeriod = new Map(varianceRows.map((row) => [row.period, row]));

    const schedule = periods.map((period) => {
      const varianceRow = varianceByPeriod.get(period);
      if (!varianceRow) {
        return { period, expectedAmount, actualAmount: null, variance: null, status: 'UPCOMING' as const };
      }
      return {
        period,
        expectedAmount,
        actualAmount: Number(varianceRow.actualAmount),
        variance: Number(varianceRow.variance),
        status: varianceRow.status,
      };
    });

    return { loanId: loan.id, schedule };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: PASS — 10 tests (6 from Task 2 + 4 new).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client-loans/client-loans.service.ts src/client-loans/client-loans.service.spec.ts
git commit -m "feat: add getRepaymentPlan to ClientLoansService"
```

---

### Task 4: Controller — query DTO and new route

**Files:**
- Create: `src/client-loans/dto/list-loans-query.dto.ts`
- Modify: `src/client-loans/client-loans.controller.ts`

**Interfaces:**
- Consumes: `ClientLoansService.getDashboard`/`.getRepaymentPlan` (Tasks 2-3), `ListLoansFilters` (Task 2).
- Produces: `GET /client/loans?status=&product=&disbursedFrom=&disbursedTo=`, `GET /client/loans/:loanId/repayment-plan`.

- [ ] **Step 1: Add the query DTO**

`src/client-loans/dto/list-loans-query.dto.ts`:

```typescript
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';

const LOAN_STATUSES = ['ACTIVE', 'DEFAULT', 'CLOSED'] as const;

export class ListLoansQueryDto {
  @IsOptional()
  @IsIn(LOAN_STATUSES)
  status?: (typeof LOAN_STATUSES)[number];

  @IsOptional()
  @IsString()
  product?: string;

  @IsOptional()
  @IsISO8601()
  disbursedFrom?: string;

  @IsOptional()
  @IsISO8601()
  disbursedTo?: string;
}
```

- [ ] **Step 2: Update the controller**

Replace `src/client-loans/client-loans.controller.ts` in full:

```typescript
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientLoansService } from './client-loans.service';
import { ListLoansQueryDto } from './dto/list-loans-query.dto';

@Controller('client/loans')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoansController {
  constructor(private readonly clientLoansService: ClientLoansService) {}

  @Get()
  getDashboard(@Query() query: ListLoansQueryDto, @Req() req: { user: JwtPayload }) {
    return this.clientLoansService.getDashboard(req.user.sub, {
      status: query.status,
      product: query.product,
      disbursedFrom: query.disbursedFrom ? new Date(query.disbursedFrom) : undefined,
      disbursedTo: query.disbursedTo ? new Date(query.disbursedTo) : undefined,
    });
  }

  @Get(':loanId/repayment-plan')
  getRepaymentPlan(@Param('loanId') loanId: string, @Req() req: { user: JwtPayload }) {
    return this.clientLoansService.getRepaymentPlan(req.user.sub, loanId);
  }
}
```

- [ ] **Step 3: Type-check and run the client-loans unit suite**

Run: `npx tsc --noEmit && npx jest src/client-loans`
Expected: both clean — no type errors, all `client-loans` unit tests still pass (this task adds no new unit tests of its own; controllers in this codebase are verified via e2e, per existing convention — see Task 5).

- [ ] **Step 4: Commit**

```bash
git add src/client-loans/dto/list-loans-query.dto.ts src/client-loans/client-loans.controller.ts
git commit -m "feat: add loan list filters and repayment-plan endpoint to ClientLoansController"
```

---

### Task 5: e2e tests, README, and Postman

**Files:**
- Modify: `test/client-loans.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

- [ ] **Step 1: Extend the e2e test**

Read `test/client-loans.e2e-spec.ts` in full first (current state shown in this plan's research — one client, two loans one of which is bvn-mismatched, one `LoanRepaymentRecord`, one existing test). Replace it in full:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Client loan dashboard (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clientId: string;
  let accessToken: string;
  let activeLoanId: string;
  let defaultLoanId: string;
  const phone = `+234803${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-LOANS-${Date.now()}`;
  const agency = 'NPF';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    clientId = client.id;
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId, employeeName: 'E2E Loans Test' },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Loans Test',
        agency,
        bvn: '11111111111',
        step: 'COMPLETED',
      },
    });

    const activeLoan = await prisma.loan.create({
      data: {
        customerId: `${staffId}-CUST`,
        customerName: 'E2E Loans Test',
        accountNumber: '0000000000',
        ippisNumber: staffId,
        agency,
        loanAmount: 500000,
        principalBalance: 400000,
        disbursementDate: new Date('2025-01-01'),
        maturationDate: new Date('2099-01-01'),
        product: 'Salary Advance',
        interestRatePercent: 5,
        bvn: '11111111111',
      },
    });
    activeLoanId = activeLoan.id;

    const defaultLoan = await prisma.loan.create({
      data: {
        customerId: `${staffId}-CUST-DEFAULT`,
        customerName: 'E2E Loans Test',
        accountNumber: '0000000002',
        ippisNumber: staffId,
        agency,
        loanAmount: 200000,
        principalBalance: 150000,
        disbursementDate: new Date('2025-01-01'),
        maturationDate: new Date('2025-06-01'),
        product: 'Emergency Loan',
        interestRatePercent: 5,
        bvn: '11111111111',
      },
    });
    defaultLoanId = defaultLoan.id;

    await prisma.loan.create({
      data: {
        customerId: `${staffId}-CUST-MISMATCH`,
        customerName: 'Someone Else',
        accountNumber: '0000000001',
        ippisNumber: staffId,
        agency,
        loanAmount: 100000,
        principalBalance: 100000,
        disbursementDate: new Date('2025-02-01'),
        maturationDate: new Date('2026-02-01'),
        product: 'Salary Advance',
        interestRatePercent: 5,
        bvn: '99999999999',
      },
    });
    await prisma.loanRepaymentRecord.create({
      data: { agency, staffId, period: '2025-01', elementName: 'Principal', amount: 50000 },
    });
    await prisma.repaymentVariance.create({
      data: {
        loanId: activeLoanId,
        period: '2025-01',
        expectedAmount: 45000,
        actualAmount: 45000,
        variance: 0,
        status: 'MATCHED',
      },
    });

    const tokenService = moduleFixture.get(TokenService);
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.repaymentVariance.deleteMany({ where: { loanId: { in: [activeLoanId, defaultLoanId] } } });
    await prisma.loanRepaymentRecord.deleteMany({ where: { agency, staffId } });
    await prisma.loan.deleteMany({ where: { ippisNumber: staffId } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('returns matched loans with a computed status, excluding the bvn-mismatched one, plus matched repayments', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loans).toHaveLength(2);
    const active = res.body.loans.find((loan: { id: string }) => loan.id === activeLoanId);
    const defaulted = res.body.loans.find((loan: { id: string }) => loan.id === defaultLoanId);
    expect(active.status).toBe('ACTIVE');
    expect(defaulted.status).toBe('DEFAULT');
    expect(res.body.repayments).toHaveLength(1);
    expect(res.body.repayments[0].elementName).toBe('Principal');
  });

  it('filters the loan list by status', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans?status=DEFAULT')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loans).toHaveLength(1);
    expect(res.body.loans[0].id).toBe(defaultLoanId);
  });

  it('filters the loan list by product', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans?product=Emergency Loan')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loans).toHaveLength(1);
    expect(res.body.loans[0].id).toBe(defaultLoanId);
  });

  it('rejects an invalid status filter with a 400', async () => {
    await request(app.getHttpServer())
      .get('/client/loans?status=NOT_A_STATUS')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('returns a full repayment plan with UPCOMING periods for a loan with a real disbursement/maturity window', async () => {
    const res = await request(app.getHttpServer())
      .get(`/client/loans/${activeLoanId}/repayment-plan`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loanId).toBe(activeLoanId);
    expect(res.body.schedule.length).toBeGreaterThan(1);
    expect(res.body.schedule[0]).toEqual(
      expect.objectContaining({ period: '2025-01', actualAmount: 45000, status: 'MATCHED' }),
    );
    const laterPeriod = res.body.schedule[res.body.schedule.length - 1];
    expect(laterPeriod.status).toBe('UPCOMING');
    expect(laterPeriod.actualAmount).toBeNull();
  });

  it('returns 404 for a repayment plan on someone else\'s loan', async () => {
    const otherLoan = await prisma.loan.findFirst({ where: { customerId: `${staffId}-CUST-MISMATCH` } });

    await request(app.getHttpServer())
      .get(`/client/loans/${otherLoan!.id}/repayment-plan`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
  });

  it('returns 404 for a repayment plan on a nonexistent loan', async () => {
    await request(app.getHttpServer())
      .get('/client/loans/00000000-0000-0000-0000-000000000000/repayment-plan')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
  });
});
```

Note: `defaultLoan`'s `maturationDate: new Date('2025-06-01')` is in the past relative to any real test run date, giving it `DEFAULT` status via the maturity+balance signal; `activeLoan`'s `maturationDate: new Date('2099-01-01')` keeps it comfortably `ACTIVE` for as long as this suite exists.

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/client-loans.e2e-spec.ts --runInBand`
Expected: PASS — 7 tests.

- [ ] **Step 3: Update the README**

In `README.md`, find the existing `## Client loan dashboard` section (documented in this plan's research above) and replace it in full with:

```markdown
## Client loan dashboard

`GET /client/loans` (Client JWT) returns the calling client's pre-existing
loan history — real disbursed loans and repayment activity ingested from
bank reports, which predate this platform and have no direct database
link to `Client`. Matched via the client's linked `IppisRecord`'s
`agency`+`staffId` (the same pairing `Loan.agency`/`.ippisNumber` and
`LoanRepaymentRecord.agency`/`.staffId` already carry from ingestion),
with a BVN cross-check against `Loan.bvn` (comparing the client's own
Dojah-verified BVN from onboarding, not the IPPIS broadsheet's BVN) to
guard against an agency+staffId collision showing one client someone
else's loan. Returns `{ loans: [], repayments: [] }` (empty, not an
error) if the client hasn't linked IPPIS yet or has no matching history.
This is deliberately separate from `GET /client/loan-requests` — that
endpoint is the client's own in-platform loan applications; this one is
historical/external data.

Each loan in the response carries a computed (not persisted) `status`:
`CLOSED` if `principalBalance <= 0`; else `DEFAULT` if `maturationDate`
has passed with a balance still owed, or the loan's most recent
`RepaymentVariance` row is `UNDER_PAID`/`NO_DEDUCTION_FOUND`; else
`ACTIVE`. `GET /client/loans` accepts optional `status`/`product`/
`disbursedFrom`/`disbursedTo` query params to filter the `loans` array —
`repayments` is never filtered by these, since those rows aren't tied to
a specific loan in the schema.

`GET /client/loans/:loanId/repayment-plan` (Client JWT) returns one
loan's full month-by-month schedule from disbursement to maturity, reusing
the reconciliation module's `computeExpectedInstallment()` for the
expected amount (the same value reconciliation stores as
`RepaymentVariance.expectedAmount`) and overlaying real `RepaymentVariance`
rows where they exist. Periods with no row yet are returned with
`status: "UPCOMING"` and null `actualAmount`/`variance`. Requesting a
`loanId` that isn't the caller's own (or doesn't exist) returns `404`,
matching this codebase's never-leak-existence convention elsewhere.
```

- [ ] **Step 4: Add Postman coverage**

Under the existing Client group (not the Loan Requests sub-folder — see the design spec's §7 rationale), find the existing `GET /client/loans - Success` request in `postman/public-sector-backend.postman_collection.json` and:
- Update its saved response example to include the new `status` field on each loan object.
- Add four new sibling requests, each with a saved response example authored from the actual controller/service/DTO code from Tasks 1-4 (not guessed):
  - `GET /client/loans - Filtered by status`
  - `GET /client/loans - Invalid status (400)`
  - `GET /client/loans/:loanId/repayment-plan - Success`
  - `GET /client/loans/:loanId/repayment-plan - Not found (404)`

Use a surgical text-based/jq-based insert into the JSON, not a full rewrite.

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including everything from this plan. If a single pre-existing, unrelated suite times out under the full serialized run, re-run just that suite in isolation before treating it as a real regression — this repo has known environmental e2e flakiness under machine load.

- [ ] **Step 7: Commit**

```bash
git add test/client-loans.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add e2e coverage and docs for loan filters/status/repayment-plan"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state.
- [ ] `GET /client/loans` returns each loan with a correct computed `status`, filterable by `status`/`product`/`disbursedFrom`/`disbursedTo` — proven by unit and e2e tests.
- [ ] `GET /client/loans/:loanId/repayment-plan` returns a full disbursement-to-maturity schedule with real data overlaid and `UPCOMING` for unreconciled future periods, and `404`s for any loan that isn't the caller's own — proven by unit and e2e tests.
- [ ] `computeExpectedInstallment()` and `RepaymentVariance.expectedAmount` remain the single source of truth for "expected" — no second calculation was introduced.
- [ ] `ReconciliationService`'s behavior is unchanged after the `period.util.ts` extraction — proven by its existing test suite passing unmodified.
- [ ] Postman has coverage for both endpoints, including the updated response shape on the existing request.
