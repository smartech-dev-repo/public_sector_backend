# Loan Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `LoanTermOption` with a `LoanProduct` entity that is itself the loan eligibility/qualification mechanism (sectors, amount range, tenor range, dynamic tenor-to-interest tiers, service-length bounds), and retire the flat `LOAN_SALARY_MULTIPLE_CAP` env-var cap in favor of each product's own amount range.

**Architecture:** A new `LoanProductResolverService` (in `src/loan-request/eligibility/`) structurally matches active products by sector/amount/tenor, filters by service-length eligibility (computed from `IppisRecord.dateOfBirth`/`hireDate` against a new admin-configurable `LoanSettings` singleton), then picks the interest tier covering the requested tenor. `LoanRequestService` calls this resolver instead of looking up `LoanTermOption`. A new `src/loan-products/` module (replacing `src/loan-terms/`) exposes CRUD + a sectors lookup for admins and a read-only eligible-products list for clients. `AmountWithinSalaryCapRule` is deleted outright.

**Tech Stack:** NestJS, Prisma (Postgres `String[]` + `Json` columns), class-validator DTOs, Jest unit tests, supertest e2e tests.

**Spec:** `docs/superpowers/specs/2026-10-13-loan-product-design.md`

## Global Constraints

- `interestTiers` validation (non-empty, each tier within `[minimumTenorMonths, maximumTenorMonths]`, no overlaps, gaps allowed) is enforced in application code invoked from the create/update service methods — **not** via class-validator nested decorators and **not** at the DB layer (Postgres `Json` columns aren't schema-validated). This is an implementation decision, not a spec restatement: plain `@IsArray()` without `@ValidateNested()`/`@Type()` is sufficient for NestJS's global `ValidationPipe({ whitelist: true, transform: true })` to pass the array through untouched, so hand-rolled validation in the service is the correct (and only) place to enforce it.
- `managementChargeType`/`Value`/`Application` stay flat per product, not per tier.
- `minimumServiceMonthsLeft`/`maximumMonthsInService` are both nullable; a product setting neither skips the service-length check entirely for that product.
- Every new/changed endpoint gets a Postman example authored from the actual DTO/controller/service code, per this repo's `CLAUDE.md`.
- `AmountWithinSalaryCapRule`, its spec, and `LOAN_SALARY_MULTIPLE_CAP` (`.env`/`.env.example`) are deleted entirely — not deprecated, not left behind a flag.
- No migration of existing `LoanTermOption` rows into `LoanProduct` — none are real production config (confirmed in spec §2).

---

### Task 1: Schema — `LoanProduct` + `LoanSettings`, drop `LoanTermOption`

**Files:**
- Modify: `prisma/schema.prisma:444-457` (the `LoanTermOption` model block)

**Interfaces:**
- Produces: Prisma models `LoanProduct` (fields: `id, productName, productCode, sectors, minimumAmount, maximumAmount, minimumTenorMonths, maximumTenorMonths, interestTiers, managementChargeType, managementChargeValue, managementChargeApplication, minimumServiceMonthsLeft, maximumMonthsInService, isActive, createdAt, updatedAt`) and `LoanSettings` (fields: `id, retirementAgeYears, maxServiceYears, updatedAt`), both available via `../generated/prisma/client` after `prisma generate`.

- [ ] **Step 1: Replace the `LoanTermOption` model with `LoanProduct` + `LoanSettings`**

In `prisma/schema.prisma`, replace this exact block:

```prisma
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

with:

```prisma
model LoanProduct {
  id                           String                       @id @default(uuid())
  productName                  String
  productCode                  String                       @unique
  sectors                      String[]
  minimumAmount                Decimal
  maximumAmount                Decimal
  minimumTenorMonths           Int
  maximumTenorMonths           Int
  interestTiers                Json
  managementChargeType         ManagementChargeType
  managementChargeValue        Decimal
  managementChargeApplication  ManagementChargeApplication
  minimumServiceMonthsLeft     Int?
  maximumMonthsInService       Int?
  isActive                     Boolean                      @default(true)
  createdAt                    DateTime                     @default(now())
  updatedAt                    DateTime                     @updatedAt
}

model LoanSettings {
  id                 String   @id @default(uuid())
  retirementAgeYears Int      @default(60)
  maxServiceYears    Int      @default(35)
  updatedAt          DateTime @updatedAt
}
```

- [ ] **Step 2: Run the migration**

Run: `npx prisma migrate dev --name loan_product_replaces_loan_term_option`

This is destructive (drops the `LoanTermOption` table) and will prompt for confirmation since it detects data loss — confirm it. The shared UAT database only has e2e-fixture rows in that table (no real admin-entered config), per spec §2. Remember: this DB is shared and fragile — after this migration lands, a separate redeploy is needed for other environments pointed at the same DB (see project memory on UAT DB being shared).

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): replace LoanTermOption with LoanProduct and LoanSettings"
```

---

### Task 2: Shared types — known agencies + interest tier shape

**Files:**
- Create: `src/common/known-agencies.constant.ts`
- Create: `src/loan-products/interest-tier.interface.ts`

**Interfaces:**
- Produces: `KNOWN_AGENCIES` (readonly 6-element string tuple), `KnownAgency` type, `InterestTier` interface (`{ minTenorMonths: number; maxTenorMonths: number; interestRatePercent: number }`) — consumed by Tasks 5, 7, 8.

- [ ] **Step 1: Create the known-agencies constant**

```typescript
// src/common/known-agencies.constant.ts
export const KNOWN_AGENCIES = ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOM', 'LASG'] as const;
export type KnownAgency = (typeof KNOWN_AGENCIES)[number];
```

- [ ] **Step 2: Create the shared `InterestTier` interface**

```typescript
// src/loan-products/interest-tier.interface.ts
export interface InterestTier {
  minTenorMonths: number;
  maxTenorMonths: number;
  interestRatePercent: number;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/common/known-agencies.constant.ts src/loan-products/interest-tier.interface.ts
git commit -m "feat(loan-products): add shared known-agencies constant and InterestTier type"
```

---

### Task 3: Service-length computation utilities

**Files:**
- Create: `src/loan-request/eligibility/compute-service-window.util.ts`
- Create: `src/loan-request/eligibility/compute-service-window.util.spec.ts`
- Create: `src/loan-request/eligibility/service-length-eligible.util.ts`
- Create: `src/loan-request/eligibility/service-length-eligible.util.spec.ts`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces: `computeServiceWindow(dateOfBirth, hireDate, retirementAgeYears, maxServiceYears): ServiceWindow` and `isServiceLengthEligible(product: { minimumServiceMonthsLeft: number | null; maximumMonthsInService: number | null }, monthsLeft: number | null, monthsServed: number | null): boolean` — both consumed by Task 5 (`LoanProductResolverService`) and Task 8 (`LoanProductsService.listActiveForClient`).

- [ ] **Step 1: Write `compute-service-window.util.ts`**

```typescript
// src/loan-request/eligibility/compute-service-window.util.ts
export interface ServiceWindow {
  monthsLeft: number | null;
  monthsServed: number | null;
}

export function computeServiceWindow(
  dateOfBirth: Date | null,
  hireDate: Date | null,
  retirementAgeYears: number,
  maxServiceYears: number,
): ServiceWindow {
  const now = new Date();
  const byAge = dateOfBirth ? addYears(dateOfBirth, retirementAgeYears) : null;
  const byService = hireDate ? addYears(hireDate, maxServiceYears) : null;
  const candidates = [byAge, byService].filter((d): d is Date => d !== null);
  const retirementDate =
    candidates.length > 0 ? candidates.reduce((earliest, d) => (d < earliest ? d : earliest)) : null;

  return {
    monthsLeft: retirementDate ? monthsBetween(now, retirementDate) : null,
    monthsServed: hireDate ? monthsBetween(hireDate, now) : null,
  };
}

function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/loan-request/eligibility/compute-service-window.util.spec.ts
import { computeServiceWindow } from './compute-service-window.util';

describe('computeServiceWindow', () => {
  it('uses whichever retirement date (age-based or service-based) is earlier when both are present', () => {
    const now = new Date();
    const dateOfBirth = new Date(now.getFullYear() - 59, now.getMonth(), now.getDate());
    const hireDate = new Date(now.getFullYear() - 34, now.getMonth(), now.getDate());
    const result = computeServiceWindow(dateOfBirth, hireDate, 60, 35);
    expect(result.monthsLeft).toBe(12);
    expect(result.monthsServed).toBe(34 * 12);
  });

  it('uses the age-based retirement date alone when only dateOfBirth is on file', () => {
    const now = new Date();
    const dateOfBirth = new Date(now.getFullYear() - 59, now.getMonth(), now.getDate());
    const result = computeServiceWindow(dateOfBirth, null, 60, 35);
    expect(result.monthsLeft).toBe(12);
    expect(result.monthsServed).toBeNull();
  });

  it('uses the service-based retirement date alone when only hireDate is on file', () => {
    const now = new Date();
    const hireDate = new Date(now.getFullYear() - 34, now.getMonth(), now.getDate());
    const result = computeServiceWindow(null, hireDate, 60, 35);
    expect(result.monthsLeft).toBe(12);
    expect(result.monthsServed).toBe(34 * 12);
  });

  it('returns both fields null when neither date is on file', () => {
    const result = computeServiceWindow(null, null, 60, 35);
    expect(result.monthsLeft).toBeNull();
    expect(result.monthsServed).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/loan-request/eligibility/compute-service-window.util.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: Write `service-length-eligible.util.ts`**

```typescript
// src/loan-request/eligibility/service-length-eligible.util.ts
export interface ServiceLengthBounds {
  minimumServiceMonthsLeft: number | null;
  maximumMonthsInService: number | null;
}

export function isServiceLengthEligible(
  product: ServiceLengthBounds,
  monthsLeft: number | null,
  monthsServed: number | null,
): boolean {
  return (
    (product.minimumServiceMonthsLeft == null ||
      (monthsLeft != null && monthsLeft >= product.minimumServiceMonthsLeft)) &&
    (product.maximumMonthsInService == null ||
      (monthsServed != null && monthsServed <= product.maximumMonthsInService))
  );
}
```

- [ ] **Step 5: Write its spec**

```typescript
// src/loan-request/eligibility/service-length-eligible.util.spec.ts
import { isServiceLengthEligible } from './service-length-eligible.util';

describe('isServiceLengthEligible', () => {
  it('is eligible when both bounds are null regardless of months', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: null, maximumMonthsInService: null }, null, null)).toBe(
      true,
    );
  });

  it('rejects when minimumServiceMonthsLeft is set but monthsLeft is unknown', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: 12, maximumMonthsInService: null }, null, 100)).toBe(
      false,
    );
  });

  it('rejects when monthsLeft is below the minimum', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: 12, maximumMonthsInService: null }, 6, 100)).toBe(
      false,
    );
  });

  it('accepts when monthsLeft meets the minimum', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: 12, maximumMonthsInService: null }, 12, 100)).toBe(
      true,
    );
  });

  it('rejects when monthsServed exceeds the maximum', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: null, maximumMonthsInService: 100 }, 12, 101)).toBe(
      false,
    );
  });

  it('accepts when monthsServed is within the maximum', () => {
    expect(isServiceLengthEligible({ minimumServiceMonthsLeft: null, maximumMonthsInService: 100 }, 12, 100)).toBe(
      true,
    );
  });
});
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx jest src/loan-request/eligibility/service-length-eligible.util.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Commit**

```bash
git add src/loan-request/eligibility/compute-service-window.util.ts src/loan-request/eligibility/compute-service-window.util.spec.ts src/loan-request/eligibility/service-length-eligible.util.ts src/loan-request/eligibility/service-length-eligible.util.spec.ts
git commit -m "feat(loan-request): add service-length computation utilities"
```

---

### Task 4: `LoanSettings` module

**Files:**
- Create: `src/loan-settings/loan-settings.service.ts`
- Create: `src/loan-settings/loan-settings.service.spec.ts`
- Create: `src/loan-settings/dto/update-loan-settings.dto.ts`
- Create: `src/loan-settings/admin-loan-settings.controller.ts`
- Create: `src/loan-settings/loan-settings.module.ts`

**Interfaces:**
- Consumes: `PrismaService` (global).
- Produces: `LoanSettingsService` (exported from `LoanSettingsModule`) with `get(): Promise<LoanSettings>` and `update(input: { retirementAgeYears?: number; maxServiceYears?: number }): Promise<LoanSettings>` — consumed by Task 5 and Task 8. New permission key `loan-settings:manage` (seeded in Task 10).

- [ ] **Step 1: Write `LoanSettingsService`**

```typescript
// src/loan-settings/loan-settings.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanSettings } from '../generated/prisma/client';

export interface UpdateLoanSettingsInput {
  retirementAgeYears?: number;
  maxServiceYears?: number;
}

@Injectable()
export class LoanSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<LoanSettings> {
    const existing = await this.prisma.loanSettings.findFirst();
    if (existing) return existing;
    return this.prisma.loanSettings.create({ data: {} });
  }

  async update(input: UpdateLoanSettingsInput): Promise<LoanSettings> {
    const current = await this.get();
    return this.prisma.loanSettings.update({ where: { id: current.id }, data: input });
  }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/loan-settings/loan-settings.service.spec.ts
import { LoanSettingsService } from './loan-settings.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LoanSettingsService', () => {
  let prisma: { loanSettings: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock } };
  let service: LoanSettingsService;

  beforeEach(() => {
    prisma = { loanSettings: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() } };
    service = new LoanSettingsService(prisma as unknown as PrismaService);
  });

  describe('get', () => {
    it('creates a row with schema defaults on first call', async () => {
      prisma.loanSettings.findFirst.mockResolvedValue(null);
      prisma.loanSettings.create.mockResolvedValue({ id: 's1', retirementAgeYears: 60, maxServiceYears: 35 });

      const result = await service.get();

      expect(prisma.loanSettings.create).toHaveBeenCalledWith({ data: {} });
      expect(result).toEqual({ id: 's1', retirementAgeYears: 60, maxServiceYears: 35 });
    });

    it('returns the existing row on subsequent calls without creating another', async () => {
      prisma.loanSettings.findFirst.mockResolvedValue({ id: 's1', retirementAgeYears: 60, maxServiceYears: 35 });

      await service.get();

      expect(prisma.loanSettings.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('persists partial changes against the existing row', async () => {
      prisma.loanSettings.findFirst.mockResolvedValue({ id: 's1', retirementAgeYears: 60, maxServiceYears: 35 });
      prisma.loanSettings.update.mockResolvedValue({ id: 's1', retirementAgeYears: 62, maxServiceYears: 35 });

      const result = await service.update({ retirementAgeYears: 62 });

      expect(prisma.loanSettings.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { retirementAgeYears: 62 },
      });
      expect(result.retirementAgeYears).toBe(62);
    });
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/loan-settings/loan-settings.service.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: Write the update DTO**

```typescript
// src/loan-settings/dto/update-loan-settings.dto.ts
import { IsInt, IsOptional, IsPositive } from 'class-validator';

export class UpdateLoanSettingsDto {
  @IsOptional()
  @IsInt()
  @IsPositive()
  retirementAgeYears?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maxServiceYears?: number;
}
```

- [ ] **Step 5: Write the controller**

```typescript
// src/loan-settings/admin-loan-settings.controller.ts
import { Body, Controller, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanSettingsService } from './loan-settings.service';
import { UpdateLoanSettingsDto } from './dto/update-loan-settings.dto';

@Controller('admin/loan-settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('loan-settings:manage')
export class AdminLoanSettingsController {
  constructor(private readonly loanSettingsService: LoanSettingsService) {}

  @Get()
  get() {
    return this.loanSettingsService.get();
  }

  @Patch()
  @HttpCode(200)
  update(@Body() dto: UpdateLoanSettingsDto) {
    return this.loanSettingsService.update(dto);
  }
}
```

- [ ] **Step 6: Write the module**

```typescript
// src/loan-settings/loan-settings.module.ts
import { Module } from '@nestjs/common';
import { LoanSettingsService } from './loan-settings.service';
import { AdminLoanSettingsController } from './admin-loan-settings.controller';

@Module({
  controllers: [AdminLoanSettingsController],
  providers: [LoanSettingsService],
  exports: [LoanSettingsService],
})
export class LoanSettingsModule {}
```

- [ ] **Step 7: Commit**

```bash
git add src/loan-settings
git commit -m "feat(loan-settings): add LoanSettings admin-configurable singleton module"
```

---

### Task 5: `LoanProductResolverService`

**Files:**
- Create: `src/loan-request/eligibility/loan-product-resolver.service.ts`
- Create: `src/loan-request/eligibility/loan-product-resolver.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `LoanSettingsService.get()` (Task 4), `computeServiceWindow`/`isServiceLengthEligible` (Task 3), `InterestTier` (Task 2).
- Produces: `LoanProductResolverService.resolve(ippisRecord: IppisRecord, amount: number, tenorMonths: number): Promise<{ product: LoanProduct; tier: InterestTier }>` — consumed by Task 7 (`LoanRequestService`).

- [ ] **Step 1: Write `LoanProductResolverService`**

```typescript
// src/loan-request/eligibility/loan-product-resolver.service.ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LoanSettingsService } from '../../loan-settings/loan-settings.service';
import { IppisRecord, LoanProduct } from '../../generated/prisma/client';
import { computeServiceWindow } from './compute-service-window.util';
import { isServiceLengthEligible } from './service-length-eligible.util';
import { InterestTier } from '../../loan-products/interest-tier.interface';

export interface LoanProductMatch {
  product: LoanProduct;
  tier: InterestTier;
}

@Injectable()
export class LoanProductResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanSettingsService: LoanSettingsService,
  ) {}

  async resolve(ippisRecord: IppisRecord, amount: number, tenorMonths: number): Promise<LoanProductMatch> {
    const structuralMatches = await this.prisma.loanProduct.findMany({
      where: {
        isActive: true,
        sectors: { has: ippisRecord.agency },
        minimumAmount: { lte: amount },
        maximumAmount: { gte: amount },
        minimumTenorMonths: { lte: tenorMonths },
        maximumTenorMonths: { gte: tenorMonths },
      },
    });
    if (structuralMatches.length === 0) {
      throw new UnprocessableEntityException('No loan product matches this amount/tenor for your agency');
    }

    const settings = await this.loanSettingsService.get();
    const { monthsLeft, monthsServed } = computeServiceWindow(
      ippisRecord.dateOfBirth,
      ippisRecord.hireDate,
      settings.retirementAgeYears,
      settings.maxServiceYears,
    );

    const eligibleMatches = structuralMatches.filter((p) => isServiceLengthEligible(p, monthsLeft, monthsServed));
    if (eligibleMatches.length === 0) {
      throw new UnprocessableEntityException('Not eligible for any matching loan product based on service length');
    }
    if (eligibleMatches.length > 1) {
      throw new UnprocessableEntityException(
        'Multiple loan products match this request — ambiguous configuration, contact an admin',
      );
    }

    const product = eligibleMatches[0];
    const tiers = product.interestTiers as unknown as InterestTier[];
    const tier = tiers.find((t) => tenorMonths >= t.minTenorMonths && tenorMonths <= t.maxTenorMonths);
    if (!tier) {
      throw new UnprocessableEntityException(`No interest rate configured for ${tenorMonths} months under this product`);
    }

    return { product, tier };
  }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/loan-request/eligibility/loan-product-resolver.service.spec.ts
import { UnprocessableEntityException } from '@nestjs/common';
import { LoanProductResolverService } from './loan-product-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LoanSettingsService } from '../../loan-settings/loan-settings.service';
import { IppisRecord } from '../../generated/prisma/client';

describe('LoanProductResolverService', () => {
  let prisma: { loanProduct: { findMany: jest.Mock } };
  let loanSettingsService: { get: jest.Mock };
  let service: LoanProductResolverService;

  beforeEach(() => {
    prisma = { loanProduct: { findMany: jest.fn() } };
    loanSettingsService = { get: jest.fn().mockResolvedValue({ retirementAgeYears: 60, maxServiceYears: 35 }) };
    service = new LoanProductResolverService(
      prisma as unknown as PrismaService,
      loanSettingsService as unknown as LoanSettingsService,
    );
  });

  const ippisRecord = (overrides: Partial<IppisRecord> = {}): IppisRecord =>
    ({ agency: 'NPF', dateOfBirth: null, hireDate: null, ...overrides }) as IppisRecord;

  it('throws when there are zero structural matches', async () => {
    prisma.loanProduct.findMany.mockResolvedValue([]);
    await expect(service.resolve(ippisRecord(), 5000, 6)).rejects.toThrow(UnprocessableEntityException);
  });

  it('throws when a structural match is excluded by service-length eligibility', async () => {
    prisma.loanProduct.findMany.mockResolvedValue([
      {
        minimumServiceMonthsLeft: 24,
        maximumMonthsInService: null,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
      },
    ]);
    // dateOfBirth (age-based retirement), not hireDate (service-based cap), is what
    // drives monthsLeft low here: a fresh hireDate leaves ~420 months until the
    // 35-year service cap, which would NOT exclude a minimumServiceMonthsLeft: 24
    // product -- only a near-retirement-age dateOfBirth does.
    const dateOfBirth = new Date();
    dateOfBirth.setFullYear(dateOfBirth.getFullYear() - 59);
    await expect(service.resolve(ippisRecord({ dateOfBirth }), 5000, 6)).rejects.toThrow(UnprocessableEntityException);
  });

  it('resolves the single eligible match and its matching tier', async () => {
    prisma.loanProduct.findMany.mockResolvedValue([
      {
        minimumServiceMonthsLeft: null,
        maximumMonthsInService: null,
        interestTiers: [
          { minTenorMonths: 0, maxTenorMonths: 4, interestRatePercent: 3 },
          { minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 },
        ],
      },
    ]);

    const result = await service.resolve(ippisRecord(), 5000, 6);

    expect(result.tier).toEqual({ minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 });
  });

  it('throws an ambiguous-configuration error when more than one product is eligible', async () => {
    const product = {
      minimumServiceMonthsLeft: null,
      maximumMonthsInService: null,
      interestTiers: [{ minTenorMonths: 0, maxTenorMonths: 12, interestRatePercent: 5 }],
    };
    prisma.loanProduct.findMany.mockResolvedValue([product, { ...product }]);
    await expect(service.resolve(ippisRecord(), 5000, 6)).rejects.toThrow(UnprocessableEntityException);
  });

  it('throws when the eligible product has no tier covering the requested tenor (a tier gap)', async () => {
    prisma.loanProduct.findMany.mockResolvedValue([
      {
        minimumServiceMonthsLeft: null,
        maximumMonthsInService: null,
        interestTiers: [{ minTenorMonths: 0, maxTenorMonths: 4, interestRatePercent: 3 }],
      },
    ]);
    await expect(service.resolve(ippisRecord(), 5000, 5)).rejects.toThrow(UnprocessableEntityException);
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/loan-request/eligibility/loan-product-resolver.service.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 4: Commit**

```bash
git add src/loan-request/eligibility/loan-product-resolver.service.ts src/loan-request/eligibility/loan-product-resolver.service.spec.ts
git commit -m "feat(loan-request): add LoanProductResolverService"
```

---

### Task 6: Retire `AmountWithinSalaryCapRule`

**Files:**
- Delete: `src/loan-request/eligibility/amount-within-salary-cap.rule.ts`
- Delete: `src/loan-request/eligibility/amount-within-salary-cap.rule.spec.ts`
- Modify: `src/loan-request/eligibility/eligibility.service.ts`
- Modify: `src/loan-request/eligibility/eligibility.service.spec.ts`
- Modify: `src/loan-request/eligibility/topup-eligibility.service.ts`
- Modify: `src/loan-request/eligibility/topup-eligibility.service.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `EligibilityService`/`TopupEligibilityService` constructors shrink by one parameter each (no more `AmountWithinSalaryCapRule`) — Task 11 must also drop its provider registration in `loan-request.module.ts`.

- [ ] **Step 1: Delete the rule and its spec**

```bash
rm src/loan-request/eligibility/amount-within-salary-cap.rule.ts src/loan-request/eligibility/amount-within-salary-cap.rule.spec.ts
```

- [ ] **Step 2: Update `EligibilityService`**

In `src/loan-request/eligibility/eligibility.service.ts`, replace the whole file with:

```typescript
import { Injectable } from '@nestjs/common';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { NoActiveLoanRule } from './no-active-loan.rule';

@Injectable()
export class EligibilityService {
  private readonly rules: EligibilityRule[];

  constructor(clientMustBeVerifiedRule: ClientMustBeVerifiedRule, noActiveLoanRule: NoActiveLoanRule) {
    this.rules = [clientMustBeVerifiedRule, noActiveLoanRule];
  }

  async check(client: Client, ippisRecord: IppisRecord, amount: number): Promise<EligibilityCheckResult> {
    for (const rule of this.rules) {
      const result = await rule.check(client, ippisRecord, amount);
      if (!result.eligible) {
        return result;
      }
    }
    return { eligible: true };
  }
}
```

- [ ] **Step 3: Update `EligibilityService`'s spec**

Replace `src/loan-request/eligibility/eligibility.service.spec.ts` with:

```typescript
import { EligibilityService } from './eligibility.service';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { NoActiveLoanRule } from './no-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('EligibilityService', () => {
  function buildService() {
    const prisma = {
      loanRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      clientLoan: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const clientLoansService = {
      hasActiveLoan: jest.fn().mockResolvedValue(false),
    } as unknown as ClientLoansService;
    return new EligibilityService(new ClientMustBeVerifiedRule(), new NoActiveLoanRule(prisma, clientLoansService));
  }

  const verifiedClient = { status: 'VERIFIED' } as Client;
  const unverifiedClient = { status: 'PENDING_IPPIS' } as Client;
  const ippisRecordWithSalary = { salary: 100000 } as unknown as IppisRecord;

  it('passes when every rule passes', async () => {
    const service = buildService();
    const result = await service.check(verifiedClient, ippisRecordWithSalary, 200000);
    expect(result.eligible).toBe(true);
  });

  it('fails fast on the first failing rule without evaluating later rules', async () => {
    const service = buildService();
    const result = await service.check(unverifiedClient, ippisRecordWithSalary, 999999999);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/VERIFIED/);
  });
});
```

Note: the deleted `'fails the salary cap rule when the amount exceeds it'` test has no replacement here — the equivalent behavior (amount exceeding a cap) is now `LoanProductResolverService`'s responsibility and is covered by its own spec (Task 5).

- [ ] **Step 4: Update `TopupEligibilityService`**

Replace `src/loan-request/eligibility/topup-eligibility.service.ts` with:

```typescript
import { Injectable } from '@nestjs/common';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { HasActiveLoanRule } from './has-active-loan.rule';
import { NoTopupInProgressRule } from './no-topup-in-progress.rule';

@Injectable()
export class TopupEligibilityService {
  private readonly rules: EligibilityRule[];

  constructor(
    clientMustBeVerifiedRule: ClientMustBeVerifiedRule,
    hasActiveLoanRule: HasActiveLoanRule,
    noTopupInProgressRule: NoTopupInProgressRule,
  ) {
    this.rules = [clientMustBeVerifiedRule, hasActiveLoanRule, noTopupInProgressRule];
  }

  async check(client: Client, ippisRecord: IppisRecord, amount: number): Promise<EligibilityCheckResult> {
    for (const rule of this.rules) {
      const result = await rule.check(client, ippisRecord, amount);
      if (!result.eligible) {
        return result;
      }
    }
    return { eligible: true };
  }
}
```

- [ ] **Step 5: Update `TopupEligibilityService`'s spec**

Replace `src/loan-request/eligibility/topup-eligibility.service.spec.ts` with:

```typescript
import { TopupEligibilityService } from './topup-eligibility.service';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { HasActiveLoanRule } from './has-active-loan.rule';
import { NoTopupInProgressRule } from './no-topup-in-progress.rule';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('TopupEligibilityService', () => {
  function buildService(overrides: { hasActiveLoan?: boolean; noTopupInProgress?: boolean } = {}) {
    const clientMustBeVerifiedRule = { check: () => ({ eligible: true }) } as unknown as ClientMustBeVerifiedRule;
    const hasActiveLoanRule = {
      check: () =>
        overrides.hasActiveLoan === false
          ? { eligible: false, reason: 'Client has no active loan to top up' }
          : { eligible: true },
    } as unknown as HasActiveLoanRule;
    const noTopupInProgressRule = {
      check: () =>
        overrides.noTopupInProgress === false
          ? { eligible: false, reason: 'A previous loan request is still in progress' }
          : { eligible: true },
    } as unknown as NoTopupInProgressRule;
    return new TopupEligibilityService(clientMustBeVerifiedRule, hasActiveLoanRule, noTopupInProgressRule);
  }

  const client = {} as Client;
  const ippisRecord = {} as IppisRecord;

  it('passes when every rule passes', async () => {
    const service = buildService();
    const result = await service.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when HasActiveLoanRule fails', async () => {
    const service = buildService({ hasActiveLoan: false });
    const result = await service.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no active loan/);
  });

  it('fails when NoTopupInProgressRule fails', async () => {
    const service = buildService({ noTopupInProgress: false });
    const result = await service.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/still in progress/);
  });
});
```

- [ ] **Step 6: Run both specs to verify they pass**

Run: `npx jest src/loan-request/eligibility/eligibility.service.spec.ts src/loan-request/eligibility/topup-eligibility.service.spec.ts`
Expected: PASS (5 tests total)

- [ ] **Step 7: Commit**

```bash
git add -A src/loan-request/eligibility/amount-within-salary-cap.rule.ts src/loan-request/eligibility/amount-within-salary-cap.rule.spec.ts src/loan-request/eligibility/eligibility.service.ts src/loan-request/eligibility/eligibility.service.spec.ts src/loan-request/eligibility/topup-eligibility.service.ts src/loan-request/eligibility/topup-eligibility.service.spec.ts
git commit -m "refactor(loan-request): delete AmountWithinSalaryCapRule, superseded by LoanProductResolverService"
```

---

### Task 7: `LoanRequestService` integration

**Files:**
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`

**Interfaces:**
- Consumes: `LoanProductResolverService.resolve()` (Task 5).
- Produces: `LoanRequestService` constructor gains a required `loanProductResolverService: LoanProductResolverService` parameter, inserted before the two existing optional parameters — Task 11 must wire this provider into `LoanRequestModule`.

- [ ] **Step 1: Update the constructor**

In `src/loan-request/loan-request.service.ts`, add the import:

```typescript
import { LoanProductResolverService } from './eligibility/loan-product-resolver.service';
```

and change the constructor from:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    @Inject(TWO_WAY_SMS_PROVIDER) private readonly smsProvider: TwoWaySmsProvider,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
    private readonly topupEligibilityService: TopupEligibilityService,
    private readonly walletService: WalletService,
    private readonly configService?: ConfigService,
    private readonly emailService?: EmailService,
  ) {}
```

to:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    @Inject(TWO_WAY_SMS_PROVIDER) private readonly smsProvider: TwoWaySmsProvider,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
    private readonly topupEligibilityService: TopupEligibilityService,
    private readonly walletService: WalletService,
    private readonly loanProductResolverService: LoanProductResolverService,
    private readonly configService?: ConfigService,
    private readonly emailService?: EmailService,
  ) {}
```

- [ ] **Step 2: Replace the `create()` term-lookup block**

Replace:

```typescript
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
    await this.sendEmailCopy(client.email, this.confirmationMessage(amount));

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
```

(inside `async create(clientId: string, amount: number, tenorMonths: number)`) with:

```typescript
    const { product, tier } = await this.loanProductResolverService.resolve(onboarding.ippisRecord, amount, tenorMonths);

    const managementChargeAmount =
      product.managementChargeType === ManagementChargeType.PERCENTAGE
        ? (amount * Number(product.managementChargeValue)) / 100
        : Number(product.managementChargeValue);

    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));
    await this.sendEmailCopy(client.email, this.confirmationMessage(amount));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        interestRatePercent: tier.interestRatePercent,
        managementChargeType: product.managementChargeType,
        managementChargeValue: product.managementChargeValue,
        managementChargeApplication: product.managementChargeApplication,
        managementChargeAmount,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
        confirmationSmsSentAt: new Date(),
      },
    });
```

- [ ] **Step 3: Replace the `createTopup()` term-lookup block**

Replace:

```typescript
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

    await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));
    await this.sendEmailCopy(client.email, this.confirmationMessage(amount, LoanRequestType.TOPUP));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        type: LoanRequestType.TOPUP,
        topupTargetId: activeLoan.id,
        interestRatePercent: termOption.interestRatePercent,
        managementChargeType: termOption.managementChargeType,
        managementChargeValue: termOption.managementChargeValue,
        managementChargeApplication: termOption.managementChargeApplication,
        managementChargeAmount,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
        confirmationSmsSentAt: new Date(),
      },
    });
```

(inside `async createTopup(clientId: string, amount: number, tenorMonths: number)`) with:

```typescript
    const { product, tier } = await this.loanProductResolverService.resolve(onboarding.ippisRecord, amount, tenorMonths);

    const managementChargeAmount =
      product.managementChargeType === ManagementChargeType.PERCENTAGE
        ? (amount * Number(product.managementChargeValue)) / 100
        : Number(product.managementChargeValue);

    await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));
    await this.sendEmailCopy(client.email, this.confirmationMessage(amount, LoanRequestType.TOPUP));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        type: LoanRequestType.TOPUP,
        topupTargetId: activeLoan.id,
        interestRatePercent: tier.interestRatePercent,
        managementChargeType: product.managementChargeType,
        managementChargeValue: product.managementChargeValue,
        managementChargeApplication: product.managementChargeApplication,
        managementChargeAmount,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
        confirmationSmsSentAt: new Date(),
      },
    });
```

- [ ] **Step 4: Update the spec's mock setup**

In `src/loan-request/loan-request.service.spec.ts`:

Remove `loanTermOption: { findUnique: jest.Mock };` from the `prisma` type (line 27) and `loanTermOption: { findUnique: jest.fn() },` from its instantiation (line 60).

Add the import:

```typescript
import { LoanProductResolverService } from './eligibility/loan-product-resolver.service';
```

Add a new `let loanProductResolverService: { resolve: jest.Mock };` alongside the other `let` declarations, instantiate it in `beforeEach` as `loanProductResolverService = { resolve: jest.fn() };`, and update the `new LoanRequestService(...)` call from:

```typescript
    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
      topupEligibilityService as unknown as TopupEligibilityService,
      walletService as unknown as WalletService,
      undefined,
      emailService as unknown as EmailService,
    );
```

to:

```typescript
    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
      topupEligibilityService as unknown as TopupEligibilityService,
      walletService as unknown as WalletService,
      loanProductResolverService as unknown as LoanProductResolverService,
      undefined,
      emailService as unknown as EmailService,
    );
```

- [ ] **Step 5: Rewrite the 5 `create` describe-block mock call sites**

For each of these four tests — `'sends the SMS, creates the request, and enqueues the expiry job on success'`, `'also emails a confirmation copy when the client has an email on file'`, `'does not email when the client has no email on file'`, `'still creates the loan request when the email copy fails'` — replace:

```typescript
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
```

with:

```typescript
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 },
      });
```

For `'rejects when there is no active loan term for the requested tenor'`, rename the test and replace its body:

```typescript
    it('rejects when the loan product resolver throws (no matching product for the requested tenor)', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000, agency: 'NPF' } });
      eligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockRejectedValue(
        new UnprocessableEntityException('No loan product matches this amount/tenor for your agency'),
      );

      await expect(service.create('c1', 5000, 99)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });
```

- [ ] **Step 6: Rewrite the 3 `createTopup` describe-block mock call sites**

For `'rejects when there is no active loan term for the requested tenor'` in the `createTopup` block, rename and replace:

```typescript
    it('rejects when the loan product resolver throws (no matching product for the requested tenor)', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockRejectedValue(
        new UnprocessableEntityException('No loan product matches this amount/tenor for your agency'),
      );

      await expect(service.createTopup('c1', 2000, 99)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });
```

For `'sends a top-up-worded SMS and creates a TOPUP LoanRequest pointing at the active loan'` and `'also emails a top-up confirmation copy when the client has an email on file'`, replace:

```typescript
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
```

with:

```typescript
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 },
      });
```

- [ ] **Step 7: Run the spec to verify it passes**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS (all tests, same count as before minus the two renamed-not-removed ones)

- [ ] **Step 8: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts
git commit -m "feat(loan-request): resolve loan products via LoanProductResolverService instead of LoanTermOption"
```

---

### Task 8: `LoanProducts` module (replaces `loan-terms`)

**Files:**
- Create: `src/loan-products/validate-interest-tiers.util.ts`
- Create: `src/loan-products/validate-interest-tiers.util.spec.ts`
- Create: `src/loan-products/loan-products.service.ts`
- Create: `src/loan-products/loan-products.service.spec.ts`
- Create: `src/loan-products/dto/create-loan-product.dto.ts`
- Create: `src/loan-products/dto/update-loan-product.dto.ts`
- Create: `src/loan-products/dto/list-admin-loan-products-query.dto.ts`
- Create: `src/loan-products/dto/list-client-loan-products-query.dto.ts`
- Create: `src/loan-products/admin-loan-products.controller.ts`
- Create: `src/loan-products/client-loan-products.controller.ts`
- Create: `src/loan-products/loan-products.module.ts`
- Delete: `src/loan-terms/` (entire directory — `admin-loan-terms.controller.ts`, `client-loan-terms.controller.ts`, `loan-terms.module.ts`, `loan-terms.service.ts`, `loan-terms.service.spec.ts`, `dto/*.ts`)

**Interfaces:**
- Consumes: `PrismaService`, `LoanSettingsService` (Task 4), `computeServiceWindow`/`isServiceLengthEligible` (Task 3), `InterestTier` (Task 2), `isUniqueConstraintError` (existing, `src/common/is-unique-constraint-error.util.ts`), `KNOWN_AGENCIES` (Task 2).
- Produces: `LoanProductsService` (exported from `LoanProductsModule`) with `create`, `list`, `update`, `listActiveForClient` — no other task consumes these directly, but Task 10 wires the module into `app.module.ts`.

- [ ] **Step 1: Write the interest-tiers validator**

```typescript
// src/loan-products/validate-interest-tiers.util.ts
import { BadRequestException } from '@nestjs/common';
import { InterestTier } from './interest-tier.interface';

export function validateInterestTiers(
  tiers: InterestTier[],
  minimumTenorMonths: number,
  maximumTenorMonths: number,
): void {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new BadRequestException('interestTiers must be a non-empty array');
  }

  const sorted = [...tiers].sort((a, b) => a.minTenorMonths - b.minTenorMonths);

  for (const tier of sorted) {
    if (
      typeof tier.minTenorMonths !== 'number' ||
      typeof tier.maxTenorMonths !== 'number' ||
      typeof tier.interestRatePercent !== 'number' ||
      tier.minTenorMonths > tier.maxTenorMonths
    ) {
      throw new BadRequestException(
        'Each interest tier must have minTenorMonths <= maxTenorMonths and a numeric interestRatePercent',
      );
    }
    if (tier.minTenorMonths < minimumTenorMonths || tier.maxTenorMonths > maximumTenorMonths) {
      throw new BadRequestException(
        `Interest tier [${tier.minTenorMonths}-${tier.maxTenorMonths}] must fall within the product's tenor range [${minimumTenorMonths}-${maximumTenorMonths}]`,
      );
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].minTenorMonths <= sorted[i - 1].maxTenorMonths) {
      throw new BadRequestException(
        `Interest tiers overlap: [${sorted[i - 1].minTenorMonths}-${sorted[i - 1].maxTenorMonths}] and [${sorted[i].minTenorMonths}-${sorted[i].maxTenorMonths}]`,
      );
    }
  }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/loan-products/validate-interest-tiers.util.spec.ts
import { BadRequestException } from '@nestjs/common';
import { validateInterestTiers } from './validate-interest-tiers.util';

describe('validateInterestTiers', () => {
  it('passes for non-overlapping tiers within range, gaps allowed', () => {
    expect(() =>
      validateInterestTiers(
        [
          { minTenorMonths: 0, maxTenorMonths: 4, interestRatePercent: 3 },
          { minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 },
          { minTenorMonths: 13, maxTenorMonths: 18, interestRatePercent: 6 },
        ],
        0,
        18,
      ),
    ).not.toThrow();
  });

  it('rejects an empty tiers array', () => {
    expect(() => validateInterestTiers([], 0, 18)).toThrow(BadRequestException);
  });

  it('rejects a tier that falls outside the product tenor range', () => {
    expect(() =>
      validateInterestTiers([{ minTenorMonths: 0, maxTenorMonths: 24, interestRatePercent: 3 }], 0, 18),
    ).toThrow(BadRequestException);
  });

  it('rejects overlapping tiers', () => {
    expect(() =>
      validateInterestTiers(
        [
          { minTenorMonths: 0, maxTenorMonths: 6, interestRatePercent: 3 },
          { minTenorMonths: 4, maxTenorMonths: 12, interestRatePercent: 5 },
        ],
        0,
        12,
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a tier with minTenorMonths greater than maxTenorMonths', () => {
    expect(() =>
      validateInterestTiers([{ minTenorMonths: 10, maxTenorMonths: 5, interestRatePercent: 3 }], 0, 18),
    ).toThrow(BadRequestException);
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/loan-products/validate-interest-tiers.util.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 4: Write `LoanProductsService`**

```typescript
// src/loan-products/loan-products.service.ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanProduct, ManagementChargeApplication, ManagementChargeType, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { isUniqueConstraintError } from '../common/is-unique-constraint-error.util';
import { LoanSettingsService } from '../loan-settings/loan-settings.service';
import { computeServiceWindow } from '../loan-request/eligibility/compute-service-window.util';
import { isServiceLengthEligible } from '../loan-request/eligibility/service-length-eligible.util';
import { validateInterestTiers } from './validate-interest-tiers.util';
import { InterestTier } from './interest-tier.interface';

export interface ListLoanProductsFilters {
  sectors?: string;
  isActive?: boolean;
}

export interface CreateLoanProductInput {
  productName: string;
  productCode: string;
  sectors: string[];
  minimumAmount: number;
  maximumAmount: number;
  minimumTenorMonths: number;
  maximumTenorMonths: number;
  interestTiers: InterestTier[];
  managementChargeType: ManagementChargeType;
  managementChargeValue: number;
  managementChargeApplication: ManagementChargeApplication;
  minimumServiceMonthsLeft?: number;
  maximumMonthsInService?: number;
}

export interface UpdateLoanProductInput {
  productName?: string;
  sectors?: string[];
  minimumAmount?: number;
  maximumAmount?: number;
  minimumTenorMonths?: number;
  maximumTenorMonths?: number;
  interestTiers?: InterestTier[];
  managementChargeType?: ManagementChargeType;
  managementChargeValue?: number;
  managementChargeApplication?: ManagementChargeApplication;
  minimumServiceMonthsLeft?: number;
  maximumMonthsInService?: number;
  isActive?: boolean;
}

@Injectable()
export class LoanProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanSettingsService: LoanSettingsService,
  ) {}

  async create(input: CreateLoanProductInput): Promise<LoanProduct> {
    validateInterestTiers(input.interestTiers, input.minimumTenorMonths, input.maximumTenorMonths);
    try {
      return await this.prisma.loanProduct.create({
        data: { ...input, interestTiers: input.interestTiers as unknown as Prisma.InputJsonValue },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A loan product with code "${input.productCode}" already exists`);
      }
      throw error;
    }
  }

  async list(
    filters: ListLoanProductsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<LoanProduct>> {
    const { page, limit } = pagination;
    const where: Prisma.LoanProductWhereInput = {
      sectors: filters.sectors ? { has: filters.sectors } : undefined,
      isActive: filters.isActive,
    };

    const [data, total] = await Promise.all([
      this.prisma.loanProduct.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.loanProduct.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async update(id: string, input: UpdateLoanProductInput): Promise<LoanProduct> {
    const existing = await this.prisma.loanProduct.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Loan product not found');
    }

    if (input.interestTiers || input.minimumTenorMonths !== undefined || input.maximumTenorMonths !== undefined) {
      const tiers = input.interestTiers ?? (existing.interestTiers as unknown as InterestTier[]);
      const minimumTenorMonths = input.minimumTenorMonths ?? existing.minimumTenorMonths;
      const maximumTenorMonths = input.maximumTenorMonths ?? existing.maximumTenorMonths;
      validateInterestTiers(tiers, minimumTenorMonths, maximumTenorMonths);
    }

    return this.prisma.loanProduct.update({
      where: { id },
      data: {
        ...input,
        interestTiers: input.interestTiers ? (input.interestTiers as unknown as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  async listActiveForClient(
    clientId: string,
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<LoanProduct>> {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return buildPaginatedResult([], 0, pagination.page, pagination.limit);
    }

    const settings = await this.loanSettingsService.get();
    const { monthsLeft, monthsServed } = computeServiceWindow(
      onboarding.ippisRecord.dateOfBirth,
      onboarding.ippisRecord.hireDate,
      settings.retirementAgeYears,
      settings.maxServiceYears,
    );

    const candidates = await this.prisma.loanProduct.findMany({
      where: { isActive: true, sectors: { has: onboarding.ippisRecord.agency } },
      orderBy: { createdAt: 'desc' },
    });
    const eligible = candidates.filter((p) => isServiceLengthEligible(p, monthsLeft, monthsServed));

    const { page, limit } = pagination;
    const total = eligible.length;
    const data = eligible.slice((page - 1) * limit, (page - 1) * limit + limit);

    return buildPaginatedResult(data, total, page, limit);
  }
}
```

- [ ] **Step 5: Write its spec**

```typescript
// src/loan-products/loan-products.service.spec.ts
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LoanProductsService } from './loan-products.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoanSettingsService } from '../loan-settings/loan-settings.service';

describe('LoanProductsService', () => {
  let prisma: {
    loanProduct: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock };
  };
  let loanSettingsService: { get: jest.Mock };
  let service: LoanProductsService;

  const validInput = {
    productName: 'Standard Loan',
    productCode: 'STD-001',
    sectors: ['NPF'],
    minimumAmount: 1000,
    maximumAmount: 500000,
    minimumTenorMonths: 1,
    maximumTenorMonths: 12,
    interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
    managementChargeType: 'PERCENTAGE' as const,
    managementChargeValue: 2,
    managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT' as const,
  };

  beforeEach(() => {
    prisma = {
      loanProduct: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      clientOnboarding: { findUnique: jest.fn() },
    };
    loanSettingsService = { get: jest.fn().mockResolvedValue({ retirementAgeYears: 60, maxServiceYears: 35 }) };
    service = new LoanProductsService(
      prisma as unknown as PrismaService,
      loanSettingsService as unknown as LoanSettingsService,
    );
  });

  describe('create', () => {
    it('creates a product when the tiers are valid', async () => {
      prisma.loanProduct.create.mockResolvedValue({ id: 'p1', ...validInput });
      const result = await service.create(validInput);
      expect(result.id).toBe('p1');
    });

    it('rejects invalid tiers before ever touching the database', async () => {
      await expect(
        service.create({
          ...validInput,
          interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 24, interestRatePercent: 5 }],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.loanProduct.create).not.toHaveBeenCalled();
    });

    it('converts a duplicate productCode P2002 error into a 409', async () => {
      prisma.loanProduct.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.create(validInput)).rejects.toThrow(ConflictException);
    });
  });

  describe('list', () => {
    it('filters by sectors and isActive', async () => {
      prisma.loanProduct.findMany.mockResolvedValue([]);
      prisma.loanProduct.count.mockResolvedValue(0);
      await service.list({ sectors: 'NPF', isActive: true }, { page: 1, limit: 25 });
      expect(prisma.loanProduct.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sectors: { has: 'NPF' }, isActive: true } }),
      );
    });
  });

  describe('update', () => {
    it('throws when the product does not exist', async () => {
      prisma.loanProduct.findUnique.mockResolvedValue(null);
      await expect(service.update('missing', { productName: 'New name' })).rejects.toThrow(NotFoundException);
    });

    it('revalidates interest tiers against the merged tenor range when only the range changes', async () => {
      prisma.loanProduct.findUnique.mockResolvedValue({
        id: 'p1',
        minimumTenorMonths: 1,
        maximumTenorMonths: 12,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
      });
      await expect(service.update('p1', { maximumTenorMonths: 6 })).rejects.toThrow(BadRequestException);
    });

    it('persists a valid partial update', async () => {
      prisma.loanProduct.findUnique.mockResolvedValue({
        id: 'p1',
        minimumTenorMonths: 1,
        maximumTenorMonths: 12,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
      });
      prisma.loanProduct.update.mockResolvedValue({ id: 'p1', isActive: false });
      const result = await service.update('p1', { isActive: false });
      expect(result.isActive).toBe(false);
    });
  });

  describe('listActiveForClient', () => {
    it('returns an empty page when the client has no onboarding record', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      const result = await service.listActiveForClient('c1');
      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
    });

    it('returns only products matching the agency and service-length eligibility', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.loanProduct.findMany.mockResolvedValue([
        { id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null },
        { id: 'p2', minimumServiceMonthsLeft: 999, maximumMonthsInService: null },
      ]);
      const result = await service.listActiveForClient('c1');
      expect(result.data).toEqual([{ id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null }]);
      expect(result.meta.total).toBe(1);
    });
  });
});
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx jest src/loan-products/loan-products.service.spec.ts`
Expected: PASS (8 tests)

- [ ] **Step 7: Write the DTOs**

```typescript
// src/loan-products/dto/create-loan-product.dto.ts
import { ArrayMinSize, IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';
import { ManagementChargeApplication, ManagementChargeType } from '../../generated/prisma/client';
import { InterestTier } from '../interest-tier.interface';

export class CreateLoanProductDto {
  @IsString()
  @MinLength(1)
  productName: string;

  @IsString()
  @MinLength(1)
  productCode: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  sectors: string[];

  @IsNumber()
  @IsPositive()
  minimumAmount: number;

  @IsNumber()
  @IsPositive()
  maximumAmount: number;

  @IsInt()
  @IsPositive()
  minimumTenorMonths: number;

  @IsInt()
  @IsPositive()
  maximumTenorMonths: number;

  @IsArray()
  @ArrayMinSize(1)
  interestTiers: InterestTier[];

  @IsEnum(ManagementChargeType)
  managementChargeType: ManagementChargeType;

  @IsNumber()
  @IsPositive()
  managementChargeValue: number;

  @IsEnum(ManagementChargeApplication)
  managementChargeApplication: ManagementChargeApplication;

  @IsOptional()
  @IsInt()
  @IsPositive()
  minimumServiceMonthsLeft?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maximumMonthsInService?: number;
}
```

```typescript
// src/loan-products/dto/update-loan-product.dto.ts
import { ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';
import { ManagementChargeApplication, ManagementChargeType } from '../../generated/prisma/client';
import { InterestTier } from '../interest-tier.interface';

export class UpdateLoanProductDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  productName?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  sectors?: string[];

  @IsOptional()
  @IsNumber()
  @IsPositive()
  minimumAmount?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  maximumAmount?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  minimumTenorMonths?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maximumTenorMonths?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  interestTiers?: InterestTier[];

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
  @IsInt()
  @IsPositive()
  minimumServiceMonthsLeft?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  maximumMonthsInService?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
```

```typescript
// src/loan-products/dto/list-admin-loan-products-query.dto.ts
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListAdminLoanProductsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  sectors?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;
}
```

```typescript
// src/loan-products/dto/list-client-loan-products-query.dto.ts
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListClientLoanProductsQueryDto extends PaginationDto {}
```

- [ ] **Step 8: Write the controllers**

```typescript
// src/loan-products/admin-loan-products.controller.ts
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanProductsService } from './loan-products.service';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { UpdateLoanProductDto } from './dto/update-loan-product.dto';
import { ListAdminLoanProductsQueryDto } from './dto/list-admin-loan-products-query.dto';
import { KNOWN_AGENCIES } from '../common/known-agencies.constant';

@Controller('admin/loan-products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('loan-products:manage')
export class AdminLoanProductsController {
  constructor(private readonly loanProductsService: LoanProductsService) {}

  @Get('sectors')
  sectors() {
    return { sectors: KNOWN_AGENCIES };
  }

  @Post()
  create(@Body() dto: CreateLoanProductDto) {
    return this.loanProductsService.create(dto);
  }

  @Get()
  list(@Query() query: ListAdminLoanProductsQueryDto) {
    return this.loanProductsService.list(
      { sectors: query.sectors, isActive: query.isActive },
      { page: query.page, limit: query.limit },
    );
  }

  @Patch(':id')
  @HttpCode(200)
  update(@Param('id') id: string, @Body() dto: UpdateLoanProductDto) {
    return this.loanProductsService.update(id, dto);
  }
}
```

```typescript
// src/loan-products/client-loan-products.controller.ts
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanProductsService } from './loan-products.service';
import { ListClientLoanProductsQueryDto } from './dto/list-client-loan-products-query.dto';

@Controller('client/loan-products')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoanProductsController {
  constructor(private readonly loanProductsService: LoanProductsService) {}

  @Get()
  list(@Query() query: ListClientLoanProductsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.loanProductsService.listActiveForClient(req.user.sub, { page: query.page, limit: query.limit });
  }
}
```

- [ ] **Step 9: Write the module**

```typescript
// src/loan-products/loan-products.module.ts
import { Module } from '@nestjs/common';
import { LoanProductsService } from './loan-products.service';
import { AdminLoanProductsController } from './admin-loan-products.controller';
import { ClientLoanProductsController } from './client-loan-products.controller';
import { LoanSettingsModule } from '../loan-settings/loan-settings.module';

@Module({
  imports: [LoanSettingsModule],
  controllers: [AdminLoanProductsController, ClientLoanProductsController],
  providers: [LoanProductsService],
  exports: [LoanProductsService],
})
export class LoanProductsModule {}
```

- [ ] **Step 10: Delete the old `loan-terms` module**

```bash
rm -rf src/loan-terms
```

- [ ] **Step 11: Run the full new module's tests to verify they pass**

Run: `npx jest src/loan-products`
Expected: PASS (14 tests total across the validator spec and service spec)

- [ ] **Step 12: Commit**

```bash
git add -A src/loan-products src/loan-terms
git commit -m "feat(loan-products): add LoanProducts module replacing loan-terms"
```

---

### Task 9: Permission seed + `.env.example` cleanup

**Files:**
- Modify: `prisma/seed.ts:27`
- Modify: `.env.example:80-81`

**Interfaces:**
- Produces: permission keys `loan-products:manage` and `loan-settings:manage` available after `npx prisma db seed` (or the next deploy's seed run) — the `AdminLoanProductsController`/`AdminLoanSettingsController` (Tasks 8, 4) already reference these keys via `@RequirePermissions`.

- [ ] **Step 1: Update the permission seed list**

In `prisma/seed.ts`, replace:

```typescript
  { key: 'loan-terms:manage', description: "Create/edit the agency-scoped loan terms catalog" },
```

with:

```typescript
  { key: 'loan-products:manage', description: 'Create/edit the loan product catalog (sectors, amount/tenor range, interest tiers, service-length eligibility)' },
  { key: 'loan-settings:manage', description: 'Configure the global retirement-age and max-service-years settings used for loan eligibility' },
```

Rollout note (do not implement — just flag it in the commit/PR description): because the seed script upserts permissions by `key`, renaming `loan-terms:manage` to `loan-products:manage` creates a *new* `Permission` row rather than renaming the existing one in place. Any role that currently holds `loan-terms:manage` needs `loan-products:manage` re-granted manually after this deploys — the `SUPER_ADMIN` role is unaffected since the seed script grants it every permission unconditionally.

- [ ] **Step 2: Remove the retired env var**

In `.env.example`, remove these two lines:

```
# Provisional placeholder — the real ratio will be supplied later.
LOAN_SALARY_MULTIPLE_CAP=3
```

(Check your local `.env` too — if it has the same line, remove it there as well; `.env` is gitignored so there's nothing to commit for that file.)

- [ ] **Step 3: Run the seed script against your local/dev database to verify it doesn't error**

Run: `npx prisma db seed`
Expected: completes without error; `loan-products:manage` and `loan-settings:manage` now exist as `Permission` rows.

- [ ] **Step 4: Commit**

```bash
git add prisma/seed.ts .env.example
git commit -m "chore: replace loan-terms:manage permission with loan-products:manage/loan-settings:manage, drop LOAN_SALARY_MULTIPLE_CAP"
```

---

### Task 10: Wire the modules together

**Files:**
- Modify: `src/app.module.ts`
- Modify: `src/loan-request/loan-request.module.ts`

**Interfaces:**
- Consumes: `LoanProductsModule` (Task 8), `LoanSettingsModule` (Task 4), `LoanProductResolverService` (Task 5).
- Produces: a fully bootable `AppModule` — this is the task that makes Tasks 5-8's code actually reachable via HTTP.

- [ ] **Step 1: Update `app.module.ts`**

Replace the import:

```typescript
import { LoanTermsModule } from './loan-terms/loan-terms.module';
```

with:

```typescript
import { LoanProductsModule } from './loan-products/loan-products.module';
import { LoanSettingsModule } from './loan-settings/loan-settings.module';
```

and in the `imports` array, replace:

```typescript
    LoanTermsModule,
```

with:

```typescript
    LoanProductsModule,
    LoanSettingsModule,
```

- [ ] **Step 2: Update `loan-request.module.ts`**

Remove the import:

```typescript
import { AmountWithinSalaryCapRule } from './eligibility/amount-within-salary-cap.rule';
```

Add these imports:

```typescript
import { LoanProductResolverService } from './eligibility/loan-product-resolver.service';
import { LoanSettingsModule } from '../loan-settings/loan-settings.module';
```

In the `imports` array, add `LoanSettingsModule`:

```typescript
  imports: [
    BullModule.registerQueue({ name: LOAN_REQUEST_EXPIRY_QUEUE }),
    TwoWaySmsModule,
    ClientLoansModule,
    AuditModule,
    WalletModule,
    EmailModule,
    LoanSettingsModule,
  ],
```

In the `providers` array, remove `AmountWithinSalaryCapRule` and add `LoanProductResolverService`:

```typescript
  providers: [
    LoanRequestService,
    LoanRequestExpiryProcessor,
    EligibilityService,
    ClientMustBeVerifiedRule,
    NoActiveLoanRule,
    HasActiveLoanRule,
    NoTopupInProgressRule,
    TopupEligibilityService,
    LoanProductResolverService,
  ],
```

- [ ] **Step 3: Verify the app boots**

Run: `npx nest build`
Expected: compiles with no errors (this catches any DI wiring mistake, since Nest validates module graphs lazily but TypeScript catches missing imports/types at compile time — a genuine DI cycle or missing provider would surface here as a type error or, if you also run the app, a runtime `Nest can't resolve dependencies` error).

If you have a local/dev database reachable, also run: `npm run start:dev` briefly and confirm it logs successful startup (no `UnknownDependenciesException`), then stop it.

- [ ] **Step 4: Commit**

```bash
git add src/app.module.ts src/loan-request/loan-request.module.ts
git commit -m "feat: wire LoanProducts and LoanSettings modules into AppModule, swap eligibility rule for LoanProductResolverService"
```

---

### Task 11: e2e fixture rewrites — 6 files

**Files:**
- Modify: `test/loan-origination.e2e-spec.ts`
- Modify: `test/loan-topup.e2e-spec.ts`
- Modify: `test/admin-client-visibility.e2e-spec.ts`
- Modify: `test/wallet-loan-payment.e2e-spec.ts`
- Modify: `test/client-loan-repayment-tracking.e2e-spec.ts`
- Modify: `test/loan-request.e2e-spec.ts`

**Interfaces:**
- Consumes: the live `/admin/loan-products`, `/client/loan-products`, `/client/loan-requests` HTTP surface from Tasks 8/10.
- Produces: nothing consumed by later tasks — this is the last code-bearing task before the dedicated `admin-loan-products` e2e rewrite (Task 12).

Every file below follows the same shape of change: its `loanTermOption.create` fixture becomes a `loanProduct.create` fixture with a single interest tier spanning exactly the tenor the file's requests use, and its `loanTermOption.deleteMany` cleanup becomes a `loanProduct.deleteMany` keyed by the fixture's own unique `productCode` (not a shared literal, to avoid any risk of a concurrent run's product colliding or being deleted early). Every fixture uses `minimumAmount: 1000, maximumAmount: 1000000` — wide enough to cover every amount every one of these files' tests actually sends (confirmed by grep: the tightest is `loan-topup.e2e-spec.ts`'s `amount: 5000`, the widest is `loan-origination.e2e-spec.ts`'s `amount: 200000`), and `minimumServiceMonthsLeft`/`maximumMonthsInService` stay `null` (omitted) since none of these tests exercise service-length eligibility.

- [ ] **Step 1: `test/loan-origination.e2e-spec.ts`**

Add a `productCode` constant alongside the existing `staffId`/`agency` constants:

```typescript
  const staffId = `E2E-ORIGIN-${Date.now()}`;
  const agency = 'NPF';
  const productCode = `E2E-ORIGIN-PRODUCT-${Date.now()}`;
```

Replace the fixture create block:

```typescript
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
```

with:

```typescript
    await prisma.loanProduct.create({
      data: {
        productName: 'E2E Origination Product',
        productCode,
        sectors: [agency],
        minimumAmount: 1000,
        maximumAmount: 1000000,
        minimumTenorMonths: 3,
        maximumTenorMonths: 3,
        interestTiers: [{ minTenorMonths: 3, maxTenorMonths: 3, interestRatePercent: 5 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      },
    });
```

Replace the cleanup line:

```typescript
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 3 } });
```

with:

```typescript
    await prisma.loanProduct.deleteMany({ where: { productCode } });
```

Replace the route and assertion in the "lists the active loan terms" test:

```typescript
  it('lists the active loan terms for the client\'s own agency', async () => {
    const { accessToken } = await createVerifiedClient('0000001', 'A');

    const res = await request(app.getHttpServer())
      .get('/client/loan-terms')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Not toHaveLength(1): other e2e suites running concurrently against this
    // same shared DB also create active NPF loan terms (different
    // tenorMonths) -- the endpoint correctly returns every active term for
    // the agency, so this only asserts that *this* fixture's term is present.
    expect(res.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ agency: 'NPF', tenorMonths: 3 })]),
    );
  });
```

with:

```typescript
  it('lists the active loan products for the client\'s own agency', async () => {
    const { accessToken } = await createVerifiedClient('0000001', 'A');

    const res = await request(app.getHttpServer())
      .get('/client/loan-products')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Not toHaveLength(1): other e2e suites running concurrently against this
    // same shared DB also create active NPF loan products -- the endpoint
    // correctly returns every eligible product for the agency, so this only
    // asserts that *this* fixture's product is present.
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ productCode })]));
  });
```

- [ ] **Step 2: `test/loan-topup.e2e-spec.ts`**

Add the constant:

```typescript
  const staffId = `E2E-TOPUP-${Date.now()}`;
  const agency = 'NPF';
  const productCode = `E2E-TOPUP-PRODUCT-${Date.now()}`;
```

Replace the fixture create block:

```typescript
    await prisma.loanTermOption.create({
      data: {
        agency,
        tenorMonths: 4,
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 1,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
```

with:

```typescript
    await prisma.loanProduct.create({
      data: {
        productName: 'E2E Topup Product',
        productCode,
        sectors: [agency],
        minimumAmount: 1000,
        maximumAmount: 1000000,
        minimumTenorMonths: 4,
        maximumTenorMonths: 4,
        interestTiers: [{ minTenorMonths: 4, maxTenorMonths: 4, interestRatePercent: 6 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 1,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
```

Replace the cleanup line:

```typescript
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 4 } });
```

with:

```typescript
    await prisma.loanProduct.deleteMany({ where: { productCode } });
```

- [ ] **Step 3: `test/admin-client-visibility.e2e-spec.ts`**

Add the constant:

```typescript
  const staffId = `E2E-VISIBILITY-${Date.now()}`;
  const agency = 'NPF';
  const productCode = `E2E-VISIBILITY-PRODUCT-${Date.now()}`;
```

Replace the fixture create block:

```typescript
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
```

with:

```typescript
    await prisma.loanProduct.create({
      data: {
        productName: 'E2E Visibility Product',
        productCode,
        sectors: [agency],
        minimumAmount: 1000,
        maximumAmount: 1000000,
        minimumTenorMonths: 2,
        maximumTenorMonths: 2,
        interestTiers: [{ minTenorMonths: 2, maxTenorMonths: 2, interestRatePercent: 0 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 0,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
```

Replace the cleanup line:

```typescript
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 2 } });
```

with:

```typescript
    await prisma.loanProduct.deleteMany({ where: { productCode } });
```

- [ ] **Step 4: `test/wallet-loan-payment.e2e-spec.ts`**

Add the constant:

```typescript
  const staffId = `E2E-WALLETPAY-${Date.now()}`;
  const agency = 'NPF-WALLETPAY';
  const productCode = `E2E-WALLETPAY-PRODUCT-${Date.now()}`;
```

Replace the fixture create block:

```typescript
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
```

with:

```typescript
    await prisma.loanProduct.create({
      data: {
        productName: 'E2E WalletPay Product',
        productCode,
        sectors: [agency],
        minimumAmount: 1000,
        maximumAmount: 1000000,
        minimumTenorMonths: 2,
        maximumTenorMonths: 2,
        interestTiers: [{ minTenorMonths: 2, maxTenorMonths: 2, interestRatePercent: 0 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 0,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
```

Replace the cleanup line:

```typescript
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 2 } });
```

with:

```typescript
    await prisma.loanProduct.deleteMany({ where: { productCode } });
```

- [ ] **Step 5: `test/client-loan-repayment-tracking.e2e-spec.ts`**

Add the constant:

```typescript
  const staffId = `E2E-REPAY-${Date.now()}`;
  const agency = 'NPF-REPAY';
  const productCode = `E2E-REPAY-PRODUCT-${Date.now()}`;
```

Replace the fixture create block:

```typescript
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
```

with:

```typescript
    await prisma.loanProduct.create({
      data: {
        productName: 'E2E Repay Product',
        productCode,
        sectors: [agency],
        minimumAmount: 1000,
        maximumAmount: 1000000,
        minimumTenorMonths: 2,
        maximumTenorMonths: 2,
        interestTiers: [{ minTenorMonths: 2, maxTenorMonths: 2, interestRatePercent: 0 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 0,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
```

Replace the cleanup line:

```typescript
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 2 } });
```

with:

```typescript
    await prisma.loanProduct.deleteMany({ where: { productCode } });
```

- [ ] **Step 6: `test/loan-request.e2e-spec.ts`**

Add the constant alongside `phone`/`staffId`:

```typescript
  const phone = `+234802${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-LOAN-${Date.now()}`;
  const productCode = `E2E-LOAN-PRODUCT-${Date.now()}`;
```

Replace the fixture create block:

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

with:

```typescript
    await prisma.loanProduct.create({
      data: {
        productName: 'E2E Loan Product',
        productCode,
        sectors: ['NPF'],
        minimumAmount: 1000,
        maximumAmount: 1000000,
        minimumTenorMonths: 6,
        maximumTenorMonths: 6,
        interestTiers: [{ minTenorMonths: 6, maxTenorMonths: 6, interestRatePercent: 5 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      },
    });
```

Replace the cleanup line:

```typescript
    await prisma.loanTermOption.deleteMany({ where: { agency: 'NPF', tenorMonths: 6 } });
```

with:

```typescript
    await prisma.loanProduct.deleteMany({ where: { productCode } });
```

Rename the first test (the behavior is unchanged — still a 422 — but the rejection now comes from the resolver's amount-range check since `AmountWithinSalaryCapRule` no longer exists, and this fixture's `maximumAmount: 1000000` is what makes `amount: 100000000` fail):

```typescript
  it('rejects a request that exceeds the loan product\'s maximum amount', async () => {
    await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 100000000, tenorMonths: 6 })
      .expect(422);
  });
```

- [ ] **Step 7: Run each file to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json loan-origination loan-topup admin-client-visibility wallet-loan-payment client-loan-repayment-tracking loan-request`
Expected: PASS (re-run individually/in isolation if any fail — this shared UAT database has known contention-based flakiness under full-suite load; an isolated rerun is the standing way to distinguish that from a real regression)

- [ ] **Step 8: Commit**

```bash
git add test/loan-origination.e2e-spec.ts test/loan-topup.e2e-spec.ts test/admin-client-visibility.e2e-spec.ts test/wallet-loan-payment.e2e-spec.ts test/client-loan-repayment-tracking.e2e-spec.ts test/loan-request.e2e-spec.ts
git commit -m "test(e2e): migrate LoanTermOption fixtures to LoanProduct across 6 e2e specs"
```

---

### Task 12: `admin-loan-products` e2e spec (replaces `admin-loan-terms`)

**Files:**
- Delete: `test/admin-loan-terms.e2e-spec.ts`
- Create: `test/admin-loan-products.e2e-spec.ts`

**Interfaces:**
- Consumes: `/admin/loan-products` CRUD + `/admin/loan-products/sectors` (Task 8).

- [ ] **Step 1: Delete the old spec**

```bash
rm test/admin-loan-terms.e2e-spec.ts
```

- [ ] **Step 2: Write the new spec**

```typescript
// test/admin-loan-products.e2e-spec.ts
import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin loan products endpoint (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const productCode = `E2E-PRODUCTS-${Date.now()}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;

    await prisma.loanProduct.createMany({
      data: [
        {
          productName: 'Wave 3 NPF Standard',
          productCode: `${productCode}-NPF`,
          sectors: ['NPF'],
          minimumAmount: 1000,
          maximumAmount: 500000,
          minimumTenorMonths: 1,
          maximumTenorMonths: 12,
          interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          isActive: true,
        },
        {
          productName: 'Wave 3 NPF Legacy',
          productCode: `${productCode}-NPF-OLD`,
          sectors: ['NPF'],
          minimumAmount: 1000,
          maximumAmount: 500000,
          minimumTenorMonths: 1,
          maximumTenorMonths: 12,
          interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 }],
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          isActive: false,
        },
        {
          productName: 'Wave 3 NSCDC Standard',
          productCode: `${productCode}-NSCDC`,
          sectors: ['NSCDC'],
          minimumAmount: 1000,
          maximumAmount: 500000,
          minimumTenorMonths: 1,
          maximumTenorMonths: 12,
          interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
          managementChargeType: 'FLAT',
          managementChargeValue: 5000,
          managementChargeApplication: 'ADD_TO_REPAYMENT',
          isActive: true,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.loanProduct.deleteMany({ where: { productCode: { startsWith: productCode } } });
    await app.close();
  });

  it('rejects creation with invalid tiers (400)', async () => {
    await request(app.getHttpServer())
      .post('/admin/loan-products')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({
        productName: 'Broken Product',
        productCode: `${productCode}-BROKEN`,
        sectors: ['NPF'],
        minimumAmount: 1000,
        maximumAmount: 500000,
        minimumTenorMonths: 1,
        maximumTenorMonths: 6,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 24, interestRatePercent: 5 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      })
      .expect(400);
  });

  it('creates a product and rejects a duplicate productCode with a 409', async () => {
    const body = {
      productName: 'Fresh Product',
      productCode: `${productCode}-FRESH`,
      sectors: ['NPF'],
      minimumAmount: 1000,
      maximumAmount: 500000,
      minimumTenorMonths: 1,
      maximumTenorMonths: 12,
      interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
      managementChargeType: 'PERCENTAGE',
      managementChargeValue: 2,
      managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
    };

    await request(app.getHttpServer())
      .post('/admin/loan-products')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send(body)
      .expect(201);

    await request(app.getHttpServer())
      .post('/admin/loan-products')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send(body)
      .expect(409);
  });

  it('paginates GET /admin/loan-products', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-products?limit=2&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.meta.limit).toBe(2);
  });

  it('filters GET /admin/loan-products by sectors and isActive', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-products')
      .query({ sectors: 'NSCDC', isActive: 'true' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(
      res.body.data.every(
        (p: { sectors: string[]; isActive: boolean }) => p.sectors.includes('NSCDC') && p.isActive === true,
      ),
    ).toBe(true);
    expect(res.body.data.some((p: { productCode: string }) => p.productCode === `${productCode}-NSCDC`)).toBe(true);
  });

  it('updates a product', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/admin/loan-products')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({
        productName: 'Updatable Product',
        productCode: `${productCode}-UPDATABLE`,
        sectors: ['NPF'],
        minimumAmount: 1000,
        maximumAmount: 500000,
        minimumTenorMonths: 1,
        maximumTenorMonths: 12,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      })
      .expect(201);

    const updateRes = await request(app.getHttpServer())
      .patch(`/admin/loan-products/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ isActive: false })
      .expect(200);
    expect(updateRes.body.isActive).toBe(false);
  });

  it('returns the known agencies from the sectors endpoint', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-products/sectors')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.sectors).toEqual(['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOM', 'LASG']);
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json admin-loan-products`
Expected: PASS (6 tests)

- [ ] **Step 4: Commit**

```bash
git add -A test/admin-loan-terms.e2e-spec.ts test/admin-loan-products.e2e-spec.ts
git commit -m "test(e2e): replace admin-loan-terms spec with admin-loan-products"
```

---

### Task 13: Postman collection update

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: nothing code-facing — this is documentation/tooling sync required by this repo's `CLAUDE.md`.

The collection is a single ~870KB JSON file; the safest way to make a large, precise, repeatable edit to it is a one-off Node script rather than hand-editing the JSON. Write the script, run it once, delete it (it's build tooling, not part of the app).

- [ ] **Step 1: Write the migration script**

```javascript
// scratchpad/migrate-postman-loan-products.js — run once, then delete.
const fs = require('fs');
const path = require('path');

const COLLECTION_PATH = path.join(__dirname, '..', 'postman', 'public-sector-backend.postman_collection.json');
const collection = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf8'));

function findFolder(items, name) {
  return items.find((it) => it.name === name && Array.isArray(it.item));
}

const adminGroup = findFolder(collection.item, 'Admin');
const clientGroup = findFolder(collection.item, 'Client');
if (!adminGroup || !clientGroup) {
  throw new Error('Could not find Admin/Client top-level groups');
}

const adminLoanTermsFolder = findFolder(adminGroup.item, 'Loan Terms');
const clientLoanTermsFolder = findFolder(clientGroup.item, 'Loan Terms');
if (!adminLoanTermsFolder || !clientLoanTermsFolder) {
  throw new Error('Could not find Loan Terms folders');
}

// ---- Admin > Loan Products ----
adminLoanTermsFolder.name = 'Loan Products';
adminLoanTermsFolder.item = [
  {
    name: 'POST /admin/loan-products - Success',
    request: {
      method: 'POST',
      header: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Authorization', value: 'Bearer {{admin_access_token}}' },
      ],
      body: {
        mode: 'raw',
        raw: JSON.stringify(
          {
            productName: 'Standard NPF Loan',
            productCode: 'STD-NPF-001',
            sectors: ['NPF'],
            minimumAmount: 10000,
            maximumAmount: 2000000,
            minimumTenorMonths: 1,
            maximumTenorMonths: 18,
            interestTiers: [
              { minTenorMonths: 1, maxTenorMonths: 4, interestRatePercent: 3 },
              { minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 },
              { minTenorMonths: 13, maxTenorMonths: 18, interestRatePercent: 6 },
            ],
            managementChargeType: 'PERCENTAGE',
            managementChargeValue: 2,
            managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          },
          null,
          2,
        ),
      },
      url: { raw: '{{base_url}}/admin/loan-products', host: ['{{base_url}}'], path: ['admin', 'loan-products'] },
    },
    event: [
      {
        listen: 'test',
        script: {
          exec: [
            "pm.test('status 201', () => pm.response.to.have.status(201));",
            'const json = pm.response.json();',
            "pm.test('productCode matches', () => pm.expect(json.productCode).to.eql('STD-NPF-001'));",
            "pm.collectionVariables.set('loan_product_id', json.id);",
          ],
        },
      },
    ],
    response: [
      {
        name: 'Success (201)',
        status: 'Created',
        code: 201,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify(
          {
            id: 'c5d6e7f8-a9b0-4c1d-2e3f-4a5b6c7d8e9f',
            productName: 'Standard NPF Loan',
            productCode: 'STD-NPF-001',
            sectors: ['NPF'],
            minimumAmount: '10000',
            maximumAmount: '2000000',
            minimumTenorMonths: 1,
            maximumTenorMonths: 18,
            interestTiers: [
              { minTenorMonths: 1, maxTenorMonths: 4, interestRatePercent: 3 },
              { minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 },
              { minTenorMonths: 13, maxTenorMonths: 18, interestRatePercent: 6 },
            ],
            managementChargeType: 'PERCENTAGE',
            managementChargeValue: '2',
            managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
            minimumServiceMonthsLeft: null,
            maximumMonthsInService: null,
            isActive: true,
            createdAt: '2026-10-13T10:00:00.000Z',
            updatedAt: '2026-10-13T10:00:00.000Z',
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    name: 'POST /admin/loan-products - Validation error (400)',
    request: {
      method: 'POST',
      header: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Authorization', value: 'Bearer {{admin_access_token}}' },
      ],
      body: {
        mode: 'raw',
        raw: JSON.stringify(
          {
            productName: 'Broken Product',
            productCode: 'BROKEN-001',
            sectors: ['NPF'],
            minimumAmount: 10000,
            maximumAmount: 2000000,
            minimumTenorMonths: 1,
            maximumTenorMonths: 6,
            interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 24, interestRatePercent: 5 }],
            managementChargeType: 'PERCENTAGE',
            managementChargeValue: 2,
            managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          },
          null,
          2,
        ),
      },
      url: { raw: '{{base_url}}/admin/loan-products', host: ['{{base_url}}'], path: ['admin', 'loan-products'] },
      description:
        "Tier [1-24] falls outside the product's own tenor range [1-6] -- rejected by the service-level interestTiers validation.",
    },
    event: [
      { listen: 'test', script: { exec: ["pm.test('status 400', () => pm.response.to.have.status(400));"] } },
    ],
    response: [
      {
        name: '400 Bad Request',
        status: 'Bad Request',
        code: 400,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify(
          {
            statusCode: 400,
            message: "Interest tier [1-24] must fall within the product's tenor range [1-6]",
            error: 'Bad Request',
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    name: 'POST /admin/loan-products - Conflict, duplicate productCode (409)',
    request: {
      method: 'POST',
      header: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Authorization', value: 'Bearer {{admin_access_token}}' },
      ],
      body: {
        mode: 'raw',
        raw: JSON.stringify(
          {
            productName: 'Standard NPF Loan',
            productCode: 'STD-NPF-001',
            sectors: ['NPF'],
            minimumAmount: 10000,
            maximumAmount: 2000000,
            minimumTenorMonths: 1,
            maximumTenorMonths: 18,
            interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 18, interestRatePercent: 5 }],
            managementChargeType: 'PERCENTAGE',
            managementChargeValue: 2,
            managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          },
          null,
          2,
        ),
      },
      url: { raw: '{{base_url}}/admin/loan-products', host: ['{{base_url}}'], path: ['admin', 'loan-products'] },
      description: "Run 'POST /admin/loan-products - Success' first so productCode STD-NPF-001 already exists.",
    },
    event: [
      { listen: 'test', script: { exec: ["pm.test('status 409', () => pm.response.to.have.status(409));"] } },
    ],
    response: [
      {
        name: '409 Conflict',
        status: 'Conflict',
        code: 409,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify(
          { statusCode: 409, message: 'A loan product with code "STD-NPF-001" already exists', error: 'Conflict' },
          null,
          2,
        ),
      },
    ],
  },
  {
    name: 'POST /admin/loan-products - Missing permission (403)',
    request: {
      method: 'POST',
      header: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Authorization', value: 'Bearer {{agent_access_token}}' },
      ],
      body: {
        mode: 'raw',
        raw: JSON.stringify(
          {
            productName: 'Standard NPF Loan',
            productCode: 'STD-NPF-002',
            sectors: ['NPF'],
            minimumAmount: 10000,
            maximumAmount: 2000000,
            minimumTenorMonths: 1,
            maximumTenorMonths: 18,
            interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 18, interestRatePercent: 5 }],
            managementChargeType: 'PERCENTAGE',
            managementChargeValue: 2,
            managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          },
          null,
          2,
        ),
      },
      url: { raw: '{{base_url}}/admin/loan-products', host: ['{{base_url}}'], path: ['admin', 'loan-products'] },
    },
    response: [
      {
        name: '403 Forbidden',
        status: 'Forbidden',
        code: 403,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify({ statusCode: 403, message: 'Insufficient permissions', error: 'Forbidden' }, null, 2),
      },
    ],
  },
  {
    name: 'GET /admin/loan-products - Success (all)',
    request: {
      method: 'GET',
      header: [{ key: 'Authorization', value: 'Bearer {{admin_access_token}}' }],
      url: {
        raw: '{{base_url}}/admin/loan-products',
        host: ['{{base_url}}'],
        path: ['admin', 'loan-products'],
        query: [
          { key: 'sectors', value: 'NPF', description: 'Optional. Products whose sectors include this agency.', disabled: true },
          { key: 'isActive', value: 'true', description: 'Optional. true | false.', disabled: true },
          { key: 'page', value: '1', description: 'Optional. Page number, defaults to 1.', disabled: true },
          { key: 'limit', value: '25', description: 'Optional. Page size, defaults to 25, hard max 100.', disabled: true },
        ],
      },
      description:
        'Lists loan products, filterable by sectors/isActive. Paginated (page/limit, default 1/25, limit capped at 100). Requires loan-products:manage. Response is { data, meta }.',
    },
    event: [
      {
        listen: 'test',
        script: {
          exec: [
            "pm.test('status 200', () => pm.response.to.have.status(200));",
            "pm.test('is a paginated result', () => {",
            '  const body = pm.response.json();',
            "  pm.expect(body.data).to.be.an('array');",
            "  pm.expect(body.meta).to.have.all.keys('total', 'page', 'limit', 'totalPages');",
            '});',
          ],
        },
      },
    ],
    response: [
      {
        name: 'Success (200)',
        status: 'OK',
        code: 200,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify(
          {
            data: [
              {
                id: 'c5d6e7f8-a9b0-4c1d-2e3f-4a5b6c7d8e9f',
                productName: 'Standard NPF Loan',
                productCode: 'STD-NPF-001',
                sectors: ['NPF'],
                minimumAmount: '10000',
                maximumAmount: '2000000',
                minimumTenorMonths: 1,
                maximumTenorMonths: 18,
                interestTiers: [
                  { minTenorMonths: 1, maxTenorMonths: 4, interestRatePercent: 3 },
                  { minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 },
                  { minTenorMonths: 13, maxTenorMonths: 18, interestRatePercent: 6 },
                ],
                managementChargeType: 'PERCENTAGE',
                managementChargeValue: '2',
                managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
                minimumServiceMonthsLeft: null,
                maximumMonthsInService: null,
                isActive: true,
                createdAt: '2026-10-13T10:00:00.000Z',
                updatedAt: '2026-10-13T10:00:00.000Z',
              },
            ],
            meta: { total: 1, page: 1, limit: 25, totalPages: 1 },
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    name: 'GET /admin/loan-products - Filtered by sectors',
    request: {
      method: 'GET',
      header: [{ key: 'Authorization', value: 'Bearer {{admin_access_token}}' }],
      url: {
        raw: '{{base_url}}/admin/loan-products?sectors=NPF',
        host: ['{{base_url}}'],
        path: ['admin', 'loan-products'],
        query: [{ key: 'sectors', value: 'NPF' }],
      },
    },
    response: [
      {
        name: 'Success (200)',
        status: 'OK',
        code: 200,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify(
          {
            data: [
              {
                id: 'c5d6e7f8-a9b0-4c1d-2e3f-4a5b6c7d8e9f',
                productName: 'Standard NPF Loan',
                productCode: 'STD-NPF-001',
                sectors: ['NPF'],
                minimumAmount: '10000',
                maximumAmount: '2000000',
                minimumTenorMonths: 1,
                maximumTenorMonths: 18,
                interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 18, interestRatePercent: 5 }],
                managementChargeType: 'PERCENTAGE',
                managementChargeValue: '2',
                managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
                minimumServiceMonthsLeft: null,
                maximumMonthsInService: null,
                isActive: true,
                createdAt: '2026-10-13T10:00:00.000Z',
                updatedAt: '2026-10-13T10:00:00.000Z',
              },
            ],
            meta: { total: 1, page: 1, limit: 25, totalPages: 1 },
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    name: 'PATCH /admin/loan-products/:id - Success',
    request: {
      method: 'PATCH',
      header: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Authorization', value: 'Bearer {{admin_access_token}}' },
      ],
      body: { mode: 'raw', raw: JSON.stringify({ isActive: false }, null, 2) },
      url: {
        raw: '{{base_url}}/admin/loan-products/{{loan_product_id}}',
        host: ['{{base_url}}'],
        path: ['admin', 'loan-products', '{{loan_product_id}}'],
      },
    },
    event: [
      {
        listen: 'test',
        script: {
          exec: [
            "pm.test('status 200', () => pm.response.to.have.status(200));",
            "pm.test('isActive updated', () => pm.expect(pm.response.json().isActive).to.eql(false));",
          ],
        },
      },
    ],
    response: [
      {
        name: 'Success (200)',
        status: 'OK',
        code: 200,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify(
          {
            id: 'c5d6e7f8-a9b0-4c1d-2e3f-4a5b6c7d8e9f',
            productName: 'Standard NPF Loan',
            productCode: 'STD-NPF-001',
            sectors: ['NPF'],
            minimumAmount: '10000',
            maximumAmount: '2000000',
            minimumTenorMonths: 1,
            maximumTenorMonths: 18,
            interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 18, interestRatePercent: 5 }],
            managementChargeType: 'PERCENTAGE',
            managementChargeValue: '2',
            managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
            minimumServiceMonthsLeft: null,
            maximumMonthsInService: null,
            isActive: false,
            createdAt: '2026-10-13T10:00:00.000Z',
            updatedAt: '2026-10-13T10:05:00.000Z',
          },
          null,
          2,
        ),
      },
    ],
  },
  {
    name: 'PATCH /admin/loan-products/:id - Not found (404)',
    request: {
      method: 'PATCH',
      header: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'Authorization', value: 'Bearer {{admin_access_token}}' },
      ],
      body: { mode: 'raw', raw: JSON.stringify({ isActive: false }, null, 2) },
      url: {
        raw: '{{base_url}}/admin/loan-products/00000000-0000-0000-0000-000000000000',
        host: ['{{base_url}}'],
        path: ['admin', 'loan-products', '00000000-0000-0000-0000-000000000000'],
      },
    },
    response: [
      {
        name: '404 Not Found',
        status: 'Not Found',
        code: 404,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify({ statusCode: 404, message: 'Loan product not found', error: 'Not Found' }, null, 2),
      },
    ],
  },
  {
    name: 'GET /admin/loan-products/sectors - Success',
    request: {
      method: 'GET',
      header: [{ key: 'Authorization', value: 'Bearer {{admin_access_token}}' }],
      url: { raw: '{{base_url}}/admin/loan-products/sectors', host: ['{{base_url}}'], path: ['admin', 'loan-products', 'sectors'] },
      description: 'Returns the full set of agencies this system recognizes, for populating a sectors picker when creating/editing a product.',
    },
    response: [
      {
        name: 'Success (200)',
        status: 'OK',
        code: 200,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify({ sectors: ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOM', 'LASG'] }, null, 2),
      },
    ],
  },
  {
    name: 'GET /admin/loan-products/sectors - Missing permission (403)',
    request: {
      method: 'GET',
      header: [{ key: 'Authorization', value: 'Bearer {{agent_access_token}}' }],
      url: { raw: '{{base_url}}/admin/loan-products/sectors', host: ['{{base_url}}'], path: ['admin', 'loan-products', 'sectors'] },
    },
    response: [
      {
        name: '403 Forbidden',
        status: 'Forbidden',
        code: 403,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify({ statusCode: 403, message: 'Insufficient permissions', error: 'Forbidden' }, null, 2),
      },
    ],
  },
];

// ---- Admin > Loan Settings (new sibling folder, inserted right after Loan Products) ----
const loanSettingsFolder = {
  name: 'Loan Settings',
  item: [
    {
      name: 'GET /admin/loan-settings - Success',
      request: {
        method: 'GET',
        header: [{ key: 'Authorization', value: 'Bearer {{admin_access_token}}' }],
        url: { raw: '{{base_url}}/admin/loan-settings', host: ['{{base_url}}'], path: ['admin', 'loan-settings'] },
        description:
          'Lazily initialized singleton (created with schema defaults retirementAgeYears=60/maxServiceYears=35 on first read). Requires loan-settings:manage.',
      },
      response: [
        {
          name: 'Success (200)',
          status: 'OK',
          code: 200,
          _postman_previewlanguage: 'json',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          cookie: [],
          body: JSON.stringify(
            { id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b', retirementAgeYears: 60, maxServiceYears: 35, updatedAt: '2026-10-13T10:00:00.000Z' },
            null,
            2,
          ),
        },
      ],
    },
    {
      name: 'GET /admin/loan-settings - Missing permission (403)',
      request: {
        method: 'GET',
        header: [{ key: 'Authorization', value: 'Bearer {{agent_access_token}}' }],
        url: { raw: '{{base_url}}/admin/loan-settings', host: ['{{base_url}}'], path: ['admin', 'loan-settings'] },
      },
      response: [
        {
          name: '403 Forbidden',
          status: 'Forbidden',
          code: 403,
          _postman_previewlanguage: 'json',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          cookie: [],
          body: JSON.stringify({ statusCode: 403, message: 'Insufficient permissions', error: 'Forbidden' }, null, 2),
        },
      ],
    },
    {
      name: 'PATCH /admin/loan-settings - Success',
      request: {
        method: 'PATCH',
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: 'Bearer {{admin_access_token}}' },
        ],
        body: { mode: 'raw', raw: JSON.stringify({ retirementAgeYears: 62 }, null, 2) },
        url: { raw: '{{base_url}}/admin/loan-settings', host: ['{{base_url}}'], path: ['admin', 'loan-settings'] },
      },
      event: [
        {
          listen: 'test',
          script: {
            exec: [
              "pm.test('status 200', () => pm.response.to.have.status(200));",
              "pm.test('retirementAgeYears updated', () => pm.expect(pm.response.json().retirementAgeYears).to.eql(62));",
            ],
          },
        },
      ],
      response: [
        {
          name: 'Success (200)',
          status: 'OK',
          code: 200,
          _postman_previewlanguage: 'json',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          cookie: [],
          body: JSON.stringify(
            { id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b', retirementAgeYears: 62, maxServiceYears: 35, updatedAt: '2026-10-13T10:05:00.000Z' },
            null,
            2,
          ),
        },
      ],
    },
    {
      name: 'PATCH /admin/loan-settings - Validation error (400)',
      request: {
        method: 'PATCH',
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: 'Bearer {{admin_access_token}}' },
        ],
        body: { mode: 'raw', raw: JSON.stringify({ retirementAgeYears: -5 }, null, 2) },
        url: { raw: '{{base_url}}/admin/loan-settings', host: ['{{base_url}}'], path: ['admin', 'loan-settings'] },
      },
      response: [
        {
          name: '400 Bad Request',
          status: 'Bad Request',
          code: 400,
          _postman_previewlanguage: 'json',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          cookie: [],
          body: JSON.stringify(
            {
              statusCode: 400,
              message: ['retirementAgeYears must be a positive number', 'retirementAgeYears must be an integer number'],
              error: 'Bad Request',
            },
            null,
            2,
          ),
        },
      ],
    },
    {
      name: 'PATCH /admin/loan-settings - Missing permission (403)',
      request: {
        method: 'PATCH',
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: 'Bearer {{agent_access_token}}' },
        ],
        body: { mode: 'raw', raw: JSON.stringify({ retirementAgeYears: 62 }, null, 2) },
        url: { raw: '{{base_url}}/admin/loan-settings', host: ['{{base_url}}'], path: ['admin', 'loan-settings'] },
      },
      response: [
        {
          name: '403 Forbidden',
          status: 'Forbidden',
          code: 403,
          _postman_previewlanguage: 'json',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          cookie: [],
          body: JSON.stringify({ statusCode: 403, message: 'Insufficient permissions', error: 'Forbidden' }, null, 2),
        },
      ],
    },
  ],
};
const adminLoanProductsIndex = adminGroup.item.indexOf(adminLoanTermsFolder);
adminGroup.item.splice(adminLoanProductsIndex + 1, 0, loanSettingsFolder);

// ---- Client > Loan Products ----
clientLoanTermsFolder.name = 'Loan Products';
clientLoanTermsFolder.item = [
  {
    name: 'GET /client/loan-products - Success',
    request: {
      method: 'GET',
      header: [{ key: 'Authorization', value: 'Bearer {{client_access_token}}' }],
      url: {
        raw: '{{base_url}}/client/loan-products',
        host: ['{{base_url}}'],
        path: ['client', 'loan-products'],
        query: [
          { key: 'page', value: '1', description: 'Optional. Page number, defaults to 1.', disabled: true },
          { key: 'limit', value: '25', description: 'Optional. Page size, defaults to 25, hard max 100.', disabled: true },
        ],
      },
      description:
        "Lists active loan products matching the client's own IPPIS agency and service-length eligibility (no amount/tenor filter -- the client hasn't chosen those yet). Each item carries its full interestTiers array.",
    },
    event: [
      {
        listen: 'test',
        script: {
          exec: [
            "pm.test('status 200', () => pm.response.to.have.status(200));",
            "pm.test('is paginated envelope', () => {",
            '  const json = pm.response.json();',
            "  pm.expect(json.data).to.be.an('array');",
            "  pm.expect(json.meta).to.have.all.keys('total', 'page', 'limit', 'totalPages');",
            '});',
          ],
        },
      },
    ],
    response: [
      {
        name: 'Success (200)',
        status: 'OK',
        code: 200,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        cookie: [],
        body: JSON.stringify(
          {
            data: [
              {
                id: 'c5d6e7f8-a9b0-4c1d-2e3f-4a5b6c7d8e9f',
                productName: 'Standard NPF Loan',
                productCode: 'STD-NPF-001',
                sectors: ['NPF'],
                minimumAmount: '10000',
                maximumAmount: '2000000',
                minimumTenorMonths: 1,
                maximumTenorMonths: 18,
                interestTiers: [
                  { minTenorMonths: 1, maxTenorMonths: 4, interestRatePercent: 3 },
                  { minTenorMonths: 6, maxTenorMonths: 12, interestRatePercent: 5 },
                  { minTenorMonths: 13, maxTenorMonths: 18, interestRatePercent: 6 },
                ],
                managementChargeType: 'PERCENTAGE',
                managementChargeValue: '2',
                managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
                minimumServiceMonthsLeft: null,
                maximumMonthsInService: null,
                isActive: true,
                createdAt: '2026-10-13T10:00:00.000Z',
                updatedAt: '2026-10-13T10:00:00.000Z',
              },
            ],
            meta: { total: 1, page: 1, limit: 25, totalPages: 1 },
          },
          null,
          2,
        ),
      },
    ],
  },
];

fs.writeFileSync(COLLECTION_PATH, JSON.stringify(collection, null, 2) + '\n');
console.log('Postman collection updated.');
```

- [ ] **Step 2: Run the script**

Run: `node scratchpad/migrate-postman-loan-products.js`
Expected: logs `Postman collection updated.` with no errors.

- [ ] **Step 3: Validate the result is well-formed JSON and the rename took effect**

Run:
```bash
python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo "valid JSON"
grep -c '"Loan Terms"' postman/public-sector-backend.postman_collection.json
```
Expected: `valid JSON` printed, and the grep count is `0` (no `"Loan Terms"` folder names remain).

- [ ] **Step 4: Delete the one-off script**

```bash
rm scratchpad/migrate-postman-loan-products.js
```

(If your scratchpad directory is outside the repo, this step is a no-op — just confirm the script isn't left tracked in the repo via `git status`.)

- [ ] **Step 5: Commit**

```bash
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs(postman): rename Loan Terms to Loan Products, add Loan Settings folder and sectors endpoint coverage"
```

**Important:** the `400` validation-error example bodies and the `PATCH /admin/loan-settings - Validation error (400)` example's `message` array are best-effort reconstructions from the DTO decorators, not captured from a live response. Before considering this task done, actually run the `POST /admin/loan-products - Validation error (400)` and `PATCH /admin/loan-settings - Validation error (400)` requests against a running local server (or re-run the equivalent e2e assertions and read the actual response body) and correct the saved example bodies in the collection if the real message text differs.

---

### Task 14: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit test suite**

Run: `npx jest`
Expected: PASS. If anything outside this feature's touched files fails, investigate before proceeding — it should be unrelated, but confirm rather than assume.

- [ ] **Step 2: Full e2e test suite**

Run: `npx jest --config ./test/jest-e2e.json`
Expected: PASS. Per established practice in this project, re-run any failing spec in isolation before treating it as a regression — this shared UAT database has known contention-based flakiness under full-suite concurrent load that is unrelated to code correctness.

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit` and `npm run lint` (or this repo's equivalent lint script — check `package.json`)
Expected: both clean.

- [ ] **Step 4: Confirm no stray references to the retired concepts remain**

Run:
```bash
grep -rn "loanTermOption\|LoanTermOption\|AmountWithinSalaryCapRule\|LOAN_SALARY_MULTIPLE_CAP\|loan-terms" src test prisma/schema.prisma .env.example postman/public-sector-backend.postman_collection.json 2>/dev/null
```
Expected: no output (or only expected false positives — review anything that appears).

- [ ] **Step 5: Clean up any e2e test rows left in the shared UAT database**

Per standing project practice, confirm no stray rows were left behind. Connect to the UAT database and check for leftover fixture rows this feature's e2e specs might have created outside their own `afterAll` cleanup (shouldn't happen given Task 11/12's scoped `deleteMany` calls, but verify):

```sql
SELECT "productCode" FROM "LoanProduct" WHERE "productCode" LIKE 'E2E-%';
```
Expected: no rows (all e2e specs clean up their own `LoanProduct` fixtures by exact `productCode`/`productCode` prefix in `afterAll`). If any are found, delete them.

- [ ] **Step 6: Final review pass**

Re-read `docs/superpowers/specs/2026-10-13-loan-product-design.md` once more against the diff (`git diff main...HEAD` or equivalent) and confirm every numbered section (§1-§10) has a corresponding implemented piece. This plan's tasks map to the spec as: §2→Task 1, §6→Tasks 2/8, §3→Task 4, §4→Task 3, §5→Tasks 5/7/6, §7→Tasks 8/10, §8→Tasks 3/4/5/6/8, §9→Task 13, §10→(intentionally not implemented).
