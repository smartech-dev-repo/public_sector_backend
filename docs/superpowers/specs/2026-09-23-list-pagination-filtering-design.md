# List Pagination, Filtering, Search &amp; Date-Range Design

## 1. Purpose

Every GET endpoint in this codebase that returns a list of records was built
ad hoc: some have a hand-rolled status filter via raw `@Query()`, most have
no pagination at all, and several (`admin/ippis-records`, `admin/loans`,
`admin/loan-requests`, `admin/reconciliation`,
`admin/clients/:id/activities`) run fully unbounded `findMany()` calls
against tables that grow without bound (a whole agency's payroll upload, a
loan-request history spanning every client, per-loan-per-period variance
rows). A survey of all 30 controllers found **zero** existing shared
pagination/filtering utility — `skip` is never used anywhere in the
application code today, and only three endpoints have even a hardcoded
safety-cap `take: 100` (with no way to page past it).

This is a multi-wave initiative. This spec covers **Sub-project 1 only**:
the shared utility and response convention every later wave builds on, plus
retrofitting the one endpoint that already has a well-designed filter DTO
(`ListLoansQueryDto`) to use it. Sub-projects 2–5 (applying the convention
across the remaining 19 list endpoints) get their own specs later, each
referencing this one — they are pure application of what's designed here,
not new design decisions.

**Full rollout roadmap** (for context — only Sub-project 1 is designed and
planned by this doc):

- **Sub-project 2** (highest-risk, fully unbounded, large/growing tables):
  `admin/ippis-records`, `admin/loans`, `admin/loan-requests`,
  `admin/reconciliation`, `admin/clients/:id/activities`.
- **Sub-project 3** (unbounded, smaller tables): `admin/agents`,
  `admin/invites`, `admin/permissions`, `admin/admins`, `admin/roles`,
  `admin/loan-terms`.
- **Sub-project 4** (already capped at `take: 100` but with no real paging):
  `admin/audit-logs`, `admin/clients`, `admin/documents/batches`.
- **Sub-project 5** (client-facing / low-risk, already scoped to one
  principal): `client/loans` (already has `ListLoansQueryDto` — this one
  moves to Sub-project 1 instead, see below), `admin/client-loans`,
  `client/loan-requests`, `client/loan-terms`, `auth/sessions`, wallet
  entries (admin + client).

Concrete filters for waves 2–5, decided during brainstorming so each
later spec can be written straight from this table:

| Endpoint | Exact-match filters | Search (`q`) | Date ranges |
|---|---|---|---|
| `admin/ippis-records` | `employeeStatus`, `agency`, `department`, `grade` | `employeeName`, `staffId` | `hireDateFrom/To`, `createdFrom/To` |
| `admin/loans` | `agency`, `product` | `customerName`, `accountNumber`, `ippisNumber` | `disbursedFrom/To`, `createdFrom/To` |
| `admin/loan-requests` | `status`, `type`, `clientId` | — | `createdFrom/To`, `disbursedFrom/To` |
| `admin/reconciliation` | `status`, `agency`, `period` | — | `generatedFrom/To` |
| `admin/clients/:id/activities` | `type` | — | `occurredFrom/To` |
| `admin/agents` | `status` | `fullName`, `email`, `phone` | `createdFrom/To`, `reviewedFrom/To` |
| `admin/invites` | `status` | `email` | `createdFrom/To`, `expiresFrom/To` |
| `admin/permissions` | — | `key` | — |
| `admin/admins` | `isActive` | `email`, `fullName` | `createdFrom/To` |
| `admin/roles` | — | `name` | — |
| `admin/loan-terms` | `agency`, `isActive` | — | — |
| `admin/audit-logs` | `actorType`, `action`, `targetType`, `targetId` (existing) | — | `createdFrom/To` |
| `admin/clients` | `status` (existing) | `phone` | `createdFrom/To` |
| `admin/documents/batches` | `documentType`, `status` (existing) | `originalFileName`, `period` | `createdFrom/To`, `completedFrom/To` |
| `admin/client-loans` | `status`, `agency` (plus existing required `clientId`) | — | `disbursedFrom/To` |
| `client/loan-requests` | `status` | — | — |
| `client/loan-terms` | — | — | — (pagination only) |
| `auth/sessions` | — | — | `createdFrom/To` |
| wallet entries (admin + client) | `direction`, `actorType` | — | `createdFrom/To` |

## 2. Shared utility (this spec's actual scope)

New module, `src/common/pagination/` (nothing to extend today — this is
built from scratch):

```typescript
// src/common/pagination/pagination.dto.ts
export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  getSkipTake(): { skip: number; take: number } {
    const limit = this.limit ?? 25;
    const page = this.page ?? 1;
    return { skip: (page - 1) * limit, take: limit };
  }
}
```

Every list-endpoint query DTO extends `PaginationDto` (via
`class-transformer`'s `@Type(() => Number)` for query-string-to-number
coercion, since Nest's `ValidationPipe` receives all query params as
strings). `main.ts` configures the global pipe as
`new ValidationPipe({ whitelist: true, transform: true })` — `transform`
already coerces/validates, and `@Max(100)` on `limit` means a caller
requesting `limit=500` gets a `400` (validation failure), not a silent
clamp — matching this app's existing `ValidationPipe` behavior for every
other DTO. (`forbidNonWhitelisted` is not set, so unknown query params are
silently stripped, not rejected — consistent with every other endpoint
today, not something this spec changes.)

```typescript
// src/common/pagination/paginated-result.ts
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
  return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 } };
}
```

Every list service method changes its return shape from `T[]` to
`Promise<PaginatedResult<T>>`, computing `total` via a parallel
`prisma.<model>.count({ where })` alongside the existing `findMany`
(`Promise.all([findMany(...), count(...)])` — same `where` clause reused
for both, so filters and the total stay consistent).

**Search convention**: a `q?: string` field (added per-endpoint, not on
the shared base, since which fields it searches varies) translates to
Prisma `OR: [{ field1: { contains: q, mode: 'insensitive' } }, ...]`
merged into the existing `where`.

**Date-range convention**: field-specific `xFrom`/`xTo` pairs (e.g.
`disbursedFrom`/`disbursedTo`, `createdFrom`/`createdTo`), each
`@IsOptional() @IsISO8601()`, translating to
`{ [field]: { gte: xFrom ? new Date(xFrom) : undefined, lte: xTo ? new Date(xTo) : undefined } }`
— matches the existing `disbursedFrom`/`disbursedTo` precedent in
`ListLoansQueryDto` exactly, just generalized to a shared naming pattern
so future endpoints don't reinvent it.

## 3. Retrofit: `ListLoansQueryDto` / `GET /client/loans`

The one endpoint with an existing well-designed filter DTO. Note on
re-reading `ClientLoansService.getDashboard`: this endpoint does not
return a bare array today — it returns `{ loans: [...], repayments: [...] }`
— and `status` is a value computed per-loan from variance data
(`computeLoanStatus`) *after* the Prisma `findMany`, not a column
`findMany` can filter on directly. So pagination here means: run the
existing `findMany` (filtered by `product`/`disbursedFrom`/`disbursedTo`
at the DB level, as today), compute `status` per loan, filter by `status`
in memory (as today), then apply `skip`/`take` as an in-memory
`.slice()` over that already-filtered array to get the current page, and
compute `total` as that filtered array's `.length` (not a separate
`prisma.count()`, since the filter cannot run purely in SQL). Only
`loans` becomes a `PaginatedResult` — `repayments` is unrelated to this
filter set and stays a plain array, unpaginated, exactly as today. Final
response shape: `{ loans: PaginatedResult<LoanWithStatus>, repayments: RepaymentRecord[] }`.

Change:

```typescript
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

`ClientLoansService`'s list method changes to return
`Promise<PaginatedResult<ClientLoan>>` using the pattern above. This is
the only behavior change in this sub-project beyond adding the shared
utility itself — it doubles as the first real usage/proof of the new
convention before Sub-project 2 applies it at scale.

## 4. Response-shape impact

`GET /client/loans`'s response changes from `{ loans: [...], repayments: [...] }`
to `{ loans: { data: [...], meta: {...} }, repayments: [...] }` — only the
`loans` field gains the envelope; `repayments` is untouched. Any Postman
saved example or test script for this endpoint that reads `res.body.loans`
as a bare array needs updating to read `res.body.loans.data` instead
(check `test/client-loans.e2e-spec.ts` and the Postman collection's
`Client > Loans` folder).

## 5. Testing

- Unit: `PaginationDto.getSkipTake()` — default `page`/`limit`, explicit
  values, `limit` clamped/rejected above 100 (via the DTO's own
  `class-validator` decorators, tested through a direct
  `class-validator`'s `validate()` call, matching how other DTOs in this
  codebase are unit-tested).
- Unit: `buildPaginatedResult()` — correct `totalPages` (including the
  zero-results case, `totalPages: 0`, and a partial-last-page case,
  e.g. `total: 51, limit: 25` → `totalPages: 3`).
- Unit: `ClientLoansService.getDashboard` — `loans` is a `PaginatedResult`,
  `meta.total` reflects the post-status-filter count (not the raw
  `findMany` count), the returned page is a correct `.slice()` of the
  filtered array, `repayments` is unchanged (plain array, no envelope).
- e2e: `GET /client/loans?page=2&limit=1` against a client with 2+ loans
  returns the second loan only in `loans.data`, with correct
  `loans.meta.total`/`totalPages`; existing status/product/date-range e2e
  assertions still pass against the new shape (update assertions to read
  `res.body.loans.data` instead of `res.body.loans`); `repayments` assertions
  unchanged.

## 6. Postman

Per this repo's `CLAUDE.md`: update the existing `GET /client/loans`
saved response examples (all status/product/date-filter variants already
in the collection) to the new `{ data, meta }` shape, and add `page`/
`limit` as documented (but not required) query params on the request
itself.

## 7. Memory

Once Sub-project 1 ships, save a standing convention memory (not part of
this spec's implementation, done directly after) recording: every new list
endpoint must extend `PaginationDto`, return `PaginatedResult<T>` via
`buildPaginatedResult()`, use `q` for free-text search and field-specific
`xFrom`/`xTo` for date ranges, with defaults `page=1`/`limit=25`/
`limit` max `100` — so this isn't re-derived for the next new endpoint
added to the codebase.
