# Agent Admin Visibility Design

## 1. Purpose

Admin already has solid list/filter/action/analytics coverage for the final
`Agent` table (`GET /admin/agents` with status/search/date-range filters,
approve/reject/resend-credentials/onboarding-access actions, and
`GET /admin/agents/analytics`). Two gaps surfaced while auditing this
surface:

1. **No visibility into in-progress recruitment applications.** The
   `AgentApplication` draft model (`EMAIL_PENDING` → `EMAIL_VERIFIED` →
   `SUBMITTED`) only produces a visible `Agent` row once an applicant
   finishes `POST agents/recruitment/submit`. An admin currently has no way
   to see applicants who verified their email or filled in part of the form
   but never finished — those rows are invisible everywhere on the admin
   side.
2. **No itemized "clients onboarded by this agent" list.** `GET
   /admin/clients` only supports a coarse `onboardingSource=AGENT` filter
   ("onboarded by any agent"), and the only per-agent aggregate is a
   leaderboard (counts only, no client list) inside `GET
   /admin/clients/analytics`.

This adds: an `agentId` filter on the existing client list endpoint, and a
new admin-facing `AgentApplication` list/detail/delete/analytics surface.

## 2. Clients onboarded by a specific agent

Add `agentId?: string` (`@IsUUID()`) to `ListClientsQueryDto`
(`src/admin-client-review/dto/list-clients-query.dto.ts`):

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

`AdminClientReviewController.list()` passes `agentId: query.agentId`
through to the service alongside the existing filters.
`AdminClientReviewService.list()`'s `ListClientsFilters` interface gains
`agentId?: string`, and the `where.onboarding` construction becomes:

```typescript
onboarding: {
  ...this.buildOnboardingSourceWhere(filters.onboardingSource),
  ...(filters.agentId ? { onboardedByAgentId: filters.agentId } : {}),
},
```

An explicit `agentId` always wins over the coarser `onboardingSource`
value when both are supplied (admins are expected to use one or the
other in practice, not both). No new permission — this is the same
`clients:review`-gated route, just one more optional filter.

## 3. Agent recruitment applications

New controller `src/admin-agent-review/admin-agent-recruitment-review.controller.ts`
+ service `admin-agent-recruitment-review.service.ts`, added into the
existing `AdminAgentReviewModule` (same module — shares `AuditModule`,
no new module needed).

**Path choice**: mounted at the disjoint base path
`admin/agent-recruitment-applications`, *not* nested under
`admin/agents/:id`. `AgentApplication` is a different Prisma model with a
different lifecycle than `Agent`, and a disjoint path means its routes
never compete for match-order against the existing controller's
`GET admin/agents/:id` route — no risk of a literal segment being
swallowed by an unrelated `:id` param the way `GET admin/agents/analytics`
had to be deliberately ordered before `GET admin/agents/:id` in this same
codebase. Each controller still internally needs its own literal-before-param
ordering (`analytics` before `:id`), but that's now self-contained to one
file.

### `GET admin/agent-recruitment-applications` — list

Permission: `agents:recruitment:read` (new).

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

Service filters: `status` exact match; `q` as `OR` across `email`/`fullName`
(`contains`/`insensitive`, matching the `AdminAgentReviewService.list()`
precedent); `createdFrom`/`createdTo` on `createdAt`; standard
page/limit pagination via `buildPaginatedResult`. Each row is narrowed to
exclude `emailCodeHash`/`emailCodeExpiresAt` (internal verification
secrets, never admin-facing) and includes a `submittedAgent` summary
(`{ id, status }`) when `submittedAgentId` is set, `null` otherwise.

### `GET admin/agent-recruitment-applications/analytics` — funnel counts

Permission: `agents:recruitment:analytics:read` (new). Registered
**before** the `:id` route in this controller (same rule as every other
analytics route in this codebase).

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

Response shape:

```typescript
export interface RecruitmentApplicationAnalyticsSummary {
  totalApplications: number;
  byStatus: Record<AgentApplicationStatus, number>;
  conversionRate: number | null; // submitted / total, 0..1, null when totalApplications === 0
  averageTimeToSubmitHours: number | null; // createdAt -> submittedAgent.createdAt, across SUBMITTED rows; null when none submitted yet
}
```

### `GET admin/agent-recruitment-applications/:id` — detail

Permission: `agents:recruitment:read`. Same narrowed shape as a list row.
`NotFoundException` if missing.

### `DELETE admin/agent-recruitment-applications/:id` — remove an abandoned draft

Permission: `agents:recruitment:manage` (new). Throws `ConflictException`
if `status === SUBMITTED` (that row is tied to a real `Agent` via a unique
FK — deleting it would silently erase that agent's recruitment history,
so submitted applications can never be deleted through this route).
Otherwise hard-deletes the row. Audit-logged (`AuditActorType.ADMIN`,
action `agent_recruitment_application.deleted`, `targetType:
'AgentApplication'`, `targetId: id`) — matching the approve/reject
precedent in this same module, since this is a destructive admin action.
Returns `{ deleted: true }`.

## 4. Permission seed additions

```typescript
{ key: 'agents:recruitment:read', description: 'View in-progress and completed agent recruitment applications' },
{ key: 'agents:recruitment:analytics:read', description: 'View agent recruitment funnel analytics' },
{ key: 'agents:recruitment:manage', description: 'Delete an abandoned agent recruitment application' },
```

## 5. Testing

- Unit: `AdminClientReviewService.list()` — new test confirming `agentId`
  filters to that agent's onboardings, and that it overrides
  `onboardingSource` when both are supplied.
- Unit: `AdminAgentRecruitmentReviewService` — `list()` (status/q/date
  filters, pagination, narrowed shape, `submittedAgent` summary present/
  absent), `findById()` (found + not-found), `getAnalytics()` (byStatus
  fill-every-key behavior matching the `AdminAgentAnalyticsService`
  precedent, conversionRate/averageTimeToSubmitHours null-when-empty
  cases), `remove()` (deletes a non-submitted draft, 409s on a submitted
  one).
- e2e: full recruitment-application admin flow — create a draft via the
  existing public recruitment endpoints, list it, fetch it by id, confirm
  analytics reflects it, delete it (409 case: submit one first, confirm
  delete is blocked); `GET /admin/clients?agentId=...` returns only that
  agent's onboarded clients.
- Postman: new `GET`/`DELETE` entries for the recruitment-applications
  group under Admin, and an updated example on `GET /admin/clients`
  documenting the new `agentId` filter.

## 6. Out of scope

- Any action on a draft other than delete (no "nudge/remind" email, no
  manual status transitions).
- Bulk delete.
- Changing the existing `GET /admin/agents`/`GET /admin/agents/analytics`
  endpoints — they continue to report on the `Agent` table only, unchanged.
