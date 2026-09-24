# Admin-Side FK Relation Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hydrate every admin-side endpoint's bare foreign-key columns (Role.departmentId, DocumentUploadBatch.uploadedById, LoanRequest/ClientLoan's client and cross-loan FKs, AdminInvite.invitedById) with their related entity, promote `reviewedBy` on `ClientOnboarding`/`Agent` to real Prisma relations, and add a shared resolver for the codebase's polymorphic actor/target columns (`AuditLog`, `WalletEntry`) that can't be expressed as a normal `@relation`.

**Architecture:** Straightforward Prisma `include`/`select` additions at each existing query site for the schema-declared FKs (no new abstractions). One new shared `PrincipalResolverService`, registered in `AuditModule` (already imported by `WalletModule`), handles the polymorphic actor/target columns via a type-string registry and batched lookups.

**Tech Stack:** NestJS, Prisma, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-24-admin-fk-relation-hydration-design.md`

## Global Constraints

- No `Co-Authored-By: Claude` trailer on any commit.
- Every existing test's Prisma-call assertions that this plan's changes would break must be updated in the same task that causes the break — never left failing for a later task.
- `Session.principalId` is explicitly out of scope — no admin-facing endpoint returns `Session` rows.
- This plan is its own complete phase — its closing task runs the full unit + e2e suite.

---

### Task 1: Schema — promote `reviewedBy` to real relations

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `ClientOnboarding.reviewedByAdmin` (`AdminUser | null`), `Agent.reviewedByAdmin` (`AdminUser | null`) — consumed by Task 7.

- [ ] **Step 1: Verify no orphaned `reviewedBy` values exist**

Run this against the database `DATABASE_URL` points to (read the value from `.env`, strip `?schema=public` for `psql`, exactly as done earlier this session):

```bash
DB_URL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d'=' -f2- | tr -d '"' | sed 's/?schema=public//')
psql "$DB_URL" -c "
SELECT COUNT(*) FROM \"ClientOnboarding\" co
WHERE co.\"reviewedBy\" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM \"AdminUser\" a WHERE a.id = co.\"reviewedBy\");
"
psql "$DB_URL" -c "
SELECT COUNT(*) FROM \"Agent\" ag
WHERE ag.\"reviewedBy\" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM \"AdminUser\" a WHERE a.id = ag.\"reviewedBy\");
"
```

Expected: both counts are `0`. If either is non-zero, STOP — do not proceed with Step 2 until those specific rows are identified and a decision is made (this plan assumes clean data based on the write path always being `req.user.sub`, but this must be confirmed, not assumed).

- [ ] **Step 2: Add the relations to `prisma/schema.prisma`**

Find the `ClientOnboarding` model's `reviewedBy String?` line and add the relation field directly after it:

```prisma
  reviewedBy String?
  reviewedByAdmin AdminUser? @relation(fields: [reviewedBy], references: [id])
```

Find the `Agent` model's `reviewedBy String?` line and add the relation field directly after it:

```prisma
  reviewedBy             String?
  reviewedByAdmin        AdminUser? @relation(fields: [reviewedBy], references: [id])
```

Find the `AdminUser` model's `sentInvites AdminInvite[]` line and add two back-relation fields directly after it (Prisma requires both sides of a relation declared — this follows the exact same pattern already used for `AdminInvite.invitedBy`):

```prisma
  sentInvites  AdminInvite[]
  reviewedOnboardings ClientOnboarding[]
  reviewedAgents      Agent[]
```

- [ ] **Step 3: Generate and apply the migration**

Run: `npx prisma migrate dev --name promote_reviewedby_to_relations`
Expected: migration created and applied cleanly (no backfill needed — Step 1 already confirmed clean data, and these are relation additions on existing nullable columns, not new columns).

- [ ] **Step 4: Run `tsc` to confirm the generated Prisma client compiles cleanly against existing code**

Run: `npx tsc --noEmit`
Expected: clean (this step only adds new optional relation fields to two models' generated types; nothing existing references a field name that could collide).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: promote ClientOnboarding/Agent reviewedBy to real AdminUser relations"
```

---

### Task 2: `PrincipalResolverService` — resolving polymorphic actor/target columns

**Files:**
- Create: `src/common/principal-resolver.service.ts`
- Create: `src/common/principal-resolver.service.spec.ts`
- Modify: `src/audit/audit.module.ts`
- Modify: `src/audit/audit-log.service.ts`
- Modify: `src/audit/audit-log.service.spec.ts`
- Modify: `src/wallet/wallet.service.ts`
- Modify: `src/wallet/wallet.service.spec.ts`
- Modify: `src/session/session.service.ts`
- Modify: `src/session/session.service.spec.ts`

**Interfaces:**
- Produces: `PrincipalResolverService.resolveMany(refs: PrincipalRef[]): Promise<Map<string, ResolvedPrincipal>>`, `PrincipalRef = { type: string; id: string | null }`, `ResolvedPrincipal = Record<string, unknown> | null`. Map keys are `` `${type}:${id}` ``.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing `PrincipalResolverService` tests**

Create `src/common/principal-resolver.service.spec.ts`:

```typescript
import { PrincipalResolverService } from './principal-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PrincipalResolverService', () => {
  let service: PrincipalResolverService;
  let prisma: {
    adminUser: { findMany: jest.Mock };
    agent: { findMany: jest.Mock };
    client: { findMany: jest.Mock };
    adminInvite: { findMany: jest.Mock };
    department: { findMany: jest.Mock };
    loanRequest: { findMany: jest.Mock };
    permission: { findMany: jest.Mock };
    role: { findMany: jest.Mock };
    ippisRecord: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      adminUser: { findMany: jest.fn() },
      agent: { findMany: jest.fn() },
      client: { findMany: jest.fn() },
      adminInvite: { findMany: jest.fn() },
      department: { findMany: jest.fn() },
      loanRequest: { findMany: jest.fn() },
      permission: { findMany: jest.fn() },
      role: { findMany: jest.fn() },
      ippisRecord: { findMany: jest.fn() },
    };
    service = new PrincipalResolverService(prisma as unknown as PrismaService);
  });

  it('resolves a single ADMIN ref to the projected AdminUser fields', async () => {
    prisma.adminUser.findMany.mockResolvedValue([{ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' }]);

    const result = await service.resolveMany([{ type: 'ADMIN', id: 'admin-1' }]);

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['admin-1'] } },
      select: { id: true, fullName: true, email: true },
    });
    expect(result.get('ADMIN:admin-1')).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
  });

  it('does one query per distinct type in a batch, not one per ref', async () => {
    prisma.adminUser.findMany.mockResolvedValue([
      { id: 'admin-1', fullName: 'A', email: 'a@x.com' },
      { id: 'admin-2', fullName: 'B', email: 'b@x.com' },
    ]);
    prisma.client.findMany.mockResolvedValue([{ id: 'client-1', phone: '0801', status: 'VERIFIED' }]);

    const result = await service.resolveMany([
      { type: 'ADMIN', id: 'admin-1' },
      { type: 'ADMIN', id: 'admin-2' },
      { type: 'Client', id: 'client-1' },
    ]);

    expect(prisma.adminUser.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.adminUser.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['admin-1', 'admin-2'] } },
      select: { id: true, fullName: true, email: true },
    });
    expect(prisma.client.findMany).toHaveBeenCalledTimes(1);
    expect(result.get('ADMIN:admin-1')).toEqual({ id: 'admin-1', fullName: 'A', email: 'a@x.com' });
    expect(result.get('ADMIN:admin-2')).toEqual({ id: 'admin-2', fullName: 'B', email: 'b@x.com' });
    expect(result.get('Client:client-1')).toEqual({ id: 'client-1', phone: '0801', status: 'VERIFIED' });
  });

  it('does not query for a SYSTEM ref or a null id, and the map has no entry for them', async () => {
    const result = await service.resolveMany([
      { type: 'SYSTEM', id: null },
      { type: 'ADMIN', id: null },
    ]);

    expect(prisma.adminUser.findMany).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('does not query for an unregistered type', async () => {
    const result = await service.resolveMany([{ type: 'NotARealType', id: 'x' }]);

    expect(result.size).toBe(0);
  });

  it('resolves every registered type to its documented projection', async () => {
    prisma.agent.findMany.mockResolvedValue([{ id: 'agent-1', fullName: 'Agent A', email: 'agent@x.com' }]);
    prisma.adminInvite.findMany.mockResolvedValue([{ id: 'invite-1', email: 'invited@x.com', status: 'PENDING' }]);
    prisma.department.findMany.mockResolvedValue([{ id: 'dept-1', name: 'Finance' }]);
    prisma.loanRequest.findMany.mockResolvedValue([{ id: 'lr-1', type: 'ORIGINATION', status: 'PENDING' }]);
    prisma.permission.findMany.mockResolvedValue([{ id: 'perm-1', key: 'admins:create' }]);
    prisma.role.findMany.mockResolvedValue([{ id: 'role-1', name: 'SUPER_ADMIN' }]);
    prisma.ippisRecord.findMany.mockResolvedValue([
      { id: 'ippis-1', staffId: 'NPF-001', employeeName: 'Jane Doe', agency: 'NPF' },
    ]);

    const result = await service.resolveMany([
      { type: 'AGENT', id: 'agent-1' },
      { type: 'AdminInvite', id: 'invite-1' },
      { type: 'Department', id: 'dept-1' },
      { type: 'LoanRequest', id: 'lr-1' },
      { type: 'Permission', id: 'perm-1' },
      { type: 'Role', id: 'role-1' },
      { type: 'IppisRecord', id: 'ippis-1' },
    ]);

    expect(result.get('AGENT:agent-1')).toEqual({ id: 'agent-1', fullName: 'Agent A', email: 'agent@x.com' });
    expect(result.get('AdminInvite:invite-1')).toEqual({ id: 'invite-1', email: 'invited@x.com', status: 'PENDING' });
    expect(result.get('Department:dept-1')).toEqual({ id: 'dept-1', name: 'Finance' });
    expect(result.get('LoanRequest:lr-1')).toEqual({ id: 'lr-1', type: 'ORIGINATION', status: 'PENDING' });
    expect(result.get('Permission:perm-1')).toEqual({ id: 'perm-1', key: 'admins:create' });
    expect(result.get('Role:role-1')).toEqual({ id: 'role-1', name: 'SUPER_ADMIN' });
    expect(result.get('IppisRecord:ippis-1')).toEqual({
      id: 'ippis-1',
      staffId: 'NPF-001',
      employeeName: 'Jane Doe',
      agency: 'NPF',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/common/principal-resolver.service.spec.ts`
Expected: FAIL — `principal-resolver.service.ts` doesn't exist yet.

- [ ] **Step 3: Create `PrincipalResolverService`**

Create `src/common/principal-resolver.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PrincipalRef {
  type: string;
  id: string | null;
}

export type ResolvedPrincipal = Record<string, unknown> | null;

interface RegistryEntry {
  findMany: (prisma: PrismaService, ids: string[]) => Promise<Array<{ id: string } & Record<string, unknown>>>;
}

const REGISTRY: Record<string, RegistryEntry> = {
  ADMIN: {
    findMany: (p, ids) =>
      p.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }),
  },
  AGENT: {
    findMany: (p, ids) =>
      p.agent.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }),
  },
  CLIENT: {
    findMany: (p, ids) =>
      p.client.findMany({ where: { id: { in: ids } }, select: { id: true, phone: true, status: true } }),
  },
  AdminUser: {
    findMany: (p, ids) =>
      p.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }),
  },
  Agent: {
    findMany: (p, ids) =>
      p.agent.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } }),
  },
  Client: {
    findMany: (p, ids) =>
      p.client.findMany({ where: { id: { in: ids } }, select: { id: true, phone: true, status: true } }),
  },
  AdminInvite: {
    findMany: (p, ids) =>
      p.adminInvite.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, status: true } }),
  },
  Department: {
    findMany: (p, ids) => p.department.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  },
  LoanRequest: {
    findMany: (p, ids) =>
      p.loanRequest.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, status: true } }),
  },
  Permission: {
    findMany: (p, ids) => p.permission.findMany({ where: { id: { in: ids } }, select: { id: true, key: true } }),
  },
  Role: {
    findMany: (p, ids) => p.role.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  },
  IppisRecord: {
    findMany: (p, ids) =>
      p.ippisRecord.findMany({
        where: { id: { in: ids } },
        select: { id: true, staffId: true, employeeName: true, agency: true },
      }),
  },
};

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/common/principal-resolver.service.spec.ts`
Expected: PASS — 5/5.

- [ ] **Step 5: Register `PrincipalResolverService` in `AuditModule`**

Replace `src/audit/audit.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';
import { PrincipalResolverService } from '../common/principal-resolver.service';

@Module({
  providers: [AuditLogService, AuditInterceptor, PrincipalResolverService],
  exports: [AuditLogService, AuditInterceptor, PrincipalResolverService],
})
export class AuditModule {}
```

- [ ] **Step 6: Write the failing `AuditLogService.list` resolution tests**

In `src/audit/audit-log.service.spec.ts`, update the `beforeEach` and imports:

```typescript
import { AuditLogService } from './audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { PrincipalResolverService } from '../common/principal-resolver.service';
import { AuditActorType } from '../generated/prisma/client';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let prisma: { auditLog: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock } };
  let principalResolver: { resolveMany: jest.Mock };

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() } };
    principalResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
    service = new AuditLogService(prisma as unknown as PrismaService, principalResolver as unknown as PrincipalResolverService);
  });
```

Add these tests to the `describe('list', ...)` block, after the existing three tests:

```typescript
    it('attaches resolved actor and target objects to each row', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          actorType: AuditActorType.ADMIN,
          actorId: 'admin-1',
          action: 'client.sessions.revoked',
          targetType: 'Client',
          targetId: 'client-1',
        },
      ]);
      prisma.auditLog.count.mockResolvedValue(1);
      principalResolver.resolveMany.mockResolvedValue(
        new Map<string, unknown>([
          ['ADMIN:admin-1', { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' }],
          ['Client:client-1', { id: 'client-1', phone: '0801', status: 'VERIFIED' }],
        ]),
      );

      const result = await service.list();

      expect(principalResolver.resolveMany).toHaveBeenCalledWith([
        { type: AuditActorType.ADMIN, id: 'admin-1' },
        { type: 'Client', id: 'client-1' },
      ]);
      expect(result.data[0].actor).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
      expect(result.data[0].target).toEqual({ id: 'client-1', phone: '0801', status: 'VERIFIED' });
    });

    it('attaches null actor/target when the row has no target or is unresolvable', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        { id: 'log-1', actorType: AuditActorType.SYSTEM, actorId: null, action: 'session.reuse_detected', targetType: null, targetId: null },
      ]);
      prisma.auditLog.count.mockResolvedValue(1);
      principalResolver.resolveMany.mockResolvedValue(new Map());

      const result = await service.list();

      expect(result.data[0].actor).toBeNull();
      expect(result.data[0].target).toBeNull();
    });
```

- [ ] **Step 7: Run the tests to verify the two new ones fail**

Run: `npx jest src/audit/audit-log.service.spec.ts`
Expected: FAIL — `AuditLogService` doesn't accept a second constructor argument yet, and `list()` doesn't attach `actor`/`target`.

- [ ] **Step 8: Update `AuditLogService`**

Replace `src/audit/audit-log.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, AuditLog, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { PrincipalResolverService } from '../common/principal-resolver.service';

export interface RecordAuditEventParams {
  actorType: AuditActorType;
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
}

export interface ListAuditEventsFilters {
  actorType?: AuditActorType;
  action?: string;
  targetType?: string;
  targetId?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principalResolver: PrincipalResolverService,
  ) {}

  async record(params: RecordAuditEventParams): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorType: params.actorType,
        actorId: params.actorId,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        metadata: params.metadata,
        ip: params.ip,
        userAgent: params.userAgent,
      },
    });
  }

  async list(
    filters: ListAuditEventsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<AuditLog & { actor: Record<string, unknown> | null; target: Record<string, unknown> | null }>> {
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

    const refs = [
      ...data.map((row) => ({ type: row.actorType as string, id: row.actorId })),
      ...data.map((row) => ({ type: row.targetType ?? '', id: row.targetId })),
    ];
    const resolved = await this.principalResolver.resolveMany(refs);

    const enriched = data.map((row) => ({
      ...row,
      actor: (row.actorId && resolved.get(`${row.actorType}:${row.actorId}`)) || null,
      target: (row.targetType && row.targetId && resolved.get(`${row.targetType}:${row.targetId}`)) || null,
    }));

    return buildPaginatedResult(enriched, total, page, limit);
  }
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx jest src/audit/audit-log.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 10: Update `AuditLogModule` consumers' DI (none needed beyond Step 5)**

`AdminAuditLogController` already injects `AuditLogService` via NestJS DI (constructor injection through the module graph), and `AuditModule` now provides `PrincipalResolverService` alongside it — no controller change needed. Confirm by reading `src/admin-audit-log/admin-audit-log.module.ts` and `src/audit/audit.module.ts` import graph: `AdminAuditLogModule` imports `AuditModule`? Check with:

```bash
cat src/admin-audit-log/admin-audit-log.module.ts
```

If it does NOT already import `AuditModule` (it may import `AuditLogService` some other way), add `AuditModule` to its `imports` array so `AuditLogService`'s new `PrincipalResolverService` dependency resolves. (This is a read-and-verify step, not a blind edit — only change the file if the import is actually missing.)

- [ ] **Step 11: Write the failing `WalletService.getWallet` resolution test**

In `src/wallet/wallet.service.spec.ts`, update imports and `beforeEach`:

```typescript
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { PrincipalResolverService } from '../common/principal-resolver.service';
import { AuditActorType, WalletEntryDirection } from '../generated/prisma/client';

describe('WalletService', () => {
  let service: WalletService;
  let prisma: {
    client: { findUnique: jest.Mock };
    walletEntry: { findMany: jest.Mock; create: jest.Mock; count: jest.Mock };
  };
  let principalResolver: { resolveMany: jest.Mock };

  const adminActor = { actorType: AuditActorType.ADMIN, actorId: 'admin-1' };

  beforeEach(() => {
    prisma = {
      client: { findUnique: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      walletEntry: { findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
    };
    principalResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
    service = new WalletService(prisma as unknown as PrismaService, principalResolver as unknown as PrincipalResolverService);
  });
```

Add this test inside the `describe('getWallet', ...)` block, after the existing tests:

```typescript
    it('attaches a resolved actor object to each entry', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { id: 'entry-1', amount: 5000, direction: WalletEntryDirection.CREDIT, actorType: AuditActorType.ADMIN, actorId: 'admin-1' },
      ]);
      prisma.walletEntry.count.mockResolvedValue(1);
      principalResolver.resolveMany.mockResolvedValue(
        new Map<string, unknown>([['ADMIN:admin-1', { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' }]]),
      );

      const result = await service.getWallet('client-1');

      expect(principalResolver.resolveMany).toHaveBeenCalledWith([{ type: AuditActorType.ADMIN, id: 'admin-1' }]);
      expect(result.entries.data[0].actor).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });
```

- [ ] **Step 12: Run the tests to verify the new one fails**

Run: `npx jest src/wallet/wallet.service.spec.ts`
Expected: FAIL — `WalletService` doesn't accept a second constructor argument yet.

- [ ] **Step 13: Update `WalletService`**

Replace `src/wallet/wallet.service.ts`:

```typescript
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, Prisma, WalletEntry, WalletEntryDirection } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { PrincipalResolverService } from '../common/principal-resolver.service';

export interface WalletActor {
  actorType: AuditActorType;
  actorId?: string;
}

export interface ListWalletEntriesFilters {
  direction?: WalletEntryDirection;
  actorType?: AuditActorType;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principalResolver: PrincipalResolverService,
  ) {}

  async getWallet(
    clientId: string,
    filters: ListWalletEntriesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<{ balance: number; entries: PaginatedResult<WalletEntry & { actor: Record<string, unknown> | null }> }> {
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

    const resolved = await this.principalResolver.resolveMany(
      data.map((row) => ({ type: row.actorType as string, id: row.actorId })),
    );
    const enriched = data.map((row) => ({
      ...row,
      actor: (row.actorId && resolved.get(`${row.actorType}:${row.actorId}`)) || null,
    }));

    return { balance, entries: buildPaginatedResult(enriched, total, page, limit) };
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

  async credit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry> {
    await this.assertClientExists(clientId);

    return this.prisma.walletEntry.create({
      data: {
        clientId,
        amount,
        direction: WalletEntryDirection.CREDIT,
        description,
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    });
  }

  async debit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry> {
    const balance = await this.getBalance(clientId);

    if (amount > balance) {
      throw new UnprocessableEntityException('Insufficient wallet balance');
    }

    return this.prisma.walletEntry.create({
      data: {
        clientId,
        amount,
        direction: WalletEntryDirection.DEBIT,
        description,
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    });
  }

  private async assertClientExists(clientId: string): Promise<void> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new NotFoundException('Client not found');
    }
  }

  private sumEntries(entries: Array<{ amount: unknown; direction: WalletEntryDirection }>): number {
    return entries.reduce((total, entry) => {
      const amount = Number(entry.amount);
      return total + (entry.direction === WalletEntryDirection.CREDIT ? amount : -amount);
    }, 0);
  }
}
```

- [ ] **Step 14: Run the tests to verify they pass**

Run: `npx jest src/wallet/wallet.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 15: Write the failing test for the `session.service.ts` targetType fix**

In `src/session/session.service.spec.ts`, add this assertion inside the existing `'treats presenting an already-revoked token as reuse...'` test (from Task context: it's the test with `principalType: SessionPrincipalType.CLIENT`), right after the existing `auditLogService.record` assertion:

```typescript
    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'Client', targetId: 'client-1' }),
    );
```

- [ ] **Step 16: Run the test to verify it fails**

Run: `npx jest src/session/session.service.spec.ts`
Expected: FAIL — `targetType` is currently the literal string `'Session'`, not `'Client'`.

- [ ] **Step 17: Fix `session.service.ts`**

In `src/session/session.service.ts`, replace:

```typescript
    if (session.revokedAt) {
      await this.revokeAllForPrincipal(session.principalType, session.principalId, 'reuse_detected');
      await this.auditLogService.record({
        actorType: AuditActorType.SYSTEM,
        action: 'session.reuse_detected',
        targetType: 'Session',
        targetId: session.principalId,
        metadata: { principalType: session.principalType },
      });
      throw new UnauthorizedException('Invalid refresh token');
    }
```

with:

```typescript
    if (session.revokedAt) {
      await this.revokeAllForPrincipal(session.principalType, session.principalId, 'reuse_detected');
      const targetType: Record<SessionPrincipalType, string> = {
        ADMIN: 'AdminUser',
        AGENT: 'Agent',
        CLIENT: 'Client',
      };
      await this.auditLogService.record({
        actorType: AuditActorType.SYSTEM,
        action: 'session.reuse_detected',
        targetType: targetType[session.principalType],
        targetId: session.principalId,
        metadata: { principalType: session.principalType },
      });
      throw new UnauthorizedException('Invalid refresh token');
    }
```

- [ ] **Step 18: Run the test to verify it passes**

Run: `npx jest src/session/session.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 19: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 20: Commit**

```bash
git add src/common/principal-resolver.service.ts src/common/principal-resolver.service.spec.ts src/audit/audit.module.ts src/audit/audit-log.service.ts src/audit/audit-log.service.spec.ts src/wallet/wallet.service.ts src/wallet/wallet.service.spec.ts src/session/session.service.ts src/session/session.service.spec.ts
git commit -m "feat: add PrincipalResolverService and wire it into audit log and wallet entry resolution"
```

(If Step 10 required editing `src/admin-audit-log/admin-audit-log.module.ts`, `git add` that file too in this same commit.)

---

### Task 3: `RoleService` — hydrate department (Gap A)

**Files:**
- Modify: `src/admin-rbac/role.service.ts`
- Modify: `src/admin-rbac/role.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (Role.departmentId relation already exists in the schema).

- [ ] **Step 1: Update the existing strict tests that will break**

In `src/admin-rbac/role.service.spec.ts`, replace:

```typescript
  it('create stores the departmentId when given', async () => {
    prisma.role.create.mockResolvedValue({ id: 'role-2', name: 'REVIEWER', departmentId: 'dept-1' });
    await service.create({ name: 'REVIEWER', departmentId: 'dept-1' });
    expect(prisma.role.create).toHaveBeenCalledWith({ data: { name: 'REVIEWER', departmentId: 'dept-1' } });
  });
```

with:

```typescript
  it('create stores the departmentId when given, and hydrates department/permissions in the response', async () => {
    prisma.role.create.mockResolvedValue({ id: 'role-2', name: 'REVIEWER', departmentId: 'dept-1' });
    await service.create({ name: 'REVIEWER', departmentId: 'dept-1' });
    expect(prisma.role.create).toHaveBeenCalledWith({
      data: { name: 'REVIEWER', departmentId: 'dept-1' },
      include: { permissions: { include: { permission: true } }, department: { select: { id: true, name: true } } },
    });
  });
```

Replace:

```typescript
  it('update allows editing SUPER_ADMIN description without touching name', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN', description: 'new' });
    await service.update('role-1', { description: 'new' });
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { name: undefined, description: 'new', departmentId: undefined },
    });
  });
```

with:

```typescript
  it('update allows editing SUPER_ADMIN description without touching name, and hydrates department/permissions', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN', description: 'new' });
    await service.update('role-1', { description: 'new' });
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { name: undefined, description: 'new', departmentId: undefined },
      include: { permissions: { include: { permission: true } }, department: { select: { id: true, name: true } } },
    });
  });
```

Replace:

```typescript
  it('update sets departmentId when given, and clears it when explicitly set to null', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'REVIEWER' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'REVIEWER', departmentId: null });
    await service.update('role-1', { departmentId: null });
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { name: undefined, description: undefined, departmentId: null },
    });
  });
```

with:

```typescript
  it('update sets departmentId when given, and clears it when explicitly set to null', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'REVIEWER' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'REVIEWER', departmentId: null });
    await service.update('role-1', { departmentId: null });
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { name: undefined, description: undefined, departmentId: null },
      include: { permissions: { include: { permission: true } }, department: { select: { id: true, name: true } } },
    });
  });
```

Add a new test to the `describe('list', ...)` block confirming the include shape:

```typescript
    it('includes department alongside permissions', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      prisma.role.count.mockResolvedValue(0);

      await service.list();

      expect(prisma.role.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { permissions: { include: { permission: true } }, department: { select: { id: true, name: true } } },
        }),
      );
    });
```

- [ ] **Step 2: Run the tests to verify the updated/new ones fail**

Run: `npx jest src/admin-rbac/role.service.spec.ts`
Expected: FAIL — `create`/`update` don't send `include` yet, `list` still uses the old `ROLE_WITH_PERMISSIONS_INCLUDE`.

- [ ] **Step 3: Update `RoleService`**

In `src/admin-rbac/role.service.ts`, replace:

```typescript
const ROLE_WITH_PERMISSIONS_INCLUDE = {
  permissions: { include: { permission: true } },
} as const;
```

with:

```typescript
const ROLE_WITH_RELATIONS_INCLUDE = {
  permissions: { include: { permission: true } },
  department: { select: { id: true, name: true } },
} as const;
```

Replace:

```typescript
  async create(params: CreateRoleParams): Promise<Role> {
    try {
      return await this.prisma.role.create({ data: params });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A role named "${params.name}" already exists`);
      }
      throw error;
    }
  }
```

with:

```typescript
  async create(params: CreateRoleParams): Promise<Role> {
    try {
      return await this.prisma.role.create({ data: params, include: ROLE_WITH_RELATIONS_INCLUDE });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A role named "${params.name}" already exists`);
      }
      throw error;
    }
  }
```

Replace the three remaining references to `ROLE_WITH_PERMISSIONS_INCLUDE` (in `list`, `findById`) with `ROLE_WITH_RELATIONS_INCLUDE`:

```typescript
      this.prisma.role.findMany({
        where,
        include: ROLE_WITH_RELATIONS_INCLUDE,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
```

```typescript
  async findById(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: ROLE_WITH_RELATIONS_INCLUDE,
    });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    return role;
  }
```

Replace:

```typescript
  async update(id: string, params: UpdateRoleParams): Promise<Role> {
    const role = await this.findById(id);
    if (role.name === SUPER_ADMIN_ROLE_NAME && params.name && params.name !== role.name) {
      throw new ConflictException('The SUPER_ADMIN role cannot be renamed');
    }
    return this.prisma.role.update({
      where: { id },
      data: { name: params.name, description: params.description, departmentId: params.departmentId },
    });
  }
```

with:

```typescript
  async update(id: string, params: UpdateRoleParams): Promise<Role> {
    const role = await this.findById(id);
    if (role.name === SUPER_ADMIN_ROLE_NAME && params.name && params.name !== role.name) {
      throw new ConflictException('The SUPER_ADMIN role cannot be renamed');
    }
    return this.prisma.role.update({
      where: { id },
      data: { name: params.name, description: params.description, departmentId: params.departmentId },
      include: ROLE_WITH_RELATIONS_INCLUDE,
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/admin-rbac/role.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 5: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/admin-rbac/role.service.ts src/admin-rbac/role.service.spec.ts
git commit -m "feat: hydrate department alongside permissions on every RoleService response"
```

---

### Task 4: `DocumentBatchService` — hydrate uploadedBy and snapshotExport consistency (Gap B)

**Files:**
- Modify: `src/document-ingestion/document-batch.service.ts`
- Modify: `src/document-ingestion/document-batch.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Update the existing strict tests that will break, and add a new one**

In `src/document-ingestion/document-batch.service.spec.ts`, replace:

```typescript
  it('findById includes the snapshot export', async () => {
    prisma.documentUploadBatch.findUnique.mockResolvedValue({ id: 'batch-1' });
    await service.findById('batch-1');
    expect(prisma.documentUploadBatch.findUnique).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      include: { snapshotExport: true },
    });
  });
```

with:

```typescript
  it('findById includes the snapshot export and uploadedBy', async () => {
    prisma.documentUploadBatch.findUnique.mockResolvedValue({ id: 'batch-1' });
    await service.findById('batch-1');
    expect(prisma.documentUploadBatch.findUnique).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      include: {
        snapshotExport: true,
        uploadedBy: { select: { id: true, fullName: true, email: true } },
      },
    });
  });
```

Replace:

```typescript
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
```

with:

```typescript
      expect(prisma.documentUploadBatch.findMany).toHaveBeenCalledWith({
        where: {
          documentType: DocumentType.DISBURSED_LOANS,
          status: DocumentBatchStatus.COMPLETED,
          createdAt: undefined,
          completedAt: undefined,
          OR: undefined,
        },
        include: {
          uploadedBy: { select: { id: true, fullName: true, email: true } },
          snapshotExport: { select: { id: true, documentType: true, generatedAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 25,
      });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/document-ingestion/document-batch.service.spec.ts`
Expected: FAIL — neither `findById` nor `list` sends the new `include` yet.

- [ ] **Step 3: Update `DocumentBatchService`**

In `src/document-ingestion/document-batch.service.ts`, replace:

```typescript
  async findById(batchId: string) {
    return this.prisma.documentUploadBatch.findUnique({
      where: { id: batchId },
      include: { snapshotExport: true },
    });
  }
```

with:

```typescript
  async findById(batchId: string) {
    return this.prisma.documentUploadBatch.findUnique({
      where: { id: batchId },
      include: {
        snapshotExport: true,
        uploadedBy: { select: { id: true, fullName: true, email: true } },
      },
    });
  }
```

Replace:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.documentUploadBatch.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.documentUploadBatch.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
}
```

with:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.documentUploadBatch.findMany({
        where,
        include: {
          uploadedBy: { select: { id: true, fullName: true, email: true } },
          snapshotExport: { select: { id: true, documentType: true, generatedAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.documentUploadBatch.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/document-ingestion/document-batch.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 5: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/document-ingestion/document-batch.service.ts src/document-ingestion/document-batch.service.spec.ts
git commit -m "feat: hydrate uploadedBy on document batch responses, consistent snapshotExport on list"
```

---

### Task 5: `LoanRequestService` — hydrate client/topupTarget and loanRequest/client (Gaps C + D)

**Files:**
- Modify: `src/loan-request/loan-request.service.ts`
- Modify: `src/loan-request/loan-request.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Update the existing strict tests that will break, and add new ones**

In `src/loan-request/loan-request.service.spec.ts`, replace:

```typescript
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'APPROVED', approvedAt: expect.any(Date) },
      });
    });
  });

  describe('reject', () => {
```

with:

```typescript
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'APPROVED', approvedAt: expect.any(Date) },
        include: {
          client: { select: { id: true, phone: true, status: true } },
          topupTarget: { select: { id: true, status: true, agency: true } },
        },
      });
    });
  });

  describe('reject', () => {
```

Replace:

```typescript
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'REJECTED', rejectionReason: 'not eligible' },
      });
    });
  });

  describe('disburse', () => {
```

with:

```typescript
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'REJECTED', rejectionReason: 'not eligible' },
        include: {
          client: { select: { id: true, phone: true, status: true } },
          topupTarget: { select: { id: true, status: true, agency: true } },
        },
      });
    });
  });

  describe('disburse', () => {
```

Replace:

```typescript
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', disbursedAt: expect.any(Date) },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ disbursedAmount: 5000, principalAmount: 5000 }),
      });
    });
  });
```

with:

```typescript
      expect(prisma.loanRequest.update).toHaveBeenCalledWith({
        where: { id: 'lr1' },
        data: { status: 'DISBURSED', disbursedAt: expect.any(Date) },
        include: {
          client: { select: { id: true, phone: true, status: true } },
          topupTarget: { select: { id: true, status: true, agency: true } },
        },
      });
      expect(prisma.clientLoan.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ disbursedAmount: 5000, principalAmount: 5000 }),
      });
    });
  });
```

Add a new test inside `describe('listAll', ...)`, after the existing one:

```typescript
    it('includes client and topupTarget on every row', async () => {
      prisma.loanRequest.findMany.mockResolvedValue([]);
      prisma.loanRequest.count.mockResolvedValue(0);

      await service.listAll();

      expect(prisma.loanRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            client: { select: { id: true, phone: true, status: true } },
            topupTarget: { select: { id: true, status: true, agency: true } },
          },
        }),
      );
    });
```

Add a new test inside `describe('listByClient', ...)`, after the existing ones:

```typescript
    it('includes loanRequest and client on every row', async () => {
      prisma.clientLoan.findMany.mockResolvedValue([]);
      prisma.clientLoan.count.mockResolvedValue(0);

      await service.listByClient('client-1');

      expect(prisma.clientLoan.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            loanRequest: { select: { id: true, type: true, status: true } },
            client: { select: { id: true, phone: true } },
          },
        }),
      );
    });
```

Add a new test inside `describe('getRepaymentPlanById', ...)`, after the existing ones:

```typescript
    it('includes loanRequest and client when fetching the loan', async () => {
      prisma.clientLoan.findUnique.mockResolvedValue({
        id: 'cl1',
        clientId: 'c1',
        principalAmount: 90000,
        interestRatePercent: 0,
        disbursementDate: new Date(2026, 0, 1),
        maturationDate: new Date(2026, 0, 1),
      });
      prisma.clientLoanRepaymentVariance.findMany.mockResolvedValue([]);

      await service.getRepaymentPlanById('cl1');

      expect(prisma.clientLoan.findUnique).toHaveBeenCalledWith({
        where: { id: 'cl1' },
        include: {
          loanRequest: { select: { id: true, type: true, status: true } },
          client: { select: { id: true, phone: true } },
        },
      });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: FAIL — none of `approve`/`reject`/`disburse`/`listAll`/`listByClient`/`getRepaymentPlanById` send the new `include` yet.

- [ ] **Step 3: Update `LoanRequestService`**

In `src/loan-request/loan-request.service.ts`, replace:

```typescript
  async approve(id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to approve');
    }
    return this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.APPROVED, approvedAt: new Date() },
    });
  }

  async reject(id: string, reason: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to reject');
    }
    return this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.REJECTED, rejectionReason: reason },
    });
  }

  async disburse(id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.APPROVED) {
      throw new ConflictException('Loan request must be APPROVED to disburse');
    }
    const updated = await this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.DISBURSED, disbursedAt: new Date() },
    });
    await this.createClientLoanFromRequest(id);
    return updated;
  }
```

with:

```typescript
  private static readonly LOAN_REQUEST_RELATIONS_INCLUDE = {
    client: { select: { id: true, phone: true, status: true } },
    topupTarget: { select: { id: true, status: true, agency: true } },
  } as const;

  async approve(id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to approve');
    }
    return this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.APPROVED, approvedAt: new Date() },
      include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
    });
  }

  async reject(id: string, reason: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.CONFIRMED) {
      throw new ConflictException('Loan request must be CONFIRMED to reject');
    }
    return this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.REJECTED, rejectionReason: reason },
      include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
    });
  }

  async disburse(id: string) {
    const loanRequest = await this.prisma.loanRequest.findUnique({ where: { id } });
    if (!loanRequest || loanRequest.status !== LoanRequestStatus.APPROVED) {
      throw new ConflictException('Loan request must be APPROVED to disburse');
    }
    const updated = await this.prisma.loanRequest.update({
      where: { id },
      data: { status: LoanRequestStatus.DISBURSED, disbursedAt: new Date() },
      include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
    });
    await this.createClientLoanFromRequest(id);
    return updated;
  }
```

Replace:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.loanRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.loanRequest.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async listByClient(
```

with:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.loanRequest.findMany({
        where,
        include: LoanRequestService.LOAN_REQUEST_RELATIONS_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.loanRequest.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async listByClient(
```

Replace:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.clientLoan.findMany({ where, orderBy: { disbursementDate: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.clientLoan.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async exportDisbursementSummaryCsv(month: string): Promise<string> {
```

with:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.clientLoan.findMany({
        where,
        include: {
          loanRequest: { select: { id: true, type: true, status: true } },
          client: { select: { id: true, phone: true } },
        },
        orderBy: { disbursementDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.clientLoan.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async exportDisbursementSummaryCsv(month: string): Promise<string> {
```

Replace:

```typescript
  async getRepaymentPlanById(clientLoanId: string) {
    const clientLoan = await this.prisma.clientLoan.findUnique({ where: { id: clientLoanId } });
    if (!clientLoan) {
      throw new NotFoundException('Loan not found');
    }
    return this.buildLoanWithSchedule(clientLoan);
  }
```

with:

```typescript
  async getRepaymentPlanById(clientLoanId: string) {
    const clientLoan = await this.prisma.clientLoan.findUnique({
      where: { id: clientLoanId },
      include: {
        loanRequest: { select: { id: true, type: true, status: true } },
        client: { select: { id: true, phone: true } },
      },
    });
    if (!clientLoan) {
      throw new NotFoundException('Loan not found');
    }
    return this.buildLoanWithSchedule(clientLoan);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/loan-request/loan-request.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 5: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean. Note: `buildLoanWithSchedule`'s parameter type is `ClientLoan` (the plain Prisma model type) — since `getRepaymentPlanById` now passes a value with extra `loanRequest`/`client` properties (a structurally-compatible superset), this remains assignable without a signature change, same as how `getMyLoan`'s plain `ClientLoan` (no include) already works today.

- [ ] **Step 6: Commit**

```bash
git add src/loan-request/loan-request.service.ts src/loan-request/loan-request.service.spec.ts
git commit -m "feat: hydrate client/topupTarget on LoanRequest and loanRequest/client on ClientLoan responses"
```

---

### Task 6: `AdminInviteService.list` — hydrate invitedBy (Gap E)

**Files:**
- Modify: `src/admin-invite/admin-invite.service.ts`
- Modify: `src/admin-invite/admin-invite.service.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Update the four existing strict `list` tests**

In `src/admin-invite/admin-invite.service.spec.ts`, every occurrence of `include: { role: true }` inside the `describe('list', ...)` block becomes `include: { role: true, invitedBy: { select: { id: true, fullName: true, email: true } } }`. Replace:

```typescript
      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 25, include: { role: true } }),
      );
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
          include: { role: true },
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
          include: { role: true },
        }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(6);

      const result = await service.list({}, { page: 2, limit: 3 });

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 3, take: 3, include: { role: true } }),
      );
      expect(result.meta).toEqual({ total: 6, page: 2, limit: 3, totalPages: 2 });
    });
  });
```

with:

```typescript
      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 25,
          include: { role: true, invitedBy: { select: { id: true, fullName: true, email: true } } },
        }),
      );
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
          include: { role: true, invitedBy: { select: { id: true, fullName: true, email: true } } },
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
          include: { role: true, invitedBy: { select: { id: true, fullName: true, email: true } } },
        }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(6);

      const result = await service.list({}, { page: 2, limit: 3 });

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 3,
          take: 3,
          include: { role: true, invitedBy: { select: { id: true, fullName: true, email: true } } },
        }),
      );
      expect(result.meta).toEqual({ total: 6, page: 2, limit: 3, totalPages: 2 });
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/admin-invite/admin-invite.service.spec.ts`
Expected: FAIL — `list()` doesn't include `invitedBy` yet.

- [ ] **Step 3: Update `AdminInviteService.list`**

In `src/admin-invite/admin-invite.service.ts`, replace:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.adminInvite.findMany({
        where,
        include: { role: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.adminInvite.count({ where }),
    ]);
```

with:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.adminInvite.findMany({
        where,
        include: { role: true, invitedBy: { select: { id: true, fullName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.adminInvite.count({ where }),
    ]);
```

The `AdminInviteWithRole` type alias (`Prisma.AdminInviteGetPayload<{ include: { role: true } }>`) is used by both `create`/`resend` (unaffected — they don't add `invitedBy`) and the return type of `list`'s `PaginatedResult<AdminInviteWithRole>`. Since `list`'s actual query now includes more than that type declares, widen the return type for `list` specifically. Replace:

```typescript
  async list(
    filters: ListInvitesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<AdminInviteWithRole>> {
```

with:

```typescript
  async list(
    filters: ListInvitesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<AdminInviteWithRole & { invitedBy: { id: string; fullName: string; email: string } }>> {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/admin-invite/admin-invite.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 5: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/admin-invite/admin-invite.service.ts src/admin-invite/admin-invite.service.spec.ts
git commit -m "feat: hydrate invitedBy on the admin invites list endpoint"
```

---

### Task 7: `reviewedByAdmin` hydration on client and agent review

**Files:**
- Modify: `src/admin-client-review/admin-client-review.service.ts`
- Modify: `src/admin-client-review/admin-client-review.service.spec.ts`
- Modify: `src/admin-agent-review/admin-agent-review.service.ts`
- Modify: `src/admin-agent-review/admin-agent-review.service.spec.ts`

**Interfaces:**
- Consumes: `ClientOnboarding.reviewedByAdmin`, `Agent.reviewedByAdmin` (Task 1).

- [ ] **Step 1: Update the existing strict `findById` test in `admin-client-review.service.spec.ts`**

Replace:

```typescript
      expect(prisma.client.findUnique).toHaveBeenCalledWith({
        where: { id: 'c1' },
        include: { onboarding: { include: { documents: true, ippisRecord: true } } },
      });
      expect(result.onboarding.lengthOfService).toEqual({ years: 1, months: 0 });
```

with:

```typescript
      expect(prisma.client.findUnique).toHaveBeenCalledWith({
        where: { id: 'c1' },
        include: {
          onboarding: {
            include: {
              documents: true,
              ippisRecord: true,
              reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
            },
          },
        },
      });
      expect(result.onboarding.lengthOfService).toEqual({ years: 1, months: 0 });
```

Add a new test to the `describe('findById', ...)` block, after the existing ones:

```typescript
    it('surfaces the reviewedByAdmin relation when the onboarding has been reviewed', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'VERIFIED',
        onboarding: { id: 'o1', reviewedByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' } },
      });

      const result = await service.findById('c1');

      expect(result.onboarding.reviewedByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: FAIL — `findById`'s `include` doesn't have `reviewedByAdmin` yet.

- [ ] **Step 3: Update `AdminClientReviewService.findById`**

In `src/admin-client-review/admin-client-review.service.ts`, replace:

```typescript
  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { onboarding: { include: { documents: true, ippisRecord: true } } },
    });
```

with:

```typescript
  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: {
        onboarding: {
          include: {
            documents: true,
            ippisRecord: true,
            reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
          },
        },
      },
    });
```

(`reviewedByAdmin` flows through to the response automatically via the existing `...client.onboarding` spread later in the method — no further code change needed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/admin-client-review/admin-client-review.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 5: Write the failing tests for `AdminAgentReviewService.findById` and `list`**

`findById` currently has zero test coverage — add a new `describe('findById', ...)` block to `src/admin-agent-review/admin-agent-review.service.spec.ts`, placed after the `describe('approve', ...)` block:

```typescript
  describe('findById', () => {
    it('throws NotFoundException for an unknown id', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('includes reviewedByAdmin', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a1',
        status: 'APPROVED',
        reviewedByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' },
      });

      const result = await service.findById('a1');

      expect(prisma.agent.findUnique).toHaveBeenCalledWith({
        where: { id: 'a1' },
        include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
      });
      expect(result.reviewedByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });
  });
```

Add a new test inside the existing `describe('list', ...)` block, after the existing ones:

```typescript
    it('includes reviewedByAdmin on every row', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);

      await service.list();

      expect(prisma.agent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
        }),
      );
    });
```

- [ ] **Step 6: Run the tests to verify the new ones fail**

Run: `npx jest src/admin-agent-review/admin-agent-review.service.spec.ts`
Expected: FAIL — `findById`'s NotFoundException test passes already (unrelated to this change) but the `include`-asserting test and the `list` test fail since neither method sends `include` yet.

- [ ] **Step 7: Update `AdminAgentReviewService`**

In `src/admin-agent-review/admin-agent-review.service.ts`, replace:

```typescript
  async findById(id: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    return agent;
  }
```

with:

```typescript
  async findById(id: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
    });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    return agent;
  }
```

Replace:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.agent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.agent.count({ where }),
    ]);
```

with:

```typescript
    const [data, total] = await Promise.all([
      this.prisma.agent.findMany({
        where,
        include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.agent.count({ where }),
    ]);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx jest src/admin-agent-review/admin-agent-review.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 9: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/admin-client-review/admin-client-review.service.ts src/admin-client-review/admin-client-review.service.spec.ts src/admin-agent-review/admin-agent-review.service.ts src/admin-agent-review/admin-agent-review.service.spec.ts
git commit -m "feat: hydrate reviewedByAdmin on client and agent review responses"
```

---

### Task 8: e2e coverage, Postman, and the full test suite

**Files:**
- Modify: `test/admin-roles.e2e-spec.ts`
- Modify: `test/document-upload.e2e-spec.ts`
- Modify: `test/loan-request.e2e-spec.ts`
- Modify: `test/admin-invite.e2e-spec.ts`
- Modify: `test/audit-log.e2e-spec.ts`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-7.

- [ ] **Step 1: Read each e2e file's existing setup before adding to it**

Read `test/admin-roles.e2e-spec.ts`, `test/document-upload.e2e-spec.ts`, `test/loan-request.e2e-spec.ts`, `test/admin-invite.e2e-spec.ts`, and `test/audit-log.e2e-spec.ts` in full first, to match each file's exact existing variable names, auth-token setup, and request patterns — do not guess.

- [ ] **Step 2: Add a hydration assertion to `test/admin-roles.e2e-spec.ts`**

Find the test that creates a role with a `departmentId` (or, if none exists, the main role-creation test) and add an assertion that the response's `department` field is a hydrated `{ id, name }` object, not a bare `departmentId`. Follow the file's existing pattern for creating a `Department` first via `POST /admin/departments` (or reading one from a fixture, matching how the file already obtains a valid `departmentId` for role tests — read this before writing the assertion, since Sub-project A's e2e coverage for this exact area may already exist to extend rather than duplicate).

- [ ] **Step 3: Add a hydration assertion to `test/document-upload.e2e-spec.ts`**

After a batch is created and its status polled to `COMPLETED` (following the file's existing pattern — e.g. the synthetic-upload-and-poll sequence used earlier this session), assert `GET /admin/documents/batches/:id`'s response has an `uploadedBy` object with `id`/`fullName`/`email`, not a bare `uploadedById`.

- [ ] **Step 4: Add a hydration assertion to `test/loan-request.e2e-spec.ts`**

Find the test exercising `GET /admin/loan-requests` (or `POST /admin/loan-requests/:id/approve`) and assert the response includes a `client` object with `id`/`phone`/`status`.

- [ ] **Step 5: Add a hydration assertion to `test/admin-invite.e2e-spec.ts`**

Find the `'lists invites with the full role object hydrated'` test (or the nearest equivalent) and add an assertion that the same listed invite also has an `invitedBy` object with `id`/`fullName`/`email`.

- [ ] **Step 6: Add a hydration assertion to `test/audit-log.e2e-spec.ts`**

Find a test exercising `GET /admin/audit-logs` for an action with a known actor (e.g. an admin-authenticated action that's already logged elsewhere in the suite) and assert the corresponding row has a non-null `actor` object.

- [ ] **Step 7: Run all five e2e files together**

Run: `npx jest --config ./test/jest-e2e.json test/admin-roles.e2e-spec.ts test/document-upload.e2e-spec.ts test/loan-request.e2e-spec.ts test/admin-invite.e2e-spec.ts test/audit-log.e2e-spec.ts --runInBand`
Expected: PASS — all five files.

- [ ] **Step 8: Update Postman**

Per this repo's `CLAUDE.md`, using surgical `Edit`-tool text edits only, never a full-document rewrite:
- Update saved response examples for: Roles create/list/get/update; `GET /admin/documents/batches(/:id)`; loan-request list/approve/reject/disburse; client-loans list/repayment-plan; `GET /admin/invites`; `GET /admin/audit-logs`; `GET /admin/clients/:clientId/wallet`; admin client-review and agent-review list/detail — to show the newly hydrated fields from Tasks 3-7.
- Check every `pm.test` script on these endpoints for anything reading a field this plan changed the shape of (e.g. a script that reads `departmentId` directly rather than `department.id`).
- No new endpoints were added — only existing saved-response updates.

- [ ] **Step 9: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 10: Commit**

```bash
git add test/admin-roles.e2e-spec.ts test/document-upload.e2e-spec.ts test/loan-request.e2e-spec.ts test/admin-invite.e2e-spec.ts test/audit-log.e2e-spec.ts postman/public-sector-backend.postman_collection.json
git commit -m "test: add e2e coverage for admin-side FK relation hydration, update Postman"
```

- [ ] **Step 11: Run the full test suite**

This plan is its own complete phase — run the true full suite.

Run: `npm run test`
Expected: PASS — every unit suite in the codebase.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run it in isolation to confirm pre-existing environmental flakiness rather than a real regression (this codebase's full e2e run has hit this before, multiple times, always benignly), and report that distinction clearly.

## Exit criteria

- [ ] `Role.departmentId`, `DocumentUploadBatch.uploadedById`, `LoanRequest.clientId`/`topupTargetId`, `ClientLoan.clientId`/`loanRequestId`, and `AdminInvite.invitedById` (list only) are all hydrated at their respective endpoints.
- [ ] `ClientOnboarding.reviewedBy` and `Agent.reviewedBy` are real `AdminUser` relations, hydrated on client-review and agent-review responses.
- [ ] `AuditLog.actorId`/`targetId` and `WalletEntry.actorId` resolve to a curated object via `PrincipalResolverService`, batched (one query per distinct type per response, not per row).
- [ ] `session.service.ts`'s `session.reuse_detected` audit entry records a resolvable `targetType`.
- [ ] Full unit + e2e suite passes clean.
