# Admin-Side FK Relation Hydration Design

## 1. Purpose

An audit of every `/admin/*` controller found several endpoints that return
a raw foreign-key column (e.g. `departmentId`, `uploadedById`, `clientId`)
without hydrating the related entity, forcing the frontend into a second
lookup. This spec covers fixing every confirmed gap, promoting two
plain-string admin-id columns (`reviewedBy` on `ClientOnboarding`/`Agent`)
to real Prisma relations, and adding a shared resolver for the codebase's
polymorphic actor/target columns (`AuditLog.actorId`/`targetId`,
`WalletEntry.actorId`), which vary in what table they point to based on an
accompanying type column and can't be expressed as a normal Prisma
`@relation`.

`Session.principalId` was audited too but is explicitly out of scope: no
admin-facing endpoint returns `Session` rows at all (`AdminSessionController`
only exposes revoke actions), so there's nothing to hydrate today.

## 2. Schema change — promote `reviewedBy` to real relations

`ClientOnboarding.reviewedBy` and `Agent.reviewedBy` are both plain
`String?` columns that already store an `AdminUser.id` (or `null`) — every
write to them goes through `req.user.sub` in an authenticated admin
request. Add the relation directly on the existing column, no new column,
no backfill:

```prisma
model ClientOnboarding {
  // ...existing fields...
  reviewedBy      String?
  reviewedByAdmin AdminUser? @relation(fields: [reviewedBy], references: [id])
}

model Agent {
  // ...existing fields...
  reviewedBy      String?
  reviewedByAdmin AdminUser? @relation(fields: [reviewedBy], references: [id])
}

model AdminUser {
  // ...existing fields, alongside the existing sentInvites AdminInvite[]...
  reviewedOnboardings ClientOnboarding[]
  reviewedAgents      Agent[]
}
```

Prisma requires both sides of a relation declared — `AdminUser` already
does this for `AdminInvite.invitedBy` via `sentInvites AdminInvite[]`
(schema.prisma:66); these two new back-relation array fields follow the
identical, already-established pattern, not a new one.

Before applying the migration, verify every non-null `reviewedBy` value on
both tables currently matches a live `AdminUser.id` — Prisma enforces the
FK at the DB level once added, so an orphaned value would fail the
migration. Given the write path described above this is expected to be a
clean no-op check, but it must be run, not assumed.

`AdminClientReviewService.findById` and `AdminAgentReviewController`'s
list/detail queries add `reviewedByAdmin: { select: { id: true, fullName:
true, email: true } }` to their existing includes.

## 3. `PrincipalResolverService` — resolving polymorphic actor/target columns

New file `src/common/principal-resolver.service.ts`, injectable, depends
only on `PrismaService`. A registry maps an exact type-string (as it
actually appears in `AuditActorType`/`targetType` data) to a lookup +
projection:

```typescript
export type PrincipalRef = { type: string; id: string | null };
export type ResolvedPrincipal = Record<string, unknown> | null;

interface RegistryEntry {
  findMany: (prisma: PrismaService, ids: string[]) => Promise<Array<{ id: string } & Record<string, unknown>>>;
  // every findMany above already selects exactly the fields to project —
  // no separate projection step needed.
}

const REGISTRY: Record<string, RegistryEntry> = {
  ADMIN:       { findMany: (p, ids) => p.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }) },
  AGENT:       { findMany: (p, ids) => p.agent.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }) },
  CLIENT:      { findMany: (p, ids) => p.client.findMany({ where: { id: { in: ids } }, select: { id: true, phone: true, status: true } }) },
  AdminUser:   { findMany: (p, ids) => p.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }) },
  Agent:       { findMany: (p, ids) => p.agent.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }) },
  Client:      { findMany: (p, ids) => p.client.findMany({ where: { id: { in: ids } }, select: { id: true, phone: true, status: true } }) },
  AdminInvite: { findMany: (p, ids) => p.adminInvite.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, status: true } }) },
  Department:  { findMany: (p, ids) => p.department.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) },
  LoanRequest: { findMany: (p, ids) => p.loanRequest.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, status: true } }) },
  Permission:  { findMany: (p, ids) => p.permission.findMany({ where: { id: { in: ids } }, select: { id: true, key: true } }) },
  Role:        { findMany: (p, ids) => p.role.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) },
  IppisRecord: { findMany: (p, ids) => p.ippisRecord.findMany({ where: { id: { in: ids } }, select: { id: true, staffId: true, employeeName: true, agency: true } }) },
};
```

`ADMIN`/`AGENT`/`CLIENT` (uppercase, from `AuditActorType`) and
`AdminUser`/`Agent`/`Client` (PascalCase, from free-text `targetType`
values already in use) are distinct, non-colliding keys in the same flat
map — both point at the same underlying tables, just reached via
different columns (`actorType` vs `targetType`) that happen to use
different casing conventions today. `SYSTEM` and any type not in the
registry resolve to `null` without a query.

```typescript
@Injectable()
export class PrincipalResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveMany(refs: PrincipalRef[]): Promise<Map<string, ResolvedPrincipal>> {
    const byType = new Map<string, Set<string>>();
    for (const ref of refs) {
      if (!ref.id || !REGISTRY[ref.type]) continue;
      if (!byType.has(ref.type)) byType.set(ref.type, new Set());
      byType.get(ref.type)!.add(ref.id);
    }

    const result = new Map<string, ResolvedPrincipal>();
    await Promise.all(
      Array.from(byType.entries()).map(async ([type, idSet]) => {
        const rows = await REGISTRY[type].findMany(this.prisma, Array.from(idSet));
        for (const row of rows) {
          result.set(`${type}:${row.id}`, row);
        }
      }),
    );
    return result;
  }
}
```

One `findMany` per distinct type present in a batch (not per row), so a
25-row audit-log page does at most a handful of queries regardless of row
count. Callers look up `` result.get(`${ref.type}:${ref.id}`) `` — `undefined`
(not found) and explicit `null` (unregistered/no id) both mean "nothing to
show," callers normalize both to `null` in the response.

### Response shape

Raw `actorType`/`actorId`/`targetType`/`targetId` stay on the response
(still needed for the existing `ListAuditLogsQueryDto` filters); a new
`actor`/`target` object is added alongside, always present as a key,
`null` when unresolvable:

```json
{
  "actorType": "ADMIN", "actorId": "uuid",
  "actor": { "id": "uuid", "fullName": "Jane Doe", "email": "jane@x.com" },
  "targetType": "Client", "targetId": "uuid",
  "target": { "id": "uuid", "phone": "0801234567", "status": "VERIFIED" }
}
```

`AuditLogService.list` and `WalletEntryService.getWallet` both call
`resolveMany` once per response (collecting every row's actor ref, plus
target refs for audit logs) and map each row to attach `actor`/`target`.

### Fixing `session.service.ts`'s mislabeled audit-log target

`SessionService.rotate` (src/session/session.service.ts:70-76) currently
records `targetType: 'Session'` with `targetId: session.principalId` — but
`session.principalId` is an admin/agent/client id, not a `Session.id`, and
`'Session'` isn't a registered type, so this entry would silently resolve
to `null` forever. Fix the call site to record the actual principal type
instead, reusing the registry's existing PascalCase keys:

```typescript
const targetType = { ADMIN: 'AdminUser', AGENT: 'Agent', CLIENT: 'Client' }[session.principalType];
await this.auditLogService.record({
  actorType: AuditActorType.SYSTEM,
  action: 'session.reuse_detected',
  targetType,
  targetId: session.principalId,
  metadata: { principalType: session.principalType },
});
```

`metadata.principalType` stays (harmless, was already there) even though
it's no longer needed to interpret `targetType`.

## 4. Endpoint-by-endpoint fixes (confirmed gaps)

All follow the codebase's existing house style (`AdminInviteService`'s
`include` + curated projection) — no new abstractions beyond
`PrincipalResolverService` above.

- **`RoleService`** (src/admin-rbac/role.service.ts) — replace the
  existing `ROLE_WITH_PERMISSIONS_INCLUDE` constant with
  `ROLE_WITH_RELATIONS_INCLUDE = { permissions: { include: { permission:
  true } }, department: { select: { id: true, name: true } } }` and use
  it in `create`, `list`, `findById`, **and `update`** — `update`
  currently has no include at all, dropping permissions hydration that
  `list`/`findById` already provide; this fixes that regression too.
- **`DocumentBatchService`** (src/document-ingestion/document-batch.service.ts)
  — add `uploadedBy: { select: { id: true, fullName: true, email: true }
  }` to both `list()` and `findById()`; add `snapshotExport: { select: {
  id: true, documentType: true, generatedAt: true } }` to `list()` (only
  `findById()` has it today).
- **`LoanRequestService`** (src/loan-request/loan-request.service.ts),
  loan-request side — add `client: { select: { id: true, phone: true,
  status: true } }` and `topupTarget: { select: { id: true, status: true,
  agency: true } }` to the queries backing `listAll`, `approve`, `reject`,
  `disburse`. `topupTarget` resolves to `null` automatically when
  `topupTargetId` is null (non-`TOPUP` requests) — no conditional include.
- **`LoanRequestService`**, `ClientLoan` side — add `loanRequest: {
  select: { id: true, type: true, status: true } }` and `client: { select:
  { id: true, phone: true } }` to `listByClient` and
  `buildLoanWithSchedule`.
- **`AdminInviteService.list`** — add `invitedBy: { select: { id: true,
  fullName: true, email: true } }` alongside the existing `include: {
  role: true }`. (`create`/`resend` aren't touched — they manually curate
  their response and don't currently expose `invitedById` bare at all, so
  there's no gap there to fix.)

## 5. Testing

- Unit: `PrincipalResolverService.resolveMany` — one query per distinct
  type in a batch (not per ref); `SYSTEM`/unregistered types/null ids all
  resolve to `null`; correct projected shape per registered type.
- Unit: `RoleService` (all four methods), `DocumentBatchService` (both
  methods), `LoanRequestService` (both loan-request and client-loan
  query groups), `AdminInviteService.list` — extend each service's
  existing spec file asserting the new `include`/`select` clauses and
  that the response carries the hydrated relation.
- Unit: `AuditLogService.list`, `WalletEntryService.getWallet` — `actor`/
  `target` attached correctly, including the `SYSTEM`-actor-resolves-to-
  null case.
- Unit: `SessionService.rotate` — the `session.reuse_detected` audit-log
  call now records the mapped `targetType` (`AdminUser`/`Agent`/`Client`)
  instead of `'Session'`.
- Unit: `AdminClientReviewService.findById`, `AdminAgentReviewController`
  — `reviewedByAdmin` hydrates when set, stays absent/`null` when not yet
  reviewed.
- e2e: one representative endpoint per gap (not all nine) showing the
  hydrated relation in the actual HTTP response, matching this session's
  established e2e-coverage depth for prior work.

## 6. Postman

Per this repo's `CLAUDE.md`: update saved response examples for every
touched endpoint (Roles create/list/get/update; `GET
/admin/documents/batches(/:id)`; loan-request list/approve/reject/
disburse; client-loans list/repayment-plan; `GET /admin/invites`; `GET
/admin/audit-logs`; `GET /admin/clients/:clientId/wallet`; admin
client-review and agent-review list/detail) to show the newly hydrated
fields. No new endpoints — only existing saved-response updates.
