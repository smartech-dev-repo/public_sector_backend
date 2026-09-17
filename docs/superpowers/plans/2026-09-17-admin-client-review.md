# Admin Manual-Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins holding `clients:review` a way to list, inspect, approve, or retry clients stuck at `Client.status = MANUAL_REVIEW`, and fix `ClientOnboardingService.linkIppis` so it actually sets `Client.status = PENDING_IPPIS` (currently left unset — a gap discovered while designing this feature).

**Architecture:** Three review fields added to the existing `ClientOnboarding` model (no new model). A new `AdminClientReviewService`/`AdminClientReviewController` (flat-per-feature module, matching `admin-invite`/`admin-rbac`) sits alongside the already-shipped `ClientOnboardingService` without modifying its pipeline logic — except the one-line `PENDING_IPPIS` fix.

**Tech Stack:** NestJS 10, Prisma 7, Jest — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-17-admin-client-review-design.md`

## Global Constraints

- No new `ClientStatus` value — review outcomes are `approve` (→ `VERIFIED`) or `retry` (→ back to an earlier step, `PENDING_IPPIS`), never a permanent rejection (spec §1).
- Retry step is auto-inferred from `ClientOnboarding.failureReasons` (`{identityVerified, faceMatchPassed}`), never chosen by the admin (spec §5): `identityVerified === false` → reset to `IPPIS_LINKED` and clear all identity+face fields; otherwise (only `faceMatchPassed === false`) → reset to `IDENTITY_SUBMITTED` and clear only the face-match fields.
- `approve`/`retry` are only valid when `Client.status === MANUAL_REVIEW`; otherwise `409`.
- `retry` requires a non-empty `note` (`400` if missing) — matches this repo's existing "required reason" precedent.
- Selfie images are fetched via the existing generic `GET /admin/documents/files/:key` endpoint (gated by `documents:read`, not `clients:review` — a role assignment note, not something this plan changes).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints (Task 4).

---

### Task 1: Add review fields to `ClientOnboarding`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `ClientOnboarding.reviewedBy`/`.reviewedAt`/`.reviewNote` — Task 3 depends on these exact field names.

- [ ] **Step 1: Add the fields**

In `prisma/schema.prisma`, inside the existing `ClientOnboarding` model, add three lines right after `failureReasons Json?`:

```prisma
  reviewedBy String?
  reviewedAt DateTime?
  reviewNote String?
```

- [ ] **Step 2: Generate and run the migration**

Run: `npx prisma migrate dev --name add_client_review_fields`
Expected: creates and applies `prisma/migrations/<timestamp>_add_client_review_fields/migration.sql`.

- [ ] **Step 3: Explicitly regenerate the Prisma client**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client`.

- [ ] **Step 4: Verify the client regenerated correctly**

Run: `grep -n "reviewedBy" src/generated/prisma/models/ClientOnboarding.ts`
Expected: a line referencing `reviewedBy` appears. (Note: per a prior task's experience in this codebase, Prisma 7 re-exports enums via a wildcard in `client.ts`, so grep the per-model file under `src/generated/prisma/models/`, not `client.ts`, for field-level checks.)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add review fields to ClientOnboarding"
```

---

### Task 2: Fix `linkIppis` to set `Client.status = PENDING_IPPIS`

**Files:**
- Modify: `src/client-onboarding/client-onboarding.service.ts`
- Modify: `src/client-onboarding/client-onboarding.service.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no interface change — `linkIppis`'s signature and return type are unchanged; only its side effect changes (it now also updates `Client.status`).

- [ ] **Step 1: Write the failing test**

In `src/client-onboarding/client-onboarding.service.spec.ts`, add a new test inside the existing `describe('linkIppis', ...)` block, after the `'creates a ClientOnboarding row pulling the matched IppisRecord fields'` test:

```typescript
    it('sets Client.status to PENDING_IPPIS once linked', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
      });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.linkIppis('client-1', 'NPF/1');

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'PENDING_IPPIS' },
      });
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts -t "PENDING_IPPIS"`
Expected: FAIL — `prisma.client.update` was never called (the current `linkIppis` implementation doesn't touch `Client` at all).

- [ ] **Step 3: Fix `linkIppis`**

In `src/client-onboarding/client-onboarding.service.ts`, replace the `linkIppis` method's final `return` statement:

```typescript
  async linkIppis(clientId: string, ippisNumber: string) {
    const existing = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    if (existing) {
      throw new ConflictException('Onboarding already started for this client');
    }

    const ippisRecord = await this.prisma.ippisRecord.findFirst({
      where: { staffId: { equals: ippisNumber, mode: 'insensitive' } },
    });
    if (!ippisRecord) {
      throw new NotFoundException('IPPIS number not found');
    }

    const alreadyLinked = await this.prisma.clientOnboarding.findUnique({
      where: { ippisRecordId: ippisRecord.id },
    });
    if (alreadyLinked) {
      throw new ConflictException('This IPPIS record is already linked to another client');
    }

    const onboarding = await this.prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: ippisRecord.employeeName,
        agency: ippisRecord.agency,
        bankName: ippisRecord.bankName,
        accountNumber: ippisRecord.accountNumber,
        step: OnboardingStep.IPPIS_LINKED,
      },
    });

    await this.prisma.client.update({
      where: { id: clientId },
      data: { status: ClientStatus.PENDING_IPPIS },
    });

    return onboarding;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/client-onboarding/client-onboarding.service.spec.ts`
Expected: PASS — 12 tests (the existing 11 plus the new one).

- [ ] **Step 5: Run the client-onboarding e2e test to confirm nothing broke**

Run: `npx jest --config ./test/jest-e2e.json test/client-onboarding.e2e-spec.ts --runInBand`
Expected: PASS — 3 tests (the e2e test only asserts `res.body.step`, not `Client.status`, at the `ippis-link` stage, so this fix doesn't change any existing assertion).

- [ ] **Step 6: Commit**

```bash
git add src/client-onboarding/client-onboarding.service.ts src/client-onboarding/client-onboarding.service.spec.ts
git commit -m "fix: set Client.status to PENDING_IPPIS once IPPIS linking succeeds"
```

---

### Task 3: `AdminClientReviewService`

**Files:**
- Create: `src/admin-client-review/admin-client-review.service.ts`
- Test: `src/admin-client-review/admin-client-review.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces: `AdminClientReviewService.list(status?: ClientStatus)`, `.findById(id): Promise<Client & {onboarding: ClientOnboarding | null}>` (throws `NotFoundException`), `.approve(id, adminId): Promise<Client>` (throws `ConflictException` if not `MANUAL_REVIEW`), `.retry(id, adminId, note): Promise<Client>` (throws `ConflictException` if not `MANUAL_REVIEW` or if no onboarding row exists) — Task 4's controller consumes all four.

- [ ] **Step 1: Write the failing tests**

`src/admin-client-review/admin-client-review.service.spec.ts`:

```typescript
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminClientReviewService } from './admin-client-review.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminClientReviewService', () => {
  let service: AdminClientReviewService;
  let prisma: {
    client: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    clientOnboarding: { update: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      client: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      clientOnboarding: { update: jest.fn() },
    };
    service = new AdminClientReviewService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('lists all clients with their onboarding record when no status filter is given', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      await service.list();
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined, include: { onboarding: true } }),
      );
    });

    it('filters by status when given', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      await service.list('MANUAL_REVIEW' as never);
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'MANUAL_REVIEW' } }),
      );
    });
  });

  describe('findById', () => {
    it('throws NotFoundException for an unknown id', async () => {
      prisma.client.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the client with its onboarding record', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'MANUAL_REVIEW', onboarding: { id: 'o1' } });
      const result = await service.findById('c1');
      expect(result.id).toBe('c1');
    });
  });

  describe('approve', () => {
    it('rejects when the client is not in MANUAL_REVIEW', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'VERIFIED', onboarding: { id: 'o1' } });
      await expect(service.approve('c1', 'admin-1')).rejects.toThrow(ConflictException);
    });

    it('marks the onboarding COMPLETED, records the reviewer, and sets Client VERIFIED', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'MANUAL_REVIEW', onboarding: { id: 'o1' } });
      prisma.client.update.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });

      await service.approve('c1', 'admin-1');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        data: expect.objectContaining({ step: 'COMPLETED', reviewedBy: 'admin-1' }),
      });
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'VERIFIED' },
      });
    });
  });

  describe('retry', () => {
    it('rejects when the client is not in MANUAL_REVIEW', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'PENDING_IPPIS', onboarding: { id: 'o1' } });
      await expect(service.retry('c1', 'admin-1', 'please retry')).rejects.toThrow(ConflictException);
    });

    it('rejects when the client has no onboarding record', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'MANUAL_REVIEW', onboarding: null });
      await expect(service.retry('c1', 'admin-1', 'please retry')).rejects.toThrow(ConflictException);
    });

    it('resets to IPPIS_LINKED and clears identity+face fields when identity verification failed', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', failureReasons: { identityVerified: false, faceMatchPassed: false } },
      });
      prisma.client.update.mockResolvedValue({ id: 'c1', status: 'PENDING_IPPIS' });

      await service.retry('c1', 'admin-1', 'bad bvn, please resubmit');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        data: expect.objectContaining({
          step: 'IPPIS_LINKED',
          bvn: null,
          nin: null,
          bvnSelfie: null,
          ninSelfie: null,
          identityVerified: null,
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
          failureReasons: null,
          reviewedBy: 'admin-1',
          reviewNote: 'bad bvn, please resubmit',
        }),
      });
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'PENDING_IPPIS' },
      });
    });

    it('resets to IDENTITY_SUBMITTED and only clears face-match fields when only the face match failed', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', failureReasons: { identityVerified: true, faceMatchPassed: false } },
      });
      prisma.client.update.mockResolvedValue({ id: 'c1', status: 'PENDING_IPPIS' });

      await service.retry('c1', 'admin-1', 'blurry selfie, please retake');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        data: expect.objectContaining({
          step: 'IDENTITY_SUBMITTED',
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
          failureReasons: null,
        }),
      });
      expect(prisma.clientOnboarding.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ bvn: null }) }),
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: FAIL — `Cannot find module './admin-client-review.service'`

- [ ] **Step 3: Implement `AdminClientReviewService`**

`src/admin-client-review/admin-client-review.service.ts`:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientStatus, OnboardingStep } from '../generated/prisma/client';

interface FailureReasons {
  identityVerified?: boolean;
  faceMatchPassed?: boolean;
}

@Injectable()
export class AdminClientReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async list(status?: ClientStatus) {
    return this.prisma.client.findMany({
      where: status ? { status } : undefined,
      include: { onboarding: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { onboarding: true },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }
    return client;
  }

  async approve(id: string, adminId: string) {
    const client = await this.findById(id);
    if (client.status !== ClientStatus.MANUAL_REVIEW) {
      throw new ConflictException(`Client is not in MANUAL_REVIEW (currently ${client.status})`);
    }

    await this.prisma.clientOnboarding.update({
      where: { clientId: id },
      data: {
        step: OnboardingStep.COMPLETED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });

    return this.prisma.client.update({
      where: { id },
      data: { status: ClientStatus.VERIFIED },
    });
  }

  async retry(id: string, adminId: string, note: string) {
    const client = await this.findById(id);
    if (client.status !== ClientStatus.MANUAL_REVIEW) {
      throw new ConflictException(`Client is not in MANUAL_REVIEW (currently ${client.status})`);
    }
    if (!client.onboarding) {
      throw new ConflictException('Client has no onboarding record to retry');
    }

    const failureReasons = client.onboarding.failureReasons as FailureReasons | null;
    const identityFailed = failureReasons?.identityVerified === false;

    const resetData = identityFailed
      ? {
          step: OnboardingStep.IPPIS_LINKED,
          bvn: null,
          nin: null,
          bvnSelfie: null,
          ninSelfie: null,
          identityVerified: null,
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
        }
      : {
          step: OnboardingStep.IDENTITY_SUBMITTED,
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
        };

    await this.prisma.clientOnboarding.update({
      where: { clientId: id },
      data: {
        ...resetData,
        failureReasons: null,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        reviewNote: note,
      },
    });

    return this.prisma.client.update({
      where: { id },
      data: { status: ClientStatus.PENDING_IPPIS },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts
git commit -m "feat: add AdminClientReviewService"
```

---

### Task 4: Controller, module wiring, e2e test, README, and Postman

**Files:**
- Create: `src/admin-client-review/dto/retry-review.dto.ts`
- Create: `src/admin-client-review/admin-client-review.controller.ts`
- Create: `src/admin-client-review/admin-client-review.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/admin-client-review.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`
- Modify: `postman/README.md`

**Interfaces:**
- Consumes: `AdminClientReviewService` (Task 3).
- Produces: `GET /admin/clients`, `GET /admin/clients/:id`, `POST /admin/clients/:id/approve`, `POST /admin/clients/:id/retry`.

- [ ] **Step 1: Add the DTO**

`src/admin-client-review/dto/retry-review.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class RetryReviewDto {
  @IsString()
  @MinLength(1)
  note: string;
}
```

- [ ] **Step 2: Implement the controller**

`src/admin-client-review/admin-client-review.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminClientReviewService } from './admin-client-review.service';
import { RetryReviewDto } from './dto/retry-review.dto';
import { AuditActorType, ClientStatus } from '../generated/prisma/client';

@Controller('admin/clients')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminClientReviewController {
  constructor(
    private readonly adminClientReviewService: AdminClientReviewService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions('clients:review')
  list(@Query('status') status?: ClientStatus) {
    return this.adminClientReviewService.list(status);
  }

  @Get(':id')
  @RequirePermissions('clients:review')
  findOne(@Param('id') id: string) {
    return this.adminClientReviewService.findById(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('clients:review')
  async approve(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const client = await this.adminClientReviewService.approve(id, req.user.sub);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'client.review.approved',
      targetType: 'Client',
      targetId: id,
    });
    return client;
  }

  @Post(':id/retry')
  @HttpCode(200)
  @RequirePermissions('clients:review')
  async retry(@Param('id') id: string, @Body() dto: RetryReviewDto, @Req() req: { user: JwtPayload }) {
    const client = await this.adminClientReviewService.retry(id, req.user.sub, dto.note);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'client.review.retried',
      targetType: 'Client',
      targetId: id,
      metadata: { note: dto.note },
    });
    return client;
  }
}
```

- [ ] **Step 3: Implement the module and wire it into `AppModule`**

`src/admin-client-review/admin-client-review.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminClientReviewService } from './admin-client-review.service';
import { AdminClientReviewController } from './admin-client-review.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminClientReviewController],
  providers: [AdminClientReviewService],
})
export class AdminClientReviewModule {}
```

Modify `src/app.module.ts`: add `import { AdminClientReviewModule } from './admin-client-review/admin-client-review.module';` and add `AdminClientReviewModule` to the `imports` array.

- [ ] **Step 4: Write the e2e test**

`test/admin-client-review.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Admin client review (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let clientId: string;
  const phone = `+234801${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-REVIEW-${Date.now()}`;

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

    const client = await prisma.client.create({ data: { phone } });
    clientId = client.id;
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId, employeeName: 'E2E Review Test' },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Review Test',
        agency: 'NPF',
        bvn: '12345678901',
        nin: '98765432109',
        bvnSelfie: 'client-onboarding/x/bvn-selfie.jpg',
        ninSelfie: 'client-onboarding/x/nin-selfie.jpg',
        identityVerified: true,
        liveSelfieKey: 'client-onboarding/x/live-selfie.jpg',
        faceMatchBvnScore: 0.95,
        faceMatchNinScore: 0.2,
        faceMatchPassed: false,
        step: 'FACE_MATCH_PENDING',
        failureReasons: { identityVerified: true, faceMatchPassed: false },
      },
    });
    await prisma.client.update({ where: { id: clientId }, data: { status: 'MANUAL_REVIEW' } });
  });

  afterAll(async () => {
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('rejects an unauthenticated request', () => {
    return request(app.getHttpServer()).get('/admin/clients').expect(401);
  });

  it('lists clients filtered by MANUAL_REVIEW status', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ status: 'MANUAL_REVIEW' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.some((c: { id: string }) => c.id === clientId)).toBe(true);
  });

  it('gets the full client detail including onboarding', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.onboarding.faceMatchPassed).toBe(false);
  });

  it('retries: resets to IDENTITY_SUBMITTED since only the face match failed', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/retry`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ note: 'blurry selfie, please retake' })
      .expect(200);
    expect(res.body.status).toBe('PENDING_IPPIS');

    const onboarding = await prisma.clientOnboarding.findUnique({ where: { clientId } });
    expect(onboarding!.step).toBe('IDENTITY_SUBMITTED');
    expect(onboarding!.bvn).toBe('12345678901');
    expect(onboarding!.liveSelfieKey).toBeNull();
  });

  it('rejects approve/retry once the client is no longer in MANUAL_REVIEW', () => {
    return request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(409);
  });
});
```

- [ ] **Step 5: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-client-review.e2e-spec.ts --runInBand`
Expected: PASS — 5 tests.

- [ ] **Step 6: Update the README**

Add a new section to `README.md`, right before the `## Client/IPPIS onboarding` section (or immediately after it — either placement is fine, they're closely related):

```markdown
## Admin client review

Clients that fail identity or face-match verification land at
`Client.status = MANUAL_REVIEW` with `ClientOnboarding.failureReasons`
populated. Admins holding `clients:review` can list/inspect them and
either `approve` (overrides straight to `VERIFIED`) or `retry` — which
auto-resets the client to the right earlier onboarding step based on
*which* check failed, rather than requiring the admin to pick a step
manually.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /admin/clients` | `clients:review` | Filterable by `status` |
| `GET /admin/clients/:id` | `clients:review` | Full detail incl. `ClientOnboarding` — selfie images are downloaded separately via `GET /admin/documents/files/:key` (`documents:read`) |
| `POST /admin/clients/:id/approve` | `clients:review` | Only valid from `MANUAL_REVIEW` |
| `POST /admin/clients/:id/retry` | `clients:review` | `{ note }`. Resets to `IPPIS_LINKED` if identity verification itself failed, or `IDENTITY_SUBMITTED` if only the face match failed |
```

- [ ] **Step 7: Add Postman coverage**

In `postman/public-sector-backend.postman_collection.json`, under the **Admin** top-level folder, add a new sub-folder `"Client Review"` (alongside the existing `Documents`, `Permissions`, `Roles`, `Admins` sub-folders) with these requests:

```json
{
  "name": "Client Review",
  "item": [
    {
      "name": "GET /admin/clients - Unauthenticated (401)",
      "request": {
        "method": "GET",
        "header": [],
        "url": { "raw": "{{base_url}}/admin/clients", "host": ["{{base_url}}"], "path": ["admin", "clients"] }
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 401', () => pm.response.to.have.status(401));"] } }]
    },
    {
      "name": "GET /admin/clients - Filtered by status",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/clients?status=MANUAL_REVIEW",
          "host": ["{{base_url}}"],
          "path": ["admin", "clients"],
          "query": [{ "key": "status", "value": "MANUAL_REVIEW" }]
        }
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "exec": [
              "pm.test('status 200', () => pm.response.to.have.status(200));",
              "const json = pm.response.json();",
              "if (json.length > 0) { pm.collectionVariables.set('review_client_id', json[0].id); }"
            ]
          }
        }
      ]
    },
    {
      "name": "GET /admin/clients/:id - Success",
      "request": {
        "method": "GET",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/clients/{{review_client_id}}",
          "host": ["{{base_url}}"],
          "path": ["admin", "clients", "{{review_client_id}}"]
        },
        "description": "Run 'GET /admin/clients - Filtered by status' first to populate review_client_id from a real MANUAL_REVIEW client."
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));"] } }]
    },
    {
      "name": "POST /admin/clients/:id/retry - Success",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{\n  \"note\": \"Please retake your selfie in better lighting\"\n}" },
        "url": {
          "raw": "{{base_url}}/admin/clients/{{review_client_id}}/retry",
          "host": ["{{base_url}}"],
          "path": ["admin", "clients", "{{review_client_id}}", "retry"]
        }
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 200', () => pm.response.to.have.status(200));"] } }]
    },
    {
      "name": "POST /admin/clients/:id/retry - Missing note (400)",
      "request": {
        "method": "POST",
        "header": [
          { "key": "Content-Type", "value": "application/json" },
          { "key": "Authorization", "value": "Bearer {{admin_access_token}}" }
        ],
        "body": { "mode": "raw", "raw": "{}" },
        "url": {
          "raw": "{{base_url}}/admin/clients/{{review_client_id}}/retry",
          "host": ["{{base_url}}"],
          "path": ["admin", "clients", "{{review_client_id}}", "retry"]
        }
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 400', () => pm.response.to.have.status(400));"] } }]
    },
    {
      "name": "POST /admin/clients/:id/approve - Blocked, not in MANUAL_REVIEW (409)",
      "request": {
        "method": "POST",
        "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
        "url": {
          "raw": "{{base_url}}/admin/clients/{{review_client_id}}/approve",
          "host": ["{{base_url}}"],
          "path": ["admin", "clients", "{{review_client_id}}", "approve"]
        },
        "description": "Returns 409 if review_client_id was already moved out of MANUAL_REVIEW by the retry request above (expected when running this folder top-to-bottom)."
      },
      "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 409', () => pm.response.to.have.status(409));"] } }]
    }
  ]
}
```

Add one new collection variable alongside the existing ones: `{ "key": "review_client_id", "value": "" }`.

- [ ] **Step 8: Validate the JSON and update `postman/README.md`**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

Add "**Client Review**" to `postman/README.md`'s Admin bullet in "Folder structure", alongside the existing Permissions/Roles/Admins/Documents mentions.

- [ ] **Step 9: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite, including the new/modified ones from this plan.

- [ ] **Step 10: Commit**

```bash
git add src/admin-client-review src/app.module.ts test/admin-client-review.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json postman/README.md
git commit -m "feat: add admin manual-review queue for client onboarding"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] `linkIppis` sets `Client.status = PENDING_IPPIS` — proven by `client-onboarding.service.spec.ts`'s new test.
- [ ] An admin can list clients filtered by `MANUAL_REVIEW`, view full detail, and approve a client straight to `VERIFIED` — proven by `admin-client-review.e2e-spec.ts`.
- [ ] Retry correctly resets to `IPPIS_LINKED` (identity failure) or `IDENTITY_SUBMITTED` (face-match-only failure), clearing exactly the right fields in each case — proven by `admin-client-review.service.spec.ts`.
- [ ] `approve`/`retry` are blocked with `409` once a client is no longer in `MANUAL_REVIEW` — proven by both the unit and e2e tests.
- [ ] Postman has full coverage of all four endpoints under `Admin > Client Review`.
