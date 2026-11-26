# Client Loan Repayment Tracking Implementation Plan (Loan Lifecycle Overhaul — B3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the existing bulk repayment-schedule upload against `ClientLoan`, auto-crediting overpayment excess to the client's wallet, recording underpayment with no remediation, and keeping `ClientLoan.principalBalance`/`.status` current — plus two new endpoints to view the resulting schedule.

**Architecture:** A new `ClientLoanRepaymentVariance` table (parallel to the existing `RepaymentVariance`, which stays untouched). A new `ClientLoanReconciliationService` in the existing `src/reconciliation/` module, called by `DocumentIngestionProcessor` right after the existing `ReconciliationService.reconcileAll()`. A new pure `computeClientLoanStatus()` function mirrors `computeLoanStatus()`. Two new read methods on the existing `LoanRequestService` (which already owns all `ClientLoan` logic from B1/B2) power a new client controller and a new admin endpoint.

**Tech Stack:** NestJS 10, Prisma 7, Jest.

**Spec:** `docs/superpowers/specs/2026-09-22-client-loan-repayment-tracking-design.md`

## Global Constraints

- `ClientLoanRepaymentVariance` is a separate table from `RepaymentVariance`, FKing to `ClientLoan`, reusing the existing `VarianceStatus` enum unchanged (spec §2).
- Matching key is `agency`+`staffId` (identical to the existing ingested-Loan reconciliation and to `ClientLoansService`), filtered to periods between `disbursementDate` and `maturationDate` (spec §3).
- **Write-once per period**: if a `ClientLoanRepaymentVariance` row already exists for a `(clientLoanId, period)`, skip it entirely — no re-processing, no re-crediting, no re-reducing balance (spec §3).
- Balance formula for every newly-processed period: `principalBalance -= min(actualAmount, expectedAmount)` (spec §3).
- Wallet credit only fires when `actualAmount > expectedAmount`, for exactly the excess, `actorType: SYSTEM` (spec §3).
- `ClientLoan.status` is recomputed from the loan's **true most recent** `ClientLoanRepaymentVariance` row (by `period` descending, across all time — not just periods touched in the current reconciliation run) each time new periods are processed for that loan (spec §3, refined here for correctness against late-arriving/out-of-order uploads).
- `GET /client/client-loans/me` returns the client's most recent `ClientLoan` regardless of status, or `null` if they've never had one; `GET /admin/client-loans/:id/repayment-plan` mirrors it for any loan by id (spec §4).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the API-surface changes, with a saved response example per request.
- Per this session's standing testing preference: run only the test file(s) relevant to what changed in each task — never the full suite for any task in this plan, including its last one. This plan is B3 of a five-part phase (B4 spend-wallet still to come); a full suite run only happens at the end of the whole phase or when explicitly requested.

---

### Task 1: Schema — `ClientLoanRepaymentVariance`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `ClientLoanRepaymentVariance` model (`id`, `clientLoanId`, `period`, `expectedAmount`, `actualAmount`, `variance`, `status`, `generatedAt`) — every later task depends on these exact field names.

- [ ] **Step 1: Add the model**

In `prisma/schema.prisma`, add (near `RepaymentVariance`):

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

Add the inverse relation to the existing `ClientLoan` model:

```prisma
  repaymentVariances ClientLoanRepaymentVariance[]
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_client_loan_repayment_variance`
Expected: creates and applies `prisma/migrations/<timestamp>_add_client_loan_repayment_variance/migration.sql`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add ClientLoanRepaymentVariance schema"
```

---

### Task 2: `computeClientLoanStatus`

**Files:**
- Create: `src/reconciliation/client-loan-status.util.ts`
- Test: `src/reconciliation/client-loan-status.util.spec.ts`

**Interfaces:**
- Produces: `computeClientLoanStatus(loan: { principalBalance: unknown; maturationDate: Date }, latestVarianceStatus: VarianceStatus | null): 'ACTIVE' | 'DEFAULT' | 'CLOSED'` — Task 3's `ClientLoanReconciliationService` consumes this.

This mirrors `src/client-loans/loan-status.util.ts`'s `computeLoanStatus()` exactly — reimplemented here (not imported from there) since it operates on a different variance source, but the policy is intentionally identical.

- [ ] **Step 1: Write the failing tests**

`src/reconciliation/client-loan-status.util.spec.ts`:

```typescript
import { computeClientLoanStatus } from './client-loan-status.util';
import { VarianceStatus } from '../generated/prisma/client';

describe('computeClientLoanStatus', () => {
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);

  it('returns CLOSED when the principal balance is paid off, regardless of maturity', () => {
    expect(computeClientLoanStatus({ principalBalance: 0, maturationDate: future }, null)).toBe('CLOSED');
    expect(computeClientLoanStatus({ principalBalance: 0, maturationDate: past }, VarianceStatus.UNDER_PAID)).toBe(
      'CLOSED',
    );
  });

  it('returns DEFAULT when maturity has passed and a balance remains, even with no variance history', () => {
    expect(computeClientLoanStatus({ principalBalance: 5000, maturationDate: past }, null)).toBe('DEFAULT');
  });

  it('returns DEFAULT when the most recent variance is UNDER_PAID or NO_DEDUCTION_FOUND, even before maturity', () => {
    expect(
      computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.UNDER_PAID),
    ).toBe('DEFAULT');
    expect(
      computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.NO_DEDUCTION_FOUND),
    ).toBe('DEFAULT');
  });

  it('returns ACTIVE when not past maturity and the most recent variance is healthy', () => {
    expect(computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.MATCHED)).toBe(
      'ACTIVE',
    );
    expect(computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.OVER_PAID)).toBe(
      'ACTIVE',
    );
    expect(computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, null)).toBe('ACTIVE');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/reconciliation/client-loan-status.util.spec.ts`
Expected: FAIL — `Cannot find module './client-loan-status.util'`.

- [ ] **Step 3: Implement `computeClientLoanStatus`**

`src/reconciliation/client-loan-status.util.ts`:

```typescript
import { VarianceStatus } from '../generated/prisma/client';

export type ClientLoanDerivedStatus = 'ACTIVE' | 'DEFAULT' | 'CLOSED';

export function computeClientLoanStatus(
  loan: { principalBalance: unknown; maturationDate: Date },
  latestVarianceStatus: VarianceStatus | null,
): ClientLoanDerivedStatus {
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

Run: `npx jest src/reconciliation/client-loan-status.util.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/reconciliation/client-loan-status.util.ts src/reconciliation/client-loan-status.util.spec.ts
git commit -m "feat: add computeClientLoanStatus"
```

---

### Task 3: `ClientLoanReconciliationService`

**Files:**
- Modify: `src/wallet/wallet.module.ts`
- Create: `src/reconciliation/client-loan-reconciliation.service.ts`
- Test: `src/reconciliation/client-loan-reconciliation.service.spec.ts`
- Modify: `src/reconciliation/reconciliation.module.ts`
- Modify: `src/document-ingestion/document-ingestion.processor.ts`
- Modify: `src/document-ingestion/document-ingestion.processor.spec.ts`

**Interfaces:**
- Consumes: `computeExpectedInstallment` (existing, unchanged), `toPeriodKey` (existing, unchanged), `computeClientLoanStatus` (Task 2), `WalletService.credit` (existing, unchanged).
- Produces: `ClientLoanReconciliationService.reconcileAll(): Promise<void>` — Task 5's `DocumentIngestionProcessor` calls this alongside the existing `ReconciliationService.reconcileAll()`.

- [ ] **Step 1: Export `WalletService` for cross-module use**

In `src/wallet/wallet.module.ts`, add `exports: [WalletService]` to the `@Module` decorator (it currently has no `exports` array — `ClientLoanReconciliationService`, in a different module, needs to inject it).

- [ ] **Step 2: Write the failing tests**

`src/reconciliation/client-loan-reconciliation.service.spec.ts`:

```typescript
import { ClientLoanReconciliationService } from './client-loan-reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditActorType, VarianceStatus } from '../generated/prisma/client';

describe('ClientLoanReconciliationService', () => {
  let service: ClientLoanReconciliationService;
  let prisma: {
    clientLoan: { findMany: jest.Mock; update: jest.Mock };
    loanRepaymentRecord: { findMany: jest.Mock };
    clientLoanRepaymentVariance: { findUnique: jest.Mock; findFirst: jest.Mock; create: jest.Mock };
  };
  let walletService: { credit: jest.Mock };

  // Date-relative (not hardcoded) so this fixture never drifts into the past — computeClientLoanStatus
  // marks a loan DEFAULT once maturationDate has passed, so a fixed calendar date would eventually make
  // every "should be ACTIVE" test below wrongly expect DEFAULT once real time caught up to it.
  const now = new Date();
  const disbursementDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const maturationDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const period = `${disbursementDate.getFullYear()}-${String(disbursementDate.getMonth() + 1).padStart(2, '0')}`;

  const baseLoan = {
    id: 'cl-1',
    clientId: 'client-1',
    agency: 'NPF',
    staffId: 'NPF-001',
    principalAmount: 90000,
    interestRatePercent: 0,
    principalBalance: 90000,
    disbursementDate,
    maturationDate,
  };

  beforeEach(() => {
    prisma = {
      clientLoan: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
      loanRepaymentRecord: { findMany: jest.fn().mockResolvedValue([]) },
      clientLoanRepaymentVariance: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
    };
    walletService = { credit: jest.fn().mockResolvedValue(undefined) };
    service = new ClientLoanReconciliationService(
      prisma as unknown as PrismaService,
      walletService as unknown as WalletService,
    );
  });

  it('does nothing for a loan with no matching repayment data in its date range', async () => {
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).not.toHaveBeenCalled();
    expect(prisma.clientLoan.update).not.toHaveBeenCalled();
  });

  it('skips a period that already has a ClientLoanRepaymentVariance row (write-once)', async () => {
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 30000 },
    ]);
    prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue({ id: 'existing-row' });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).not.toHaveBeenCalled();
    expect(walletService.credit).not.toHaveBeenCalled();
    expect(prisma.clientLoan.update).not.toHaveBeenCalled();
  });

  it('reduces the balance by the actual amount and does not credit the wallet on a MATCHED period', async () => {
    // baseLoan is a 2-month term (1 month ago -> 1 month from now, computed relative to whenever the
    // test runs) with a flat 90000 principal at 0% interest, so computeExpectedInstallment resolves to
    // 90000 / 2 = 45000 per period — the mocked repayment amount below must equal that for this to be
    // a true MATCHED case.
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 45000 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.MATCHED });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clientLoanId: 'cl-1',
        period,
        expectedAmount: 45000,
        actualAmount: 45000,
        variance: 0,
        status: VarianceStatus.MATCHED,
      }),
    });
    expect(walletService.credit).not.toHaveBeenCalled();
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 45000, status: 'ACTIVE' },
    });
  });

  it('reduces the balance by only the partial amount received on an UNDER_PAID period, with no wallet credit', async () => {
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 10000 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.UNDER_PAID });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actualAmount: 10000, status: VarianceStatus.UNDER_PAID }),
    });
    expect(walletService.credit).not.toHaveBeenCalled();
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 80000, status: 'DEFAULT' },
    });
  });

  it('reduces the balance by only the expected amount and credits the excess to the wallet on an OVER_PAID period', async () => {
    // Expected installment is 45000 (see the MATCHED test above) — 50000 actual gives a 5000 excess.
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 50000 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.OVER_PAID });

    await service.reconcileAll();

    expect(walletService.credit).toHaveBeenCalledWith(
      'client-1',
      5000,
      expect.stringContaining('NPF'),
      { actorType: AuditActorType.SYSTEM },
    );
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 45000, status: 'ACTIVE' },
    });
  });

  it('leaves the balance unchanged on a NO_DEDUCTION_FOUND period', async () => {
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);
    prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue(null);
    // No repayment record at all for this period is the normal "no deduction" case, but the loop only
    // ever considers periods that appear in loanRepaymentRecord — so exercise it via a period that does
    // appear, with amount 0 (a real-world "deduction attempted, zero collected" row).
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 0 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.NO_DEDUCTION_FOUND });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actualAmount: 0, status: VarianceStatus.NO_DEDUCTION_FOUND }),
    });
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 90000, status: 'DEFAULT' },
    });
  });

  it('derives status from the TRUE most recent variance row across all time, not just periods touched in this run', async () => {
    // Simulates a late-arriving upload for an OLD period, while a NEWER period was already
    // reconciled (and is UNDER_PAID) in a prior run.
    prisma.clientLoan.findMany.mockResolvedValue([baseLoan]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NPF', staffId: 'NPF-001', period, amount: 30000 },
    ]);
    prisma.clientLoanRepaymentVariance.findFirst.mockResolvedValue({ status: VarianceStatus.UNDER_PAID });

    await service.reconcileAll();

    expect(prisma.clientLoanRepaymentVariance.findFirst).toHaveBeenCalledWith({
      where: { clientLoanId: 'cl-1' },
      orderBy: { period: 'desc' },
    });
    expect(prisma.clientLoan.update).toHaveBeenCalledWith({
      where: { id: 'cl-1' },
      data: { principalBalance: 60000, status: 'DEFAULT' },
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/reconciliation/client-loan-reconciliation.service.spec.ts`
Expected: FAIL — `Cannot find module './client-loan-reconciliation.service'`.

- [ ] **Step 4: Implement `ClientLoanReconciliationService`**

`src/reconciliation/client-loan-reconciliation.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { computeExpectedInstallment } from './amortization.util';
import { toPeriodKey } from './period.util';
import { computeClientLoanStatus } from './client-loan-status.util';
import { AuditActorType, VarianceStatus } from '../generated/prisma/client';

const MATCH_TOLERANCE = 1;

@Injectable()
export class ClientLoanReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  async reconcileAll(): Promise<void> {
    const clientLoans = await this.prisma.clientLoan.findMany();
    const repayments = await this.prisma.loanRepaymentRecord.findMany();

    const periodsSeen = new Set<string>();
    const totalsByLoanKey = new Map<string, Map<string, number>>();

    for (const repayment of repayments) {
      if (!repayment.period) {
        continue;
      }
      periodsSeen.add(repayment.period);
      const loanKey = `${repayment.agency}::${repayment.staffId}`;
      const periodMap = totalsByLoanKey.get(loanKey) ?? new Map<string, number>();
      periodMap.set(repayment.period, (periodMap.get(repayment.period) ?? 0) + Number(repayment.amount));
      totalsByLoanKey.set(loanKey, periodMap);
    }

    const allPeriods = Array.from(periodsSeen);

    for (const clientLoan of clientLoans) {
      const disbursementPeriod = toPeriodKey(clientLoan.disbursementDate);
      const maturationPeriod = toPeriodKey(clientLoan.maturationDate);
      const applicablePeriods = allPeriods
        .filter((period) => period >= disbursementPeriod && period <= maturationPeriod)
        .sort();
      if (applicablePeriods.length === 0) {
        continue;
      }

      const loanKey = `${clientLoan.agency}::${clientLoan.staffId}`;
      const periodMap = totalsByLoanKey.get(loanKey) ?? new Map<string, number>();

      const expectedAmount = computeExpectedInstallment(
        Number(clientLoan.principalAmount),
        Number(clientLoan.interestRatePercent),
        clientLoan.disbursementDate,
        clientLoan.maturationDate,
      );

      let updatedBalance = Number(clientLoan.principalBalance);
      let processedAnyPeriod = false;

      for (const period of applicablePeriods) {
        const existing = await this.prisma.clientLoanRepaymentVariance.findUnique({
          where: { clientLoanId_period: { clientLoanId: clientLoan.id, period } },
        });
        if (existing) {
          continue;
        }

        const actualAmount = periodMap.get(period) ?? 0;
        const variance = actualAmount - expectedAmount;
        const status = this.classify(actualAmount, variance);

        await this.prisma.clientLoanRepaymentVariance.create({
          data: { clientLoanId: clientLoan.id, period, expectedAmount, actualAmount, variance, status },
        });

        updatedBalance -= Math.min(actualAmount, expectedAmount);
        processedAnyPeriod = true;

        if (actualAmount > expectedAmount) {
          await this.walletService.credit(
            clientLoan.clientId,
            actualAmount - expectedAmount,
            `Loan overpayment excess — ${clientLoan.agency} ${period}`,
            { actorType: AuditActorType.SYSTEM },
          );
        }
      }

      if (processedAnyPeriod) {
        const latestVariance = await this.prisma.clientLoanRepaymentVariance.findFirst({
          where: { clientLoanId: clientLoan.id },
          orderBy: { period: 'desc' },
        });
        const newStatus = computeClientLoanStatus(
          { principalBalance: updatedBalance, maturationDate: clientLoan.maturationDate },
          latestVariance?.status ?? null,
        );

        await this.prisma.clientLoan.update({
          where: { id: clientLoan.id },
          data: { principalBalance: updatedBalance, status: newStatus },
        });
      }
    }
  }

  private classify(actualAmount: number, variance: number): VarianceStatus {
    if (actualAmount === 0) {
      return VarianceStatus.NO_DEDUCTION_FOUND;
    }
    if (Math.abs(variance) <= MATCH_TOLERANCE) {
      return VarianceStatus.MATCHED;
    }
    return variance > 0 ? VarianceStatus.OVER_PAID : VarianceStatus.UNDER_PAID;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/reconciliation/client-loan-reconciliation.service.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Wire the service into `ReconciliationModule` and `DocumentIngestionProcessor`**

In `src/reconciliation/reconciliation.module.ts`, import `WalletModule` (`import { WalletModule } from '../wallet/wallet.module';`), add it to `imports`, add `ClientLoanReconciliationService` to `providers` and `exports`:

```typescript
import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { ClientLoanReconciliationService } from './client-loan-reconciliation.service';
import { AdminReconciliationController } from './admin-reconciliation.controller';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [AdminReconciliationController],
  providers: [ReconciliationService, ClientLoanReconciliationService],
  exports: [ReconciliationService, ClientLoanReconciliationService],
})
export class ReconciliationModule {}
```

In `src/document-ingestion/document-ingestion.processor.ts`, inject `ClientLoanReconciliationService` and call it alongside the existing `reconciliationService.reconcileAll()`:

```typescript
import { ClientLoanReconciliationService } from '../reconciliation/client-loan-reconciliation.service';
```

```typescript
  constructor(
    private readonly documentBatchService: DocumentBatchService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    @Inject(DOCUMENT_PARSERS) private readonly parsers: Record<DocumentType, DocumentParser>,
    private readonly reconciliationService: ReconciliationService,
    private readonly clientLoanReconciliationService: ClientLoanReconciliationService,
  ) {
    super();
  }
```

```typescript
      if (RECONCILIATION_TRIGGER_TYPES.includes(batch.documentType)) {
        await this.reconciliationService.reconcileAll();
        await this.clientLoanReconciliationService.reconcileAll();
      }
```

- [ ] **Step 7: Update `document-ingestion.processor.spec.ts` for the new constructor parameter**

`DocumentIngestionProcessor` now takes a 5th constructor argument, so its existing spec file (which constructs it directly, not through Nest's DI) needs updating or it won't compile. Read the file's current state first, then:

1. Add a new `let clientLoanReconciliationService: { reconcileAll: jest.Mock };` declaration alongside the existing `reconciliationService` one.
2. In `beforeEach`, initialize it the same way: `clientLoanReconciliationService = { reconcileAll: jest.fn().mockResolvedValue(undefined) };`, and pass it as the 5th argument to `new DocumentIngestionProcessor(...)`.
3. In the test `'marks processing, dispatches to the matching parser, and marks completed on success, without running reconciliation for IPPIS_BROADSHEET'`, add `expect(clientLoanReconciliationService.reconcileAll).not.toHaveBeenCalled();` alongside the existing `reconciliationService.reconcileAll` assertion.
4. In `'runs reconciliation after a successful DISBURSED_LOANS parse'` and `'runs reconciliation after a successful REPAYMENT_SCHEDULE parse'`, add `expect(clientLoanReconciliationService.reconcileAll).toHaveBeenCalledTimes(1);` alongside the existing assertion in each.
5. In `'marks failed with the error message when the parser throws, without running reconciliation'`, add `expect(clientLoanReconciliationService.reconcileAll).not.toHaveBeenCalled();` alongside the existing assertion.

- [ ] **Step 8: Type-check and run the reconciliation and document-ingestion unit suites**

Run: `npx tsc --noEmit && npx jest src/reconciliation src/document-ingestion/document-ingestion.processor.spec.ts`
Expected: both clean — no type errors, all reconciliation suites (old and new) passing, and `document-ingestion.processor.spec.ts`'s 5 tests passing.

- [ ] **Step 9: Commit**

```bash
git add src/wallet/wallet.module.ts src/reconciliation/client-loan-reconciliation.service.ts src/reconciliation/client-loan-reconciliation.service.spec.ts src/reconciliation/reconciliation.module.ts src/document-ingestion/document-ingestion.processor.ts src/document-ingestion/document-ingestion.processor.spec.ts
git commit -m "feat: add ClientLoanReconciliationService, wired into document ingestion"
```

---

### Task 4: `LoanRequestService` — read methods for the repayment schedule

**Files:**
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`

**Interfaces:**
- Consumes: `generatePeriodRange`/`computeExpectedInstallment` (existing, unchanged), `ClientLoanRepaymentVariance` (Task 1).
- Produces: `LoanRequestService.getMyLoan(clientId: string): Promise<(ClientLoan & { schedule: ScheduleEntry[] }) | null>`, `.getRepaymentPlanById(clientLoanId: string): Promise<ClientLoan & { schedule: ScheduleEntry[] }>` where `ScheduleEntry = { period: string; expectedAmount: number; actualAmount: number | null; variance: number | null; status: VarianceStatus | 'UPCOMING' }` — Task 5's controllers consume both.

- [ ] **Step 1: Write the failing tests**

Read `src/loan-request/loan-request.service.spec.ts`'s current full state first (it's large — built up across the whole Loan Origination and Topup plans; this task only adds new `describe` blocks at the end, no existing code changes). Add `NotFoundException` to the existing `@nestjs/common` import if not already present. Append:

```typescript
  describe('getMyLoan', () => {
    it('returns null when the client has no ClientLoan', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      const result = await service.getMyLoan('c1');
      expect(result).toBeNull();
    });

    it('returns the most recent ClientLoan with its schedule', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 1, 1),
      });
      prisma.clientLoanRepaymentVariance.findMany.mockResolvedValue([
        { period: '2026-01', actualAmount: 45000, variance: 0, status: 'MATCHED' },
      ]);

      const result = await service.getMyLoan('c1');

      expect(prisma.clientLoan.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        orderBy: { disbursementDate: 'desc' },
      });
      expect(result!.id).toBe('cl1');
      expect(result!.schedule).toEqual([
        { period: '2026-01', expectedAmount: 90000, actualAmount: 45000, variance: 0, status: 'MATCHED' },
        { period: '2026-02', expectedAmount: 90000, actualAmount: null, variance: null, status: 'UPCOMING' },
      ]);
    });
  });

  describe('getRepaymentPlanById', () => {
    it('throws NotFoundException when the loan does not exist', async () => {
      prisma.clientLoan.findUnique.mockResolvedValue(null);
      await expect(service.getRepaymentPlanById('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the loan with its schedule', async () => {
      prisma.clientLoan.findUnique.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 0, 1),
      });
      prisma.clientLoanRepaymentVariance.findMany.mockResolvedValue([]);

      const result = await service.getRepaymentPlanById('cl1');

      expect(result.schedule).toEqual([
        { period: '2026-01', expectedAmount: 90000, actualAmount: null, variance: null, status: 'UPCOMING' },
      ]);
    });
  });
```

Add `findFirst: jest.Mock` (already present from earlier tasks) and `findUnique: jest.Mock` to the `clientLoan` mock's type declaration/`beforeEach` if not already there, and add a new top-level `clientLoanRepaymentVariance: { findMany: jest.Mock }` entry to both the type declaration and `beforeEach`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `service.getMyLoan is not a function`.

- [ ] **Step 3: Implement the read methods**

Add these imports to `src/loan-request/loan-request.service.ts` (merge `ClientLoan` into the existing `'../generated/prisma/client'` import, add the other two as new lines):

```typescript
import { generatePeriodRange } from '../reconciliation/period.util';
import { computeExpectedInstallment } from '../reconciliation/amortization.util';
```

Add these methods to the class, after `exportDisbursementSummaryCsv`:

```typescript
  async getMyLoan(clientId: string) {
    const clientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId },
      orderBy: { disbursementDate: 'desc' },
    });
    if (!clientLoan) {
      return null;
    }
    return this.buildLoanWithSchedule(clientLoan);
  }

  async getRepaymentPlanById(clientLoanId: string) {
    const clientLoan = await this.prisma.clientLoan.findUnique({ where: { id: clientLoanId } });
    if (!clientLoan) {
      throw new NotFoundException('Loan not found');
    }
    return this.buildLoanWithSchedule(clientLoan);
  }

  private async buildLoanWithSchedule(clientLoan: ClientLoan) {
    const periods = generatePeriodRange(clientLoan.disbursementDate, clientLoan.maturationDate);
    const expectedAmount = computeExpectedInstallment(
      Number(clientLoan.principalAmount),
      Number(clientLoan.interestRatePercent),
      clientLoan.disbursementDate,
      clientLoan.maturationDate,
    );

    const varianceRows = await this.prisma.clientLoanRepaymentVariance.findMany({
      where: { clientLoanId: clientLoan.id },
    });
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

    return { ...clientLoan, schedule };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks in the full file after this step to confirm the total, rather than trusting a specific stated number (this task added 2 `getMyLoan` tests + 2 `getRepaymentPlanById` tests = 4 new tests on top of whatever count Task 3 of the Topup plan left the file at).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts
git commit -m "feat: add getMyLoan and getRepaymentPlanById to LoanRequestService"
```

---

### Task 5: Controllers

**Files:**
- Create: `src/loan-request/client-loan.controller.ts`
- Modify: `src/loan-request/admin-client-loans.controller.ts`
- Modify: `src/loan-request/loan-request.module.ts`

**Interfaces:**
- Consumes: `LoanRequestService.getMyLoan`/`.getRepaymentPlanById` (Task 4).
- Produces: `GET /client/client-loans/me`, `GET /admin/client-loans/:id/repayment-plan`.

- [ ] **Step 1: Add the client controller**

`src/loan-request/client-loan.controller.ts`:

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanRequestService } from './loan-request.service';

@Controller('client/client-loans')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoanController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Get('me')
  getMyLoan(@Req() req: { user: JwtPayload }) {
    return this.loanRequestService.getMyLoan(req.user.sub);
  }
}
```

- [ ] **Step 2: Add the admin endpoint**

In `src/loan-request/admin-client-loans.controller.ts`, add `Param` to the `@nestjs/common` import and this method:

```typescript
  @Get(':id/repayment-plan')
  getRepaymentPlan(@Param('id') id: string) {
    return this.loanRequestService.getRepaymentPlanById(id);
  }
```

- [ ] **Step 3: Wire the new controller into `LoanRequestModule`**

In `src/loan-request/loan-request.module.ts`, add `ClientLoanController` to `controllers`.

- [ ] **Step 4: Type-check and run the loan-request unit suite**

Run: `npx tsc --noEmit && npx jest src/loan-request`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/loan-request/client-loan.controller.ts src/loan-request/admin-client-loans.controller.ts src/loan-request/loan-request.module.ts
git commit -m "feat: add client and admin ClientLoan repayment-plan endpoints"
```

---

### Task 6: e2e tests, README, and Postman

**Files:**
- Create: `test/client-loan-repayment-tracking.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-5.

- [ ] **Step 1: Write the e2e test**

Read `test/loan-topup.e2e-spec.ts` first for the admin-login/client-fixture/originate-and-disburse helper pattern this reuses. This test calls `ClientLoanReconciliationService.reconcileAll()` directly (via `app.get(ClientLoanReconciliationService)`) rather than going through a real file upload — driving it through the actual multer/BullMQ document-ingestion pipeline would need substantial extra fixture machinery (a real parseable file, waiting on an async queue job) for a wiring change that's just one added line in an already-proven call path (Task 3 Step 6 adds a single call alongside the existing, already-triggered `reconciliationService.reconcileAll()`). Calling the service directly still exercises 100% of this plan's own logic — matching, write-once, balance/wallet/status effects — which is what needs proving here. `test/client-loan-repayment-tracking.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';
import { ClientLoanReconciliationService } from '../src/reconciliation/client-loan-reconciliation.service';

describe('Client loan repayment tracking (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-REPAY-${Date.now()}`;
  const agency = 'NPF';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    adminAccessToken = loginRes.body.accessToken;

    await prisma.loanTermOption.create({
      data: {
        agency,
        tenorMonths: 2,
        interestRatePercent: 0,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 0,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
  });

  afterAll(async () => {
    await prisma.clientLoanRepaymentVariance.deleteMany({ where: { clientLoan: { agency, staffId: { startsWith: staffId } } } });
    await prisma.walletEntry.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Repay Test' } } } });
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Repay Test' } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: 'E2E Repay Test' } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234806' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 2 } });
    await app.close();
  });

  async function originateAndDisburseLoan(phoneSuffix: string, staffIdSuffix: string, amount: number) {
    const phone = `+234806${phoneSuffix}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-${staffIdSuffix}`, employeeName: 'E2E Repay Test', salary: 5000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Repay Test',
        agency,
        step: 'COMPLETED',
      },
    });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });

    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount, tenorMonths: 2 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/webhooks/sms/inbound')
      .send({ phone, message: 'YES' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${createRes.body.id}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${createRes.body.id}/disburse`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const clientLoan = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-${staffIdSuffix}` } });
    return { client, accessToken, clientLoan: clientLoan! };
  }

  it(
    'reconciles a matched, an underpaid, and an overpaid loan, updating balance/status and crediting the wallet on overpayment',
    async () => {
      const matched = await originateAndDisburseLoan('0000001', 'A', 90000);
      const underpaid = await originateAndDisburseLoan('0000002', 'B', 90000);
      const overpaid = await originateAndDisburseLoan('0000003', 'C', 90000);

      // Matches toPeriodKey()'s own local-time-based format exactly (src/reconciliation/period.util.ts) —
      // deriving this via toISOString() would risk a UTC/local mismatch near a month boundary.
      const disbursedAt = matched.clientLoan.disbursementDate;
      const period = `${disbursedAt.getFullYear()}-${String(disbursedAt.getMonth() + 1).padStart(2, '0')}`;
      await prisma.loanRepaymentRecord.createMany({
        data: [
          { agency, staffId: `${staffId}-A`, period, elementName: 'Principal', amount: 45000 },
          { agency, staffId: `${staffId}-B`, period, elementName: 'Principal', amount: 20000 },
          { agency, staffId: `${staffId}-C`, period, elementName: 'Principal', amount: 50000 },
        ],
      });

      const clientLoanReconciliationService = (app as unknown as { get: (t: unknown) => ClientLoanReconciliationService }).get(
        ClientLoanReconciliationService,
      );
      await clientLoanReconciliationService.reconcileAll();

      const matchedLoan = await prisma.clientLoan.findUnique({ where: { id: matched.clientLoan.id } });
      expect(Number(matchedLoan!.principalBalance)).toBe(45000);
      expect(matchedLoan!.status).toBe('ACTIVE');

      const underpaidLoan = await prisma.clientLoan.findUnique({ where: { id: underpaid.clientLoan.id } });
      expect(Number(underpaidLoan!.principalBalance)).toBe(70000);
      expect(underpaidLoan!.status).toBe('DEFAULT');

      const overpaidLoan = await prisma.clientLoan.findUnique({ where: { id: overpaid.clientLoan.id } });
      expect(Number(overpaidLoan!.principalBalance)).toBe(45000);
      expect(overpaidLoan!.status).toBe('ACTIVE');

      const overpaidWallet = await request(app.getHttpServer())
        .get('/client/wallet')
        .set('Authorization', `Bearer ${overpaid.accessToken}`)
        .expect(200);
      expect(overpaidWallet.body.balance).toBe(5000);

      const myLoanRes = await request(app.getHttpServer())
        .get('/client/client-loans/me')
        .set('Authorization', `Bearer ${matched.accessToken}`)
        .expect(200);
      expect(myLoanRes.body.id).toBe(matched.clientLoan.id);
      expect(myLoanRes.body.schedule[0]).toEqual(
        expect.objectContaining({ period, actualAmount: 45000, status: 'MATCHED' }),
      );

      const adminPlanRes = await request(app.getHttpServer())
        .get(`/admin/client-loans/${matched.clientLoan.id}/repayment-plan`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(adminPlanRes.body.id).toBe(matched.clientLoan.id);
    },
    30000,
  );

  it('returns null for a client with no ClientLoan', async () => {
    const phone = `+234806${'0000004'}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });

    const res = await request(app.getHttpServer())
      .get('/client/client-loans/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body).toBeNull();

    await prisma.client.deleteMany({ where: { id: client.id } });
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/client-loan-repayment-tracking.e2e-spec.ts --runInBand`
Expected: PASS — 2 tests.

- [ ] **Step 3: Update the README**

In `README.md`, find the "### Topup" subsection (added by the prior plan, under "## Loan origination") and add this new subsection directly after it:

```markdown
### Repayment tracking

Repayment-schedule uploads are matched against `ClientLoan` the same way
they're already matched against the historical ingested `Loan` model —
`ClientLoanReconciliationService.reconcileAll()` runs automatically
alongside the existing reconciliation, right after every
disbursed-loans/repayment-schedule upload finishes. Each new period
(never re-processed once recorded — a correction is a manual admin
action) reduces `principalBalance` by `min(actualAmount, expectedAmount)`;
any excess beyond the expected installment is credited to the client's
wallet (`SYSTEM` actor). Underpayment carries no penalty and no automatic
remediation — it's simply recorded, which feeds `ClientLoan.status`
toward `DEFAULT` (mirroring the same `ACTIVE`/`DEFAULT`/`CLOSED` logic
used for the ingested-loan history). `GET /client/client-loans/me`
(Client JWT) returns the caller's most recent platform loan with its full
period-by-period schedule (`null` if they've never had one);
`GET /admin/client-loans/:id/repayment-plan` (`client-loans:read`)
returns the same for any loan.
```

- [ ] **Step 4: Add Postman coverage**

Add `GET /client/client-loans/me` under Client (success with a loan, and the null-loan case), and `GET /admin/client-loans/:id/repayment-plan` under Admin (alongside the existing disbursement-summary export). Every new request needs a saved response example authored from the actual code. Use a surgical text-based/jq-based insert, not a full rewrite (watch `ensure_ascii` if using Python's `json` module).

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Run the scoped suites touched by this whole plan**

Run: `npx jest src/reconciliation src/loan-request src/wallet && npx jest --config ./test/jest-e2e.json test/loan-request.e2e-spec.ts test/loan-origination.e2e-spec.ts test/loan-topup.e2e-spec.ts test/client-loan-repayment-tracking.e2e-spec.ts test/wallet.e2e-spec.ts --runInBand`
Expected: PASS. Per this plan's Global Constraints, do NOT run the full unit suite (`npm run test`) or the full e2e config with no path filter — this plan is B3 of a five-part phase, not the phase's last plan.

- [ ] **Step 7: Commit**

```bash
git add test/client-loan-repayment-tracking.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add client loan repayment tracking e2e coverage and docs"
```

## Exit criteria

- [ ] The scoped test run in Task 6's Step 6 passes from a clean state (not the full suite — see Global Constraints).
- [ ] A matched, an underpaid, and an overpaid period each affect `ClientLoan.principalBalance`/`.status` per the confirmed formulas, proven by unit and e2e tests.
- [ ] Overpayment excess is credited to the client's wallet with a `SYSTEM` actor; underpayment triggers no wallet or penalty action at all.
- [ ] Re-running reconciliation over already-processed periods is a true no-op — no double-crediting, no double-reducing balance.
- [ ] `ClientLoan.status` reflects the loan's true most recent variance row, not just whichever period happened to be touched in the latest run.
- [ ] Both new endpoints return the correct schedule shape, including `UPCOMING` for future periods.
- [ ] Postman has coverage for both new endpoints.
