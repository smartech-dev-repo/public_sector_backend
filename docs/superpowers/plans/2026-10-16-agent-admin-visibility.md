# Agent Admin Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admin an `agentId` filter on the existing client list, and a full list/detail/delete/analytics surface over in-progress `AgentApplication` recruitment drafts that are currently invisible until an applicant finishes submitting.

**Architecture:** Add one optional filter field to the existing `GET /admin/clients` endpoint (no new route). Add a brand-new controller+service pair for `AgentApplication`, mounted at a path (`admin/agent-recruitment-applications`) deliberately disjoint from `admin/agents/:id` so its routes never compete with that controller's existing `:id` param route for match order.

**Tech Stack:** NestJS, Prisma, class-validator DTOs, Jest unit tests, supertest e2e tests.

**Spec:** `docs/superpowers/specs/2026-10-16-agent-admin-visibility-design.md`

## Global Constraints

- No new module — the new controller/service are added into the existing `AdminAgentReviewModule`.
- `DELETE admin/agent-recruitment-applications/:id` must 409 when the target's `status === SUBMITTED` (it's tied to a real `Agent` via a unique FK) — never allow deleting a submitted application.
- The `GET /admin/agents`/`GET /admin/agents/analytics` endpoints are unchanged — they continue to report on the `Agent` table only.
- Every new/changed endpoint gets a Postman example authored from the actual landed code, per this repo's CLAUDE.md.

---

### Task 1: `agentId` filter on `GET /admin/clients`

**Files:**
- Modify: `src/admin-client-review/dto/list-clients-query.dto.ts`
- Modify: `src/admin-client-review/admin-client-review.service.ts`
- Modify: `src/admin-client-review/admin-client-review.service.spec.ts`
- Modify: `src/admin-client-review/admin-client-review.controller.ts`

**Interfaces:**
- Produces: `ListClientsFilters.agentId?: string`, consumed by `AdminClientReviewService.list()` — no other task depends on this.

- [ ] **Step 1: Add the query field**

In `src/admin-client-review/dto/list-clients-query.dto.ts`, change:

```typescript
import { IsEnum, IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { ClientStatus } from '../../generated/prisma/client';

export class ListClientsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @IsOptional()
  @IsIn(['SELF', 'AGENT', 'ADMIN'])
  onboardingSource?: 'SELF' | 'AGENT' | 'ADMIN';
}
```

to:

```typescript
import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { ClientStatus } from '../../generated/prisma/client';

export class ListClientsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ClientStatus)
  status?: ClientStatus;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @IsOptional()
  @IsIn(['SELF', 'AGENT', 'ADMIN'])
  onboardingSource?: 'SELF' | 'AGENT' | 'ADMIN';

  @IsOptional()
  @IsUUID()
  agentId?: string;
}
```

- [ ] **Step 2: Write the failing unit tests**

In `src/admin-client-review/admin-client-review.service.spec.ts`, inside the existing `describe('list', ...)` block, add these two tests right after the `'applies a createdAt date range'` test:

```typescript
    it('filters by agentId', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.list({ agentId: 'agent-1' });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ onboarding: { onboardedByAgentId: 'agent-1' } }),
        }),
      );
    });

    it('overrides onboardingSource with the exact agentId when both are given', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.list({ onboardingSource: 'AGENT' as never, agentId: 'agent-1' });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ onboarding: { onboardedByAgentId: 'agent-1' } }),
        }),
      );
    });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: FAIL — `service.list({ agentId: ... })` doesn't filter by it yet (the `agentId` property doesn't exist on `ListClientsFilters` and is silently ignored).

- [ ] **Step 4: Implement the filter**

In `src/admin-client-review/admin-client-review.service.ts`, change the `ListClientsFilters` interface:

```typescript
export interface ListClientsFilters {
  status?: ClientStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  onboardingSource?: OnboardingSource;
}
```

to:

```typescript
export interface ListClientsFilters {
  status?: ClientStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  onboardingSource?: OnboardingSource;
  agentId?: string;
}
```

Change the `where` construction inside `list()` from:

```typescript
      onboarding: this.buildOnboardingSourceWhere(filters.onboardingSource),
```

to:

```typescript
      onboarding: this.buildOnboardingWhere(filters.onboardingSource, filters.agentId),
```

Add a new private method right after `buildOnboardingSourceWhere`:

```typescript
  private buildOnboardingWhere(
    onboardingSource?: OnboardingSource,
    agentId?: string,
  ): Prisma.ClientOnboardingWhereInput | undefined {
    const sourceWhere = this.buildOnboardingSourceWhere(onboardingSource);
    if (agentId) {
      return { ...sourceWhere, onboardedByAgentId: agentId };
    }
    return sourceWhere;
  }
```

This preserves the existing `onboarding: undefined` behavior (and its exact-match unit test) when neither filter is supplied — `buildOnboardingWhere` returns exactly whatever `buildOnboardingSourceWhere` returns (including `undefined`) unless `agentId` is present, in which case it returns a concrete object that overrides any `onboardedByAgentId` constraint `onboardingSource` would have produced.

- [ ] **Step 5: Wire the controller**

In `src/admin-client-review/admin-client-review.controller.ts`, change the `list()` method body from:

```typescript
  list(@Query() query: ListClientsQueryDto) {
    return this.adminClientReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        onboardingSource: query.onboardingSource,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

to:

```typescript
  list(@Query() query: ListClientsQueryDto) {
    return this.adminClientReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        onboardingSource: query.onboardingSource,
        agentId: query.agentId,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS (all tests, including the 2 new ones).

- [ ] **Step 7: Verify the app still compiles**

Run: `npx nest build`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/admin-client-review/dto/list-clients-query.dto.ts src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts src/admin-client-review/admin-client-review.controller.ts
git commit -m "feat(admin-client-review): add agentId filter to GET /admin/clients"
```

---

### Task 2: `AdminAgentRecruitmentReviewService`

**Files:**
- Create: `src/admin-agent-review/admin-agent-recruitment-review.service.ts`
- Create: `src/admin-agent-review/admin-agent-recruitment-review.service.spec.ts`

**Interfaces:**
- Consumes: `prisma.agentApplication` (the `AgentApplication` model from Task 1 of the earlier Agent Recruitment plan, already in the schema).
- Produces: `AdminAgentRecruitmentReviewService.list(filters, pagination)`, `.findById(id)`, `.getAnalytics(filters)`, `.remove(id)` — consumed by Task 3.

- [ ] **Step 1: Write the service**

```typescript
// src/admin-agent-review/admin-agent-recruitment-review.service.ts
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentApplication, AgentApplicationStatus, AgentStatus, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

export interface ListRecruitmentApplicationsFilters {
  status?: AgentApplicationStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface RecruitmentApplicationAnalyticsFilters {
  createdFrom?: Date;
  createdTo?: Date;
}

export interface RecruitmentApplicationAnalyticsSummary {
  totalApplications: number;
  byStatus: Record<AgentApplicationStatus, number>;
  conversionRate: number | null;
  averageTimeToSubmitHours: number | null;
}

type ApplicationWithSubmittedAgent = AgentApplication & {
  submittedAgent: { id: string; status: AgentStatus } | null;
};

@Injectable()
export class AdminAgentRecruitmentReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    filters: ListRecruitmentApplicationsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.AgentApplicationWhereInput = {
      status: filters.status,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      OR: filters.q
        ? [
            { email: { contains: filters.q, mode: 'insensitive' } },
            { fullName: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.agentApplication.findMany({
        where,
        include: { submittedAgent: { select: { id: true, status: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.agentApplication.count({ where }),
    ]);

    return buildPaginatedResult(
      data.map((row) => this.narrow(row as ApplicationWithSubmittedAgent)),
      total,
      page,
      limit,
    );
  }

  async findById(id: string) {
    const application = await this.prisma.agentApplication.findUnique({
      where: { id },
      include: { submittedAgent: { select: { id: true, status: true } } },
    });
    if (!application) {
      throw new NotFoundException('Recruitment application not found');
    }
    return this.narrow(application as ApplicationWithSubmittedAgent);
  }

  async getAnalytics(
    filters: RecruitmentApplicationAnalyticsFilters = {},
  ): Promise<RecruitmentApplicationAnalyticsSummary> {
    const where: Prisma.AgentApplicationWhereInput = {
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [totalApplications, statusGroups, submittedRows] = await Promise.all([
      this.prisma.agentApplication.count({ where }),
      this.prisma.agentApplication.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.agentApplication.findMany({
        where: { ...where, status: AgentApplicationStatus.SUBMITTED },
        include: { submittedAgent: { select: { createdAt: true } } },
      }),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(AgentApplicationStatus).map((status) => [
        status,
        statusGroups.find((g) => g.status === status)?._count._all ?? 0,
      ]),
    ) as Record<AgentApplicationStatus, number>;

    const submittedCount = byStatus[AgentApplicationStatus.SUBMITTED];
    const conversionRate = totalApplications === 0 ? null : submittedCount / totalApplications;

    const submitDurationsMs = submittedRows
      .filter((row) => row.submittedAgent)
      .map((row) => row.submittedAgent!.createdAt.getTime() - row.createdAt.getTime());
    const averageTimeToSubmitHours =
      submitDurationsMs.length === 0
        ? null
        : submitDurationsMs.reduce((sum, ms) => sum + ms, 0) / submitDurationsMs.length / (1000 * 60 * 60);

    return { totalApplications, byStatus, conversionRate, averageTimeToSubmitHours };
  }

  async remove(id: string): Promise<void> {
    const application = await this.prisma.agentApplication.findUnique({ where: { id } });
    if (!application) {
      throw new NotFoundException('Recruitment application not found');
    }
    if (application.status === AgentApplicationStatus.SUBMITTED) {
      throw new ConflictException('Cannot delete an application that has already been submitted');
    }
    await this.prisma.agentApplication.delete({ where: { id } });
  }

  private narrow(row: ApplicationWithSubmittedAgent) {
    return {
      id: row.id,
      email: row.email,
      status: row.status,
      emailVerifiedAt: row.emailVerifiedAt,
      fullName: row.fullName,
      phone: row.phone,
      gender: row.gender,
      address: row.address,
      city: row.city,
      state: row.state,
      localGovernment: row.localGovernment,
      nin: row.nin,
      ninVerified: row.ninVerified,
      ninVerifiedName: row.ninVerifiedName,
      coverLetter: row.coverLetter,
      cvKey: row.cvKey,
      passportPhotoKey: row.passportPhotoKey,
      identityDocumentKey: row.identityDocumentKey,
      submittedAgent: row.submittedAgent,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
```

- [ ] **Step 2: Write its spec**

```typescript
// src/admin-agent-review/admin-agent-recruitment-review.service.spec.ts
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminAgentRecruitmentReviewService } from './admin-agent-recruitment-review.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminAgentRecruitmentReviewService', () => {
  let service: AdminAgentRecruitmentReviewService;
  let prisma: {
    agentApplication: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      groupBy: jest.Mock;
      delete: jest.Mock;
    };
  };

  const baseRow = {
    id: 'app-1',
    email: 'jane@example.com',
    status: 'EMAIL_VERIFIED',
    emailVerifiedAt: new Date('2026-01-01'),
    fullName: 'Jane Doe',
    phone: '+2348000000000',
    gender: 'Female',
    address: '1 St',
    city: 'Lagos',
    state: 'Lagos',
    localGovernment: 'Ikeja',
    nin: '12345678901',
    ninVerified: true,
    ninVerifiedName: 'Jane Doe',
    coverLetter: 'Hello',
    cvKey: null,
    passportPhotoKey: null,
    identityDocumentKey: null,
    submittedAgent: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  beforeEach(() => {
    prisma = {
      agentApplication: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
        delete: jest.fn(),
      },
    };
    service = new AdminAgentRecruitmentReviewService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      const result = await service.list();

      expect(prisma.agentApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: undefined, createdAt: undefined, OR: undefined }, skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status and searches email/fullName', async () => {
      await service.list({ status: 'SUBMITTED' as never, q: 'jane' });

      expect(prisma.agentApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'SUBMITTED',
            OR: [
              { email: { contains: 'jane', mode: 'insensitive' } },
              { fullName: { contains: 'jane', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies a createdAt date range', async () => {
      const createdFrom = new Date('2026-01-01');
      const createdTo = new Date('2026-12-31');

      await service.list({ createdFrom, createdTo });

      expect(prisma.agentApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
      );
    });

    it('narrows each row and includes a submittedAgent summary when present', async () => {
      prisma.agentApplication.findMany.mockResolvedValue([
        { ...baseRow, status: 'SUBMITTED', submittedAgent: { id: 'agent-1', status: 'PENDING_REVIEW' } },
      ]);
      prisma.agentApplication.count.mockResolvedValue(1);

      const result = await service.list();

      expect(result.data[0]).toEqual(
        expect.objectContaining({ id: 'app-1', submittedAgent: { id: 'agent-1', status: 'PENDING_REVIEW' } }),
      );
      expect(result.data[0]).not.toHaveProperty('emailCodeHash');
      expect(result.data[0]).not.toHaveProperty('emailCodeExpiresAt');
    });
  });

  describe('findById', () => {
    it('throws NotFoundException when missing', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the narrowed shape when found', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue(baseRow);
      const result = await service.findById('app-1');
      expect(result.id).toBe('app-1');
      expect(result.submittedAgent).toBeNull();
    });
  });

  describe('getAnalytics', () => {
    it('fills every AgentApplicationStatus key even when groupBy returns no rows', async () => {
      const result = await service.getAnalytics();
      expect(Object.keys(result.byStatus).sort()).toEqual(['EMAIL_PENDING', 'EMAIL_VERIFIED', 'SUBMITTED'].sort());
      expect(result.conversionRate).toBeNull();
      expect(result.averageTimeToSubmitHours).toBeNull();
    });

    it('computes conversionRate from submitted/total', async () => {
      prisma.agentApplication.count.mockResolvedValue(4);
      prisma.agentApplication.groupBy.mockResolvedValue([{ status: 'SUBMITTED', _count: { _all: 1 } }]);

      const result = await service.getAnalytics();

      expect(result.conversionRate).toBe(0.25);
    });

    it('computes averageTimeToSubmitHours across submitted rows', async () => {
      prisma.agentApplication.findMany.mockResolvedValue([
        {
          createdAt: new Date('2026-01-01T00:00:00Z'),
          submittedAgent: { createdAt: new Date('2026-01-01T02:00:00Z') },
        },
        {
          createdAt: new Date('2026-01-01T00:00:00Z'),
          submittedAgent: { createdAt: new Date('2026-01-01T04:00:00Z') },
        },
      ]);

      const result = await service.getAnalytics();

      expect(result.averageTimeToSubmitHours).toBe(3);
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when missing', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue(null);
      await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when already submitted', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'SUBMITTED' });
      await expect(service.remove('app-1')).rejects.toThrow(ConflictException);
      expect(prisma.agentApplication.delete).not.toHaveBeenCalled();
    });

    it('deletes a non-submitted draft', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'EMAIL_VERIFIED' });
      await service.remove('app-1');
      expect(prisma.agentApplication.delete).toHaveBeenCalledWith({ where: { id: 'app-1' } });
    });
  });
});
```

- [ ] **Step 3: Run it to verify it passes**

Run: `npx jest src/admin-agent-review/admin-agent-recruitment-review.service.spec.ts`
Expected: PASS (12 tests)

- [ ] **Step 4: Commit**

```bash
git add src/admin-agent-review/admin-agent-recruitment-review.service.ts src/admin-agent-review/admin-agent-recruitment-review.service.spec.ts
git commit -m "feat(admin-agent-review): add AdminAgentRecruitmentReviewService"
```

---

### Task 3: Controller, DTOs, module wiring, permission seed

**Files:**
- Create: `src/admin-agent-review/dto/list-recruitment-applications-query.dto.ts`
- Create: `src/admin-agent-review/dto/recruitment-application-analytics-query.dto.ts`
- Create: `src/admin-agent-review/admin-agent-recruitment-review.controller.ts`
- Modify: `src/admin-agent-review/admin-agent-review.module.ts`
- Modify: `prisma/seed.ts`

**Interfaces:**
- Consumes: `AdminAgentRecruitmentReviewService` (Task 2).
- Produces: the 4 new routes under `admin/agent-recruitment-applications/*`.

- [ ] **Step 1: Write the DTOs**

```typescript
// src/admin-agent-review/dto/list-recruitment-applications-query.dto.ts
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AgentApplicationStatus } from '../../generated/prisma/client';

export class ListRecruitmentApplicationsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(AgentApplicationStatus)
  status?: AgentApplicationStatus;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

```typescript
// src/admin-agent-review/dto/recruitment-application-analytics-query.dto.ts
import { IsISO8601, IsOptional } from 'class-validator';

export class RecruitmentApplicationAnalyticsQueryDto {
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

- [ ] **Step 2: Write the controller**

```typescript
// src/admin-agent-review/admin-agent-recruitment-review.controller.ts
import { Controller, Delete, Get, HttpCode, Param, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminAgentRecruitmentReviewService } from './admin-agent-recruitment-review.service';
import { ListRecruitmentApplicationsQueryDto } from './dto/list-recruitment-applications-query.dto';
import { RecruitmentApplicationAnalyticsQueryDto } from './dto/recruitment-application-analytics-query.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/agent-recruitment-applications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminAgentRecruitmentReviewController {
  constructor(
    private readonly adminAgentRecruitmentReviewService: AdminAgentRecruitmentReviewService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions('agents:recruitment:read')
  list(@Query() query: ListRecruitmentApplicationsQueryDto) {
    return this.adminAgentRecruitmentReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Get('analytics')
  @RequirePermissions('agents:recruitment:analytics:read')
  getAnalytics(@Query() query: RecruitmentApplicationAnalyticsQueryDto) {
    return this.adminAgentRecruitmentReviewService.getAnalytics({
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('agents:recruitment:read')
  findById(@Param('id') id: string) {
    return this.adminAgentRecruitmentReviewService.findById(id);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('agents:recruitment:manage')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminAgentRecruitmentReviewService.remove(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent_recruitment_application.deleted',
      targetType: 'AgentApplication',
      targetId: id,
    });
    return { deleted: true };
  }
}
```

Note: `analytics` is registered before `:id` within this controller — same literal-before-param ordering rule already established elsewhere in this codebase (e.g. `GET admin/agents/analytics` vs `GET admin/agents/:id`). This controller is mounted at a path disjoint from `admin/agents`, so it does not interact with that other controller's route ordering at all.

- [ ] **Step 3: Wire the module**

In `src/admin-agent-review/admin-agent-review.module.ts`, change:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { AdminAgentReviewController } from './admin-agent-review.controller';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { AdminAgentAnalyticsService } from './admin-agent-analytics.service';

@Module({
  imports: [AuditModule, EmailModule],
  controllers: [AdminAgentReviewController],
  providers: [AdminAgentReviewService, AdminAgentAnalyticsService],
})
export class AdminAgentReviewModule {}
```

to:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { AdminAgentReviewController } from './admin-agent-review.controller';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { AdminAgentAnalyticsService } from './admin-agent-analytics.service';
import { AdminAgentRecruitmentReviewController } from './admin-agent-recruitment-review.controller';
import { AdminAgentRecruitmentReviewService } from './admin-agent-recruitment-review.service';

@Module({
  imports: [AuditModule, EmailModule],
  controllers: [AdminAgentReviewController, AdminAgentRecruitmentReviewController],
  providers: [AdminAgentReviewService, AdminAgentAnalyticsService, AdminAgentRecruitmentReviewService],
})
export class AdminAgentReviewModule {}
```

- [ ] **Step 4: Seed the 3 new permissions**

In `prisma/seed.ts`'s `BOOTSTRAP_PERMISSIONS` array, add:

```typescript
  { key: 'agents:recruitment:read', description: 'View in-progress and completed agent recruitment applications' },
  { key: 'agents:recruitment:analytics:read', description: 'View agent recruitment funnel analytics' },
  { key: 'agents:recruitment:manage', description: 'Delete an abandoned agent recruitment application' },
```

Run: `npx prisma db seed` to verify it runs cleanly.

- [ ] **Step 5: Verify the app compiles and boots**

Run: `npx nest build`
Expected: no errors.

Run (briefly) `npm run start:dev`, confirm the log shows `Mapped {/admin/agent-recruitment-applications, GET}`, `Mapped {/admin/agent-recruitment-applications/analytics, GET}`, `Mapped {/admin/agent-recruitment-applications/:id, GET}`, `Mapped {/admin/agent-recruitment-applications/:id, DELETE}` with `analytics` registered before `:id`, then stop it.

- [ ] **Step 6: Commit**

```bash
git add src/admin-agent-review/dto/list-recruitment-applications-query.dto.ts src/admin-agent-review/dto/recruitment-application-analytics-query.dto.ts src/admin-agent-review/admin-agent-recruitment-review.controller.ts src/admin-agent-review/admin-agent-review.module.ts prisma/seed.ts
git commit -m "feat(admin-agent-review): add agent-recruitment-applications admin endpoints"
```

---

### Task 4: e2e tests

**Files:**
- Modify: `test/admin-client-review.e2e-spec.ts`
- Create: `test/admin-agent-recruitment-review.e2e-spec.ts`

**Interfaces:**
- Consumes: all routes from Tasks 1-3 — requires the full app wired (already true after Task 3).

- [ ] **Step 1: Add the agentId filter e2e test**

In `test/admin-client-review.e2e-spec.ts`, add a throwaway agent + agent-onboarded client fixture and its own test. Add these fields near the top of the `describe` block, alongside the existing `clientId`/`phone`/`staffId` declarations:

```typescript
  let agentOnboardedClientId: string;
  let throwawayAgentId: string;
  const agentOnboardedPhone = `+234802${Date.now().toString().slice(-7)}`;
  const agentStaffId = `E2E-AGENT-FILTER-${Date.now()}`;
```

In `beforeAll`, after the existing fixture setup (right before the closing of `beforeAll`), add:

```typescript
    const throwawayAgent = await prisma.agent.create({
      data: {
        email: `e2e-agent-filter-${Date.now()}@example.com`,
        phone: '+2348099999999',
        fullName: 'E2E Agent Filter Test',
        address: '1 St',
        cvKey: '',
        status: 'APPROVED',
      },
    });
    throwawayAgentId = throwawayAgent.id;

    const agentOnboardedClient = await prisma.client.create({ data: { phone: agentOnboardedPhone } });
    agentOnboardedClientId = agentOnboardedClient.id;
    const agentIppisRecord = await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId: agentStaffId, employeeName: 'E2E Agent Filter Test Client' },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: agentOnboardedClientId,
        ippisRecordId: agentIppisRecord.id,
        employeeName: 'E2E Agent Filter Test Client',
        agency: 'NPF',
        onboardedByAgentId: throwawayAgentId,
        step: 'COMPLETED',
      },
    });
```

In `afterAll`, before `await app.close();`, add:

```typescript
    await prisma.clientOnboarding.deleteMany({ where: { clientId: agentOnboardedClientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: agentStaffId } });
    await prisma.client.deleteMany({ where: { id: agentOnboardedClientId } });
    await prisma.agent.deleteMany({ where: { id: throwawayAgentId } });
```

Add a new test, right after the existing `'filters the list by onboardingSource'` test:

```typescript
  it('filters the list by agentId', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ agentId: throwawayAgentId })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.body.data.every((c: { id: string }) => c.id === agentOnboardedClientId)).toBe(true);
    expect(res.body.data.some((c: { id: string }) => c.id === agentOnboardedClientId)).toBe(true);
  });
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json admin-client-review`
Expected: PASS (all tests, including the new one). Re-run in isolation if it fails on the first attempt before concluding there's a real regression — this is a shared UAT database with known DB-contention flakiness under concurrent load.

- [ ] **Step 3: Write the recruitment-applications e2e spec**

```typescript
// test/admin-agent-recruitment-review.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Admin agent recruitment applications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let capturedEmails: EmailMessage[];
  let adminAccessToken: string;
  const createdAgentIds: string[] = [];
  const createdApplicationEmails: string[] = [];

  function latestCodeFor(email: string): string {
    const match = [...capturedEmails]
      .reverse()
      .find((m) => m.to === email && /verification code is: (\d+)/.test(m.text ?? ''));
    const codeMatch = match?.text?.match(/verification code is: (\d+)/);
    if (!codeMatch) {
      throw new Error(`No verification code email found for ${email}`);
    }
    return codeMatch[1];
  }

  async function createVerifiedDraft(email: string): Promise<string> {
    await request(app.getHttpServer()).post('/agents/recruitment/email/request-code').send({ email }).expect(200);
    const code = latestCodeFor(email);
    const confirmRes = await request(app.getHttpServer())
      .post('/agents/recruitment/email/confirm-code')
      .send({ email, code })
      .expect(200);
    return confirmRes.body.applicationToken;
  }

  beforeAll(async () => {
    capturedEmails = [];
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_PROVIDERS)
      .useValue([
        {
          name: 'test-capture',
          send: async (message: EmailMessage) => {
            capturedEmails.push(message);
          },
        },
      ])
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await prisma.agentApplication.deleteMany({ where: { email: { in: createdApplicationEmails } } });
    await app.close();
  });

  it(
    'lists an in-progress draft, fetches it by id, reflects it in analytics, and allows deleting it',
    async () => {
      const email = `e2e-admin-draft-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);
      await createVerifiedDraft(email);

      const listRes = await request(app.getHttpServer())
        .get('/admin/agent-recruitment-applications')
        .query({ q: email })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      const row = listRes.body.data.find((a: { email: string }) => a.email === email);
      expect(row).toBeDefined();
      expect(row.status).toBe('EMAIL_VERIFIED');
      expect(row.submittedAgent).toBeNull();
      expect(row).not.toHaveProperty('emailCodeHash');

      const detailRes = await request(app.getHttpServer())
        .get(`/admin/agent-recruitment-applications/${row.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(detailRes.body.email).toBe(email);

      const analyticsRes = await request(app.getHttpServer())
        .get('/admin/agent-recruitment-applications/analytics')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(analyticsRes.body.totalApplications).toBeGreaterThanOrEqual(1);
      expect(analyticsRes.body.byStatus).toEqual(
        expect.objectContaining({
          EMAIL_PENDING: expect.any(Number),
          EMAIL_VERIFIED: expect.any(Number),
          SUBMITTED: expect.any(Number),
        }),
      );

      await request(app.getHttpServer())
        .delete(`/admin/agent-recruitment-applications/${row.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200)
        .expect({ deleted: true });

      await request(app.getHttpServer())
        .get(`/admin/agent-recruitment-applications/${row.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(404);
    },
    20000,
  );

  it(
    'blocks deleting a submitted application with a 409',
    async () => {
      const email = `e2e-admin-submitted-${Date.now()}@example.com`;
      createdApplicationEmails.push(email);
      const applicationToken = await createVerifiedDraft(email);

      const submitRes = await request(app.getHttpServer())
        .post('/agents/recruitment/submit')
        .set('Authorization', `Bearer ${applicationToken}`)
        .field('fullName', 'E2E Admin Submitted')
        .field('phone', '+2348012399999')
        .field('gender', 'Male')
        .field('address', '1 Example Street')
        .field('city', 'Lagos')
        .field('state', 'Lagos')
        .field('localGovernment', 'Ikeja')
        .field('nin', '12345678901')
        .field('coverLetter', 'Cover letter.')
        .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
        .attach('passportPhoto', Buffer.from('fake photo content'), 'photo.jpg')
        .expect(201);
      createdAgentIds.push(submitRes.body.id);

      const listRes = await request(app.getHttpServer())
        .get('/admin/agent-recruitment-applications')
        .query({ q: email })
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      const row = listRes.body.data.find((a: { email: string }) => a.email === email);
      expect(row.status).toBe('SUBMITTED');
      expect(row.submittedAgent).toEqual({ id: submitRes.body.id, status: 'PENDING_REVIEW' });

      await request(app.getHttpServer())
        .delete(`/admin/agent-recruitment-applications/${row.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(409);
    },
    20000,
  );
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json admin-agent-recruitment-review`
Expected: PASS (2 tests). Re-run in isolation if it fails on the first attempt before concluding there's a real regression.

- [ ] **Step 5: Commit**

```bash
git add test/admin-client-review.e2e-spec.ts test/admin-agent-recruitment-review.e2e-spec.ts
git commit -m "test(e2e): cover agentId client filter and agent recruitment admin endpoints"
```

---

### Task 5: Postman collection update

**Files:**
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: all routes from Tasks 1-3.

Write a one-off Node script to a scratch location outside the repo, run it once, then delete it — same pattern used for every prior Postman task this session.

- [ ] **Step 1: Write and run the migration script**

The script should:

1. Find the existing `GET /admin/clients - Success` request (or its sibling "filters by onboardingSource" example, whichever exists) under Admin → Client Review. Add a new saved example `GET /admin/clients - Filtered by agentId` showing the `agentId` query param and a response scoped to one agent's onboarded clients, authored from the real `ListClientsQueryDto`/`AdminClientReviewService` response shape.
2. Under Admin, add a new `Agent Recruitment Applications` sub-folder (sibling to the existing Agent Review sub-folder) with 4 requests, each with a saved response example authored from the actual landed controller/service/DTO code:
   - `GET /admin/agent-recruitment-applications - Success` (with `status`/`q`/`createdFrom`/`createdTo` query params shown)
   - `GET /admin/agent-recruitment-applications/analytics - Success`
   - `GET /admin/agent-recruitment-applications/:id - Success` and `- Not found (404)`
   - `DELETE /admin/agent-recruitment-applications/:id - Success` and `- Already submitted (409)`
3. Writes the updated JSON back to the repo path.

- [ ] **Step 2: Validate the result**

Run:
```bash
python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo "valid JSON"
```

- [ ] **Step 3: Delete the one-off script, confirm it isn't tracked**

Run: `git status` — the script must not appear.

- [ ] **Step 4: Commit**

```bash
git add postman/public-sector-backend.postman_collection.json
git commit -m "docs(postman): add agent-recruitment-applications admin endpoints, document clients agentId filter"
```

---

### Task 6: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit test suite**

Run: `npx jest`
Expected: PASS.

- [ ] **Step 2: Full e2e test suite**

Run: `npx jest --config ./test/jest-e2e.json`
Expected: PASS. Re-run any failing spec in isolation before treating it as a regression (known pre-existing DB-contention flakiness under full-suite concurrent load).

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint "{src,apps,libs,test}/**/*.ts" --rule '{"prettier/prettier":"off"}'` (note: **without** `--fix`) — expect no new errors beyond the established pre-existing baseline (24 errors as of the last check on this branch).

- [ ] **Step 4: Confirm the app boots live**

Run `npm run start:dev` against a reachable database, confirm clean startup and that all new routes (`GET admin/agent-recruitment-applications`, `GET admin/agent-recruitment-applications/analytics`, `GET admin/agent-recruitment-applications/:id`, `DELETE admin/agent-recruitment-applications/:id`) resolve in the startup log with `analytics` ahead of `:id`, then stop it.

- [ ] **Step 5: Confirm no stray debug artifacts remain**

Run: `git status --short` — expect clean.
