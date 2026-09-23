# List Pagination Wave 5 — Client-Facing & Low-Risk Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the shared pagination convention (Sub-project 1) to the last five list endpoints in the initiative: `client/loan-requests`, `admin/client-loans`, `client/loan-terms`, `auth/sessions`, and the wallet-entries list shared by `admin/clients/:clientId/wallet` + `client/wallet`. This is the final wave — its closing task runs the full unit + e2e suite for the entire codebase.

**Architecture:** All five are single-Prisma-model `findMany`+`count` pairs, same pattern as Waves 3/4. The one real design decision in this wave: `WalletService.getWallet` currently computes its returned `balance` by summing the very same `entries` array it returns — once `entries` becomes paginated, that summation would silently be wrong (only summing one page). This plan splits `getBalance()` (unpaginated, always-correct, used internally by `debit()` too) from the paginated `entries` list, exactly the same shape of fix Sub-project 1 needed for `NoActiveLoanRule`.

**Tech Stack:** NestJS, Prisma, `class-validator`/`class-transformer`, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-list-pagination-filtering-design.md` (see its per-endpoint filter table)

## Global Constraints

- Every new query DTO extends `PaginationDto` from `src/common/pagination/pagination.dto.ts` (`page` default `1`, `limit` default `25`, hard max `100`).
- Every changed service method returns `PaginatedResult<T>` via `buildPaginatedResult()` from `src/common/pagination/paginated-result.ts`.
- Date-range fields are field-specific `xFrom`/`xTo` ISO8601 pairs. None of this wave's five endpoints has a `q` search field per the spec's filter table.
- Before changing any service method's return shape, grep the whole `src/` tree for other callers — already confirmed for four of the five methods in this plan (each has exactly one caller, its own controller). `WalletService.getWallet` has **two** callers (admin and client controllers, both intentional) — both get the same new signature. `WalletService.debit()` currently calls `getWallet()` internally purely to read `balance`; this plan replaces that with a dedicated `getBalance()` so a debit's insufficient-balance check is never affected by list pagination (see Task 4).
- Before changing any endpoint's response shape, grep `test/*.e2e-spec.ts` for existing calls to that route — already catalogued per task below.
- **Git safety, carried forward from Waves 3/4**: for your final commit, run `git add <your task's explicit file paths...>` immediately followed by `git commit <the same explicit file paths...> -m "..."` as two back-to-back commands (a bare pathspec-only `git commit <paths>` fails for brand-new untracked files with "pathspec did not match any files known to git" — Waves 3/4 both hit this and worked around it exactly this way). Never run a bare `git add -A`/`git add .` or a bare `git commit -m "..."` with no pathspec.
- No `Co-Authored-By: Claude` trailer on any commit.
- **This is Sub-project 5, the last wave of the whole initiative.** Tasks 1-4 still scope their own test runs to only the files they touch. Task 5 (the closing task) is different from every previous wave's closing task: it runs the **full** unit and e2e suite, because this is the true end of the multi-plan phase.

---

### Task 1: `client/loan-requests` and `admin/client-loans`

Both endpoints are served by `LoanRequestService`, so this task covers both together (same file, avoids a concurrent-edit conflict with itself).

**Files:**
- Create: `src/loan-request/dto/list-client-loan-requests-query.dto.ts`
- Modify: `src/loan-request/dto/list-client-loans-query.dto.ts`
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.controller.ts`
- Modify: `src/loan-request/admin-client-loans.controller.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`
- Modify: `test/loan-request.e2e-spec.ts`
- Modify: `test/admin-client-visibility.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult` (Sub-project 1, both already imported in `loan-request.service.ts` from Wave 2).
- Produces: `LoanRequestService.list(clientId: string, filters?: { status?: LoanRequestStatus }, pagination?): Promise<PaginatedResult<LoanRequest>>` and `LoanRequestService.listByClient(clientId: string, filters?: ListClientLoansFilters, pagination?): Promise<PaginatedResult<ClientLoan>>`.

- [ ] **Step 1: Confirm callers and read the pagination utility**

Run: `grep -rn "loanRequestService\.list(\|\.listByClient(" src --include="*.ts" | grep -v spec` — expect `LoanRequestController` (client-facing `list`) and `AdminClientLoansController` (`listByClient`) as the only callers. Read `src/common/pagination/pagination.dto.ts` and `src/common/pagination/paginated-result.ts` first to confirm exact exported names.

- [ ] **Step 2: Add tests for the client-facing `list` method**

Read `src/loan-request/loan-request.service.spec.ts` in full first (it's large — only touch what's described here). There is currently no test at all for the bare `service.list(clientId)` method (confirmed — only `listAll`/`listAll with a type filter`/`listByClient` are tested). Add `count: jest.fn()` to the `prisma.loanRequest` mock (it already has `findMany` from Wave 2 — just add `count` alongside it). Add a new top-level `describe` block anywhere in the file:

```typescript
  describe('list (client-facing)', () => {
    it('scopes to the given clientId, defaulting to page 1/limit 25', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);

      const result = await service.list('client-1');

      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'client-1', status: undefined }, skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);

      await service.list('client-1', { status: 'CONFIRMED' as never });

      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'client-1', status: 'CONFIRMED' } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(3);

      const result = await service.list('client-1', {}, { page: 2, limit: 2 });

      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 2, take: 2 }));
      expect(result.meta).toEqual({ total: 3, page: 2, limit: 2, totalPages: 2 });
    });
  });
```

- [ ] **Step 3: Rewrite the existing `listByClient` test and add new ones**

Add `count: jest.fn()` to the `prisma.clientLoan` mock (it already has `findMany`). Replace the existing `describe('listByClient', ...)` block:

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

with:

```typescript
  describe('listByClient', () => {
    it('lists a client\'s ClientLoan rows ordered by disbursementDate descending, defaulting to page 1/limit 25', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([{ id: 'cl1' }]);
      prisma.clientLoan.count.mockResolvedValue(1);

      const result = await service.listByClient('client-1');

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clientId: 'client-1', status: undefined, agency: undefined, disbursementDate: undefined },
          orderBy: { disbursementDate: 'desc' },
          skip: 0,
          take: 25,
        }),
      );
      expect(result).toEqual({ data: [{ id: 'cl1' }], meta: { total: 1, page: 1, limit: 25, totalPages: 1 } });
    });

    it('filters by status and agency', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([]);
      prisma.clientLoan.count.mockResolvedValue(0);

      await service.listByClient('client-1', { status: 'ACTIVE' as never, agency: 'NPF' });

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE', agency: 'NPF' }) }),
      );
    });

    it('applies a disbursementDate range', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([]);
      prisma.clientLoan.count.mockResolvedValue(0);
      const disbursedFrom = new Date('2025-01-01');
      const disbursedTo = new Date('2025-12-31');

      await service.listByClient('client-1', { disbursedFrom, disbursedTo });

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ disbursementDate: { gte: disbursedFrom, lte: disbursedTo } }) }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([]);
      prisma.clientLoan.count.mockResolvedValue(4);

      const result = await service.listByClient('client-1', {}, { page: 2, limit: 3 });

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 3, take: 3 }));
      expect(result.meta).toEqual({ total: 4, page: 2, limit: 3, totalPages: 2 });
    });
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts -t "list (client-facing)|listByClient"`
Expected: FAIL.

- [ ] **Step 5: Create the client-facing query DTO**

Create `src/loan-request/dto/list-client-loan-requests-query.dto.ts`:

```typescript
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { LoanRequestStatus } from '../../generated/prisma/client';

export class ListClientLoanRequestsQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(LoanRequestStatus)
  status?: LoanRequestStatus;
}
```

- [ ] **Step 6: Extend the existing `ListClientLoansQueryDto`**

Read `src/loan-request/dto/list-client-loans-query.dto.ts` in full first (it's short — just a required `clientId`). Replace its full contents:

```typescript
import { IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { ClientLoanStatus } from '../../generated/prisma/client';

export class ListClientLoansQueryDto extends PaginationDto {
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsOptional()
  @IsEnum(ClientLoanStatus)
  status?: ClientLoanStatus;

  @IsOptional()
  @IsString()
  agency?: string;

  @IsOptional()
  @IsISO8601()
  disbursedFrom?: string;

  @IsOptional()
  @IsISO8601()
  disbursedTo?: string;
}
```

- [ ] **Step 7: Rewrite `LoanRequestService.list` and `listByClient`**

In `src/loan-request/loan-request.service.ts`, add `Prisma` to the existing generated-client import (currently `import { AuditActorType, ClientLoan, ClientLoanStatus, LoanRequest, LoanRequestStatus, LoanRequestType, ManagementChargeApplication, ManagementChargeType, VarianceSource } from '../generated/prisma/client';` — add `Prisma` to this list). `buildPaginatedResult` is already imported (from Wave 2).

Replace:

```typescript
  async list(clientId: string) {
    return this.prisma.loanRequest.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }
```

with:

```typescript
  async list(
    clientId: string,
    filters: { status?: LoanRequestStatus } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.LoanRequestWhereInput = { clientId, status: filters.status };

    const [data, total] = await Promise.all([
      this.prisma.loanRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.loanRequest.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

Replace:

```typescript
  async listByClient(clientId: string) {
    return this.prisma.clientLoan.findMany({ where: { clientId }, orderBy: { disbursementDate: 'desc' } });
  }
```

with:

```typescript
  async listByClient(
    clientId: string,
    filters: { status?: ClientLoanStatus; agency?: string; disbursedFrom?: Date; disbursedTo?: Date } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.ClientLoanWhereInput = {
      clientId,
      status: filters.status,
      agency: filters.agency,
      disbursementDate:
        filters.disbursedFrom || filters.disbursedTo
          ? { gte: filters.disbursedFrom, lte: filters.disbursedTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.clientLoan.findMany({ where, orderBy: { disbursementDate: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.clientLoan.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 8: Update `LoanRequestController` (client-facing)**

In `src/loan-request/loan-request.controller.ts`, replace:

```typescript
  @Get()
  list(@Req() req: { user: JwtPayload }) {
    return this.loanRequestService.list(req.user.sub);
  }
```

with:

```typescript
  @Get()
  list(@Query() query: ListClientLoanRequestsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.list(req.user.sub, { status: query.status }, { page: query.page, limit: query.limit });
  }
```

Add `Query` to this controller's existing `@nestjs/common` import and add `import { ListClientLoanRequestsQueryDto } from './dto/list-client-loan-requests-query.dto';`.

- [ ] **Step 9: Update `AdminClientLoansController`**

In `src/loan-request/admin-client-loans.controller.ts`, replace:

```typescript
  @Get()
  @RequirePermissions('clients:read')
  list(@Query() query: ListClientLoansQueryDto) {
    return this.loanRequestService.listByClient(query.clientId);
  }
```

with:

```typescript
  @Get()
  @RequirePermissions('clients:read')
  list(@Query() query: ListClientLoansQueryDto) {
    return this.loanRequestService.listByClient(
      query.clientId,
      {
        status: query.status,
        agency: query.agency,
        disbursedFrom: query.disbursedFrom ? new Date(query.disbursedFrom) : undefined,
        disbursedTo: query.disbursedTo ? new Date(query.disbursedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

- [ ] **Step 10: Run the unit tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — the full file (it covers many other `LoanRequestService` methods; this confirms nothing else broke).

- [ ] **Step 11: Fix the ripple e2e assertions**

In `test/loan-request.e2e-spec.ts`, read around line 95-102 first. Replace:

```typescript
    const confirmed = listRes.body.find((lr: { id: string }) => lr.id === loanRequestId);
```

with:

```typescript
    const confirmed = listRes.body.data.find((lr: { id: string }) => lr.id === loanRequestId);
```

In `test/admin-client-visibility.e2e-spec.ts`, read around line 120-128 first. Replace:

```typescript
      expect(loansRes.body).toHaveLength(1);
```

with:

```typescript
      expect(loansRes.body.data).toHaveLength(1);
```

- [ ] **Step 12: Run the e2e tests to verify they still pass**

Run: `npx jest --config ./test/jest-e2e.json test/loan-request.e2e-spec.ts test/admin-client-visibility.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 13: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 14: Commit**

```bash
git add src/loan-request/dto/list-client-loan-requests-query.dto.ts src/loan-request/dto/list-client-loans-query.dto.ts src/loan-request/loan-request.service.ts src/loan-request/loan-request.controller.ts src/loan-request/admin-client-loans.controller.ts src/loan-request/loan-request.service.spec.ts test/loan-request.e2e-spec.ts test/admin-client-visibility.e2e-spec.ts
git commit src/loan-request/dto/list-client-loan-requests-query.dto.ts src/loan-request/dto/list-client-loans-query.dto.ts src/loan-request/loan-request.service.ts src/loan-request/loan-request.controller.ts src/loan-request/admin-client-loans.controller.ts src/loan-request/loan-request.service.spec.ts test/loan-request.e2e-spec.ts test/admin-client-visibility.e2e-spec.ts -m "feat: paginate and filter client loan-requests and admin client-loans lists"
```

---

### Task 2: `client/loan-terms`

**Files:**
- Create: `src/loan-terms/dto/list-client-loan-terms-query.dto.ts`
- Modify: `src/loan-terms/loan-terms.service.ts`
- Modify: `src/loan-terms/client-loan-terms.controller.ts`
- Modify: `src/loan-terms/loan-terms.service.spec.ts`
- Modify: `test/loan-origination.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult`/`PaginatedResult` (already imported in `loan-terms.service.ts` from Wave 3).
- Produces: `LoanTermOptionService.listActiveForClient(clientId: string, pagination?): Promise<PaginatedResult<LoanTermOption>>`. `list()` (the admin-facing method, Wave 3) is untouched.

- [ ] **Step 1: Confirm the one caller**

Run: `grep -rn "listActiveForClient(" src --include="*.ts" | grep -v spec` — expect only `ClientLoanTermsController`.

- [ ] **Step 2: Rewrite the existing `listActiveForClient` tests**

Read `src/loan-terms/loan-terms.service.spec.ts` in full first. `count: jest.fn()` already exists on the `loanTermOption` mock (added in Wave 3) — no mock changes needed. Replace the existing `describe('listActiveForClient', ...)` block:

```typescript
  describe('listActiveForClient', () => {
    it('returns an empty array when the client has no onboarding record', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      const result = await service.listActiveForClient('client-1');
      expect(result).toEqual([]);
      expect(prisma.loanTermOption.findMany).not.toHaveBeenCalled();
    });

    it('lists active options for the client\'s own agency', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      prisma.loanTermOption.findMany.mockResolvedValue([{ id: 'term-1' }]);

      const result = await service.listActiveForClient('client-1');

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith({ where: { agency: 'NPF', isActive: true } });
      expect(result).toEqual([{ id: 'term-1' }]);
    });
  });
```

with:

```typescript
  describe('listActiveForClient', () => {
    it('returns an empty paginated result when the client has no onboarding record', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.listActiveForClient('client-1');

      expect(result).toEqual({ data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } });
      expect(prisma.loanTermOption.findMany).not.toHaveBeenCalled();
    });

    it('lists active options for the client\'s own agency, defaulting to page 1/limit 25', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      prisma.loanTermOption.findMany.mockResolvedValue([{ id: 'term-1' }]);
      prisma.loanTermOption.count.mockResolvedValue(1);

      const result = await service.listActiveForClient('client-1');

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { agency: 'NPF', isActive: true }, skip: 0, take: 25 }),
      );
      expect(result).toEqual({ data: [{ id: 'term-1' }], meta: { total: 1, page: 1, limit: 25, totalPages: 1 } });
    });

    it('computes skip/take from page and limit', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ippisRecord: { agency: 'NPF' } });
      prisma.loanTermOption.findMany.mockResolvedValue([]);
      prisma.loanTermOption.count.mockResolvedValue(5);

      const result = await service.listActiveForClient('client-1', { page: 2, limit: 2 });

      expect(prisma.loanTermOption.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 2, take: 2 }));
      expect(result.meta).toEqual({ total: 5, page: 2, limit: 2, totalPages: 3 });
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/loan-terms/loan-terms.service.spec.ts -t listActiveForClient`
Expected: FAIL.

- [ ] **Step 4: Create the query DTO**

Create `src/loan-terms/dto/list-client-loan-terms-query.dto.ts`:

```typescript
import { PaginationDto } from '../../common/pagination/pagination.dto';

export class ListClientLoanTermsQueryDto extends PaginationDto {}
```

- [ ] **Step 5: Rewrite `LoanTermOptionService.listActiveForClient`**

Replace:

```typescript
  async listActiveForClient(clientId: string): Promise<LoanTermOption[]> {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return [];
    }
    return this.prisma.loanTermOption.findMany({
      where: { agency: onboarding.ippisRecord.agency, isActive: true },
    });
  }
```

with:

```typescript
  async listActiveForClient(
    clientId: string,
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<LoanTermOption>> {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return buildPaginatedResult([], 0, pagination.page, pagination.limit);
    }

    const { page, limit } = pagination;
    const where: Prisma.LoanTermOptionWhereInput = { agency: onboarding.ippisRecord.agency, isActive: true };

    const [data, total] = await Promise.all([
      this.prisma.loanTermOption.findMany({ where, skip: (page - 1) * limit, take: limit }),
      this.prisma.loanTermOption.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 6: Update `ClientLoanTermsController`**

Replace:

```typescript
  @Get()
  list(@Req() req: { user: JwtPayload }) {
    return this.loanTermOptionService.listActiveForClient(req.user.sub);
  }
```

with:

```typescript
  @Get()
  list(@Query() query: ListClientLoanTermsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.loanTermOptionService.listActiveForClient(req.user.sub, { page: query.page, limit: query.limit });
  }
```

Add `Query` to this controller's existing `@nestjs/common` import (currently `import { Controller, Get, Req, UseGuards } from '@nestjs/common';`) and add `import { ListClientLoanTermsQueryDto } from './dto/list-client-loan-terms-query.dto';`.

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/loan-terms/loan-terms.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 8: Fix the ripple e2e assertions in `test/loan-origination.e2e-spec.ts`**

Read the file around line 80-89 first. Replace:

```typescript
    expect(res.body).toHaveLength(1);
    expect(res.body[0].tenorMonths).toBe(3);
```

with:

```typescript
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].tenorMonths).toBe(3);
```

- [ ] **Step 9: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/loan-origination.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/loan-terms/dto/list-client-loan-terms-query.dto.ts src/loan-terms/loan-terms.service.ts src/loan-terms/client-loan-terms.controller.ts src/loan-terms/loan-terms.service.spec.ts test/loan-origination.e2e-spec.ts
git add src/loan-terms/dto/list-client-loan-terms-query.dto.ts src/loan-terms/loan-terms.service.ts src/loan-terms/client-loan-terms.controller.ts src/loan-terms/loan-terms.service.spec.ts test/loan-origination.e2e-spec.ts
git commit src/loan-terms/dto/list-client-loan-terms-query.dto.ts src/loan-terms/loan-terms.service.ts src/loan-terms/client-loan-terms.controller.ts src/loan-terms/loan-terms.service.spec.ts test/loan-origination.e2e-spec.ts -m "feat: paginate client loan-terms list"
```

---

### Task 3: `auth/sessions`

**Files:**
- Create: `src/auth/session/dto/list-sessions-query.dto.ts`
- Modify: `src/session/session.service.ts`
- Modify: `src/auth/session/session-auth.controller.ts`
- Modify: `src/session/session.service.spec.ts`
- Modify: `test/session-rails.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult`/`PaginatedResult` (Sub-project 1).
- Produces: `SessionService.listActiveSessions(principalType, principalId, filters?: { createdFrom?: Date; createdTo?: Date }, pagination?): Promise<PaginatedResult<SessionSummary>>`.

- [ ] **Step 1: Confirm the one caller**

Run: `grep -rn "listActiveSessions(" src --include="*.ts" | grep -v spec` — expect only `SessionAuthController`.

- [ ] **Step 2: Add tests for `listActiveSessions`**

Read `src/session/session.service.spec.ts` in full first. There is no existing test for `listActiveSessions` (confirmed). Add `count: jest.fn()` to the `prisma.session` mock (it already has `findMany`). Add a new top-level `describe` block:

```typescript
  describe('listActiveSessions', () => {
    it('lists non-revoked, non-expired sessions ordered by lastUsedAt, defaulting to page 1/limit 25', async () => {
      prisma.session.findMany.mockResolvedValue([]);
      prisma.session.count.mockResolvedValue(0);

      const result = await service.listActiveSessions(SessionPrincipalType.CLIENT, 'client-1');

      expect(prisma.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            principalType: SessionPrincipalType.CLIENT,
            principalId: 'client-1',
            revokedAt: null,
          }),
          orderBy: { lastUsedAt: 'desc' },
          skip: 0,
          take: 25,
        }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('applies a createdAt date range', async () => {
      prisma.session.findMany.mockResolvedValue([]);
      prisma.session.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.listActiveSessions(SessionPrincipalType.CLIENT, 'client-1', { createdFrom, createdTo });

      expect(prisma.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
      );
    });

    it('maps each row to a SessionSummary shape and computes skip/take from page and limit', async () => {
      prisma.session.findMany.mockResolvedValue([
        {
          id: 's1',
          userAgent: 'jest',
          ip: '127.0.0.1',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: new Date('2026-01-02'),
          expiresAt: new Date('2026-02-01'),
        },
      ]);
      prisma.session.count.mockResolvedValue(6);

      const result = await service.listActiveSessions(SessionPrincipalType.CLIENT, 'client-1', {}, { page: 2, limit: 3 });

      expect(prisma.session.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 3, take: 3 }));
      expect(result.data).toEqual([
        {
          id: 's1',
          userAgent: 'jest',
          ip: '127.0.0.1',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: new Date('2026-01-02'),
          expiresAt: new Date('2026-02-01'),
        },
      ]);
      expect(result.meta).toEqual({ total: 6, page: 2, limit: 3, totalPages: 2 });
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/session/session.service.spec.ts -t listActiveSessions`
Expected: FAIL — `Cannot find module` is not the issue here since the method exists; expect assertion failures against the old unpaginated signature/shape.

- [ ] **Step 4: Create the query DTO**

Create `src/auth/session/dto/list-sessions-query.dto.ts`:

```typescript
import { IsISO8601, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/pagination/pagination.dto';

export class ListSessionsQueryDto extends PaginationDto {
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

- [ ] **Step 5: Rewrite `SessionService.listActiveSessions`**

In `src/session/session.service.ts`, change `import { AuditActorType, SessionPrincipalType } from '../generated/prisma/client';` to `import { AuditActorType, Prisma, SessionPrincipalType } from '../generated/prisma/client';` and add `import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';`. Replace:

```typescript
  async listActiveSessions(
    principalType: SessionPrincipalType,
    principalId: string,
  ): Promise<SessionSummary[]> {
    const sessions = await this.prisma.session.findMany({
      where: { principalType, principalId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });

    return sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ip: session.ip,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
    }));
  }
```

with:

```typescript
  async listActiveSessions(
    principalType: SessionPrincipalType,
    principalId: string,
    filters: { createdFrom?: Date; createdTo?: Date } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<SessionSummary>> {
    const { page, limit } = pagination;
    const where: Prisma.SessionWhereInput = {
      principalType,
      principalId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [sessions, total] = await Promise.all([
      this.prisma.session.findMany({ where, orderBy: { lastUsedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.session.count({ where }),
    ]);

    const data = sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ip: session.ip,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
    }));

    return buildPaginatedResult(data, total, page, limit);
  }
```

- [ ] **Step 6: Update `SessionAuthController`**

In `src/auth/session/session-auth.controller.ts`, replace:

```typescript
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  listSessions(@Req() req: { user: JwtPayload }) {
    return this.sessionService.listActiveSessions(
      toSessionPrincipalType(req.user.type),
      req.user.sub,
    );
  }
```

with:

```typescript
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  listSessions(@Query() query: ListSessionsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.sessionService.listActiveSessions(
      toSessionPrincipalType(req.user.type),
      req.user.sub,
      {
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add `Query` to this controller's existing `@nestjs/common` import (currently `import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';`) and add `import { ListSessionsQueryDto } from './dto/list-sessions-query.dto';`.

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx jest src/session/session.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 8: Fix the ripple e2e assertion in `test/session-rails.e2e-spec.ts`**

Read the file around line 100-112 first. Replace:

```typescript
    expect(listRes.body.length).toBeGreaterThan(0);
```

with:

```typescript
    expect(listRes.body.data.length).toBeGreaterThan(0);
```

- [ ] **Step 9: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/session-rails.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 10: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/auth/session/dto/list-sessions-query.dto.ts src/session/session.service.ts src/auth/session/session-auth.controller.ts src/session/session.service.spec.ts test/session-rails.e2e-spec.ts
git add src/auth/session/dto/list-sessions-query.dto.ts src/session/session.service.ts src/auth/session/session-auth.controller.ts src/session/session.service.spec.ts test/session-rails.e2e-spec.ts
git commit src/auth/session/dto/list-sessions-query.dto.ts src/session/session.service.ts src/auth/session/session-auth.controller.ts src/session/session.service.spec.ts test/session-rails.e2e-spec.ts -m "feat: paginate and filter auth sessions list"
```

---

### Task 4: Wallet entries (`admin/clients/:clientId/wallet` + `client/wallet`)

**Files:**
- Create: `src/wallet/dto/list-wallet-entries-query.dto.ts`
- Modify: `src/wallet/wallet.service.ts`
- Modify: `src/wallet/admin-wallet.controller.ts`
- Modify: `src/wallet/client-wallet.controller.ts`
- Modify: `src/wallet/wallet.service.spec.ts`
- Modify: `test/wallet.e2e-spec.ts`

**Interfaces:**
- Consumes: `PaginationDto`, `buildPaginatedResult`/`PaginatedResult` (Sub-project 1).
- Produces: `WalletService.getBalance(clientId: string): Promise<number>` (new, unpaginated — used internally by `debit()`), `WalletService.getWallet(clientId, filters?, pagination?): Promise<{ balance: number; entries: PaginatedResult<WalletEntry> }>`.

- [ ] **Step 1: Confirm callers before changing anything**

Run: `grep -rn "walletService\.getWallet(\|walletService\.debit(\|walletService\.credit(" src --include="*.ts" | grep -v spec`. Expect `getWallet` called by both `AdminWalletController` and `ClientWalletController` (both intentional — both get the new signature); `debit` called by `LoanRequestService` and internally by nothing else; `credit` called by `ClientLoanReconciliationService` and the admin controller. This confirms `debit()`'s internal reliance on `getWallet()` for its balance check is the only place inside `WalletService` itself that needs rewiring — no external caller of `debit`/`credit` needs to change.

- [ ] **Step 2: Rewrite `getWallet` tests, add `getBalance` tests, and add a decoupling regression test**

Read `src/wallet/wallet.service.spec.ts` in full first. Add `count: jest.fn()` to the `prisma.walletEntry` mock. Replace the existing `describe('getWallet', ...)` block:

```typescript
  describe('getWallet', () => {
    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.getWallet('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns a zero balance and empty entries for a client with no history', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([]);

      const result = await service.getWallet('client-1');

      expect(result).toEqual({ balance: 0, entries: [] });
    });

    it('sums credits and subtracts debits to compute the balance', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { amount: 5000, direction: WalletEntryDirection.CREDIT },
        { amount: 1500, direction: WalletEntryDirection.DEBIT },
        { amount: 200, direction: WalletEntryDirection.CREDIT },
      ]);

      const result = await service.getWallet('client-1');

      expect(result.balance).toBe(3700);
    });
  });
```

with:

```typescript
  describe('getWallet', () => {
    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.getWallet('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns a zero balance and an empty paginated entries list for a client with no history', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([]);
      prisma.walletEntry.count.mockResolvedValue(0);

      const result = await service.getWallet('client-1');

      expect(result).toEqual({ balance: 0, entries: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } } });
    });

    it('sums credits and subtracts debits to compute the balance', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { amount: 5000, direction: WalletEntryDirection.CREDIT },
        { amount: 1500, direction: WalletEntryDirection.DEBIT },
        { amount: 200, direction: WalletEntryDirection.CREDIT },
      ]);
      prisma.walletEntry.count.mockResolvedValue(3);

      const result = await service.getWallet('client-1');

      expect(result.balance).toBe(3700);
    });

    it('filters entries by direction/actorType and applies a createdAt range', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([]);
      prisma.walletEntry.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.getWallet('client-1', {
        direction: WalletEntryDirection.CREDIT,
        actorType: AuditActorType.ADMIN,
        createdFrom,
        createdTo,
      });

      expect(prisma.walletEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            direction: WalletEntryDirection.CREDIT,
            actorType: AuditActorType.ADMIN,
            createdAt: { gte: createdFrom, lte: createdTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit for the entries list', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([]);
      prisma.walletEntry.count.mockResolvedValue(30);

      const result = await service.getWallet('client-1', {}, { page: 2, limit: 10 });

      expect(prisma.walletEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
      expect(result.entries.meta).toEqual({ total: 30, page: 2, limit: 10, totalPages: 3 });
    });

    it('computes the balance from every entry, independent of the entries page size', async () => {
      const allEntries = [
        { amount: 5000, direction: WalletEntryDirection.CREDIT },
        { amount: 1500, direction: WalletEntryDirection.DEBIT },
        { amount: 200, direction: WalletEntryDirection.CREDIT },
      ];
      prisma.walletEntry.count.mockResolvedValue(3);
      prisma.walletEntry.findMany.mockImplementation((args: { take?: number }) =>
        Promise.resolve(args.take ? allEntries.slice(0, args.take) : allEntries),
      );

      const result = await service.getWallet('client-1', {}, { page: 1, limit: 1 });

      expect(result.entries.data).toHaveLength(1);
      expect(result.balance).toBe(3700);
    });
  });

  describe('getBalance', () => {
    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.getBalance('missing')).rejects.toThrow(NotFoundException);
    });

    it('sums credits and subtracts debits', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { amount: 5000, direction: WalletEntryDirection.CREDIT },
        { amount: 1500, direction: WalletEntryDirection.DEBIT },
      ]);

      const balance = await service.getBalance('client-1');

      expect(balance).toBe(3500);
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/wallet/wallet.service.spec.ts -t "getWallet|getBalance"`
Expected: FAIL.

- [ ] **Step 4: Create the query DTO**

Create `src/wallet/dto/list-wallet-entries-query.dto.ts`:

```typescript
import { IsEnum, IsISO8601, IsOptional } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';
import { AuditActorType, WalletEntryDirection } from '../../generated/prisma/client';

export class ListWalletEntriesQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(WalletEntryDirection)
  direction?: WalletEntryDirection;

  @IsOptional()
  @IsEnum(AuditActorType)
  actorType?: AuditActorType;

  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @IsOptional()
  @IsISO8601()
  createdTo?: string;
}
```

- [ ] **Step 5: Rewrite `WalletService`**

Change `import { AuditActorType, WalletEntry, WalletEntryDirection } from '../generated/prisma/client';` to `import { AuditActorType, Prisma, WalletEntry, WalletEntryDirection } from '../generated/prisma/client';` and add `import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';`. Add near the top:

```typescript
export interface ListWalletEntriesFilters {
  direction?: WalletEntryDirection;
  actorType?: AuditActorType;
  createdFrom?: Date;
  createdTo?: Date;
}
```

Replace:

```typescript
  async getWallet(clientId: string): Promise<{ balance: number; entries: WalletEntry[] }> {
    await this.assertClientExists(clientId);

    const entries = await this.prisma.walletEntry.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });

    return { balance: this.sumEntries(entries), entries };
  }
```

with:

```typescript
  async getWallet(
    clientId: string,
    filters: ListWalletEntriesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<{ balance: number; entries: PaginatedResult<WalletEntry> }> {
    await this.assertClientExists(clientId);

    const { page, limit } = pagination;
    const where: Prisma.WalletEntryWhereInput = {
      clientId,
      direction: filters.direction,
      actorType: filters.actorType,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [data, total, balance] = await Promise.all([
      this.prisma.walletEntry.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.walletEntry.count({ where }),
      this.getBalance(clientId),
    ]);

    return { balance, entries: buildPaginatedResult(data, total, page, limit) };
  }

  // Unpaginated, unfiltered on purpose -- the real wallet balance must never
  // depend on which page of the entries list a caller happens to be viewing.
  async getBalance(clientId: string): Promise<number> {
    await this.assertClientExists(clientId);

    const entries = await this.prisma.walletEntry.findMany({
      where: { clientId },
      select: { amount: true, direction: true },
    });

    return this.sumEntries(entries);
  }
```

Replace the start of `debit`:

```typescript
  async debit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry> {
    const { balance } = await this.getWallet(clientId);

    if (amount > balance) {
```

with:

```typescript
  async debit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry> {
    const balance = await this.getBalance(clientId);

    if (amount > balance) {
```

(the rest of `debit`'s body — the `throw`, the `prisma.walletEntry.create` call — is unchanged).

- [ ] **Step 6: Update `AdminWalletController`**

Replace:

```typescript
  @Get()
  @RequirePermissions('wallets:read')
  getWallet(@Param('clientId') clientId: string) {
    return this.walletService.getWallet(clientId);
  }
```

with:

```typescript
  @Get()
  @RequirePermissions('wallets:read')
  getWallet(@Param('clientId') clientId: string, @Query() query: ListWalletEntriesQueryDto) {
    return this.walletService.getWallet(
      clientId,
      {
        direction: query.direction,
        actorType: query.actorType,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add `Query` to this controller's existing `@nestjs/common` import and add `import { ListWalletEntriesQueryDto } from './dto/list-wallet-entries-query.dto';`.

- [ ] **Step 7: Update `ClientWalletController`**

Replace:

```typescript
  @Get()
  getWallet(@Req() req: { user: JwtPayload }) {
    return this.walletService.getWallet(req.user.sub);
  }
```

with:

```typescript
  @Get()
  getWallet(@Query() query: ListWalletEntriesQueryDto, @Req() req: { user: JwtPayload }) {
    return this.walletService.getWallet(
      req.user.sub,
      {
        direction: query.direction,
        actorType: query.actorType,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

Add `Query` to this controller's existing `@nestjs/common` import and add `import { ListWalletEntriesQueryDto } from './dto/list-wallet-entries-query.dto';`.

- [ ] **Step 8: Run the unit tests to verify they pass**

Run: `npx jest src/wallet/wallet.service.spec.ts`
Expected: PASS — full file, including the untouched `credit`/`debit` describe blocks (their existing generic `findMany.mockResolvedValue([...])` mocks still satisfy `getBalance`'s own internal `findMany` call, since the mock doesn't distinguish by arguments).

- [ ] **Step 9: Fix the ripple e2e assertion in `test/wallet.e2e-spec.ts`**

Read the file around lines 60-70 first. Replace:

```typescript
    expect(adminView.body.balance).toBe(5000);
    expect(adminView.body.entries).toHaveLength(1);
    expect(adminView.body.entries[0].description).toBe('Overpayment excess');
```

with:

```typescript
    expect(adminView.body.balance).toBe(5000);
    expect(adminView.body.entries.data).toHaveLength(1);
    expect(adminView.body.entries.data[0].description).toBe('Overpayment excess');
```

(Every other assertion in this file only reads `.body.balance`, which is unaffected — confirmed during planning via `grep -n "\.body\." test/wallet.e2e-spec.ts` that no other line reads `.entries`.)

- [ ] **Step 10: Run the e2e test to verify it still passes**

Run: `npx jest --config ./test/jest-e2e.json test/wallet.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 11: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add src/wallet/dto/list-wallet-entries-query.dto.ts src/wallet/wallet.service.ts src/wallet/admin-wallet.controller.ts src/wallet/client-wallet.controller.ts src/wallet/wallet.service.spec.ts test/wallet.e2e-spec.ts
git add src/wallet/dto/list-wallet-entries-query.dto.ts src/wallet/wallet.service.ts src/wallet/admin-wallet.controller.ts src/wallet/client-wallet.controller.ts src/wallet/wallet.service.spec.ts test/wallet.e2e-spec.ts
git commit src/wallet/dto/list-wallet-entries-query.dto.ts src/wallet/wallet.service.ts src/wallet/admin-wallet.controller.ts src/wallet/client-wallet.controller.ts src/wallet/wallet.service.spec.ts test/wallet.e2e-spec.ts -m "feat: paginate and filter wallet entries, decouple balance from list pagination"
```

---

### Task 5: README, Postman, and the full test suite — closes the entire 5-wave initiative

**Files:**
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: all five endpoints' new query params and response shapes from Tasks 1-4, plus every endpoint from Sub-projects 1-4.

- [ ] **Step 1: Update the README**

For each of the five endpoints/pairs (`client/loan-requests`, `admin/client-loans`, `client/loan-terms`, `auth/sessions`, wallet — both `admin/clients/:clientId/wallet` and `client/wallet`), find its existing documentation and add: the new query params it accepts, and the new response shape — for the four `PaginatedResult`-returning endpoints, `{ data, meta }`; for wallet specifically, `{ balance: number, entries: { data, meta } }` (note `balance` itself is NOT wrapped — only `entries` is a paginated list; call this out explicitly since it's the one endpoint in the whole initiative with a mixed shape).

- [ ] **Step 2: Update Postman**

For each of the five endpoints/pairs, find its existing request(s) in the Postman collection. Wrap each saved response example's list value in `{ "data": [...], "meta": {...} }` (for wallet, only wrap the `entries` field, leave `balance` as a plain number in the example body). Add each endpoint's new filter/date-range query params as documented (disabled) example values — `client/loan-requests` gets `status=CONFIRMED`; `admin/client-loans` gets `status=ACTIVE`, `agency=NPF`, `disbursedFrom=2026-01-01`; `client/loan-terms` gets `page`/`limit` only; `auth/sessions` gets `createdFrom=2026-01-01`; wallet gets `direction=CREDIT`, `actorType=ADMIN`, `createdFrom=2026-01-01`. Trace every `pm.test` script on these six requests for bare-array or chained-variable assumptions — this has been a real, recurring finding in every wave's closing task so far, so check thoroughly rather than assuming these are simple. Use surgical text-based/`Edit`-tool edits only, never a full-document rewrite. Verify with a byte-level em-dash/naira-sign check against `HEAD`.

- [ ] **Step 3: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 4: Commit the docs**

```bash
git add README.md postman/public-sector-backend.postman_collection.json
git commit README.md postman/public-sector-backend.postman_collection.json -m "docs: document pagination/filtering for wave 5 client-facing list endpoints"
```

- [ ] **Step 5: Save the standing convention to memory (if not already saved)**

This step is a note for the orchestrating session, not a subagent action: confirm the memory file recording this initiative's pagination convention (`page`/`limit` defaults, `{data,meta}` envelope, `q`/`xFrom`/`xTo` naming) is still accurate and up to date now that the wallet endpoint introduced the one exception (a mixed shape where only part of the response is paginated) — add a short note about that exception if the memory file doesn't already mention it.

- [ ] **Step 6: Run the FULL test suite — this is the true end of the whole 5-wave initiative**

Run: `npm run test`
Expected: PASS — every unit suite in the codebase, not a scoped subset.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run just that suite in isolation to confirm it's pre-existing environmental flakiness (this codebase has hit this before, always benignly) rather than a real regression, and report that distinction clearly.

## Exit criteria

- [ ] All five endpoints/pairs accept `page`/`limit` plus their own filter/date-range params, returning the appropriate paginated shape.
- [ ] `WalletService.debit()`'s insufficient-balance check uses `getBalance()`, never the paginated `entries` list — verified by the decoupling regression test in Task 4.
- [ ] No existing e2e assertion anywhere in the suite still reads any of this wave's five endpoints' responses as a bare array.
- [ ] README and Postman reflect every endpoint from the entire 5-wave initiative.
- [ ] The full unit and e2e suite passes clean — this is the true, final close of the whole list-pagination initiative.
