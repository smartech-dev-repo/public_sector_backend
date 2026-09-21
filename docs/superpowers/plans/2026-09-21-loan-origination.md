# Loan Origination Implementation Plan (Loan Lifecycle Overhaul — B1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the request → confirm → approve → disburse pipeline that turns a `LoanRequest` into a real, trackable `ClientLoan`, backed by an admin-managed, agency-scoped loan terms catalog, with a single-active-loan rule enforced at request time.

**Architecture:** A new `src/loan-terms/` module (admin CRUD + client lookup for `LoanTermOption`). A new `NoActiveLoanRule` added to the existing `src/loan-request/eligibility/` rule chain, reusing `ClientLoansService.getDashboard()` (already shipped) rather than duplicating its BVN-cross-check/status logic. `LoanRequestService` (existing) is extended with tenor validation, a rate/charge snapshot at request time, an auto-approve/disburse threshold check, and new approve/reject/disburse/list methods, all reachable through a new `AdminLoanRequestController` alongside the existing client-facing one. `ClientLoan` creation is a single shared private method called from both the auto-approval path and the manual admin `disburse` action.

**Tech Stack:** NestJS 10, Prisma 7, Jest, class-validator.

**Spec:** `docs/superpowers/specs/2026-09-21-loan-origination-design.md`

## Global Constraints

- `LoanTermOption` is scoped by `agency` + `tenorMonths` (`@@unique`); options are deactivated (`isActive: false`), never deleted (spec §2).
- A `LoanRequest`'s rate/charge fields are a **snapshot** taken at creation time from the matched `LoanTermOption` — never re-derived later (spec §3).
- Status flow: `PENDING` → `CONFIRMED` (unchanged) → below `LOAN_AUTO_APPROVE_THRESHOLD`: `APPROVED`+`DISBURSED` fire together instantly on confirmation; at/above threshold: stays `CONFIRMED` until a manual admin `approve`/`reject`, then a separate manual `disburse` (spec §3).
- A `ClientLoan` is created exactly once, on the transition into `DISBURSED`, via one shared private method regardless of which path triggered it (spec §4).
- The single-active-loan rule blocks a new `LoanRequest` if the client has any non-terminal `LoanRequest`, an `ACTIVE` `ClientLoan`, **or** an `ACTIVE` loan in their ingested bank history — reusing `ClientLoansService.getDashboard()`/`computeLoanStatus()` unchanged, not reimplemented (spec §4).
- `EligibilityRule.check()`'s return type widens to `Promise<EligibilityCheckResult> | EligibilityCheckResult` — a non-breaking change; the two existing synchronous rules are untouched (spec §4).
- Three new permission keys added to `BOOTSTRAP_PERMISSIONS`: `loan-terms:manage`, `loan-requests:review`, `client-loans:read` (spec §6).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the API-surface changes, with a saved response example per request.
- Per this session's standing testing preference: run only the test file(s) relevant to what changed in each task — never the full suite for any task in this plan, including its last one. This plan is B1 of a four-part phase (B2 topup, B3 repayment tracking, B4 spend-wallet still to come); a full suite run only happens at the end of the whole phase or when explicitly requested, not at the end of this individual plan.

---

### Task 1: Schema and permissions

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: `ManagementChargeType` (`PERCENTAGE`/`FLAT`), `ManagementChargeApplication` (`DEDUCT_FROM_DISBURSEMENT`/`ADD_TO_REPAYMENT`), `LoanTermOption`, expanded `LoanRequestStatus` (`PENDING`/`CONFIRMED`/`APPROVED`/`DISBURSED`/`REJECTED`/`FAILED`), new `LoanRequest` fields, `ClientLoanStatus` (`ACTIVE`/`CLOSED`/`DEFAULT`), `ClientLoan` — every later task depends on these exact names. Permission keys `loan-terms:manage`/`loan-requests:review`/`client-loans:read`.

- [ ] **Step 1: Add the new enums and `LoanTermOption` model**

In `prisma/schema.prisma`, add (e.g. near `LoanRequest`):

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

- [ ] **Step 2: Expand `LoanRequestStatus` and add the new `LoanRequest` fields**

Replace the existing `enum LoanRequestStatus { PENDING CONFIRMED FAILED }` with:

```prisma
enum LoanRequestStatus {
  PENDING
  CONFIRMED
  APPROVED
  DISBURSED
  REJECTED
  FAILED
}
```

Add these fields to the existing `LoanRequest` model (alongside `amount`/`status`/etc.):

```prisma
  tenorMonths                  Int
  interestRatePercent          Decimal
  managementChargeType         ManagementChargeType
  managementChargeValue        Decimal
  managementChargeApplication  ManagementChargeApplication
  managementChargeAmount       Decimal
  rejectionReason               String?
  approvedAt                    DateTime?
  disbursedAt                   DateTime?
```

Add the reverse relation to `LoanRequest`:

```prisma
  clientLoan                    ClientLoan?
```

- [ ] **Step 3: Add `ClientLoanStatus` and `ClientLoan`**

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
  disbursementDate                 DateTime
  maturationDate                    DateTime
  status                            ClientLoanStatus            @default(ACTIVE)
  createdAt                         DateTime                    @default(now())
  updatedAt                         DateTime                    @updatedAt
}
```

Add the inverse relation to the existing `Client` model (alongside `onboarding`/`loanRequests`/`walletEntries`):

```prisma
  clientLoans ClientLoan[]
```

- [ ] **Step 4: Generate and run the migration**

Run: `npx prisma migrate dev --name add_loan_origination`
Expected: creates and applies `prisma/migrations/<timestamp>_add_loan_origination/migration.sql`.

- [ ] **Step 5: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 6: Add the permission keys**

In `prisma/seed.ts`, add to `BOOTSTRAP_PERMISSIONS` (after the `wallets:manage` entry added by the wallet plan):

```typescript
  { key: 'loan-terms:manage', description: "Create/edit the agency-scoped loan terms catalog" },
  { key: 'loan-requests:review', description: 'Approve, reject, or disburse client loan requests' },
  { key: 'client-loans:read', description: "View client loans and disbursement reports" },
```

- [ ] **Step 7: Apply the new permissions**

Run: `npx prisma db seed`
Expected: completes without error.

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (existing code that constructs a `LoanRequest`/references `LoanRequestStatus` may now show missing-field errors in test files — that's expected and fixed in later tasks, not this one; this step is just confirming the schema/client themselves compile).

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/seed.ts prisma/migrations
git commit -m "feat: add LoanTermOption/ClientLoan schema and loan origination permissions"
```

---

### Task 2: Loan Terms Catalog

**Files:**
- Create: `src/loan-terms/loan-terms.service.ts`
- Test: `src/loan-terms/loan-terms.service.spec.ts`
- Create: `src/loan-terms/dto/create-loan-term-option.dto.ts`
- Create: `src/loan-terms/dto/update-loan-term-option.dto.ts`
- Create: `src/loan-terms/admin-loan-terms.controller.ts`
- Create: `src/loan-terms/client-loan-terms.controller.ts`
- Create: `src/loan-terms/loan-terms.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `LoanTermOption`/`ManagementChargeType`/`ManagementChargeApplication` (Task 1).
- Produces: `LoanTermOptionService.create(input): Promise<LoanTermOption>`, `.list(agency?: string): Promise<LoanTermOption[]>`, `.update(id, input): Promise<LoanTermOption>`, `.listActiveForClient(clientId: string): Promise<LoanTermOption[]>` — Task 4's `LoanRequestService` consumes the underlying `LoanTermOption` rows directly via Prisma (not this service), but Task 4 depends on `LoanTermOption` rows existing, which this task's admin endpoints create.

- [ ] **Step 1: Write the failing tests**

`src/loan-terms/loan-terms.service.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { LoanTermOptionService } from './loan-terms.service';
import { PrismaService } from '../prisma/prisma.service';
import { ManagementChargeApplication, ManagementChargeType } from '../generated/prisma/client';

describe('LoanTermOptionService', () => {
  let service: LoanTermOptionService;
  let prisma: {
    loanTermOption: { create: jest.Mock; findMany: jest.Mock; update: jest.Mock; findUnique: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      loanTermOption: { create: jest.fn(), findMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
      clientOnboarding: { findUnique: jest.fn() },
    };
    service = new LoanTermOptionService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('creates a term option with the given fields', async () => {
      prisma.loanTermOption.create.mockResolvedValue({ id: 'term-1' });

      await service.create({
        agency: 'NPF',
        tenorMonths: 6,
        interestRatePercent: 5,
        managementChargeType: ManagementChargeType.PERCENTAGE,
        managementChargeValue: 2,
        managementChargeApplication: ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT,
      });

      expect(prisma.loanTermOption.create).toHaveBeenCalledWith({
        data: {
          agency: 'NPF',
          tenorMonths: 6,
          interestRatePercent: 5,
          managementChargeType: ManagementChargeType.PERCENTAGE,
          managementChargeValue: 2,
          managementChargeApplication: ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT,
        },
      });
    });
  });

  describe('list', () => {
    it('filters by agency when provided', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      await service.list('NPF');
      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith({ where: { agency: 'NPF' } });
    });

    it('lists everything when no agency is given', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      await service.list();
      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith({ where: { agency: undefined } });
    });
  });

  describe('update', () => {
    it('throws NotFoundException when the option does not exist', async () => {
      prisma.loanTermOption.findUnique.mockResolvedValue(null);
      await expect(service.update('missing', { isActive: false })).rejects.toThrow(NotFoundException);
    });

    it('updates the given fields', async () => {
      prisma.loanTermOption.findUnique.mockResolvedValue({ id: 'term-1' });
      prisma.loanTermOption.update.mockResolvedValue({ id: 'term-1', isActive: false });

      await service.update('term-1', { isActive: false });

      expect(prisma.loanTermOption.update).toHaveBeenCalledWith({
        where: { id: 'term-1' },
        data: { isActive: false },
      });
    });
  });

  describe('listActiveForClient', () => {
    it('returns an empty array when the client has no onboarding record', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      const result = await service.listActiveForClient('client-1');
      expect(result).toEqual([]);
      expect(prisma.loanTermOption.findMany).not.toHaveBeenCalled();
    });

    it('lists active options for the client\'s own agency', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      prisma.loanTermOption.findMany.mockResolvedValue([{ id: 'term-1' }]);

      const result = await service.listActiveForClient('client-1');

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith({ where: { agency: 'NPF', isActive: true } });
      expect(result).toEqual([{ id: 'term-1' }]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/loan-terms/loan-terms.service.spec.ts`
Expected: FAIL — `Cannot find module './loan-terms.service'`.

- [ ] **Step 3: Implement `LoanTermOptionService`**

`src/loan-terms/loan-terms.service.ts`:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanTermOption, ManagementChargeApplication, ManagementChargeType } from '../generated/prisma/client';

export interface CreateLoanTermOptionInput {
  agency: string;
  tenorMonths: number;
  interestRatePercent: number;
  managementChargeType: ManagementChargeType;
  managementChargeValue: number;
  managementChargeApplication: ManagementChargeApplication;
}

export interface UpdateLoanTermOptionInput {
  interestRatePercent?: number;
  managementChargeType?: ManagementChargeType;
  managementChargeValue?: number;
  managementChargeApplication?: ManagementChargeApplication;
  isActive?: boolean;
}

@Injectable()
export class LoanTermOptionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateLoanTermOptionInput): Promise<LoanTermOption> {
    return this.prisma.loanTermOption.create({ data: input });
  }

  async list(agency?: string): Promise<LoanTermOption[]> {
    return this.prisma.loanTermOption.findMany({ where: { agency } });
  }

  async update(id: string, input: UpdateLoanTermOptionInput): Promise<LoanTermOption> {
    const existing = await this.prisma.loanTermOption.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Loan term option not found');
    }
    return this.prisma.loanTermOption.update({ where: { id }, data: input });
  }

  async listActiveForClient(clientId: string): Promise<LoanTermOption[]> {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return [];
    }
    return this.prisma.loanTermOption.findMany({
      where: { agency: onboarding.ippisRecord.agency, isActive: true },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/loan-terms/loan-terms.service.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Add the DTOs**

`src/loan-terms/dto/create-loan-term-option.dto.ts`:

```typescript
import { IsEnum, IsInt, IsNumber, IsPositive, IsString, MinLength } from 'class-validator';
import { ManagementChargeApplication, ManagementChargeType } from '../../generated/prisma/client';

export class CreateLoanTermOptionDto {
  @IsString()
  @MinLength(1)
  agency: string;

  @IsInt()
  @IsPositive()
  tenorMonths: number;

  @IsNumber()
  @IsPositive()
  interestRatePercent: number;

  @IsEnum(ManagementChargeType)
  managementChargeType: ManagementChargeType;

  @IsNumber()
  @IsPositive()
  managementChargeValue: number;

  @IsEnum(ManagementChargeApplication)
  managementChargeApplication: ManagementChargeApplication;
}
```

`src/loan-terms/dto/update-loan-term-option.dto.ts`:

```typescript
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsPositive } from 'class-validator';
import { ManagementChargeApplication, ManagementChargeType } from '../../generated/prisma/client';

export class UpdateLoanTermOptionDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  interestRatePercent?: number;

  @IsOptional()
  @IsEnum(ManagementChargeType)
  managementChargeType?: ManagementChargeType;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  managementChargeValue?: number;

  @IsOptional()
  @IsEnum(ManagementChargeApplication)
  managementChargeApplication?: ManagementChargeApplication;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
```

- [ ] **Step 6: Add the admin controller**

`src/loan-terms/admin-loan-terms.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanTermOptionService } from './loan-terms.service';
import { CreateLoanTermOptionDto } from './dto/create-loan-term-option.dto';
import { UpdateLoanTermOptionDto } from './dto/update-loan-term-option.dto';

@Controller('admin/loan-terms')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('loan-terms:manage')
export class AdminLoanTermsController {
  constructor(private readonly loanTermOptionService: LoanTermOptionService) {}

  @Post()
  create(@Body() dto: CreateLoanTermOptionDto) {
    return this.loanTermOptionService.create(dto);
  }

  @Get()
  list(@Query('agency') agency?: string) {
    return this.loanTermOptionService.list(agency);
  }

  @Patch(':id')
  @HttpCode(200)
  update(@Param('id') id: string, @Body() dto: UpdateLoanTermOptionDto) {
    return this.loanTermOptionService.update(id, dto);
  }
}
```

- [ ] **Step 7: Add the client controller**

`src/loan-terms/client-loan-terms.controller.ts`:

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanTermOptionService } from './loan-terms.service';

@Controller('client/loan-terms')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoanTermsController {
  constructor(private readonly loanTermOptionService: LoanTermOptionService) {}

  @Get()
  list(@Req() req: { user: JwtPayload }) {
    return this.loanTermOptionService.listActiveForClient(req.user.sub);
  }
}
```

- [ ] **Step 8: Add the module and wire it into `AppModule`**

`src/loan-terms/loan-terms.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { LoanTermOptionService } from './loan-terms.service';
import { AdminLoanTermsController } from './admin-loan-terms.controller';
import { ClientLoanTermsController } from './client-loan-terms.controller';

@Module({
  controllers: [AdminLoanTermsController, ClientLoanTermsController],
  providers: [LoanTermOptionService],
  exports: [LoanTermOptionService],
})
export class LoanTermsModule {}
```

In `src/app.module.ts`, add the import `import { LoanTermsModule } from './loan-terms/loan-terms.module';` and add `LoanTermsModule` to the `imports` array, directly after `WalletModule`.

- [ ] **Step 9: Type-check and run the loan-terms unit suite**

Run: `npx tsc --noEmit && npx jest src/loan-terms`
Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add src/loan-terms src/app.module.ts
git commit -m "feat: add agency-scoped loan terms catalog"
```

---

### Task 3: Single-active-loan eligibility rule

**Files:**
- Modify: `src/loan-request/eligibility/eligibility-rule.interface.ts`
- Modify: `src/loan-request/eligibility/eligibility.service.ts`
- Modify: `src/loan-request/eligibility/eligibility.service.spec.ts`
- Create: `src/loan-request/eligibility/no-active-loan.rule.ts`
- Test: `src/loan-request/eligibility/no-active-loan.rule.spec.ts`
- Modify: `src/client-loans/client-loans.module.ts`
- Modify: `src/loan-request/loan-request.module.ts`

**Interfaces:**
- Consumes: `ClientLoansService.getDashboard()` (already exists, exported here for the first time), `ClientLoanStatus`/`LoanRequestStatus` (Task 1).
- Produces: `EligibilityRule.check()` returning `Promise<EligibilityCheckResult> | EligibilityCheckResult`, `NoActiveLoanRule` — Task 4's `LoanRequestService.create()` consumes `EligibilityService.check()` (now async).

- [ ] **Step 1: Widen the `EligibilityRule` interface**

In `src/loan-request/eligibility/eligibility-rule.interface.ts`, change:

```typescript
export interface EligibilityRule {
  check(client: Client, ippisRecord: IppisRecord, amount: number): EligibilityCheckResult;
}
```

to:

```typescript
export interface EligibilityRule {
  check(
    client: Client,
    ippisRecord: IppisRecord,
    amount: number,
  ): Promise<EligibilityCheckResult> | EligibilityCheckResult;
}
```

- [ ] **Step 2: Make `EligibilityService.check()` async**

In `src/loan-request/eligibility/eligibility.service.ts`, change the `check` method:

```typescript
  async check(client: Client, ippisRecord: IppisRecord, amount: number): Promise<EligibilityCheckResult> {
    for (const rule of this.rules) {
      const result = await rule.check(client, ippisRecord, amount);
      if (!result.eligible) {
        return result;
      }
    }
    return { eligible: true };
  }
```

- [ ] **Step 3: Update `eligibility.service.spec.ts` for the now-async `check`**

Read the file first (shown in full in this plan's own research). Change each `const result = service.check(...)` call to `const result = await service.check(...)`, and mark each `it` callback `async` if not already. The rest of each test is unchanged.

- [ ] **Step 4: Run the existing eligibility suite to confirm it still passes**

Run: `npx jest src/loan-request/eligibility/eligibility.service.spec.ts`
Expected: PASS — same 3 tests as before, now awaiting.

- [ ] **Step 5: Export `ClientLoansService` for cross-module use**

In `src/client-loans/client-loans.module.ts`, add `exports: [ClientLoansService]` to the `@Module` decorator (it currently has no `exports` array — `NoActiveLoanRule`, in a different module, needs to inject it).

- [ ] **Step 6: Write the failing tests for `NoActiveLoanRule`**

`src/loan-request/eligibility/no-active-loan.rule.spec.ts`:

```typescript
import { NoActiveLoanRule } from './no-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('NoActiveLoanRule', () => {
  let rule: NoActiveLoanRule;
  let prisma: { loanRequest: { findFirst: jest.Mock }; clientLoan: { findFirst: jest.Mock } };
  let clientLoansService: { getDashboard: jest.Mock };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = {
      loanRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      clientLoan: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    clientLoansService = { getDashboard: jest.fn().mockResolvedValue({ loans: [], repayments: [] }) };
    rule = new NoActiveLoanRule(prisma as unknown as PrismaService, clientLoansService as unknown as ClientLoansService);
  });

  it('passes when there is no in-progress request, active ClientLoan, or active ingested loan', async () => {
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when the client already has a non-terminal LoanRequest', async () => {
    prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/in progress/);
  });

  it('fails when the client already has an ACTIVE ClientLoan', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/active loan/);
  });

  it('fails when the client has an ACTIVE ingested loan', async () => {
    clientLoansService.getDashboard.mockResolvedValue({ loans: [{ id: 'loan-1', status: 'ACTIVE' }], repayments: [] });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/active loan/);
  });

  it('passes when the client has only a CLOSED ingested loan', async () => {
    clientLoansService.getDashboard.mockResolvedValue({ loans: [{ id: 'loan-1', status: 'CLOSED' }], repayments: [] });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `npx jest src/loan-request/eligibility/no-active-loan.rule.spec.ts`
Expected: FAIL — `Cannot find module './no-active-loan.rule'`.

- [ ] **Step 8: Implement `NoActiveLoanRule`**

`src/loan-request/eligibility/no-active-loan.rule.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, ClientLoanStatus, IppisRecord, LoanRequestStatus } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

const NON_TERMINAL_LOAN_REQUEST_STATUSES = [
  LoanRequestStatus.PENDING,
  LoanRequestStatus.CONFIRMED,
  LoanRequestStatus.APPROVED,
];

@Injectable()
export class NoActiveLoanRule implements EligibilityRule {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientLoansService: ClientLoansService,
  ) {}

  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const inProgressRequest = await this.prisma.loanRequest.findFirst({
      where: { clientId: client.id, status: { in: NON_TERMINAL_LOAN_REQUEST_STATUSES } },
    });
    if (inProgressRequest) {
      return { eligible: false, reason: 'Client already has a loan request in progress' };
    }

    const activeClientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId: client.id, status: ClientLoanStatus.ACTIVE },
    });
    if (activeClientLoan) {
      return { eligible: false, reason: 'Client already has an active loan' };
    }

    const { loans } = await this.clientLoansService.getDashboard(client.id);
    const hasActiveIngestedLoan = loans.some((loan) => loan.status === 'ACTIVE');
    if (hasActiveIngestedLoan) {
      return { eligible: false, reason: 'Client already has an active loan on record' };
    }

    return { eligible: true };
  }
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx jest src/loan-request/eligibility/no-active-loan.rule.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 10: Wire `NoActiveLoanRule` into `EligibilityService` and the module**

In `src/loan-request/eligibility/eligibility.service.ts`, add the new rule to the constructor and `this.rules` array:

```typescript
  constructor(
    clientMustBeVerifiedRule: ClientMustBeVerifiedRule,
    amountWithinSalaryCapRule: AmountWithinSalaryCapRule,
    noActiveLoanRule: NoActiveLoanRule,
  ) {
    this.rules = [clientMustBeVerifiedRule, amountWithinSalaryCapRule, noActiveLoanRule];
  }
```

(Add the corresponding `import { NoActiveLoanRule } from './no-active-loan.rule';`.)

In `src/loan-request/loan-request.module.ts`, add `NoActiveLoanRule` to `providers`, and add `ClientLoansModule` to `imports` (import it via `import { ClientLoansModule } from '../client-loans/client-loans.module';`).

- [ ] **Step 11: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (the existing `EligibilityService.spec.ts`'s `buildService` helper will need `NoActiveLoanRule` added to its constructor call — read the file's current `buildService` helper and add a third argument, e.g. a `NoActiveLoanRule` instance built the same way `no-active-loan.rule.spec.ts` builds one, with mocks returning "always eligible" defaults, so the existing 3 tests keep testing only what they already test).

- [ ] **Step 12: Run the eligibility suite again to confirm the full chain still passes**

Run: `npx jest src/loan-request/eligibility`
Expected: PASS — all eligibility-related suites (`eligibility.service.spec.ts`, `no-active-loan.rule.spec.ts`, plus the two pre-existing rule specs, untouched).

- [ ] **Step 13: Commit**

```bash
git add src/loan-request/eligibility src/loan-request/loan-request.module.ts src/client-loans/client-loans.module.ts
git commit -m "feat: add single-active-loan eligibility rule"
```

---

### Task 4: `LoanRequestService.create()` — tenor validation and rate/charge snapshot

**Files:**
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`
- Modify: `src/loan-request/dto/create-loan-request.dto.ts`
- Modify: `src/loan-request/loan-request.controller.ts`

**Interfaces:**
- Consumes: `LoanTermOption` (Task 1), `EligibilityService.check()` now async (Task 3).
- Produces: `LoanRequestService.create(clientId: string, amount: number, tenorMonths: number)` (signature change — the two existing callers, `LoanRequestController.create` and every test, are updated in this task).

- [ ] **Step 1: Add `tenorMonths` to the DTO**

`src/loan-request/dto/create-loan-request.dto.ts`:

```typescript
import { IsInt, IsNumber, IsPositive } from 'class-validator';

export class CreateLoanRequestDto {
  @IsNumber()
  @IsPositive()
  amount: number;

  @IsInt()
  @IsPositive()
  tenorMonths: number;
}
```

- [ ] **Step 2: Update the controller to pass `tenorMonths` through**

In `src/loan-request/loan-request.controller.ts`, change the `create` method:

```typescript
  @Post()
  create(@Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.create(req.user.sub, dto.amount, dto.tenorMonths);
  }
```

- [ ] **Step 3: Update the existing `create` tests in `loan-request.service.spec.ts`**

Read the file's current `describe('create', ...)` block (shown in full in this plan's research above) and:
1. Add `loanTermOption: { findUnique: jest.Mock }` to the `prisma` mock object's type and its `beforeEach` initialization.
2. Change `eligibilityService.check.mockReturnValue(...)` to `eligibilityService.check.mockResolvedValue(...)` in every existing test (the mock itself can still be a plain `jest.fn()` — `mockResolvedValue` just makes it return a resolved Promise, matching the now-async interface).
3. Add a `tenorMonths` argument (e.g. `6`) to every `service.create('c1', amount, ...)` call.
4. In the two tests that currently don't reach the term-option lookup (`no onboarding`, `eligibility fails`), no further change is needed — they still throw before that point.
5. In the success test (`'sends the SMS, creates the request, and enqueues the expiry job on success'`), add `prisma.loanTermOption.findUnique.mockResolvedValue({ interestRatePercent: 5, managementChargeType: 'PERCENTAGE', managementChargeValue: 2, managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT', isActive: true });` before calling `service.create`, and update the assertion on `prisma.loanRequest.create` to check the new fields are included:

```typescript
    it('sends the SMS, creates the request, and enqueues the expiry job on success', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000, 6);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('5000'));
      expect(prisma.loanRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          amount: 5000,
          tenorMonths: 6,
          interestRatePercent: 5,
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          managementChargeAmount: 100,
        }),
      });
      expect(expiryQueue.add).toHaveBeenCalledWith('expire', { loanRequestId: 'lr1' }, { delay: 24 * 60 * 60 * 1000 });
    });
```

6. Add a new test for the missing/inactive term-option case:

```typescript
    it('rejects when there is no active loan term for the requested tenor', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue(null);

      await expect(service.create('c1', 5000, 99)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `service.create` still takes 2 arguments and doesn't query `loanTermOption`.

- [ ] **Step 5: Implement the `create` changes**

In `src/loan-request/loan-request.service.ts`, add this import: `import { ManagementChargeType } from '../generated/prisma/client';` (alongside the existing `LoanRequestStatus` import — merge into one import line from `'../generated/prisma/client'`).

Replace the `create` method:

```typescript
  async create(clientId: string, amount: number, tenorMonths: number) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      throw new ConflictException('Client has not completed onboarding');
    }

    const eligibility = await this.eligibilityService.check(client, onboarding.ippisRecord, amount);
    if (!eligibility.eligible) {
      throw new UnprocessableEntityException(eligibility.reason);
    }

    const termOption = await this.prisma.loanTermOption.findUnique({
      where: { agency_tenorMonths: { agency: onboarding.ippisRecord.agency, tenorMonths } },
    });
    if (!termOption || !termOption.isActive) {
      throw new UnprocessableEntityException(`No active loan term available for ${tenorMonths} months`);
    }

    const managementChargeAmount =
      termOption.managementChargeType === ManagementChargeType.PERCENTAGE
        ? (amount * Number(termOption.managementChargeValue)) / 100
        : Number(termOption.managementChargeValue);

    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        interestRatePercent: termOption.interestRatePercent,
        managementChargeType: termOption.managementChargeType,
        managementChargeValue: termOption.managementChargeValue,
        managementChargeApplication: termOption.managementChargeApplication,
        managementChargeAmount,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
        confirmationSmsSentAt: new Date(),
      },
    });

    await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

    return loanRequest;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — the full file (recount the literal `it(` blocks in the file after this step's edits before treating any specific number as correct — this task only touched the `create` describe block, so `resend`/`confirmByPhone`/`expire` counts are unchanged from before this task).

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts src/loan-request/dto/create-loan-request.dto.ts src/loan-request/loan-request.controller.ts
git commit -m "feat: add tenor selection and rate/charge snapshot to LoanRequest creation"
```

---

### Task 5: Auto-approve/disburse, `ClientLoan` creation, and admin service methods

**Files:**
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`

**Interfaces:**
- Consumes: `ClientLoan`/`ClientLoanStatus` (Task 1).
- Produces: `LoanRequestService.approve(id: string): Promise<LoanRequest>`, `.reject(id: string, reason: string): Promise<LoanRequest>`, `.disburse(id: string): Promise<LoanRequest>`, `.listAll(status?: LoanRequestStatus): Promise<LoanRequest[]>` — Task 6's `AdminLoanRequestController` consumes all four. `confirmByPhone` now also triggers the auto path.

- [ ] **Step 1: Write the failing tests**

Read `src/loan-request/loan-request.service.spec.ts`'s current state first (Task 4 only touched the `create` describe block, so everything else is exactly as shown in this plan's research above). Two changes are needed before adding new tests:

1. Add `import { ConfigService } from '@nestjs/config';` to the top imports.
2. Widen the `prisma` mock's type declaration and its `beforeEach` initialization to include the new fields the rest of this task's tests need (`loanRequest.findUniqueOrThrow`, `clientOnboarding.findUniqueOrThrow`, and a new top-level `clientLoan` object) — declaring them here, rather than assigning them ad-hoc inside individual tests, keeps the mock's TypeScript type consistent (assigning a property Prisma's own type declaration doesn't list, e.g. `prisma.clientLoan = {...}`, is a compile error regardless of an `as never` cast on the value, since the cast doesn't affect whether the target property exists on the type):

```typescript
  let prisma: {
    client: { findUniqueOrThrow: jest.Mock; findUnique: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    loanRequest: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
    };
    loanTermOption: { findUnique: jest.Mock };
    clientLoan: { create: jest.Mock };
  };
```

```typescript
    prisma = {
      client: { findUniqueOrThrow: jest.fn(), findUnique: jest.fn() },
      clientOnboarding: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      loanRequest: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      loanTermOption: { findUnique: jest.fn() },
      clientLoan: { create: jest.fn() },
    };
```

(`loanTermOption` was already added to this same declaration in Task 4 — this just folds it into the same widened object rather than a separate change.)

Now append these tests, after the existing `describe('confirmByPhone', ...)` block:

```typescript
  describe('confirmByPhone with auto-approval', () => {
    it('auto-approves and auto-disburses when the amount is below the configured threshold', async () => {
      const configService = { get: jest.fn().mockReturnValue('10000') } as unknown as ConfigService;
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        configService,
      );
      prisma.client.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr1' });
      prisma.loanRequest.update.mockResolvedValueOnce({ id: 'lr1', amount: 5000 });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        amount: 5000,
        tenorMonths: 6,
        managementChargeAmount: 100,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl1' });

      await service.confirmByPhone('+2348000000000', 'YES');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', approvedAt: expect.any(Date), disbursedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          loanRequestId: 'lr1',
          agency: 'NPF',
          staffId: 'NPF-001',
          principalAmount: 5000,
          disbursedAmount: 4900,
          principalBalance: 5000,
        }),
      });
    });

    it('leaves the request CONFIRMED when the amount is at or above the threshold', async () => {
      const configService = { get: jest.fn().mockReturnValue('1000') } as unknown as ConfigService;
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        configService,
      );
      prisma.client.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr1' });
      prisma.loanRequest.update.mockResolvedValueOnce({ id: 'lr1', amount: 5000 });

      await service.confirmByPhone('+2348000000000', 'YES');

      expect(prisma.loanRequest.update).toHaveBeenCalledTimes(1);
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'CONFIRMED', confirmedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('throws ConflictException when the request is not CONFIRMED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });
      await expect(service.approve('lr1')).rejects.toThrow(ConflictException);
    });

    it('moves a CONFIRMED request to APPROVED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'APPROVED' });

      await service.approve('lr1');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'APPROVED', approvedAt: expect.any(Date) },
      });
    });
  });

  describe('reject', () => {
    it('throws ConflictException when the request is not CONFIRMED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });
      await expect(service.reject('lr1', 'not eligible')).rejects.toThrow(ConflictException);
    });

    it('moves a CONFIRMED request to REJECTED with a reason', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'REJECTED' });

      await service.reject('lr1', 'not eligible');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'REJECTED', rejectionReason: 'not eligible' },
      });
    });
  });

  describe('disburse', () => {
    it('throws ConflictException when the request is not APPROVED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      await expect(service.disburse('lr1')).rejects.toThrow(ConflictException);
    });

    it('moves an APPROVED request to DISBURSED and creates a ClientLoan', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr1',
        clientId: 'c1',
        amount: 5000,
        tenorMonths: 6,
        managementChargeAmount: 100,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl1' });

      await service.disburse('lr1');

      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', disbursedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ disbursedAmount: 5000, principalAmount: 5000 }),
      });
    });
  });

  describe('listAll', () => {
    it('filters by status when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      await service.listAll('CONFIRMED' as never);
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith({
        where: { status: 'CONFIRMED' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `service.approve`/`.reject`/`.disburse`/`.listAll` don't exist, and the constructor doesn't accept a 5th `configService` argument yet.

- [ ] **Step 3: Implement the changes**

In `src/loan-request/loan-request.service.ts`, add imports:

```typescript
import { ConfigService } from '@nestjs/config';
import { ClientLoanStatus, LoanRequestStatus, ManagementChargeApplication, ManagementChargeType } from '../generated/prisma/client';
```

(This replaces the two separate `LoanRequestStatus`/`ManagementChargeType` imports from Tasks 1/4 — consolidate into one import line from `'../generated/prisma/client'`.)

Add `configService` as an optional 5th constructor parameter:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    @Inject(TWO_WAY_SMS_PROVIDER) private readonly smsProvider: TwoWaySmsProvider,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
    private readonly configService?: ConfigService,
  ) {}
```

Add this private helper (used by both the auto path and `disburse`):

```typescript
  private async createClientLoanFromRequest(loanRequestId: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUniqueOrThrow({ where: { id: loanRequestId } });
    const onboarding = await this.prisma.clientOnboarding.findUniqueOrThrow({
      where: { clientId: loanRequest.clientId },
      include: { ippisRecord: true },
    });

    const principalAmount = Number(loanRequest.amount);
    const managementChargeAmount = Number(loanRequest.managementChargeAmount);
    const disbursedAmount =
      loanRequest.managementChargeApplication === ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT
        ? principalAmount - managementChargeAmount
        : principalAmount;

    const disbursementDate = new Date();
    const maturationDate = new Date(disbursementDate);
    maturationDate.setMonth(maturationDate.getMonth() + loanRequest.tenorMonths);

    await this.prisma.clientLoan.create({
      data: {
        clientId: loanRequest.clientId,
        loanRequestId: loanRequest.id,
        agency: onboarding.ippisRecord.agency,
        staffId: onboarding.ippisRecord.staffId,
        principalAmount,
        disbursedAmount,
        principalBalance: principalAmount,
        tenorMonths: loanRequest.tenorMonths,
        interestRatePercent: loanRequest.interestRatePercent,
        managementChargeType: loanRequest.managementChargeType,
        managementChargeValue: loanRequest.managementChargeValue,
        managementChargeApplication: loanRequest.managementChargeApplication,
        managementChargeAmount: loanRequest.managementChargeAmount,
        disbursementDate,
        maturationDate,
      },
    });
  }
```

Replace the end of `confirmByPhone` (from the existing `await this.prisma.loanRequest.update(...)` line onward) with:

```typescript
    const confirmed = await this.prisma.loanRequest.update({
      where: { id: pending.id },
      data: { status: LoanRequestStatus.CONFIRMED, confirmedAt: new Date() },
    });

    const threshold = Number(this.configService?.get('LOAN_AUTO_APPROVE_THRESHOLD') ?? 0);
    if (Number(confirmed.amount) < threshold) {
      await this.prisma.loanRequest.update({
        where: { id: confirmed.id },
        data: { status: LoanRequestStatus.DISBURSED, approvedAt: new Date(), disbursedAt: new Date() },
      });
      await this.createClientLoanFromRequest(confirmed.id);
    }
```

Add these four methods after `confirmByPhone`:

```typescript
  async approve(id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to approve');
    }
    return this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.APPROVED, approvedAt: new Date() },
    });
  }

  async reject(id: string, reason: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to reject');
    }
    return this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.REJECTED, rejectionReason: reason },
    });
  }

  async disburse(id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.APPROVED) {
      throw new ConflictException('Loan request must be APPROVED to disburse');
    }
    const updated = await this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.DISBURSED, disbursedAt: new Date() },
    });
    await this.createClientLoanFromRequest(id);
    return updated;
  }

  async listAll(status?: LoanRequestStatus) {
    return this.prisma.loanRequest.findMany({ where: { status }, orderBy: { createdAt: 'desc' } });
  }
```

Note: `ClientLoanStatus` is imported here for later tasks' convenience even though this task's own new code doesn't directly reference it — remove it from the import line if `tsc --noEmit` flags it as unused (Task 6/7 don't need it either; only `no-active-loan.rule.ts` from Task 3 uses it. Double check with `tsc --noEmit` in Step 5 and drop the unused import if flagged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks in the full file after this step to confirm the total, rather than trusting a specific number here (this task added 2 `confirmByPhone with auto-approval` tests + 2 `approve` + 2 `reject` + 2 `disburse` + 1 `listAll` = 9 new tests on top of whatever Task 4 left the file at).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (drop the `ClientLoanStatus` import per the note in Step 3 if flagged unused).

- [ ] **Step 6: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts
git commit -m "feat: add auto-approval threshold, ClientLoan creation, and admin review methods"
```

---

### Task 6: Admin loan request controller

**Files:**
- Create: `src/loan-request/dto/reject-loan-request.dto.ts`
- Create: `src/loan-request/admin-loan-request.controller.ts`
- Modify: `src/loan-request/loan-request.module.ts`

**Interfaces:**
- Consumes: `LoanRequestService.approve`/`.reject`/`.disburse`/`.listAll` (Task 5).
- Produces: `GET /admin/loan-requests`, `POST /admin/loan-requests/:id/approve`, `POST /admin/loan-requests/:id/reject`, `POST /admin/loan-requests/:id/disburse`.

- [ ] **Step 1: Add the reject DTO**

`src/loan-request/dto/reject-loan-request.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class RejectLoanRequestDto {
  @IsString()
  @MinLength(1)
  reason: string;
}
```

- [ ] **Step 2: Add the admin controller**

`src/loan-request/admin-loan-request.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType, LoanRequestStatus } from '../generated/prisma/client';
import { LoanRequestService } from './loan-request.service';
import { RejectLoanRequestDto } from './dto/reject-loan-request.dto';

@Controller('admin/loan-requests')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('loan-requests:review')
@UseInterceptors(AuditInterceptor)
export class AdminLoanRequestController {
  constructor(
    private readonly loanRequestService: LoanRequestService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  list(@Query('status') status?: LoanRequestStatus) {
    return this.loanRequestService.listAll(status);
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const result = await this.loanRequestService.approve(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.approve',
      targetType: 'LoanRequest',
      targetId: id,
    });
    return result;
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@Param('id') id: string, @Body() dto: RejectLoanRequestDto, @Req() req: { user: JwtPayload }) {
    const result = await this.loanRequestService.reject(id, dto.reason);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.reject',
      targetType: 'LoanRequest',
      targetId: id,
      metadata: { reason: dto.reason },
    });
    return result;
  }

  @Post(':id/disburse')
  @HttpCode(200)
  async disburse(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const result = await this.loanRequestService.disburse(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.disburse',
      targetType: 'LoanRequest',
      targetId: id,
    });
    return result;
  }
}
```

- [ ] **Step 3: Wire the controller and `AuditModule` into `LoanRequestModule`**

In `src/loan-request/loan-request.module.ts`, add `AdminLoanRequestController` to `controllers`, and add `AuditModule` to `imports` (`import { AuditModule } from '../audit/audit.module';`).

- [ ] **Step 4: Type-check and run the loan-request unit suite**

Run: `npx tsc --noEmit && npx jest src/loan-request`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/loan-request/dto/reject-loan-request.dto.ts src/loan-request/admin-loan-request.controller.ts src/loan-request/loan-request.module.ts
git commit -m "feat: add admin loan request review endpoints"
```

---

### Task 7: Disbursement summary export

**Files:**
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`
- Create: `src/loan-request/admin-client-loans.controller.ts`
- Modify: `src/loan-request/loan-request.module.ts`

**Interfaces:**
- Produces: `LoanRequestService.exportDisbursementSummaryCsv(month: string): Promise<string>` — `GET /admin/client-loans/disbursement-summary`.

Note: this lives in a separate `AdminClientLoansController` (`@Controller('admin/client-loans')`), not as a method on `AdminLoanRequestController` from Task 6 — that controller is mounted at `admin/loan-requests`, and Nest routes are relative to a controller's own prefix, so a sibling path like `admin/client-loans/...` needs its own controller.

- [ ] **Step 1: Write the failing tests**

First widen the `clientLoan` entry in the `prisma` mock's type declaration and `beforeEach` (both added by Task 5) to also include `findMany`:

```typescript
    clientLoan: { create: jest.Mock; findMany: jest.Mock };
```

```typescript
      clientLoan: { create: jest.fn(), findMany: jest.fn() },
```

Then append to `src/loan-request/loan-request.service.spec.ts`, after the `describe('listAll', ...)` block:

```typescript
  describe('exportDisbursementSummaryCsv', () => {
    it('throws BadRequestException for a malformed month', async () => {
      await expect(service.exportDisbursementSummaryCsv('not-a-month')).rejects.toThrow(BadRequestException);
    });

    it('builds a CSV with one row per ClientLoan disbursed in that month', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([
        {
          agency: 'NPF',
          principalAmount: 5000,
          disbursedAmount: 4900,
          tenorMonths: 6,
          interestRatePercent: 5,
          managementChargeAmount: 100,
          disbursementDate: new Date('2026-09-15T00:00:00.000Z'),
          client: { phone: '+2348000000000', onboarding: { employeeName: 'Jane Doe' } },
        },
      ]);

      const csv = await service.exportDisbursementSummaryCsv('2026-09');

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith({
        where: { disbursementDate: { gte: new Date(2026, 8, 1), lt: new Date(2026, 9, 1) } },
        include: { client: { include: { onboarding: true } } },
        orderBy: { disbursementDate: 'asc' },
      });
      expect(csv).toContain('clientPhone,clientName,agency,principalAmount,disbursedAmount,tenorMonths,interestRatePercent,managementChargeAmount,disbursementDate');
      expect(csv).toContain('+2348000000000,Jane Doe,NPF,5000,4900,6,5,100,2026-09-15T00:00:00.000Z');
    });
  });
```

Add `BadRequestException` to the existing `@nestjs/common` import line at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `service.exportDisbursementSummaryCsv is not a function`.

- [ ] **Step 3: Implement `exportDisbursementSummaryCsv`**

Add `BadRequestException` to the `@nestjs/common` import in `src/loan-request/loan-request.service.ts`. Add this method after `listAll`:

```typescript
  async exportDisbursementSummaryCsv(month: string): Promise<string> {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) {
      throw new BadRequestException('month must be in YYYY-MM format');
    }
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const start = new Date(year, monthIndex, 1);
    const end = new Date(year, monthIndex + 1, 1);

    const loans = await this.prisma.clientLoan.findMany({
      where: { disbursementDate: { gte: start, lt: end } },
      include: { client: { include: { onboarding: true } } },
      orderBy: { disbursementDate: 'asc' },
    });

    const header = [
      'clientPhone',
      'clientName',
      'agency',
      'principalAmount',
      'disbursedAmount',
      'tenorMonths',
      'interestRatePercent',
      'managementChargeAmount',
      'disbursementDate',
    ];
    const rows = loans.map((loan) =>
      [
        loan.client.phone,
        loan.client.onboarding?.employeeName ?? '',
        loan.agency,
        Number(loan.principalAmount),
        Number(loan.disbursedAmount),
        loan.tenorMonths,
        Number(loan.interestRatePercent),
        Number(loan.managementChargeAmount),
        loan.disbursementDate.toISOString(),
      ].join(','),
    );

    return [header.join(','), ...rows].join('\n') + '\n';
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the controller**

`src/loan-request/admin-client-loans.controller.ts`:

```typescript
import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanRequestService } from './loan-request.service';

@Controller('admin/client-loans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('client-loans:read')
export class AdminClientLoansController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Get('disbursement-summary')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="disbursement-summary.csv"')
  exportDisbursementSummary(@Query('month') month: string) {
    return this.loanRequestService.exportDisbursementSummaryCsv(month);
  }
}
```

Add `AdminClientLoansController` to `controllers` in `src/loan-request/loan-request.module.ts`.

- [ ] **Step 6: Type-check and run the loan-request unit suite**

Run: `npx tsc --noEmit && npx jest src/loan-request`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts src/loan-request/admin-client-loans.controller.ts src/loan-request/loan-request.module.ts
git commit -m "feat: add admin disbursement summary CSV export"
```

---

### Task 8: e2e tests, README, and Postman

**Files:**
- Modify: `test/loan-request.e2e-spec.ts`
- Create: `test/loan-origination.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-7.

- [ ] **Step 1: Fix the existing loan-request e2e test**

Read `test/loan-request.e2e-spec.ts` in full first (shown in this plan's own research above — it currently posts `{ amount: 500000 }` with no `tenorMonths`, which will now fail DTO validation). Update it:

1. In `beforeAll`, after creating the `ippisRecord`/`clientOnboarding`, seed a `LoanTermOption`:

```typescript
    await prisma.loanTermOption.create({
      data: {
        agency: 'NPF',
        tenorMonths: 6,
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      },
    });
```

2. In `afterAll`, add `await prisma.loanTermOption.deleteMany({ where: { agency: 'NPF', tenorMonths: 6 } });` before the other cleanup (careful: this must not delete term options other tests might rely on — scope the delete tightly to this test's own agency+tenor, and note this could collide with other suites seeding `agency: 'NPF'` term options; if `test/loan-origination.e2e-spec.ts` (this task's Step 3) also uses `NPF`, give each suite a distinct tenor value, e.g. this file uses tenor `6`, the new suite uses a different one, so their `LoanTermOption` rows never collide on the `@@unique([agency, tenorMonths])` constraint).
3. Add `tenorMonths: 6` to both `.send({ amount: ... })` bodies (the salary-cap-exceeding request and the real one).

- [ ] **Step 2: Run the fixed e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/loan-request.e2e-spec.ts --runInBand`
Expected: PASS — same 4 tests as before.

- [ ] **Step 3: Write the new e2e test**

Read `test/wallet.e2e-spec.ts` first for the admin-login pattern this also uses. `test/loan-origination.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Loan origination (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-ORIGIN-${Date.now()}`;
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
        tenorMonths: 3,
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      },
    });
  });

  afterAll(async () => {
    await prisma.clientLoan.deleteMany({ where: { agency, staffId } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: { contains: 'E2E Origination' } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234804' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 3 } });
    await app.close();
  });

  async function createVerifiedClient(phoneSuffix: string, staffIdSuffix: string) {
    const phone = `+234804${phoneSuffix}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-${staffIdSuffix}`, employeeName: 'E2E Origination Test', salary: 1000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Origination Test',
        agency,
        step: 'COMPLETED',
      },
    });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });
    return { client, accessToken };
  }

  it('lists the active loan terms for the client\'s own agency', async () => {
    const { accessToken } = await createVerifiedClient('0000001', 'A');

    const res = await request(app.getHttpServer())
      .get('/client/loan-terms')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].tenorMonths).toBe(3);
  });

  it(
    'runs the full manual-review flow: request -> confirm -> admin approve -> admin disburse -> ClientLoan exists',
    async () => {
      const { client, accessToken } = await createVerifiedClient('0000002', 'B');

      const createRes = await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 200000, tenorMonths: 3 })
        .expect(201);
      const loanRequestId = createRes.body.id;

      await request(app.getHttpServer())
        .post('/webhooks/sms/inbound')
        .send({ phone: client.phone, message: 'YES' })
        .expect(200);

      const listRes = await request(app.getHttpServer())
        .get('/admin/loan-requests?status=CONFIRMED')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(listRes.body.some((lr: { id: string }) => lr.id === loanRequestId)).toBe(true);

      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${loanRequestId}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('APPROVED'));

      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${loanRequestId}/disburse`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('DISBURSED'));

      const clientLoan = await prisma.clientLoan.findUnique({ where: { loanRequestId } });
      expect(clientLoan).not.toBeNull();
      expect(Number(clientLoan!.disbursedAmount)).toBe(196000);

      await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 10000, tenorMonths: 3 })
        .expect(422);
    },
    30000,
  );

  it('rejects a CONFIRMED request with a reason', async () => {
    const { client, accessToken } = await createVerifiedClient('0000003', 'C');

    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 150000, tenorMonths: 3 })
      .expect(201);
    const loanRequestId = createRes.body.id;

    await request(app.getHttpServer())
      .post('/webhooks/sms/inbound')
      .send({ phone: client.phone, message: 'YES' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/reject`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ reason: 'Insufficient documentation' })
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('REJECTED');
        expect(res.body.rejectionReason).toBe('Insufficient documentation');
      });
  });

  it('returns a CSV for the disbursement summary export', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const res = await request(app.getHttpServer())
      .get(`/admin/client-loans/disbursement-summary?month=${month}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('clientPhone,clientName,agency,principalAmount');
  });
});
```

- [ ] **Step 4: Run the new e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/loan-origination.e2e-spec.ts --runInBand`
Expected: PASS — 4 tests.

- [ ] **Step 5: Update the README**

Add a new section to `README.md`, after the existing loan-request-workflow section (search for the `POST /client/loan-requests` table row to find the right spot):

```markdown
## Loan origination

`LoanRequest` now carries a `tenorMonths` (chosen from
`GET /client/loan-terms`, the active `LoanTermOption`s for the client's own
agency) and a rate/management-charge snapshot taken at request time. After
the existing SMS "YES" confirmation, a request below
`LOAN_AUTO_APPROVE_THRESHOLD` auto-`APPROVED`s and auto-`DISBURSED`s in the
same step; at or above it, an admin holding `loan-requests:review` calls
`POST /admin/loan-requests/:id/approve` or `.../reject` (`{ reason }`),
then separately `.../disburse` once the external transfer is confirmed —
`DISBURSED` is always its own manual step for a manually-approved request.
Either path creates exactly one `ClientLoan` (the client's single
platform-native loan — topup and repayment tracking are still to come). A
client can only have one loan in flight at a time: a new
`POST /client/loan-requests` is rejected (`422`) while they have a
non-terminal request, an `ACTIVE` `ClientLoan`, or an `ACTIVE` loan in
their ingested bank history. `GET /admin/client-loans/disbursement-summary
?month=YYYY-MM` (`client-loans:read`) streams a CSV of that month's
disbursed loans.
```

- [ ] **Step 6: Add Postman coverage**

Add a new **Loan Terms** area (client `GET /client/loan-terms`, admin CRUD under a new **Loan Terms** admin sub-folder), update the existing `POST /client/loan-requests` request/example for the new `tenorMonths` field, and add a new **Loan Requests** admin sub-folder (list, approve, reject, disburse) plus the disbursement-summary export under **Client Review**-adjacent Admin requests — following this repo's `postman/README.md` folder-structure rationale (admin acting on a client-adjacent resource). Every new/changed request needs a saved response example authored from the actual code. Use a surgical text-based/jq-based insert, not a full rewrite (watch `ensure_ascii` if using Python's `json` module).

- [ ] **Step 7: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 8: Run the loan-related suites (scoped, not the full suite)**

Run: `npx jest src/loan-request src/loan-terms src/client-loans src/wallet && npx jest --config ./test/jest-e2e.json test/loan-request.e2e-spec.ts test/loan-origination.e2e-spec.ts test/client-loans.e2e-spec.ts test/wallet.e2e-spec.ts --runInBand`
Expected: PASS. Per this plan's Global Constraints, do NOT run the full unit suite (`npm run test`) or the full e2e config with no path filter — this plan is B1 of a four-part phase, not the phase's last plan.

- [ ] **Step 9: Commit**

```bash
git add test/loan-request.e2e-spec.ts test/loan-origination.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add loan origination e2e coverage and docs"
```

## Exit criteria

- [ ] The scoped test run in Task 8's Step 8 passes from a clean state (not the full suite — see Global Constraints).
- [ ] A client can list active loan terms for their own agency and submit a request with a chosen tenor.
- [ ] Below-threshold requests auto-approve and auto-disburse on SMS confirmation; at/above-threshold requests wait for a manual admin approve/reject, then a separate manual disburse.
- [ ] Exactly one `ClientLoan` is created per disbursed `LoanRequest`, via the single shared `createClientLoanFromRequest` helper regardless of path.
- [ ] A client cannot have more than one loan in flight — blocked by a non-terminal `LoanRequest`, an `ACTIVE` `ClientLoan`, or an `ACTIVE` ingested loan.
- [ ] The admin disbursement summary export returns a well-formed CSV for a given month.
- [ ] Postman has coverage for every new/changed endpoint in this plan.
