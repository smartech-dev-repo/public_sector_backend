# Loan Topup Implementation Plan (Loan Lifecycle Overhaul — B2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client add more funds to their existing single active `ClientLoan`, reusing the origination request→confirm→approve→disburse pipeline (B1) via a `type` discriminator on `LoanRequest`, rather than building a second pipeline.

**Architecture:** `LoanRequest` gains `type: ORIGINATION | TOPUP` plus a `topupTargetId` pointing at the `ClientLoan` being topped up. A new `TopupEligibilityService` (separate rule chain, reusing two of the three existing rules) gates `LoanRequestService.createTopup()`. The existing shared disbursement-creation private method branches on `type`: `ORIGINATION` creates a new `ClientLoan` (unchanged from B1); `TOPUP` updates the existing one.

**Tech Stack:** NestJS 10, Prisma 7, Jest, class-validator.

**Spec:** `docs/superpowers/specs/2026-09-21-loan-topup-design.md`

## Global Constraints

- `LoanRequest.type` defaults to `ORIGINATION`; `topupTargetId` is set only for `TOPUP` requests (spec §2).
- Because `LoanRequest` now has two distinct relations to `ClientLoan` (the 1:1 "this request originated this loan" relation from B1, and the new 1:many "this request topped up this loan" relation), both must be given explicit Prisma relation names to avoid an ambiguous-relation schema error — the spec doesn't name them, so this plan names them `"OriginatingRequest"` and `"TopupRequests"` (spec §2, refined here for Prisma's requirements).
- Topup eligibility is a separate `TopupEligibilityService`/rule chain, not a branch inside the existing `EligibilityService` — reuses `ClientMustBeVerifiedRule`/`AmountWithinSalaryCapRule` unchanged, adds `HasActiveLoanRule`/`NoTopupInProgressRule` (spec §3).
- The salary cap applies to the topup amount alone, not combined with existing principal (spec §3).
- `POST /client/loan-requests/topup` takes no loan ID — the service looks up the client's one `ACTIVE` `ClientLoan` itself (spec §4).
- On disbursement, a `TOPUP` request updates the existing `ClientLoan` (`principalAmount`/`principalBalance`/`disbursedAmount` increase; `maturationDate = max(current, topup.disbursementDate + topup.tenorMonths)`) instead of creating a new one (spec §4).
- Auto-approval/manual-approval/reject/disburse (the existing `LOAN_AUTO_APPROVE_THRESHOLD` status machine) apply unchanged to topup requests, evaluated against the topup amount (spec §4).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the API-surface changes, with a saved response example per request.
- Per this session's standing testing preference: run only the test file(s) relevant to what changed in each task — never the full suite for any task in this plan, including its last one. This plan is B2 of a four-part phase (B3 repayment tracking, B4 spend-wallet still to come); a full suite run only happens at the end of the whole phase or when explicitly requested.

---

### Task 1: Schema — `LoanRequestType` and the topup relation

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `LoanRequestType` (`ORIGINATION`/`TOPUP`), `LoanRequest.type`, `LoanRequest.topupTargetId`, `LoanRequest.topupTarget` (relation to `ClientLoan`), `ClientLoan.topupRequests` (reverse relation) — every later task depends on these exact names.

- [ ] **Step 1: Add the enum**

In `prisma/schema.prisma`, add (e.g. near `LoanRequestStatus`):

```prisma
enum LoanRequestType {
  ORIGINATION
  TOPUP
}
```

- [ ] **Step 2: Add the new fields and name both `LoanRequest`↔`ClientLoan` relations**

`LoanRequest` currently has a reverse relation `clientLoan ClientLoan?` (from B1, the 1:1 "this request originated this loan" link) and `ClientLoan` has `loanRequest LoanRequest @relation(fields: [loanRequestId], references: [id])`. Adding a second, different relation between the same two models means Prisma requires both relations to be explicitly named to disambiguate. Update both models:

In `LoanRequest`, add `type` and the new topup fields, and name the existing reverse relation:

```prisma
  type            LoanRequestType @default(ORIGINATION)
  clientLoan      ClientLoan?     @relation("OriginatingRequest")
  topupTargetId   String?
  topupTarget     ClientLoan?     @relation("TopupRequests", fields: [topupTargetId], references: [id])
```

(`clientLoan ClientLoan?` already exists from B1 as a bare reverse relation with no explicit name — replace that line with the named version above; `type`/`topupTargetId`/`topupTarget` are new.)

In `ClientLoan`, name the existing forward relation and add the new reverse one:

```prisma
  loanRequest   LoanRequest   @relation("OriginatingRequest", fields: [loanRequestId], references: [id])
  topupRequests LoanRequest[] @relation("TopupRequests")
```

(`loanRequest`/`loanRequestId` already exist from B1 — just add the `"OriginatingRequest"` name to the existing `@relation(...)` call; `topupRequests` is new.)

- [ ] **Step 3: Generate and run the migration**

Run: `npx prisma migrate dev --name add_loan_topup`
Expected: creates and applies `prisma/migrations/<timestamp>_add_loan_topup/migration.sql`.

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (this is a pure additive schema change — existing code that creates a `LoanRequest` doesn't need to set `type` since it defaults to `ORIGINATION`).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add LoanRequestType and topup relation to LoanRequest/ClientLoan"
```

---

### Task 2: Topup eligibility rules

**Files:**
- Create: `src/loan-request/eligibility/has-active-loan.rule.ts`
- Test: `src/loan-request/eligibility/has-active-loan.rule.spec.ts`
- Create: `src/loan-request/eligibility/no-topup-in-progress.rule.ts`
- Test: `src/loan-request/eligibility/no-topup-in-progress.rule.spec.ts`
- Create: `src/loan-request/eligibility/topup-eligibility.service.ts`
- Test: `src/loan-request/eligibility/topup-eligibility.service.spec.ts`
- Modify: `src/loan-request/loan-request.module.ts`

**Interfaces:**
- Consumes: `ClientLoanStatus`/`LoanRequestStatus` (already exist), `EligibilityRule`/`EligibilityCheckResult` (already exist, unchanged), `ClientMustBeVerifiedRule`/`AmountWithinSalaryCapRule` (already exist, unchanged).
- Produces: `HasActiveLoanRule`, `NoTopupInProgressRule`, `TopupEligibilityService.check(client, ippisRecord, amount): Promise<EligibilityCheckResult>` — Task 3's `LoanRequestService.createTopup` consumes `TopupEligibilityService`.

- [ ] **Step 1: Write the failing tests for `HasActiveLoanRule`**

`src/loan-request/eligibility/has-active-loan.rule.spec.ts`:

```typescript
import { HasActiveLoanRule } from './has-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('HasActiveLoanRule', () => {
  let rule: HasActiveLoanRule;
  let prisma: { clientLoan: { findFirst: jest.Mock } };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = { clientLoan: { findFirst: jest.fn() } };
    rule = new HasActiveLoanRule(prisma as unknown as PrismaService);
  });

  it('fails when the client has no ACTIVE ClientLoan', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no active loan/);
  });

  it('passes when the client has an ACTIVE ClientLoan', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
    expect(prisma.clientLoan.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'client-1', status: 'ACTIVE' },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/loan-request/eligibility/has-active-loan.rule.spec.ts`
Expected: FAIL — `Cannot find module './has-active-loan.rule'`.

- [ ] **Step 3: Implement `HasActiveLoanRule`**

`src/loan-request/eligibility/has-active-loan.rule.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Client, ClientLoanStatus, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

@Injectable()
export class HasActiveLoanRule implements EligibilityRule {
  constructor(private readonly prisma: PrismaService) {}

  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const activeLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId: client.id, status: ClientLoanStatus.ACTIVE },
    });
    if (!activeLoan) {
      return { eligible: false, reason: 'Client has no active loan to top up' };
    }
    return { eligible: true };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/loan-request/eligibility/has-active-loan.rule.spec.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Write the failing tests for `NoTopupInProgressRule`**

`src/loan-request/eligibility/no-topup-in-progress.rule.spec.ts`:

```typescript
import { NoTopupInProgressRule } from './no-topup-in-progress.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('NoTopupInProgressRule', () => {
  let rule: NoTopupInProgressRule;
  let prisma: { loanRequest: { findFirst: jest.Mock } };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = { loanRequest: { findFirst: jest.fn() } };
    rule = new NoTopupInProgressRule(prisma as unknown as PrismaService);
  });

  it('fails when the client has a non-terminal LoanRequest', async () => {
    prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/still in progress/);
  });

  it('passes when the client has no non-terminal LoanRequest', async () => {
    prisma.loanRequest.findFirst.mockResolvedValue(null);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
    expect(prisma.loanRequest.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'client-1', status: { in: ['PENDING', 'CONFIRMED', 'APPROVED'] } },
    });
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx jest src/loan-request/eligibility/no-topup-in-progress.rule.spec.ts`
Expected: FAIL — `Cannot find module './no-topup-in-progress.rule'`.

- [ ] **Step 7: Implement `NoTopupInProgressRule`**

`src/loan-request/eligibility/no-topup-in-progress.rule.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Client, IppisRecord, LoanRequestStatus } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

const NON_TERMINAL_LOAN_REQUEST_STATUSES = [
  LoanRequestStatus.PENDING,
  LoanRequestStatus.CONFIRMED,
  LoanRequestStatus.APPROVED,
];

@Injectable()
export class NoTopupInProgressRule implements EligibilityRule {
  constructor(private readonly prisma: PrismaService) {}

  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const inProgress = await this.prisma.loanRequest.findFirst({
      where: { clientId: client.id, status: { in: NON_TERMINAL_LOAN_REQUEST_STATUSES } },
    });
    if (inProgress) {
      return { eligible: false, reason: 'A previous loan request is still in progress' };
    }
    return { eligible: true };
  }
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx jest src/loan-request/eligibility/no-topup-in-progress.rule.spec.ts`
Expected: PASS — 2 tests.

- [ ] **Step 9: Write the failing tests for `TopupEligibilityService`**

`src/loan-request/eligibility/topup-eligibility.service.spec.ts`:

```typescript
import { TopupEligibilityService } from './topup-eligibility.service';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';
import { HasActiveLoanRule } from './has-active-loan.rule';
import { NoTopupInProgressRule } from './no-topup-in-progress.rule';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('TopupEligibilityService', () => {
  function buildService(overrides: { hasActiveLoan?: boolean; noTopupInProgress?: boolean } = {}) {
    const clientMustBeVerifiedRule = { check: () => ({ eligible: true }) } as unknown as ClientMustBeVerifiedRule;
    const amountWithinSalaryCapRule = { check: () => ({ eligible: true }) } as unknown as AmountWithinSalaryCapRule;
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
    return new TopupEligibilityService(
      clientMustBeVerifiedRule,
      amountWithinSalaryCapRule,
      hasActiveLoanRule,
      noTopupInProgressRule,
    );
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

- [ ] **Step 10: Run tests to verify they fail**

Run: `npx jest src/loan-request/eligibility/topup-eligibility.service.spec.ts`
Expected: FAIL — `Cannot find module './topup-eligibility.service'`.

- [ ] **Step 11: Implement `TopupEligibilityService`**

`src/loan-request/eligibility/topup-eligibility.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';
import { HasActiveLoanRule } from './has-active-loan.rule';
import { NoTopupInProgressRule } from './no-topup-in-progress.rule';

@Injectable()
export class TopupEligibilityService {
  private readonly rules: EligibilityRule[];

  constructor(
    clientMustBeVerifiedRule: ClientMustBeVerifiedRule,
    amountWithinSalaryCapRule: AmountWithinSalaryCapRule,
    hasActiveLoanRule: HasActiveLoanRule,
    noTopupInProgressRule: NoTopupInProgressRule,
  ) {
    this.rules = [clientMustBeVerifiedRule, amountWithinSalaryCapRule, hasActiveLoanRule, noTopupInProgressRule];
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

- [ ] **Step 12: Run tests to verify they pass**

Run: `npx jest src/loan-request/eligibility/topup-eligibility.service.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 13: Wire the new providers into `LoanRequestModule`**

In `src/loan-request/loan-request.module.ts`, add imports for `HasActiveLoanRule`, `NoTopupInProgressRule`, `TopupEligibilityService`, and add all three to the `providers` array (alongside the existing `NoActiveLoanRule` etc.).

- [ ] **Step 14: Type-check and run the full eligibility suite**

Run: `npx tsc --noEmit && npx jest src/loan-request/eligibility`
Expected: both clean — no type errors, all eligibility suites (old and new) passing.

- [ ] **Step 15: Commit**

```bash
git add src/loan-request/eligibility src/loan-request/loan-request.module.ts
git commit -m "feat: add topup eligibility rules and TopupEligibilityService"
```

---

### Task 3: `LoanRequestService` — `createTopup` and disbursement branching

**Files:**
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`

**Interfaces:**
- Consumes: `TopupEligibilityService` (Task 2), `LoanRequestType`/`ClientLoan.topupTargetId` (Task 1).
- Produces: `LoanRequestService.createTopup(clientId: string, amount: number, tenorMonths: number)`, `.listAll(status?: LoanRequestStatus, type?: LoanRequestType)` (extended signature) — Task 4's controllers consume both.

This is the constructor-signature-changing task: `LoanRequestService` gains a new required `topupEligibilityService: TopupEligibilityService` parameter, inserted **before** the existing optional `configService?: ConfigService` (TypeScript requires all non-optional parameters before optional ones). Every place the spec file constructs `new LoanRequestService(...)` needs a `topupEligibilityService` mock inserted as the 5th argument — there are three such call sites in the current file (the main `beforeEach`, and two inside the `'confirmByPhone with auto-approval'` tests that reconstruct `service` with a real `configService`).

- [ ] **Step 1: Update the `prisma`/service-construction scaffolding in the spec file**

Read `src/loan-request/loan-request.service.spec.ts`'s current full state first. Make these changes:

1. Add `import { TopupEligibilityService } from './eligibility/topup-eligibility.service';` to the top imports.
2. Add `import { LoanRequestType } from '../generated/prisma/client';` — merge into the existing `'../generated/prisma/client'` import if there is one at the top level (this specific import may only exist inside individual test bodies as string literals so far; if there's no top-level import from that module yet, add a new one).
3. Add a `topupEligibilityService: { check: jest.Mock }` variable declaration alongside the existing `eligibilityService`/`smsProvider`/`expiryQueue` declarations, and initialize it in `beforeEach`: `topupEligibilityService = { check: jest.fn() };`.
4. Widen the `clientLoan` entry in the `prisma` mock's type declaration and `beforeEach` (already `{ create: jest.Mock; findMany: jest.Mock }` after Tasks 5/7 of the origination plan) to also include `findUniqueOrThrow` and `update`:

```typescript
    clientLoan: { create: jest.Mock; findMany: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock };
```

```typescript
      clientLoan: { create: jest.fn(), findMany: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
```

5. Add `findFirstOrThrow: jest.Mock` to that same `clientLoan` mock type/`beforeEach` too (`createTopup` needs it to re-fetch the client's active loan):

```typescript
    clientLoan: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      findFirstOrThrow: jest.Mock;
    };
```

```typescript
      clientLoan: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        findFirstOrThrow: jest.fn(),
      },
```

6. Update the main `beforeEach`'s `service = new LoanRequestService(...)` call to insert `topupEligibilityService as unknown as TopupEligibilityService` as the 5th argument:

```typescript
    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
      topupEligibilityService as unknown as TopupEligibilityService,
    );
```

7. In both `'confirmByPhone with auto-approval'` tests (the ones that reconstruct `service` with a real `configService` as the last argument), insert `topupEligibilityService as unknown as TopupEligibilityService` as the 5th argument, before `configService` (now the 6th):

```typescript
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        topupEligibilityService as unknown as TopupEligibilityService,
        configService,
      );
```

- [ ] **Step 2: Run the suite to confirm the scaffolding change alone now fails against the old constructor**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `Expected 5-6 arguments, but got 4-5` (the service class itself hasn't been updated yet in this step; this confirms the spec-side scaffolding change is in place and driving a real compile/constructor mismatch, matching TDD's fail-first step for this task's constructor change).

- [ ] **Step 3: Write the failing tests for `createTopup` and the disbursement branching**

Append these new `describe` blocks to `src/loan-request/loan-request.service.spec.ts`, after the existing `describe('exportDisbursementSummaryCsv', ...)` block:

```typescript
  describe('createTopup', () => {
    it('rejects when the client has no onboarding record', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      await expect(service.createTopup('c1', 2000, 12)).rejects.toThrow(ConflictException);
    });

    it('rejects when topup eligibility fails, without sending any SMS', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: false, reason: 'Client has no active loan to top up' });

      await expect(service.createTopup('c1', 2000, 12)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });

    it('rejects when there is no active loan term for the requested tenor', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue(null);

      await expect(service.createTopup('c1', 2000, 99)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });

    it('sends a top-up-worded SMS and creates a TOPUP LoanRequest pointing at the active loan', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanTermOption.findUnique.mockResolvedValue({
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        isActive: true,
      });
      prisma.clientLoan.findFirstOrThrow.mockResolvedValue({ id: 'cl1' });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('top-up'));
      expect(prisma.loanRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          amount: 2000,
          tenorMonths: 12,
          type: 'TOPUP',
          topupTargetId: 'cl1',
          managementChargeAmount: 40,
        }),
      });
      expect(expiryQueue.add).toHaveBeenCalledWith('expire', { loanRequestId: 'lr2' }, { delay: 24 * 60 * 60 * 1000 });
    });
  });

  describe('disburse with a TOPUP request', () => {
    it('updates the existing ClientLoan and extends maturity when the topup tenor pushes it further out', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr2', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr2', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr2',
        type: 'TOPUP',
        topupTargetId: 'cl1',
        amount: 2000,
        tenorMonths: 12,
        managementChargeAmount: 40,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      });
      const nearFutureMaturity = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      prisma.clientLoan.findUniqueOrThrow.mockResolvedValue({
        id: 'cl1',
        principalAmount: 5000,
        principalBalance: 4000,
        disbursedAmount: 4900,
        maturationDate: nearFutureMaturity,
      });
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1' });

      await service.disburse('lr2');

      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: expect.objectContaining({
          principalAmount: 7000,
          principalBalance: 6000,
          disbursedAmount: 6860,
        }),
      });
      const call = (prisma.clientLoan.update.mock.calls[0] as [{ data: { maturationDate: Date } }])[0];
      expect(call.data.maturationDate.getTime()).toBeGreaterThan(nearFutureMaturity.getTime());
      expect(prisma.clientLoan.create).not.toHaveBeenCalled();
    });

    it('keeps the existing maturationDate when the topup tenor does not extend beyond it', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr2', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr2', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr2',
        type: 'TOPUP',
        topupTargetId: 'cl1',
        amount: 1000,
        tenorMonths: 1,
        managementChargeAmount: 20,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      });
      const veryFarFutureMaturity = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 5);
      prisma.clientLoan.findUniqueOrThrow.mockResolvedValue({
        id: 'cl1',
        principalAmount: 5000,
        principalBalance: 4000,
        disbursedAmount: 5000,
        maturationDate: veryFarFutureMaturity,
      });
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1' });

      await service.disburse('lr2');

      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: expect.objectContaining({
          principalAmount: 6000,
          principalBalance: 5000,
          disbursedAmount: 6000,
          maturationDate: veryFarFutureMaturity,
        }),
      });
    });
  });

  describe('listAll with a type filter', () => {
    it('filters by type when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      await service.listAll(undefined, 'TOPUP' as never);
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith({
        where: { status: undefined, type: 'TOPUP' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `service.createTopup is not a function`, and the disbursement-branching/`listAll` tests fail against the current single-purpose implementation.

- [ ] **Step 5: Implement the service changes**

In `src/loan-request/loan-request.service.ts`:

1. Add these imports (merge into the existing `'../generated/prisma/client'` import line):

```typescript
import {
  ClientLoan,
  ClientLoanStatus,
  LoanRequest,
  LoanRequestStatus,
  LoanRequestType,
  ManagementChargeApplication,
  ManagementChargeType,
} from '../generated/prisma/client';
```

Add `import { TopupEligibilityService } from './eligibility/topup-eligibility.service';`.

2. Add `topupEligibilityService: TopupEligibilityService` as a new, required 5th constructor parameter, before the existing optional `configService`:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    @Inject(TWO_WAY_SMS_PROVIDER) private readonly smsProvider: TwoWaySmsProvider,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
    private readonly topupEligibilityService: TopupEligibilityService,
    private readonly configService?: ConfigService,
  ) {}
```

3. Replace `confirmationMessage` to take an optional type (defaulting to `ORIGINATION`, so the two existing call sites in `create`/`resend` need no changes):

```typescript
  private confirmationMessage(amount: number, type: LoanRequestType = LoanRequestType.ORIGINATION): string {
    return type === LoanRequestType.TOPUP
      ? `Reply YES to confirm your loan top-up of ₦${amount}`
      : `Reply YES to confirm your loan request of ₦${amount}`;
  }
```

4. Replace `createClientLoanFromRequest` to branch on `type`, extracting the origination-only logic into the branch and adding a new `applyTopupToClientLoan` private method:

```typescript
  private async createClientLoanFromRequest(loanRequestId: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUniqueOrThrow({ where: { id: loanRequestId } });

    if (loanRequest.type === LoanRequestType.TOPUP) {
      await this.applyTopupToClientLoan(loanRequest);
      return;
    }

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

  private async applyTopupToClientLoan(loanRequest: LoanRequest): Promise<void> {
    const clientLoan = await this.prisma.clientLoan.findUniqueOrThrow({
      where: { id: loanRequest.topupTargetId! },
    });

    const topupAmount = Number(loanRequest.amount);
    const managementChargeAmount = Number(loanRequest.managementChargeAmount);
    const topupDisbursedAmount =
      loanRequest.managementChargeApplication === ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT
        ? topupAmount - managementChargeAmount
        : topupAmount;

    const disbursementDate = new Date();
    const topupMaturationDate = new Date(disbursementDate);
    topupMaturationDate.setMonth(topupMaturationDate.getMonth() + loanRequest.tenorMonths);

    const newMaturationDate =
      topupMaturationDate.getTime() > clientLoan.maturationDate.getTime()
        ? topupMaturationDate
        : clientLoan.maturationDate;

    await this.prisma.clientLoan.update({
      where: { id: clientLoan.id },
      data: {
        principalAmount: Number(clientLoan.principalAmount) + topupAmount,
        principalBalance: Number(clientLoan.principalBalance) + topupAmount,
        disbursedAmount: Number(clientLoan.disbursedAmount) + topupDisbursedAmount,
        maturationDate: newMaturationDate,
      },
    });
  }
```

5. Add `createTopup`, mirroring `create` but targeting the client's existing active loan:

```typescript
  async createTopup(clientId: string, amount: number, tenorMonths: number) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      throw new ConflictException('Client has not completed onboarding');
    }

    const eligibility = await this.topupEligibilityService.check(client, onboarding.ippisRecord, amount);
    if (!eligibility.eligible) {
      throw new UnprocessableEntityException(eligibility.reason);
    }

    const activeLoan = await this.prisma.clientLoan.findFirstOrThrow({
      where: { clientId, status: ClientLoanStatus.ACTIVE },
    });

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

    await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

    return loanRequest;
  }
```

6. Update `listAll` to accept and apply an optional `type` filter:

```typescript
  async listAll(status?: LoanRequestStatus, type?: LoanRequestType) {
    return this.prisma.loanRequest.findMany({ where: { status, type }, orderBy: { createdAt: 'desc' } });
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks in the full file after this step to confirm the total, rather than trusting a specific stated number (this task added 4 `createTopup` tests + 2 `disburse with a TOPUP request` tests + 1 `listAll with a type filter` test = 7 new tests on top of whatever count Task 7 of the origination plan left the file at). The pre-existing `listAll`/`disburse`/`confirmByPhone` tests from the origination plan must still pass unchanged — the `type` field defaults to `undefined` in their hand-built mock `LoanRequest` objects, which correctly falls through to the `ORIGINATION` branch (`undefined === LoanRequestType.TOPUP` is `false`), and Jest's `toHaveBeenCalledWith` treats an object with an extra `undefined`-valued key as equal to one without that key, so the existing `listAll` assertion (`{ where: { status: 'CONFIRMED' }, ... }`) still matches the new call shape (`{ where: { status: 'CONFIRMED', type: undefined }, ... }`) without needing to be touched.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts
git commit -m "feat: add createTopup and topup disbursement handling to LoanRequestService"
```

---

### Task 4: Controllers — topup endpoint and admin type filter

**Files:**
- Modify: `src/loan-request/loan-request.controller.ts`
- Modify: `src/loan-request/admin-loan-request.controller.ts`

**Interfaces:**
- Consumes: `LoanRequestService.createTopup`/`.listAll` (Task 3), `CreateLoanRequestDto` (already exists — reused as-is, since a topup's body shape, `{ amount, tenorMonths }`, is identical to an origination request's).
- Produces: `POST /client/loan-requests/topup`, `GET /admin/loan-requests?type=`.

- [ ] **Step 1: Add the topup endpoint to the client controller**

In `src/loan-request/loan-request.controller.ts`, add this method to the class, after `create`:

```typescript
  @Post('topup')
  createTopup(@Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.createTopup(req.user.sub, dto.amount, dto.tenorMonths);
  }
```

(`CreateLoanRequestDto` is already imported — its `{ amount, tenorMonths }` shape is reused unchanged, since a topup's request body is identical in shape to an origination request's.)

- [ ] **Step 2: Add the `type` filter to the admin controller**

In `src/loan-request/admin-loan-request.controller.ts`, add `LoanRequestType` to the existing `'../generated/prisma/client'` import, and update `list`:

```typescript
  @Get()
  list(@Query('status') status?: LoanRequestStatus, @Query('type') type?: LoanRequestType) {
    return this.loanRequestService.listAll(status, type);
  }
```

- [ ] **Step 3: Type-check and run the loan-request unit suite**

Run: `npx tsc --noEmit && npx jest src/loan-request`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/loan-request/loan-request.controller.ts src/loan-request/admin-loan-request.controller.ts
git commit -m "feat: add topup endpoint and admin type filter"
```

---

### Task 5: e2e tests, README, and Postman

**Files:**
- Create: `test/loan-topup.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

- [ ] **Step 1: Write the e2e test**

Read `test/loan-origination.e2e-spec.ts` first (the admin-login/client-fixture pattern this mirrors, including creating a `LoanTermOption` and running a full request→confirm→approve→disburse cycle). `test/loan-topup.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Loan topup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-TOPUP-${Date.now()}`;
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
        tenorMonths: 4,
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 1,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
  });

  afterAll(async () => {
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Topup Test' } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: 'E2E Topup Test' } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234805' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 4 } });
    await app.close();
  });

  async function createVerifiedClient(phoneSuffix: string, staffIdSuffix: string) {
    const phone = `+234805${phoneSuffix}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-${staffIdSuffix}`, employeeName: 'E2E Topup Test', salary: 2000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Topup Test',
        agency,
        step: 'COMPLETED',
      },
    });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });
    return { client, accessToken };
  }

  async function originateAndDisburseLoan(phoneSuffix: string, staffIdSuffix: string) {
    const { client, accessToken } = await createVerifiedClient(phoneSuffix, staffIdSuffix);

    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 100000, tenorMonths: 4 })
      .expect(201);
    const loanRequestId = createRes.body.id;

    await request(app.getHttpServer())
      .post('/webhooks/sms/inbound')
      .send({ phone: client.phone, message: 'YES' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/disburse`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    return { client, accessToken };
  }

  it(
    'runs a full topup flow: existing active loan -> topup request -> confirm -> admin approve/disburse -> ClientLoan updated',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000001', 'A');
      const before = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-A` } });

      const topupRes = await request(app.getHttpServer())
        .post('/client/loan-requests/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 20000, tenorMonths: 4 })
        .expect(201);
      const topupId = topupRes.body.id;
      expect(topupRes.body.type).toBe('TOPUP');

      await request(app.getHttpServer())
        .post('/webhooks/sms/inbound')
        .send({ phone: client.phone, message: 'YES' })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${topupId}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${topupId}/disburse`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const after = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-A` } });
      expect(Number(after!.principalAmount)).toBe(Number(before!.principalAmount) + 20000);
      expect(Number(after!.principalBalance)).toBe(Number(before!.principalBalance) + 20000);

      const secondLoanCount = await prisma.clientLoan.count({ where: { agency, staffId: `${staffId}-A` } });
      expect(secondLoanCount).toBe(1);
    },
    30000,
  );

  it('rejects a second topup while the first is still in progress', async () => {
    const { client, accessToken } = await originateAndDisburseLoan('0000002', 'B');

    await request(app.getHttpServer())
      .post('/client/loan-requests/topup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 10000, tenorMonths: 4 })
      .expect(201);

    await request(app.getHttpServer())
      .post('/client/loan-requests/topup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 5000, tenorMonths: 4 })
      .expect(422);
  });

  it('rejects a topup when the client has no active loan', async () => {
    const { accessToken } = await createVerifiedClient('0000003', 'C');

    await request(app.getHttpServer())
      .post('/client/loan-requests/topup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 10000, tenorMonths: 4 })
      .expect(422);
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/loan-topup.e2e-spec.ts --runInBand`
Expected: PASS — 3 tests.

- [ ] **Step 3: Update the README**

In `README.md`, find the "## Loan origination" section (added by B1) and add this new subsection directly after it:

```markdown
### Topup

`POST /client/loan-requests/topup` (`{ amount, tenorMonths }`, Client JWT)
adds more funds to the client's existing single active `ClientLoan` — no
loan ID in the request; the service looks up the client's one `ACTIVE`
loan itself. Reuses the exact same request→confirm→approve/auto-approve→
disburse pipeline as origination (`LoanRequest.type` is now `ORIGINATION`
or `TOPUP`), gated by a separate eligibility chain requiring an active
loan to exist and no other request already in progress. On disbursement,
instead of creating a new loan, the existing `ClientLoan`'s
`principalAmount`/`principalBalance`/`disbursedAmount` increase by the
topup's own amount, and `maturationDate` extends to
`max(current, topup disbursement date + topup's own tenor)` — a topup
never shortens the loan's remaining term. `GET /admin/loan-requests` now
also accepts an optional `?type=` filter (`ORIGINATION`/`TOPUP`).
```

- [ ] **Step 4: Add Postman coverage**

Add `POST /client/loan-requests/topup` under Client (success, the two rejection scenarios — no active loan, and a topup already in progress), and update the existing `GET /admin/loan-requests` request/example to show the new `?type=` filter. Every new/changed request needs a saved response example authored from the actual code. Use a surgical text-based/jq-based insert, not a full rewrite (watch `ensure_ascii` if using Python's `json` module).

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Run the scoped suites touched by this whole plan**

Run: `npx jest src/loan-request && npx jest --config ./test/jest-e2e.json test/loan-request.e2e-spec.ts test/loan-origination.e2e-spec.ts test/loan-topup.e2e-spec.ts --runInBand`
Expected: PASS. Per this plan's Global Constraints, do NOT run the full unit suite (`npm run test`) or the full e2e config with no path filter — this plan is B2 of a four-part phase, not the phase's last plan.

- [ ] **Step 7: Commit**

```bash
git add test/loan-topup.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add loan topup e2e coverage and docs"
```

## Exit criteria

- [ ] The scoped test run in Task 5's Step 6 passes from a clean state (not the full suite — see Global Constraints).
- [ ] A client with an active loan can submit a topup, confirm it via SMS, and have it auto- or manually-disbursed, updating (not duplicating) their `ClientLoan`.
- [ ] `maturationDate` only ever extends from a topup, never shortens, per the confirmed max-of-two-dates rule (proven in both directions by unit tests).
- [ ] A second topup is rejected while the first is still in progress, and a topup is rejected when there's no active loan at all — proven by unit and e2e tests.
- [ ] The origination flow (B1) is entirely unaffected — its existing tests pass unchanged.
- [ ] Postman has coverage for the new endpoint and the admin filter change.
