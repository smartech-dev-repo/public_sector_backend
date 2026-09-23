# List Pagination Shared Utility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared `PaginationDto`/`PaginatedResult` convention every later wave of the list-pagination initiative will reuse, and prove it end-to-end by retrofitting the one endpoint (`GET /client/loans`) that already has a well-designed filter DTO.

**Architecture:** A new `src/common/pagination/` module provides a `PaginationDto` base class (query params `page`/`limit`, defaults 1/25, hard max 100) and a `buildPaginatedResult()` helper producing `{ data, meta: { total, page, limit, totalPages } }`. `ListLoansQueryDto` extends the base class; `ClientLoansService.getDashboard` applies pagination to its in-memory-filtered `loans` array (status is computed post-query, so this cannot be a pure Prisma `skip`/`take`) while leaving `repayments` untouched.

**Tech Stack:** NestJS, `class-validator`/`class-transformer` (already dependencies, first use of `@Type()` for query coercion in this codebase), Jest + Supertest for e2e.

**Spec:** `docs/superpowers/specs/2026-09-23-list-pagination-filtering-design.md`

## Global Constraints

- Pagination query params: `page` (default 1), `limit` (default 25, hard max 100 — request above 100 is a `400`, not a silent clamp).
- Response envelope: `PaginatedResult<T> = { data: T[], meta: { total: number, page: number, limit: number, totalPages: number } }`.
- `totalPages` is `Math.ceil(total / limit)`, or `0` when `total` is `0`.
- Every new list-endpoint query DTO extends `PaginationDto` — this is the shared base future waves build on.
- No `Co-Authored-By: Claude` trailer on any commit (this repo's standing convention).
- This is Sub-project 1 of a 5-wave initiative (see the spec's roadmap table) — **do not run the full test suite in this plan's closing task.** Per this project's scoped-test-runs convention, the full suite runs only at the true end of the whole multi-plan phase (after Sub-project 5), not after each individual wave. This plan's closing task runs only the tests for files it touched.

---

### Task 1: Shared pagination utility

**Files:**
- Create: `src/common/pagination/pagination.dto.ts`
- Create: `src/common/pagination/paginated-result.ts`
- Test: `src/common/pagination/pagination.dto.spec.ts`
- Test: `src/common/pagination/paginated-result.spec.ts`

**Interfaces:**
- Produces: `PaginationDto` class with `page?: number` (default `1`), `limit?: number` (default `25`), and method `getSkipTake(): { skip: number; take: number }`.
- Produces: `PaginatedResult<T>` interface (`{ data: T[]; meta: { total: number; page: number; limit: number; totalPages: number } }`) and `buildPaginatedResult<T>(data: T[], total: number, page: number, limit: number): PaginatedResult<T>`.

- [ ] **Step 1: Write the failing tests for `PaginationDto`**

Create `src/common/pagination/pagination.dto.spec.ts`:

```typescript
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PaginationDto } from './pagination.dto';

describe('PaginationDto', () => {
  it('defaults to page 1, limit 25 when neither is provided', () => {
    const dto = plainToInstance(PaginationDto, {});
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(25);
  });

  it('coerces query-string numbers and computes skip/take', () => {
    const dto = plainToInstance(PaginationDto, { page: '3', limit: '10' });
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(10);
    expect(dto.getSkipTake()).toEqual({ skip: 20, take: 10 });
  });

  it('computes skip 0 for page 1 regardless of limit', () => {
    const dto = plainToInstance(PaginationDto, { page: '1', limit: '25' });
    expect(dto.getSkipTake()).toEqual({ skip: 0, take: 25 });
  });

  it('rejects limit above 100', async () => {
    const dto = plainToInstance(PaginationDto, { limit: '500' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('rejects page below 1', async () => {
    const dto = plainToInstance(PaginationDto, { page: '0' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'page')).toBe(true);
  });

  it('passes validation with no params at all', async () => {
    const dto = plainToInstance(PaginationDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/pagination/pagination.dto.spec.ts`
Expected: FAIL — `Cannot find module './pagination.dto'`.

- [ ] **Step 3: Implement `PaginationDto`**

Create `src/common/pagination/pagination.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  getSkipTake(): { skip: number; take: number } {
    return { skip: (this.page - 1) * this.limit, take: this.limit };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/common/pagination/pagination.dto.spec.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Write the failing tests for `buildPaginatedResult`**

Create `src/common/pagination/paginated-result.spec.ts`:

```typescript
import { buildPaginatedResult } from './paginated-result';

describe('buildPaginatedResult', () => {
  it('builds the envelope with correct totalPages for an exact multiple', () => {
    const result = buildPaginatedResult(['a', 'b'], 50, 1, 25);
    expect(result).toEqual({ data: ['a', 'b'], meta: { total: 50, page: 1, limit: 25, totalPages: 2 } });
  });

  it('rounds totalPages up for a partial last page', () => {
    const result = buildPaginatedResult(['a'], 51, 3, 25);
    expect(result.meta.totalPages).toBe(3);
  });

  it('returns totalPages 0 when total is 0', () => {
    const result = buildPaginatedResult([], 0, 1, 25);
    expect(result.meta.totalPages).toBe(0);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx jest src/common/pagination/paginated-result.spec.ts`
Expected: FAIL — `Cannot find module './paginated-result'`.

- [ ] **Step 7: Implement `PaginatedResult`/`buildPaginatedResult`**

Create `src/common/pagination/paginated-result.ts`:

```typescript
export interface PaginatedResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export function buildPaginatedResult<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResult<T> {
  return {
    data,
    meta: {
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx jest src/common/pagination/paginated-result.spec.ts`
Expected: PASS (3/3).

- [ ] **Step 9: Commit**

```bash
git add src/common/pagination/
git commit -m "feat: add shared pagination DTO and paginated-result helper"
```

---

### Task 2: Retrofit `ListLoansQueryDto` and `ClientLoansService.getDashboard`

**Files:**
- Modify: `src/client-loans/dto/list-loans-query.dto.ts`
- Modify: `src/client-loans/client-loans.service.ts`
- Modify: `src/client-loans/client-loans.controller.ts`
- Modify: `src/client-loans/client-loans.service.spec.ts`

**Interfaces:**
- Consumes: `PaginationDto` (from `../common/pagination/pagination.dto`), `buildPaginatedResult`/`PaginatedResult` (from `../common/pagination/paginated-result`) — both from Task 1.
- Produces: `ClientLoansService.getDashboard(clientId: string, filters?: ListLoansFilters, pagination?: { page: number; limit: number }): Promise<{ loans: PaginatedResult<LoanWithStatus>; repayments: RepaymentRecord[] }>` — the new `pagination` param and changed return shape are what Task 3's e2e test and any later consumer rely on.

- [ ] **Step 1: Update the existing unit tests to expect the new `loans` shape**

Read `src/client-loans/client-loans.service.spec.ts` in full first (it currently asserts `result.loans` as a bare array in several tests). Update every assertion that reads `result.loans` directly to read `result.loans.data` instead, and add `meta` assertions where the test's purpose calls for it. Specifically:

Replace:
```typescript
      expect(result).toEqual({ loans: [], repayments: [] });
```
with:
```typescript
      expect(result).toEqual({
        loans: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } },
        repayments: [],
      });
```

Replace:
```typescript
      expect(result.loans).toEqual([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future, status: 'ACTIVE' },
      ]);
      expect(result.repayments).toEqual([{ id: 'rep-1' }]);
```
with:
```typescript
      expect(result.loans.data).toEqual([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future, status: 'ACTIVE' },
      ]);
      expect(result.loans.meta).toEqual({ total: 1, page: 1, limit: 25, totalPages: 1 });
      expect(result.repayments).toEqual([{ id: 'rep-1' }]);
```

Replace each of the three remaining occurrences of:
```typescript
      expect(result.loans.map((loan: { id: string }) => loan.id)).toEqual([...]);
```
with:
```typescript
      expect(result.loans.data.map((loan: { id: string }) => loan.id)).toEqual([...]);
```
(keep each test's own expected id array unchanged — only the `.data` accessor is new).

Then add two new tests to the same `describe('getDashboard', ...)` block:

```typescript
    it('paginates the filtered loans array and reports the filtered total, not the raw findMany count', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future },
        { id: 'loan-2', bvn: null, principalBalance: 5000, maturationDate: future },
        { id: 'loan-3', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const result = await service.getDashboard('c1', {}, { page: 2, limit: 1 });

      expect(result.loans.data.map((loan: { id: string }) => loan.id)).toEqual(['loan-2']);
      expect(result.loans.meta).toEqual({ total: 3, page: 2, limit: 1, totalPages: 3 });
    });

    it('defaults to page 1, limit 25 when no pagination is passed', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        bvn: null,
        ippisRecord: { agency: 'NPF', staffId: 'NPF-001' },
      });
      prisma.loan.findMany.mockResolvedValue([
        { id: 'loan-1', bvn: null, principalBalance: 5000, maturationDate: future },
      ]);
      prisma.loanRepaymentRecord.findMany.mockResolvedValue([]);

      const result = await service.getDashboard('c1');

      expect(result.loans.meta).toEqual({ total: 1, page: 1, limit: 25, totalPages: 1 });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: FAIL — `result.loans` is currently an array, so `.data`/`.meta` accesses fail, and the `pagination` parameter doesn't exist yet.

- [ ] **Step 3: Update `ListLoansQueryDto` to extend `PaginationDto`**

Replace the full contents of `src/client-loans/dto/list-loans-query.dto.ts`:

```typescript
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/pagination/pagination.dto';

const LOAN_STATUSES = ['ACTIVE', 'DEFAULT', 'CLOSED'] as const;

export class ListLoansQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(LOAN_STATUSES)
  status?: (typeof LOAN_STATUSES)[number];

  @IsOptional()
  @IsString()
  product?: string;

  @IsOptional()
  @IsISO8601()
  disbursedFrom?: string;

  @IsOptional()
  @IsISO8601()
  disbursedTo?: string;
}
```

- [ ] **Step 4: Update `ClientLoansService.getDashboard`**

In `src/client-loans/client-loans.service.ts`, add the import at the top:

```typescript
import { buildPaginatedResult } from '../common/pagination/paginated-result';
```

Change the `getDashboard` signature and its body's final section. Replace:

```typescript
  async getDashboard(clientId: string, filters: ListLoansFilters = {}) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return { loans: [], repayments: [] };
    }
```

with:

```typescript
  async getDashboard(
    clientId: string,
    filters: ListLoansFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return { loans: buildPaginatedResult([], 0, pagination.page, pagination.limit), repayments: [] };
    }
```

Then replace the existing tail of the method:

```typescript
    const loans = filters.status
      ? loansWithStatus.filter((loan) => loan.status === filters.status)
      : loansWithStatus;

    const repayments = await this.prisma.loanRepaymentRecord.findMany({
      where: { agency, staffId },
      select: REPAYMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return { loans, repayments };
  }
```

with:

```typescript
    const filteredLoans = filters.status
      ? loansWithStatus.filter((loan) => loan.status === filters.status)
      : loansWithStatus;

    const { page, limit } = pagination;
    const pageStart = (page - 1) * limit;
    const pagedLoans = filteredLoans.slice(pageStart, pageStart + limit);

    const repayments = await this.prisma.loanRepaymentRecord.findMany({
      where: { agency, staffId },
      select: REPAYMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return {
      loans: buildPaginatedResult(pagedLoans, filteredLoans.length, page, limit),
      repayments,
    };
  }
```

Only the `buildPaginatedResult` import shown at the top of this step is needed in this file — `PaginationDto` itself is not imported here; pagination is computed directly from the `pagination.page`/`pagination.limit` values passed in.

- [ ] **Step 5: Update `ClientLoansController` to pass pagination through**

In `src/client-loans/client-loans.controller.ts`, change the `getDashboard` call:

```typescript
  @Get()
  getDashboard(@Query() query: ListLoansQueryDto, @Req() req: { user: JwtPayload }) {
    return this.clientLoansService.getDashboard(
      req.user.sub,
      {
        status: query.status,
        product: query.product,
        disbursedFrom: query.disbursedFrom ? new Date(query.disbursedFrom) : undefined,
        disbursedTo: query.disbursedTo ? new Date(query.disbursedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/client-loans/client-loans.service.spec.ts`
Expected: PASS — all existing tests (updated) plus the 2 new pagination tests.

- [ ] **Step 7: Run `tsc` to confirm no type errors ripple to other callers**

Run: `npx tsc --noEmit`
Expected: clean. (Grep `getDashboard(` across `src/` first to confirm `ClientLoansController` is the only caller — if another caller exists, it needs the same 3-arg-call treatment; the third argument has a default so a 2-arg call still compiles, but check anyway.)

- [ ] **Step 8: Commit**

```bash
git add src/client-loans/dto/list-loans-query.dto.ts src/client-loans/client-loans.service.ts src/client-loans/client-loans.controller.ts src/client-loans/client-loans.service.spec.ts
git commit -m "feat: paginate GET /client/loans loans list"
```

---

### Task 3: e2e coverage, README, Postman, and scoped test run

**Files:**
- Modify: `test/client-loans.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: `GET /client/loans` now returns `{ loans: { data, meta }, repayments }` (Task 2).

- [ ] **Step 1: Update the existing e2e assertions**

Read `test/client-loans.e2e-spec.ts` in full first. Every occurrence of `res.body.loans` (an array today) needs to become `res.body.loans.data`. Specifically, replace:

```typescript
    expect(res.body.loans).toHaveLength(2);
    const active = res.body.loans.find((loan: { id: string }) => loan.id === activeLoanId);
    const defaulted = res.body.loans.find((loan: { id: string }) => loan.id === defaultLoanId);
```
with:
```typescript
    expect(res.body.loans.data).toHaveLength(2);
    const active = res.body.loans.data.find((loan: { id: string }) => loan.id === activeLoanId);
    const defaulted = res.body.loans.data.find((loan: { id: string }) => loan.id === defaultLoanId);
```

and each of the two remaining pairs:
```typescript
    expect(res.body.loans).toHaveLength(1);
    expect(res.body.loans[0].id).toBe(defaultLoanId);
```
with:
```typescript
    expect(res.body.loans.data).toHaveLength(1);
    expect(res.body.loans.data[0].id).toBe(defaultLoanId);
```
(applies to both occurrences of this pair — the status-filter test and the date-range-filter test).

- [ ] **Step 2: Add a new pagination e2e test**

Find the `describe`/`it` block that seeds 2 loans (`activeLoanId`/`defaultLoanId`) for the existing "filters by status" test — add a new test right after it in the same `describe` block, reusing the same seeded client/loans:

```typescript
  it('paginates the loans list', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans?page=1&limit=1')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .expect(200);

    expect(res.body.loans.data).toHaveLength(1);
    expect(res.body.loans.meta).toEqual({ total: 2, page: 1, limit: 1, totalPages: 2 });
  });
```

(Match the exact `clientAccessToken`/`app`/`request` variable names already used by the surrounding tests in this file — read the file's top-level `beforeAll` setup first to confirm the exact names in scope.)

- [ ] **Step 3: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/client-loans.e2e-spec.ts --runInBand`
Expected: PASS — all existing tests (updated) plus the new pagination test.

- [ ] **Step 4: Update the README**

Find the existing `GET /client/loans` documentation row/section in `README.md` and add a note that the endpoint now accepts `page`/`limit` query params (default `1`/`25`, `limit` capped at `100`), and that its response shape is now `{ loans: { data: [...], meta: { total, page, limit, totalPages } }, repayments: [...] }` instead of a bare `loans` array.

- [ ] **Step 5: Update Postman**

Find the existing `GET /client/loans` request(s) in the Postman collection (search for the route path `client/loans`). For each saved response example on this request: wrap the existing `loans` array value in `{ "data": [...], "meta": { "total": N, "page": 1, "limit": 25, "totalPages": 1 } }` (compute `N` as the example's own array length, `totalPages` as `Math.ceil(N/25)` or `1` if `N <= 25`), leaving `repayments` untouched. Add `page` and `limit` as documented (not required) query params on the request itself. Use a surgical text-based/jq-based edit, not a full rewrite (watch `ensure_ascii` if using Python's `json` module — always pass `ensure_ascii=False`).

- [ ] **Step 6: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 7: Commit**

```bash
git add test/client-loans.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add e2e coverage and docs for paginated client loans list"
```

- [ ] **Step 8: Run the scoped test set (NOT the full suite — see Global Constraints)**

Run: `npx jest src/common/pagination src/client-loans`
Expected: PASS — every unit test touched by this plan.

Run: `npx jest --config ./test/jest-e2e.json test/client-loans.e2e-spec.ts --runInBand`
Expected: PASS.

Do not run the full unit or e2e suite in this task — this plan is Sub-project 1 of a 5-wave initiative; the full suite runs once, at the end of Sub-project 5, per this project's scoped-test-runs convention.

## Exit criteria

- [ ] `PaginationDto`/`buildPaginatedResult` exist in `src/common/pagination/` with passing unit tests.
- [ ] `GET /client/loans` accepts `page`/`limit`, returns `{ loans: { data, meta }, repayments }`.
- [ ] All existing `client-loans` unit and e2e tests pass against the new shape; two new tests cover pagination directly.
- [ ] README and Postman reflect the new query params and response shape.
