# List Pagination Wave 4 — Capped-But-Unpaged Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the shared pagination convention (Sub-project 1) to the three admin list endpoints that already have a hardcoded `take: 100` safety cap but no real `skip`-based paging past it: `admin/audit-logs`, `admin/clients`, `admin/documents/batches`.

**Architecture:** Each is a straightforward single-Prisma-model `findMany`+`count`, same pattern as Wave 3. The only difference from earlier waves: these three already have a `take: 100` today, which this plan replaces with the shared convention's default (`page=1`/`limit=25`, hard max `100`) — a deliberate reduction in default page size from 100 to 25, consistent with every other endpoint in this initiative, not a preserved special case.

**Tech Stack:** NestJS, Prisma, `class-validator`/`class-transformer`, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-list-pagination-filtering-design.md` (see its per-endpoint filter table)

## Global Constraints

- Every new query DTO extends `PaginationDto` from `src/common/pagination/pagination.dto.ts` (`page` default `1`, `limit` default `25`, hard max `100`).
- Every changed service method returns `PaginatedResult<T>` via `buildPaginatedResult()` from `src/common/pagination/paginated-result.ts`.
- Search fields use `q?: string`; a single-searchable-field endpoint filters that field directly, a multi-field endpoint uses `OR: [...]`.
- Date-range fields are field-specific `xFrom`/`xTo` ISO8601 pairs.
- Before changing any service method's return shape, grep the whole `src/` tree for other callers — already confirmed for all three methods in this plan (each has exactly one caller, its own controller), but re-confirm during execution.
- Before changing any endpoint's response shape, grep `test/*.e2e-spec.ts` for existing calls to that route — already catalogued per task below.
- **Concurrency/git-index note carried forward from Wave 3**: when multiple subagents share one working tree and git index, a bare `git commit -m "..."` with no pathspec can accidentally sweep in another task's staged-but-not-yet-committed files, and a stray `git reset` (even non-`--hard`) can transiently un-commit another task's work (recoverable via reflog, but disruptive). **Every task's commit step in this plan uses `git commit <explicit paths> -m "..."`, not a bare `git add` + `git commit`** — always stage and commit by explicit pathspec together, never rely on a separately-run `git add` still being the only thing staged by the time `git commit` executes.
- No `Co-Authored-By: Claude` trailer on any commit.
- This is Sub-project 4 of a 5-wave initiative. Per this project's scoped-test-runs convention, **do not run the full test suite in this plan's closing task** — only the tests for files this plan touches. The full suite runs once, at the true end of the whole initiative (after Sub-project 5).

---

### Task 1: `admin/audit-logs`

**Files:**
- Create: `src/admin-audit-log/dto/list-audit-logs-query.dto.ts`
- Modify: `src/audit/audit-log.service.ts`
- Modify: `src/admin-audit-log/admin-audit-log.controller.ts`
- Modify: `src/audit/audit-log.service.spec.ts`
- Modify: `test/audit-log.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1).
- Produces: `AuditLogService.list(filters?: ListAuditEventsFilters, pagination?): Promise<PaginatedResult<AuditLog>>`.

- [ ] **Step 1: Confirm the one caller and read the pagination utility**

Run: `grep -rn "auditLogService\.list(\|\.list(" src/admin-audit-log src/audit --include="*.ts"` — expect only `AdminAuditLogController`. Read `src/common/pagination/pagination.dto.ts` and `src/common/pagination/paginated-result.ts` first to confirm exact exported names before writing any import.

- [ ] **Step 2: Rewrite the existing `list` unit test and add new ones**

Read `src/audit/audit-log.service.spec.ts` in full first. Add `count: jest.fn()` to the `prisma.auditLog` mock's type declaration and instantiation. Replace the existing test:

```typescript
  it('lists entries filtered and ordered newest-first', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);

    await service.list({ actorType: AuditActorType.ADMIN });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        actorType: AuditActorType.ADMIN,
        action: undefined,
        targetType: undefined,
        targetId: undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });
```

with:

```typescript
  describe('list', () => {
    it('filters and orders newest-first, defaulting to page 1/limit 25', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      const result = await service.list({ actorType: AuditActorType.ADMIN });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          actorType: AuditActorType.ADMIN,
          action: undefined,
          targetType: undefined,
          targetId: undefined,
          createdAt: undefined,
        },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 25,
      });
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('applies a createdAt date range', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.list({ createdFrom, createdTo });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(40);

      const result = await service.list({}, { page: 2, limit: 20 });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
      expect(result.meta).toEqual({ total: 40, page: 2, limit: 20, totalPages: 2 });
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/audit/audit-log.service.spec.ts -t list`
Expected: FAIL.

- [ ] **Step 4: Create the query DTO**

Create `src/admin-audit-log/dto/list-audit-logs-query.dto.ts`:

```typescript
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AuditActorType } from '../../generated/prisma/client';

export class ListAuditLogsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(AuditActorType)
  actorType?: AuditActorType;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  targetType?: string;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

- [ ] **Step 5: Rewrite `AuditLogService.list`**

In `src/audit/audit-log.service.ts`, add `import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';`. Add `createdFrom`/`createdTo` to the existing `ListAuditEventsFilters` interface:

```typescript
export interface ListAuditEventsFilters {
  actorType?: AuditActorType;
  action?: string;
  targetType?: string;
  targetId?: string;
  createdFrom?: Date;
  createdTo?: Date;
}
```

Replace:

```typescript
  async list(filters: ListAuditEventsFilters): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: {
        actorType: filters.actorType,
        action: filters.action,
        targetType: filters.targetType,
        targetId: filters.targetId,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
```

with:

```typescript
  async list(
    filters: ListAuditEventsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<AuditLog>> {
    const { page, limit } = pagination;
    const where: Prisma.AuditLogWhereInput = {
      actorType: filters.actorType,
      action: filters.action,
      targetType: filters.targetType,
      targetId: filters.targetId,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.auditLog.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

(`Prisma` is already imported in this file — confirm via the existing `import { AuditActorType, AuditLog, Prisma } from '../generated/prisma/client';` line — no import change needed there.)

- [ ] **Step 6: Update `AdminAuditLogController`**

Replace:

```typescript
  @Get()
  @RequirePermissions('audit:read')
  list(
    @Query('actorType') actorType?: AuditActorType,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
  ) {
    return this.auditLogService.list({ actorType, action, targetType, targetId });
  }
```

with:

```typescript
  @Get()
  @RequirePermissions('audit:read')
  list(@Query() query: ListAuditLogsQueryDto) {
    return this.auditLogService.list(
      {
        actorType: query.actorType,
        action: query.action,
        targetType: query.targetType,
        targetId: query.targetId,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add the import `import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';` and drop the now-unused `AuditActorType` import from this controller file if nothing else in it uses it (check first).

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/audit/audit-log.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 8: Fix the ripple e2e assertions in `test/audit-log.e2e-spec.ts`**

Read the file around lines 65-85 first. Replace:

```typescript
    expect(res.body.length).toBeGreaterThan(0);
```

with:

```typescript
    expect(res.body.data.length).toBeGreaterThan(0);
```

and replace:

```typescript
    expect(res.body.every((entry: { action: string }) => entry.action === 'admin.invite.created')).toBe(true);
```

with:

```typescript
    expect(res.body.data.every((entry: { action: string }) => entry.action === 'admin.invite.created')).toBe(true);
```

- [ ] **Step 9: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/audit-log.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git commit src/admin-audit-log/dto/list-audit-logs-query.dto.ts src/audit/audit-log.service.ts src/admin-audit-log/admin-audit-log.controller.ts src/audit/audit-log.service.spec.ts test/audit-log.e2e-spec.ts -m "feat: paginate and filter admin audit-logs list"
```

(Use `git add <paths>` immediately followed by `git commit <same paths> -m "..."` — a single `git commit <paths>` invocation both stages and commits exactly those paths regardless of what else may be sitting in the shared index from a concurrent task, per this plan's Global Constraints.)

---

### Task 2: `admin/clients`

**Files:**
- Create: `src/admin-client-review/dto/list-clients-query.dto.ts`
- Modify: `src/admin-client-review/admin-client-review.service.ts`
- Modify: `src/admin-client-review/admin-client-review.controller.ts`
- Modify: `src/admin-client-review/admin-client-review.service.spec.ts`
- Modify: `test/admin-client-review.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1).
- Produces: `AdminClientReviewService.list(filters?: ListClientsFilters, pagination?): Promise<PaginatedResult<...>>` (the existing `{ ...client, onboarding }` row shape, unchanged, just wrapped/paginated).

- [ ] **Step 1: Confirm the one caller**

Run: `grep -rn "adminClientReviewService\.list(\|\.list(" src/admin-client-review --include="*.ts"` — expect only `AdminClientReviewController`.

- [ ] **Step 2: Rewrite the existing `list` unit tests and add new ones**

Read `src/admin-client-review/admin-client-review.service.spec.ts` in full first. Add `count: jest.fn()` to the `prisma.client` mock's type declaration and instantiation. Replace the existing `describe('list', ...)` block:

```typescript
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
```

with:

```typescript
  describe('list', () => {
    it('lists all clients with their onboarding record, defaulting to page 1/limit 25', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: undefined, phone: undefined, createdAt: undefined },
          include: { onboarding: true },
          skip: 0,
          take: 25,
        }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status and searches phone when given', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.list({ status: 'MANUAL_REVIEW' as never, q: '0801' });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'MANUAL_REVIEW',
            phone: { contains: '0801', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('applies a createdAt date range', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.list({ createdFrom, createdTo });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(60);

      const result = await service.list({}, { page: 3, limit: 25 });

      expect(prisma.client.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 25 }));
      expect(result.meta).toEqual({ total: 60, page: 3, limit: 25, totalPages: 3 });
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts -t list`
Expected: FAIL.

- [ ] **Step 4: Create the query DTO**

Create `src/admin-client-review/dto/list-clients-query.dto.ts`:

```typescript
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
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
}
```

- [ ] **Step 5: Rewrite `AdminClientReviewService.list`**

In `src/admin-client-review/admin-client-review.service.ts`, add `import { buildPaginatedResult } from '../common/pagination/paginated-result';`. Add near the top (after the `FailureReasons` interface):

```typescript
export interface ListClientsFilters {
  status?: ClientStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
}
```

Replace:

```typescript
  async list(status?: ClientStatus) {
    return this.prisma.client.findMany({
      where: status ? { status } : undefined,
      include: { onboarding: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
```

with:

```typescript
  async list(
    filters: ListClientsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.ClientWhereInput = {
      status: filters.status,
      phone: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        include: { onboarding: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.client.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

Change the import line `import { ClientStatus, OnboardingStep } from '../generated/prisma/client';` to `import { ClientStatus, OnboardingStep, Prisma } from '../generated/prisma/client';`.

- [ ] **Step 6: Update `AdminClientReviewController`**

Replace:

```typescript
  @Get()
  @RequirePermissions('clients:review')
  list(@Query('status') status?: ClientStatus) {
    return this.adminClientReviewService.list(status);
  }
```

with:

```typescript
  @Get()
  @RequirePermissions('clients:review')
  list(@Query() query: ListClientsQueryDto) {
    return this.adminClientReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add the import `import { ListClientsQueryDto } from './dto/list-clients-query.dto';`. Note this controller's `findOne`/other methods still use `ClientStatus` — do not remove that import.

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 8: Fix the ripple e2e assertion in `test/admin-client-review.e2e-spec.ts`**

Read the file around lines 70-80 first. Replace:

```typescript
    expect(res.body.some((c: { id: string }) => c.id === clientId)).toBe(true);
```

with:

```typescript
    expect(res.body.data.some((c: { id: string }) => c.id === clientId)).toBe(true);
```

- [ ] **Step 9: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-client-review.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git commit src/admin-client-review/dto/list-clients-query.dto.ts src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.controller.ts src/admin-client-review/admin-client-review.service.spec.ts test/admin-client-review.e2e-spec.ts -m "feat: paginate and filter admin clients list"
```

---

### Task 3: `admin/documents/batches`

**Files:**
- Create: `src/document-ingestion/dto/list-document-batches-query.dto.ts`
- Modify: `src/document-ingestion/document-batch.service.ts`
- Modify: `src/document-ingestion/admin-documents.controller.ts`
- Modify: `src/document-ingestion/document-batch.service.spec.ts`
- Modify: `test/document-upload.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1).
- Produces: `DocumentBatchService.list(filters?: ListBatchesFilters, pagination?): Promise<PaginatedResult<DocumentUploadBatch>>`.

- [ ] **Step 1: Confirm the one caller**

Run: `grep -rn "documentBatchService\.list(\|\.list(" src/document-ingestion --include="*.ts"` — expect only `AdminDocumentsController`.

- [ ] **Step 2: Rewrite the existing `list` unit test and add new ones**

Read `src/document-ingestion/document-batch.service.spec.ts` in full first. Add `count: jest.fn()` to the `prisma.documentUploadBatch` mock's type declaration and instantiation. Replace the existing test:

```typescript
  it('list filters by documentType and status, ordered newest first', async () => {
    prisma.documentUploadBatch.findMany.mockResolvedValue([]);
    await service.list({ documentType: DocumentType.DISBURSED_LOANS, status: DocumentBatchStatus.COMPLETED });
    expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith({
      where: { documentType: DocumentType.DISBURSED_LOANS, status: DocumentBatchStatus.COMPLETED },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });
});
```

with:

```typescript
  describe('list', () => {
    it('filters by documentType and status, ordered newest first, defaulting to page 1/limit 25', async () => {
      prisma.documentUploadBatch.findMany.mockResolvedValue([]);
      prisma.documentUploadBatch.count.mockResolvedValue(0);

      const result = await service.list({ documentType: DocumentType.DISBURSED_LOANS, status: DocumentBatchStatus.COMPLETED });

      expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith({
        where: {
          documentType: DocumentType.DISBURSED_LOANS,
          status: DocumentBatchStatus.COMPLETED,
          createdAt: undefined,
          completedAt: undefined,
          OR: undefined,
        },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 25,
      });
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('searches originalFileName and period', async () => {
      prisma.documentUploadBatch.findMany.mockResolvedValue([]);
      prisma.documentUploadBatch.count.mockResolvedValue(0);

      await service.list({ q: '2026-01' });

      expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { originalFileName: { contains: '2026-01', mode: 'insensitive' } },
              { period: { contains: '2026-01', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies createdAt and completedAt date ranges independently', async () => {
      prisma.documentUploadBatch.findMany.mockResolvedValue([]);
      prisma.documentUploadBatch.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const completedTo = new Date('2025-06-01');

      await service.list({ createdFrom, completedTo });

      expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: createdFrom, lte: undefined },
            completedAt: { gte: undefined, lte: completedTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.documentUploadBatch.findMany.mockResolvedValue([]);
      prisma.documentUploadBatch.count.mockResolvedValue(12);

      const result = await service.list({}, { page: 2, limit: 5 });

      expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
      expect(result.meta).toEqual({ total: 12, page: 2, limit: 5, totalPages: 3 });
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/document-ingestion/document-batch.service.spec.ts -t list`
Expected: FAIL.

- [ ] **Step 4: Create the query DTO**

Create `src/document-ingestion/dto/list-document-batches-query.dto.ts`:

```typescript
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { DocumentBatchStatus, DocumentType } from '../../generated/prisma/client';

export class ListDocumentBatchesQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  @IsOptional()
  @IsEnum(DocumentBatchStatus)
  status?: DocumentBatchStatus;

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
  completedFrom?: string;

  @IsOptional()
  @IsISO8601()
  completedTo?: string;
}
```

- [ ] **Step 5: Rewrite `DocumentBatchService.list`**

In `src/document-ingestion/document-batch.service.ts`, change `import { DocumentBatchStatus, DocumentType } from '../generated/prisma/client';` to `import { DocumentBatchStatus, DocumentType, Prisma } from '../generated/prisma/client';` and add `import { buildPaginatedResult } from '../common/pagination/paginated-result';`. Add to the existing `ListBatchesFilters` interface:

```typescript
export interface ListBatchesFilters {
  documentType?: DocumentType;
  status?: DocumentBatchStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  completedFrom?: Date;
  completedTo?: Date;
}
```

Replace:

```typescript
  async list(filters: ListBatchesFilters) {
    return this.prisma.documentUploadBatch.findMany({
      where: { documentType: filters.documentType, status: filters.status },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
```

with:

```typescript
  async list(
    filters: ListBatchesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.DocumentUploadBatchWhereInput = {
      documentType: filters.documentType,
      status: filters.status,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      completedAt:
        filters.completedFrom || filters.completedTo
          ? { gte: filters.completedFrom, lte: filters.completedTo }
          : undefined,
      OR: filters.q
        ? [
            { originalFileName: { contains: filters.q, mode: 'insensitive' } },
            { period: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.documentUploadBatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.documentUploadBatch.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 6: Update `AdminDocumentsController`**

Replace:

```typescript
  @Get('batches')
  @RequirePermissions('documents:read')
  listBatches(
    @Query('documentType') documentType?: DocumentType,
    @Query('status') status?: DocumentBatchStatus,
  ) {
    return this.documentBatchService.list({ documentType, status });
  }
```

with:

```typescript
  @Get('batches')
  @RequirePermissions('documents:read')
  listBatches(@Query() query: ListDocumentBatchesQueryDto) {
    return this.documentBatchService.list(
      {
        documentType: query.documentType,
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        completedFrom: query.completedFrom ? new Date(query.completedFrom) : undefined,
        completedTo: query.completedTo ? new Date(query.completedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add the import `import { ListDocumentBatchesQueryDto } from './dto/list-document-batches-query.dto';`. `DocumentBatchStatus`/`DocumentType` are still used elsewhere in this controller (`createAndEnqueue`'s parameter type, the three upload endpoints) — do not remove that import.

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/document-ingestion/document-batch.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 8: Fix the ripple e2e assertion in `test/document-upload.e2e-spec.ts`**

Read the file around lines 110-120 first. Replace:

```typescript
    expect(listRes.body.length).toBeGreaterThan(0);
```

with:

```typescript
    expect(listRes.body.data.length).toBeGreaterThan(0);
```

- [ ] **Step 9: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/document-upload.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git commit src/document-ingestion/dto/list-document-batches-query.dto.ts src/document-ingestion/document-batch.service.ts src/document-ingestion/admin-documents.controller.ts src/document-ingestion/document-batch.service.spec.ts test/document-upload.e2e-spec.ts -m "feat: paginate and filter admin document batches list"
```

---

### Task 4: README, Postman, and scoped test run

**Files:**
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: all three endpoints' new query params and `{ data, meta }` response shape from Tasks 1-3.

- [ ] **Step 1: Update the README**

For each of the three endpoints (`admin/audit-logs`, `admin/clients`, `admin/documents/batches`), find its existing documentation row/section in `README.md` and add: the new query params it accepts (per Tasks 1-3), that its default page size dropped from an unpaged 100-row cap to `page=1`/`limit=25` (max `100`), and that its response is now `{ data: [...], meta: { total, page, limit, totalPages } }` instead of a bare array.

- [ ] **Step 2: Update Postman**

For each of the three endpoints, find its existing request(s) in the Postman collection. For each saved response example: wrap the list value in `{ "data": [...], "meta": { "total": N, "page": 1, "limit": 25, "totalPages": 1 } }` (computed from the example's own array length). Add each endpoint's new filter/search/date-range query params as documented (disabled) example params — `admin/audit-logs` gets `createdFrom=2026-01-01`, `createdTo=2026-12-31`; `admin/clients` gets `q=0801`, `createdFrom=2026-01-01`; `admin/documents/batches` gets `q=2026-01`, `createdFrom=2026-01-01`, `completedFrom=2026-01-01`. Check every `pm.test` script on these requests for any that reads the response as a bare array or sets a chained collection variable from one — trace carefully, the same way Wave 3's closing task did for `admin/roles`/`admin/agents` (both had load-bearing `pm.test` scripts feeding later requests). Use a surgical text-based/`Edit`-tool approach only, never a full `json.load`/`json.dump` or `jq` whole-document rewrite. Verify afterward with a byte-level check that literal `—`/`₦` counts in the file are unchanged from `HEAD`.

- [ ] **Step 3: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 4: Commit**

```bash
git commit README.md postman/public-sector-backend.postman_collection.json -m "docs: document pagination/filtering for wave 4 admin list endpoints"
```

- [ ] **Step 5: Run the scoped test set (NOT the full suite — see Global Constraints)**

Run: `npx jest src/admin-audit-log src/audit src/admin-client-review src/document-ingestion`
Expected: PASS — every unit test touched by this plan.

Run: `npx jest --config ./test/jest-e2e.json test/audit-log.e2e-spec.ts test/admin-client-review.e2e-spec.ts test/document-upload.e2e-spec.ts --runInBand`
Expected: PASS.

Do not run the full unit or e2e suite in this task — this plan is Sub-project 4 of 5; the full suite runs once, at the end of Sub-project 5.

## Exit criteria

- [ ] All three endpoints accept `page`/`limit` plus their own filter/search/date-range params, returning `{ data, meta }`, with the old unpaged `take: 100` safety cap fully replaced.
- [ ] No existing e2e assertion anywhere in the suite still reads any of these three endpoints' responses as a bare array.
- [ ] Every service method changed in this plan was confirmed (via grep) to have exactly one caller before its return shape changed.
- [ ] README and Postman reflect all three endpoints' new query params and response shape.
