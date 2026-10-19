# Loan Lifecycle Policy Change & Eligibility-Gated Product Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client may have exactly one loan in their lifetime; after it
closes (balance ≤ 0) the only path forward is a top-up that renews the
same lifetime loan, and `GET client/loan-products` (plus a new agent
equivalent) reflects whether the client can currently act (`NEW_LOAN` vs
`TOPUP` mode, eligible or not, and why) instead of being a plain catalog
browse.

**Architecture:** A shared `hasLifetimeLoan` util plus two new
`ClientLoansService` methods become the single source of truth for "has
this client ever had a loan" (spanning both app-native `ClientLoan` rows
and admin-ingested `Loan` records). `NoActiveLoanRule` and
`HasActiveLoanRule` are rewritten against that shared concept.
`LoanRequestService`'s top-up path is rewritten to reset the existing
`ClientLoan` row in place (or create the client's first one, for an
ingested-only lifetime loan). `LoanProductsService.listActiveForClient` is
replaced by `listEligibleForClient`, which runs the same gates before
listing products, consumed by both the existing client controller and a
new agent-facing one.

**Tech Stack:** NestJS, Prisma (PostgreSQL), Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-10-19-loan-lifecycle-and-eligibility-design.md`

## Global Constraints

- No renaming of "topup" identifiers (enum value, route, service/rule
  class names) — only internal logic and behavior change.
- `ClientLoansService.hasActiveLoan` (consumed by
  `client-profile.service.ts`'s `GET client/me` response) must not change
  behavior or signature — add new methods alongside it, never modify it.
- Every e2e test must fully clean up every DB row it creates (standing
  project rule) — this repo's e2e suite runs against a live shared UAT
  Postgres instance.
- `postman/public-sector-backend.postman_collection.json` must be updated
  in the same change as any endpoint/response-shape change (project
  CLAUDE.md rule) — see Task 7.
- Never add a `Co-Authored-By: Claude` trailer to any commit in this repo.

---

### Task 1: Shared "lifetime loan" building blocks

**Files:**
- Create: `src/loan-request/eligibility/has-lifetime-loan.util.ts`
- Create: `src/loan-request/eligibility/has-lifetime-loan.util.spec.ts`
- Modify: `src/client-loans/client-loans.service.ts:85-90` (insert two new
  public methods right after the existing `hasActiveLoan` method)
- Modify: `src/client-loans/client-loans.service.spec.ts` (add a new
  `describe` block after the existing `hasActiveLoan` block, around line
  222)

**Interfaces:**
- Produces: `hasLifetimeLoan(prisma: PrismaService, clientLoansService: ClientLoansService, clientId: string): Promise<boolean>`
- Produces: `ClientLoansService.hasAnyMatchedLoan(clientId: string): Promise<boolean>`
- Produces: `ClientLoansService.hasOutstandingMatchedLoan(clientId: string): Promise<boolean>`
- Consumes: `ClientLoansService`'s existing private `getMatchedLoansWithStatus(clientId, filters?)` (already returns `{ agency, staffId, loans: Array<{ id, status: 'ACTIVE'|'DEFAULT'|'CLOSED', ... } >} | null`).

- [ ] **Step 1: Write the failing tests for `ClientLoansService`'s two new methods**

Open `src/client-loans/client-loans.service.spec.ts`. Insert this new
`describe` block immediately after the existing `describe('hasActiveLoan', ...)` block (which currently ends at line 222, right before `describe('getRepaymentPlan', ...)`):

```typescript
  describe('hasAnyMatchedLoan', () => {
    it('returns false when the client has no ClientOnboarding row', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      expect(await service.hasAnyMatchedLoan('c1')).toBe(false);
      expect(prisma.loan.findMany).not.toHaveBeenCalled();
    });

    it('returns false when the client has no ingested loans', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([]);

      expect(await service.hasAnyMatchedLoan('c1')).toBe(false);
    });

    it('returns true when a matched loan exists, regardless of its status', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-closed', bvn: null, principalBalance: 0, maturationDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) },
      ]);

      expect(await service.hasAnyMatchedLoan('c1')).toBe(true);
    });
  });

  describe('hasOutstandingMatchedLoan', () => {
    it('returns false when the client has no ClientOnboarding row', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      expect(await service.hasOutstandingMatchedLoan('c1')).toBe(false);
    });

    it('returns false when every matched loan is CLOSED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 0, maturationDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) },
      ]);

      expect(await service.hasOutstandingMatchedLoan('c1')).toBe(false);
    });

    it('returns true when a matched loan is ACTIVE', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);

      expect(await service.hasOutstandingMatchedLoan('c1')).toBe(true);
    });

    it('returns true when a matched loan is DEFAULT (past maturity with an outstanding balance)', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) },
      ]);

      expect(await service.hasOutstandingMatchedLoan('c1')).toBe(true);
    });
  });
```
(`future` is the existing `const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);` already declared at the top of this spec file — reuse it, don't redeclare.)

Also create `src/loan-request/eligibility/has-lifetime-loan.util.spec.ts`:
```typescript
import { hasLifetimeLoan } from './has-lifetime-loan.util';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';

describe('hasLifetimeLoan', () => {
  let prisma: { clientLoan: { findFirst: jest.Mock } };
  let clientLoansService: { hasAnyMatchedLoan: jest.Mock };

  beforeEach(() => {
    prisma = { clientLoan: { findFirst: jest.fn() } };
    clientLoansService = { hasAnyMatchedLoan: jest.fn() };
  });

  it('returns true when a ClientLoan row exists, without checking ingested loans', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });

    const result = await hasLifetimeLoan(
      prisma as unknown as PrismaService,
      clientLoansService as unknown as ClientLoansService,
      'c1',
    );

    expect(result).toBe(true);
    expect(clientLoansService.hasAnyMatchedLoan).not.toHaveBeenCalled();
  });

  it('falls back to checking matched ingested loans when no ClientLoan row exists', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(true);

    const result = await hasLifetimeLoan(
      prisma as unknown as PrismaService,
      clientLoansService as unknown as ClientLoansService,
      'c1',
    );

    expect(result).toBe(true);
  });

  it('returns false when neither a ClientLoan row nor a matched ingested loan exists', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);

    const result = await hasLifetimeLoan(
      prisma as unknown as PrismaService,
      clientLoansService as unknown as ClientLoansService,
      'c1',
    );

    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx jest src/client-loans/client-loans.service.spec.ts src/loan-request/eligibility/has-lifetime-loan.util.spec.ts`
Expected: the `has-lifetime-loan.util.spec.ts` suite fails with "Cannot
find module './has-lifetime-loan.util'"; the `hasAnyMatchedLoan`/
`hasOutstandingMatchedLoan` tests in `client-loans.service.spec.ts` fail
with "is not a function".

- [ ] **Step 3: Implement `has-lifetime-loan.util.ts`**

```typescript
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';

export async function hasLifetimeLoan(
  prisma: PrismaService,
  clientLoansService: ClientLoansService,
  clientId: string,
): Promise<boolean> {
  const clientLoan = await prisma.clientLoan.findFirst({
    where: { clientId },
    select: { id: true },
  });
  if (clientLoan) {
    return true;
  }
  return clientLoansService.hasAnyMatchedLoan(clientId);
}
```

- [ ] **Step 4: Add the two new methods to `ClientLoansService`**

In `src/client-loans/client-loans.service.ts`, insert these two methods
directly after the existing `hasActiveLoan` method (which ends at line 90,
right before the `private async getMatchedLoansWithStatus` declaration on
line 92):

```typescript
  // Unpaginated on purpose — same reasoning as hasActiveLoan above.
  async hasAnyMatchedLoan(clientId: string): Promise<boolean> {
    const matched = await this.getMatchedLoansWithStatus(clientId);
    return matched ? matched.loans.length > 0 : false;
  }

  async hasOutstandingMatchedLoan(clientId: string): Promise<boolean> {
    const matched = await this.getMatchedLoansWithStatus(clientId);
    return matched ? matched.loans.some((loan) => loan.status !== 'CLOSED') : false;
  }

```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/client-loans/client-loans.service.spec.ts src/loan-request/eligibility/has-lifetime-loan.util.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/loan-request/eligibility/has-lifetime-loan.util.ts src/loan-request/eligibility/has-lifetime-loan.util.spec.ts src/client-loans/client-loans.service.ts src/client-loans/client-loans.service.spec.ts
git commit -m "feat(loan-eligibility): add shared hasLifetimeLoan check spanning ClientLoan and ingested loans"
```

---

### Task 2: `NoActiveLoanRule` — block on any lifetime loan, not just an active one

**Files:**
- Modify: `src/loan-request/eligibility/no-active-loan.rule.ts` (full rewrite)
- Modify: `src/loan-request/eligibility/no-active-loan.rule.spec.ts` (full rewrite)

**Interfaces:**
- Consumes: `hasLifetimeLoan` from `./has-lifetime-loan.util` (Task 1).
- Produces: `NoActiveLoanRule.check(client, ippisRecord, amount): Promise<EligibilityCheckResult>` — unchanged signature, only its internal logic and failure `reason` text change.

- [ ] **Step 1: Write the failing test — rewrite `no-active-loan.rule.spec.ts` in full**

```typescript
import { NoActiveLoanRule } from './no-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('NoActiveLoanRule', () => {
  let rule: NoActiveLoanRule;
  let prisma: { loanRequest: { findFirst: jest.Mock }; clientLoan: { findFirst: jest.Mock } };
  let clientLoansService: { hasAnyMatchedLoan: jest.Mock };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = {
      loanRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      clientLoan: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    clientLoansService = {
      hasAnyMatchedLoan: jest.fn().mockResolvedValue(false),
    };
    rule = new NoActiveLoanRule(prisma as unknown as PrismaService, clientLoansService as unknown as ClientLoansService);
  });

  it('passes when there is no in-progress request and no lifetime loan on record', async () => {
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when the client already has a non-terminal LoanRequest', async () => {
    prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/in progress/);
  });

  it('fails when the client already has a ClientLoan row, regardless of its status', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1' });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/already taken a loan/);
  });

  it('fails when the client has a matched ingested loan, regardless of its status', async () => {
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(true);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/already taken a loan/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/loan-request/eligibility/no-active-loan.rule.spec.ts`
Expected: FAIL — the "regardless of its status"/"matched ingested loan"
cases fail because the current rule only checks `status: ACTIVE ...`
rather than any `ClientLoan`, and the constructor signature expects
`hasActiveLoan` not `hasAnyMatchedLoan`.

- [ ] **Step 3: Rewrite `no-active-loan.rule.ts` in full**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord, LoanRequestStatus } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { hasLifetimeLoan } from './has-lifetime-loan.util';

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

    if (await hasLifetimeLoan(this.prisma, this.clientLoansService, client.id)) {
      return { eligible: false, reason: 'Client has already taken a loan — only a renewal is available now' };
    }

    return { eligible: true };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/loan-request/eligibility/no-active-loan.rule.spec.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/loan-request/eligibility/no-active-loan.rule.ts src/loan-request/eligibility/no-active-loan.rule.spec.ts
git commit -m "feat(loan-eligibility): block new loan origination on any lifetime loan, not just an active one"
```

---

### Task 3: `HasActiveLoanRule` — gate top-up on balance ≤ 0 (renewal), not balance > 0

**Files:**
- Modify: `src/loan-request/eligibility/has-active-loan.rule.ts` (full rewrite)
- Modify: `src/loan-request/eligibility/has-active-loan.rule.spec.ts` (full rewrite)

**Interfaces:**
- Consumes: `ClientLoansService.hasOutstandingMatchedLoan` and
  `ClientLoansService.hasAnyMatchedLoan` (Task 1).
- Produces: `HasActiveLoanRule.check(client, ippisRecord, amount): Promise<EligibilityCheckResult>` — unchanged signature; constructor now takes `(prisma: PrismaService, clientLoansService: ClientLoansService)` (previously just `prisma`).

- [ ] **Step 1: Write the failing test — rewrite `has-active-loan.rule.spec.ts` in full**

```typescript
import { HasActiveLoanRule } from './has-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('HasActiveLoanRule', () => {
  let rule: HasActiveLoanRule;
  let prisma: { clientLoan: { findFirst: jest.Mock } };
  let clientLoansService: { hasOutstandingMatchedLoan: jest.Mock; hasAnyMatchedLoan: jest.Mock };

  const client = { id: 'client-1' } as Client;
  const ippisRecord = {} as IppisRecord;

  beforeEach(() => {
    prisma = { clientLoan: { findFirst: jest.fn() } };
    clientLoansService = {
      hasOutstandingMatchedLoan: jest.fn().mockResolvedValue(false),
      hasAnyMatchedLoan: jest.fn().mockResolvedValue(false),
    };
    rule = new HasActiveLoanRule(prisma as unknown as PrismaService, clientLoansService as unknown as ClientLoansService);
  });

  it('fails when the latest ClientLoan still has an outstanding balance', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1', principalBalance: 5000 });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/outstanding balance/);
    expect(prisma.clientLoan.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'client-1' },
      orderBy: { disbursementDate: 'desc' },
    });
  });

  it('passes when the latest ClientLoan balance is 0 (closed)', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl-1', principalBalance: 0 });
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when there is no ClientLoan row but a matched ingested loan is still outstanding', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasOutstandingMatchedLoan.mockResolvedValue(true);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/outstanding balance/);
  });

  it('passes when there is no ClientLoan row and the only matched ingested loan is closed', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasOutstandingMatchedLoan.mockResolvedValue(false);
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(true);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when the client has no ClientLoan row and no matched ingested loan at all', async () => {
    prisma.clientLoan.findFirst.mockResolvedValue(null);
    clientLoansService.hasOutstandingMatchedLoan.mockResolvedValue(false);
    clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
    const result = await rule.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no existing loan to renew/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/loan-request/eligibility/has-active-loan.rule.spec.ts`
Expected: FAIL — current rule takes a 1-arg constructor and checks
`status: 'ACTIVE'` rather than `principalBalance`.

- [ ] **Step 3: Rewrite `has-active-loan.rule.ts` in full**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

@Injectable()
export class HasActiveLoanRule implements EligibilityRule {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientLoansService: ClientLoansService,
  ) {}

  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const latestClientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId: client.id },
      orderBy: { disbursementDate: 'desc' },
    });

    if (latestClientLoan) {
      if (Number(latestClientLoan.principalBalance) > 0) {
        return { eligible: false, reason: 'Existing loan still has an outstanding balance' };
      }
      return { eligible: true };
    }

    if (await this.clientLoansService.hasOutstandingMatchedLoan(client.id)) {
      return { eligible: false, reason: 'Existing loan still has an outstanding balance' };
    }
    if (!(await this.clientLoansService.hasAnyMatchedLoan(client.id))) {
      return { eligible: false, reason: 'Client has no existing loan to renew' };
    }

    return { eligible: true };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/loan-request/eligibility/has-active-loan.rule.spec.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/loan-request/eligibility/has-active-loan.rule.ts src/loan-request/eligibility/has-active-loan.rule.spec.ts
git commit -m "feat(loan-eligibility): gate top-up/renewal on balance<=0 instead of an active balance"
```

---

### Task 4: `LoanRequestService` — renewal creates/resets a `ClientLoan` row instead of adding onto one

**Files:**
- Modify: `src/loan-request/loan-request.service.ts:260-309` (`createTopup`) and `:123-153` (`applyTopupToClientLoan`)
- Modify: `src/loan-request/loan-request.service.spec.ts:519-599` (`describe('createTopup', ...)`) and `:601-673` (`describe('disburse with a TOPUP request', ...)`)

**Interfaces:**
- Consumes: nothing new from Tasks 1–3 (this task mocks
  `topupEligibilityService.check` directly, same as today — it doesn't
  call `HasActiveLoanRule` itself).
- Produces: `LoanRequestService.createTopup(clientId, amount, tenorMonths)`
  no longer throws when the client has no `ClientLoan` row yet;
  `applyTopupToClientLoan` (private, invoked by both `confirmByPhone`'s
  auto-approve path and `disburse()`) resets the target row in place, or
  creates the client's first `ClientLoan` row when `loanRequest.topupTargetId`
  is unset.

- [ ] **Step 1: Write the failing tests**

In `src/loan-request/loan-request.service.spec.ts`, replace the existing
`'sends a top-up-worded SMS and creates a TOPUP LoanRequest pointing at the active loan'`
test (lines 547–576) with:

```typescript
    it('sends a top-up-worded SMS and creates a TOPUP LoanRequest pointing at the existing ClientLoan', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 },
      });
      prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(prisma.clientLoan.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        orderBy: { disbursementDate: 'desc' },
      });
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

    it('creates a TOPUP LoanRequest with no topupTargetId when the client has no ClientLoan row yet (ingested-only lifetime loan)', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      loanProductResolverService.resolve.mockResolvedValue({
        product: {
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
        },
        tier: { minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 },
      });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr2' });

      await service.createTopup('c1', 2000, 12);

      expect(prisma.loanRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ topupTargetId: undefined }),
      });
    });
```

Then replace the entire `describe('disburse with a TOPUP request', ...)`
block (lines 601–673) with:

```typescript
  describe('disburse with a TOPUP request', () => {
    it('resets the existing ClientLoan row in place with the new terms, flipping status back to ACTIVE', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr2', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr2', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr2',
        clientId: 'c1',
        type: 'TOPUP',
        topupTargetId: 'cl1',
        amount: 7000,
        tenorMonths: 6,
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeAmount: 140,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      });
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1' });

      await service.disburse('lr2');

      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: expect.objectContaining({
          principalAmount: 7000,
          principalBalance: 7000,
          disbursedAmount: 6860,
          tenorMonths: 6,
          interestRatePercent: 6,
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeAmount: 140,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          status: 'ACTIVE',
        }),
      });
      expect(prisma.clientLoan.create).not.toHaveBeenCalled();
    });

    it('creates the client\'s first ClientLoan row when no topupTargetId is set (renewal of an ingested-only lifetime loan)', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr2', status: 'APPROVED' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr2', status: 'DISBURSED' });
      prisma.loanRequest.findUniqueOrThrow.mockResolvedValue({
        id: 'lr2',
        clientId: 'c1',
        type: 'TOPUP',
        topupTargetId: null,
        amount: 7000,
        tenorMonths: 6,
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeAmount: 140,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      });
      prisma.clientOnboarding.findUniqueOrThrow.mockResolvedValue({
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.clientLoan.create.mockResolvedValue({ id: 'cl-new' });

      await service.disburse('lr2');

      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'c1',
          loanRequestId: 'lr2',
          agency: 'NPF',
          staffId: 'NPF-001',
          principalAmount: 7000,
          principalBalance: 7000,
          disbursedAmount: 6860,
          status: 'ACTIVE',
        }),
      });
      expect(prisma.clientLoan.update).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts -t "createTopup|disburse with a TOPUP request"`
Expected: FAIL — `createTopup`'s tests fail because the service still
calls `prisma.clientLoan.findFirstOrThrow`; the `disburse` tests fail
because `applyTopupToClientLoan` still adds onto the existing balance
instead of resetting, and never creates a row when `topupTargetId` is
unset.

- [ ] **Step 3: Rewrite `createTopup` (lines 260–309) in full**

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

    const existingClientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId },
      orderBy: { disbursementDate: 'desc' },
    });

    const { product, tier } = await this.loanProductResolverService.resolve(onboarding.ippisRecord, amount, tenorMonths);

    const managementChargeAmount =
      product.managementChargeType === ManagementChargeType.PERCENTAGE
        ? (amount * Number(product.managementChargeValue)) / 100
        : Number(product.managementChargeValue);

    await this.smsProvider.send(client.phone, this.confirmationMessage(amount, LoanRequestType.TOPUP));
    await this.sendEmailCopy(client.email, amount, LoanRequestType.TOPUP);

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        tenorMonths,
        type: LoanRequestType.TOPUP,
        topupTargetId: existingClientLoan?.id,
        interestRatePercent: tier.interestRatePercent,
        managementChargeType: product.managementChargeType,
        managementChargeValue: product.managementChargeValue,
        managementChargeApplication: product.managementChargeApplication,
        managementChargeAmount,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
        confirmationSmsSentAt: new Date(),
      },
    });

    await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

    return loanRequest;
  }
```
(Only two lines changed from today: the `prisma.clientLoan.findFirstOrThrow({ where: { clientId, status: ClientLoanStatus.ACTIVE } })`
call becomes `prisma.clientLoan.findFirst({ where: { clientId }, orderBy: { disbursementDate: 'desc' } })`
assigned to `existingClientLoan`, and `topupTargetId: activeLoan.id` becomes
`topupTargetId: existingClientLoan?.id`.)

- [ ] **Step 4: Rewrite `applyTopupToClientLoan` (lines 123–153) in full**

```typescript
  private async applyTopupToClientLoan(loanRequest: LoanRequest): Promise<void> {
    const topupAmount = Number(loanRequest.amount);
    const managementChargeAmount = Number(loanRequest.managementChargeAmount);
    const disbursedAmount =
      loanRequest.managementChargeApplication === ManagementChargeApplication.DEDUCT_FROM_DISBURSEMENT
        ? topupAmount - managementChargeAmount
        : topupAmount;

    const disbursementDate = new Date();
    const maturationDate = new Date(disbursementDate);
    maturationDate.setMonth(maturationDate.getMonth() + loanRequest.tenorMonths);

    const fields = {
      principalAmount: topupAmount,
      disbursedAmount,
      principalBalance: topupAmount,
      tenorMonths: loanRequest.tenorMonths,
      interestRatePercent: loanRequest.interestRatePercent,
      managementChargeType: loanRequest.managementChargeType,
      managementChargeValue: loanRequest.managementChargeValue,
      managementChargeApplication: loanRequest.managementChargeApplication,
      managementChargeAmount,
      disbursementDate,
      maturationDate,
      status: ClientLoanStatus.ACTIVE,
    };

    if (loanRequest.topupTargetId) {
      await this.prisma.clientLoan.update({ where: { id: loanRequest.topupTargetId }, data: fields });
      return;
    }

    const onboarding = await this.prisma.clientOnboarding.findUniqueOrThrow({
      where: { clientId: loanRequest.clientId },
      include: { ippisRecord: true },
    });

    await this.prisma.clientLoan.create({
      data: {
        clientId: loanRequest.clientId,
        loanRequestId: loanRequest.id,
        agency: onboarding.ippisRecord.agency,
        staffId: onboarding.ippisRecord.staffId,
        ...fields,
      },
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS, full suite green (this also re-runs every other
`describe` block in the file — none of their mocks changed, so they
should be unaffected).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts
git commit -m "feat(loan-request): renewal resets the client's ClientLoan row in place instead of adding onto its balance"
```

---

### Task 5: Eligibility-gated `GET client/loan-products` + new agent equivalent

**Files:**
- Modify: `src/loan-products/loan-products.service.ts:1-13` (imports/interfaces), `:49-54` (constructor), `:115-146` (replace `listActiveForClient`)
- Modify: `src/loan-products/loan-products.service.spec.ts:1-37` (imports/setup), `:103-123` (replace `describe('listActiveForClient', ...)`)
- Modify: `src/loan-products/dto/list-client-loan-products-query.dto.ts` (full rewrite)
- Modify: `src/loan-products/client-loan-products.controller.ts` (full rewrite)
- Create: `src/loan-products/agent-loan-products.controller.ts`
- Modify: `src/loan-products/loan-products.module.ts` (full rewrite)
- Modify: `src/loan-request/loan-request.module.ts:53` (add `exports` array)

**Interfaces:**
- Consumes: `hasLifetimeLoan` from `../loan-request/eligibility/has-lifetime-loan.util` (Task 1); `EligibilityService`/`TopupEligibilityService` from `../loan-request/eligibility/{eligibility,topup-eligibility}.service` (now exported from `LoanRequestModule`); `ClientLoansService` from `../client-loans/client-loans.service`.
- Produces: `LoanProductsService.listEligibleForClient(clientId, filters?: { amount?: number }, pagination?): Promise<{ mode: 'NEW_LOAN' | 'TOPUP'; eligible: boolean; reason?: string; data: LoanProduct[]; meta: { total, page, limit, totalPages } }>` — replaces `listActiveForClient` (deleted, no other callers exist).

- [ ] **Step 1: Write the failing tests — replace `describe('listActiveForClient', ...)` in `loan-products.service.spec.ts`**

First, update the test file's `beforeEach`/imports block (lines 1–37) to
match the new 5-arg constructor:

```typescript
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { LoanProductsService } from './loan-products.service';
import { PrismaService } from '../prisma/prisma.service';
import { LoanSettingsService } from '../loan-settings/loan-settings.service';
import { EligibilityService } from '../loan-request/eligibility/eligibility.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';
import { ClientLoansService } from '../client-loans/client-loans.service';

describe('LoanProductsService', () => {
  let prisma: {
    loanProduct: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock };
    client: { findUniqueOrThrow: jest.Mock };
    clientLoan: { findFirst: jest.Mock };
  };
  let loanSettingsService: { get: jest.Mock };
  let eligibilityService: { check: jest.Mock };
  let topupEligibilityService: { check: jest.Mock };
  let clientLoansService: { hasAnyMatchedLoan: jest.Mock };
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
      client: { findUniqueOrThrow: jest.fn() },
      clientLoan: { findFirst: jest.fn() },
    };
    loanSettingsService = { get: jest.fn().mockResolvedValue({ retirementAgeYears: 60, maxServiceYears: 35 }) };
    eligibilityService = { check: jest.fn() };
    topupEligibilityService = { check: jest.fn() };
    clientLoansService = { hasAnyMatchedLoan: jest.fn().mockResolvedValue(false) };
    service = new LoanProductsService(
      prisma as unknown as PrismaService,
      loanSettingsService as unknown as LoanSettingsService,
      eligibilityService as unknown as EligibilityService,
      topupEligibilityService as unknown as TopupEligibilityService,
      clientLoansService as unknown as ClientLoansService,
    );
  });
```
(`describe('create', ...)`, `describe('list', ...)`, and
`describe('update', ...)` blocks below this are unchanged — they don't
touch the new constructor params.)

Then replace the `describe('listActiveForClient', ...)` block (lines
103–123) with:

```typescript
  describe('listEligibleForClient', () => {
    it('returns NEW_LOAN/ineligible when the client has no onboarding record', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.listEligibleForClient('c1');

      expect(result).toEqual({
        mode: 'NEW_LOAN',
        eligible: false,
        reason: 'Client has not completed onboarding',
        data: [],
        meta: { total: 0, page: 1, limit: 25, totalPages: 0 },
      });
      expect(prisma.loanProduct.findMany).not.toHaveBeenCalled();
    });

    it('resolves NEW_LOAN mode and returns matching products when the client has no lifetime loan and is eligible', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanProduct.findMany.mockResolvedValue([
        { id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null },
      ]);

      const result = await service.listEligibleForClient('c1');

      expect(eligibilityService.check).toHaveBeenCalledWith(
        { id: 'c1', status: 'VERIFIED' },
        { agency: 'NPF', dateOfBirth: null, hireDate: null },
        0,
      );
      expect(result.mode).toBe('NEW_LOAN');
      expect(result.eligible).toBe(true);
      expect(result.data).toEqual([{ id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null }]);
    });

    it('returns NEW_LOAN/ineligible with the rule\'s reason and an empty product list when origination eligibility fails', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'PENDING' });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
      eligibilityService.check.mockResolvedValue({ eligible: false, reason: 'Client must be VERIFIED (currently PENDING)' });

      const result = await service.listEligibleForClient('c1');

      expect(result.mode).toBe('NEW_LOAN');
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Client must be VERIFIED (currently PENDING)');
      expect(result.data).toEqual([]);
      expect(prisma.loanProduct.findMany).not.toHaveBeenCalled();
    });

    it('resolves TOPUP mode when the client already has a ClientLoan row, and returns products when eligible', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });
      topupEligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanProduct.findMany.mockResolvedValue([
        { id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null },
      ]);

      const result = await service.listEligibleForClient('c1');

      expect(topupEligibilityService.check).toHaveBeenCalledWith(
        { id: 'c1', status: 'VERIFIED' },
        { agency: 'NPF', dateOfBirth: null, hireDate: null },
        0,
      );
      expect(eligibilityService.check).not.toHaveBeenCalled();
      expect(result.mode).toBe('TOPUP');
      expect(result.eligible).toBe(true);
    });

    it('returns TOPUP/ineligible with the rule\'s reason when renewal eligibility fails', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue({ id: 'cl1' });
      topupEligibilityService.check.mockResolvedValue({ eligible: false, reason: 'Existing loan still has an outstanding balance' });

      const result = await service.listEligibleForClient('c1');

      expect(result.mode).toBe('TOPUP');
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('Existing loan still has an outstanding balance');
      expect(result.data).toEqual([]);
    });

    it('narrows by the optional amount filter', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanProduct.findMany.mockResolvedValue([]);

      await service.listEligibleForClient('c1', { amount: 50000 });

      expect(prisma.loanProduct.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            minimumAmount: { lte: 50000 },
            maximumAmount: { gte: 50000 },
          }),
        }),
      );
    });

    it('only applies the service-length filter, still returning only matching products', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        ippisRecord: { agency: 'NPF', dateOfBirth: null, hireDate: null },
      });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      clientLoansService.hasAnyMatchedLoan.mockResolvedValue(false);
      eligibilityService.check.mockResolvedValue({ eligible: true });
      prisma.loanProduct.findMany.mockResolvedValue([
        { id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null },
        { id: 'p2', minimumServiceMonthsLeft: 999, maximumMonthsInService: null },
      ]);

      const result = await service.listEligibleForClient('c1');

      expect(result.data).toEqual([{ id: 'p1', minimumServiceMonthsLeft: null, maximumMonthsInService: null }]);
      expect(result.meta.total).toBe(1);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/loan-products/loan-products.service.spec.ts`
Expected: FAIL — `listActiveForClient` / `listEligibleForClient` mismatch
and constructor arity mismatch.

- [ ] **Step 3: Update `loan-products.service.ts`'s imports and constructor**

Replace the import block (lines 1–10) with:
```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanProduct, ManagementChargeApplication, ManagementChargeType, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { isUniqueConstraintError } from '../common/is-unique-constraint-error.util';
import { LoanSettingsService } from '../loan-settings/loan-settings.service';
import { computeServiceWindow } from '../loan-request/eligibility/compute-service-window.util';
import { isServiceLengthEligible } from '../loan-request/eligibility/service-length-eligible.util';
import { hasLifetimeLoan } from '../loan-request/eligibility/has-lifetime-loan.util';
import { EligibilityService } from '../loan-request/eligibility/eligibility.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { validateInterestTiers } from './validate-interest-tiers.util';
import { InterestTier } from './interest-tier.interface';
```

Replace the constructor (lines 51–54) with:
```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanSettingsService: LoanSettingsService,
    private readonly eligibilityService: EligibilityService,
    private readonly topupEligibilityService: TopupEligibilityService,
    private readonly clientLoansService: ClientLoansService,
  ) {}
```

- [ ] **Step 4: Replace `listActiveForClient` (lines 115–146) with `listEligibleForClient`**

```typescript
  async listEligibleForClient(
    clientId: string,
    filters: { amount?: number } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<{ mode: 'NEW_LOAN' | 'TOPUP'; eligible: boolean; reason?: string; data: LoanProduct[]; meta: PaginatedResult<LoanProduct>['meta'] }> {
    const { page, limit } = pagination;
    const emptyMeta = buildPaginatedResult<LoanProduct>([], 0, page, limit).meta;

    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return { mode: 'NEW_LOAN', eligible: false, reason: 'Client has not completed onboarding', data: [], meta: emptyMeta };
    }

    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const mode: 'NEW_LOAN' | 'TOPUP' = (await hasLifetimeLoan(this.prisma, this.clientLoansService, clientId))
      ? 'TOPUP'
      : 'NEW_LOAN';

    const eligibility =
      mode === 'TOPUP'
        ? await this.topupEligibilityService.check(client, onboarding.ippisRecord, 0)
        : await this.eligibilityService.check(client, onboarding.ippisRecord, 0);

    if (!eligibility.eligible) {
      return { mode, eligible: false, reason: eligibility.reason, data: [], meta: emptyMeta };
    }

    const settings = await this.loanSettingsService.get();
    const { monthsLeft, monthsServed } = computeServiceWindow(
      onboarding.ippisRecord.dateOfBirth,
      onboarding.ippisRecord.hireDate,
      settings.retirementAgeYears,
      settings.maxServiceYears,
    );

    const candidates = await this.prisma.loanProduct.findMany({
      where: {
        isActive: true,
        sectors: { has: onboarding.ippisRecord.agency },
        ...(filters.amount !== undefined
          ? { minimumAmount: { lte: filters.amount }, maximumAmount: { gte: filters.amount } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    const eligibleProducts = candidates.filter((p) => isServiceLengthEligible(p, monthsLeft, monthsServed));

    const total = eligibleProducts.length;
    const data = eligibleProducts.slice((page - 1) * limit, (page - 1) * limit + limit);

    return { mode, eligible: true, data, meta: buildPaginatedResult(data, total, page, limit).meta };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/loan-products/loan-products.service.spec.ts`
Expected: PASS, full suite green.

- [ ] **Step 6: Update the DTO**

Rewrite `src/loan-products/dto/list-client-loan-products-query.dto.ts` in full:
```typescript
import { IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListClientLoanProductsQueryDto extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;
}
```

- [ ] **Step 7: Update the client controller**

Rewrite `src/loan-products/client-loan-products.controller.ts` in full:
```typescript
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
    return this.loanProductsService.listEligibleForClient(
      req.user.sub,
      { amount: query.amount },
      { page: query.page, limit: query.limit },
    );
  }
}
```

- [ ] **Step 8: Create the agent controller**

Create `src/loan-products/agent-loan-products.controller.ts`:
```typescript
import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';
import { LoanProductsService } from './loan-products.service';
import { ListClientLoanProductsQueryDto } from './dto/list-client-loan-products-query.dto';

@Controller('agent/clients/:clientId/loan-products')
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
export class AgentLoanProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanProductsService: LoanProductsService,
  ) {}

  @Get()
  async list(
    @Param('clientId') clientId: string,
    @Query() query: ListClientLoanProductsQueryDto,
    @Req() req: { user: JwtPayload },
  ) {
    const owned = await this.prisma.client.findFirst({
      where: { id: clientId, onboarding: { onboardedByAgentId: req.user.sub } },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('Client not found');
    }

    return this.loanProductsService.listEligibleForClient(
      clientId,
      { amount: query.amount },
      { page: query.page, limit: query.limit },
    );
  }
}
```

- [ ] **Step 9: Wire up the modules**

In `src/loan-request/loan-request.module.ts`, add an `exports` array
(there is currently none — the `@Module({...})` block ends at line 53
with `})`; add `exports` as the last property before the closing brace):
```typescript
  exports: [EligibilityService, TopupEligibilityService],
```

Rewrite `src/loan-products/loan-products.module.ts` in full:
```typescript
import { Module } from '@nestjs/common';
import { LoanProductsService } from './loan-products.service';
import { AdminLoanProductsController } from './admin-loan-products.controller';
import { ClientLoanProductsController } from './client-loan-products.controller';
import { AgentLoanProductsController } from './agent-loan-products.controller';
import { LoanSettingsModule } from '../loan-settings/loan-settings.module';
import { LoanRequestModule } from '../loan-request/loan-request.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';

@Module({
  imports: [LoanSettingsModule, LoanRequestModule, ClientLoansModule],
  controllers: [AdminLoanProductsController, ClientLoanProductsController, AgentLoanProductsController],
  providers: [LoanProductsService],
  exports: [LoanProductsService],
})
export class LoanProductsModule {}
```

- [ ] **Step 10: Build and typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (This also validates there's no circular-import
problem at the Nest dependency-injection level — if there were one,
`npx nest build` would still typecheck fine but boot would fail; do a
quick boot sanity check too: `timeout 15 npx nest start` in the
background, confirm no `Nest can't resolve dependencies` or circular
dependency warning in the log, then stop it.)

- [ ] **Step 11: Commit**

```bash
git add src/loan-products/loan-products.service.ts src/loan-products/loan-products.service.spec.ts src/loan-products/dto/list-client-loan-products-query.dto.ts src/loan-products/client-loan-products.controller.ts src/loan-products/agent-loan-products.controller.ts src/loan-products/loan-products.module.ts src/loan-request/loan-request.module.ts
git commit -m "feat(loan-products): gate client loan-products listing by new-loan/renewal eligibility, add agent equivalent"
```

---

### Task 6: e2e coverage

**Files:**
- Modify: `test/loan-topup.e2e-spec.ts` (full rewrite)
- Modify: `test/loan-origination.e2e-spec.ts:97-110` (extend the existing
  `'lists the active loan products...'` test with a `mode` assertion)
- Create: `test/agent-loan-products.e2e-spec.ts`

**Interfaces:**
- Consumes: the full feature from Tasks 1–5, running against the live
  app and a live shared UAT Postgres DB.

- [ ] **Step 1: Extend `loan-origination.e2e-spec.ts`'s product-listing test**

In `test/loan-origination.e2e-spec.ts`, replace the body of
`'lists the active loan products for the client's own agency'` (lines
97–110) with:
```typescript
  it('lists the active loan products for the client\'s own agency, in NEW_LOAN mode', async () => {
    const { accessToken } = await createVerifiedClient('0000001', 'A');

    const res = await request(app.getHttpServer())
      .get('/client/loan-products')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.mode).toBe('NEW_LOAN');
    expect(res.body.eligible).toBe(true);
    // Not toHaveLength(1): other e2e suites running concurrently against this
    // same shared DB also create active NPF loan products -- the endpoint
    // correctly returns every eligible product for the agency, so this only
    // asserts that *this* fixture's product is present.
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ productCode })]));
  });
```

- [ ] **Step 2: Rewrite `test/loan-topup.e2e-spec.ts` in full**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Loan topup/renewal (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-TOPUP-${Date.now()}`;
  const agency = 'NPF';
  const productCode = `E2E-TOPUP-PRODUCT-${Date.now()}`;

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
  });

  afterAll(async () => {
    await prisma.clientLoanRepaymentVariance.deleteMany({ where: { clientLoan: { agency, staffId: { startsWith: staffId } } } });
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { ippisRecord: { staffId: { startsWith: staffId } } } } } });
    const clientIds = (
      await prisma.clientOnboarding.findMany({
        where: { ippisRecord: { staffId: { startsWith: staffId } } },
        select: { clientId: true },
      })
    ).map((c) => c.clientId);
    await prisma.walletEntry.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.clientOnboarding.deleteMany({ where: { ippisRecord: { staffId: { startsWith: staffId } } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.loanProduct.deleteMany({ where: { productCode } });
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

  async function closeLoanBalance(clientId: string, accessToken: string, agencyStaffId: string) {
    const loan = await prisma.clientLoan.findFirst({ where: { agency, staffId: agencyStaffId } });
    const balance = Number(loan!.principalBalance);
    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/credit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: balance, description: 'E2E test credit' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/client/client-loans/me/apply-wallet')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: balance })
      .expect(200);
  }

  it(
    'rejects a renewal while the existing loan still has an outstanding balance',
    async () => {
      const { accessToken } = await originateAndDisburseLoan('0000001', 'A');

      await request(app.getHttpServer())
        .post('/client/loan-requests/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 20000, tenorMonths: 4 })
        .expect(422)
        .expect((res) => expect(res.body.message).toMatch(/outstanding balance/));
    },
    30000,
  );

  it(
    'runs a full renewal flow once the balance reaches 0: request -> confirm -> admin approve -> admin disburse -> ClientLoan reset in place',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000002', 'B');
      await closeLoanBalance(client.id, accessToken, `${staffId}-B`);

      const beforeClosed = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-B` } });
      expect(Number(beforeClosed!.principalBalance)).toBe(0);
      expect(beforeClosed!.status).toBe('CLOSED');

      const topupRes = await request(app.getHttpServer())
        .post('/client/loan-requests/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 50000, tenorMonths: 4 })
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

      const after = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-B` } });
      expect(Number(after!.principalAmount)).toBe(50000);
      expect(Number(after!.principalBalance)).toBe(50000);
      expect(after!.status).toBe('ACTIVE');

      const rowCount = await prisma.clientLoan.count({ where: { agency, staffId: `${staffId}-B` } });
      expect(rowCount).toBe(1);
    },
    30000,
  );

  it(
    'rejects a second renewal request while the first is still in progress',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000003', 'C');
      await closeLoanBalance(client.id, accessToken, `${staffId}-C`);

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
    },
    30000,
  );

  it('rejects a renewal when the client has never had a loan at all', async () => {
    const { accessToken } = await createVerifiedClient('0000004', 'D');

    await request(app.getHttpServer())
      .post('/client/loan-requests/topup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 10000, tenorMonths: 4 })
      .expect(422)
      .expect((res) => expect(res.body.message).toMatch(/no existing loan to renew/));
  });
});
```

- [ ] **Step 3: Create `test/agent-loan-products.e2e-spec.ts`**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Agent loan-products (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const staffId = `E2E-AGENT-LP-${Date.now()}`;
  const agency = 'NPF';
  const productCode = `E2E-AGENT-LP-PRODUCT-${Date.now()}`;
  let agentId: string;
  let agentAccessToken: string;
  let otherAgentAccessToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    await prisma.loanProduct.create({
      data: {
        productName: 'E2E Agent Loan Products Product',
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

    const agent = await prisma.agent.create({
      data: {
        email: `${staffId}-agent@example.com`,
        phone: '+2348060000001',
        fullName: 'E2E Agent LP Test',
        address: '1 Test Street',
        cvKey: 'e2e/cv.pdf',
        status: 'APPROVED',
        mustChangePassword: false,
      },
    });
    agentId = agent.id;
    const otherAgent = await prisma.agent.create({
      data: {
        email: `${staffId}-other-agent@example.com`,
        phone: '+2348060000002',
        fullName: 'E2E Agent LP Other',
        address: '1 Test Street',
        cvKey: 'e2e/cv.pdf',
        status: 'APPROVED',
        mustChangePassword: false,
      },
    });

    const tokenService = moduleFixture.get(TokenService);
    agentAccessToken = tokenService.signAccessToken({ sub: agentId, type: 'agent' });
    otherAgentAccessToken = tokenService.signAccessToken({ sub: otherAgent.id, type: 'agent' });
  });

  afterAll(async () => {
    const clientIds = (
      await prisma.clientOnboarding.findMany({
        where: { ippisRecord: { staffId: { startsWith: staffId } } },
        select: { clientId: true },
      })
    ).map((c) => c.clientId);
    await prisma.clientOnboarding.deleteMany({ where: { ippisRecord: { staffId: { startsWith: staffId } } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.agent.deleteMany({ where: { email: { startsWith: staffId } } });
    await prisma.loanProduct.deleteMany({ where: { productCode } });
    await app.close();
  });

  it('lists the eligible loan products for a client the agent onboarded', async () => {
    const client = await prisma.client.create({ data: { phone: '+2348070000001', status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-A`, employeeName: 'E2E Agent LP Client', salary: 1000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Agent LP Client',
        agency,
        step: 'COMPLETED',
        onboardedByAgentId: agentId,
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/agent/clients/${client.id}/loan-products`)
      .set('Authorization', `Bearer ${agentAccessToken}`)
      .expect(200);

    expect(res.body.mode).toBe('NEW_LOAN');
    expect(res.body.eligible).toBe(true);
    expect(res.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ productCode })]));
  });

  it('returns 404 when the client was not onboarded by the calling agent', async () => {
    const client = await prisma.client.create({ data: { phone: '+2348070000002', status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-B`, employeeName: 'E2E Agent LP Client 2', salary: 1000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Agent LP Client 2',
        agency,
        step: 'COMPLETED',
        onboardedByAgentId: agentId,
      },
    });

    await request(app.getHttpServer())
      .get(`/agent/clients/${client.id}/loan-products`)
      .set('Authorization', `Bearer ${otherAgentAccessToken}`)
      .expect(404);
  });

  it('returns 404 for a clientId that does not exist at all', async () => {
    await request(app.getHttpServer())
      .get('/agent/clients/00000000-0000-0000-0000-000000000000/loan-products')
      .set('Authorization', `Bearer ${agentAccessToken}`)
      .expect(404);
  });
});
```

- [ ] **Step 4: Run the e2e suite for these three files**

Run: `npx jest --config ./test/jest-e2e.json test/loan-topup.e2e-spec.ts test/loan-origination.e2e-spec.ts test/agent-loan-products.e2e-spec.ts`
Expected: PASS, all tests green. If a test fails, re-run that single file
in isolation before treating it as a real regression (this repo's shared
UAT DB can produce incidental cross-test contention).

- [ ] **Step 5: Confirm cleanup leaves no rows behind**

After the run, query the UAT DB directly (e.g. via a throwaway script
using `PrismaPg`/`PrismaClient`, following the pattern used elsewhere in
this repo for ad hoc verification) for any row matching this run's
`staffId`/`productCode`/email prefixes. Expected: zero rows. Delete the
throwaway script afterward.

- [ ] **Step 6: Commit**

```bash
git add test/loan-topup.e2e-spec.ts test/loan-origination.e2e-spec.ts test/agent-loan-products.e2e-spec.ts
git commit -m "test(e2e): cover loan renewal lifecycle and agent-facing eligibility-gated loan-products"
```

---

### Task 7: Postman sync

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: the final response shapes from Tasks 5–6 (read the actual
  code/tests, don't guess).

- [ ] **Step 1: Update `Client > Loan Products > GET /client/loan-products - Success`**

Find this request (search the collection JSON for `"loan-products"`
under the `Client` top-level group). Update its saved `response` entry's
body to the new wrapper shape:
```json
{
  "mode": "NEW_LOAN",
  "eligible": true,
  "data": [
    {
      "id": "...",
      "productName": "Standard Loan",
      "productCode": "STD-001",
      "sectors": ["NPF"],
      "minimumAmount": 1000,
      "maximumAmount": 500000,
      "minimumTenorMonths": 1,
      "maximumTenorMonths": 12,
      "interestTiers": [{ "minTenorMonths": 1, "maxTenorMonths": 12, "interestRatePercent": 5 }],
      "managementChargeType": "PERCENTAGE",
      "managementChargeValue": 2,
      "managementChargeApplication": "DEDUCT_FROM_DISBURSEMENT",
      "minimumServiceMonthsLeft": null,
      "maximumMonthsInService": null,
      "isActive": true,
      "createdAt": "2026-10-19T00:00:00.000Z",
      "updatedAt": "2026-10-19T00:00:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 25, "totalPages": 1 }
}
```
(Match the exact `LoanProduct` field set already used in the
`Admin > Loan Products` folder's saved examples, rather than inventing
new field names — copy that shape, just wrapped in `mode`/`eligible`/
`data`/`meta`.) Add a second saved response example on the same request,
named `OK - ineligible (outstanding renewal balance)`:
```json
{
  "mode": "TOPUP",
  "eligible": false,
  "reason": "Existing loan still has an outstanding balance",
  "data": [],
  "meta": { "total": 0, "page": 1, "limit": 25, "totalPages": 0 }
}
```

- [ ] **Step 2: Update `Client > Loan Requests > POST /client/loan-requests/topup` scenarios**

Find the `- No active loan (422)` request. Rename it to
`- No existing loan to renew (422)` and update its saved response body's
`message` to `"Client has no existing loan to renew"`. Add a new sibling
request, `POST /client/loan-requests/topup - Outstanding balance (422)`,
same request body/auth as the existing success request, with a saved
409... actually 422 response:
```json
{ "statusCode": 422, "message": "Existing loan still has an outstanding balance", "error": "Unprocessable Entity" }
```
Leave `- Success` and `- Topup already in progress (422)` as-is (their
response shapes are unchanged by this feature).

- [ ] **Step 3: Add a new `Agent > Loan Products` sub-folder**

Per this project's CLAUDE.md ("create a new sub-folder for a new
controller/module within that group"), add a new sub-folder under the
top-level `Agent` group, named `Loan Products`, containing:
- `GET /agent/clients/:clientId/loan-products - Success` — URL
  `{{base_url}}/agent/clients/{{agent_onboarding_client_id}}/loan-products`
  (this is the existing collection variable already set by
  `Agent > Client Onboarding > POST /agent/clients/onboarding/ippis-lookup - Success (201)`'s
  test script — `pm.collectionVariables.set('agent_onboarding_client_id', pm.response.json().clientId)`
  — reuse it rather than adding a new one), bearer auth using the Agent
  folder's existing access-token variable, saved response body matching
  Step 1's `NEW_LOAN`/eligible example shape.
- `GET /agent/clients/:clientId/loan-products - Not found, not your client (404)` —
  same URL pattern against a client id the test agent doesn't own, saved
  response `{ "statusCode": 404, "message": "Client not found", "error": "Not Found" }`.

- [ ] **Step 4: Validate and commit**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json')); print('valid JSON')"`
Expected: `valid JSON`.

```bash
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs(postman): sync collection for eligibility-gated loan-products and renewal flow"
```

---

### Task 8: Final verification (done directly, not dispatched to a subagent)

- [ ] Run the full unit suite: `npx jest`. Expected: all suites pass.
- [ ] Run the full e2e suite: `npx jest --config ./test/jest-e2e.json`.
  Re-run any failing file in isolation before treating it as a real
  regression (this repo's shared UAT DB produces incidental cross-test
  flakiness under concurrent load — established prior pattern this
  session).
- [ ] Typecheck: `npx tsc --noEmit`. Expected: no errors.
- [ ] Lint: `npx eslint "{src,apps,libs,test}/**/*.ts" --rule '{"prettier/prettier":"off"}'`.
  Expected: matches this repo's established pre-existing baseline error
  count — confirm no *new* errors were introduced in files this plan
  touched.
- [ ] Live sanity check: boot the app (`npx nest start`), confirm
  `/client/loan-products` and `/agent/clients/:clientId/loan-products`
  resolve (not 404) and return the new wrapper shape for a real
  onboarded client, then exercise one full renewal cycle manually
  (originate → disburse → apply wallet to close balance → topup →
  confirm → approve → disburse) and confirm the `ClientLoan` row resets
  in place rather than adding onto the old balance. Clean up any rows
  created during this manual check.
- [ ] Confirm `git status --short` is clean, then ask the user whether to
  push.
