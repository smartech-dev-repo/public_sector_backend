# Spend Wallet Balance Toward a Loan Payment Implementation Plan (Loan Lifecycle Overhaul — B4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client apply their own wallet balance toward their `ClientLoan`'s outstanding `principalBalance`, capped at what's owed, producing a `ClientLoanRepaymentVariance` row for the current period so it appears in the existing repayment-plan schedule.

**Architecture:** A `source` field on `ClientLoanRepaymentVariance` distinguishes this from payroll-reconciled rows. The classification logic duplicated across `ReconciliationService` and `ClientLoanReconciliationService` is extracted into a shared `classifyVariance()` util first, so the new code (and both existing services) share one implementation instead of a third copy. A new `LoanRequestService.applyWalletToLoan()` method — consuming `WalletService` as a new constructor dependency — powers a new endpoint on the existing `ClientLoanController`.

**Tech Stack:** NestJS 10, Prisma 7, Jest, class-validator.

**Spec:** `docs/superpowers/specs/2026-09-22-wallet-loan-payment-design.md`

## Global Constraints

- `ClientLoanRepaymentVariance.source` defaults to `PAYROLL_RECONCILIATION` — every existing B3 row keeps its meaning with no backfill (spec §2).
- **One variance row per period, regardless of source**: a wallet application is rejected with `409` if the current period already has any `ClientLoanRepaymentVariance` row (spec §2).
- Requested amount is silently capped at `principalBalance` (spec §3).
- `WalletService.debit()` is reused completely unchanged, including its own existing insufficient-balance check — this is the first `CLIENT`-actor wallet entry produced anywhere (spec §3).
- The **full** applied amount reduces `principalBalance` — deliberately *not* `min(applied, expectedAmount)` the way B3's payroll path works, since there's no "excess" to route anywhere when the client explicitly chose and already-capped this amount (spec §3).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the API-surface changes, with a saved response example per request.
- Per this session's standing testing preference: run only the test file(s) relevant to what changed in each task — never the full suite for any task in this plan, including its last one. **This plan is the last plan of the Loan Lifecycle Overhaul phase** (A, B1, B2, B3 already shipped) — Task 5's e2e/docs task therefore ends with the one full-suite run that closes out the whole phase, not just this plan; every earlier task in this plan still only runs its own scoped tests.

---

### Task 1: Schema — `VarianceSource`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `VarianceSource` enum (`PAYROLL_RECONCILIATION`/`WALLET_APPLICATION`), `ClientLoanRepaymentVariance.source` — every later task depends on this exact name.

- [ ] **Step 1: Add the enum and field**

In `prisma/schema.prisma`, add:

```prisma
enum VarianceSource {
  PAYROLL_RECONCILIATION
  WALLET_APPLICATION
}
```

Add to the existing `ClientLoanRepaymentVariance` model:

```prisma
  source VarianceSource @default(PAYROLL_RECONCILIATION)
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_variance_source`
Expected: creates and applies `prisma/migrations/<timestamp>_add_variance_source/migration.sql`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (this is a pure additive schema change — the default means existing `ClientLoanRepaymentVariance.create()` call sites in `ClientLoanReconciliationService` don't need to change).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add VarianceSource to ClientLoanRepaymentVariance"
```

---

### Task 2: Extract shared `classifyVariance`

**Files:**
- Create: `src/reconciliation/variance-classification.util.ts`
- Test: `src/reconciliation/variance-classification.util.spec.ts`
- Modify: `src/reconciliation/reconciliation.service.ts`
- Modify: `src/reconciliation/client-loan-reconciliation.service.ts`

**Interfaces:**
- Produces: `classifyVariance(actualAmount: number, variance: number): VarianceStatus` — Task 3's `LoanRequestService.applyWalletToLoan` consumes this (a third call site, alongside the two existing services this task refactors to use it too, avoiding a third copy of the same logic).

This is a pure extraction — `ReconciliationService.classify()` and `ClientLoanReconciliationService.classify()` are byte-for-byte identical private methods (both `MATCH_TOLERANCE = 1`, same three-branch logic). Neither existing service's own test suite tests `classify` directly (both only test through the public `reconcileAll()` behavior), so this refactor needs no changes to either existing spec file — same shape as the earlier `toPeriodKey`/`generatePeriodRange` extraction from the Client Loan History work.

- [ ] **Step 1: Write the failing tests**

`src/reconciliation/variance-classification.util.spec.ts`:

```typescript
import { classifyVariance } from './variance-classification.util';
import { VarianceStatus } from '../generated/prisma/client';

describe('classifyVariance', () => {
  it('returns NO_DEDUCTION_FOUND when actualAmount is 0', () => {
    expect(classifyVariance(0, -5000)).toBe(VarianceStatus.NO_DEDUCTION_FOUND);
  });

  it('returns MATCHED when the variance is within tolerance', () => {
    expect(classifyVariance(45000, 0)).toBe(VarianceStatus.MATCHED);
    expect(classifyVariance(45001, 1)).toBe(VarianceStatus.MATCHED);
  });

  it('returns OVER_PAID when the variance is positive beyond tolerance', () => {
    expect(classifyVariance(50000, 5000)).toBe(VarianceStatus.OVER_PAID);
  });

  it('returns UNDER_PAID when the variance is negative beyond tolerance', () => {
    expect(classifyVariance(30000, -15000)).toBe(VarianceStatus.UNDER_PAID);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/reconciliation/variance-classification.util.spec.ts`
Expected: FAIL — `Cannot find module './variance-classification.util'`.

- [ ] **Step 3: Implement `classifyVariance`**

`src/reconciliation/variance-classification.util.ts`:

```typescript
import { VarianceStatus } from '../generated/prisma/client';

const MATCH_TOLERANCE = 1;

export function classifyVariance(actualAmount: number, variance: number): VarianceStatus {
  if (actualAmount === 0) {
    return VarianceStatus.NO_DEDUCTION_FOUND;
  }
  if (Math.abs(variance) <= MATCH_TOLERANCE) {
    return VarianceStatus.MATCHED;
  }
  return variance > 0 ? VarianceStatus.OVER_PAID : VarianceStatus.UNDER_PAID;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/reconciliation/variance-classification.util.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Refactor `ReconciliationService` to use it**

In `src/reconciliation/reconciliation.service.ts`: remove the `MATCH_TOLERANCE` constant and the private `classify` method; add `import { classifyVariance } from './variance-classification.util';`; change the one call site `this.classify(actualAmount, variance)` to `classifyVariance(actualAmount, variance)`.

- [ ] **Step 6: Refactor `ClientLoanReconciliationService` to use it**

In `src/reconciliation/client-loan-reconciliation.service.ts`: same change — remove `MATCH_TOLERANCE`/private `classify`, add the import, change `this.classify(actualAmount, variance)` to `classifyVariance(actualAmount, variance)`.

- [ ] **Step 7: Run the full reconciliation suite to confirm no regression**

Run: `npx jest src/reconciliation`
Expected: PASS — every reconciliation suite (old and new), same test counts as before this task (pure extraction, no behavior change).

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/reconciliation/variance-classification.util.ts src/reconciliation/variance-classification.util.spec.ts src/reconciliation/reconciliation.service.ts src/reconciliation/client-loan-reconciliation.service.ts
git commit -m "refactor: extract classifyVariance into a shared util"
```

---

### Task 3: `LoanRequestService.applyWalletToLoan`

**Files:**
- Modify: `src/loan-request/loan-request.module.ts`
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`

**Interfaces:**
- Consumes: `WalletService.debit` (existing, unchanged), `classifyVariance` (Task 2), `computeClientLoanStatus` (existing, from B3), `toPeriodKey` (existing, unchanged), `VarianceSource` (Task 1).
- Produces: `LoanRequestService.applyWalletToLoan(clientId: string, amount: number): Promise<{ appliedAmount: number; remainingBalance: number; status: 'ACTIVE' | 'DEFAULT' | 'CLOSED' }>` — Task 4's controller consumes this.

`LoanRequestService` gains a new required `walletService: WalletService` constructor parameter, inserted **before** the existing optional `configService?: ConfigService` (same reason as B2's `topupEligibilityService` addition — TypeScript requires non-optional parameters before optional ones). Every place the spec file constructs `new LoanRequestService(...)` needs a `walletService` mock inserted as the 6th argument (after `topupEligibilityService`, before `configService`) — there are three such call sites in the current file (the main `beforeEach`, and the two `'confirmByPhone with auto-approval'` tests that reconstruct `service` with a real `configService`), the same three call sites B2's Task 3 already had to update once.

- [ ] **Step 1: Import `WalletModule` into `LoanRequestModule`**

In `src/loan-request/loan-request.module.ts`, add `import { WalletModule } from '../wallet/wallet.module';` and add `WalletModule` to the `imports` array (`WalletModule` already exports `WalletService`, from B3's Task 3 Step 1).

- [ ] **Step 2: Update the `prisma`/service-construction scaffolding in the spec file**

Read `src/loan-request/loan-request.service.spec.ts`'s current full state first. Make these changes:

1. Add `import { WalletService } from '../wallet/wallet.service';` to the top imports.
2. Add a `walletService: { debit: jest.Mock }` variable declaration alongside the existing `topupEligibilityService` one, and initialize it in `beforeEach`: `walletService = { debit: jest.fn() };`.
3. Widen the `clientLoanRepaymentVariance` entry in the `prisma` mock's type declaration and `beforeEach` (added in an earlier task for `getMyLoan`/`getRepaymentPlanById` — currently `{ findMany: jest.Mock }`) to also include `findUnique` and `create`:

```typescript
    clientLoanRepaymentVariance: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
```

```typescript
      clientLoanRepaymentVariance: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
```

4. Update the main `beforeEach`'s `service = new LoanRequestService(...)` call to insert `walletService as unknown as WalletService` as the 6th argument, after `topupEligibilityService`:

```typescript
    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
      topupEligibilityService as unknown as TopupEligibilityService,
      walletService as unknown as WalletService,
    );
```

5. In both `'confirmByPhone with auto-approval'` tests (the ones that reconstruct `service` with a real `configService` as the last argument), insert `walletService as unknown as WalletService` as the 6th argument, before `configService` (now the 7th):

```typescript
      service = new LoanRequestService(
        prisma as unknown as PrismaService,
        eligibilityService as unknown as EligibilityService,
        smsProvider as unknown as TwoWaySmsProvider,
        expiryQueue as unknown as Queue,
        topupEligibilityService as unknown as TopupEligibilityService,
        walletService as unknown as WalletService,
        configService,
      );
```

- [ ] **Step 3: Run the suite to confirm the scaffolding change alone now fails against the old constructor**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `Expected 6-7 arguments, but got 5-6` (the service class itself hasn't been updated yet in this step).

- [ ] **Step 4: Write the failing tests for `applyWalletToLoan`**

Append this `describe` block to `src/loan-request/loan-request.service.spec.ts`, after the last existing block:

```typescript
  describe('applyWalletToLoan', () => {
    // Date-relative (not hardcoded) so this fixture never drifts into the past — see the identical
    // reasoning in client-loan-reconciliation.service.spec.ts's baseLoan fixture.
    const now = new Date();
    const disbursementDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const maturationDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    it('throws UnprocessableEntityException when the client has no outstanding loan balance', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue(null);
      await expect(service.applyWalletToLoan('c1', 5000)).rejects.toThrow(UnprocessableEntityException);
      expect(walletService.debit).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the current period already has a variance row, without touching the wallet', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate,
        maturationDate,
      });
      prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue({ id: 'existing-row' });

      await expect(service.applyWalletToLoan('c1', 5000)).rejects.toThrow(ConflictException);
      expect(walletService.debit).not.toHaveBeenCalled();
      expect(prisma.clientLoanRepaymentVariance.create).not.toHaveBeenCalled();
    });

    it('caps the applied amount at principalBalance, fully pays off the loan, and records an OVER_PAID row', async () => {
      // expectedAmount = 90000 / 2 months = 45000. Requesting 100000 against a 60000 balance caps at
      // 60000 — which exceeds the period's own expected installment (45000), so this period's row is
      // OVER_PAID even though nothing is credited back to the wallet (per the design: the full applied
      // amount pays down principal, with no separate excess-to-wallet step for a client-initiated payment).
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate,
        maturationDate,
      });
      prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue(null);
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1', status: 'CLOSED' });

      const result = await service.applyWalletToLoan('c1', 100000);

      expect(walletService.debit).toHaveBeenCalledWith(
        'c1',
        60000,
        expect.stringContaining('cl1'),
        { actorType: 'CLIENT', actorId: 'c1' },
      );
      expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientLoanId: 'cl1',
          expectedAmount: 45000,
          actualAmount: 60000,
          variance: 15000,
          status: 'OVER_PAID',
          source: 'WALLET_APPLICATION',
        }),
      });
      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: { principalBalance: 0, status: 'CLOSED' },
      });
      expect(result).toEqual({ appliedAmount: 60000, remainingBalance: 0, status: 'CLOSED' });
    });

    it('applies a partial amount without capping, reducing the balance by the full amount regardless of the expected installment', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate,
        maturationDate,
      });
      prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue(null);
      prisma.clientLoan.update.mockResolvedValue({ id: 'cl1', status: 'DEFAULT' });

      const result = await service.applyWalletToLoan('c1', 20000);

      expect(walletService.debit).toHaveBeenCalledWith('c1', 20000, expect.any(String), {
        actorType: 'CLIENT',
        actorId: 'c1',
      });
      expect(prisma.clientLoanRepaymentVariance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ actualAmount: 20000, status: 'UNDER_PAID' }),
      });
      expect(prisma.clientLoan.update).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        data: { principalBalance: 40000, status: 'DEFAULT' },
      });
      expect(result).toEqual({ appliedAmount: 20000, remainingBalance: 40000, status: 'DEFAULT' });
    });

    it('propagates WalletService.debit\'s own insufficient-balance error without creating a variance row', async () => {
      prisma.clientLoan.findFirst.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        principalBalance: 60000,
        interestRatePercent: 0,
        disbursementDate,
        maturationDate,
      });
      prisma.clientLoanRepaymentVariance.findUnique.mockResolvedValue(null);
      walletService.debit.mockRejectedValue(new UnprocessableEntityException('Insufficient wallet balance'));

      await expect(service.applyWalletToLoan('c1', 20000)).rejects.toThrow('Insufficient wallet balance');
      expect(prisma.clientLoanRepaymentVariance.create).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `service.applyWalletToLoan is not a function`.

- [ ] **Step 6: Implement `applyWalletToLoan`**

In `src/loan-request/loan-request.service.ts`, add these two new import lines:

```typescript
import { WalletService } from '../wallet/wallet.service';
import { classifyVariance } from '../reconciliation/variance-classification.util';
import { computeClientLoanStatus } from '../reconciliation/client-loan-status.util';
```

Then change the existing `import { generatePeriodRange } from '../reconciliation/period.util';` line to also bring in `toPeriodKey` (merge into the same import rather than adding a second, separate import line from the same module):

```typescript
import { generatePeriodRange, toPeriodKey } from '../reconciliation/period.util';
```

Merge `AuditActorType` and `VarianceSource` into the existing `'../generated/prisma/client'` import line.

Add `walletService: WalletService` as a new required 6th constructor parameter, before the existing optional `configService`:

```typescript
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    @Inject(TWO_WAY_SMS_PROVIDER) private readonly smsProvider: TwoWaySmsProvider,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
    private readonly topupEligibilityService: TopupEligibilityService,
    private readonly walletService: WalletService,
    private readonly configService?: ConfigService,
  ) {}
```

Add this method to the class, after `applyTopupToClientLoan`:

```typescript
  async applyWalletToLoan(clientId: string, amount: number) {
    const clientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId, principalBalance: { gt: 0 } },
      orderBy: { disbursementDate: 'desc' },
    });
    if (!clientLoan) {
      throw new UnprocessableEntityException('No outstanding loan balance to pay down');
    }

    const currentPeriod = toPeriodKey(new Date());
    const existingVariance = await this.prisma.clientLoanRepaymentVariance.findUnique({
      where: { clientLoanId_period: { clientLoanId: clientLoan.id, period: currentPeriod } },
    });
    if (existingVariance) {
      throw new ConflictException('This period has already been reconciled for this loan');
    }

    const principalBalance = Number(clientLoan.principalBalance);
    const appliedAmount = Math.min(amount, principalBalance);

    await this.walletService.debit(clientId, appliedAmount, `Applied toward loan #${clientLoan.id}`, {
      actorType: AuditActorType.CLIENT,
      actorId: clientId,
    });

    const expectedAmount = computeExpectedInstallment(
      Number(clientLoan.principalAmount),
      Number(clientLoan.interestRatePercent),
      clientLoan.disbursementDate,
      clientLoan.maturationDate,
    );
    const variance = appliedAmount - expectedAmount;
    const status = classifyVariance(appliedAmount, variance);

    await this.prisma.clientLoanRepaymentVariance.create({
      data: {
        clientLoanId: clientLoan.id,
        period: currentPeriod,
        expectedAmount,
        actualAmount: appliedAmount,
        variance,
        status,
        source: VarianceSource.WALLET_APPLICATION,
      },
    });

    const remainingBalance = principalBalance - appliedAmount;
    const newStatus = computeClientLoanStatus(
      { principalBalance: remainingBalance, maturationDate: clientLoan.maturationDate },
      status,
    );

    await this.prisma.clientLoan.update({
      where: { id: clientLoan.id },
      data: { principalBalance: remainingBalance, status: newStatus },
    });

    return { appliedAmount, remainingBalance, status: newStatus };
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks in the full file after this step to confirm the total, rather than trusting a specific stated number (this task added 5 `applyWalletToLoan` tests on top of whatever count the prior plan left the file at).

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/loan-request/loan-request.module.ts src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts
git commit -m "feat: add applyWalletToLoan to LoanRequestService"
```

---

### Task 4: Controller

**Files:**
- Create: `src/loan-request/dto/apply-wallet-to-loan.dto.ts`
- Modify: `src/loan-request/client-loan.controller.ts`

**Interfaces:**
- Consumes: `LoanRequestService.applyWalletToLoan` (Task 3).
- Produces: `POST /client/client-loans/me/apply-wallet`.

- [ ] **Step 1: Add the DTO**

`src/loan-request/dto/apply-wallet-to-loan.dto.ts`:

```typescript
import { IsNumber, IsPositive } from 'class-validator';

export class ApplyWalletToLoanDto {
  @IsNumber()
  @IsPositive()
  amount: number;
}
```

- [ ] **Step 2: Add the endpoint**

In `src/loan-request/client-loan.controller.ts`, add imports for `Body`, `HttpCode`, `Post` (merge into the existing `@nestjs/common` import) and `ApplyWalletToLoanDto`, then add this method:

```typescript
  @Post('me/apply-wallet')
  @HttpCode(200)
  applyWalletToLoan(@Body() dto: ApplyWalletToLoanDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.applyWalletToLoan(req.user.sub, dto.amount);
  }
```

- [ ] **Step 3: Type-check and run the loan-request unit suite**

Run: `npx tsc --noEmit && npx jest src/loan-request`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/loan-request/dto/apply-wallet-to-loan.dto.ts src/loan-request/client-loan.controller.ts
git commit -m "feat: add POST /client/client-loans/me/apply-wallet endpoint"
```

---

### Task 5: e2e tests, README, Postman, and the phase-closing full suite run

**Files:**
- Create: `test/wallet-loan-payment.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

This is the last task of the last plan in the Loan Lifecycle Overhaul phase (A, B1, B2, B3 already shipped) — per this plan's Global Constraints, Step 8 below is a genuine full-suite run (the phase-closing one), not a scoped one.

- [ ] **Step 1: Write the e2e test**

Read `test/client-loan-repayment-tracking.e2e-spec.ts` and `test/wallet.e2e-spec.ts` first for the fixture/helper patterns this combines. `test/wallet-loan-payment.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Spend wallet balance toward a loan payment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-WALLETPAY-${Date.now()}`;
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
    await prisma.walletEntry.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E WalletPay Test' } } } });
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E WalletPay Test' } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: 'E2E WalletPay Test' } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234807' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 2 } });
    await app.close();
  });

  async function originateAndDisburseLoan(phoneSuffix: string, staffIdSuffix: string) {
    const phone = `+234807${phoneSuffix}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-${staffIdSuffix}`, employeeName: 'E2E WalletPay Test', salary: 5000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E WalletPay Test',
        agency,
        step: 'COMPLETED',
      },
    });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });

    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 90000, tenorMonths: 2 })
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

    return { client, accessToken };
  }

  it(
    'lets a client apply their wallet balance toward their loan, reducing the balance and appearing in the schedule',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000001', 'A');

      await request(app.getHttpServer())
        .post(`/admin/clients/${client.id}/wallet/credit`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ amount: 30000, description: 'E2E test credit' })
        .expect(200);

      const applyRes = await request(app.getHttpServer())
        .post('/client/client-loans/me/apply-wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 20000 })
        .expect(200);
      expect(applyRes.body).toEqual({ appliedAmount: 20000, remainingBalance: 70000, status: 'DEFAULT' });

      const walletRes = await request(app.getHttpServer())
        .get('/client/wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(walletRes.body.balance).toBe(10000);

      const myLoanRes = await request(app.getHttpServer())
        .get('/client/client-loans/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const currentPeriodEntry = myLoanRes.body.schedule.find(
        (row: { status: string }) => row.status !== 'UPCOMING',
      );
      expect(currentPeriodEntry).toEqual(
        expect.objectContaining({ actualAmount: 20000, status: 'UNDER_PAID' }),
      );
    },
    30000,
  );

  it('rejects a second wallet application in the same period with a 409', async () => {
    const { client, accessToken } = await originateAndDisburseLoan('0000002', 'B');

    await request(app.getHttpServer())
      .post(`/admin/clients/${client.id}/wallet/credit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: 30000, description: 'E2E test credit' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/client/client-loans/me/apply-wallet')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 10000 })
      .expect(200);

    await request(app.getHttpServer())
      .post('/client/client-loans/me/apply-wallet')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 5000 })
      .expect(409);
  });

  it('rejects an application exceeding the wallet balance with a 422', async () => {
    const { accessToken } = await originateAndDisburseLoan('0000003', 'C');

    await request(app.getHttpServer())
      .post('/client/client-loans/me/apply-wallet')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 5000 })
      .expect(422);
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/wallet-loan-payment.e2e-spec.ts --runInBand`
Expected: PASS — 3 tests.

- [ ] **Step 3: Update the README**

In `README.md`, find the "### Repayment tracking" subsection (under "## Loan origination", added by the prior plan) and add this new subsection directly after it:

```markdown
### Spend wallet balance toward a loan payment

`POST /client/client-loans/me/apply-wallet` (`{ amount }`, Client JWT)
lets a client apply their own wallet balance toward their loan's
outstanding `principalBalance` — `422` if they have no outstanding
balance, `409` if the current period already has a
`ClientLoanRepaymentVariance` row (from either payroll reconciliation or
an earlier wallet application this period — at most one per period,
either source). The requested amount is silently capped at
`principalBalance`; `WalletService.debit()` still applies its own
independent insufficient-wallet-balance check. Unlike payroll
reconciliation, the **full** applied amount reduces `principalBalance` —
there's no excess-to-wallet step, since the amount already came from the
client's own wallet. Produces a `ClientLoanRepaymentVariance` row for the
current period (`source: WALLET_APPLICATION`), so the payment shows up in
`GET /client/client-loans/me`'s schedule the same way a payroll deduction
would.
```

- [ ] **Step 4: Add Postman coverage**

Add `POST /client/client-loans/me/apply-wallet` under Client — success, no-outstanding-balance (`422`), already-reconciled-this-period (`409`), insufficient-wallet-balance (`422`) — each with a saved response example authored from the actual code. Use a surgical text-based/jq-based insert, not a full rewrite (watch `ensure_ascii` if using Python's `json` module).

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Run the scoped suites touched by this plan**

Run: `npx jest src/reconciliation src/loan-request src/wallet && npx jest --config ./test/jest-e2e.json test/wallet-loan-payment.e2e-spec.ts test/client-loan-repayment-tracking.e2e-spec.ts test/loan-topup.e2e-spec.ts test/loan-origination.e2e-spec.ts test/loan-request.e2e-spec.ts test/wallet.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/wallet-loan-payment.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add wallet-to-loan-payment e2e coverage and docs"
```

- [ ] **Step 8: Run the full suite — this closes out the entire Loan Lifecycle Overhaul phase**

This is the one point in this plan (and the only point across all five plans in this phase — A, B1, B2, B3, and this one) where a genuine full run is appropriate, per this session's standing testing preference: a full suite run happens at the end of a whole phase, not at the end of each individual plan, and this plan is the phase's last one.

Run: `npm run test`
Expected: PASS — every unit suite in the codebase.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run just that suite in isolation to confirm it's pre-existing environmental flakiness (this repo has known flakiness under machine load, observed and confirmed benign multiple times across this phase's earlier plans) rather than a real regression, and report that distinction clearly rather than just calling it a pass.

- [ ] **Step 9: Report phase completion**

No code change for this step — just confirm in your final report that Step 8's full run passed, since this is the signal that the entire Loan Lifecycle Overhaul phase (Wallet & Ledger, Loan Origination, Topup, Repayment Tracking, and this plan) is done and the codebase is in a fully green state.

## Exit criteria

- [ ] Step 6's scoped suite passes from a clean state.
- [ ] A client can apply part of their wallet balance to their loan, reducing `principalBalance` by the full amount applied and appearing in their repayment schedule with `source: WALLET_APPLICATION`.
- [ ] A second application in the same period is rejected `409`; an application beyond the wallet's real balance is rejected `422`; a request beyond the loan's remaining balance is silently capped, not rejected.
- [ ] `classifyVariance` has exactly one implementation, used by both existing reconciliation services and this new code.
- [ ] Postman has coverage for the new endpoint, including all three failure cases.
- [ ] **Step 8's full unit + e2e suite run passes clean, closing out the entire Loan Lifecycle Overhaul phase.**
