# List Pagination Wave 2 — Unbounded Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the shared pagination convention (from Sub-project 1) to the five highest-risk, fully-unbounded list endpoints: `admin/ippis-records`, `admin/loans`, `admin/loan-requests`, `admin/reconciliation`, and `admin/clients/:id/activities`.

**Architecture:** Each endpoint's query DTO extends `PaginationDto`. The three DB-backed endpoints (`admin/ippis-records`, `admin/loans`, `admin/loan-requests`, `admin/reconciliation` — four, not three) run a real Prisma `skip`/`take` + parallel `count()` against the same `where` clause. `admin/clients/:id/activities` is a merged, in-memory list (built from `AuditLog`/`LoanRequest`/`Session`/`WalletEntry`/onboarding, not one Prisma model) so its `type`/date filters and pagination are applied to the already-sorted in-memory array, the same way Sub-project 1 handled `ClientLoansService.getDashboard`'s in-memory status filter.

**Tech Stack:** NestJS, Prisma, `class-validator`/`class-transformer`, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-list-pagination-filtering-design.md` (see its per-endpoint filter table)

## Global Constraints

- Every new query DTO extends `PaginationDto` from `src/common/pagination/pagination.dto.ts` (Sub-project 1, already shipped — `page` default `1`, `limit` default `25`, hard max `100`).
- Every changed service method returns `PaginatedResult<T>` (`{ data: T[], meta: { total, page, limit, totalPages } }`) via `buildPaginatedResult()` from `src/common/pagination/paginated-result.ts` (Sub-project 1).
- Search fields use `q?: string`, translated to a case-insensitive Prisma `OR: [...]` across that endpoint's searchable text fields (per the spec's filter table).
- Date-range fields are field-specific `xFrom`/`xTo` ISO8601 pairs, never a single generic `from`/`to`.
- Before changing any service method's return shape, grep the whole `src/` tree for other callers of that method — a paginated envelope is a breaking change for any consumer expecting a bare array (Sub-project 1 hit exactly this with `ClientLoansService.getDashboard`, silently breaking an internal eligibility check; see `project_list_pagination_convention` memory).
- Before changing any endpoint's response shape, grep `test/*.e2e-spec.ts` for existing calls to that route — several already have assertions elsewhere in the suite that read the response as a bare array and will break.
- No `Co-Authored-By: Claude` trailer on any commit.
- This is Sub-project 2 of a 5-wave initiative. Per this project's scoped-test-runs convention, **do not run the full test suite in this plan's closing task** — only the tests for files this plan touches. The full suite runs once, at the true end of the whole initiative (after Sub-project 5).

---

### Task 1: Admin Catalog — `admin/ippis-records` and `admin/loans`

**Files:**
- Create: `src/admin-catalog/dto/list-ippis-records-query.dto.ts`
- Create: `src/admin-catalog/dto/list-admin-loans-query.dto.ts`
- Modify: `src/admin-catalog/admin-catalog.service.ts`
- Modify: `src/admin-catalog/admin-ippis-records.controller.ts`
- Modify: `src/admin-catalog/admin-loans.controller.ts`
- Test: `src/admin-catalog/admin-catalog.service.spec.ts`
- Test: Create `test/admin-catalog.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult`/`PaginatedResult` (Sub-project 1).
- Produces: `AdminCatalogService.listLoans(filters?: ListLoansFilters, pagination?): Promise<PaginatedResult<Loan>>`, `AdminCatalogService.listIppisRecords(filters?: ListIppisRecordsFilters, pagination?): Promise<PaginatedResult<IppisRecord>>`.

- [ ] **Step 1: Confirm there's no existing e2e coverage to break**

Run: `grep -rn "admin/ippis-records\|'/admin/loans'\|\"/admin/loans\"" test/*.e2e-spec.ts`
Expected: no results — confirmed during planning that no e2e file currently exercises either route, so this task's new e2e file is the first coverage, not a ripple fix.

- [ ] **Step 2: Update the existing unit tests**

Read `src/admin-catalog/admin-catalog.service.spec.ts` in full first (it's short — 48 lines). Replace its entire contents:

```typescript
import { AdminCatalogService } from './admin-catalog.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminCatalogService', () => {
  let service: AdminCatalogService;
  let prisma: {
    loan: { findMany: jest.Mock; count: jest.Mock };
    ippisRecord: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      loan: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      ippisRecord: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    service = new AdminCatalogService(prisma as unknown as PrismaService);
  });

  describe('listLoans', () => {
    it('lists every loan when no filters are given, defaulting to page 1/limit 25', async () => {
      const result = await service.listLoans();
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agency: undefined, product: undefined }), skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by agency and product when given', async () => {
      await service.listLoans({ agency: 'NPF', product: 'Salary Advance' });
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agency: 'NPF', product: 'Salary Advance' }) }),
      );
    });

    it('applies a case-insensitive search across customerName, accountNumber, and ippisNumber', async () => {
      await service.listLoans({ q: 'okoro' });
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { customerName: { contains: 'okoro', mode: 'insensitive' } },
              { accountNumber: { contains: 'okoro', mode: 'insensitive' } },
              { ippisNumber: { contains: 'okoro', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies the disbursement date range filter', async () => {
      const disbursedFrom = new Date('2025-01-01');
      const disbursedTo = new Date('2025-12-31');
      await service.listLoans({ disbursedFrom, disbursedTo });
      expect(prisma.loan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ disbursementDate: { gte: disbursedFrom, lte: disbursedTo } }) }),
      );
    });

    it('computes skip/take from page and limit', async () => {
      prisma.loan.count.mockResolvedValue(53);
      const result = await service.listLoans({}, { page: 3, limit: 20 });
      expect(prisma.loan.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }));
      expect(result.meta).toEqual({ total: 53, page: 3, limit: 20, totalPages: 3 });
    });
  });

  describe('listIppisRecords', () => {
    it('lists every record when no filters are given, defaulting to page 1/limit 25', async () => {
      const result = await service.listIppisRecords();
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ agency: undefined }), skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by agency, employeeStatus, department, and grade when given', async () => {
      await service.listIppisRecords({ agency: 'NSCDC', employeeStatus: 'ACTIVE', department: 'Finance', grade: 'GL-10' });
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ agency: 'NSCDC', employeeStatus: 'ACTIVE', department: 'Finance', grade: 'GL-10' }),
        }),
      );
    });

    it('applies a case-insensitive search across employeeName and staffId', async () => {
      await service.listIppisRecords({ q: 'chidi' });
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { employeeName: { contains: 'chidi', mode: 'insensitive' } },
              { staffId: { contains: 'chidi', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies the hireDate range filter', async () => {
      const hireDateFrom = new Date('2010-01-01');
      const hireDateTo = new Date('2020-01-01');
      await service.listIppisRecords({ hireDateFrom, hireDateTo });
      expect(prisma.ippisRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ hireDate: { gte: hireDateFrom, lte: hireDateTo } }) }),
      );
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/admin-catalog/admin-catalog.service.spec.ts`
Expected: FAIL — `listLoans`/`listIppisRecords` don't accept these params yet, `count` isn't called.

- [ ] **Step 4: Create the two query DTOs**

Create `src/admin-catalog/dto/list-ippis-records-query.dto.ts`:

```typescript
import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListIppisRecordsQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  agency?: string;

  @IsOptional()
  @IsString()
  employeeStatus?: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  grade?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  hireDateFrom?: string;

  @IsOptional()
  @IsISO8601()
  hireDateTo?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

Create `src/admin-catalog/dto/list-admin-loans-query.dto.ts`:

```typescript
import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListAdminLoansQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  agency?: string;

  @IsOptional()
  @IsString()
  product?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601()
  disbursedFrom?: string;

  @IsOptional()
  @IsISO8601()
  disbursedTo?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

- [ ] **Step 5: Rewrite `AdminCatalogService`**

Replace the full contents of `src/admin-catalog/admin-catalog.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

export interface ListLoansFilters {
  agency?: string;
  product?: string;
  q?: string;
  disbursedFrom?: Date;
  disbursedTo?: Date;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface ListIppisRecordsFilters {
  agency?: string;
  employeeStatus?: string;
  department?: string;
  grade?: string;
  q?: string;
  hireDateFrom?: Date;
  hireDateTo?: Date;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class AdminCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listLoans(
    filters: ListLoansFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.LoanWhereInput = {
      agency: filters.agency,
      product: filters.product,
      disbursementDate:
        filters.disbursedFrom || filters.disbursedTo
          ? { gte: filters.disbursedFrom, lte: filters.disbursedTo }
          : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      OR: filters.q
        ? [
            { customerName: { contains: filters.q, mode: 'insensitive' } },
            { accountNumber: { contains: filters.q, mode: 'insensitive' } },
            { ippisNumber: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.loan.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.loan.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async listIppisRecords(
    filters: ListIppisRecordsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.IppisRecordWhereInput = {
      agency: filters.agency,
      employeeStatus: filters.employeeStatus,
      department: filters.department,
      grade: filters.grade,
      hireDate:
        filters.hireDateFrom || filters.hireDateTo
          ? { gte: filters.hireDateFrom, lte: filters.hireDateTo }
          : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      OR: filters.q
        ? [
            { employeeName: { contains: filters.q, mode: 'insensitive' } },
            { staffId: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.ippisRecord.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.ippisRecord.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
}
```

- [ ] **Step 6: Update the two controllers**

Replace the full contents of `src/admin-catalog/admin-ippis-records.controller.ts`:

```typescript
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AdminCatalogService } from './admin-catalog.service';
import { ListIppisRecordsQueryDto } from './dto/list-ippis-records-query.dto';

@Controller('admin/ippis-records')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminIppisRecordsController {
  constructor(private readonly adminCatalogService: AdminCatalogService) {}

  @Get()
  @RequirePermissions('ippis:upload')
  list(@Query() query: ListIppisRecordsQueryDto) {
    return this.adminCatalogService.listIppisRecords(
      {
        agency: query.agency,
        employeeStatus: query.employeeStatus,
        department: query.department,
        grade: query.grade,
        q: query.q,
        hireDateFrom: query.hireDateFrom ? new Date(query.hireDateFrom) : undefined,
        hireDateTo: query.hireDateTo ? new Date(query.hireDateTo) : undefined,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}
```

Replace the full contents of `src/admin-catalog/admin-loans.controller.ts`:

```typescript
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AdminCatalogService } from './admin-catalog.service';
import { ListAdminLoansQueryDto } from './dto/list-admin-loans-query.dto';

@Controller('admin/loans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminLoansController {
  constructor(private readonly adminCatalogService: AdminCatalogService) {}

  @Get()
  @RequirePermissions('loans:upload')
  list(@Query() query: ListAdminLoansQueryDto) {
    return this.adminCatalogService.listLoans(
      {
        agency: query.agency,
        product: query.product,
        q: query.q,
        disbursedFrom: query.disbursedFrom ? new Date(query.disbursedFrom) : undefined,
        disbursedTo: query.disbursedTo ? new Date(query.disbursedTo) : undefined,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}
```

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/admin-catalog/admin-catalog.service.spec.ts`
Expected: PASS (10/10).

- [ ] **Step 8: Write a new e2e test file**

Create `test/admin-catalog.e2e-spec.ts`. Read `test/reconciliation.e2e-spec.ts`'s top-level `beforeAll` first to copy this repo's exact pattern for admin login and document-batch upload (ingesting a `Loan`/`IppisRecord` requires the document-ingestion pipeline — there is no direct Prisma seed shortcut used elsewhere in this codebase's e2e tests for these two models; confirm by reading how `reconciliation.e2e-spec.ts` gets its `Loan`/`IppisRecord` rows into the DB, which is via uploading a document batch and polling `waitForBatchCompletion`, and reuse that exact helper and upload fixture). Structure:

```typescript
import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin catalog list endpoints (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;

    await prisma.ippisRecord.createMany({
      data: [
        { agency: 'NPF', staffId: 'CAT-001', employeeName: 'Amaka Test', employeeStatus: 'ACTIVE', department: 'Finance', grade: 'GL-08', hireDate: new Date('2015-06-01') },
        { agency: 'NPF', staffId: 'CAT-002', employeeName: 'Bello Test', employeeStatus: 'RETIRED', department: 'Operations', grade: 'GL-12', hireDate: new Date('2005-03-01') },
      ],
    });
    await prisma.loan.createMany({
      data: [
        {
          customerId: 'cat-loan-001', customerName: 'Amaka Test', accountNumber: '1000000001', ippisNumber: 'CAT-001',
          agency: 'NPF', loanAmount: 100000, principalBalance: 50000, disbursementDate: new Date('2025-01-01'),
          maturationDate: new Date('2026-01-01'), product: 'Salary Advance', interestRatePercent: 5,
        },
        {
          customerId: 'cat-loan-002', customerName: 'Bello Test', accountNumber: '1000000002', ippisNumber: 'CAT-002',
          agency: 'NSCDC', loanAmount: 200000, principalBalance: 100000, disbursementDate: new Date('2025-06-01'),
          maturationDate: new Date('2026-06-01'), product: 'Consolidation', interestRatePercent: 5,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.loan.deleteMany({ where: { customerId: { in: ['cat-loan-001', 'cat-loan-002'] } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { in: ['CAT-001', 'CAT-002'] } } });
    await app.close();
  });

  it('paginates GET /admin/ippis-records', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/ippis-records?limit=1&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.body.meta.limit).toBe(1);
  });

  it('filters GET /admin/ippis-records by employeeStatus and searches by q', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/ippis-records')
      .query({ employeeStatus: 'ACTIVE', q: 'Amaka' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.some((r: { staffId: string }) => r.staffId === 'CAT-001')).toBe(true);
    expect(res.body.data.every((r: { employeeStatus: string }) => r.employeeStatus === 'ACTIVE')).toBe(true);
  });

  it('paginates GET /admin/loans', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loans?limit=1&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.body.meta.limit).toBe(1);
  });

  it('filters GET /admin/loans by agency and searches by q', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loans')
      .query({ agency: 'NSCDC', q: 'Bello' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.some((l: { customerId: string }) => l.customerId === 'cat-loan-002')).toBe(true);
    expect(res.body.data.every((l: { agency: string }) => l.agency === 'NSCDC')).toBe(true);
  });
});
```

Before finalizing, read `test/reconciliation.e2e-spec.ts` and one other existing e2e file's `beforeAll` to confirm the exact admin-login request shape and env var names used for the seed admin (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` above are illustrative — use whatever this codebase's e2e tests actually use, matching the established pattern exactly).

- [ ] **Step 9: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-catalog.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/admin-catalog/ test/admin-catalog.e2e-spec.ts
git commit -m "feat: paginate and filter admin ippis-records and loans lists"
```

---

### Task 2: `admin/loan-requests`

**Files:**
- Create: `src/loan-request/dto/list-admin-loan-requests-query.dto.ts`
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/admin-loan-request.controller.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`
- Modify: `test/loan-origination.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult`/`PaginatedResult` (Sub-project 1).
- Produces: `LoanRequestService.listAll(filters?: ListAdminLoanRequestsFilters, pagination?): Promise<PaginatedResult<LoanRequest>>` — this replaces the old 3-positional-arg `listAll(status?, type?, clientId?)` signature. Confirmed via `grep -rn "\.listAll("  src --include="*.ts"` that `AdminLoanRequestController` is the only caller.

- [ ] **Step 1: Update the shared prisma mock in `loan-request.service.spec.ts`**

Read `src/loan-request/loan-request.service.spec.ts` in full first (it's 750+ lines and shared across many methods — only touch what's described here). Add `count: jest.fn()` to the `loanRequest` mock's type declaration (near line 17-24, in the `loanRequest: { ... }` type block) and to its instantiation in `beforeEach` (near line 47-53, the `loanRequest: { ... }` object). Do not touch any other part of this file yet.

- [ ] **Step 2: Rewrite the three existing `listAll` tests to fail against the new signature**

Find and replace the `describe('listAll', ...)` block (currently ~line 348-356):

```typescript
  describe('listAll', () => {
    it('filters by status when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);
      await service.listAll({ status: 'CONFIRMED' as never });
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'CONFIRMED' }) }),
      );
    });
  });
```

Find and replace the `describe('listAll with a type filter', ...)` block (currently ~line 521-539):

```typescript
  describe('listAll with a type filter', () => {
    it('filters by type when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);
      await service.listAll({ type: 'TOPUP' as never });
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: undefined, type: 'TOPUP' }) }),
      );
    });

    it('filters by clientId when provided', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);
      await service.listAll({ clientId: 'client-1' });
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: undefined, type: undefined, clientId: 'client-1' }) }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(7);
      const result = await service.listAll({}, { page: 2, limit: 5 });
      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
      expect(result.meta).toEqual({ total: 7, page: 2, limit: 5, totalPages: 2 });
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts -t listAll`
Expected: FAIL — `listAll` doesn't accept an object/pagination yet, `count` isn't called.

- [ ] **Step 4: Create the query DTO**

Create `src/loan-request/dto/list-admin-loan-requests-query.dto.ts`:

```typescript
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { LoanRequestStatus, LoanRequestType } from '../../generated/prisma/client';

export class ListAdminLoanRequestsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(LoanRequestStatus)
  status?: LoanRequestStatus;

  @IsOptional()
  @IsEnum(LoanRequestType)
  type?: LoanRequestType;

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @IsOptional()
  @IsISO8601()
  disbursedFrom?: string;

  @IsOptional()
  @IsISO8601()
  disbursedTo?: string;
}
```

- [ ] **Step 5: Rewrite `LoanRequestService.listAll`**

In `src/loan-request/loan-request.service.ts`, find the existing method:

```typescript
  async listAll(status?: LoanRequestStatus, type?: LoanRequestType, clientId?: string) {
    return this.prisma.loanRequest.findMany({ where: { status, type, clientId }, orderBy: { createdAt: 'desc' } });
  }
```

Replace it with (add the `buildPaginatedResult` import at the top of the file alongside the other imports if not already present):

```typescript
  async listAll(
    filters: {
      status?: LoanRequestStatus;
      type?: LoanRequestType;
      clientId?: string;
      createdFrom?: Date;
      createdTo?: Date;
      disbursedFrom?: Date;
      disbursedTo?: Date;
    } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where = {
      status: filters.status,
      type: filters.type,
      clientId: filters.clientId,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      disbursedAt:
        filters.disbursedFrom || filters.disbursedTo
          ? { gte: filters.disbursedFrom, lte: filters.disbursedTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.loanRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.loanRequest.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 6: Update `AdminLoanRequestController`**

In `src/loan-request/admin-loan-request.controller.ts`, replace:

```typescript
  @Get()
  list(@Query('status') status?: LoanRequestStatus, @Query('type') type?: LoanRequestType, @Query('clientId') clientId?: string) {
    return this.loanRequestService.listAll(status, type, clientId);
  }
```

with:

```typescript
  @Get()
  list(@Query() query: ListAdminLoanRequestsQueryDto) {
    return this.loanRequestService.listAll(
      {
        status: query.status,
        type: query.type,
        clientId: query.clientId,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        disbursedFrom: query.disbursedFrom ? new Date(query.disbursedFrom) : undefined,
        disbursedTo: query.disbursedTo ? new Date(query.disbursedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add the import `import { ListAdminLoanRequestsQueryDto } from './dto/list-admin-loan-requests-query.dto';` and remove the now-unused `LoanRequestStatus, LoanRequestType` import members if nothing else in this controller file still references them (check first — `AuditActorType` is still used elsewhere in the same import statement, so only drop the two now-unused names, not the whole import line).

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — the full 750+-line spec file, not just the `listAll` tests, since this file is shared across many `LoanRequestService` methods and Step 1's mock-shape change must not break any of them.

- [ ] **Step 8: Fix the ripple e2e assertion in `loan-origination.e2e-spec.ts`**

Read `test/loan-origination.e2e-spec.ts` around line 109-112 first. Replace:

```typescript
      const listRes = await request(app.getHttpServer())
        .get('/admin/loan-requests?status=CONFIRMED')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(listRes.body.some((lr: { id: string }) => lr.id === loanRequestId)).toBe(true);
```

with:

```typescript
      const listRes = await request(app.getHttpServer())
        .get('/admin/loan-requests?status=CONFIRMED')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(listRes.body.data.some((lr: { id: string }) => lr.id === loanRequestId)).toBe(true);
```

- [ ] **Step 9: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/loan-origination.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/loan-request/dto/list-admin-loan-requests-query.dto.ts src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts src/loan-request/admin-loan-request.controller.ts test/loan-origination.e2e-spec.ts
git commit -m "feat: paginate and filter admin loan-requests list"
```

---

### Task 3: `admin/reconciliation`

**Files:**
- Create: `src/reconciliation/dto/list-reconciliation-query.dto.ts`
- Modify: `src/reconciliation/reconciliation.service.ts`
- Modify: `src/reconciliation/admin-reconciliation.controller.ts`
- Modify: `src/reconciliation/reconciliation.service.spec.ts`
- Modify: `test/reconciliation.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult`/`PaginatedResult` (Sub-project 1).
- Produces: `ReconciliationService.list(filters?: ReconciliationFilters, pagination?): Promise<PaginatedResult<RepaymentVariance>>`.

- [ ] **Step 1: Confirm there's only one caller of `list`**

Run: `grep -rn "reconciliationService\.list(\|\.list(" src/reconciliation --include="*.ts"`
Expected: only `admin-reconciliation.controller.ts` calls it.

- [ ] **Step 2: Update the existing unit test**

In `src/reconciliation/reconciliation.service.spec.ts`, add `count: jest.fn()` to the `repaymentVariance` mock's type declaration and instantiation (near the top of the file, in the `prisma` object). Replace the existing `describe('list', ...)` block:

```typescript
  describe('list', () => {
    it('applies agency, status, and period filters', async () => {
      prisma.repaymentVariance.findMany.mockResolvedValue([]);
      prisma.repaymentVariance.count.mockResolvedValue(0);

      await service.list({ agency: 'NPF', status: VarianceStatus.UNDER_PAID, period: '2025-01' });

      expect(prisma.repaymentVariance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: VarianceStatus.UNDER_PAID, period: '2025-01', loan: { agency: 'NPF' }, generatedAt: undefined },
        }),
      );
    });

    it('applies the generatedAt date range filter', async () => {
      prisma.repaymentVariance.findMany.mockResolvedValue([]);
      prisma.repaymentVariance.count.mockResolvedValue(0);

      const generatedFrom = new Date('2025-01-01');
      const generatedTo = new Date('2025-12-31');
      await service.list({ generatedFrom, generatedTo });

      expect(prisma.repaymentVariance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ generatedAt: { gte: generatedFrom, lte: generatedTo } }) }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.repaymentVariance.findMany.mockResolvedValue([]);
      prisma.repaymentVariance.count.mockResolvedValue(11);

      const result = await service.list({}, { page: 1, limit: 5 });

      expect(prisma.repaymentVariance.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 5 }));
      expect(result.meta).toEqual({ total: 11, page: 1, limit: 5, totalPages: 3 });
    });
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx jest src/reconciliation/reconciliation.service.spec.ts -t list`
Expected: FAIL.

- [ ] **Step 4: Create the query DTO**

Create `src/reconciliation/dto/list-reconciliation-query.dto.ts`:

```typescript
import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { VarianceStatus } from '../../generated/prisma/client';

export class ListReconciliationQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  agency?: string;

  @IsOptional()
  @IsEnum(VarianceStatus)
  status?: VarianceStatus;

  @IsOptional()
  @IsString()
  period?: string;

  @IsOptional()
  @IsISO8601()
  generatedFrom?: string;

  @IsOptional()
  @IsISO8601()
  generatedTo?: string;
}
```

- [ ] **Step 5: Rewrite `ReconciliationService.list`**

In `src/reconciliation/reconciliation.service.ts`, add the import `import { buildPaginatedResult } from '../common/pagination/paginated-result';` at the top, then replace:

```typescript
  async list(filters: ReconciliationFilters) {
    return this.prisma.repaymentVariance.findMany({
      where: {
        status: filters.status,
        period: filters.period,
        loan: filters.agency ? { agency: filters.agency } : undefined,
      },
      include: { loan: true },
      orderBy: { generatedAt: 'desc' },
    });
  }
```

with:

```typescript
  async list(
    filters: ReconciliationFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where = {
      status: filters.status,
      period: filters.period,
      loan: filters.agency ? { agency: filters.agency } : undefined,
      generatedAt:
        filters.generatedFrom || filters.generatedTo
          ? { gte: filters.generatedFrom, lte: filters.generatedTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.repaymentVariance.findMany({
        where,
        include: { loan: true },
        orderBy: { generatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.repaymentVariance.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

Find the `ReconciliationFilters` interface earlier in the same file and add the two new optional fields:

```typescript
export interface ReconciliationFilters {
  agency?: string;
  status?: VarianceStatus;
  period?: string;
  generatedFrom?: Date;
  generatedTo?: Date;
}
```

- [ ] **Step 6: Update `AdminReconciliationController`**

Replace the full contents of `src/reconciliation/admin-reconciliation.controller.ts`:

```typescript
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ReconciliationService } from './reconciliation.service';
import { ListReconciliationQueryDto } from './dto/list-reconciliation-query.dto';

@Controller('admin/reconciliation')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Get()
  @RequirePermissions('reconciliation:read')
  list(@Query() query: ListReconciliationQueryDto) {
    return this.reconciliationService.list(
      {
        agency: query.agency,
        status: query.status,
        period: query.period,
        generatedFrom: query.generatedFrom ? new Date(query.generatedFrom) : undefined,
        generatedTo: query.generatedTo ? new Date(query.generatedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}
```

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/reconciliation/reconciliation.service.spec.ts`
Expected: PASS.

- [ ] **Step 8: Fix the ripple e2e assertion in `test/reconciliation.e2e-spec.ts`**

Read the file around line 100-118 first. Replace:

```typescript
      const listRes = await request(app.getHttpServer())
        .get('/admin/reconciliation')
        .query({ agency: 'NSCDC', period: '2025-01' })
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const variance = listRes.body.find(
        (v: { loan: { customerId: string } }) => v.loan.customerId === customerId,
      );
```

with:

```typescript
      const listRes = await request(app.getHttpServer())
        .get('/admin/reconciliation')
        .query({ agency: 'NSCDC', period: '2025-01' })
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const variance = listRes.body.data.find(
        (v: { loan: { customerId: string } }) => v.loan.customerId === customerId,
      );
```

- [ ] **Step 9: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/reconciliation.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/reconciliation/dto/list-reconciliation-query.dto.ts src/reconciliation/reconciliation.service.ts src/reconciliation/reconciliation.service.spec.ts src/reconciliation/admin-reconciliation.controller.ts test/reconciliation.e2e-spec.ts
git commit -m "feat: paginate and filter admin reconciliation list"
```

---

### Task 4: `admin/clients/:id/activities`

**Files:**
- Create: `src/admin-client-review/dto/list-activities-query.dto.ts`
- Modify: `src/admin-client-review/admin-client-activity.service.ts`
- Modify: `src/admin-client-review/admin-client-review.controller.ts`
- Modify: `src/admin-client-review/admin-client-activity.service.spec.ts`
- Modify: `test/admin-client-visibility.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult`/`PaginatedResult` (Sub-project 1).
- Produces: `AdminClientActivityService.listActivities(clientId: string, filters?: ListActivitiesFilters, pagination?): Promise<PaginatedResult<ActivityEntry>>` — this is an in-memory merged list (not one Prisma model), so filtering and pagination both apply to the already-sorted in-memory array, not a DB `skip`/`take`.

- [ ] **Step 1: Update the existing unit tests**

Read `src/admin-client-review/admin-client-activity.service.spec.ts` in full first (114 lines). Update each test that reads `result` as a bare array:

Replace:
```typescript
  it('returns an empty array when the client has no activity anywhere', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    const result = await service.listActivities('c1');
    expect(result).toEqual([]);
  });
```
with:
```typescript
  it('returns an empty paginated result when the client has no activity anywhere', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    const result = await service.listActivities('c1');
    expect(result).toEqual({ data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } });
  });
```

In the `'merges every source and sorts the result by timestamp descending'` test, replace:
```typescript
    expect(result).toHaveLength(7);
    expect(result.map((entry) => entry.timestamp.toISOString())).toEqual([
```
with:
```typescript
    expect(result.data).toHaveLength(7);
    expect(result.meta).toEqual({ total: 7, page: 1, limit: 25, totalPages: 1 });
    expect(result.data.map((entry) => entry.timestamp.toISOString())).toEqual([
```
and replace:
```typescript
    expect(result[result.length - 1]).toEqual(
      expect.objectContaining({ type: 'loan-request.created', source: 'LOAN_REQUEST' }),
    );
```
with:
```typescript
    expect(result.data[result.data.length - 1]).toEqual(
      expect.objectContaining({ type: 'loan-request.created', source: 'LOAN_REQUEST' }),
    );
```

In the `'only synthesizes a loan-request.confirmed entry when confirmedAt is set'` test, replace:
```typescript
    expect(result.filter((entry) => entry.source === 'LOAN_REQUEST')).toHaveLength(1);
```
with:
```typescript
    expect(result.data.filter((entry) => entry.source === 'LOAN_REQUEST')).toHaveLength(1);
```

Then add three new tests at the end of the same top-level `describe` block:

```typescript
  it('filters by type', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([
      { id: 'lr1', amount: 50000, createdAt: new Date('2026-01-01T00:00:00.000Z'), confirmedAt: null },
    ]);
    prisma.session.findMany.mockResolvedValue([{ createdAt: new Date('2026-01-02T00:00:00.000Z') }]);

    const result = await service.listActivities('c1', { type: 'session.created' });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].type).toBe('session.created');
  });

  it('filters by occurredFrom/occurredTo', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([
      { id: 'lr1', amount: 50000, createdAt: new Date('2025-01-01T00:00:00.000Z'), confirmedAt: null },
      { id: 'lr2', amount: 50000, createdAt: new Date('2026-01-01T00:00:00.000Z'), confirmedAt: null },
    ]);

    const result = await service.listActivities('c1', {
      occurredFrom: new Date('2025-12-01T00:00:00.000Z'),
      occurredTo: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].timestamp.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('paginates the merged, filtered, sorted entries', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([
      { id: 'lr1', amount: 50000, createdAt: new Date('2026-01-01T00:00:00.000Z'), confirmedAt: null },
      { id: 'lr2', amount: 50000, createdAt: new Date('2026-01-02T00:00:00.000Z'), confirmedAt: null },
    ]);

    const result = await service.listActivities('c1', {}, { page: 2, limit: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.meta).toEqual({ total: 2, page: 2, limit: 1, totalPages: 2 });
    expect(result.data[0].timestamp.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/admin-client-review/admin-client-activity.service.spec.ts`
Expected: FAIL — `result` is currently a bare array.

- [ ] **Step 3: Create the query DTO**

Create `src/admin-client-review/dto/list-activities-query.dto.ts`:

```typescript
import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListActivitiesQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsISO8601()
  occurredFrom?: string;

  @IsOptional()
  @IsISO8601()
  occurredTo?: string;
}
```

- [ ] **Step 4: Update `AdminClientActivityService.listActivities`**

In `src/admin-client-review/admin-client-activity.service.ts`, add the import `import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';` at the top. Add a `ListActivitiesFilters` interface right after the existing `ActivityEntry` interface:

```typescript
export interface ListActivitiesFilters {
  type?: string;
  occurredFrom?: Date;
  occurredTo?: Date;
}
```

Change the method signature and its final two lines. Replace:

```typescript
  async listActivities(clientId: string): Promise<ActivityEntry[]> {
```

with:

```typescript
  async listActivities(
    clientId: string,
    filters: ListActivitiesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<ActivityEntry>> {
```

Replace the method's final line:

```typescript
    return entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
```

with:

```typescript
    const sorted = entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const filtered = sorted.filter((entry) => {
      if (filters.type && entry.type !== filters.type) {
        return false;
      }
      if (filters.occurredFrom && entry.timestamp < filters.occurredFrom) {
        return false;
      }
      if (filters.occurredTo && entry.timestamp > filters.occurredTo) {
        return false;
      }
      return true;
    });

    const { page, limit } = pagination;
    const pageStart = (page - 1) * limit;
    const paged = filtered.slice(pageStart, pageStart + limit);

    return buildPaginatedResult(paged, filtered.length, page, limit);
```

- [ ] **Step 5: Update `AdminClientReviewController`'s `getActivities`**

In `src/admin-client-review/admin-client-review.controller.ts`, read the file first to find the exact current import list, then replace:

```typescript
  @Get(':id/activities')
  @RequirePermissions('clients:read')
  getActivities(@Param('id') id: string) {
    return this.adminClientActivityService.listActivities(id);
  }
```

with:

```typescript
  @Get(':id/activities')
  @RequirePermissions('clients:read')
  getActivities(@Param('id') id: string, @Query() query: ListActivitiesQueryDto) {
    return this.adminClientActivityService.listActivities(
      id,
      {
        type: query.type,
        occurredFrom: query.occurredFrom ? new Date(query.occurredFrom) : undefined,
        occurredTo: query.occurredTo ? new Date(query.occurredTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add the import `import { ListActivitiesQueryDto } from './dto/list-activities-query.dto';` and make sure `Query` is imported from `@nestjs/common` in this controller's existing import statement (it likely already imports `Param`, `Get`, etc. from `@nestjs/common` — add `Query` to that same import if not already present).

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-activity.service.spec.ts`
Expected: PASS (8/8: 5 updated existing + 3 new).

- [ ] **Step 7: Fix the ripple e2e assertion in `test/admin-client-visibility.e2e-spec.ts`**

Read the file around line 130-150 first. Replace:

```typescript
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
```

with:

```typescript
      const activitiesRes = await request(app.getHttpServer())
        .get(`/admin/clients/${clientA.id}/activities`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      const types = activitiesRes.body.data.map((entry: { type: string }) => entry.type);
      expect(types).toContain('loan-request.created');
      expect(types).toContain('loan-request.confirmed');
      expect(types).toContain('loan-request.approve');
      expect(types).toContain('loan-request.disburse');
      expect(types).toContain('onboarding.step');
      const timestamps = activitiesRes.body.data.map((entry: { timestamp: string }) => new Date(entry.timestamp).getTime());
      const sorted = [...timestamps].sort((a, b) => b - a);
      expect(timestamps).toEqual(sorted);
```

- [ ] **Step 8: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-client-visibility.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 9: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/admin-client-review/dto/list-activities-query.dto.ts src/admin-client-review/admin-client-activity.service.ts src/admin-client-review/admin-client-activity.service.spec.ts src/admin-client-review/admin-client-review.controller.ts test/admin-client-visibility.e2e-spec.ts
git commit -m "feat: paginate and filter admin client activities feed"
```

---

### Task 5: README, Postman, and scoped test run

**Files:**
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: all four endpoints' new query params and `{ data, meta }` response shape from Tasks 1-4.

- [ ] **Step 1: Update the README**

For each of the five endpoints (`admin/ippis-records`, `admin/loans`, `admin/loan-requests`, `admin/reconciliation`, `admin/clients/:id/activities`), find its existing documentation row/section in `README.md` and add: the new query params it accepts (per the tables in Tasks 1-4), and that its response is now `{ data: [...], meta: { total, page, limit, totalPages } }` instead of a bare array.

- [ ] **Step 2: Update Postman**

For each of the five endpoints, find its existing request(s) in the Postman collection (search for each route path). For each saved response example: wrap the list value in `{ "data": [...], "meta": { "total": N, "page": 1, "limit": 25, "totalPages": 1 } }` (compute `N`/`totalPages` from the example's own array length, same approach as Sub-project 1's Postman update). Add each endpoint's new filter/search/date-range query params as documented (disabled, not required) params on the request itself, with example values drawn from that endpoint's own filter table (Tasks 1-4) — e.g. `admin/ippis-records` gets example `employeeStatus=ACTIVE`, `q=Amaka`, `hireDateFrom=2015-01-01`, `hireDateTo=2020-01-01`; `admin/loans` gets `product=Salary Advance`, `q=Bello`; `admin/loan-requests` gets `type=TOPUP`, `createdFrom=2026-01-01`; `admin/reconciliation` gets `period=2025-01`, `generatedFrom=2025-01-01`; `admin/clients/:id/activities` gets `type=session.created`, `occurredFrom=2026-01-01`. Check every `pm.test` script attached to these requests for any that reads the response as a bare array (e.g. `.forEach`, `[0]`, `.find`) and update to `.data` — same fix pattern Sub-project 1's Task 3 applied to `client/loans`. Use a surgical text-based/jq-based edit, never a full `json.load`/`json.dump` rewrite (Sub-project 1's Task 3 hit exactly this risk — a full rewrite silently re-escapes unrelated em-dashes elsewhere in the file).

- [ ] **Step 3: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 4: Commit**

```bash
git add README.md postman/public-sector-backend.postman_collection.json
git commit -m "docs: document pagination/filtering for wave 2 admin list endpoints"
```

- [ ] **Step 5: Run the scoped test set (NOT the full suite — see Global Constraints)**

Run: `npx jest src/admin-catalog src/loan-request src/reconciliation src/admin-client-review`
Expected: PASS — every unit test touched by this plan.

Run: `npx jest --config ./test/jest-e2e.json test/admin-catalog.e2e-spec.ts test/loan-origination.e2e-spec.ts test/reconciliation.e2e-spec.ts test/admin-client-visibility.e2e-spec.ts --runInBand`
Expected: PASS.

Do not run the full unit or e2e suite in this task — this plan is Sub-project 2 of 5; the full suite runs once, at the end of Sub-project 5.

## Exit criteria

- [ ] All five endpoints accept `page`/`limit` plus their own filter/search/date-range params, returning `{ data, meta }`.
- [ ] No existing e2e assertion anywhere in the suite still reads any of these five endpoints' responses as a bare array.
- [ ] `NoActiveLoanRule`-style internal-consumer regressions are ruled out: every service method changed in this plan was greped for other callers before its return shape changed.
- [ ] README and Postman reflect all five endpoints' new query params and response shape.
