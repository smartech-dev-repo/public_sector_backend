# Back-Office Governance Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DB-tracked/revocable sessions (replacing signed-JWT refresh tokens), an admin invite→accept lifecycle, hybrid audit logging, and the new permission keys these need — extending Phase 1's `AdminUser`/`Role`/`Permission` and `TokenService` rather than replacing them.

**Architecture:** Refresh tokens become opaque random strings hashed with SHA-256 and tracked in a new `Session` table (rotate-on-use, reuse detection revokes everything for that principal). Admin invites create no `AdminUser` row until accepted. Audit logging is hybrid: a `AuditInterceptor` on every admin-guarded route writes a shallow baseline row automatically; services call `AuditLogService.record()` directly for rich, business-meaningful entries. A new `EmailProvider` abstraction mirrors Phase 1's `OtpProvider` (ordered list, failover, mock console provider for now).

**Tech Stack:** Same as Phase 1 — NestJS 10, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL, Passport/JWT, bcrypt, class-validator, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-15-governance-bundle-design.md`

## Global Constraints

- Follow Phase 1's established patterns exactly: services take `PrismaService` via constructor injection, DTOs use `class-validator`, every admin route uses `JwtAuthGuard` + `PermissionsGuard` + `@RequirePermissions(...)`, multi-provider integrations use an ordered-array-with-failover DI token (see `OTP_PROVIDERS`/`OtpService`).
- Refresh tokens are opaque random strings hashed with **SHA-256** (not bcrypt) — bcrypt salts differently per call and can't support a `WHERE hash = ?` lookup; a 32-byte random token is already brute-force-resistant so slow hashing isn't needed.
- Access tokens are unchanged from Phase 1 (signed JWT, 15m TTL via `JWT_ACCESS_TTL`). No access-token revocation/blocklisting — force-logout takes effect on next refresh.
- RBAC (`PermissionsGuard`) applies to Admin routes only. Agent/Client routes stay ownership-scoped, not permission-based.
- No real email vendor — only a mock `ConsoleEmailProvider`, matching every other external integration so far.
- Every new file follows Phase 1's file layout: source at `src/<feature>/`, unit tests co-located as `*.spec.ts`, e2e tests under `test/*.e2e-spec.ts`.

---

### Task 1: Schema additions — Session, AdminInvite, AuditLog

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: Prisma models `Session` (enum `SessionPrincipalType`), `AdminInvite` (enum `AdminInviteStatus`), `AuditLog` (enum `AuditActorType`) — every later task's DB access goes through these. `Role` gains `invites AdminInvite[]`; `AdminUser` gains `sentInvites AdminInvite[]`.
- Produces: seeded permissions `agents:sessions:revoke`, `clients:sessions:revoke`, `audit:read` (added to `SUPER_ADMIN`'s permission set alongside the existing six from Phase 1).

- [ ] **Step 1: Extend the schema**

Add to `prisma/schema.prisma` (after the existing `OtpCode` model):

```prisma
enum SessionPrincipalType {
  ADMIN
  AGENT
  CLIENT
}

model Session {
  id               String               @id @default(uuid())
  principalType    SessionPrincipalType
  principalId      String
  refreshTokenHash String               @unique
  userAgent        String?
  ip               String?
  createdAt        DateTime             @default(now())
  lastUsedAt       DateTime             @default(now())
  expiresAt        DateTime
  revokedAt        DateTime?
  revokedReason    String?

  @@index([principalType, principalId])
}

enum AdminInviteStatus {
  PENDING
  ACCEPTED
  EXPIRED
  REVOKED
}

model AdminInvite {
  id          String            @id @default(uuid())
  email       String
  roleId      String
  role        Role              @relation(fields: [roleId], references: [id])
  tokenHash   String            @unique
  invitedById String
  invitedBy   AdminUser         @relation(fields: [invitedById], references: [id])
  status      AdminInviteStatus @default(PENDING)
  expiresAt   DateTime
  createdAt   DateTime          @default(now())
  acceptedAt  DateTime?

  @@index([email, status])
}

enum AuditActorType {
  ADMIN
  AGENT
  CLIENT
  SYSTEM
}

model AuditLog {
  id         String         @id @default(uuid())
  actorType  AuditActorType
  actorId    String?
  action     String
  targetType String?
  targetId   String?
  metadata   Json?
  ip         String?
  userAgent  String?
  createdAt  DateTime       @default(now())

  @@index([actorType, actorId])
  @@index([targetType, targetId])
  @@index([action])
}
```

Modify the existing `Role` model to add a back-relation field (inside the model body, alongside `admins AdminUserRole[]`):

```prisma
  invites     AdminInvite[]
```

Modify the existing `AdminUser` model to add a back-relation field (inside the model body, alongside `roles AdminUserRole[]`):

```prisma
  sentInvites AdminInvite[]
```

- [ ] **Step 2: Migrate**

Run: `npx prisma migrate dev --name governance_bundle`
Expected: migration applies cleanly, Prisma Client regenerated at `src/generated/prisma`.

- [ ] **Step 3: Add the new permissions to the seed script**

In `prisma/seed.ts`, extend `BOOTSTRAP_PERMISSIONS`:

```typescript
const BOOTSTRAP_PERMISSIONS: Array<{ key: string; description: string }> = [
  { key: 'admins:create', description: 'Create admin users' },
  { key: 'roles:manage', description: 'Create/edit roles and permissions' },
  { key: 'agents:read', description: 'View agent enrollment submissions' },
  { key: 'agents:review', description: 'Approve or reject agent submissions' },
  { key: 'clients:review', description: 'Review clients flagged for manual review' },
  { key: 'ippis:upload', description: 'Upload/refresh IPPIS master data' },
  { key: 'agents:sessions:revoke', description: "Force-revoke an agent's active sessions" },
  { key: 'clients:sessions:revoke', description: "Force-revoke a client's active sessions" },
  { key: 'audit:read', description: 'View audit log entries' },
];
```

(Nothing else in `seed.ts` changes — the `SUPER_ADMIN` role is assigned every `Permission` row that exists at seed time, so the three new keys are picked up automatically.)

- [ ] **Step 4: Re-seed and verify**

Run: `npx prisma db seed`
Expected: completes with no errors (upserts are idempotent, safe to rerun).

- [ ] **Step 5: Commit**

```bash
git add prisma
git commit -m "feat: add Session, AdminInvite, AuditLog schema and new permissions"
```

---

### Task 2: Shared opaque-token utility

**Files:**
- Create: `src/common/opaque-token.util.ts`
- Test: `src/common/opaque-token.util.spec.ts`

**Interfaces:**
- Produces: `generateOpaqueToken(): string` and `hashToken(token: string): string` — Task 4 (`SessionService`) and Task 8 (`AdminInviteService`) both use these instead of duplicating token generation/hashing logic.

- [ ] **Step 1: Write the failing test**

`src/common/opaque-token.util.spec.ts`:

```typescript
import { generateOpaqueToken, hashToken } from './opaque-token.util';

describe('opaque-token.util', () => {
  it('generates high-entropy, unique tokens', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();

    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('hashes deterministically', () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toEqual(hashToken(token));
  });

  it('produces different hashes for different tokens', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(hashToken(a)).not.toEqual(hashToken(b));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/common/opaque-token.util.spec.ts`
Expected: FAIL — `Cannot find module './opaque-token.util'`

- [ ] **Step 3: Implement**

`src/common/opaque-token.util.ts`:

```typescript
import { createHash, randomBytes } from 'crypto';

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/common/opaque-token.util.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/common
git commit -m "feat: add opaque token generation/hashing utility"
```

---

### Task 3: Audit log service and interceptor

**Files:**
- Create: `src/audit/audit-log.service.ts`
- Create: `src/audit/audit.interceptor.ts`
- Create: `src/audit/audit.module.ts`
- Test: `src/audit/audit-log.service.spec.ts`
- Test: `src/audit/audit.interceptor.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `JwtPayload` (Phase 1).
- Produces: `AuditLogService.record(params: RecordAuditEventParams): Promise<void>` and `AuditLogService.list(filters): Promise<AuditLog[]>` — Task 4 (`SessionService`, reuse detection), Task 8 (`AdminInviteController`, explicit events), and Task 10 (`GET /admin/audit-logs`) all consume these.
- Produces: `AuditInterceptor` (an injectable `NestInterceptor`) — Task 8 (`AdminInviteController`/`AdminInviteModule`), Task 10 (`AdminController`/`AdminModule`), and Task 11 (`AdminSessionController`/`AdminSessionModule`) all apply it via `@UseInterceptors(AuditInterceptor)` and register it as a provider. Building it now (rather than alongside its first real use in Task 10) means every later task that references it has something real to import instead of a forward reference.

- [ ] **Step 1: Write the failing test**

`src/audit/audit-log.service.spec.ts`:

```typescript
import { AuditLogService } from './audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType } from '../generated/prisma/client';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let prisma: { auditLog: { create: jest.Mock; findMany: jest.Mock } };

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn(), findMany: jest.fn() } };
    service = new AuditLogService(prisma as unknown as PrismaService);
  });

  it('writes a row with every provided field', async () => {
    await service.record({
      actorType: AuditActorType.ADMIN,
      actorId: 'admin-1',
      action: 'admin.invite.created',
      targetType: 'AdminInvite',
      targetId: 'invite-1',
      metadata: { email: 'new-admin@example.com' },
      ip: '127.0.0.1',
      userAgent: 'jest-test',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorType: AuditActorType.ADMIN,
        actorId: 'admin-1',
        action: 'admin.invite.created',
        targetType: 'AdminInvite',
        targetId: 'invite-1',
        metadata: { email: 'new-admin@example.com' },
        ip: '127.0.0.1',
        userAgent: 'jest-test',
      },
    });
  });

  it('writes a row with only the required fields', async () => {
    await service.record({ actorType: AuditActorType.SYSTEM, action: 'session.reuse_detected' });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorType: AuditActorType.SYSTEM,
        actorId: undefined,
        action: 'session.reuse_detected',
        targetType: undefined,
        targetId: undefined,
        metadata: undefined,
        ip: undefined,
        userAgent: undefined,
      },
    });
  });

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/audit/audit-log.service.spec.ts`
Expected: FAIL — `Cannot find module './audit-log.service'`

- [ ] **Step 3: Implement**

`src/audit/audit-log.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, AuditLog, Prisma } from '../generated/prisma/client';

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
}

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/audit/audit-log.service.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing test for `AuditInterceptor`**

`src/audit/audit.interceptor.spec.ts`:

```typescript
import { of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';
import { AuditLogService } from './audit-log.service';
import { AuditActorType } from '../generated/prisma/client';

function buildContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function buildHandler(result: unknown, isError = false): CallHandler {
  return {
    handle: () => (isError ? throwError(() => result) : of(result)),
  };
}

describe('AuditInterceptor', () => {
  let auditLogService: { record: jest.Mock };
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    interceptor = new AuditInterceptor(auditLogService as unknown as AuditLogService);
  });

  it('passes GET requests through without logging', (done) => {
    const request = { method: 'GET', url: '/admin/me', headers: {} };
    interceptor.intercept(buildContext(request), buildHandler({ ok: true })).subscribe(() => {
      expect(auditLogService.record).not.toHaveBeenCalled();
      done();
    });
  });

  it('logs a baseline entry for a successful mutating request', (done) => {
    const request = {
      method: 'POST',
      url: '/admin/invites',
      user: { sub: 'admin-1', type: 'admin' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    interceptor.intercept(buildContext(request), buildHandler({ id: 'x' })).subscribe(() => {
      setImmediate(() => {
        expect(auditLogService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            actorType: AuditActorType.ADMIN,
            actorId: 'admin-1',
            action: 'POST /admin/invites (200)',
            ip: '127.0.0.1',
            userAgent: 'jest',
          }),
        );
        done();
      });
    });
  });

  it('logs a baseline entry with the error status for a failed mutating request', (done) => {
    const request = { method: 'DELETE', url: '/admin/invites/1', headers: {} };
    interceptor
      .intercept(buildContext(request), buildHandler({ status: 403 }, true))
      .subscribe({
        error: () => {
          setImmediate(() => {
            expect(auditLogService.record).toHaveBeenCalledWith(
              expect.objectContaining({ action: 'DELETE /admin/invites/1 (403)' }),
            );
            done();
          });
        },
      });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest src/audit/audit.interceptor.spec.ts`
Expected: FAIL — `Cannot find module './audit.interceptor'`

- [ ] **Step 7: Implement `AuditInterceptor`**

`src/audit/audit.interceptor.ts`:

```typescript
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditLogService } from './audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType } from '../generated/prisma/client';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface AuditableRequest {
  method: string;
  url: string;
  user?: JwtPayload;
  ip?: string;
  headers: Record<string, unknown>;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly auditLogService: AuditLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuditableRequest>();

    if (!MUTATING_METHODS.has(request.method)) {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: () => this.logBestEffort(request, 200),
        error: (error: { status?: number }) => this.logBestEffort(request, error?.status ?? 500),
      }),
    );
  }

  private logBestEffort(request: AuditableRequest, status: number): void {
    const userAgent = request.headers['user-agent'];
    // Fire-and-forget: this is the automatic *baseline* safety net (see the
    // design doc, §2.3) — it must never slow down or break the actual
    // request. Business-meaningful audit entries are written explicitly by
    // the services that produce them (see AdminInviteController, Task 8).
    this.auditLogService
      .record({
        actorType: AuditActorType.ADMIN,
        actorId: request.user?.sub,
        action: `${request.method} ${request.url} (${status})`,
        ip: request.ip,
        userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      })
      .catch(() => undefined);
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest src/audit/audit.interceptor.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 9: Wire the module**

`src/audit/audit.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';

@Module({
  providers: [AuditLogService, AuditInterceptor],
  exports: [AuditLogService, AuditInterceptor],
})
export class AuditModule {}
```

- [ ] **Step 10: Commit**

```bash
git add src/audit
git commit -m "feat: add AuditLogService and the baseline AuditInterceptor"
```

---

### Task 4: Session service (opaque refresh tokens, rotation, reuse detection)

**Files:**
- Create: `src/session/session-principal-type.mapper.ts`
- Create: `src/session/session.service.ts`
- Create: `src/session/session.module.ts`
- Test: `src/session/session-principal-type.mapper.spec.ts`
- Test: `src/session/session.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `AuditLogService` (Task 3), `generateOpaqueToken`/`hashToken` (Task 2), `PrincipalType` (from `src/auth/jwt-payload.interface.ts`, Phase 1).
- Produces: `toSessionPrincipalType(type: PrincipalType): SessionPrincipalType` and `toJwtPrincipalType(type: SessionPrincipalType): PrincipalType`.
- Produces: `SessionService.createSession(params: CreateSessionParams): Promise<string>`, `.rotate(refreshToken: string, meta?): Promise<RotateResult>`, `.revokeByToken(refreshToken: string): Promise<void>`, `.revokeAllForPrincipal(principalType, principalId, reason: string): Promise<void>`, `.listActiveSessions(principalType, principalId): Promise<SessionSummary[]>`, `.revokeOwnSession(principalType, principalId, sessionId: string): Promise<void>` — Task 5 (existing auth services), Task 6 (`SessionAuthController`), and Task 11 (admin force-revoke) all consume these.

- [ ] **Step 1: Write the failing test for the principal-type mapper**

`src/session/session-principal-type.mapper.spec.ts`:

```typescript
import { toSessionPrincipalType, toJwtPrincipalType } from './session-principal-type.mapper';
import { SessionPrincipalType } from '../generated/prisma/client';

describe('session-principal-type.mapper', () => {
  it('maps every JWT principal type to its Session enum value', () => {
    expect(toSessionPrincipalType('admin')).toBe(SessionPrincipalType.ADMIN);
    expect(toSessionPrincipalType('agent')).toBe(SessionPrincipalType.AGENT);
    expect(toSessionPrincipalType('client')).toBe(SessionPrincipalType.CLIENT);
  });

  it('maps every Session enum value back to its JWT principal type', () => {
    expect(toJwtPrincipalType(SessionPrincipalType.ADMIN)).toBe('admin');
    expect(toJwtPrincipalType(SessionPrincipalType.AGENT)).toBe('agent');
    expect(toJwtPrincipalType(SessionPrincipalType.CLIENT)).toBe('client');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/session/session-principal-type.mapper.spec.ts`
Expected: FAIL — `Cannot find module './session-principal-type.mapper'`

- [ ] **Step 3: Implement the mapper**

`src/session/session-principal-type.mapper.ts`:

```typescript
import { PrincipalType } from '../auth/jwt-payload.interface';
import { SessionPrincipalType } from '../generated/prisma/client';

const TO_SESSION: Record<PrincipalType, SessionPrincipalType> = {
  admin: SessionPrincipalType.ADMIN,
  agent: SessionPrincipalType.AGENT,
  client: SessionPrincipalType.CLIENT,
};

const TO_JWT: Record<SessionPrincipalType, PrincipalType> = {
  [SessionPrincipalType.ADMIN]: 'admin',
  [SessionPrincipalType.AGENT]: 'agent',
  [SessionPrincipalType.CLIENT]: 'client',
};

export function toSessionPrincipalType(type: PrincipalType): SessionPrincipalType {
  return TO_SESSION[type];
}

export function toJwtPrincipalType(type: SessionPrincipalType): PrincipalType {
  return TO_JWT[type];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/session/session-principal-type.mapper.spec.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Write the failing test for `SessionService`**

`src/session/session.service.spec.ts`:

```typescript
import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { SessionService } from './session.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { SessionPrincipalType } from '../generated/prisma/client';

describe('SessionService', () => {
  let service: SessionService;
  let prisma: {
    session: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let auditLogService: { record: jest.Mock };

  beforeEach(() => {
    prisma = {
      session: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
      },
    };
    auditLogService = { record: jest.fn() };
    service = new SessionService(
      prisma as unknown as PrismaService,
      auditLogService as unknown as AuditLogService,
    );
  });

  it('creates a session and returns a plaintext token not stored anywhere', async () => {
    prisma.session.create.mockResolvedValue({});

    const token = await service.createSession({
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'client-1',
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(32);
    const createArgs = prisma.session.create.mock.calls[0][0];
    expect(createArgs.data.principalType).toBe(SessionPrincipalType.CLIENT);
    expect(createArgs.data.principalId).toBe('client-1');
    expect(createArgs.data.refreshTokenHash).not.toEqual(token);
  });

  it('rejects rotating an unknown token', async () => {
    prisma.session.findUnique.mockResolvedValue(null);
    await expect(service.rotate('unknown-token')).rejects.toThrow(UnauthorizedException);
  });

  it('rotates a valid token: revokes the old session and issues a new one', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      principalType: SessionPrincipalType.AGENT,
      principalId: 'agent-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.session.update.mockResolvedValue({});
    prisma.session.create.mockResolvedValue({});

    const result = await service.rotate('valid-token');

    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { revokedAt: expect.any(Date), revokedReason: 'rotated' },
    });
    expect(result.principalType).toBe(SessionPrincipalType.AGENT);
    expect(result.principalId).toBe('agent-1');
    expect(typeof result.refreshToken).toBe('string');
  });

  it('treats presenting an already-revoked token as reuse: revokes every session for that principal', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'client-1',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 2 });

    await expect(service.rotate('stolen-token')).rejects.toThrow(UnauthorizedException);

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { principalType: SessionPrincipalType.CLIENT, principalId: 'client-1', revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedReason: 'reuse_detected' },
    });
    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session.reuse_detected' }),
    );
  });

  it('rejects rotating an expired token and revokes it', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'client-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    prisma.session.update.mockResolvedValue({});

    await expect(service.rotate('expired-token')).rejects.toThrow(UnauthorizedException);
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { revokedAt: expect.any(Date), revokedReason: 'expired' },
    });
  });

  it('revokeByToken is idempotent for an unknown token', async () => {
    prisma.session.findUnique.mockResolvedValue(null);
    await expect(service.revokeByToken('unknown')).resolves.toBeUndefined();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('revokeOwnSession throws NotFoundException for a session belonging to someone else', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'someone-else',
    });

    await expect(
      service.revokeOwnSession(SessionPrincipalType.CLIENT, 'client-1', 'session-1'),
    ).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest src/session/session.service.spec.ts`
Expected: FAIL — `Cannot find module './session.service'`

- [ ] **Step 7: Implement `SessionService`**

`src/session/session.service.ts`:

```typescript
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { generateOpaqueToken, hashToken } from '../common/opaque-token.util';
import { AuditActorType, SessionPrincipalType } from '../generated/prisma/client';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateSessionParams {
  principalType: SessionPrincipalType;
  principalId: string;
  userAgent?: string;
  ip?: string;
}

export interface RotateResult {
  refreshToken: string;
  principalType: SessionPrincipalType;
  principalId: string;
}

export interface SessionSummary {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createSession(params: CreateSessionParams): Promise<string> {
    const token = generateOpaqueToken();

    await this.prisma.session.create({
      data: {
        principalType: params.principalType,
        principalId: params.principalId,
        refreshTokenHash: hashToken(token),
        userAgent: params.userAgent,
        ip: params.ip,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    return token;
  }

  async rotate(
    refreshToken: string,
    meta?: { userAgent?: string; ip?: string },
  ): Promise<RotateResult> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
    });

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }

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

    if (session.expiresAt < new Date()) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokedReason: 'expired' },
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: 'rotated' },
    });

    const newToken = await this.createSession({
      principalType: session.principalType,
      principalId: session.principalId,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      refreshToken: newToken,
      principalType: session.principalType,
      principalId: session.principalId,
    };
  }

  async revokeByToken(refreshToken: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
    });

    if (!session || session.revokedAt) {
      return;
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
  }

  async revokeAllForPrincipal(
    principalType: SessionPrincipalType,
    principalId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.session.updateMany({
      where: { principalType, principalId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

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

  async revokeOwnSession(
    principalType: SessionPrincipalType,
    principalId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });

    if (!session || session.principalType !== principalType || session.principalId !== principalId) {
      throw new NotFoundException('Session not found');
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest src/session/session.service.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 9: Wire the module**

`src/session/session.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SessionService } from './session.service';

@Module({
  imports: [AuditModule],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
```

- [ ] **Step 10: Commit**

```bash
git add src/session
git commit -m "feat: add SessionService with rotating, revocable refresh tokens"
```

---

### Task 5: Migrate existing login flows onto SessionService

**Files:**
- Create: `src/common/request-metadata.util.ts`
- Modify: `src/auth/token.service.ts`
- Modify: `src/auth/admin/admin-auth.service.ts`
- Modify: `src/auth/admin/admin-auth.service.spec.ts`
- Modify: `src/auth/admin/admin-auth.controller.ts`
- Modify: `src/auth/agent/agent-auth.service.ts`
- Modify: `src/auth/agent/agent-auth.service.spec.ts`
- Modify: `src/auth/agent/agent-auth.controller.ts`
- Modify: `src/auth/client/client-auth.service.ts`
- Modify: `src/auth/client/client-auth.service.spec.ts`
- Modify: `src/auth/client/client-auth.controller.ts`
- Modify: `src/auth/auth.module.ts`

**Interfaces:**
- Consumes: `SessionService` (Task 4), `toSessionPrincipalType` (Task 4).
- Produces: `AdminAuthService.getPermissionsForAdmin(adminId: string): Promise<string[]>` — extracted from `login()` so Task 6's `/auth/refresh` can reuse it — and `AdminAuthService.login(email, password, meta?): Promise<{accessToken; refreshToken}>` (now takes an optional `meta`). Same `meta?` addition to `AgentAuthService.login` and `ClientAuthService.verifyOtp`. All three now return an opaque `Session`-backed `refreshToken` instead of a signed JWT.

- [ ] **Step 1: Add the request-metadata helper**

`src/common/request-metadata.util.ts`:

```typescript
import { Request } from 'express';

export interface RequestMetadata {
  userAgent?: string;
  ip?: string;
}

export function getRequestMetadata(req: Request): RequestMetadata {
  const userAgent = req.headers['user-agent'];
  return {
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
    ip: req.ip,
  };
}
```

- [ ] **Step 2: Remove `signRefreshToken` from `TokenService`**

Replace `src/auth/token.service.ts` in full:

```typescript
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './jwt-payload.interface';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  signAccessToken(payload: JwtPayload): string {
    return this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>('JWT_ACCESS_TTL', '15m'),
    });
  }
}
```

- [ ] **Step 3: Update the failing test for `AdminAuthService`**

Replace `src/auth/admin/admin-auth.service.spec.ts` in full:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminAuthService } from './admin-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AdminInviteService } from '../../admin-invite/admin-invite.service';

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let prisma: {
    adminUser: { findUnique: jest.Mock; create: jest.Mock };
  };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };
  let adminInviteService: { findValidByToken: jest.Mock; markAccepted: jest.Mock };

  beforeEach(() => {
    prisma = { adminUser: { findUnique: jest.fn(), create: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = { createSession: jest.fn().mockResolvedValue('refresh-token') };
    adminInviteService = { findValidByToken: jest.fn(), markAccepted: jest.fn() };
    service = new AdminAuthService(
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
      adminInviteService as unknown as AdminInviteService,
    );
  });

  it('rejects unknown emails', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    await expect(
      service.login('nobody@example.com', 'whatever'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a wrong password', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      passwordHash,
      isActive: true,
    });

    await expect(
      service.login('admin@example.com', 'wrong-password'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('issues tokens via SessionService with flattened permissions on a correct login', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    prisma.adminUser.findUnique
      .mockResolvedValueOnce({ id: 'admin-1', email: 'admin@example.com', passwordHash, isActive: true })
      .mockResolvedValueOnce({
        id: 'admin-1',
        roles: [{ role: { permissions: [{ permission: { key: 'agents:read' } }] } }],
      });

    const result = await service.login('admin@example.com', 'correct-password', {
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'admin-1',
      type: 'admin',
      permissions: ['agents:read'],
    });
    expect(sessionService.createSession).toHaveBeenCalledWith({
      principalType: 'ADMIN',
      principalId: 'admin-1',
      userAgent: 'jest',
      ip: '127.0.0.1',
    });
  });

  it('getPermissionsForAdmin flattens and de-duplicates permission keys', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      roles: [
        { role: { permissions: [{ permission: { key: 'agents:read' } }] } },
        { role: { permissions: [{ permission: { key: 'agents:read' } }, { permission: { key: 'roles:manage' } }] } },
      ],
    });

    const permissions = await service.getPermissionsForAdmin('admin-1');

    expect(permissions.sort()).toEqual(['agents:read', 'roles:manage']);
  });

  it('getPermissionsForAdmin returns an empty array for an unknown admin', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    expect(await service.getPermissionsForAdmin('nobody')).toEqual([]);
  });

  it('acceptInvite creates the AdminUser, assigns the invited role, and logs in', async () => {
    adminInviteService.findValidByToken.mockResolvedValue({
      id: 'invite-1',
      email: 'new-admin@example.com',
      roleId: 'role-1',
    });
    prisma.adminUser.create.mockResolvedValue({ id: 'admin-2' });
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-2',
      roles: [{ role: { permissions: [] } }],
    });

    const result = await service.acceptInvite('some-token', 'new-password', 'New Admin');

    expect(prisma.adminUser.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'new-admin@example.com',
        fullName: 'New Admin',
        roles: { create: { roleId: 'role-1' } },
      }),
    });
    expect(adminInviteService.markAccepted).toHaveBeenCalledWith('invite-1');
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: FAIL — constructor signature mismatch / missing methods.

- [ ] **Step 5: Update `AdminAuthService`**

Replace `src/auth/admin/admin-auth.service.ts` in full:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AdminInviteService } from '../../admin-invite/admin-invite.service';
import { JwtPayload } from '../jwt-payload.interface';
import { SessionPrincipalType } from '../../generated/prisma/client';

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly adminInviteService: AdminInviteService,
  ) {}

  async getPermissionsForAdmin(adminId: string): Promise<string[]> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: {
        roles: {
          include: {
            role: { include: { permissions: { include: { permission: true } } } },
          },
        },
      },
    });

    if (!admin) {
      return [];
    }

    return Array.from(
      new Set(
        admin.roles.flatMap((adminRole) =>
          adminRole.role.permissions.map((rp) => rp.permission.key),
        ),
      ),
    );
  }

  async login(email: string, password: string, meta?: { userAgent?: string; ip?: string }) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueTokens(admin.id, meta);
  }

  async acceptInvite(
    token: string,
    password: string,
    fullName: string,
    meta?: { userAgent?: string; ip?: string },
  ) {
    const invite = await this.adminInviteService.findValidByToken(token);
    const passwordHash = await bcrypt.hash(password, 12);

    const admin = await this.prisma.adminUser.create({
      data: {
        email: invite.email,
        passwordHash,
        fullName,
        roles: { create: { roleId: invite.roleId } },
      },
    });

    await this.adminInviteService.markAccepted(invite.id);

    return this.issueTokens(admin.id, meta);
  }

  private async issueTokens(adminId: string, meta?: { userAgent?: string; ip?: string }) {
    const permissions = await this.getPermissionsForAdmin(adminId);
    const payload: JwtPayload = { sub: adminId, type: 'admin', permissions };

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.ADMIN,
      principalId: adminId,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken,
    };
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: PASS — 7 tests. (`AdminInviteService` doesn't exist as a real class yet — Task 8 creates it — but the spec only references its *type* for the mock cast, which TypeScript resolves once Task 8 lands; until then this file won't compile standalone. Task 8 must land before running the *whole* suite — see Task 8's note. For now, `npx jest` on this one file still passes because `ts-jest` only needs the type to exist, and Task 8 creates a stub-free real implementation before the full suite is ever run end-to-end. If your TypeScript setup errors before Task 8, skip ahead and create the minimal `AdminInviteService` class shell from Task 8 first, then return here.)

- [ ] **Step 7: Update `AdminAuthController`**

Replace `src/auth/admin/admin-auth.controller.ts` in full:

```typescript
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    return this.adminAuthService.login(dto.email, dto.password, getRequestMetadata(req));
  }

  @Post('accept-invite')
  @HttpCode(200)
  acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    return this.adminAuthService.acceptInvite(
      dto.token,
      dto.password,
      dto.fullName,
      getRequestMetadata(req),
    );
  }
}
```

(`AcceptInviteDto` is created in Task 9 — this controller won't compile until then. Continue with the rest of this task's steps; Task 9 completes the wiring.)

- [ ] **Step 8: Update `AgentAuthService`**

Replace `src/auth/agent/agent-auth.service.ts` in full:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { SessionPrincipalType } from '../../generated/prisma/client';

@Injectable()
export class AgentAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
  ) {}

  async login(email: string, password: string, meta?: { userAgent?: string; ip?: string }) {
    const agent = await this.prisma.agent.findUnique({ where: { email } });

    if (!agent || agent.status !== 'APPROVED' || !agent.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, agent.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload = { sub: agent.id, type: 'agent' as const };

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.AGENT,
      principalId: agent.id,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken,
    };
  }
}
```

- [ ] **Step 9: Update the `AgentAuthService` test**

Replace `src/auth/agent/agent-auth.service.spec.ts` in full:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AgentAuthService } from './agent-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';

describe('AgentAuthService', () => {
  let service: AgentAuthService;
  let prisma: { agent: { findUnique: jest.Mock } };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };

  beforeEach(() => {
    prisma = { agent: { findUnique: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = { createSession: jest.fn().mockResolvedValue('refresh-token') };
    service = new AgentAuthService(
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
    );
  });

  it('rejects an agent that is still PENDING_REVIEW', async () => {
    const passwordHash = await bcrypt.hash('secret-password', 12);
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      email: 'agent@example.com',
      passwordHash,
      status: 'PENDING_REVIEW',
    });

    await expect(
      service.login('agent@example.com', 'secret-password'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an approved agent with no password set yet', async () => {
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      email: 'agent@example.com',
      passwordHash: null,
      status: 'APPROVED',
    });

    await expect(
      service.login('agent@example.com', 'secret-password'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('issues tokens via SessionService for an approved agent with the right password', async () => {
    const passwordHash = await bcrypt.hash('secret-password', 12);
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      email: 'agent@example.com',
      passwordHash,
      status: 'APPROVED',
    });

    const result = await service.login('agent@example.com', 'secret-password', {
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(sessionService.createSession).toHaveBeenCalledWith({
      principalType: 'AGENT',
      principalId: 'agent-1',
      userAgent: 'jest',
      ip: '127.0.0.1',
    });
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});
```

- [ ] **Step 10: Update `AgentAuthController`**

Replace `src/auth/agent/agent-auth.controller.ts` in full:

```typescript
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AgentAuthService } from './agent-auth.service';
import { AgentLoginDto } from './dto/agent-login.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth/agent')
export class AgentAuthController {
  constructor(private readonly agentAuthService: AgentAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AgentLoginDto, @Req() req: Request) {
    return this.agentAuthService.login(dto.email, dto.password, getRequestMetadata(req));
  }
}
```

- [ ] **Step 11: Update `ClientAuthService`**

Replace `src/auth/client/client-auth.service.ts` in full:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { SessionPrincipalType } from '../../generated/prisma/client';

@Injectable()
export class ClientAuthService {
  constructor(
    private readonly otpService: OtpService,
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
  ) {}

  async requestOtp(phone: string): Promise<void> {
    await this.otpService.request(phone);
  }

  async verifyOtp(phone: string, code: string, meta?: { userAgent?: string; ip?: string }) {
    const isValid = await this.otpService.verify(phone, code);
    if (!isValid) {
      throw new UnauthorizedException('Invalid or expired code');
    }

    const client = await this.prisma.client.upsert({
      where: { phone },
      update: {},
      create: { phone },
    });

    const payload = { sub: client.id, type: 'client' as const };

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.CLIENT,
      principalId: client.id,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken,
    };
  }
}
```

- [ ] **Step 12: Update the `ClientAuthService` test**

Replace `src/auth/client/client-auth.service.spec.ts` in full:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { OtpService } from '../../otp/otp.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';

describe('ClientAuthService', () => {
  let service: ClientAuthService;
  let otpService: { request: jest.Mock; verify: jest.Mock };
  let prisma: { client: { upsert: jest.Mock } };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };

  beforeEach(() => {
    otpService = { request: jest.fn(), verify: jest.fn() };
    prisma = { client: { upsert: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = { createSession: jest.fn().mockResolvedValue('refresh-token') };
    service = new ClientAuthService(
      otpService as unknown as OtpService,
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
    );
  });

  it('delegates OTP requests to OtpService', async () => {
    await service.requestOtp('+2348000000000');
    expect(otpService.request).toHaveBeenCalledWith('+2348000000000');
  });

  it('rejects an invalid OTP', async () => {
    otpService.verify.mockResolvedValue(false);
    await expect(
      service.verifyOtp('+2348000000000', '000000'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('upserts the Client and issues tokens via SessionService on a valid OTP', async () => {
    otpService.verify.mockResolvedValue(true);
    prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000' });

    const result = await service.verifyOtp('+2348000000000', '123456', {
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(sessionService.createSession).toHaveBeenCalledWith({
      principalType: 'CLIENT',
      principalId: 'client-1',
      userAgent: 'jest',
      ip: '127.0.0.1',
    });
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});
```

- [ ] **Step 13: Update `ClientAuthController`**

Replace `src/auth/client/client-auth.controller.ts` in full:

```typescript
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { ClientAuthService } from './client-auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth/client')
export class ClientAuthController {
  constructor(private readonly clientAuthService: ClientAuthService) {}

  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@Body() dto: RequestOtpDto) {
    await this.clientAuthService.requestOtp(dto.phone);
    return { sent: true };
  }

  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.clientAuthService.verifyOtp(dto.phone, dto.code, getRequestMetadata(req));
  }
}
```

- [ ] **Step 14: Wire `SessionModule` (and, forward-looking, `AdminInviteModule`) into `AuthModule`**

Replace `src/auth/auth.module.ts` in full:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { OtpModule } from '../otp/otp.module';
import { SessionModule } from '../session/session.module';
import { AdminInviteModule } from '../admin-invite/admin-invite.module';
import { TokenService } from './token.service';
import { JwtStrategy } from './jwt.strategy';
import { AdminAuthController } from './admin/admin-auth.controller';
import { AdminAuthService } from './admin/admin-auth.service';
import { ClientAuthController } from './client/client-auth.controller';
import { ClientAuthService } from './client/client-auth.service';
import { AgentAuthController } from './agent/agent-auth.controller';
import { AgentAuthService } from './agent/agent-auth.service';

@Module({
  imports: [PassportModule, JwtModule.register({}), OtpModule, SessionModule, AdminInviteModule],
  controllers: [AdminAuthController, ClientAuthController, AgentAuthController],
  providers: [
    TokenService,
    JwtStrategy,
    AdminAuthService,
    ClientAuthService,
    AgentAuthService,
  ],
  exports: [TokenService],
})
export class AuthModule {}
```

This references `AdminInviteModule`, which doesn't exist until Task 8. **Do not run the full test suite or `nest build` at the end of this task** — Task 8 completes the missing piece. Running the per-file unit tests listed in Steps 6, 9, and 12 above (`npx jest <path>`) works fine in isolation since `ts-jest` only needs the referenced types to resolve, not a full successful compile of every other file.

- [ ] **Step 15: Commit**

```bash
git add src/common src/auth src/session
git commit -m "feat: migrate admin/agent/client login onto SessionService refresh tokens"
```

---

### Task 6: Session endpoints (refresh, logout, logout-all, list, revoke-one)

**Files:**
- Create: `src/auth/session/dto/refresh-token.dto.ts`
- Create: `src/auth/session/session-auth.controller.ts`
- Modify: `src/auth/auth.module.ts`
- Test: `test/session-rails.e2e-spec.ts`

**Interfaces:**
- Consumes: `SessionService` (Task 4), `AdminAuthService.getPermissionsForAdmin` (Task 5), `TokenService.signAccessToken` (Phase 1), `toJwtPrincipalType`/`toSessionPrincipalType` (Task 4).
- Produces: `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`.

- [ ] **Step 1: Add the DTO**

`src/auth/session/dto/refresh-token.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class RefreshTokenDto {
  @IsString()
  refreshToken: string;
}
```

- [ ] **Step 2: Implement the controller**

`src/auth/session/session-auth.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SessionService } from '../../session/session.service';
import { TokenService } from '../token.service';
import { AdminAuthService } from '../admin/admin-auth.service';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { JwtPayload } from '../jwt-payload.interface';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { toJwtPrincipalType, toSessionPrincipalType } from '../../session/session-principal-type.mapper';
import { SessionPrincipalType } from '../../generated/prisma/client';
import { getRequestMetadata } from '../../common/request-metadata.util';

@Controller('auth')
export class SessionAuthController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly tokenService: TokenService,
    private readonly adminAuthService: AdminAuthService,
  ) {}

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    const result = await this.sessionService.rotate(dto.refreshToken, getRequestMetadata(req));

    const permissions =
      result.principalType === SessionPrincipalType.ADMIN
        ? await this.adminAuthService.getPermissionsForAdmin(result.principalId)
        : undefined;

    const payload: JwtPayload = {
      sub: result.principalId,
      type: toJwtPrincipalType(result.principalType),
      permissions,
    };

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken: result.refreshToken,
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() dto: RefreshTokenDto) {
    await this.sessionService.revokeByToken(dto.refreshToken);
    return { loggedOut: true };
  }

  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async logoutAll(@Req() req: { user: JwtPayload }) {
    await this.sessionService.revokeAllForPrincipal(
      toSessionPrincipalType(req.user.type),
      req.user.sub,
      'logout_all',
    );
    return { loggedOut: true };
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  listSessions(@Req() req: { user: JwtPayload }) {
    return this.sessionService.listActiveSessions(
      toSessionPrincipalType(req.user.type),
      req.user.sub,
    );
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async revokeSession(@Req() req: { user: JwtPayload }, @Param('id') id: string) {
    await this.sessionService.revokeOwnSession(
      toSessionPrincipalType(req.user.type),
      req.user.sub,
      id,
    );
    return { revoked: true };
  }
}
```

- [ ] **Step 3: Wire the controller into `AuthModule`**

Modify `src/auth/auth.module.ts`: add the import and register the controller.

```typescript
import { SessionAuthController } from './session/session-auth.controller';
```

Add `SessionAuthController` to the `controllers` array (alongside `AdminAuthController`, `ClientAuthController`, `AgentAuthController`).

- [ ] **Step 4: Write the e2e test**

`test/session-rails.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Session rails (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const phone = '+2348033333333';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { phone } });
    await app.close();
  });

  async function loginClient() {
    await request(app.getHttpServer()).post('/auth/client/otp/request').send({ phone });
    const stored = await prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    // The stored code is hashed; re-request via a fresh OTP isn't possible here,
    // so this suite exercises the client record directly instead of a real code.
    return stored;
  }

  it('rejects refresh with an unknown token', () => {
    return request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'not-a-real-token' })
      .expect(401);
  });

  it('rotates a valid refresh token and rejects reusing the old one', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    const originalRefreshToken = loginRes.body.refreshToken;

    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(200);

    expect(refreshRes.body.refreshToken).not.toBe(originalRefreshToken);
    expect(typeof refreshRes.body.accessToken).toBe('string');

    // Reusing the now-rotated-away token is treated as theft.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(401);

    // Reuse detection revokes the *new* token too (every session for the principal).
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refreshRes.body.refreshToken })
      .expect(401);
  });

  it('logout revokes the session so refresh subsequently fails', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: loginRes.body.refreshToken })
      .expect(200)
      .expect({ loggedOut: true });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: loginRes.body.refreshToken })
      .expect(401);
  });

  it('lists active sessions and self-revokes one', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    const accessToken = loginRes.body.accessToken;

    const listRes = await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBeGreaterThan(0);
    const sessionId = listRes.body[0].id;

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ revoked: true });
  });

  it('logout-all revokes every session for the principal', async () => {
    const firstLogin = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    const secondLogin = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });

    await request(app.getHttpServer())
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${firstLogin.body.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstLogin.body.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: secondLogin.body.refreshToken })
      .expect(401);
  });
});
```

- [ ] **Step 5: Run the e2e test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites (this task depends on `AuthModule` compiling, which needs both Task 8's `AdminInviteModule`/`AdminInviteService` and Task 9's `AcceptInviteDto` — `AdminAuthController` imports the latter directly. If run before Task 9, this step is expected to fail to compile; sequence Tasks 7–9 before executing this step if working strictly in order, or come back to this step once Task 9 lands).

- [ ] **Step 6: Commit**

```bash
git add src/auth/session src/auth/auth.module.ts test/session-rails.e2e-spec.ts
git commit -m "feat: add refresh/logout/logout-all/session-listing endpoints"
```

---

### Task 7: Email provider (mirrors OtpProvider's multi-provider failover)

**Files:**
- Create: `src/email/email-provider.interface.ts`
- Create: `src/email/console-email.provider.ts`
- Create: `src/email/email.service.ts`
- Create: `src/email/email.module.ts`
- Test: `src/email/email.service.spec.ts`

**Interfaces:**
- Produces: `EmailProvider { readonly name: string; send(message: EmailMessage): Promise<void>; }`, `EMAIL_PROVIDERS` DI token resolving to `EmailProvider[]`, `EmailService.send(message: EmailMessage): Promise<void>` — Task 8 (`AdminInviteController`) consumes this.

- [ ] **Step 1: Write the failing test**

`src/email/email.service.spec.ts`:

```typescript
import { InternalServerErrorException } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailProvider } from './email-provider.interface';

function fakeProvider(name: string, send: jest.Mock): EmailProvider {
  return { name, send };
}

describe('EmailService', () => {
  const message = { to: 'admin@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

  it('sends via the first provider that succeeds', async () => {
    const primarySend = jest.fn().mockResolvedValue(undefined);
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    const service = new EmailService([
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.send(message);

    expect(primarySend).toHaveBeenCalledWith(message);
    expect(secondarySend).not.toHaveBeenCalled();
  });

  it('falls back to the next provider when the first fails', async () => {
    const primarySend = jest.fn().mockRejectedValue(new Error('vendor down'));
    const secondarySend = jest.fn().mockResolvedValue(undefined);
    const service = new EmailService([
      fakeProvider('primary', primarySend),
      fakeProvider('secondary', secondarySend),
    ]);

    await service.send(message);

    expect(primarySend).toHaveBeenCalledTimes(1);
    expect(secondarySend).toHaveBeenCalledTimes(1);
  });

  it('throws once every provider has failed', async () => {
    const service = new EmailService([
      fakeProvider('primary', jest.fn().mockRejectedValue(new Error('A down'))),
      fakeProvider('secondary', jest.fn().mockRejectedValue(new Error('B down'))),
    ]);

    await expect(service.send(message)).rejects.toThrow(InternalServerErrorException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/email/email.service.spec.ts`
Expected: FAIL — `Cannot find module './email.service'`

- [ ] **Step 3: Implement the interface and mock provider**

`src/email/email-provider.interface.ts`:

```typescript
export const EMAIL_PROVIDERS = Symbol('EMAIL_PROVIDERS');

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
```

`src/email/console-email.provider.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from './email-provider.interface';

@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(`Email to ${message.to} — ${message.subject}\n${message.text ?? message.html}`);
  }
}
```

- [ ] **Step 4: Implement `EmailService`**

`src/email/email.service.ts`:

```typescript
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { EMAIL_PROVIDERS, EmailMessage, EmailProvider } from './email-provider.interface';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(@Inject(EMAIL_PROVIDERS) private readonly providers: EmailProvider[]) {}

  async send(message: EmailMessage): Promise<void> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        await provider.send(message);
        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Email provider "${provider.name}" failed: ${errorMessage}`);
        failures.push(`${provider.name}: ${errorMessage}`);
      }
    }

    throw new InternalServerErrorException(`All email providers failed: ${failures.join('; ')}`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/email/email.service.spec.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Wire the module**

`src/email/email.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { ConsoleEmailProvider } from './console-email.provider';
import { EMAIL_PROVIDERS } from './email-provider.interface';

@Module({
  providers: [
    EmailService,
    ConsoleEmailProvider,
    {
      provide: EMAIL_PROVIDERS,
      useFactory: (consoleProvider: ConsoleEmailProvider) => [consoleProvider],
      inject: [ConsoleEmailProvider],
    },
  ],
  exports: [EmailService],
})
export class EmailModule {}
```

- [ ] **Step 7: Commit**

```bash
git add src/email
git commit -m "feat: add EmailService with ordered multi-provider failover"
```

---

### Task 8: Admin invite management (create, resend, list)

**Files:**
- Create: `src/admin-invite/dto/create-invite.dto.ts`
- Create: `src/admin-invite/admin-invite.service.ts`
- Create: `src/admin-invite/admin-invite.controller.ts`
- Create: `src/admin-invite/admin-invite.module.ts`
- Test: `src/admin-invite/admin-invite.service.spec.ts`
- Test: `test/admin-invite.e2e-spec.ts`

**Interfaces:**
- Consumes: `generateOpaqueToken`/`hashToken` (Task 2), `AuditLogService` (Task 3), `EmailService` (Task 7).
- Produces: `AdminInviteService.create({email, roleId, invitedById}): Promise<{invite: AdminInvite; token: string}>`, `.resend(id: string): Promise<{invite: AdminInvite; token: string}>`, `.list(status？: AdminInviteStatus): Promise<AdminInvite[]>`, `.findValidByToken(token: string): Promise<AdminInvite>`, `.markAccepted(id: string): Promise<void>` — Task 5's `AdminAuthService.acceptInvite` already consumes `findValidByToken`/`markAccepted`.
- Produces: `POST /admin/invites`, `POST /admin/invites/:id/resend`, `GET /admin/invites`.

- [ ] **Step 1: Write the failing test for `AdminInviteService`**

`src/admin-invite/admin-invite.service.spec.ts`:

```typescript
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AdminInviteService } from './admin-invite.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from '../common/opaque-token.util';
import { AdminInviteStatus } from '../generated/prisma/client';

describe('AdminInviteService', () => {
  let service: AdminInviteService;
  let prisma: {
    adminInvite: {
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      adminInvite: {
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    service = new AdminInviteService(prisma as unknown as PrismaService);
  });

  it('creates an invite with a hashed token and a 7-day expiry', async () => {
    prisma.adminInvite.create.mockResolvedValue({ id: 'invite-1' });

    const { token } = await service.create({
      email: 'new-admin@example.com',
      roleId: 'role-1',
      invitedById: 'admin-1',
    });

    const createArgs = prisma.adminInvite.create.mock.calls[0][0];
    expect(createArgs.data.email).toBe('new-admin@example.com');
    expect(createArgs.data.roleId).toBe('role-1');
    expect(createArgs.data.invitedById).toBe('admin-1');
    expect(createArgs.data.tokenHash).toBe(hashToken(token));
    const expiresInMs = createArgs.data.expiresAt.getTime() - Date.now();
    expect(expiresInMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(expiresInMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it('resend rejects an invite that is not PENDING', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue({ id: 'invite-1', status: AdminInviteStatus.ACCEPTED });
    await expect(service.resend('invite-1')).rejects.toThrow(NotFoundException);
  });

  it('resend reissues a new token for a PENDING invite', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue({ id: 'invite-1', status: AdminInviteStatus.PENDING });
    prisma.adminInvite.update.mockResolvedValue({ id: 'invite-1', email: 'new-admin@example.com' });

    const { token } = await service.resend('invite-1');

    const updateArgs = prisma.adminInvite.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'invite-1' });
    expect(updateArgs.data.tokenHash).toBe(hashToken(token));
  });

  it('findValidByToken rejects an unknown token', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue(null);
    await expect(service.findValidByToken('unknown')).rejects.toThrow(UnauthorizedException);
  });

  it('findValidByToken rejects an expired invite', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue({
      status: AdminInviteStatus.PENDING,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(service.findValidByToken('expired')).rejects.toThrow(UnauthorizedException);
  });

  it('findValidByToken rejects an already-accepted invite', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue({
      status: AdminInviteStatus.ACCEPTED,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.findValidByToken('used')).rejects.toThrow(UnauthorizedException);
  });

  it('findValidByToken returns the invite when valid', async () => {
    const invite = { status: AdminInviteStatus.PENDING, expiresAt: new Date(Date.now() + 60_000) };
    prisma.adminInvite.findUnique.mockResolvedValue(invite);
    expect(await service.findValidByToken('valid')).toBe(invite);
  });

  it('markAccepted sets status ACCEPTED and acceptedAt', async () => {
    await service.markAccepted('invite-1');
    expect(prisma.adminInvite.update).toHaveBeenCalledWith({
      where: { id: 'invite-1' },
      data: { status: AdminInviteStatus.ACCEPTED, acceptedAt: expect.any(Date) },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/admin-invite/admin-invite.service.spec.ts`
Expected: FAIL — `Cannot find module './admin-invite.service'`

- [ ] **Step 3: Implement `AdminInviteService`**

`src/admin-invite/admin-invite.service.ts`:

```typescript
import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { generateOpaqueToken, hashToken } from '../common/opaque-token.util';
import { AdminInvite, AdminInviteStatus } from '../generated/prisma/client';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateInviteParams {
  email: string;
  roleId: string;
  invitedById: string;
}

export interface IssuedInvite {
  invite: AdminInvite;
  token: string;
}

@Injectable()
export class AdminInviteService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreateInviteParams): Promise<IssuedInvite> {
    const token = generateOpaqueToken();

    const invite = await this.prisma.adminInvite.create({
      data: {
        email: params.email,
        roleId: params.roleId,
        invitedById: params.invitedById,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });

    return { invite, token };
  }

  async resend(id: string): Promise<IssuedInvite> {
    const existing = await this.prisma.adminInvite.findUnique({ where: { id } });

    if (!existing || existing.status !== AdminInviteStatus.PENDING) {
      throw new NotFoundException('Invite not found or not pending');
    }

    const token = generateOpaqueToken();

    const invite = await this.prisma.adminInvite.update({
      where: { id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });

    return { invite, token };
  }

  async list(status?: AdminInviteStatus): Promise<AdminInvite[]> {
    return this.prisma.adminInvite.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findValidByToken(token: string): Promise<AdminInvite> {
    const invite = await this.prisma.adminInvite.findUnique({
      where: { tokenHash: hashToken(token) },
    });

    if (!invite || invite.status !== AdminInviteStatus.PENDING || invite.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired invitation');
    }

    return invite;
  }

  async markAccepted(id: string): Promise<void> {
    await this.prisma.adminInvite.update({
      where: { id },
      data: { status: AdminInviteStatus.ACCEPTED, acceptedAt: new Date() },
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/admin-invite/admin-invite.service.spec.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Add the DTO and controller**

`src/admin-invite/dto/create-invite.dto.ts`:

```typescript
import { IsEmail, IsUUID } from 'class-validator';

export class CreateInviteDto {
  @IsEmail()
  email: string;

  @IsUUID()
  roleId: string;
}
```

`src/admin-invite/admin-invite.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { EmailService } from '../email/email.service';
import { AdminInviteService } from './admin-invite.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { AdminInviteStatus, AuditActorType } from '../generated/prisma/client';

@Controller('admin/invites')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminInviteController {
  constructor(
    private readonly adminInviteService: AdminInviteService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @RequirePermissions('admins:create')
  async create(@Body() dto: CreateInviteDto, @Req() req: { user: JwtPayload }) {
    const { invite, token } = await this.adminInviteService.create({
      email: dto.email,
      roleId: dto.roleId,
      invitedById: req.user.sub,
    });

    await this.emailService.send({
      to: dto.email,
      subject: 'You have been invited as an admin',
      html: `<p>You have been invited. Use this token to accept: ${token}</p>`,
      text: `You have been invited. Use this token to accept: ${token}`,
    });

    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.invite.created',
      targetType: 'AdminInvite',
      targetId: invite.id,
      metadata: { email: dto.email, roleId: dto.roleId },
    });

    return { id: invite.id, email: invite.email, status: invite.status, expiresAt: invite.expiresAt };
  }

  @Post(':id/resend')
  @RequirePermissions('admins:create')
  async resend(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const { invite, token } = await this.adminInviteService.resend(id);

    await this.emailService.send({
      to: invite.email,
      subject: 'Your admin invitation (resent)',
      html: `<p>Use this token to accept: ${token}</p>`,
      text: `Use this token to accept: ${token}`,
    });

    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.invite.resent',
      targetType: 'AdminInvite',
      targetId: invite.id,
    });

    return { id: invite.id, email: invite.email, status: invite.status, expiresAt: invite.expiresAt };
  }

  @Get()
  @RequirePermissions('admins:create')
  list(@Query('status') status?: AdminInviteStatus) {
    return this.adminInviteService.list(status);
  }
}
```

`src/admin-invite/admin-invite.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { AdminInviteService } from './admin-invite.service';
import { AdminInviteController } from './admin-invite.controller';

@Module({
  imports: [AuditModule, EmailModule],
  controllers: [AdminInviteController],
  providers: [AdminInviteService],
  exports: [AdminInviteService],
})
export class AdminInviteModule {}
```

`AuditInterceptor` already exists (Task 3) and is exported by `AuditModule`, which this module imports — no extra `providers` entry is needed for it here.

- [ ] **Step 6: Commit**

```bash
git add src/admin-invite
git commit -m "feat: add admin invite create/resend/list"
```

---

### Task 9: Accept-invite DTO and e2e coverage

**Files:**
- Create: `src/auth/admin/dto/accept-invite.dto.ts`
- Test: `test/admin-invite.e2e-spec.ts`

**Interfaces:**
- Consumes: `AdminAuthService.acceptInvite` (Task 5), `AdminInviteService` (Task 8), `POST /admin/invites` (Task 8).
- Produces: nothing new for later tasks — this closes the loop Task 5's controller left open.

- [ ] **Step 1: Add the DTO**

`src/auth/admin/dto/accept-invite.dto.ts`:

```typescript
import { IsString, MinLength } from 'class-validator';

export class AcceptInviteDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @MinLength(1)
  fullName: string;
}
```

This is the file Task 5's `AdminAuthController` imports — with it in place, `AuthModule` now compiles end to end.

- [ ] **Step 2: Run the full unit suite to verify everything compiles and passes together**

Run: `npm run test`
Expected: PASS on all suites (every unit test written in Tasks 1–8 runs together for the first time here).

- [ ] **Step 3: Write the e2e test for the full invite → accept → login flow**

`test/admin-invite.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin invite (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrapAccessToken: string;
  let superAdminRoleId: string;
  const inviteEmail = 'invited-admin@example.com';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    bootstrapAccessToken = loginRes.body.accessToken;

    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    superAdminRoleId = role.id;
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { email: inviteEmail } });
    await prisma.adminInvite.deleteMany({ where: { email: inviteEmail } });
    await app.close();
  });

  it('creates an invite, and the invited admin does not exist yet', async () => {
    await request(app.getHttpServer())
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .send({ email: inviteEmail, roleId: superAdminRoleId })
      .expect(201)
      .expect((res) => {
        expect(res.body.email).toBe(inviteEmail);
        expect(res.body.status).toBe('PENDING');
      });

    const admin = await prisma.adminUser.findUnique({ where: { email: inviteEmail } });
    expect(admin).toBeNull();
  });

  it('rejects accept-invite with a made-up token', () => {
    return request(app.getHttpServer())
      .post('/auth/admin/accept-invite')
      .send({ token: 'not-a-real-token', password: 'invited-password', fullName: 'Invited Admin' })
      .expect(401);
  });

  it('lists the pending invite for the back office', () => {
    return request(app.getHttpServer())
      .get('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.some((invite: { email: string }) => invite.email === inviteEmail)).toBe(true);
      });
  });
});
```

Note: this suite deliberately does not accept a real invite end-to-end, because the invite token is only ever returned via the (mock) email provider, never in the HTTP response — matching the design's explicit requirement that the token never appears in an API response. `AdminInviteService`'s unit tests (Task 8) already prove `findValidByToken`/`markAccepted` work correctly against a real token; this e2e suite proves the HTTP-level wiring and the "no premature `AdminUser` row" guarantee instead.

- [ ] **Step 4: Run the e2e test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites, including this new one.

- [ ] **Step 5: Commit**

```bash
git add src/auth/admin/dto/accept-invite.dto.ts test/admin-invite.e2e-spec.ts
git commit -m "feat: add accept-invite DTO, closing the auth module wiring"
```

---

### Task 10: Apply the audit interceptor to AdminController + GET /admin/audit-logs

**Files:**
- Modify: `src/admin/admin.controller.ts`
- Modify: `src/admin/admin.module.ts`
- Create: `src/admin-audit-log/admin-audit-log.controller.ts`
- Create: `src/admin-audit-log/admin-audit-log.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/audit-log.e2e-spec.ts`

**Interfaces:**
- Consumes: `AuditLogService`, `AuditInterceptor` (both Task 3, already built and exported by `AuditModule`).
- Produces: `GET /admin/audit-logs`. `AdminController` (Phase 1's `/admin/me` and `/admin/roles/ping`) gains baseline audit logging, same as `AdminInviteController` already has from Task 8.

- [ ] **Step 1: Apply the interceptor to `AdminController`**

Modify `src/admin/admin.controller.ts`: add `UseInterceptors` to the import from `@nestjs/common`, import `AuditInterceptor`, and add `@UseInterceptors(AuditInterceptor)` alongside the existing `@UseGuards(...)` decorator on the class.

```typescript
import { Controller, Get, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminController {
  @Get('me')
  me(@Req() req: { user: JwtPayload }) {
    return { id: req.user.sub, type: req.user.type, permissions: req.user.permissions };
  }

  @Get('roles/ping')
  @RequirePermissions('roles:manage')
  rolesPing() {
    return { ok: true };
  }
}
```

`AdminModule` needs `AuditModule` importable for `AuditInterceptor`'s own `AuditLogService` dependency to resolve when Nest constructs it for `AdminController`. Since `AuditModule` (Task 3) already exports `AuditInterceptor` itself, `AdminModule` only needs to import `AuditModule` — no separate `providers` entry for `AuditInterceptor` is needed (the same reasoning already applied to `AdminInviteModule` in Task 8). Modify `src/admin/admin.module.ts` in full:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminController],
})
export class AdminModule {}
```

- [ ] **Step 2: Implement `GET /admin/audit-logs`**

`src/admin-audit-log/admin-audit-log.controller.ts`:

```typescript
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminAuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

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
}
```

`src/admin-audit-log/admin-audit-log.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminAuditLogController } from './admin-audit-log.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminAuditLogController],
})
export class AdminAuditLogModule {}
```

- [ ] **Step 3: Wire `AdminAuditLogModule` into `AppModule`**

Modify `src/app.module.ts`: add the import and register in `imports`.

```typescript
import { AdminAuditLogModule } from './admin-audit-log/admin-audit-log.module';
```

Add `AdminAuditLogModule` to the `imports` array.

- [ ] **Step 4: Write the e2e test**

`test/audit-log.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Audit log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  let superAdminRoleId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    accessToken = loginRes.body.accessToken;

    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    superAdminRoleId = role.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('records an explicit rich event when an invite is created', async () => {
    const email = `audit-test-${Date.now()}@example.com`;

    const res = await request(app.getHttpServer())
      .post('/admin/invites')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email, roleId: superAdminRoleId })
      .expect(201);

    // Fire-and-forget baseline logging (see AuditInterceptor) needs a brief
    // moment to land after the response is sent.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const explicitEntry = await prisma.auditLog.findFirst({
      where: { action: 'admin.invite.created', targetId: res.body.id },
    });
    expect(explicitEntry).not.toBeNull();
    expect((explicitEntry!.metadata as { email: string }).email).toBe(email);

    const baselineEntry = await prisma.auditLog.findFirst({
      where: { action: { contains: 'POST /admin/invites' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(baselineEntry).not.toBeNull();

    await prisma.adminInvite.deleteMany({ where: { email } });
  });

  it('GET /admin/audit-logs lists recorded entries, newest first', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET /admin/audit-logs filters by action', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .query({ action: 'admin.invite.created' })
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.every((entry: { action: string }) => entry.action === 'admin.invite.created')).toBe(true);
  });
});
```

- [ ] **Step 5: Run the full suite to verify everything passes**

Run: `npm run test && npm run test:e2e`
Expected: PASS on all suites.

- [ ] **Step 6: Commit**

```bash
git add src/admin src/admin-audit-log src/app.module.ts test/audit-log.e2e-spec.ts
git commit -m "feat: apply baseline audit logging to AdminController, add GET /admin/audit-logs"
```

---

### Task 11: Admin-forced session revocation for agents/clients

**Files:**
- Create: `src/admin-session/admin-session.controller.ts`
- Create: `src/admin-session/admin-session.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/admin-session-revoke.e2e-spec.ts`

**Interfaces:**
- Consumes: `SessionService.revokeAllForPrincipal` (Task 4), `AuditLogService` (Task 3).
- Produces: `POST /admin/agents/:id/sessions/revoke-all`, `POST /admin/clients/:id/sessions/revoke-all`.

- [ ] **Step 1: Implement the controller**

`src/admin-session/admin-session.controller.ts`:

```typescript
import { Controller, HttpCode, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { SessionService } from '../session/session.service';
import { AuditActorType, SessionPrincipalType } from '../generated/prisma/client';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminSessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post('agents/:id/sessions/revoke-all')
  @HttpCode(200)
  @RequirePermissions('agents:sessions:revoke')
  async revokeAgentSessions(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.AGENT, id, 'admin_forced');
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent.sessions.revoked',
      targetType: 'Agent',
      targetId: id,
    });
    return { revoked: true };
  }

  @Post('clients/:id/sessions/revoke-all')
  @HttpCode(200)
  @RequirePermissions('clients:sessions:revoke')
  async revokeClientSessions(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.CLIENT, id, 'admin_forced');
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'client.sessions.revoked',
      targetType: 'Client',
      targetId: id,
    });
    return { revoked: true };
  }
}
```

- [ ] **Step 2: Wire the module**

`src/admin-session/admin-session.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SessionModule } from '../session/session.module';
import { AdminSessionController } from './admin-session.controller';

@Module({
  imports: [AuditModule, SessionModule],
  controllers: [AdminSessionController],
})
export class AdminSessionModule {}
```

(As in Task 8 and Task 10, `AuditInterceptor` doesn't need its own `providers` entry — `AuditModule` already exports it.)

Modify `src/app.module.ts`: add the import and register `AdminSessionModule` in `imports`.

```typescript
import { AdminSessionModule } from './admin-session/admin-session.module';
```

- [ ] **Step 3: Write the e2e test**

`test/admin-session-revoke.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin-forced session revocation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const agentEmail = 'session-revoke-agent@example.com';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    adminAccessToken = loginRes.body.accessToken;

    const passwordHash = await bcrypt.hash('agent-password', 12);
    await prisma.agent.create({
      data: {
        email: agentEmail,
        phone: '+2348044444444',
        fullName: 'Session Revoke Agent',
        passwordHash,
        status: 'APPROVED',
      },
    });
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { email: agentEmail } });
    await app.close();
  });

  it("admin force-revoking an agent's sessions blocks their refresh token", async () => {
    const agentLoginRes = await request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email: agentEmail, password: 'agent-password' })
      .expect(200);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { email: agentEmail } });

    await request(app.getHttpServer())
      .post(`/admin/agents/${agent.id}/sessions/revoke-all`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect({ revoked: true });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: agentLoginRes.body.refreshToken })
      .expect(401);
  });

  it('rejects the revoke-all route without the required permission', async () => {
    // The bootstrap admin holds every permission (SUPER_ADMIN), so this
    // proves the route is permission-gated at all rather than open once
    // authenticated — a request with no Authorization header must fail.
    return request(app.getHttpServer())
      .post('/admin/agents/some-agent-id/sessions/revoke-all')
      .expect(401);
  });
});
```

- [ ] **Step 4: Run the e2e test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS on all suites.

- [ ] **Step 5: Commit**

```bash
git add src/admin-session src/app.module.ts test/admin-session-revoke.e2e-spec.ts
git commit -m "feat: add admin-forced session revocation for agents and clients"
```

---

### Task 12: Final wiring, README, and full regression pass

**Files:**
- Modify: `src/app.module.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: a fully wired `AppModule` importing every module from Tasks 1–11; an updated README documenting the new endpoints.

- [ ] **Step 1: Confirm `src/app.module.ts` imports every new module**

Replace `src/app.module.ts` in full:

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { AdminInviteModule } from './admin-invite/admin-invite.module';
import { AdminAuditLogModule } from './admin-audit-log/admin-audit-log.module';
import { AdminSessionModule } from './admin-session/admin-session.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    AdminModule,
    AdminInviteModule,
    AdminAuditLogModule,
    AdminSessionModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
```

(`OtpModule`, `SessionModule`, `EmailModule`, and `AuditModule` are imported transitively via `AuthModule`/`AdminInviteModule`/`AdminSessionModule`/`AdminAuditLogModule` — no direct import needed here, matching Phase 1's existing pattern where `OtpModule` was never imported directly into `AppModule` either.)

- [ ] **Step 2: Update the README**

Add to `README.md`, after the existing "Login endpoints" table:

```markdown
## Session endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/refresh` | `{ refreshToken }` in body | Rotates the refresh token; reusing an already-rotated token revokes every session for that principal. |
| `POST /auth/logout` | `{ refreshToken }` in body | Revokes one session. |
| `POST /auth/logout-all` | Bearer access token | Revokes every session for the authenticated principal. |
| `GET /auth/sessions` | Bearer access token | Lists the caller's own active sessions. |
| `DELETE /auth/sessions/:id` | Bearer access token | Revokes one of the caller's own sessions. |

## Admin invite flow

`POST /admin/invites` (`admins:create`) → emails a token via the mock console
email provider → `POST /auth/admin/accept-invite { token, password, fullName }`
(public) creates the `AdminUser` and logs them in. `POST
/admin/invites/:id/resend` and `GET /admin/invites` manage outstanding
invites. No `AdminUser` row exists until the invite is accepted.

## Audit log

Every mutating request to an admin-guarded route gets a baseline `AuditLog`
row automatically (actor, route, status). Business-meaningful actions (invite
created/resent, sessions force-revoked) also get an explicit, richer entry.
View them at `GET /admin/audit-logs` (`audit:read`), optionally filtered by
`actorType`, `action`, `targetType`, `targetId`.
```

- [ ] **Step 3: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite from Phase 1 and this plan green together.

- [ ] **Step 4: Commit**

```bash
git add src/app.module.ts README.md
git commit -m "docs: wire final AppModule for the governance bundle and update README"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] Refresh-token rotation, reuse detection, logout, logout-all, and self-service session listing/revocation all work end-to-end (`test/session-rails.e2e-spec.ts`).
- [ ] An admin can invite another admin by role, the invite creates no `AdminUser` row, and the token never appears in an API response (`test/admin-invite.e2e-spec.ts`).
- [ ] Every mutating admin request produces a baseline `AuditLog` row automatically, and invite creation/resend also produce a richer explicit row (`test/audit-log.e2e-spec.ts`).
- [ ] An admin holding `agents:sessions:revoke`/`clients:sessions:revoke` can force-revoke another principal's sessions, and the route rejects unauthenticated requests (`test/admin-session-revoke.e2e-spec.ts`).
- [ ] `PermissionsGuard` still governs every admin route with an explicit `@RequirePermissions(...)` — spot-check the new `AdminInviteController`, `AdminAuditLogController`, and `AdminSessionController`.

**Next:** the document ingestion/reconciliation engine (IPPIS broadsheet, repayment schedule, disbursed loans) is a separate design — write `docs/superpowers/specs/<date>-document-ingestion-design.md` via the brainstorming skill once this bundle ships.
