# Admin Account Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin holding `roles:manage` deactivate or reactivate another admin's account — the one missing action on top of `AdminUser.isActive` (which has existed since Phase 1 but nothing has ever set it).

**Architecture:** Two new methods on the existing `AdminRoleAssignmentService` (which already owns `listAdmins`/`assignRole`/`removeRole` — this is an extension of that "admin accounts" surface, not a new module), two new routes on the existing `AdminRoleAssignmentController` (`admin/admins`), reusing the existing `SessionService.revokeAllForPrincipal` primitive (already used by the Agent/Client force-revoke endpoints) to kill the deactivated admin's sessions immediately.

**Tech Stack:** NestJS 10, Prisma 7, Jest.

**Spec:** `docs/superpowers/specs/2026-09-17-admin-account-management-design.md`

## Global Constraints

- Both new endpoints require `roles:manage` — the same permission every other route in `AdminRoleAssignmentController` already requires (spec §2).
- An admin cannot deactivate their own account — `409` (spec §2, §3).
- Deactivate is not idempotent-silent — deactivating an already-inactive admin, or reactivating an already-active one, is a `409`, not a silent no-op (spec §2, §3).
- Deactivating force-revokes sessions via `SessionService.revokeAllForPrincipal(SessionPrincipalType.ADMIN, id, 'admin_deactivated')`; reactivating does not touch sessions at all (spec §2).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as the new endpoints.

---

### Task 1: `deactivate`/`reactivate` on `AdminRoleAssignmentService`, controller routes, module wiring, and e2e

**Files:**
- Modify: `src/admin-rbac/admin-role-assignment.service.ts`
- Modify: `src/admin-rbac/admin-role-assignment.service.spec.ts`
- Modify: `src/admin-rbac/admin-role-assignment.controller.ts`
- Modify: `src/admin-rbac/admin-rbac.module.ts`
- Modify: `test/admin-role-assignment.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: `SessionService.revokeAllForPrincipal(principalType: SessionPrincipalType, principalId: string, reason: string): Promise<void>` (already exists, exported by `SessionModule` from `src/session/session.module.ts`).
- Produces: `AdminRoleAssignmentService.deactivate(callerId: string, id: string): Promise<void>`, `.reactivate(id: string): Promise<void>` — this task is self-contained (controller + service + wiring together), unlike prior plans this session, because both halves are small enough that splitting them would leave an untestable intermediate state.

This codebase's existing `admin-role-assignment.service.spec.ts` file already has its own `beforeEach` constructing `new AdminRoleAssignmentService(prisma)`. Read that file first (`src/admin-rbac/admin-role-assignment.service.spec.ts`) to match its exact mock-Prisma shape before adding new tests — do not restructure its existing tests, only add new `describe` blocks.

- [ ] **Step 1: Write the failing unit tests**

Read `src/admin-rbac/admin-role-assignment.service.spec.ts` in full first. Add these two `describe` blocks to it (adjust the mock `prisma` object's shape to match whatever the file already uses — it needs `adminUser.findUnique` and `adminUser.update` mocks, and the service's constructor will now take a second argument, a mocked `SessionService`):

```typescript
describe('deactivate', () => {
  it('throws NotFoundException when the admin does not exist', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    await expect(service.deactivate('caller-1', 'missing-id')).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when deactivating your own account', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'caller-1', isActive: true });
    await expect(service.deactivate('caller-1', 'caller-1')).rejects.toThrow(ConflictException);
  });

  it('throws ConflictException when the admin is already inactive', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: false });
    await expect(service.deactivate('caller-1', 'admin-2')).rejects.toThrow(ConflictException);
  });

  it('deactivates the admin and revokes their sessions', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: true });
    prisma.adminUser.update.mockResolvedValue({ id: 'admin-2', isActive: false });

    await service.deactivate('caller-1', 'admin-2');

    expect(prisma.adminUser.update).toHaveBeenCalledWith({
      where: { id: 'admin-2' },
      data: { isActive: false },
    });
    expect(sessionService.revokeAllForPrincipal).toHaveBeenCalledWith('ADMIN', 'admin-2', 'admin_deactivated');
  });
});

describe('reactivate', () => {
  it('throws NotFoundException when the admin does not exist', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    await expect(service.reactivate('missing-id')).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when the admin is already active', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: true });
    await expect(service.reactivate('admin-2')).rejects.toThrow(ConflictException);
  });

  it('reactivates the admin without touching sessions', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: false });
    prisma.adminUser.update.mockResolvedValue({ id: 'admin-2', isActive: true });

    await service.reactivate('admin-2');

    expect(prisma.adminUser.update).toHaveBeenCalledWith({
      where: { id: 'admin-2' },
      data: { isActive: true },
    });
    expect(sessionService.revokeAllForPrincipal).not.toHaveBeenCalled();
  });
});
```

Add `sessionService = { revokeAllForPrincipal: jest.fn().mockResolvedValue(undefined) };` to the file's existing `beforeEach`, and change the existing `service = new AdminRoleAssignmentService(prisma)` line (wherever it is) to `service = new AdminRoleAssignmentService(prisma, sessionService as unknown as SessionService)`. Add `import { SessionService } from '../session/session.service';` and make sure `ConflictException`/`NotFoundException` are imported (they're almost certainly already imported for the existing `removeRole` tests — check before adding a duplicate import).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx jest src/admin-rbac/admin-role-assignment.service.spec.ts`
Expected: FAIL — `service.deactivate is not a function` (and similarly for `reactivate`), and the constructor-arity change will also break every pre-existing test in this file until Step 3 is done — that's expected and will resolve together.

- [ ] **Step 3: Implement `deactivate`/`reactivate`**

In `src/admin-rbac/admin-role-assignment.service.ts`, change the imports and constructor, and add the two methods:

```typescript
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../session/session.service';
import { SessionPrincipalType } from '../generated/prisma/client';

const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';

@Injectable()
export class AdminRoleAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  // ...listAdmins, assignRole, removeRole unchanged...

  async deactivate(callerId: string, id: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    if (id === callerId) {
      throw new ConflictException('Cannot deactivate your own account');
    }
    if (!admin.isActive) {
      throw new ConflictException('Admin is already deactivated');
    }

    await this.prisma.adminUser.update({ where: { id }, data: { isActive: false } });
    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.ADMIN, id, 'admin_deactivated');
  }

  async reactivate(id: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    if (admin.isActive) {
      throw new ConflictException('Admin is already active');
    }

    await this.prisma.adminUser.update({ where: { id }, data: { isActive: true } });
  }
}
```

Keep `listAdmins`, `assignRole`, and `removeRole` exactly as they already are in the file — only the constructor and imports change, plus the two new methods are added.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/admin-rbac/admin-role-assignment.service.spec.ts`
Expected: PASS — every existing test in the file plus the 7 new ones (3 deactivate-failure + 1 deactivate-success + 2 reactivate-failure + 1 reactivate-success).

- [ ] **Step 5: Add the controller routes**

In `src/admin-rbac/admin-role-assignment.controller.ts`, add two methods to the existing `AdminRoleAssignmentController` class (no new imports needed — `HttpCode`, `Post`, `Param`, `Req`, `RequirePermissions`, `AuditActorType` are all already imported in this file):

```typescript
  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async deactivate(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminRoleAssignmentService.deactivate(req.user.sub, id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.deactivated',
      targetType: 'AdminUser',
      targetId: id,
    });
    return { deactivated: true };
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async reactivate(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminRoleAssignmentService.reactivate(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.reactivated',
      targetType: 'AdminUser',
      targetId: id,
    });
    return { reactivated: true };
  }
```

Add these inside the class body, after the existing `removeRole` method.

- [ ] **Step 6: Wire `SessionModule` into `AdminRbacModule`**

In `src/admin-rbac/admin-rbac.module.ts`, add the import and add `SessionModule` to `imports`:

```typescript
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SessionModule } from '../session/session.module';
import { PermissionService } from './permission.service';
import { RoleService } from './role.service';
import { AdminRoleAssignmentService } from './admin-role-assignment.service';
import { AdminPermissionsController } from './admin-permissions.controller';
import { AdminRolesController } from './admin-roles.controller';
import { AdminRoleAssignmentController } from './admin-role-assignment.controller';

@Module({
  imports: [AuditModule, SessionModule],
  controllers: [AdminPermissionsController, AdminRolesController, AdminRoleAssignmentController],
  providers: [PermissionService, RoleService, AdminRoleAssignmentService],
})
export class AdminRbacModule {}
```

- [ ] **Step 7: Run the full unit suite and type-check**

Run: `npx jest src/admin-rbac && npx tsc --noEmit`
Expected: PASS, no type errors. (`AdminRbacModule` compiling confirms `SessionService` resolves via DI; `npx tsc --noEmit` confirms nothing else broke from the constructor signature change.)

- [ ] **Step 8: Extend the e2e test**

Read `test/admin-role-assignment.e2e-spec.ts` in full first (it already logs in as the bootstrap admin in `beforeAll` and stores `accessToken`/`bootstrapAdminId`). Add a second admin fixture to `beforeAll` and new `it` blocks. Insert after the existing `testRole` creation in `beforeAll`:

```typescript
    const secondAdminEmail = `e2e-deactivate-${Date.now()}@example.com`;
    const secondAdminPasswordHash = await bcrypt.hash('Test-Password-123!', 12);
    const secondAdmin = await prisma.adminUser.create({
      data: { email: secondAdminEmail, passwordHash: secondAdminPasswordHash, fullName: 'E2E Deactivate Target' },
    });
    secondAdminId = secondAdmin.id;

    const secondAdminLoginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: secondAdminEmail, password: 'Test-Password-123!' });
    secondAdminRefreshToken = secondAdminLoginRes.body.refreshToken;
```

Add `import * as bcrypt from 'bcrypt';` to the top of the file, and declare `let secondAdminId: string;` and `let secondAdminRefreshToken: string;` alongside the file's other `let` declarations at the top of the `describe` block.

Add to `afterAll`, before `await app.close();`:

```typescript
    await prisma.adminUser.deleteMany({ where: { id: secondAdminId } });
```

Add these `it` blocks at the end of the file, before the closing `});` of the `describe` block:

```typescript
  it('rejects an admin deactivating their own account (409)', () => {
    return request(app.getHttpServer())
      .post(`/admin/admins/${bootstrapAdminId}/deactivate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it('deactivates a different admin and revokes their sessions', async () => {
    await request(app.getHttpServer())
      .post(`/admin/admins/${secondAdminId}/deactivate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ deactivated: true });

    const listRes = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const deactivatedEntry = listRes.body.find((a: { id: string }) => a.id === secondAdminId);
    expect(deactivatedEntry.isActive).toBe(false);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: secondAdminRefreshToken })
      .expect(401);
  });

  it('rejects deactivating an already-deactivated admin (409)', () => {
    return request(app.getHttpServer())
      .post(`/admin/admins/${secondAdminId}/deactivate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it('reactivates the admin', async () => {
    await request(app.getHttpServer())
      .post(`/admin/admins/${secondAdminId}/reactivate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ reactivated: true });

    const listRes = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const reactivatedEntry = listRes.body.find((a: { id: string }) => a.id === secondAdminId);
    expect(reactivatedEntry.isActive).toBe(true);
  });
```

- [ ] **Step 9: Run the e2e test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/admin-role-assignment.e2e-spec.ts --runInBand`
Expected: PASS — 8 tests total (the 4 pre-existing plus the 4 new ones).

- [ ] **Step 10: Update the README**

Add a row to whatever existing table/section in `README.md` documents the `admin/admins` endpoints (search for `/admin/admins/:id/roles` to find it) — add:

```markdown
| `POST /admin/admins/:id/deactivate` | `roles:manage` | 409 if targeting your own account or an already-inactive admin; force-revokes the admin's sessions |
| `POST /admin/admins/:id/reactivate` | `roles:manage` | 409 if the admin is already active |
```

If that section isn't a table (check first — it may be prose), match whatever format is actually there instead of introducing a table where one doesn't exist.

- [ ] **Step 11: Add Postman coverage**

In `postman/public-sector-backend.postman_collection.json`, find the existing `admin/admins` requests (search for `"admin/admins"` — they live under the Admin top-level folder's "Admins" sub-folder alongside the list/assign-role/remove-role requests already there). Using a surgical text insert (not a full JSON re-parse/re-dump, to avoid disturbing this file's existing unicode escaping elsewhere), add two new requests to that same sub-folder's `item` array, after the existing remove-role request:

```json
{
  "name": "POST /admin/admins/:id/deactivate - Self-deactivation blocked (409)",
  "request": {
    "method": "POST",
    "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
    "url": {
      "raw": "{{base_url}}/admin/admins/{{admin_id}}/deactivate",
      "host": ["{{base_url}}"],
      "path": ["admin", "admins", "{{admin_id}}", "deactivate"]
    },
    "description": "admin_id must be set to the same admin currently logged in as admin_access_token for this 409 to occur."
  },
  "event": [{ "listen": "test", "script": { "exec": ["pm.test('status 409', () => pm.response.to.have.status(409));"] } }]
},
{
  "name": "POST /admin/admins/:id/deactivate - Success",
  "request": {
    "method": "POST",
    "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
    "url": {
      "raw": "{{base_url}}/admin/admins/{{target_admin_id}}/deactivate",
      "host": ["{{base_url}}"],
      "path": ["admin", "admins", "{{target_admin_id}}", "deactivate"]
    },
    "description": "target_admin_id must be a different admin from the one running this request."
  },
  "event": [
    {
      "listen": "test",
      "script": {
        "exec": [
          "pm.test('status 200', () => pm.response.to.have.status(200));",
          "pm.test('deactivated true', () => pm.expect(pm.response.json().deactivated).to.eql(true));"
        ]
      }
    }
  ]
},
{
  "name": "POST /admin/admins/:id/reactivate - Success",
  "request": {
    "method": "POST",
    "header": [{ "key": "Authorization", "value": "Bearer {{admin_access_token}}" }],
    "url": {
      "raw": "{{base_url}}/admin/admins/{{target_admin_id}}/reactivate",
      "host": ["{{base_url}}"],
      "path": ["admin", "admins", "{{target_admin_id}}", "reactivate"]
    }
  },
  "event": [
    {
      "listen": "test",
      "script": {
        "exec": [
          "pm.test('status 200', () => pm.response.to.have.status(200));",
          "pm.test('reactivated true', () => pm.expect(pm.response.json().reactivated).to.eql(true));"
        ]
      }
    }
  ]
}
```

If a `target_admin_id` collection variable doesn't already exist, add it (empty default) alongside the other collection variables. Check whether `admin_id` already exists as a variable (it likely does, from existing admin requests) before adding it.

- [ ] **Step 12: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 13: Run the full test suite**

Run: `npm run test && npm run test:e2e`
Expected: PASS — every unit and e2e suite, including all changes from this plan.

- [ ] **Step 14: Commit**

```bash
git add src/admin-rbac test/admin-role-assignment.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json
git commit -m "feat: add admin account deactivate/reactivate"
```

## Exit criteria

- [ ] `npm run test` and `npm run test:e2e` both pass from a clean state.
- [ ] An admin holding `roles:manage` can deactivate a different admin; that admin's `isActive` flips to `false` and their refresh token is immediately rejected by `POST /auth/refresh` — proven by the e2e test.
- [ ] An admin cannot deactivate their own account (`409`) — proven by both the unit and e2e tests.
- [ ] Deactivating an already-inactive admin, or reactivating an already-active one, is a `409`, not a silent success — proven by the unit tests.
- [ ] Reactivating flips `isActive` back to `true` without touching any session — proven by the unit test's explicit `revokeAllForPrincipal` non-call assertion.
- [ ] Postman has coverage for both new endpoints under the Admin > Admins sub-folder.
