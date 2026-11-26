# List Pagination Wave 3 — Smaller Unbounded Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the shared pagination convention (Sub-project 1) to six admin list endpoints that are unbounded today but query smaller, simpler tables than Wave 2's: `admin/agents`, `admin/invites`, `admin/permissions`, `admin/admins`, `admin/roles`, `admin/loan-terms`.

**Architecture:** Each endpoint lives in its own service/module (unlike Wave 2's `admin/ippis-records`+`admin/loans`, which shared one service class) — every one of these six is a straightforward single-Prisma-model `findMany`+`count` with a real DB `skip`/`take`, no in-memory merging or filtering like Wave 2's `admin/clients/:id/activities`.

**Tech Stack:** NestJS, Prisma, `class-validator`/`class-transformer`, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-list-pagination-filtering-design.md` (see its per-endpoint filter table)

## Global Constraints

- Every new query DTO extends `PaginationDto` from `src/common/pagination/pagination.dto.ts` (`page` default `1`, `limit` default `25`, hard max `100`).
- Every changed service method returns `PaginatedResult<T>` via `buildPaginatedResult()` from `src/common/pagination/paginated-result.ts`.
- Search fields use `q?: string`; a single-searchable-field endpoint filters that field directly (`{ contains: q, mode: 'insensitive' }`), a multi-field endpoint uses `OR: [...]`.
- Date-range fields are field-specific `xFrom`/`xTo` ISO8601 pairs.
- A boolean query filter (`isActive` on `admin/admins` and `admin/loan-terms`) needs an explicit `@Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)` before `@IsBoolean()` — `@Type(() => Boolean)` alone is unsafe for query strings (`Boolean('false')` is `true` in JavaScript, since any non-empty string is truthy). This codebase has no prior boolean-query-param DTO to follow, so this plan sets the convention.
- Before changing any service method's return shape, grep the whole `src/` tree for other callers — already confirmed for all six methods in this plan (each has exactly one caller, its own controller), but re-confirm during execution in case something changed since planning.
- Before changing any endpoint's response shape, grep `test/*.e2e-spec.ts` for existing calls to that route — already catalogued per task below.
- No `Co-Authored-By: Claude` trailer on any commit.
- This is Sub-project 3 of a 5-wave initiative. Per this project's scoped-test-runs convention, **do not run the full test suite in this plan's closing task** — only the tests for files this plan touches. The full suite runs once, at the true end of the whole initiative (after Sub-project 5).

---

### Task 1: `admin/agents`

**Files:**
- Create: `src/admin-agent-review/dto/list-agents-query.dto.ts`
- Modify: `src/admin-agent-review/admin-agent-review.service.ts`
- Modify: `src/admin-agent-review/admin-agent-review.controller.ts`
- Modify: `src/admin-agent-review/admin-agent-review.service.spec.ts`
- Test: Create `test/admin-agents.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1).
- Produces: `AdminAgentReviewService.list(filters?: ListAgentsFilters, pagination?): Promise<PaginatedResult<Agent>>`.

- [ ] **Step 1: Confirm no existing e2e coverage to break**

Run: `grep -rn "get('/admin/agents'" test/*.e2e-spec.ts`
Expected: no results — confirmed during planning there's no existing coverage of this list endpoint anywhere (agent-review e2e coverage only exercises `POST /admin/agents/:id/approve|reject|resend-credentials`, never the list `GET`).

- [ ] **Step 2: Add a `list` describe block to the unit test**

Read `src/admin-agent-review/admin-agent-review.service.spec.ts` in full first. Add `import { AgentStatus } from '../generated/prisma/client';` to its imports, add `count: jest.fn()` to the `prisma.agent` mock's type declaration and instantiation, then add this new block anywhere at the top level of the `describe('AdminAgentReviewService', ...)` block:

```typescript
  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status and searches fullName/email/phone', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);

      await service.list({ status: AgentStatus.APPROVED, q: 'okoro' });

      expect(prisma.agent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: AgentStatus.APPROVED,
            OR: [
              { fullName: { contains: 'okoro', mode: 'insensitive' } },
              { email: { contains: 'okoro', mode: 'insensitive' } },
              { phone: { contains: 'okoro', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies createdAt and reviewedAt date ranges independently', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const reviewedTo = new Date('2025-06-01');

      await service.list({ createdFrom, reviewedTo });

      expect(prisma.agent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: createdFrom, lte: undefined },
            reviewedAt: { gte: undefined, lte: reviewedTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(9);

      const result = await service.list({}, { page: 2, limit: 4 });

      expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 4, take: 4 }));
      expect(result.meta).toEqual({ total: 9, page: 2, limit: 4, totalPages: 3 });
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/admin-agent-review/admin-agent-review.service.spec.ts -t list`
Expected: FAIL — `list` doesn't accept these params yet.

- [ ] **Step 4: Create the query DTO**

Create `src/admin-agent-review/dto/list-agents-query.dto.ts`:

```typescript
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AgentStatus } from '../../generated/prisma/client';

export class ListAgentsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(AgentStatus)
  status?: AgentStatus;

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
  @IsISO8601()
  reviewedFrom?: string;

  @IsOptional()
  @IsISO8601()
  reviewedTo?: string;
}
```

- [ ] **Step 5: Rewrite `AdminAgentReviewService.list`**

In `src/admin-agent-review/admin-agent-review.service.ts`, change the import line `import { Agent, AgentStatus } from '../generated/prisma/client';` to `import { Agent, AgentStatus, Prisma } from '../generated/prisma/client';`, and add `import { buildPaginatedResult } from '../common/pagination/paginated-result';`. Add this interface near the top of the file (after the imports):

```typescript
export interface ListAgentsFilters {
  status?: AgentStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  reviewedFrom?: Date;
  reviewedTo?: Date;
}
```

Replace:

```typescript
  async list(status?: AgentStatus) {
    return this.prisma.agent.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }
```

with:

```typescript
  async list(
    filters: ListAgentsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.AgentWhereInput = {
      status: filters.status,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      reviewedAt:
        filters.reviewedFrom || filters.reviewedTo
          ? { gte: filters.reviewedFrom, lte: filters.reviewedTo }
          : undefined,
      OR: filters.q
        ? [
            { fullName: { contains: filters.q, mode: 'insensitive' } },
            { email: { contains: filters.q, mode: 'insensitive' } },
            { phone: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.agent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.agent.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 6: Update `AdminAgentReviewController`**

Replace:

```typescript
  @Get()
  @RequirePermissions('agents:read')
  list(@Query('status') status?: AgentStatus) {
    return this.adminAgentReviewService.list(status);
  }
```

with:

```typescript
  @Get()
  @RequirePermissions('agents:read')
  list(@Query() query: ListAgentsQueryDto) {
    return this.adminAgentReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        reviewedFrom: query.reviewedFrom ? new Date(query.reviewedFrom) : undefined,
        reviewedTo: query.reviewedTo ? new Date(query.reviewedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add the import `import { ListAgentsQueryDto } from './dto/list-agents-query.dto';`. Remove `AgentStatus` from this controller's `import { AgentStatus, AuditActorType } from '../generated/prisma/client';` only if nothing else in the file still uses it (check first — it's used nowhere else in this controller, so drop it, keeping `AuditActorType`).

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/admin-agent-review/admin-agent-review.service.spec.ts`
Expected: PASS — full file, not just the new `list` block.

- [ ] **Step 8: Write a new e2e test file**

Create `test/admin-agents.e2e-spec.ts`. Read `test/admin-catalog.e2e-spec.ts` first (from Sub-project 2, Wave 2) to copy its exact `beforeAll` admin-login pattern (`POST /auth/admin/login` with `process.env.BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` — this was confirmed as this codebase's real convention while executing Wave 2, replacing an earlier illustrative guess). Structure:

```typescript
import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin agents list endpoint (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;

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

    await prisma.agent.createMany({
      data: [
        { email: 'wave3.agent1@test.com', phone: '08010000001', fullName: 'Wave3 Amaka', address: '1 Test St', status: 'APPROVED', cvKey: 'agents/wave3-test/cv1.pdf' },
        { email: 'wave3.agent2@test.com', phone: '08010000002', fullName: 'Wave3 Bello', address: '2 Test St', status: 'PENDING_REVIEW', cvKey: 'agents/wave3-test/cv2.pdf' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { email: { in: ['wave3.agent1@test.com', 'wave3.agent2@test.com'] } } });
    await app.close();
  });

  it('paginates GET /admin/agents', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/agents?limit=1&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.body.meta.limit).toBe(1);
  });

  it('filters GET /admin/agents by status and searches by q', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/agents')
      .query({ status: 'APPROVED', q: 'Amaka' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.some((a: { email: string }) => a.email === 'wave3.agent1@test.com')).toBe(true);
    expect(res.body.data.every((a: { status: string }) => a.status === 'APPROVED')).toBe(true);
  });
});
```

- [ ] **Step 9: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-agents.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/admin-agent-review/ test/admin-agents.e2e-spec.ts
git commit -m "feat: paginate and filter admin agents list"
```

---

### Task 2: `admin/invites`

**Files:**
- Create: `src/admin-invite/dto/list-invites-query.dto.ts`
- Modify: `src/admin-invite/admin-invite.service.ts`
- Modify: `src/admin-invite/admin-invite.controller.ts`
- Modify: `src/admin-invite/admin-invite.service.spec.ts`
- Modify: `test/admin-invite.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1).
- Produces: `AdminInviteService.list(filters?: ListInvitesFilters, pagination?): Promise<PaginatedResult<AdminInvite>>`.

- [ ] **Step 1: Add `list` tests**

Read `src/admin-invite/admin-invite.service.spec.ts` in full first. Add `count: jest.fn()` to the `adminInvite` mock's type declaration and instantiation. Add this block at the top level of the `describe`:

```typescript
  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status and searches email', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(0);

      await service.list({ status: AdminInviteStatus.PENDING, q: 'someone@example.com' });

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: AdminInviteStatus.PENDING,
            email: { contains: 'someone@example.com', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('applies createdAt and expiresAt date ranges independently', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const expiresTo = new Date('2025-06-01');

      await service.list({ createdFrom, expiresTo });

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: createdFrom, lte: undefined },
            expiresAt: { gte: undefined, lte: expiresTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(6);

      const result = await service.list({}, { page: 2, limit: 3 });

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 3, take: 3 }));
      expect(result.meta).toEqual({ total: 6, page: 2, limit: 3, totalPages: 2 });
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/admin-invite/admin-invite.service.spec.ts -t list`
Expected: FAIL.

- [ ] **Step 3: Create the query DTO**

Create `src/admin-invite/dto/list-invites-query.dto.ts`:

```typescript
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AdminInviteStatus } from '../../generated/prisma/client';

export class ListInvitesQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(AdminInviteStatus)
  status?: AdminInviteStatus;

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
  @IsISO8601()
  expiresFrom?: string;

  @IsOptional()
  @IsISO8601()
  expiresTo?: string;
}
```

- [ ] **Step 4: Rewrite `AdminInviteService.list`**

Change the import `import { AdminInvite, AdminInviteStatus } from '../generated/prisma/client';` to `import { AdminInvite, AdminInviteStatus, Prisma } from '../generated/prisma/client';` and add `import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';`. Add near the top:

```typescript
export interface ListInvitesFilters {
  status?: AdminInviteStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  expiresFrom?: Date;
  expiresTo?: Date;
}
```

Replace:

```typescript
  async list(status?: AdminInviteStatus): Promise<AdminInvite[]> {
    return this.prisma.adminInvite.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }
```

with:

```typescript
  async list(
    filters: ListInvitesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<AdminInvite>> {
    const { page, limit } = pagination;
    const where: Prisma.AdminInviteWhereInput = {
      status: filters.status,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      expiresAt:
        filters.expiresFrom || filters.expiresTo
          ? { gte: filters.expiresFrom, lte: filters.expiresTo }
          : undefined,
      email: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.adminInvite.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.adminInvite.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 5: Update `AdminInviteController`**

Replace:

```typescript
  @Get()
  @RequirePermissions('admins:create')
  list(@Query('status') status?: AdminInviteStatus) {
    return this.adminInviteService.list(status);
  }
```

with:

```typescript
  @Get()
  @RequirePermissions('admins:create')
  list(@Query() query: ListInvitesQueryDto) {
    return this.adminInviteService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        expiresFrom: query.expiresFrom ? new Date(query.expiresFrom) : undefined,
        expiresTo: query.expiresTo ? new Date(query.expiresTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add the import `import { ListInvitesQueryDto } from './dto/list-invites-query.dto';`. Drop `AdminInviteStatus` from this controller's generated-client import if nothing else in the file uses it (check first — it isn't used elsewhere here, so drop it, keeping `AuditActorType`).

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `npx jest src/admin-invite/admin-invite.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 7: Fix the ripple e2e assertion in `test/admin-invite.e2e-spec.ts`**

Read the file around line 60-71 first. Replace:

```typescript
      .get('/admin/invites')
```
...and the assertion further down:
```typescript
        expect(res.body.some((invite: { email: string }) => invite.email === inviteEmail)).toBe(true);
```

with (only the assertion line changes; the `.get(...)` call itself doesn't):

```typescript
        expect(res.body.data.some((invite: { email: string }) => invite.email === inviteEmail)).toBe(true);
```

- [ ] **Step 8: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-invite.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 9: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/admin-invite/ test/admin-invite.e2e-spec.ts
git commit -m "feat: paginate and filter admin invites list"
```

---

### Task 3: `admin/permissions`

**Files:**
- Create: `src/admin-rbac/dto/list-permissions-query.dto.ts`
- Modify: `src/admin-rbac/permission.service.ts`
- Modify: `src/admin-rbac/admin-permissions.controller.ts`
- Modify: `src/admin-rbac/permission.service.spec.ts`
- Modify: `test/admin-permissions.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1).
- Produces: `PermissionService.list(filters?: { q?: string }, pagination?): Promise<PaginatedResult<Permission>>`.

- [ ] **Step 1: Add `list` tests**

Read `src/admin-rbac/permission.service.spec.ts` in full first. Add `count: jest.fn()` to the `permission` mock's type declaration and instantiation (the file already has `rolePermission: { count: jest.fn() }` — this is a *different* model's count, keep it, just add a sibling `count` under `permission`). Add:

```typescript
  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.permission.findMany.mockResolvedValue([]);
      prisma.permission.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.permission.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('searches by key', async () => {
      prisma.permission.findMany.mockResolvedValue([]);
      prisma.permission.count.mockResolvedValue(0);

      await service.list({ q: 'audit' });

      expect(prisma.permission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: { contains: 'audit', mode: 'insensitive' } } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.permission.findMany.mockResolvedValue([]);
      prisma.permission.count.mockResolvedValue(30);

      const result = await service.list({}, { page: 2, limit: 10 });

      expect(prisma.permission.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
      expect(result.meta).toEqual({ total: 30, page: 2, limit: 10, totalPages: 3 });
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/admin-rbac/permission.service.spec.ts -t list`
Expected: FAIL.

- [ ] **Step 3: Create the query DTO**

Create `src/admin-rbac/dto/list-permissions-query.dto.ts`:

```typescript
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListPermissionsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  q?: string;
}
```

- [ ] **Step 4: Rewrite `PermissionService.list`**

Change `import { Permission } from '../generated/prisma/client';` to `import { Permission, Prisma } from '../generated/prisma/client';` and add `import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';`. Replace:

```typescript
  async list(): Promise<Permission[]> {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
  }
```

with:

```typescript
  async list(
    filters: { q?: string } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<Permission>> {
    const { page, limit } = pagination;
    const where: Prisma.PermissionWhereInput = {
      key: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.permission.findMany({ where, orderBy: { key: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.permission.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 5: Update `AdminPermissionsController`**

Replace:

```typescript
  @Get()
  @RequirePermissions('permissions:manage')
  list() {
    return this.permissionService.list();
  }
```

with:

```typescript
  @Get()
  @RequirePermissions('permissions:manage')
  list(@Query() query: ListPermissionsQueryDto) {
    return this.permissionService.list({ q: query.q }, { page: query.page, limit: query.limit });
  }
```

Add the imports `import { Query } from '@nestjs/common';` (merge into the existing `@nestjs/common` import line rather than adding a second one) and `import { ListPermissionsQueryDto } from './dto/list-permissions-query.dto';`.

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `npx jest src/admin-rbac/permission.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 7: Fix the ripple e2e assertion in `test/admin-permissions.e2e-spec.ts`**

Read the file around line 60-70 first. Replace:

```typescript
    expect(res.body.some((p: { key: string }) => p.key === testKey)).toBe(true);
```

with:

```typescript
    expect(res.body.data.some((p: { key: string }) => p.key === testKey)).toBe(true);
```

(The second `GET /admin/permissions` call later in the file, around line 101-103, only asserts a `401` status with no body read — leave it untouched.)

- [ ] **Step 8: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-permissions.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 9: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/admin-rbac/dto/list-permissions-query.dto.ts src/admin-rbac/permission.service.ts src/admin-rbac/admin-permissions.controller.ts src/admin-rbac/permission.service.spec.ts test/admin-permissions.e2e-spec.ts
git commit -m "feat: paginate and search admin permissions list"
```

---

### Task 4: `admin/admins`

**Files:**
- Create: `src/admin-rbac/dto/list-admins-query.dto.ts`
- Modify: `src/admin-rbac/admin-role-assignment.service.ts`
- Modify: `src/admin-rbac/admin-role-assignment.controller.ts`
- Modify: `src/admin-rbac/admin-role-assignment.service.spec.ts`
- Modify: `test/admin-role-assignment.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1).
- Produces: `AdminRoleAssignmentService.listAdmins(filters?: ListAdminsFilters, pagination?): Promise<PaginatedResult<...>>` (the existing `select`-shaped admin summary, unchanged fields, just wrapped/paginated).

- [ ] **Step 1: Add new `listAdmins` filter/pagination tests**

Read `src/admin-rbac/admin-role-assignment.service.spec.ts` in full first. Add `count: jest.fn()` to the `adminUser` mock's type declaration and instantiation. The existing test `'listAdmins returns admins with roles included'` only checks the `select` shape, not the return value, so it still passes unmodified after this change — leave it as-is. Add these new tests right after it:

```typescript
  it('listAdmins filters by isActive and searches email/fullName', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    prisma.adminUser.count.mockResolvedValue(0);

    await service.listAdmins({ isActive: false, q: 'bello' });

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: false,
          OR: [
            { email: { contains: 'bello', mode: 'insensitive' } },
            { fullName: { contains: 'bello', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('listAdmins applies a createdAt date range', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    prisma.adminUser.count.mockResolvedValue(0);
    const createdFrom = new Date('2025-01-01');
    const createdTo = new Date('2025-12-31');

    await service.listAdmins({ createdFrom, createdTo });

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
    );
  });

  it('listAdmins computes skip/take from page and limit and reports the total', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    prisma.adminUser.count.mockResolvedValue(4);

    const result = await service.listAdmins({}, { page: 1, limit: 2 });

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 2 }));
    expect(result.meta).toEqual({ total: 4, page: 1, limit: 2, totalPages: 2 });
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx jest src/admin-rbac/admin-role-assignment.service.spec.ts -t listAdmins`
Expected: FAIL for the 3 new tests (the pre-existing one still passes).

- [ ] **Step 3: Create the query DTO**

Create `src/admin-rbac/dto/list-admins-query.dto.ts`:

```typescript
import { Transform } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListAdminsQueryDto extends PaginationDto {
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;

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

- [ ] **Step 4: Rewrite `AdminRoleAssignmentService.listAdmins`**

Add `import { Prisma } from '../generated/prisma/client';` and `import { buildPaginatedResult } from '../common/pagination/paginated-result';` to `src/admin-rbac/admin-role-assignment.service.ts`. Add near the top:

```typescript
export interface ListAdminsFilters {
  isActive?: boolean;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
}
```

Replace:

```typescript
  async listAdmins() {
    return this.prisma.adminUser.findMany({
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        createdAt: true,
        roles: { include: { role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
```

with:

```typescript
  async listAdmins(
    filters: ListAdminsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.AdminUserWhereInput = {
      isActive: filters.isActive,
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
      this.prisma.adminUser.findMany({
        where,
        select: {
          id: true,
          email: true,
          fullName: true,
          isActive: true,
          createdAt: true,
          roles: { include: { role: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.adminUser.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 5: Update `AdminRoleAssignmentController`**

Replace:

```typescript
  @Get()
  @RequirePermissions('roles:manage')
  list() {
    return this.adminRoleAssignmentService.listAdmins();
  }
```

with:

```typescript
  @Get()
  @RequirePermissions('roles:manage')
  list(@Query() query: ListAdminsQueryDto) {
    return this.adminRoleAssignmentService.listAdmins(
      {
        isActive: query.isActive,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add the imports `Query` (merge into the existing `@nestjs/common` import) and `import { ListAdminsQueryDto } from './dto/list-admins-query.dto';`.

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `npx jest src/admin-rbac/admin-role-assignment.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 7: Fix the three ripple e2e assertions in `test/admin-role-assignment.e2e-spec.ts`**

Read the file around lines 65-160 first. There are three separate `.get('/admin/admins')` calls, each followed by a `.find(...)` on the bare body. Replace each of these three lines:

```typescript
    const bootstrapEntry = res.body.find((a: { id: string }) => a.id === bootstrapAdminId);
```
```typescript
    const deactivatedEntry = listRes.body.find((a: { id: string }) => a.id === secondAdminId);
```
```typescript
    const reactivatedEntry = listRes.body.find((a: { id: string }) => a.id === secondAdminId);
```

with (same variable names, just insert `.data`):

```typescript
    const bootstrapEntry = res.body.data.find((a: { id: string }) => a.id === bootstrapAdminId);
```
```typescript
    const deactivatedEntry = listRes.body.data.find((a: { id: string }) => a.id === secondAdminId);
```
```typescript
    const reactivatedEntry = listRes.body.data.find((a: { id: string }) => a.id === secondAdminId);
```

- [ ] **Step 8: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-role-assignment.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 9: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/admin-rbac/dto/list-admins-query.dto.ts src/admin-rbac/admin-role-assignment.service.ts src/admin-rbac/admin-role-assignment.service.spec.ts src/admin-rbac/admin-role-assignment.controller.ts test/admin-role-assignment.e2e-spec.ts
git commit -m "feat: paginate and filter admin admins list"
```

---

### Task 5: `admin/roles`

**Files:**
- Create: `src/admin-rbac/dto/list-roles-query.dto.ts`
- Modify: `src/admin-rbac/role.service.ts`
- Modify: `src/admin-rbac/admin-roles.controller.ts`
- Modify: `src/admin-rbac/role.service.spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1).
- Produces: `RoleService.list(filters?: { q?: string }, pagination?): Promise<PaginatedResult<Role>>`.

- [ ] **Step 1: Confirm no existing e2e coverage to break**

Run: `grep -rn "get('/admin/roles'" test/*.e2e-spec.ts`
Expected: two hits (`test/admin-roles.e2e-spec.ts` doesn't call the list route at all — confirmed during planning; `test/admin-rbac.e2e-spec.ts` calls it once but only asserts a `200` status, never reads the body). No ripple fix needed for this endpoint.

- [ ] **Step 2: Add `list` tests**

Read `src/admin-rbac/role.service.spec.ts` in full first. Add `count: jest.fn()` to the `role` mock's type declaration and instantiation. Add:

```typescript
  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      prisma.role.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.role.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('searches by name', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      prisma.role.count.mockResolvedValue(0);

      await service.list({ q: 'reviewer' });

      expect(prisma.role.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: { contains: 'reviewer', mode: 'insensitive' } } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      prisma.role.count.mockResolvedValue(8);

      const result = await service.list({}, { page: 2, limit: 5 });

      expect(prisma.role.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
      expect(result.meta).toEqual({ total: 8, page: 2, limit: 5, totalPages: 2 });
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/admin-rbac/role.service.spec.ts -t list`
Expected: FAIL.

- [ ] **Step 4: Create the query DTO**

Create `src/admin-rbac/dto/list-roles-query.dto.ts`:

```typescript
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListRolesQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  q?: string;
}
```

- [ ] **Step 5: Rewrite `RoleService.list`**

Change `import { Role } from '../generated/prisma/client';` to `import { Role, Prisma } from '../generated/prisma/client';` and add `import { buildPaginatedResult } from '../common/pagination/paginated-result';`. Replace:

```typescript
  async list() {
    return this.prisma.role.findMany({
      include: ROLE_WITH_PERMISSIONS_INCLUDE,
      orderBy: { name: 'asc' },
    });
  }
```

with:

```typescript
  async list(
    filters: { q?: string } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.RoleWhereInput = {
      name: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        include: ROLE_WITH_PERMISSIONS_INCLUDE,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.role.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 6: Update `AdminRolesController`**

Replace:

```typescript
  @Get()
  @RequirePermissions('roles:manage')
  list() {
    return this.roleService.list();
  }
```

with:

```typescript
  @Get()
  @RequirePermissions('roles:manage')
  list(@Query() query: ListRolesQueryDto) {
    return this.roleService.list({ q: query.q }, { page: query.page, limit: query.limit });
  }
```

Add the imports `Query` (merge into the existing `@nestjs/common` import) and `import { ListRolesQueryDto } from './dto/list-roles-query.dto';`.

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/admin-rbac/role.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 8: Run the (unchanged) e2e file to confirm nothing broke**

Run: `npx jest --config ./test/jest-e2e.json test/admin-roles.e2e-spec.ts test/admin-rbac.e2e-spec.ts --runInBand`
Expected: PASS — no ripple was expected here, this is a confirmation run.

- [ ] **Step 9: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/admin-rbac/dto/list-roles-query.dto.ts src/admin-rbac/role.service.ts src/admin-rbac/role.service.spec.ts src/admin-rbac/admin-roles.controller.ts
git commit -m "feat: paginate and search admin roles list"
```

---

### Task 6: `admin/loan-terms`

**Files:**
- Create: `src/loan-terms/dto/list-admin-loan-terms-query.dto.ts`
- Modify: `src/loan-terms/loan-terms.service.ts`
- Modify: `src/loan-terms/admin-loan-terms.controller.ts`
- Modify: `src/loan-terms/loan-terms.service.spec.ts`
- Test: Create `test/admin-loan-terms.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1).
- Produces: `LoanTermOptionService.list(filters?: ListLoanTermsFilters, pagination?): Promise<PaginatedResult<LoanTermOption>>` — the sibling method `listActiveForClient` (used by `client/loan-terms`, out of scope until Wave 5) is untouched.

- [ ] **Step 1: Confirm no existing e2e coverage to break**

Run: `grep -rln "admin/loan-terms" test/*.e2e-spec.ts`
Expected: no results — confirmed during planning there's no e2e coverage anywhere of `GET`/`POST`/`PATCH /admin/loan-terms`.

- [ ] **Step 2: Rewrite the existing `list` tests and add new ones**

Read `src/loan-terms/loan-terms.service.spec.ts` in full first. Add `count: jest.fn()` to the `loanTermOption` mock's type declaration and instantiation. Replace the existing `describe('list', ...)` block:

```typescript
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
```

with:

```typescript
  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      prisma.loanTermOption.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: undefined, isActive: undefined }, skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by agency and isActive when provided', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      prisma.loanTermOption.count.mockResolvedValue(0);

      await service.list({ agency: 'NPF', isActive: true });

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: 'NPF', isActive: true } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      prisma.loanTermOption.count.mockResolvedValue(5);

      const result = await service.list({}, { page: 1, limit: 2 });

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 2 }));
      expect(result.meta).toEqual({ total: 5, page: 1, limit: 2, totalPages: 3 });
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/loan-terms/loan-terms.service.spec.ts -t list`
Expected: FAIL.

- [ ] **Step 4: Create the query DTO**

Create `src/loan-terms/dto/list-admin-loan-terms-query.dto.ts`:

```typescript
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListAdminLoanTermsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  agency?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;
}
```

- [ ] **Step 5: Rewrite `LoanTermOptionService.list`**

Change `import { LoanTermOption, ManagementChargeApplication, ManagementChargeType } from '../generated/prisma/client';` to `import { LoanTermOption, ManagementChargeApplication, ManagementChargeType, Prisma } from '../generated/prisma/client';` and add `import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';`. Add near the top:

```typescript
export interface ListLoanTermsFilters {
  agency?: string;
  isActive?: boolean;
}
```

Replace:

```typescript
  async list(agency?: string): Promise<LoanTermOption[]> {
    return this.prisma.loanTermOption.findMany({ where: { agency } });
  }
```

with:

```typescript
  async list(
    filters: ListLoanTermsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<LoanTermOption>> {
    const { page, limit } = pagination;
    const where: Prisma.LoanTermOptionWhereInput = {
      agency: filters.agency,
      isActive: filters.isActive,
    };

    const [data, total] = await Promise.all([
      this.prisma.loanTermOption.findMany({ where, skip: (page - 1) * limit, take: limit }),
      this.prisma.loanTermOption.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

Do NOT touch `listActiveForClient` in this same file — it's a different method, out of this task's and this wave's scope.

- [ ] **Step 6: Update `AdminLoanTermsController`**

Replace:

```typescript
  @Get()
  list(@Query('agency') agency?: string) {
    return this.loanTermOptionService.list(agency);
  }
```

with:

```typescript
  @Get()
  list(@Query() query: ListAdminLoanTermsQueryDto) {
    return this.loanTermOptionService.list(
      { agency: query.agency, isActive: query.isActive },
      { page: query.page, limit: query.limit },
    );
  }
```

Add the import `import { ListAdminLoanTermsQueryDto } from './dto/list-admin-loan-terms-query.dto';`.

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/loan-terms/loan-terms.service.spec.ts`
Expected: PASS — full file, including the untouched `listActiveForClient` tests.

- [ ] **Step 8: Write a new e2e test file**

Create `test/admin-loan-terms.e2e-spec.ts`. Reuse the exact `beforeAll` admin-login pattern from `test/admin-agents.e2e-spec.ts` (Task 1 of this same plan — `POST /auth/admin/login` with `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`). Structure:

```typescript
import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin loan terms list endpoint (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;

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

    await prisma.loanTermOption.createMany({
      data: [
        { agency: 'WAVE3-NPF', tenorMonths: 6, interestRatePercent: 5, managementChargeType: 'PERCENTAGE', managementChargeValue: 2, managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT', isActive: true },
        { agency: 'WAVE3-NPF', tenorMonths: 12, interestRatePercent: 6, managementChargeType: 'PERCENTAGE', managementChargeValue: 2, managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT', isActive: false },
        { agency: 'WAVE3-NSCDC', tenorMonths: 6, interestRatePercent: 5, managementChargeType: 'FLAT', managementChargeValue: 5000, managementChargeApplication: 'ADD_TO_REPAYMENT', isActive: true },
      ],
    });
  });

  afterAll(async () => {
    await prisma.loanTermOption.deleteMany({ where: { agency: { in: ['WAVE3-NPF', 'WAVE3-NSCDC'] } } });
    await app.close();
  });

  it('paginates GET /admin/loan-terms', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-terms?limit=2&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.meta.limit).toBe(2);
  });

  it('filters GET /admin/loan-terms by agency and isActive', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-terms')
      .query({ agency: 'WAVE3-NPF', isActive: 'true' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.every((t: { agency: string; isActive: boolean }) => t.agency === 'WAVE3-NPF' && t.isActive === true)).toBe(true);
    expect(res.body.meta.total).toBe(1);
  });
});
```

- [ ] **Step 9: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-loan-terms.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/loan-terms/dto/list-admin-loan-terms-query.dto.ts src/loan-terms/loan-terms.service.ts src/loan-terms/loan-terms.service.spec.ts src/loan-terms/admin-loan-terms.controller.ts test/admin-loan-terms.e2e-spec.ts
git commit -m "feat: paginate and filter admin loan-terms list"
```

---

### Task 7: README, Postman, and scoped test run

**Files:**
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: all six endpoints' new query params and `{ data, meta }` response shape from Tasks 1-6.

- [ ] **Step 1: Update the README**

For each of the six endpoints (`admin/agents`, `admin/invites`, `admin/permissions`, `admin/admins`, `admin/roles`, `admin/loan-terms`), find its existing documentation row/section in `README.md` and add: the new query params it accepts (per Tasks 1-6), and that its response is now `{ data: [...], meta: { total, page, limit, totalPages } }` instead of a bare array.

- [ ] **Step 2: Update Postman**

For each of the six endpoints, find its existing request(s) in the Postman collection (search for each route path). For each saved response example: wrap the list value in `{ "data": [...], "meta": { "total": N, "page": 1, "limit": 25, "totalPages": 1 } }` (computed from the example's own array length, same approach as prior waves). Add each endpoint's new filter/search/date-range query params as documented (disabled) example params, with values drawn from that endpoint's own filter table — e.g. `admin/agents` gets `status=APPROVED`, `q=Amaka`; `admin/invites` gets `status=PENDING`, `q=someone@example.com`; `admin/permissions` gets `q=audit`; `admin/admins` gets `isActive=true`, `q=bello`; `admin/roles` gets `q=reviewer`; `admin/loan-terms` gets `agency=NPF`, `isActive=true`. Check every `pm.test` script on these requests for any that reads the response as a bare array and update to `.data`. Use a surgical text-based/`Edit`-tool approach, never a full `json.load`/`json.dump` or `jq` whole-document rewrite — both Sub-project 1 and Wave 2 hit real, opposite-direction re-escaping bugs doing that (Python's `json.dump` re-escaped em-dashes into `\uXXXX`; `jq`'s default serializer re-escaped `\uXXXX` back into literal em-dash characters). Verify afterward with a byte-level check that literal `—`/`₦` counts in the file are unchanged from `HEAD`.

- [ ] **Step 3: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 4: Commit**

```bash
git add README.md postman/public-sector-backend.postman_collection.json
git commit -m "docs: document pagination/filtering for wave 3 admin list endpoints"
```

- [ ] **Step 5: Run the scoped test set (NOT the full suite — see Global Constraints)**

Run: `npx jest src/admin-agent-review src/admin-invite src/admin-rbac src/loan-terms`
Expected: PASS — every unit test touched by this plan.

Run: `npx jest --config ./test/jest-e2e.json test/admin-agents.e2e-spec.ts test/admin-invite.e2e-spec.ts test/admin-permissions.e2e-spec.ts test/admin-role-assignment.e2e-spec.ts test/admin-roles.e2e-spec.ts test/admin-rbac.e2e-spec.ts test/admin-loan-terms.e2e-spec.ts --runInBand`
Expected: PASS.

Do not run the full unit or e2e suite in this task — this plan is Sub-project 3 of 5; the full suite runs once, at the end of Sub-project 5.

## Exit criteria

- [ ] All six endpoints accept `page`/`limit` plus their own filter/search/date-range params, returning `{ data, meta }`.
- [ ] No existing e2e assertion anywhere in the suite still reads any of these six endpoints' responses as a bare array.
- [ ] Every service method changed in this plan was confirmed (via grep) to have exactly one caller before its return shape changed.
- [ ] README and Postman reflect all six endpoints' new query params and response shape.
