# Admin Client Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin see everything scoped to a single client — their loan requests, their loan history, and a merged activity timeline — via three additions to existing admin controllers.

**Architecture:** A `clientId` query filter on the existing loan-requests list (no new permission — it's an addition to an already-gated endpoint). A new client-scoped list method on the existing `AdminClientLoansController`. A new `AdminClientActivityService`, living alongside the existing `AdminClientReviewService` (same module), that merges five read-only Prisma queries into one sorted timeline, exposed via a new endpoint on `AdminClientReviewController`.

**Tech Stack:** NestJS 10, Prisma 7, Jest, class-validator.

**Spec:** `docs/superpowers/specs/2026-09-22-admin-client-visibility-design.md`

## Global Constraints

- `GET /admin/loan-requests`'s existing `loan-requests:review` permission is **unchanged** by adding the `clientId` filter — the spec's "both endpoints require `clients:read`" line refers to the two genuinely *new* endpoints in this plan (client-loans list, activities), not this pre-existing one, which already had its own gate before this plan touched it (spec §2-3, clarified here).
- `GET /admin/client-loans?clientId=` requires `clientId` — `400` if missing, not an optional filter (spec §3).
- The activity timeline merges: `AuditLog` (`targetType: 'Client'`, direct) + `AuditLog` (`targetType: 'LoanRequest'`, resolved via this client's `LoanRequest` ids) + `LoanRequest` creation/confirmation timestamps + `Session` logins + `WalletEntry` rows with `actorType: CLIENT` + one `ClientOnboarding` current-state entry — sorted by timestamp descending (spec §4).
- No new persisted table for activities — everything is derived at query time (spec §1).
- No new document/signed-URL handling — out of scope, already covered by the existing `GET /admin/documents/files/:key` (spec §1).
- New `clients:read` permission added to `BOOTSTRAP_PERMISSIONS` (spec §2).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the API-surface changes, with a saved response example per request.
- Per this session's standing testing preference: run only the test file(s) relevant to what changed in each task. This spec is a standalone, single-plan initiative (not part of a multi-plan phase like the just-shipped Loan Lifecycle Overhaul) — so, per that same preference, a genuine full-suite run happens once, at this plan's own final task, since this plan *is* the whole initiative.

---

### Task 1: Permission

**Files:**
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: `clients:read` permission key — Tasks 3 and 4's new endpoints consume this.

- [ ] **Step 1: Add the permission key**

In `prisma/seed.ts`, add to `BOOTSTRAP_PERMISSIONS` (after the `client-loans:read` entry):

```typescript
  { key: 'clients:read', description: "View a client's loan requests, loans, and activity history" },
```

- [ ] **Step 2: Apply the new permission**

Run: `npx prisma db seed`
Expected: completes without error.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat: add clients:read permission"
```

---

### Task 2: `clientId` filter on `GET /admin/loan-requests`

**Files:**
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`
- Modify: `src/loan-request/admin-loan-request.controller.ts`

**Interfaces:**
- Produces: `LoanRequestService.listAll(status?: LoanRequestStatus, type?: LoanRequestType, clientId?: string)` (extended signature).

- [ ] **Step 1: Write the failing test**

Read `src/loan-request/loan-request.service.spec.ts`'s current `describe('listAll with a type filter', ...)` block first (added in the Topup plan — currently one test, `'filters by type when provided'`). Add a new test to that same block:

```typescript
    it('filters by clientId when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      await service.listAll(undefined, undefined, 'client-1');
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith({
        where: { status: undefined, type: undefined, clientId: 'client-1' },
        orderBy: { createdAt: 'desc' },
      });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `service.listAll` doesn't yet accept a 3rd argument, or the assertion's `where` shape doesn't match (`clientId` missing from the actual call).

- [ ] **Step 3: Implement the filter**

In `src/loan-request/loan-request.service.ts`, change `listAll`:

```typescript
  async listAll(status?: LoanRequestStatus, type?: LoanRequestType, clientId?: string) {
    return this.prisma.loanRequest.findMany({ where: { status, type, clientId }, orderBy: { createdAt: 'desc' } });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — recount the literal `it(` blocks in the full file to confirm the total, rather than trusting a specific stated number (this task added 1 new test on top of whatever count the prior plan left the file at). The pre-existing `'filters by type when provided'` test must still pass unchanged — Jest's `toHaveBeenCalledWith` treats an object with an extra `undefined`-valued key (`clientId: undefined`, now always present in the real call) as equal to one without that key, so its existing `{ where: { status: undefined, type: 'TOPUP' }, ... }` assertion still matches.

- [ ] **Step 5: Update the controller**

In `src/loan-request/admin-loan-request.controller.ts`, change `list`:

```typescript
  @Get()
  list(@Query('status') status?: LoanRequestStatus, @Query('type') type?: LoanRequestType, @Query('clientId') clientId?: string) {
    return this.loanRequestService.listAll(status, type, clientId);
  }
```

No permission change — this method keeps the controller's existing class-level `@RequirePermissions('loan-requests:review')` unchanged (see this plan's Global Constraints).

- [ ] **Step 6: Type-check and run the loan-request unit suite**

Run: `npx tsc --noEmit && npx jest src/loan-request`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts src/loan-request/admin-loan-request.controller.ts
git commit -m "feat: add clientId filter to GET /admin/loan-requests"
```

---

### Task 3: `GET /admin/client-loans?clientId=`

**Files:**
- Create: `src/loan-request/dto/list-client-loans-query.dto.ts`
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`
- Modify: `src/loan-request/admin-client-loans.controller.ts`

**Interfaces:**
- Consumes: `clients:read` (Task 1).
- Produces: `LoanRequestService.listByClient(clientId: string): Promise<ClientLoan[]>` — Task 3's own controller method consumes this.

- [ ] **Step 1: Write the failing test**

Append to `src/loan-request/loan-request.service.spec.ts`, after the `describe('listAll with a type filter', ...)` block:

```typescript
  describe('listByClient', () => {
    it('lists a client\'s ClientLoan rows ordered by disbursementDate descending', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([{ id: 'cl1' }]);
      const result = await service.listByClient('client-1');
      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        orderBy: { disbursementDate: 'desc' },
      });
      expect(result).toEqual([{ id: 'cl1' }]);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — `service.listByClient is not a function`.

- [ ] **Step 3: Implement `listByClient`**

Add this method to `src/loan-request/loan-request.service.ts`, after `listAll`:

```typescript
  async listByClient(clientId: string) {
    return this.prisma.clientLoan.findMany({ where: { clientId }, orderBy: { disbursementDate: 'desc' } });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the query DTO**

`src/loan-request/dto/list-client-loans-query.dto.ts`:

```typescript
import { IsNotEmpty, IsString } from 'class-validator';

export class ListClientLoansQueryDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;
}
```

- [ ] **Step 6: Add the controller endpoint**

In `src/loan-request/admin-client-loans.controller.ts`, add the import `import { ListClientLoansQueryDto } from './dto/list-client-loans-query.dto';`, add `RequirePermissions` to the existing `../auth/permissions.decorator` import if not already present (it already is, from the class-level decorator), and add this method:

```typescript
  @Get()
  @RequirePermissions('clients:read')
  list(@Query() query: ListClientLoansQueryDto) {
    return this.loanRequestService.listByClient(query.clientId);
  }
```

This method-level `@RequirePermissions('clients:read')` overrides the controller's class-level `@RequirePermissions('client-loans:read')` for this one handler only (NestJS's `Reflector.getAllAndOverride`, used by the existing `PermissionsGuard`, prefers a handler-level value over the class-level one) — the other methods on this controller (`disbursement-summary`, and Task 4's sibling if any) keep `client-loans:read` unaffected.

- [ ] **Step 7: Type-check and run the loan-request unit suite**

Run: `npx tsc --noEmit && npx jest src/loan-request`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/loan-request/dto/list-client-loans-query.dto.ts src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts src/loan-request/admin-client-loans.controller.ts
git commit -m "feat: add GET /admin/client-loans list endpoint scoped by clientId"
```

---

### Task 4: Activities — merged timeline

**Files:**
- Create: `src/admin-client-review/admin-client-activity.service.ts`
- Test: `src/admin-client-review/admin-client-activity.service.spec.ts`
- Modify: `src/admin-client-review/admin-client-review.controller.ts`
- Modify: `src/admin-client-review/admin-client-review.module.ts`

**Interfaces:**
- Produces: `interface ActivityEntry { timestamp: Date; type: string; description: string; source: 'AUDIT_LOG' | 'LOAN_REQUEST' | 'SESSION' | 'WALLET' | 'ONBOARDING' }`, `AdminClientActivityService.listActivities(clientId: string): Promise<ActivityEntry[]>` — Task 4's own controller method consumes this.

- [ ] **Step 1: Write the failing tests**

`src/admin-client-review/admin-client-activity.service.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { AdminClientActivityService } from './admin-client-activity.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminClientActivityService', () => {
  let service: AdminClientActivityService;
  let prisma: {
    client: { findUnique: jest.Mock };
    loanRequest: { findMany: jest.Mock };
    auditLog: { findMany: jest.Mock };
    session: { findMany: jest.Mock };
    walletEntry: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      client: { findUnique: jest.fn() },
      loanRequest: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
      session: { findMany: jest.fn().mockResolvedValue([]) },
      walletEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new AdminClientActivityService(prisma as unknown as PrismaService);
  });

  it('throws NotFoundException when the client does not exist', async () => {
    prisma.client.findUnique.mockResolvedValue(null);
    await expect(service.listActivities('missing')).rejects.toThrow(NotFoundException);
  });

  it('returns an empty array when the client has no activity anywhere', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    const result = await service.listActivities('c1');
    expect(result).toEqual([]);
  });

  it('does not query LoanRequest-scoped audit logs when the client has no loan requests', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([]);
    await service.listActivities('c1');
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { targetType: 'Client', targetId: 'c1' },
    });
  });

  it('merges every source and sorts the result by timestamp descending', async () => {
    prisma.client.findUnique.mockResolvedValue({
      id: 'c1',
      onboarding: { step: 'COMPLETED', updatedAt: new Date('2026-01-05T00:00:00.000Z') },
    });
    prisma.loanRequest.findMany.mockResolvedValue([
      {
        id: 'lr1',
        amount: 50000,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        confirmedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([
        { action: 'client.review.approved', createdAt: new Date('2026-01-03T00:00:00.000Z') },
      ])
      .mockResolvedValueOnce([
        { action: 'loan-request.approve', createdAt: new Date('2026-01-04T00:00:00.000Z') },
      ]);
    prisma.session.findMany.mockResolvedValue([{ createdAt: new Date('2026-01-06T00:00:00.000Z') }]);
    prisma.walletEntry.findMany.mockResolvedValue([
      {
        direction: 'DEBIT',
        description: 'Applied toward loan #cl1',
        createdAt: new Date('2026-01-07T00:00:00.000Z'),
      },
    ]);

    const result = await service.listActivities('c1');

    expect(prisma.auditLog.findMany).toHaveBeenNthCalledWith(2, {
      where: { targetType: 'LoanRequest', targetId: { in: ['lr1'] } },
    });
    expect(prisma.session.findMany).toHaveBeenCalledWith({
      where: { principalType: 'CLIENT', principalId: 'c1' },
    });
    expect(prisma.walletEntry.findMany).toHaveBeenCalledWith({
      where: { clientId: 'c1', actorType: 'CLIENT' },
    });
    // 7 entries total: 1 client-targeted audit log + 1 loan-request-targeted audit log + 2 loan
    // request entries (created + confirmed) + 1 session + 1 wallet entry + 1 onboarding snapshot.
    expect(result).toHaveLength(7);
    expect(result.map((entry) => entry.timestamp.toISOString())).toEqual([
      '2026-01-07T00:00:00.000Z',
      '2026-01-06T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    expect(result[result.length - 1]).toEqual(
      expect.objectContaining({ type: 'loan-request.created', source: 'LOAN_REQUEST' }),
    );
  });

  it('only synthesizes a loan-request.confirmed entry when confirmedAt is set', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([
      { id: 'lr1', amount: 50000, createdAt: new Date('2026-01-01T00:00:00.000Z'), confirmedAt: null },
    ]);

    const result = await service.listActivities('c1');

    expect(result.filter((entry) => entry.source === 'LOAN_REQUEST')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/admin-client-review/admin-client-activity.service.spec.ts`
Expected: FAIL — `Cannot find module './admin-client-activity.service'`.

- [ ] **Step 3: Implement `AdminClientActivityService`**

`src/admin-client-review/admin-client-activity.service.ts`:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, SessionPrincipalType } from '../generated/prisma/client';

export interface ActivityEntry {
  timestamp: Date;
  type: string;
  description: string;
  source: 'AUDIT_LOG' | 'LOAN_REQUEST' | 'SESSION' | 'WALLET' | 'ONBOARDING';
}

@Injectable()
export class AdminClientActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async listActivities(clientId: string): Promise<ActivityEntry[]> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      include: { onboarding: true },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const loanRequests = await this.prisma.loanRequest.findMany({ where: { clientId } });
    const loanRequestIds = loanRequests.map((loanRequest) => loanRequest.id);

    const clientAuditLogs = await this.prisma.auditLog.findMany({
      where: { targetType: 'Client', targetId: clientId },
    });
    const loanRequestAuditLogs =
      loanRequestIds.length > 0
        ? await this.prisma.auditLog.findMany({
            where: { targetType: 'LoanRequest', targetId: { in: loanRequestIds } },
          })
        : [];
    const sessions = await this.prisma.session.findMany({
      where: { principalType: SessionPrincipalType.CLIENT, principalId: clientId },
    });
    const walletEntries = await this.prisma.walletEntry.findMany({
      where: { clientId, actorType: AuditActorType.CLIENT },
    });

    const entries: ActivityEntry[] = [];

    for (const log of [...clientAuditLogs, ...loanRequestAuditLogs]) {
      entries.push({ timestamp: log.createdAt, type: log.action, description: log.action, source: 'AUDIT_LOG' });
    }

    for (const loanRequest of loanRequests) {
      entries.push({
        timestamp: loanRequest.createdAt,
        type: 'loan-request.created',
        description: `Loan request submitted for ₦${loanRequest.amount}`,
        source: 'LOAN_REQUEST',
      });
      if (loanRequest.confirmedAt) {
        entries.push({
          timestamp: loanRequest.confirmedAt,
          type: 'loan-request.confirmed',
          description: 'Loan request confirmed via SMS',
          source: 'LOAN_REQUEST',
        });
      }
    }

    for (const session of sessions) {
      entries.push({
        timestamp: session.createdAt,
        type: 'session.created',
        description: 'Client logged in',
        source: 'SESSION',
      });
    }

    for (const walletEntry of walletEntries) {
      entries.push({
        timestamp: walletEntry.createdAt,
        type: `wallet.${walletEntry.direction.toLowerCase()}`,
        description: walletEntry.description,
        source: 'WALLET',
      });
    }

    if (client.onboarding) {
      entries.push({
        timestamp: client.onboarding.updatedAt,
        type: 'onboarding.step',
        description: `Onboarding step: ${client.onboarding.step}`,
        source: 'ONBOARDING',
      });
    }

    return entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-activity.service.spec.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add the controller endpoint**

In `src/admin-client-review/admin-client-review.controller.ts`, add `import { AdminClientActivityService } from './admin-client-activity.service';`, inject it into the constructor, and add this method:

```typescript
  constructor(
    private readonly adminClientReviewService: AdminClientReviewService,
    private readonly auditLogService: AuditLogService,
    private readonly adminClientActivityService: AdminClientActivityService,
  ) {}
```

```typescript
  @Get(':id/activities')
  @RequirePermissions('clients:read')
  getActivities(@Param('id') id: string) {
    return this.adminClientActivityService.listActivities(id);
  }
```

(Placed after `findOne`, before `approve` — the method-level `@RequirePermissions('clients:read')` overrides the class... wait, this controller has no class-level `@RequirePermissions`, only per-method ones, so this addition is additive and doesn't affect any other method.)

- [ ] **Step 6: Wire the new provider into `AdminClientReviewModule`**

In `src/admin-client-review/admin-client-review.module.ts`, add `AdminClientActivityService` to `providers`.

- [ ] **Step 7: Type-check and run the admin-client-review unit suite**

Run: `npx tsc --noEmit && npx jest src/admin-client-review`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/admin-client-review/admin-client-activity.service.ts src/admin-client-review/admin-client-activity.service.spec.ts src/admin-client-review/admin-client-review.controller.ts src/admin-client-review/admin-client-review.module.ts
git commit -m "feat: add GET /admin/clients/:id/activities merged timeline"
```

---

### Task 5: e2e tests, README, Postman, and the full suite run

**Files:**
- Create: `test/admin-client-visibility.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

This is the last task of this plan's own single-spec initiative (not part of a larger multi-plan phase) — per this plan's Global Constraints, Step 8 below is a genuine full-suite run, the one point in this plan where that's appropriate.

- [ ] **Step 1: Write the e2e test**

Read `test/admin-client-review.e2e-spec.ts` and `test/loan-topup.e2e-spec.ts` first for the admin-login/client-fixture patterns this combines. `test/admin-client-visibility.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Admin client visibility (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-VISIBILITY-${Date.now()}`;
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
    await prisma.walletEntry.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Visibility Test' } } } });
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Visibility Test' } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: 'E2E Visibility Test' } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234808' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 2 } });
    await app.close();
  });

  it(
    'lists a client\'s loan requests and loans scoped by clientId, excluding other clients, and returns a merged activity timeline',
    async () => {
      const phoneA = '+2348080000001';
      const clientA = await prisma.client.create({ data: { phone: phoneA, status: 'VERIFIED' } });
      const ippisA = await prisma.ippisRecord.create({
        data: { agency, staffId: `${staffId}-A`, employeeName: 'E2E Visibility Test', salary: 5000000 },
      });
      await prisma.clientOnboarding.create({
        data: {
          clientId: clientA.id,
          ippisRecordId: ippisA.id,
          employeeName: 'E2E Visibility Test',
          agency,
          step: 'COMPLETED',
        },
      });
      const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
      const accessTokenA = tokenService.signAccessToken({ sub: clientA.id, type: 'client' });

      const phoneB = '+2348080000002';
      const clientB = await prisma.client.create({ data: { phone: phoneB, status: 'VERIFIED' } });
      const ippisB = await prisma.ippisRecord.create({
        data: { agency, staffId: `${staffId}-B`, employeeName: 'E2E Visibility Test', salary: 5000000 },
      });
      await prisma.clientOnboarding.create({
        data: {
          clientId: clientB.id,
          ippisRecordId: ippisB.id,
          employeeName: 'E2E Visibility Test',
          agency,
          step: 'COMPLETED',
        },
      });
      const accessTokenB = tokenService.signAccessToken({ sub: clientB.id, type: 'client' });

      const createResA = await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessTokenA}`)
        .send({ amount: 90000, tenorMonths: 2 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/webhooks/sms/inbound')
        .send({ phone: phoneA, message: 'YES' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${createResA.body.id}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${createResA.body.id}/disburse`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessTokenB}`)
        .send({ amount: 50000, tenorMonths: 2 })
        .expect(201);

      const loanRequestsRes = await request(app.getHttpServer())
        .get(`/admin/loan-requests?clientId=${clientA.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(loanRequestsRes.body).toHaveLength(1);
      expect(loanRequestsRes.body[0].clientId).toBe(clientA.id);

      const loansRes = await request(app.getHttpServer())
        .get(`/admin/client-loans?clientId=${clientA.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(loansRes.body).toHaveLength(1);
      expect(loansRes.body[0].clientId).toBe(clientA.id);

      await request(app.getHttpServer())
        .get('/admin/client-loans')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(400);

      const activitiesRes = await request(app.getHttpServer())
        .get(`/admin/clients/${clientA.id}/activities`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      const types = activitiesRes.body.map((entry: { type: string }) => entry.type);
      expect(types).toContain('loan-request.created');
      expect(types).toContain('loan-request.confirmed');
      expect(types).toContain('loan-request.approve');
      expect(types).toContain('loan-request.disburse');
      expect(types).toContain('onboarding.step');
      const timestamps = activitiesRes.body.map((entry: { timestamp: string }) => new Date(entry.timestamp).getTime());
      const sorted = [...timestamps].sort((a, b) => b - a);
      expect(timestamps).toEqual(sorted);

      await request(app.getHttpServer())
        .get('/admin/clients/00000000-0000-0000-0000-000000000000/activities')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(404);
    },
    30000,
  );
});
```

- [ ] **Step 2: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-client-visibility.e2e-spec.ts --runInBand`
Expected: PASS — 1 test.

- [ ] **Step 3: Update the README**

In `README.md`, find the `GET /admin/loan-requests` documentation (in the loan-origination-era section) and note the new `clientId` filter; find the `## Client loan dashboard` or admin client review area and add a new subsection:

```markdown
## Admin client visibility

`GET /admin/loan-requests` accepts an optional `clientId` filter alongside
`status`/`type`. `GET /admin/client-loans?clientId=` (`clients:read`,
required `clientId` — `400` if missing) lists a client's `ClientLoan`
history. `GET /admin/clients/:id/activities` (`clients:read`) returns a
merged, timestamp-descending timeline for one client: admin actions on
them or their loan requests (from the audit log), their own loan-request
creation/confirmation, logins, `CLIENT`-actor wallet applications, and
their current onboarding step — all derived at query time from existing
records, not a separately tracked feed.
```

- [ ] **Step 4: Add Postman coverage**

Update the existing `GET /admin/loan-requests` request/example to show the `clientId` filter; add new requests for `GET /admin/client-loans?clientId=` (success, missing-`clientId` `400`) and `GET /admin/clients/:id/activities` (success, `404`) — each with a saved response example authored from the actual code. Use a surgical text-based/jq-based insert, not a full rewrite (watch `ensure_ascii` if using Python's `json` module).

- [ ] **Step 5: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 6: Commit**

```bash
git add test/admin-client-visibility.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add admin client visibility e2e coverage and docs"
```

- [ ] **Step 7: Run the full suite**

This is the one point in this plan where a genuine full run is appropriate, per this session's standing testing preference — this plan is a standalone, single-plan initiative, so its own final task closes it out the same way a phase's last plan would.

Run: `npm run test`
Expected: PASS — every unit suite in the codebase.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run just that suite in isolation to confirm it's pre-existing environmental flakiness (observed and confirmed benign multiple times in this codebase already) rather than a real regression, and report that distinction clearly.

## Exit criteria

- [ ] Step 7's full unit + e2e suite run passes clean.
- [ ] `GET /admin/loan-requests?clientId=` returns only that client's requests, with its existing `loan-requests:review` permission unchanged.
- [ ] `GET /admin/client-loans?clientId=` returns only that client's loans, `400` if `clientId` is omitted.
- [ ] `GET /admin/clients/:id/activities` returns a correctly merged, timestamp-descending timeline from all five sources, `404` for a nonexistent client.
- [ ] Postman has coverage for all three endpoint changes.
