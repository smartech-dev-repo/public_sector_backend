# Loan Request & Confirmation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a verified client request a loan, run an eligibility check, push it to the database as `PENDING`, send a two-way SMS confirmation, and resolve it to `CONFIRMED` (inbound webhook reply) or `FAILED` (24-hour timeout), with a resend option.

**Architecture:** A new `LoanRequest` model, distinct from the existing `Loan` model (historical/ingested loans). A small composable eligibility rule-list (not a full pluggable-provider abstraction — these are internal business rules). A pluggable `TwoWaySmsProvider` (mock-first, matching every other external integration in this codebase). A `LoanRequestService` orchestrating create/resend/confirm/expire, backed by a new BullMQ queue for the 24-hour delayed expiry (reusing the existing document-ingestion queue's exact pattern). Two controllers: one client-JWT-guarded (`create`/`resend`/`list`), one fully public (the inbound SMS webhook — no vendor exists yet to authenticate against).

**Tech Stack:** NestJS 10, Prisma 7, `@nestjs/bullmq` (already a dependency), Jest.

**Spec:** `docs/superpowers/specs/2026-09-17-loan-request-workflow-design.md`

## Global Constraints

- `LoanRequest` is a new model, distinct from `Loan` (historical/ingested loans) — never conflate the two (spec §1, §2).
- Eligibility is a rule-list, first-failure-wins, run in sequence: `ClientMustBeVerifiedRule` then `AmountWithinSalaryCapRule` (spec §3). `LOAN_SALARY_MULTIPLE_CAP` env var, default `3` — explicitly provisional.
- Eligibility failure → `422 UnprocessableEntityException`, not `400` (the request body itself is well-formed; a business rule failed) (spec §5, §6).
- The inbound webhook (`POST /webhooks/sms/inbound`) has **no auth guard at all** — a real vendor would call it directly, and there's no vendor to authenticate against yet (signature verification is deferred, per spec §4). No match for a phone/no `PENDING` request → still `200`, silently ignored — never leak whether a phone number exists (spec §5, §6).
- `resend` never resets `expiresAt` or re-enqueues a new expiry job — the original 24-hour window governs (spec §5).
- The expiry job is a no-op if the request already resolved (`CONFIRMED` or already `FAILED`) by the time it fires — this is the deliberate confirm-vs-expiry race handling, not a bug (spec §5, §7).
- Disbursement (turning `CONFIRMED` into a real `Loan` row) is out of scope (spec §1).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints (Task 5).

---

### Task 1: `LoanRequest` schema

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: the `LoanRequest` model and `LoanRequestStatus` enum — every later task depends on these exact field names.

- [ ] **Step 1: Add the enum, model, and relation field**

Append to `prisma/schema.prisma`:

```prisma
enum LoanRequestStatus {
  PENDING
  CONFIRMED
  FAILED
}

model LoanRequest {
  id                    String            @id @default(uuid())
  clientId              String
  client                Client            @relation(fields: [clientId], references: [id])
  amount                Decimal
  status                LoanRequestStatus @default(PENDING)
  confirmationSmsSentAt DateTime?
  confirmedAt           DateTime?
  expiresAt             DateTime
  createdAt             DateTime          @default(now())
  updatedAt             DateTime          @updatedAt
}
```

Add one field inside the existing `Client` model:

```prisma
  loanRequests LoanRequest[]
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_loan_request`
Expected: creates and applies `prisma/migrations/<timestamp>_add_loan_request/migration.sql`.

- [ ] **Step 3: Explicitly regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Verify the client regenerated correctly**

Run: `grep -n "PENDING\|CONFIRMED" src/generated/prisma/models/LoanRequest.ts`
Expected: the file exists and references the status values. (Per prior experience in this codebase: check the per-model file under `src/generated/prisma/models/`, not `client.ts`, since Prisma 7 re-exports enums via a wildcard there.)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add LoanRequest model"
```

---

### Task 2: Eligibility rules

**Files:**
- Create: `src/loan-request/eligibility/eligibility-rule.interface.ts`
- Create: `src/loan-request/eligibility/client-must-be-verified.rule.ts`
- Test: `src/loan-request/eligibility/client-must-be-verified.rule.spec.ts`
- Create: `src/loan-request/eligibility/amount-within-salary-cap.rule.ts`
- Test: `src/loan-request/eligibility/amount-within-salary-cap.rule.spec.ts`
- Create: `src/loan-request/eligibility/eligibility.service.ts`
- Test: `src/loan-request/eligibility/eligibility.service.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing new.
- Produces: `EligibilityRule` interface (`check(client, ippisRecord, amount): {eligible, reason?}`), `ClientMustBeVerifiedRule`, `AmountWithinSalaryCapRule`, `EligibilityService.check(client, ippisRecord, amount): {eligible, reason?}` — Task 4's `LoanRequestService` consumes `EligibilityService`.

- [ ] **Step 1: Write the failing tests**

`src/loan-request/eligibility/client-must-be-verified.rule.spec.ts`:

```typescript
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('ClientMustBeVerifiedRule', () => {
  const rule = new ClientMustBeVerifiedRule();
  const ippisRecord = {} as IppisRecord;

  it('passes for a VERIFIED client', () => {
    const result = rule.check({ status: 'VERIFIED' } as Client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails for a non-VERIFIED client', () => {
    const result = rule.check({ status: 'MANUAL_REVIEW' } as Client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/VERIFIED/);
  });
});
```

`src/loan-request/eligibility/amount-within-salary-cap.rule.spec.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('AmountWithinSalaryCapRule', () => {
  function buildRule(capMultiple: string) {
    return new AmountWithinSalaryCapRule({ get: () => capMultiple } as unknown as ConfigService);
  }

  const client = {} as Client;

  it('passes when the amount is within the cap', () => {
    const rule = buildRule('3');
    const result = rule.check(client, { salary: 100000 } as unknown as IppisRecord, 300000);
    expect(result.eligible).toBe(true);
  });

  it('fails when the amount exceeds the cap', () => {
    const rule = buildRule('3');
    const result = rule.check(client, { salary: 100000 } as unknown as IppisRecord, 300001);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });

  it('fails when there is no salary on record', () => {
    const rule = buildRule('3');
    const result = rule.check(client, { salary: null } as unknown as IppisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/No salary/);
  });
});
```

`src/loan-request/eligibility/eligibility.service.spec.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import { EligibilityService } from './eligibility.service';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('EligibilityService', () => {
  function buildService(capMultiple = '3') {
    const configService = { get: () => capMultiple } as unknown as ConfigService;
    return new EligibilityService(
      new ClientMustBeVerifiedRule(),
      new AmountWithinSalaryCapRule(configService),
    );
  }

  const verifiedClient = { status: 'VERIFIED' } as Client;
  const unverifiedClient = { status: 'PENDING_IPPIS' } as Client;
  const ippisRecordWithSalary = { salary: 100000 } as unknown as IppisRecord;

  it('passes when every rule passes', () => {
    const service = buildService();
    const result = service.check(verifiedClient, ippisRecordWithSalary, 200000);
    expect(result.eligible).toBe(true);
  });

  it('fails fast on the first failing rule without evaluating later rules', () => {
    const service = buildService();
    const result = service.check(unverifiedClient, ippisRecordWithSalary, 999999999);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/VERIFIED/);
  });

  it('fails the salary cap rule when the amount exceeds it', () => {
    const service = buildService();
    const result = service.check(verifiedClient, ippisRecordWithSalary, 400000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/loan-request/eligibility`
Expected: FAIL — `Cannot find module './client-must-be-verified.rule'` (and similarly for the other two).

- [ ] **Step 3: Implement the interface, rules, and orchestrator**

`src/loan-request/eligibility/eligibility-rule.interface.ts`:

```typescript
import { Client, IppisRecord } from '../../generated/prisma/client';

export interface EligibilityCheckResult {
  eligible: boolean;
  reason?: string;
}

export interface EligibilityRule {
  check(client: Client, ippisRecord: IppisRecord, amount: number): EligibilityCheckResult;
}
```

`src/loan-request/eligibility/client-must-be-verified.rule.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Client, ClientStatus, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

@Injectable()
export class ClientMustBeVerifiedRule implements EligibilityRule {
  check(client: Client, _ippisRecord: IppisRecord, _amount: number): EligibilityCheckResult {
    if (client.status !== ClientStatus.VERIFIED) {
      return { eligible: false, reason: `Client must be VERIFIED (currently ${client.status})` };
    }
    return { eligible: true };
  }
}
```

`src/loan-request/eligibility/amount-within-salary-cap.rule.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

@Injectable()
export class AmountWithinSalaryCapRule implements EligibilityRule {
  constructor(private readonly configService: ConfigService) {}

  check(_client: Client, ippisRecord: IppisRecord, amount: number): EligibilityCheckResult {
    const multiple = Number(this.configService.get<string>('LOAN_SALARY_MULTIPLE_CAP', '3'));
    const salary = ippisRecord.salary ? Number(ippisRecord.salary) : 0;
    if (salary <= 0) {
      return { eligible: false, reason: 'No salary on record to determine eligibility' };
    }
    const cap = salary * multiple;
    if (amount > cap) {
      return { eligible: false, reason: `Requested amount exceeds the maximum of ${cap} (${multiple}x salary)` };
    }
    return { eligible: true };
  }
}
```

`src/loan-request/eligibility/eligibility.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';

@Injectable()
export class EligibilityService {
  private readonly rules: EligibilityRule[];

  constructor(
    clientMustBeVerifiedRule: ClientMustBeVerifiedRule,
    amountWithinSalaryCapRule: AmountWithinSalaryCapRule,
  ) {
    this.rules = [clientMustBeVerifiedRule, amountWithinSalaryCapRule];
  }

  check(client: Client, ippisRecord: IppisRecord, amount: number): EligibilityCheckResult {
    for (const rule of this.rules) {
      const result = rule.check(client, ippisRecord, amount);
      if (!result.eligible) {
        return result;
      }
    }
    return { eligible: true };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/loan-request/eligibility`
Expected: PASS — 8 tests (2 + 3 + 3).

- [ ] **Step 5: Document the new env var**

Add to `.env.example`:

```
# Provisional placeholder — the real ratio will be supplied later.
LOAN_SALARY_MULTIPLE_CAP=3
```

- [ ] **Step 6: Commit**

```bash
git add src/loan-request/eligibility .env.example
git commit -m "feat: add loan request eligibility rules"
```

---

### Task 3: `TwoWaySmsProvider`

**Files:**
- Create: `src/two-way-sms/two-way-sms-provider.interface.ts`
- Create: `src/two-way-sms/mock-two-way-sms.provider.ts`
- Test: `src/two-way-sms/mock-two-way-sms.provider.spec.ts`
- Create: `src/two-way-sms/two-way-sms.module.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TwoWaySmsProvider` interface (`send(phone, message): Promise<void>`), `TWO_WAY_SMS_PROVIDER` DI token, `MockTwoWaySmsProvider`, `TwoWaySmsModule` (exports the token) — Task 4 injects `TWO_WAY_SMS_PROVIDER`.

- [ ] **Step 1: Write the failing test**

`src/two-way-sms/mock-two-way-sms.provider.spec.ts`:

```typescript
import { MockTwoWaySmsProvider } from './mock-two-way-sms.provider';

describe('MockTwoWaySmsProvider', () => {
  it('resolves without throwing', async () => {
    const provider = new MockTwoWaySmsProvider();
    await expect(provider.send('+2348000000000', 'Reply YES to confirm')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/two-way-sms/mock-two-way-sms.provider.spec.ts`
Expected: FAIL — `Cannot find module './mock-two-way-sms.provider'`

- [ ] **Step 3: Implement the interface, mock, and module**

`src/two-way-sms/two-way-sms-provider.interface.ts`:

```typescript
export const TWO_WAY_SMS_PROVIDER = Symbol('TWO_WAY_SMS_PROVIDER');

export interface TwoWaySmsProvider {
  send(phone: string, message: string): Promise<void>;
}
```

`src/two-way-sms/mock-two-way-sms.provider.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { TwoWaySmsProvider } from './two-way-sms-provider.interface';

@Injectable()
export class MockTwoWaySmsProvider implements TwoWaySmsProvider {
  private readonly logger = new Logger(MockTwoWaySmsProvider.name);

  async send(phone: string, message: string): Promise<void> {
    this.logger.log(`[mock SMS] to ${phone}: ${message}`);
  }
}
```

`src/two-way-sms/two-way-sms.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { MockTwoWaySmsProvider } from './mock-two-way-sms.provider';
import { TWO_WAY_SMS_PROVIDER } from './two-way-sms-provider.interface';

@Module({
  providers: [
    MockTwoWaySmsProvider,
    // Single-provider for now (per the spec — no second vendor exists yet),
    // matching FaceVerificationModule's own no-failover-list precedent.
    { provide: TWO_WAY_SMS_PROVIDER, useExisting: MockTwoWaySmsProvider },
  ],
  exports: [TWO_WAY_SMS_PROVIDER],
})
export class TwoWaySmsModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/two-way-sms/mock-two-way-sms.provider.spec.ts`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/two-way-sms
git commit -m "feat: add TwoWaySmsProvider with mock implementation"
```

---

### Task 4: `LoanRequestService` and expiry processor

**Files:**
- Create: `src/loan-request/loan-request-queue.constants.ts`
- Create: `src/loan-request/loan-request.service.ts`
- Test: `src/loan-request/loan-request.service.spec.ts`
- Create: `src/loan-request/loan-request-expiry.processor.ts`

**Interfaces:**
- Consumes: `EligibilityService` (Task 2), `TWO_WAY_SMS_PROVIDER` (Task 3), `PrismaService`.
- Produces: `LoanRequestService.create(clientId, amount)`, `.resend(clientId, id)`, `.confirmByPhone(phone, message): Promise<void>`, `.expire(loanRequestId): Promise<void>`, `.list(clientId)`, `LoanRequestExpiryJobData { loanRequestId: string }`, `LoanRequestExpiryProcessor` — Task 5's controllers and module wiring consume all of these.

- [ ] **Step 1: Write the failing tests**

`src/loan-request/loan-request.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { LoanRequestService } from './loan-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { TwoWaySmsProvider } from '../two-way-sms/two-way-sms-provider.interface';

describe('LoanRequestService', () => {
  let service: LoanRequestService;
  let prisma: {
    client: { findUniqueOrThrow: jest.Mock; findUnique: jest.Mock };
    clientOnboarding: { findUnique: jest.Mock };
    loanRequest: { create: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; findMany: jest.Mock };
  };
  let eligibilityService: { check: jest.Mock };
  let smsProvider: { send: jest.Mock };
  let expiryQueue: { add: jest.Mock };

  beforeEach(() => {
    prisma = {
      client: { findUniqueOrThrow: jest.fn(), findUnique: jest.fn() },
      clientOnboarding: { findUnique: jest.fn() },
      loanRequest: { create: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    };
    eligibilityService = { check: jest.fn() };
    smsProvider = { send: jest.fn().mockResolvedValue(undefined) };
    expiryQueue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new LoanRequestService(
      prisma as unknown as PrismaService,
      eligibilityService as unknown as EligibilityService,
      smsProvider as unknown as TwoWaySmsProvider,
      expiryQueue as unknown as Queue,
    );
  });

  describe('create', () => {
    it('rejects when the client has no onboarding record', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      await expect(service.create('c1', 1000)).rejects.toThrow(ConflictException);
    });

    it('rejects when eligibility fails, without sending any SMS', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000 } });
      eligibilityService.check.mockReturnValue({ eligible: false, reason: 'too much' });
      await expect(service.create('c1', 1000000)).rejects.toThrow(UnprocessableEntityException);
      expect(smsProvider.send).not.toHaveBeenCalled();
    });

    it('sends the SMS, creates the request, and enqueues the expiry job on success', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { salary: 1000000 } });
      eligibilityService.check.mockReturnValue({ eligible: true });
      prisma.loanRequest.create.mockResolvedValue({ id: 'lr1' });

      await service.create('c1', 5000);

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('5000'));
      expect(prisma.loanRequest.create).toHaveBeenCalled();
      expect(expiryQueue.add).toHaveBeenCalledWith('expire', { loanRequestId: 'lr1' }, { delay: 24 * 60 * 60 * 1000 });
    });
  });

  describe('resend', () => {
    it('rejects when the loan request does not belong to the calling client', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'other-client', status: 'PENDING' });
      await expect(service.resend('c1', 'lr1')).rejects.toThrow(NotFoundException);
    });

    it('rejects when the loan request is not PENDING', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'CONFIRMED' });
      await expect(service.resend('c1', 'lr1')).rejects.toThrow(ConflictException);
    });

    it('re-sends the SMS and updates confirmationSmsSentAt without touching expiresAt', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', clientId: 'c1', status: 'PENDING', amount: 5000 });
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'c1', phone: '+2348000000000' });
      prisma.loanRequest.update.mockResolvedValue({ id: 'lr1' });

      await service.resend('c1', 'lr1');

      expect(smsProvider.send).toHaveBeenCalledWith('+2348000000000', expect.stringContaining('5000'));
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { confirmationSmsSentAt: expect.any(Date) },
      });
    });
  });

  describe('confirmByPhone', () => {
    it('ignores a reply that is not YES/1', async () => {
      await service.confirmByPhone('+2348000000000', 'maybe later');
      expect(prisma.client.findUnique).not.toHaveBeenCalled();
    });

    it('ignores when no client matches the phone', async () => {
      prisma.client.findUnique.mockResolvedValue(null);
      await service.confirmByPhone('+2348000000000', 'YES');
      expect(prisma.loanRequest.findFirst).not.toHaveBeenCalled();
    });

    it('ignores when the client has no PENDING loan request', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.loanRequest.findFirst.mockResolvedValue(null);
      await service.confirmByPhone('+2348000000000', 'yes');
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
    });

    it('confirms the most recent PENDING request for a matching YES reply', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.loanRequest.findFirst.mockResolvedValue({ id: 'lr1' });
      await service.confirmByPhone('+2348000000000', '1');
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'CONFIRMED', confirmedAt: expect.any(Date) },
      });
    });
  });

  describe('expire', () => {
    it('does nothing if the loan request no longer exists', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue(null);
      await service.expire('lr1');
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
    });

    it('does nothing if the loan request already resolved (the confirm-vs-expiry race)', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'CONFIRMED' });
      await service.expire('lr1');
      expect(prisma.loanRequest.update).not.toHaveBeenCalled();
    });

    it('marks a still-PENDING request FAILED', async () => {
      prisma.loanRequest.findUnique.mockResolvedValue({ id: 'lr1', status: 'PENDING' });
      await service.expire('lr1');
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'FAILED' },
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `Cannot find module './loan-request.service'`

- [ ] **Step 3: Implement the queue constant, service, and processor**

`src/loan-request/loan-request-queue.constants.ts`:

```typescript
export const LOAN_REQUEST_EXPIRY_QUEUE = 'loan-request-expiry';
```

`src/loan-request/loan-request.service.ts`:

```typescript
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { TWO_WAY_SMS_PROVIDER, TwoWaySmsProvider } from '../two-way-sms/two-way-sms-provider.interface';
import { LOAN_REQUEST_EXPIRY_QUEUE } from './loan-request-queue.constants';
import { LoanRequestStatus } from '../generated/prisma/client';

const EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface LoanRequestExpiryJobData {
  loanRequestId: string;
}

@Injectable()
export class LoanRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibilityService: EligibilityService,
    @Inject(TWO_WAY_SMS_PROVIDER) private readonly smsProvider: TwoWaySmsProvider,
    @InjectQueue(LOAN_REQUEST_EXPIRY_QUEUE) private readonly expiryQueue: Queue<LoanRequestExpiryJobData>,
  ) {}

  private confirmationMessage(amount: number): string {
    return `Reply YES to confirm your loan request of ₦${amount}`;
  }

  async create(clientId: string, amount: number) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      throw new ConflictException('Client has not completed onboarding');
    }

    const eligibility = this.eligibilityService.check(client, onboarding.ippisRecord, amount);
    if (!eligibility.eligible) {
      throw new UnprocessableEntityException(eligibility.reason);
    }

    await this.smsProvider.send(client.phone, this.confirmationMessage(amount));

    const loanRequest = await this.prisma.loanRequest.create({
      data: {
        clientId,
        amount,
        expiresAt: new Date(Date.now() + EXPIRY_MS),
        confirmationSmsSentAt: new Date(),
      },
    });

    await this.expiryQueue.add('expire', { loanRequestId: loanRequest.id }, { delay: EXPIRY_MS });

    return loanRequest;
  }

  async resend(clientId: string, id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.clientId !== clientId) {
      throw new NotFoundException('Loan request not found');
    }
    if (loanRequest.status !== LoanRequestStatus.PENDING) {
      throw new ConflictException(`Loan request is not PENDING (currently ${loanRequest.status})`);
    }

    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    await this.smsProvider.send(client.phone, this.confirmationMessage(Number(loanRequest.amount)));

    return this.prisma.loanRequest.update({
      where: { id },
      data: { confirmationSmsSentAt: new Date() },
    });
  }

  async confirmByPhone(phone: string, message: string): Promise<void> {
    const normalized = message.trim().toLowerCase();
    if (normalized !== 'yes' && normalized !== '1') {
      return;
    }

    const client = await this.prisma.client.findUnique({ where: { phone } });
    if (!client) {
      return;
    }

    const pending = await this.prisma.loanRequest.findFirst({
      where: { clientId: client.id, status: LoanRequestStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) {
      return;
    }

    await this.prisma.loanRequest.update({
      where: { id: pending.id },
      data: { status: LoanRequestStatus.CONFIRMED, confirmedAt: new Date() },
    });
  }

  async expire(loanRequestId: string): Promise<void> {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id: loanRequestId } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.PENDING) {
      return;
    }
    await this.prisma.loanRequest.update({
      where: { id: loanRequestId },
      data: { status: LoanRequestStatus.FAILED },
    });
  }

  async list(clientId: string) {
    return this.prisma.loanRequest.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
```

`src/loan-request/loan-request-expiry.processor.ts`:

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LOAN_REQUEST_EXPIRY_QUEUE } from './loan-request-queue.constants';
import { LoanRequestExpiryJobData, LoanRequestService } from './loan-request.service';

@Processor(LOAN_REQUEST_EXPIRY_QUEUE)
export class LoanRequestExpiryProcessor extends WorkerHost {
  constructor(private readonly loanRequestService: LoanRequestService) {
    super();
  }

  async process(job: Job<LoanRequestExpiryJobData>): Promise<void> {
    await this.loanRequestService.expire(job.data.loanRequestId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/loan-request/loan-request-queue.constants.ts src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts src/loan-request/loan-request-expiry.processor.ts
git commit -m "feat: add LoanRequestService and expiry processor"
```

---

### Task 5: Controllers, module wiring, e2e test, README, and Postman

**Files:**
- Create: `src/loan-request/dto/create-loan-request.dto.ts`
- Create: `src/loan-request/dto/sms-webhook.dto.ts`
- Create: `src/loan-request/loan-request.controller.ts`
- Create: `src/loan-request/sms-webhook.controller.ts`
- Create: `src/loan-request/loan-request.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/loan-request.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`
- Modify: `postman/README.md`

**Interfaces:**
- Consumes: `LoanRequestService` (Task 4), `ClientOnlyGuard` (already exists from the onboarding plan, `src/auth/client-only.guard.ts`).
- Produces: `POST /client/loan-requests`, `POST /client/loan-requests/:id/resend`, `GET /client/loan-requests`, `POST /webhooks/sms/inbound`.

- [ ] **Step 1: Add the DTOs**

`src/loan-request/dto/create-loan-request.dto.ts`:

```typescript
import { IsNumber, IsPositive } from 'class-validator';

export class CreateLoanRequestDto {
  @IsNumber()
  @IsPositive()
  amount: number;
}
```

`src/loan-request/dto/sms-webhook.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class SmsWebhookDto {
  @IsString()
  @MinLength(1)
  phone: string;

  @IsString()
  message: string;
}
```

- [ ] **Step 2: Implement the two controllers**

`src/loan-request/loan-request.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanRequestService } from './loan-request.service';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';

@Controller('client/loan-requests')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class LoanRequestController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Post()
  create(@Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.create(req.user.sub, dto.amount);
  }

  @Post(':id/resend')
  @HttpCode(200)
  resend(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.resend(req.user.sub, id);
  }

  @Get()
  list(@Req() req: { user: JwtPayload }) {
    return this.loanRequestService.list(req.user.sub);
  }
}
```

`src/loan-request/sms-webhook.controller.ts`:

```typescript
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { LoanRequestService } from './loan-request.service';
import { SmsWebhookDto } from './dto/sms-webhook.dto';

// Deliberately no @UseGuards here — a real SMS vendor calls this directly
// and there's no vendor-issued credential to authenticate against yet.
// Signature verification is a deferred follow-up once a real vendor is
// chosen (see docs/superpowers/specs/2026-09-17-loan-request-workflow-design.md §4).
@Controller('webhooks/sms')
export class SmsWebhookController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Post('inbound')
  @HttpCode(200)
  async inbound(@Body() dto: SmsWebhookDto) {
    await this.loanRequestService.confirmByPhone(dto.phone, dto.message);
    return { received: true };
  }
}
```

- [ ] **Step 3: Implement the module and wire it into `AppModule`**

`src/loan-request/loan-request.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoanRequestController } from './loan-request.controller';
import { SmsWebhookController } from './sms-webhook.controller';
import { LoanRequestService } from './loan-request.service';
import { LoanRequestExpiryProcessor } from './loan-request-expiry.processor';
import { LOAN_REQUEST_EXPIRY_QUEUE } from './loan-request-queue.constants';
import { EligibilityService } from './eligibility/eligibility.service';
import { ClientMustBeVerifiedRule } from './eligibility/client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './eligibility/amount-within-salary-cap.rule';
import { TwoWaySmsModule } from '../two-way-sms/two-way-sms.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: LOAN_REQUEST_EXPIRY_QUEUE }),
    TwoWaySmsModule,
  ],
  controllers: [LoanRequestController, SmsWebhookController],
  providers: [
    LoanRequestService,
    LoanRequestExpiryProcessor,
    EligibilityService,
    ClientMustBeVerifiedRule,
    AmountWithinSalaryCapRule,
  ],
})
export class LoanRequestModule {}
```

Modify `src/app.module.ts`: add `import { LoanRequestModule } from './loan-request/loan-request.module';` and add `LoanRequestModule` to the `imports` array.

- [ ] **Step 4: Write the e2e test**

`test/loan-request.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Loan request workflow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clientId: string;
  let accessToken: string;
  const phone = `+234802${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-LOAN-${Date.now()}`;

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
      data: { agency: 'NPF', staffId, employeeName: 'E2E Loan Test', salary: 1000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Loan Test',
        agency: 'NPF',
        step: 'COMPLETED',
      },
    });

    const tokenService = moduleFixture.get(TokenService);
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.loanRequest.deleteMany({ where: { clientId } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  let loanRequestId: string;

  it('rejects a request that exceeds the salary cap', async () => {
    await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 100000000 })
      .expect(422);
  });

  it('creates a loan request and resends the confirmation while still PENDING', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 500000 })
      .expect(201);
    expect(createRes.body.status).toBe('PENDING');
    loanRequestId = createRes.body.id;

    const resendRes = await request(app.getHttpServer())
      .post(`/client/loan-requests/${loanRequestId}/resend`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(resendRes.body.status).toBe('PENDING');
  });

  it('confirms the request via the inbound webhook and lists it as CONFIRMED', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/sms/inbound')
      .send({ phone, message: 'YES' })
      .expect(200);

    const listRes = await request(app.getHttpServer())
      .get('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const confirmed = listRes.body.find((lr: { id: string }) => lr.id === loanRequestId);
    expect(confirmed.status).toBe('CONFIRMED');
  });

  it('rejects resend once the request is no longer PENDING', async () => {
    await request(app.getHttpServer())
      .post(`/client/loan-requests/${loanRequestId}/resend`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });
});
```

- [ ] **Step 5: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/loan-request.e2e-spec.ts --runInBand`
Expected: PASS — 4 tests.

- [ ] **Step 6: Update the README**

Add a new section to `README.md`, after the `## Admin client review` section:

```markdown
## Loan requests

A `VERIFIED` client can request a loan; eligibility (currently: must be
`VERIFIED`, amount within `LOAN_SALARY_MULTIPLE_CAP` × their IPPIS salary
— both env-var-provisional pending real business criteria) is checked
before a `PENDING` `LoanRequest` is created and a confirmation SMS sent
via a pluggable `TwoWaySmsProvider` (mock-only for now). The client
confirms by replying "YES"/"1", forwarded to
`POST /webhooks/sms/inbound` by whatever SMS vendor is eventually wired
in — that endpoint has no auth guard since there's no vendor credential
to check yet. An unconfirmed request auto-expires to `FAILED` after 24
hours (a BullMQ-delayed job). Disbursement (turning a `CONFIRMED` request
into an actual `Loan` record) is not built — a separate future concern.

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /client/loan-requests` | Client JWT | `{ amount }`; `422` on eligibility failure |
| `POST /client/loan-requests/:id/resend` | Client JWT | Only valid while `PENDING`; doesn't reset the 24h expiry |
| `GET /client/loan-requests` | Client JWT | The calling client's own requests |
| `POST /webhooks/sms/inbound` | None (public) | `{ phone, message }` — mocked shape standing in for a real vendor's payload |
```

- [ ] **Step 7: Add Postman coverage**

In `postman/public-sector-backend.postman_collection.json`, under the **Client** top-level folder, add a new sub-folder `"Loan Requests"` (alongside the existing `Auth`, `Session`, `Onboarding` sub-folders):

```json
{
  "name": "Loan Requests",
  "item": [
    {
      "name": "POST /client/loan-requests - Eligibility failure (422)",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{client_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"amount\": 999999999\n}" },
        "url": { "raw": "{{base_url}}/client/loan-requests", "host": ["{{base_url}}"], "path": ["client", "loan-requests"] },
        "description": "Requires the client to already be VERIFIED with a linked IppisRecord that has a salary on file (see Client > Onboarding)."
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 422', () => pm.response.to.have.status(422));"] } }]
    },
    {
      "name": "POST /client/loan-requests - Success",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{client_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"amount\": 5000\n}" },
        "url": { "raw": "{{base_url}}/client/loan-requests", "host": ["{{base_url}}"], "path": ["client", "loan-requests"] }
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "exec": [
              "pm.test('status 201', () => pm.response.to.have.status(201));",
              "pm.test('status is PENDING', () => pm.expect(pm.response.json().status).to.eql('PENDING'));",
              "pm.collectionVariables.set('loan_request_id', pm.response.json().id);"
            ]
          }
        }
      ]
    },
    {
      "name": "POST /client/loan-requests/:id/resend - Success",
      "request": {
        "method": "POST",
        "header": [{ "key": "Authorization", "value": "Bearer {{client_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/client/loan-requests/{{loan_request_id}}/resend",
          "host": ["{{base_url}}"],
          "path": ["client", "loan-requests", "{{loan_request_id}}", "resend"]
        }
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));"] } }]
    },
    {
      "name": "POST /webhooks/sms/inbound - Confirm (no auth)",
      "request": {
        "method": "POST",
        "header": [{ "key": "Content-Type", "value": "application/json" }],
        "body": { "mode": "raw", "raw": "{\n  \"phone\": \"{{client_phone}}\",\n  \"message\": \"YES\"\n}" },
        "url": { "raw": "{{base_url}}/webhooks/sms/inbound", "host": ["{{base_url}}"], "path": ["webhooks", "sms", "inbound"] },
        "description": "No Authorization header — this endpoint is public. client_phone must match the phone used to log in as the Client running this folder."
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));"] } }]
    },
    {
      "name": "GET /client/loan-requests - Success",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{client_access_token}}" }],
        "url": { "raw": "{{base_url}}/client/loan-requests", "host": ["{{base_url}}"], "path": ["client", "loan-requests"] }
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "exec": [
              "pm.test('status 200', () => pm.response.to.have.status(200));",
              "pm.test('is array', () => pm.expect(pm.response.json()).to.be.an('array'));"
            ]
          }
        }
      ]
    },
    {
      "name": "POST /client/loan-requests/:id/resend - Blocked, not PENDING (409)",
      "request": {
        "method": "POST",
        "header": [{ "key": "Authorization", "value": "Bearer {{client_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/client/loan-requests/{{loan_request_id}}/resend",
          "host": ["{{base_url}}"],
          "path": ["client", "loan-requests", "{{loan_request_id}}", "resend"]
        },
        "description": "Run the webhook confirm request above first so this request is no longer PENDING."
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 409', () => pm.response.to.have.status(409));"] } }]
    }
  ]
}
```

Add one new collection variable alongside the existing ones: `{ "key": "loan_request_id", "value": "" }`. If a `client_phone` variable doesn't already exist in the collection, add it too: `{ "key": "client_phone", "value": "" }`.

- [ ] **Step 8: Validate the JSON and update `postman/README.md`**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

Add "**Loan Requests**" to `postman/README.md`'s Client bullet in "Folder structure", alongside the existing Auth/Session/Onboarding mentions.

- [ ] **Step 9: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite, including the new ones from this plan.

- [ ] **Step 10: Commit**

```bash
git add src/loan-request src/app.module.ts test/loan-request.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json postman/README.md
git commit -m "feat: wire up the Loan Request & Confirmation Workflow endpoints"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] A `VERIFIED` client can request a loan within the salary cap, get a `PENDING` request, confirm it via the inbound webhook, and see it as `CONFIRMED` in their own list — proven by `test/loan-request.e2e-spec.ts`.
- [ ] A request exceeding the salary cap is rejected with `422`, and no SMS is sent — proven by both the unit and e2e tests.
- [ ] `resend` is blocked once a request is no longer `PENDING`, and never resets `expiresAt` — proven by `loan-request.service.spec.ts`.
- [ ] The expiry job is a no-op for an already-resolved request (the confirm-vs-expiry race) — proven by `loan-request.service.spec.ts`.
- [ ] The inbound webhook never reveals whether a phone number exists — always `200`, regardless of match — proven by `loan-request.service.spec.ts`.
- [ ] Postman has full coverage of all four endpoints under `Client > Loan Requests`.
