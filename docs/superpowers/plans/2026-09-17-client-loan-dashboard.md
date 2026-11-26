# Client Loan Dashboard/History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client see their own pre-existing loan history (`Loan`/`LoanRepaymentRecord` rows ingested from bank reports, which have no direct link to `Client`), matched via their linked `IppisRecord`'s `agency`+`staffId`, with a BVN cross-check to guard against a same-agency/staffId collision leaking someone else's loan.

**Architecture:** A single new `client-loans` module mirroring `client-onboarding`'s structure exactly — one service (`ClientLoansService.getDashboard`), one controller (`GET /client/loans`, `ClientOnlyGuard`-protected), no DTOs needed (no request body/params).

**Tech Stack:** NestJS 10, Prisma 7, Jest.

**Spec:** `docs/superpowers/specs/2026-09-17-client-loan-dashboard-design.md`

## Global Constraints

- `Loan`/`LoanRepaymentRecord` match a client via `IppisRecord.{agency, staffId}` — `Loan.ippisNumber` and `LoanRepaymentRecord.staffId` are the same real-world identifier as `IppisRecord.staffId`, just named differently per model (spec §2).
- BVN cross-check compares `ClientOnboarding.bvn` (the client's own Dojah-verified BVN) against `Loan.bvn` — **not** `IppisRecord.bvn` against `Loan.bvn`, since the former is two independently-sourced values agreeing, the latter would just be the same government broadsheet data reflected at itself (spec §2 point 2).
- If either side lacks a BVN to compare, the primary `agency`+`staffId` match alone stands — never exclude a loan just because a cross-check wasn't possible (spec §2 point 3).
- No `ClientOnboarding` row, or no matching rows → `200` with empty arrays, never a `404`/error (spec §4).
- `LoanRepaymentRecord` has no `bvn` field at all — the cross-check applies to `Loan` only (spec §2 point 2).
- Response excludes each model's `rawFields` (internal ingestion artifact) (spec §3).
- Not gated on `Client.status` — this is informational history, not an eligibility-gated action (spec §3).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoint.

---

### Task 1: `ClientLoansService`, controller, module wiring, e2e, and docs

**Files:**
- Create: `src/client-loans/client-loans.service.ts`
- Test: `src/client-loans/client-loans.service.spec.ts`
- Create: `src/client-loans/client-loans.controller.ts`
- Create: `src/client-loans/client-loans.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/client-loans.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: `PrismaService`, `ClientOnlyGuard`/`JwtAuthGuard` (both already exist, from the onboarding pipeline work).
- Produces: `GET /client/loans` → `{ loans: Loan[], repayments: LoanRepaymentRecord[] }` (each row minus `rawFields`).

This is a single self-contained task (small enough that splitting service/controller into separate tasks would leave an untestable intermediate state), following the same shape as every prior single-controller feature this session.

- [ ] **Step 1: Write the failing unit tests**

`src/client-loans/client-loans.service.spec.ts`:

```typescript
import { ClientLoansService } from './client-loans.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ClientLoansService', () => {
  let service: ClientLoansService;
  let prisma: {
    clientOnboarding: { findUnique: jest.Mock };
    loan: { findMany: jest.Mock };
    loanRepaymentRecord: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      clientOnboarding: { findUnique: jest.fn() },
      loan: { findMany: jest.fn() },
      loanRepaymentRecord: { findMany: jest.fn() },
    };
    service = new ClientLoansService(prisma as unknown as PrismaService);
  });

  it('returns empty lists when the client has no ClientOnboarding row', async () => {
    prisma.clientOnboarding.findUnique.mockResolvedValue(null);

    const result = await service.getDashboard('c1');

    expect(result).toEqual({ loans: [], repayments: [] });
    expect(prisma.loan.findMany).not.toHaveBeenCalled();
    expect(prisma.loanRepaymentRecord.findMany).not.toHaveBeenCalled();
  });

  it('matches loans and repayments by the linked IppisRecord agency+staffId', async () => {
    prisma.clientOnboarding.findUnique.mockResolvedValue({
      bvn: null,
      ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
    });
    prisma.loan.findMany.mockResolvedValue([{ id: 'loan-1', bvn: null }]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([{ id: 'rep-1' }]);

    const result = await service.getDashboard('c1');

    expect(prisma.loan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agency: 'NPF', ippisNumber: 'NPF-001' } }),
    );
    expect(prisma.loanRepaymentRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agency: 'NPF', staffId: 'NPF-001' } }),
    );
    expect(result).toEqual({ loans: [{ id: 'loan-1', bvn: null }], repayments: [{ id: 'rep-1' }] });
  });

  it('applies the bvn cross-check when the client has a verified bvn on file', async () => {
    prisma.clientOnboarding.findUnique.mockResolvedValue({
      bvn: '11111111111',
      ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
    });
    prisma.loan.findMany.mockResolvedValue([
      { id: 'loan-no-bvn', bvn: null },
      { id: 'loan-match', bvn: '11111111111' },
      { id: 'loan-mismatch', bvn: '99999999999' },
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
    prisma.loan.findMany.mockResolvedValue([{ id: 'loan-1', bvn: '22222222222' }]);
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

    const result = await service.getDashboard('c1');

    expect(result.loans).toEqual([{ id: 'loan-1', bvn: '22222222222' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: FAIL — `Cannot find module './client-loans.service'`.

- [ ] **Step 3: Implement `ClientLoansService`**

`src/client-loans/client-loans.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

@Injectable()
export class ClientLoansService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(clientId: string) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return { loans: [], repayments: [] };
    }

    const { agency, staffId } = onboarding.ippisRecord;

    const candidateLoans = await this.prisma.loan.findMany({
      where: { agency, ippisNumber: staffId },
      select: LOAN_SELECT,
      orderBy: { disbursementDate: 'desc' },
    });

    const loans = candidateLoans.filter((loan) => {
      if (!loan.bvn || !onboarding.bvn) {
        return true;
      }
      return loan.bvn === onboarding.bvn;
    });

    const repayments = await this.prisma.loanRepaymentRecord.findMany({
      where: { agency, staffId },
      select: REPAYMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return { loans, repayments };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Implement the controller and module, wire into `AppModule`**

`src/client-loans/client-loans.controller.ts`:

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientLoansService } from './client-loans.service';

@Controller('client/loans')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoansController {
  constructor(private readonly clientLoansService: ClientLoansService) {}

  @Get()
  getDashboard(@Req() req: { user: JwtPayload }) {
    return this.clientLoansService.getDashboard(req.user.sub);
  }
}
```

`src/client-loans/client-loans.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ClientLoansController } from './client-loans.controller';
import { ClientLoansService } from './client-loans.service';

@Module({
  controllers: [ClientLoansController],
  providers: [ClientLoansService],
})
export class ClientLoansModule {}
```

Modify `src/app.module.ts`: add `import { ClientLoansModule } from './client-loans/client-loans.module';` and add `ClientLoansModule` to the `imports` array (alongside `LoanRequestModule`).

- [ ] **Step 6: Run the full unit suite and type-check**

Run: `npx jest src/client-loans && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Write the e2e test**

`test/client-loans.e2e-spec.ts`:

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

    await prisma.loan.create({
      data: {
        customerId: `${staffId}-CUST`,
        customerName: 'E2E Loans Test',
        accountNumber: '0000000000',
        ippisNumber: staffId,
        agency,
        loanAmount: 500000,
        principalBalance: 400000,
        disbursementDate: new Date('2025-01-01'),
        maturationDate: new Date('2026-01-01'),
        product: 'Salary Advance',
        interestRatePercent: 5,
        bvn: '11111111111',
      },
    });
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

    const tokenService = moduleFixture.get(TokenService);
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.loanRepaymentRecord.deleteMany({ where: { agency, staffId } });
    await prisma.loan.deleteMany({ where: { ippisNumber: staffId } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('returns matched loans, excluding the bvn-mismatched one, plus matched repayments', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loans).toHaveLength(1);
    expect(res.body.loans[0].customerId).toBe(`${staffId}-CUST`);
    expect(res.body.repayments).toHaveLength(1);
    expect(res.body.repayments[0].elementName).toBe('Principal');
  });
});
```

- [ ] **Step 8: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/client-loans.e2e-spec.ts --runInBand`
Expected: PASS — 1 test.

- [ ] **Step 9: Update the README**

Add a new section to `README.md`, after the existing `## Loan requests` section (before `## Client/IPPIS onboarding`):

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
```

- [ ] **Step 10: Add Postman coverage**

In `postman/public-sector-backend.postman_collection.json`, under the top-level **Client** folder, add a new sub-folder `"Loans"` (alongside `Auth`/`Session`/`Onboarding`/`Loan Requests`), using a surgical text insert (not a full JSON re-parse/re-dump, per this file's established editing practice):

```json
{
  "name": "Loans",
  "item": [
    {
      "name": "GET /client/loans - Success",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{client_access_token}}" }],
        "url": { "raw": "{{base_url}}/client/loans", "host": ["{{base_url}}"], "path": ["client", "loans"] }
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "exec": [
              "pm.test('status 200', () => pm.response.to.have.status(200));",
              "pm.test('has loans and repayments arrays', () => {",
              "  const body = pm.response.json();",
              "  pm.expect(body.loans).to.be.an('array');",
              "  pm.expect(body.repayments).to.be.an('array');",
              "});"
            ]
          }
        }
      ]
    }
  ]
}
```

- [ ] **Step 11: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 12: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including the new ones from this plan. (Use `--runInBand` for the e2e run — this codebase's default parallel e2e run has known pre-existing environmental flakiness from concurrent Nest app bootstraps unrelated to any single feature; serialized is the reliable signal.)

- [ ] **Step 13: Commit**

```bash
git add src/client-loans src/app.module.ts test/client-loans.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add client loan dashboard/history endpoint"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state.
- [ ] A client with a linked `IppisRecord` sees their matched `Loan`/`LoanRepaymentRecord` rows via `GET /client/loans` — proven by the e2e test.
- [ ] A `Loan` row whose `bvn` mismatches the client's own verified `bvn` is excluded — proven by both the unit tests and the e2e test.
- [ ] A `Loan` row is never excluded just because one side lacks a `bvn` to compare — proven by the unit tests.
- [ ] A client with no `ClientOnboarding` row gets `{ loans: [], repayments: [] }`, not an error — proven by the unit tests.
- [ ] Postman has coverage for the new endpoint under `Client > Loans`.
