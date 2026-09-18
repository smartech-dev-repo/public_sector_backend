# Repayment Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the last unbuilt piece of the already-approved Document Ingestion & Reconciliation design (`docs/superpowers/specs/2026-09-15-document-ingestion-design.md` §6, §11 item 5) — computing expected vs. actual loan repayments and exposing the variances — plus the two small browsing endpoints from that same design's §7 table (`GET /admin/loans`, `GET /admin/ippis-records`) that were never assigned to any of the four already-shipped implementation plans.

**Architecture:** A new `reconciliation` module owning the amortization math, the `ReconciliationService` (a full idempotent recompute over every `Loan`/`LoanRepaymentRecord`, upserted by `(loanId, period)` — deliberately not scoped to a single upload's changed rows, since that would require modifying the two already-shipped, already-tested parsers; recomputing everything is correct and simple, matching this project's stated "don't build ahead of a proven need" philosophy), and `GET /admin/reconciliation`. The existing `DocumentIngestionProcessor` calls it after a successful `DISBURSED_LOANS`/`REPAYMENT_SCHEDULE` parse, exactly as step 6 of the design's pipeline overview describes. A separate small `admin-catalog` module holds the two browsing endpoints, reusing the already-seeded `loans:upload`/`ippis:upload` permissions per the design's own table.

**Tech Stack:** NestJS 10, Prisma 7, Jest.

**Spec:** `docs/superpowers/specs/2026-09-15-document-ingestion-design.md` (§4 data model, §6 reconciliation, §7 endpoints — all pre-approved; this plan implements the parts of it not covered by the four prior ingestion plans).

## Global Constraints

- Reconciliation recomputes across **every** `Loan` and `LoanRepaymentRecord`, not just the rows touched by the triggering upload — an explicit, deliberate deviation from the design doc's literal "affected loans/periods" wording, chosen to avoid touching the already-shipped `DisbursedLoansParser`/`RepaymentScheduleParser`. The outcome is identical (correct variances for every loan/period with data); only the recompute cost differs.
- A period is only reconciled for a loan if it falls within that loan's `disbursementDate`–`maturationDate` range (inclusive, by `YYYY-MM` month) — a loan can't have a missed deduction before it existed or after it matured. This bound isn't in the original design text but is necessary for the feature to produce meaningful output rather than noise.
- `MATCHED` tolerance is a flat ₦1.00 (`Math.abs(variance) <= 1`) — a provisional, explicitly-chosen absolute tolerance, not a percentage.
- `NO_DEDUCTION_FOUND` applies when a period is within a loan's applicable range but has zero matching `LoanRepaymentRecord` rows for that loan's `(agency, ippisNumber)` — not when the actual sum happens to equal zero for some other reason (that distinction doesn't currently arise in practice, since the only way to get an actual of exactly 0 is having no records).
- The amortization function (`computeExpectedInstallment`) is a pure function, standard reducing-balance formula — independent of any I/O, unit-testable against known values.
- `Loan.agency === null` (unrecognized IPPIS prefix at ingestion, per the disbursed-loans parser's existing behavior) → that loan is skipped entirely by reconciliation, matching the design's existing "flagged for review" treatment.
- Reconciliation runs synchronously inside the same BullMQ job as the triggering upload, before the batch is marked `COMPLETED` — matching the design's step 6 exactly, not a separate follow-up job.
- New permissions (`reconciliation:read`) must be seeded **and the seed script re-run against the shared database** before any e2e test relying on it will pass — this is a real, previously-encountered requirement in this project (new permissions only take effect once `npx prisma db seed` runs again).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints, and every new request needs a saved response example (the standing rule from the completed full-collection retrofit).

---

### Task 1: Schema — `RepaymentVariance`, `VarianceStatus`, and the `reconciliation:read` permission

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: the `RepaymentVariance` model, `VarianceStatus` enum, `Loan.repaymentVariances` relation field — every later task depends on these exact names.

- [ ] **Step 1: Add the enum, model, and relation field**

Append to `prisma/schema.prisma`:

```prisma
enum VarianceStatus {
  MATCHED
  UNDER_PAID
  OVER_PAID
  NO_DEDUCTION_FOUND
}

model RepaymentVariance {
  id             String         @id @default(uuid())
  loanId         String
  loan           Loan           @relation(fields: [loanId], references: [id])
  period         String
  expectedAmount Decimal
  actualAmount   Decimal
  variance       Decimal
  status         VarianceStatus
  generatedAt    DateTime       @default(now())

  @@unique([loanId, period])
}
```

Add one field inside the existing `Loan` model:

```prisma
  repaymentVariances RepaymentVariance[]
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_repayment_variance`
Expected: creates and applies `prisma/migrations/<timestamp>_add_repayment_variance/migration.sql`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Verify the generated client**

Run: `grep -n "MATCHED\|UNDER_PAID\|OVER_PAID\|NO_DEDUCTION_FOUND" src/generated/prisma/enums.ts`
Expected: all four status values present (per this codebase's Prisma 7 convention — enum values are re-exported from `enums.ts`, not the per-model file).

- [ ] **Step 5: Add and seed the `reconciliation:read` permission**

In `prisma/seed.ts`, add one entry to the `BOOTSTRAP_PERMISSIONS` array:

```typescript
  { key: 'reconciliation:read', description: 'View loan repayment reconciliation variances' },
```

Run: `npx prisma db seed`
Expected: the new permission is upserted and, per the seed script's existing loop, automatically attached to the `SUPER_ADMIN` role (which the bootstrap admin holds) — this step is required for Task 7's e2e test to pass, since new permissions only take effect once the seed script runs again against the shared database.

- [ ] **Step 6: Type-check the project**

Run: `npx tsc --noEmit`
Expected: no errors (both changes are additive).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations prisma/seed.ts
git commit -m "feat: add RepaymentVariance model and reconciliation:read permission"
```

---

### Task 2: Amortization function

**Files:**
- Create: `src/reconciliation/amortization.util.ts`
- Test: `src/reconciliation/amortization.util.spec.ts`

**Interfaces:**
- Produces: `computeExpectedInstallment(loanAmount: number, interestRatePercent: number, disbursementDate: Date, maturationDate: Date): number` — Task 3's `ReconciliationService` consumes this.

- [ ] **Step 1: Write the failing tests**

`src/reconciliation/amortization.util.spec.ts`:

```typescript
import { computeExpectedInstallment } from './amortization.util';

describe('computeExpectedInstallment', () => {
  it('divides the principal evenly across the term when the rate is 0%', () => {
    const result = computeExpectedInstallment(120000, 0, new Date('2025-01-01'), new Date('2026-01-01'));
    expect(result).toBeCloseTo(10000, 2);
  });

  it('matches the exact single-period formula (principal plus one month of interest)', () => {
    const result = computeExpectedInstallment(100000, 12, new Date('2025-01-01'), new Date('2025-02-01'));
    expect(result).toBeCloseTo(101000, 2);
  });

  it('produces a higher installment than the zero-rate case when interest applies', () => {
    const zeroRate = computeExpectedInstallment(1200000, 0, new Date('2025-01-01'), new Date('2026-01-01'));
    const withRate = computeExpectedInstallment(1200000, 12, new Date('2025-01-01'), new Date('2026-01-01'));
    expect(withRate).toBeGreaterThan(zeroRate);
  });

  it('returns the full loan amount for a zero-length term', () => {
    const result = computeExpectedInstallment(50000, 10, new Date('2025-01-01'), new Date('2025-01-01'));
    expect(result).toBe(50000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/reconciliation/amortization.util.spec.ts`
Expected: FAIL — `Cannot find module './amortization.util'`.

- [ ] **Step 3: Implement the function**

`src/reconciliation/amortization.util.ts`:

```typescript
function monthsBetween(start: Date, end: Date): number {
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

export function computeExpectedInstallment(
  loanAmount: number,
  interestRatePercent: number,
  disbursementDate: Date,
  maturationDate: Date,
): number {
  const termMonths = monthsBetween(disbursementDate, maturationDate);
  if (termMonths <= 0) {
    return loanAmount;
  }

  const monthlyRate = interestRatePercent / 100 / 12;
  if (monthlyRate === 0) {
    return loanAmount / termMonths;
  }

  const factor = Math.pow(1 + monthlyRate, termMonths);
  return (loanAmount * monthlyRate * factor) / (factor - 1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/reconciliation/amortization.util.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/amortization.util.ts src/reconciliation/amortization.util.spec.ts
git commit -m "feat: add amortization function for loan reconciliation"
```

---

### Task 3: `ReconciliationService`

**Files:**
- Create: `src/reconciliation/reconciliation.service.ts`
- Test: `src/reconciliation/reconciliation.service.spec.ts`

**Interfaces:**
- Consumes: `computeExpectedInstallment` (Task 2), `PrismaService`.
- Produces: `ReconciliationService.reconcileAll(): Promise<void>`, `ReconciliationService.list(filters: { agency?: string; status?: VarianceStatus; period?: string })` — Task 4's processor consumes `reconcileAll`, Task 5's controller consumes `list`.

- [ ] **Step 1: Write the failing tests**

`src/reconciliation/reconciliation.service.spec.ts`:

```typescript
import { ReconciliationService } from './reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';
import { VarianceStatus } from '../generated/prisma/client';

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let prisma: {
    loan: { findMany: jest.Mock };
    loanRepaymentRecord: { findMany: jest.Mock };
    repaymentVariance: { upsert: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      loan: { findMany: jest.fn() },
      loanRepaymentRecord: { findMany: jest.fn() },
      repaymentVariance: { upsert: jest.fn().mockResolvedValue(undefined), findMany: jest.fn() },
    };
    service = new ReconciliationService(prisma as unknown as PrismaService);
  });

  describe('reconcileAll', () => {
    const baseLoan = {
      id: 'loan-1',
      agency: 'NPF',
      ippisNumber: 'NPF-001',
      loanAmount: 100000,
      interestRatePercent: 12,
      disbursementDate: new Date('2025-01-01'),
      maturationDate: new Date('2025-02-01'),
    };

    it('skips a loan with no agency', async () => {
      prisma.loan.findMany.mockResolvedValue([{ ...baseLoan, agency: null }]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).not.toHaveBeenCalled();
    });

    it('marks MATCHED when the actual amount is within the ₦1 tolerance of the expected installment', async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'NPF', staffId: 'NPF-001', period: '2025-01', amount: 101000 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { loanId_period: { loanId: 'loan-1', period: '2025-01' } },
          create: expect.objectContaining({
            status: VarianceStatus.MATCHED,
            expectedAmount: 101000,
            actualAmount: 101000,
            variance: 0,
          }),
        }),
      );
    });

    it('marks UNDER_PAID when the actual amount falls short beyond tolerance', async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'NPF', staffId: 'NPF-001', period: '2025-01', amount: 50000 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ status: VarianceStatus.UNDER_PAID }) }),
      );
    });

    it('marks OVER_PAID when the actual amount exceeds the expected installment beyond tolerance', async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'NPF', staffId: 'NPF-001', period: '2025-01', amount: 150000 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ status: VarianceStatus.OVER_PAID }) }),
      );
    });

    it('marks NO_DEDUCTION_FOUND for a period within the loan term that has no matching repayment rows', async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'OTHER_AGENCY', staffId: 'X', period: '2025-01', amount: 999 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { loanId_period: { loanId: 'loan-1', period: '2025-01' } },
          create: expect.objectContaining({ status: VarianceStatus.NO_DEDUCTION_FOUND, actualAmount: 0 }),
        }),
      );
    });

    it("excludes periods outside the loan's disbursement-to-maturation range", async () => {
      prisma.loan.findMany.mockResolvedValue([baseLoan]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([
        { agency: 'NPF', staffId: 'NPF-001', period: '2024-06', amount: 101000 },
      ]);

      await service.reconcileAll();

      expect(prisma.repaymentVariance.upsert).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('applies agency, status, and period filters', async () => {
      prisma.repaymentVariance.findMany.mockResolvedValue([]);

      await service.list({ agency: 'NPF', status: VarianceStatus.UNDER_PAID, period: '2025-01' });

      expect(prisma.repaymentVariance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: VarianceStatus.UNDER_PAID, period: '2025-01', loan: { agency: 'NPF' } },
        }),
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/reconciliation/reconciliation.service.spec.ts`
Expected: FAIL — `Cannot find module './reconciliation.service'`.

- [ ] **Step 3: Implement the service**

`src/reconciliation/reconciliation.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeExpectedInstallment } from './amortization.util';
import { VarianceStatus } from '../generated/prisma/client';

const MATCH_TOLERANCE = 1;

function toPeriodKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export interface ReconciliationFilters {
  agency?: string;
  status?: VarianceStatus;
  period?: string;
}

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async reconcileAll(): Promise<void> {
    const loans = await this.prisma.loan.findMany();
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

    for (const loan of loans) {
      if (!loan.agency) {
        continue;
      }

      const disbursementPeriod = toPeriodKey(loan.disbursementDate);
      const maturationPeriod = toPeriodKey(loan.maturationDate);
      const applicablePeriods = allPeriods.filter(
        (period) => period >= disbursementPeriod && period <= maturationPeriod,
      );
      if (applicablePeriods.length === 0) {
        continue;
      }

      const expectedAmount = computeExpectedInstallment(
        Number(loan.loanAmount),
        Number(loan.interestRatePercent),
        loan.disbursementDate,
        loan.maturationDate,
      );

      const loanKey = `${loan.agency}::${loan.ippisNumber}`;
      const periodMap = totalsByLoanKey.get(loanKey) ?? new Map<string, number>();

      for (const period of applicablePeriods) {
        const actualAmount = periodMap.get(period) ?? 0;
        const variance = actualAmount - expectedAmount;
        const status = this.classify(actualAmount, variance);

        await this.prisma.repaymentVariance.upsert({
          where: { loanId_period: { loanId: loan.id, period } },
          create: { loanId: loan.id, period, expectedAmount, actualAmount, variance, status },
          update: { expectedAmount, actualAmount, variance, status },
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

  async list(filters: ReconciliationFilters) {
    return this.prisma.repaymentVariance.findMany({
      where: {
        status: filters.status,
        period: filters.period,
        loan: filters.agency ? { agency: filters.agency } : undefined,
      },
      include: { loan: true },
      orderBy: { generatedAt: 'desc' },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/reconciliation/reconciliation.service.spec.ts`
Expected: PASS — 7 tests (6 under `reconcileAll` + 1 under `list` — recount against the literal test file above before treating any other number as correct).

- [ ] **Step 5: Commit**

```bash
git add src/reconciliation/reconciliation.service.ts src/reconciliation/reconciliation.service.spec.ts
git commit -m "feat: add ReconciliationService"
```

---

### Task 4: Wire reconciliation into `DocumentIngestionProcessor`

**Files:**
- Modify: `src/document-ingestion/document-ingestion.processor.ts`
- Modify: `src/document-ingestion/document-ingestion.processor.spec.ts`

**Interfaces:**
- Consumes: `ReconciliationService.reconcileAll` (Task 3).

- [ ] **Step 1: Update the failing tests**

Read `src/document-ingestion/document-ingestion.processor.spec.ts` in full first (shown in this plan's investigation — it currently constructs the processor with 3 args and has 3 tests). Replace the whole file with:

```typescript
import { Job } from 'bullmq';
import { DocumentIngestionProcessor, DocumentIngestionJobData } from './document-ingestion.processor';
import { DocumentBatchService } from './document-batch.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentParser } from './document-parser.interface';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { DocumentType } from '../generated/prisma/client';

describe('DocumentIngestionProcessor', () => {
  let processor: DocumentIngestionProcessor;
  let documentBatchService: {
    findById: jest.Mock;
    markProcessing: jest.Mock;
    markCompleted: jest.Mock;
    markFailed: jest.Mock;
  };
  let fileStorageProvider: { getObject: jest.Mock };
  let parsers: Record<string, { parse: jest.Mock }>;
  let reconciliationService: { reconcileAll: jest.Mock };

  beforeEach(() => {
    documentBatchService = {
      findById: jest.fn(),
      markProcessing: jest.fn(),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
    };
    fileStorageProvider = { getObject: jest.fn() };
    parsers = {
      [DocumentType.IPPIS_BROADSHEET]: { parse: jest.fn() },
      [DocumentType.DISBURSED_LOANS]: { parse: jest.fn() },
      [DocumentType.REPAYMENT_SCHEDULE]: { parse: jest.fn() },
    };
    reconciliationService = { reconcileAll: jest.fn().mockResolvedValue(undefined) };
    processor = new DocumentIngestionProcessor(
      documentBatchService as unknown as DocumentBatchService,
      fileStorageProvider as unknown as FileStorageProvider,
      parsers as unknown as Record<DocumentType, DocumentParser>,
      reconciliationService as unknown as ReconciliationService,
    );
  });

  it('logs and returns early when the batch is not found', async () => {
    documentBatchService.findById.mockResolvedValue(null);
    await processor.process({ data: { batchId: 'missing' } } as Job<DocumentIngestionJobData>);
    expect(documentBatchService.markProcessing).not.toHaveBeenCalled();
  });

  it('marks processing, dispatches to the matching parser, and marks completed on success, without running reconciliation for IPPIS_BROADSHEET', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-1',
      documentType: DocumentType.IPPIS_BROADSHEET,
      storageKey: 'uploads/file.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.IPPIS_BROADSHEET].parse.mockResolvedValue({
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });

    await processor.process({ data: { batchId: 'batch-1' } } as Job<DocumentIngestionJobData>);

    expect(documentBatchService.markProcessing).toHaveBeenCalledWith('batch-1');
    expect(parsers[DocumentType.IPPIS_BROADSHEET].parse).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'batch-1' }),
      Buffer.from('fake-file'),
    );
    expect(reconciliationService.reconcileAll).not.toHaveBeenCalled();
    expect(documentBatchService.markCompleted).toHaveBeenCalledWith('batch-1', {
      rowsProcessed: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });
  });

  it('runs reconciliation after a successful DISBURSED_LOANS parse', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-2',
      documentType: DocumentType.DISBURSED_LOANS,
      storageKey: 'uploads/loans.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.DISBURSED_LOANS].parse.mockResolvedValue({
      rowsProcessed: 1,
      rowsCreated: 1,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });

    await processor.process({ data: { batchId: 'batch-2' } } as Job<DocumentIngestionJobData>);

    expect(reconciliationService.reconcileAll).toHaveBeenCalledTimes(1);
    expect(documentBatchService.markCompleted).toHaveBeenCalled();
  });

  it('runs reconciliation after a successful REPAYMENT_SCHEDULE parse', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-3',
      documentType: DocumentType.REPAYMENT_SCHEDULE,
      storageKey: 'uploads/repayments.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.REPAYMENT_SCHEDULE].parse.mockResolvedValue({
      rowsProcessed: 1,
      rowsCreated: 1,
      rowsUpdated: 0,
      rowsSkipped: 0,
      warnings: [],
    });

    await processor.process({ data: { batchId: 'batch-3' } } as Job<DocumentIngestionJobData>);

    expect(reconciliationService.reconcileAll).toHaveBeenCalledTimes(1);
  });

  it('marks failed with the error message when the parser throws, without running reconciliation', async () => {
    documentBatchService.findById.mockResolvedValue({
      id: 'batch-1',
      documentType: DocumentType.IPPIS_BROADSHEET,
      storageKey: 'uploads/file.xlsx',
    });
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('fake-file'));
    parsers[DocumentType.IPPIS_BROADSHEET].parse.mockRejectedValue(new Error('bad file'));

    await processor.process({ data: { batchId: 'batch-1' } } as Job<DocumentIngestionJobData>);

    expect(documentBatchService.markFailed).toHaveBeenCalledWith('batch-1', 'bad file');
    expect(reconciliationService.reconcileAll).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/document-ingestion/document-ingestion.processor.spec.ts`
Expected: FAIL — constructor arity mismatch (`Expected 4 arguments, but got 4` won't be the error; rather the processor's actual constructor still only takes 3, so TypeScript will error on passing a 4th argument the class doesn't declare) and `reconciliationService.reconcileAll` is never called for the new tests.

- [ ] **Step 3: Update `DocumentIngestionProcessor`**

Replace `src/document-ingestion/document-ingestion.processor.ts` with:

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DOCUMENT_INGESTION_QUEUE } from './document-ingestion-queue.constants';
import { DocumentBatchService } from './document-batch.service';
import { DOCUMENT_PARSERS, DocumentParser } from './document-parser.interface';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { DocumentType } from '../generated/prisma/client';

export interface DocumentIngestionJobData {
  batchId: string;
}

const RECONCILIATION_TRIGGER_TYPES: DocumentType[] = [DocumentType.DISBURSED_LOANS, DocumentType.REPAYMENT_SCHEDULE];

@Processor(DOCUMENT_INGESTION_QUEUE)
export class DocumentIngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(DocumentIngestionProcessor.name);

  constructor(
    private readonly documentBatchService: DocumentBatchService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
    @Inject(DOCUMENT_PARSERS) private readonly parsers: Record<DocumentType, DocumentParser>,
    private readonly reconciliationService: ReconciliationService,
  ) {
    super();
  }

  async process(job: Job<DocumentIngestionJobData>): Promise<void> {
    const { batchId } = job.data;
    const batch = await this.documentBatchService.findById(batchId);

    if (!batch) {
      this.logger.error(`Batch ${batchId} not found`);
      return;
    }

    await this.documentBatchService.markProcessing(batchId);

    try {
      const fileBuffer = await this.fileStorageProvider.getObject(batch.storageKey);
      const parser = this.parsers[batch.documentType];
      const result = await parser.parse(batch, fileBuffer);

      if (RECONCILIATION_TRIGGER_TYPES.includes(batch.documentType)) {
        await this.reconciliationService.reconcileAll();
      }

      await this.documentBatchService.markCompleted(batchId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch ${batchId} failed: ${message}`);
      await this.documentBatchService.markFailed(batchId, message);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/document-ingestion/document-ingestion.processor.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/document-ingestion/document-ingestion.processor.ts src/document-ingestion/document-ingestion.processor.spec.ts
git commit -m "feat: run reconciliation after disbursed-loans and repayment-schedule uploads"
```

---

### Task 5: `GET /admin/reconciliation`

**Files:**
- Create: `src/reconciliation/admin-reconciliation.controller.ts`
- Create: `src/reconciliation/reconciliation.module.ts`
- Modify: `src/document-ingestion/document-ingestion.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `ReconciliationService` (Task 3).
- Produces: `GET /admin/reconciliation`.

There is no dedicated unit test for this controller in this step — it's a thin pass-through to `ReconciliationService.list` (already unit-tested in Task 3), matching this codebase's convention of not duplicating coverage for trivial controller pass-throughs when the e2e test (Task 7) exercises the real route.

- [ ] **Step 1: Implement the controller**

`src/reconciliation/admin-reconciliation.controller.ts`:

```typescript
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ReconciliationService } from './reconciliation.service';
import { VarianceStatus } from '../generated/prisma/client';

@Controller('admin/reconciliation')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Get()
  @RequirePermissions('reconciliation:read')
  list(
    @Query('agency') agency?: string,
    @Query('status') status?: VarianceStatus,
    @Query('period') period?: string,
  ) {
    return this.reconciliationService.list({ agency, status, period });
  }
}
```

- [ ] **Step 2: Implement the module and wire it into `AppModule` and `DocumentIngestionModule`**

`src/reconciliation/reconciliation.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { AdminReconciliationController } from './admin-reconciliation.controller';

@Module({
  controllers: [AdminReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
```

Modify `src/document-ingestion/document-ingestion.module.ts`: add `import { ReconciliationModule } from '../reconciliation/reconciliation.module';` and add `ReconciliationModule` to the `imports` array (so `DocumentIngestionProcessor` can inject `ReconciliationService`, per Task 4).

Modify `src/app.module.ts`: add `import { ReconciliationModule } from './reconciliation/reconciliation.module';` and add `ReconciliationModule` to the `imports` array (explicit, matching this codebase's convention of listing every feature module directly in `AppModule` rather than relying on transitive registration through `DocumentIngestionModule`).

- [ ] **Step 3: Type-check and run the full unit suite**

Run: `npx jest src/reconciliation src/document-ingestion && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/reconciliation/admin-reconciliation.controller.ts src/reconciliation/reconciliation.module.ts src/document-ingestion/document-ingestion.module.ts src/app.module.ts
git commit -m "feat: add GET /admin/reconciliation"
```

---

### Task 6: `GET /admin/loans` and `GET /admin/ippis-records`

**Files:**
- Create: `src/admin-catalog/admin-catalog.service.ts`
- Test: `src/admin-catalog/admin-catalog.service.spec.ts`
- Create: `src/admin-catalog/admin-loans.controller.ts`
- Create: `src/admin-catalog/admin-ippis-records.controller.ts`
- Create: `src/admin-catalog/admin-catalog.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `GET /admin/loans`, `GET /admin/ippis-records`, `AdminCatalogService.listLoans(agency?)`, `.listIppisRecords(agency?)`.

These two endpoints are part of the same already-approved design (§7) as the rest of this plan but were never assigned to any of the four prior ingestion plans — folded in here as the natural remaining completion of that design, not new scope.

- [ ] **Step 1: Write the failing tests**

`src/admin-catalog/admin-catalog.service.spec.ts`:

```typescript
import { AdminCatalogService } from './admin-catalog.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminCatalogService', () => {
  let service: AdminCatalogService;
  let prisma: { loan: { findMany: jest.Mock }; ippisRecord: { findMany: jest.Mock } };

  beforeEach(() => {
    prisma = { loan: { findMany: jest.fn() }, ippisRecord: { findMany: jest.fn() } };
    service = new AdminCatalogService(prisma as unknown as PrismaService);
  });

  describe('listLoans', () => {
    it('lists every loan when no agency filter is given', async () => {
      prisma.loan.findMany.mockResolvedValue([]);
      await service.listLoans();
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('filters by agency when given', async () => {
      prisma.loan.findMany.mockResolvedValue([]);
      await service.listLoans('NPF');
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: 'NPF' } }),
      );
    });
  });

  describe('listIppisRecords', () => {
    it('lists every record when no agency filter is given', async () => {
      prisma.ippisRecord.findMany.mockResolvedValue([]);
      await service.listIppisRecords();
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('filters by agency when given', async () => {
      prisma.ippisRecord.findMany.mockResolvedValue([]);
      await service.listIppisRecords('NSCDC');
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: 'NSCDC' } }),
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/admin-catalog/admin-catalog.service.spec.ts`
Expected: FAIL — `Cannot find module './admin-catalog.service'`.

- [ ] **Step 3: Implement the service, controllers, and module**

`src/admin-catalog/admin-catalog.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listLoans(agency?: string) {
    return this.prisma.loan.findMany({
      where: agency ? { agency } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async listIppisRecords(agency?: string) {
    return this.prisma.ippisRecord.findMany({
      where: agency ? { agency } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }
}
```

`src/admin-catalog/admin-loans.controller.ts`:

```typescript
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AdminCatalogService } from './admin-catalog.service';

@Controller('admin/loans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminLoansController {
  constructor(private readonly adminCatalogService: AdminCatalogService) {}

  @Get()
  @RequirePermissions('loans:upload')
  list(@Query('agency') agency?: string) {
    return this.adminCatalogService.listLoans(agency);
  }
}
```

`src/admin-catalog/admin-ippis-records.controller.ts`:

```typescript
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AdminCatalogService } from './admin-catalog.service';

@Controller('admin/ippis-records')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminIppisRecordsController {
  constructor(private readonly adminCatalogService: AdminCatalogService) {}

  @Get()
  @RequirePermissions('ippis:upload')
  list(@Query('agency') agency?: string) {
    return this.adminCatalogService.listIppisRecords(agency);
  }
}
```

`src/admin-catalog/admin-catalog.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AdminCatalogService } from './admin-catalog.service';
import { AdminLoansController } from './admin-loans.controller';
import { AdminIppisRecordsController } from './admin-ippis-records.controller';

@Module({
  controllers: [AdminLoansController, AdminIppisRecordsController],
  providers: [AdminCatalogService],
})
export class AdminCatalogModule {}
```

Modify `src/app.module.ts`: add `import { AdminCatalogModule } from './admin-catalog/admin-catalog.module';` and add `AdminCatalogModule` to the `imports` array.

- [ ] **Step 4: Run tests to verify they pass, and type-check**

Run: `npx jest src/admin-catalog && npx tsc --noEmit`
Expected: PASS — 4 tests, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/admin-catalog src/app.module.ts
git commit -m "feat: add GET /admin/loans and GET /admin/ippis-records"
```

---

### Task 7: e2e test, README, and Postman

**Files:**
- Test: `test/reconciliation.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`
- Modify: `postman/README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-6.

- [ ] **Step 1: Write the e2e test**

Read `test/disbursed-loans-ingestion.e2e-spec.ts` and `test/repayment-schedule-ingestion.e2e-spec.ts` in full first for this codebase's exact `buildLoansBuffer`/`buildRepaymentScheduleBuffer`/`waitForBatchCompletion` conventions (both already shown in this plan's own investigation). This new test uploads one disbursed-loans file and one repayment-schedule file for the *same* staff identifier, so the two rows genuinely match for reconciliation, then checks `GET /admin/reconciliation` for the resulting variance.

`test/reconciliation.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const LOAN_HEADERS = [
  'Customer ID', 'Customer Name', 'Account No.', 'Loan Amount', 'Principal Bal.',
  'Disbursement Date', 'Maturation Date', 'Product', 'Interest Rate', 'IPPIS',
];

async function buildLoanBuffer(customerId: string, ippisNumber: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');
  sheet.addRow(['TEST BANK']);
  sheet.addRow(['Title:', 'Disbursed Loans Report']);
  sheet.addRow([]);
  sheet.addRow(LOAN_HEADERS);
  sheet.addRow([
    customerId, 'E2E Reconciliation Customer', 'ACC-E2E-RECON', 100000, 100000,
    '01-Jan-2025', '01-Feb-2025', 'TEST PRODUCT', 12, ippisNumber,
  ]);
  return workbook.xlsx.writeBuffer() as unknown as Buffer;
}

async function buildRepaymentScheduleBuffer(ippisNumber: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const nscdcSheet = workbook.addWorksheet('NSCDC');
  nscdcSheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
  nscdcSheet.addRow(['E2E Reconciliation Customer', ippisNumber, 101000]);
  return workbook.xlsx.writeBuffer() as unknown as Buffer;
}

async function waitForBatchCompletion(prisma: PrismaService, batchId: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const batch = await prisma.documentUploadBatch.findUnique({ where: { id: batchId } });
    if (batch && (batch.status === 'COMPLETED' || batch.status === 'FAILED')) {
      return batch;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Batch ${batchId} did not finish within ${timeoutMs}ms`);
}

describe('Reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const customerId = `E2E-RECON-CUST-${Date.now()}`;
  const ippisNumber = `CD-E2E-RECON-${Date.now()}`;

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
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    const loan = await prisma.loan.findUnique({ where: { customerId } });
    if (loan) {
      await prisma.repaymentVariance.deleteMany({ where: { loanId: loan.id } });
    }
    await prisma.loan.deleteMany({ where: { customerId } });
    await prisma.loanRepaymentRecord.deleteMany({ where: { staffId: ippisNumber } });
    await app.close();
  });

  it(
    'reconciles a matching loan and repayment record after both uploads complete',
    async () => {
      const loanBuffer = await buildLoanBuffer(customerId, ippisNumber);
      const loanUploadRes = await request(app.getHttpServer())
        .post('/admin/documents/disbursed-loans/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .attach('file', loanBuffer, 'loans.xlsx')
        .expect(201);
      await waitForBatchCompletion(prisma, loanUploadRes.body.id);

      const repaymentBuffer = await buildRepaymentScheduleBuffer(ippisNumber);
      const repaymentUploadRes = await request(app.getHttpServer())
        .post('/admin/documents/repayment-schedule/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .field('period', '2025-01')
        .attach('file', repaymentBuffer, 'repayments.xlsx')
        .expect(201);
      const repaymentBatch = await waitForBatchCompletion(prisma, repaymentUploadRes.body.id);
      expect(repaymentBatch!.status).toBe('COMPLETED');

      const listRes = await request(app.getHttpServer())
        .get('/admin/reconciliation')
        .query({ agency: 'NSCDC', period: '2025-01' })
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const variance = listRes.body.find(
        (v: { loan: { customerId: string } }) => v.loan.customerId === customerId,
      );
      expect(variance).toBeDefined();
      expect(variance.status).toBe('MATCHED');
      expect(Number(variance.expectedAmount)).toBeCloseTo(101000, 2);
      expect(Number(variance.actualAmount)).toBe(101000);
    },
    30000,
  );
});
```

Note the explicit `30000`ms per-test timeout (Jest's third `it()` argument) — this test does two full upload-and-wait cycles plus two full-table reconciliation recomputes, strictly more work than any single existing ingestion e2e test, so the default 5000ms timeout is too tight.

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/reconciliation.e2e-spec.ts --runInBand`
Expected: PASS — 1 test. If it fails with a `403` on the final `GET /admin/reconciliation` call, Task 1 Step 5's `npx prisma db seed` run didn't take effect against the database this test suite actually points at — re-run it against the correct `DATABASE_URL` before re-running the test, don't work around it any other way.

- [ ] **Step 3: Update the README**

Add a new section to `README.md`, after the `## Document ingestion` section (grep for its exact heading first to confirm placement — this section documents the last piece of that same feature, so it belongs immediately after it, not at the end of the file with the newer client-facing features):

```markdown
## Reconciliation

After a `disbursed-loans` or `repayment-schedule` upload completes, the
system recomputes reconciliation across every `Loan` and its matching
`LoanRepaymentRecord` rows (matched via `agency`+IPPIS number, same as
the client loan dashboard) — a full idempotent recompute rather than one
scoped to the triggering upload, upserted by `(loanId, period)`. For each
period within a loan's disbursement-to-maturation range, the expected
installment (standard reducing-balance amortization from `loanAmount`,
`interestRatePercent`, and the loan term) is compared against the actual
summed deductions for that period: `MATCHED` (within a ₦1 tolerance),
`UNDER_PAID`, `OVER_PAID`, or `NO_DEDUCTION_FOUND` (no matching repayment
rows at all for that period). `GET /admin/reconciliation`
(`reconciliation:read`) lists variances, filterable by `agency`/`status`/
`period`. `GET /admin/loans` (`loans:upload`) and
`GET /admin/ippis-records` (`ippis:upload`) provide basic
listing/filtering by `agency` over the underlying ingested tables.
```

- [ ] **Step 4: Add Postman coverage**

Read `postman/README.md`'s "Folder structure" section first. In `postman/public-sector-backend.postman_collection.json`, under the top-level **Admin** folder, add a new sub-folder `"Reconciliation & Catalog"` (alongside the existing `Documents` sub-folder, since these are closely related to document ingestion but are their own controllers) with requests for:
- `GET /admin/reconciliation - Success` (with `agency`/`status`/`period` query params)
- `GET /admin/reconciliation - Missing permission (403)`
- `GET /admin/loans - Success`
- `GET /admin/ippis-records - Success`

Every request needs a saved response example per the standing `CLAUDE.md` rule — author each from the actual controller/service code (Nest's default exception shape for the 403 case: `{statusCode, message, error}`, reusing the already-established `PermissionsGuard` 403 shape from elsewhere in the collection). Use a surgical text-based insert (not a full JSON re-parse/re-dump), per this codebase's established practice.

- [ ] **Step 5: Validate the JSON and update `postman/README.md`**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

Add "Reconciliation & Catalog" to the Admin bullet in `postman/README.md`'s "Folder structure" section.

- [ ] **Step 6: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including everything from this plan. If any single pre-existing, unrelated suite flakes on a timeout under the full serialized run, re-run just that suite in isolation to confirm it passes cleanly before treating it as a real regression — this codebase has known pre-existing environmental e2e flakiness under load, unrelated to any specific feature.

- [ ] **Step 7: Commit**

```bash
git add test/reconciliation.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json postman/README.md
git commit -m "feat: add reconciliation e2e coverage and docs"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state.
- [ ] Uploading a disbursed-loans report and a matching repayment-schedule report for the same staff member produces a `MATCHED` `RepaymentVariance` row visible via `GET /admin/reconciliation` — proven by the e2e test.
- [ ] The amortization function is independently correct against hand-verified values — proven by the unit tests.
- [ ] A loan with no `agency` is skipped by reconciliation, and periods outside a loan's disbursement-to-maturation range are never reconciled — proven by the unit tests.
- [ ] `GET /admin/loans` and `GET /admin/ippis-records` provide basic agency-filterable listings over the already-ingested tables.
- [ ] Postman has coverage for all four new endpoints under Admin > Reconciliation & Catalog.
