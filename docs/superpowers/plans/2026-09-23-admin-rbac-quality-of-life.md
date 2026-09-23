# Admin RBAC Quality-of-Life Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bulk permission assignment, first/last name collection at invite-accept time, invite responses hydrating their role, suspend/unsuspend renaming, and invite deletion — five small, mostly-additive improvements to the Admin RBAC domain built in Sub-project A.

**Architecture:** Four independent slices (bulk permissions, invite hydration+deletion, invite-accept name split, suspend/unsuspend rename) each touching their own service/controller pair, plus a closing task. Invite hydration and the name split both touch `test/admin-invite.e2e-spec.ts`, so those two tasks run in that order (Task 2 before Task 3) rather than in parallel.

**Tech Stack:** NestJS, Prisma, `class-validator`, Jest + Supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-admin-rbac-quality-of-life-design.md`

## Global Constraints

- New bulk-permission endpoint is additive (upserts), all-or-nothing validation (reject the whole batch if any `permissionId` doesn't exist, write none of them).
- `AdminUser.firstName`/`lastName` become required; `fullName` stays a column, always derived as `` `${firstName} ${lastName}` `` — never independently settable.
- Existing admins get a one-time backfill (split `fullName` on the first space) — same two-phase migration shape (nullable → backfill → `NOT NULL`) Sub-project A already established.
- `AdminInvite` create/resend responses gain a trimmed `role: { id, name }`; `list` rows gain the full nested `Role` object.
- `deactivate`/`reactivate` rename to `suspend`/`unsuspend` — same `isActive` mechanism, no new state.
- Invite deletion reuses `resend()`'s exact guard shape (`NotFoundException('Invite not found or not pending')`, PENDING-only).
- No `Co-Authored-By: Claude` trailer on any commit.
- This plan is its own complete phase — its closing task runs the full unit + e2e suite.

---

### Task 1: Bulk permission assignment

**Files:**
- Create: `src/admin-rbac/dto/assign-permissions-bulk.dto.ts`
- Modify: `src/admin-rbac/role.service.ts`
- Modify: `src/admin-rbac/admin-roles.controller.ts`
- Modify: `src/admin-rbac/role.service.spec.ts`
- Modify: `test/admin-roles.e2e-spec.ts`

**Interfaces:**
- Produces: `RoleService.assignPermissions(roleId: string, permissionIds: string[]): Promise<void>`.

- [ ] **Step 1: Write the failing unit tests**

Read `src/admin-rbac/role.service.spec.ts` in full first. Add `findMany: jest.fn()` to the `prisma.permission` mock (it currently only has `findUnique`), and add `$transaction: jest.fn()` to the top-level `prisma` mock object (a new key alongside `role`/`adminUser`/`permission`/`rolePermission`). Add:

```typescript
  describe('assignPermissions', () => {
    it('rejects the whole batch when any permissionId is unknown, writing none of them', async () => {
      prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
      prisma.permission.findMany.mockResolvedValue([{ id: 'perm-1' }]);

      await expect(service.assignPermissions('role-1', ['perm-1', 'perm-missing'])).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('upserts every permission in the batch when all are valid', async () => {
      prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
      prisma.permission.findMany.mockResolvedValue([{ id: 'perm-1' }, { id: 'perm-2' }]);
      prisma.$transaction.mockResolvedValue(undefined);
      prisma.rolePermission.upsert.mockReturnValue('upsert-call');

      await service.assignPermissions('role-1', ['perm-1', 'perm-2']);

      expect(prisma.rolePermission.upsert).toHaveBeenCalledWith({
        where: { roleId_permissionId: { roleId: 'role-1', permissionId: 'perm-1' } },
        update: {},
        create: { roleId: 'role-1', permissionId: 'perm-1' },
      });
      expect(prisma.rolePermission.upsert).toHaveBeenCalledWith({
        where: { roleId_permissionId: { roleId: 'role-1', permissionId: 'perm-2' } },
        update: {},
        create: { roleId: 'role-1', permissionId: 'perm-2' },
      });
      expect(prisma.$transaction).toHaveBeenCalledWith(['upsert-call', 'upsert-call']);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/admin-rbac/role.service.spec.ts -t assignPermissions`
Expected: FAIL — `assignPermissions` doesn't exist yet.

- [ ] **Step 3: Implement `RoleService.assignPermissions`**

In `src/admin-rbac/role.service.ts`, add this method right after `assignPermission`:

```typescript
  async assignPermissions(roleId: string, permissionIds: string[]): Promise<void> {
    await this.findById(roleId);
    const permissions = await this.prisma.permission.findMany({ where: { id: { in: permissionIds } } });
    const foundIds = new Set(permissions.map((p) => p.id));
    const missing = permissionIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(`Permission(s) not found: ${missing.join(', ')}`);
    }

    await this.prisma.$transaction(
      permissionIds.map((permissionId) =>
        this.prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId, permissionId } },
          update: {},
          create: { roleId, permissionId },
        }),
      ),
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/admin-rbac/role.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 5: Create the DTO**

Create `src/admin-rbac/dto/assign-permissions-bulk.dto.ts`:

```typescript
import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class AssignPermissionsBulkDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  permissionIds: string[];
}
```

- [ ] **Step 6: Add the controller route**

In `src/admin-rbac/admin-roles.controller.ts`, add the import `import { AssignPermissionsBulkDto } from './dto/assign-permissions-bulk.dto';`. Add this route right after `assignPermission`:

```typescript
  @Post(':id/permissions/bulk')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async assignPermissionsBulk(
    @Param('id') id: string,
    @Body() dto: AssignPermissionsBulkDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.roleService.assignPermissions(id, dto.permissionIds);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.permissions.bulk_assigned',
      targetType: 'Role',
      targetId: id,
      metadata: { permissionIds: dto.permissionIds },
    });
    return { assigned: true };
  }
```

- [ ] **Step 7: Extend the e2e test**

Read `test/admin-roles.e2e-spec.ts` in full first. Add two more test-permission constants near the existing `testPermissionKey`:

```typescript
  const bulkPermissionKeyA = `test:role-e2e-bulk-a:${Date.now()}`;
  const bulkPermissionKeyB = `test:role-e2e-bulk-b:${Date.now()}`;
  let bulkPermissionIdA: string;
  let bulkPermissionIdB: string;
```

In `beforeAll`, right after the existing `createdPermissionId = permission.id;` line, add:

```typescript
    const bulkPermissionA = await prisma.permission.create({
      data: { key: bulkPermissionKeyA, description: 'e2e bulk test permission A' },
    });
    bulkPermissionIdA = bulkPermissionA.id;
    const bulkPermissionB = await prisma.permission.create({
      data: { key: bulkPermissionKeyB, description: 'e2e bulk test permission B' },
    });
    bulkPermissionIdB = bulkPermissionB.id;
```

In `afterAll`, add cleanup for the two new permissions alongside the existing one:

```typescript
    await prisma.permission.deleteMany({ where: { key: { in: [bulkPermissionKeyA, bulkPermissionKeyB] } } });
```

Add a new test right after `'assigns a permission to the role'`:

```typescript
  it('bulk-assigns multiple permissions to the role in one call', async () => {
    await request(app.getHttpServer())
      .post(`/admin/roles/${createdRoleId}/permissions/bulk`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ permissionIds: [bulkPermissionIdA, bulkPermissionIdB] })
      .expect(200)
      .expect({ assigned: true });

    const res = await request(app.getHttpServer())
      .get(`/admin/roles/${createdRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const keys = res.body.permissions.map((rp: { permission: { key: string } }) => rp.permission.key);
    expect(keys).toContain(bulkPermissionKeyA);
    expect(keys).toContain(bulkPermissionKeyB);
  });

  it('rejects a bulk-assign batch containing an unknown permissionId, writing none of it (404)', async () => {
    await request(app.getHttpServer())
      .post(`/admin/roles/${createdRoleId}/permissions/bulk`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ permissionIds: [bulkPermissionIdA, '00000000-0000-0000-0000-000000000000'] })
      .expect(404);
  });
```

- [ ] **Step 8: Run the e2e test**

Run: `npx jest --config ./test/jest-e2e.json test/admin-roles.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 9: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/admin-rbac/dto/assign-permissions-bulk.dto.ts src/admin-rbac/role.service.ts src/admin-rbac/admin-roles.controller.ts src/admin-rbac/role.service.spec.ts test/admin-roles.e2e-spec.ts
git commit -m "feat: add bulk permission assignment to roles"
```

---

### Task 2: `AdminInvite` responses hydrate the role relation, and invites can be deleted

**Files:**
- Modify: `src/admin-invite/admin-invite.service.ts`
- Modify: `src/admin-invite/admin-invite.controller.ts`
- Modify: `src/admin-invite/admin-invite.service.spec.ts`
- Modify: `test/admin-invite.e2e-spec.ts`

**Interfaces:**
- Produces: `AdminInviteService.remove(id: string): Promise<void>`. `create`/`resend`/`list` all now `include: { role: true }`.

- [ ] **Step 1: Write the failing unit tests**

Read `src/admin-invite/admin-invite.service.spec.ts` in full first. Update the existing `'creates an invite...'` test's `prisma.adminInvite.create.mockResolvedValue({ id: 'invite-1' })` calls throughout the file to also expect `include: { role: true }` on relevant calls — specifically, find every `prisma.adminInvite.create(...)`/`.update(...)`/`.findMany(...)` assertion in this file (`toHaveBeenCalledWith`) and add `include: { role: true }` to the expected argument object where the plan's Step 3 below adds it (in `create`, `resend`, and `list`). Add a new `describe('remove', ...)` block:

```typescript
  describe('remove', () => {
    it('throws NotFoundException for an unknown invite', async () => {
      prisma.adminInvite.findUnique.mockResolvedValue(null);
      await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for a non-PENDING invite', async () => {
      prisma.adminInvite.findUnique.mockResolvedValue({ id: 'invite-1', status: 'ACCEPTED' });
      await expect(service.remove('invite-1')).rejects.toThrow(NotFoundException);
    });

    it('deletes a PENDING invite', async () => {
      prisma.adminInvite.findUnique.mockResolvedValue({ id: 'invite-1', status: 'PENDING' });
      await service.remove('invite-1');
      expect(prisma.adminInvite.delete).toHaveBeenCalledWith({ where: { id: 'invite-1' } });
    });
  });
```

Add `delete: jest.fn()` to the `prisma.adminInvite` mock's type declaration and instantiation.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/admin-invite/admin-invite.service.spec.ts`
Expected: FAIL — `remove` doesn't exist yet, `include: { role: true }` isn't passed yet.

- [ ] **Step 3: Update `AdminInviteService`**

In `src/admin-invite/admin-invite.service.ts`, add `include: { role: true }` to all three Prisma calls. Replace:

```typescript
    const invite = await this.prisma.adminInvite.create({
      data: {
        email: params.email,
        roleId: params.roleId,
        invitedById: params.invitedById,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
```

with:

```typescript
    const invite = await this.prisma.adminInvite.create({
      data: {
        email: params.email,
        roleId: params.roleId,
        invitedById: params.invitedById,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
      include: { role: true },
    });
```

Replace:

```typescript
    const invite = await this.prisma.adminInvite.update({
      where: { id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
```

with:

```typescript
    const invite = await this.prisma.adminInvite.update({
      where: { id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
      include: { role: true },
    });
```

Replace:

```typescript
      this.prisma.adminInvite.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
```

with:

```typescript
      this.prisma.adminInvite.findMany({
        where,
        include: { role: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
```

Add this method at the end of the class, right after `markAccepted`:

```typescript
  async remove(id: string): Promise<void> {
    const invite = await this.prisma.adminInvite.findUnique({ where: { id } });
    if (!invite || invite.status !== AdminInviteStatus.PENDING) {
      throw new NotFoundException('Invite not found or not pending');
    }
    await this.prisma.adminInvite.delete({ where: { id } });
  }
```

- [ ] **Step 4: Update `AdminInviteController`**

In `src/admin-invite/admin-invite.controller.ts`, add `Delete, HttpCode` to the `@nestjs/common` import. Replace the `create` handler's return statement:

```typescript
    return { id: invite.id, email: invite.email, status: invite.status, expiresAt: invite.expiresAt };
  }

  @Post(':id/resend')
```

with:

```typescript
    return {
      id: invite.id,
      email: invite.email,
      status: invite.status,
      expiresAt: invite.expiresAt,
      role: { id: invite.role.id, name: invite.role.name },
    };
  }

  @Post(':id/resend')
```

Replace the `resend` handler's return statement (the second, identical-looking `return { id: invite.id, email: invite.email, status: invite.status, expiresAt: invite.expiresAt };` line) with the same trimmed-role shape:

```typescript
    return {
      id: invite.id,
      email: invite.email,
      status: invite.status,
      expiresAt: invite.expiresAt,
      role: { id: invite.role.id, name: invite.role.name },
    };
  }
```

Add a new route at the end of the class, right after `list`:

```typescript
  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('admins:create')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminInviteService.remove(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.invite.deleted',
      targetType: 'AdminInvite',
      targetId: id,
    });
    return { deleted: true };
  }
```

Add `Param` to the `@nestjs/common` import if not already present (check first — it likely already is, used by `resend`).

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx jest src/admin-invite/admin-invite.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 6: Extend the e2e test**

Read `test/admin-invite.e2e-spec.ts` in full first. Update the create-invite test's assertions to also check the hydrated role:

Replace:

```typescript
      .expect(201)
      .expect((res) => {
        expect(res.body.email).toBe(inviteEmail);
        expect(res.body.status).toBe('PENDING');
      });
```

with:

```typescript
      .expect(201)
      .expect((res) => {
        expect(res.body.email).toBe(inviteEmail);
        expect(res.body.status).toBe('PENDING');
        expect(res.body.role).toEqual({ id: superAdminRoleId, name: 'SUPER_ADMIN' });
      });
```

Add a new test right after `'lists the pending invite for the back office'`:

```typescript
  it('lists invites with the full role object hydrated', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .expect(200);
    const listedInvite = res.body.data.find((invite: { email: string }) => invite.email === inviteEmail);
    expect(listedInvite.role.name).toBe('SUPER_ADMIN');
  });

  it('creates and then deletes a PENDING invite', async () => {
    const deletableEmail = `deletable-invite-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .send({ email: deletableEmail, roleId: superAdminRoleId })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/admin/invites/${createRes.body.id}`)
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .expect(200)
      .expect({ deleted: true });

    const found = await prisma.adminInvite.findUnique({ where: { id: createRes.body.id } });
    expect(found).toBeNull();
  });

  it('rejects deleting an already-accepted or unknown invite (404)', () => {
    return request(app.getHttpServer())
      .delete('/admin/invites/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .expect(404);
  });
```

- [ ] **Step 7: Run the e2e test**

Run: `npx jest --config ./test/jest-e2e.json test/admin-invite.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 8: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/admin-invite/admin-invite.service.ts src/admin-invite/admin-invite.controller.ts src/admin-invite/admin-invite.service.spec.ts test/admin-invite.e2e-spec.ts
git commit -m "feat: hydrate role on admin invites and allow deleting pending ones"
```

---

### Task 3: Accept-invite collects first/last name

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/auth/admin/dto/accept-invite.dto.ts`
- Modify: `src/auth/admin/admin-auth.service.ts`
- Modify: `src/auth/admin/admin-auth.controller.ts`
- Modify: `src/auth/admin/admin-auth.service.spec.ts`
- Modify: `test/admin-invite.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2 directly, but touches the same e2e file Task 2 just committed to — read its current state fresh, not from memory of the plan's Task 2 snippets.
- Produces: `AdminAuthService.acceptInvite(token, password, firstName, lastName, meta?)` (was `(token, password, fullName, meta?)`).

- [ ] **Step 1: Migrate the schema (nullable → backfill → required, same shape as Sub-project A)**

In `prisma/schema.prisma`, add `firstName String?` and `lastName String?` (nullable) to `AdminUser`, right after `passwordHash`:

```prisma
  id           String          @id @default(uuid())
  email        String          @unique
  passwordHash String
  firstName    String?
  lastName     String?
  fullName     String
```

Run: `npx prisma migrate dev --name adminuser_add_nullable_first_last_name`
Expected: migration applies, Prisma client regenerates with the two new nullable columns.

- [ ] **Step 2: Write and run the backfill script**

Create a throwaway script `prisma/backfill-admin-names.ts` (deleted at the end of this task, not part of the final commit):

```typescript
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

async function main() {
  const admins = await prisma.adminUser.findMany({ where: { firstName: null } });

  for (const admin of admins) {
    const trimmed = admin.fullName.trim();
    const firstSpace = trimmed.indexOf(' ');
    const firstName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
    const lastName = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

    if (firstSpace === -1) {
      console.warn(`Admin ${admin.email} (${admin.id}) has a single-word fullName "${admin.fullName}" — firstName set to the whole string, lastName left empty, review if this is wrong`);
    }

    await prisma.adminUser.update({ where: { id: admin.id }, data: { firstName, lastName } });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
```

Run: `npx ts-node prisma/backfill-admin-names.ts`
Expected: every existing `AdminUser` (including the bootstrap admin) now has `firstName`/`lastName` set; any single-word-`fullName` warnings identify admins worth a manual look.

Delete the script: `rm prisma/backfill-admin-names.ts` (must not be part of the final commit, same reasoning as Sub-project A's equivalent script).

**Note on production/CI environments**, same as Sub-project A: fold the backfill into the actual migration SQL rather than relying only on a separately-run script, so any other environment's data gets the same treatment automatically. After proving the logic locally with the script above, generate the required-column migration without auto-applying (`npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, or `--create-only` if that works in your environment — Sub-project A's Task 3 found `--create-only` blocked in this environment and used `migrate diff` instead, matching whichever approach actually works here), and insert equivalent backfill SQL as the first statement:

```sql
UPDATE "AdminUser"
SET "firstName" = split_part(trim("fullName"), ' ', 1),
    "lastName" = CASE
      WHEN position(' ' in trim("fullName")) = 0 THEN ''
      ELSE trim(substring(trim("fullName") from position(' ' in trim("fullName")) + 1))
    END
WHERE "firstName" IS NULL;
```

(placed before the `ALTER TABLE "AdminUser" ALTER COLUMN "firstName" SET NOT NULL` / `... "lastName" SET NOT NULL` lines).

- [ ] **Step 3: Alter the columns to required**

In `prisma/schema.prisma`, change `firstName String?`/`lastName String?` to `firstName String`/`lastName String` (drop the `?`).

Run the required-column migration (inspect-then-apply, with the backfill SQL inserted, exactly as Step 2's note describes): `npx prisma migrate dev --name adminuser_require_first_last_name`.
Expected: migration applies cleanly (no NOT NULL violation, since the backfill SQL ran first), Prisma client regenerates with both fields required.

- [ ] **Step 4: Write the failing unit test**

Read `src/auth/admin/admin-auth.service.spec.ts` in full first. Replace:

```typescript
  it('acceptInvite creates the AdminUser with the invited role and its department, and logs in', async () => {
    adminInviteService.findValidByToken.mockResolvedValue({
      id: 'invite-1',
      email: 'new-admin@example.com',
      roleId: 'role-1',
    });
    prisma.role.findUniqueOrThrow.mockResolvedValue({ id: 'role-1', departmentId: 'dept-1' });
    prisma.adminUser.create.mockResolvedValue({ id: 'admin-2' });
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-2',
      role: { permissions: [] },
    });

    const result = await service.acceptInvite('some-token', 'new-password', 'New Admin');

    expect(prisma.adminUser.create).toHaveBeenCalledWith({
      data: {
        email: 'new-admin@example.com',
        passwordHash: expect.any(String),
        fullName: 'New Admin',
        roleId: 'role-1',
        departmentId: 'dept-1',
      },
    });
    expect(adminInviteService.markAccepted).toHaveBeenCalledWith('invite-1');
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
```

with:

```typescript
  it('acceptInvite creates the AdminUser with a derived fullName, the invited role, and its department, and logs in', async () => {
    adminInviteService.findValidByToken.mockResolvedValue({
      id: 'invite-1',
      email: 'new-admin@example.com',
      roleId: 'role-1',
    });
    prisma.role.findUniqueOrThrow.mockResolvedValue({ id: 'role-1', departmentId: 'dept-1' });
    prisma.adminUser.create.mockResolvedValue({ id: 'admin-2' });
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-2',
      role: { permissions: [] },
    });

    const result = await service.acceptInvite('some-token', 'new-password', 'New', 'Admin');

    expect(prisma.adminUser.create).toHaveBeenCalledWith({
      data: {
        email: 'new-admin@example.com',
        passwordHash: expect.any(String),
        firstName: 'New',
        lastName: 'Admin',
        fullName: 'New Admin',
        roleId: 'role-1',
        departmentId: 'dept-1',
      },
    });
    expect(adminInviteService.markAccepted).toHaveBeenCalledWith('invite-1');
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts -t acceptInvite`
Expected: FAIL — old 3-arg signature, `fullName` param no longer matches.

- [ ] **Step 6: Update `AdminAuthService.acceptInvite`**

In `src/auth/admin/admin-auth.service.ts`, replace:

```typescript
  async acceptInvite(
    token: string,
    password: string,
    fullName: string,
    meta?: { userAgent?: string; ip?: string },
  ) {
    const invite = await this.adminInviteService.findValidByToken(token);
    const passwordHash = await hashPassword(password);
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: invite.roleId } });

    const admin = await this.prisma.adminUser.create({
      data: {
        email: invite.email,
        passwordHash,
        fullName,
        roleId: role.id,
        departmentId: role.departmentId,
      },
    });
```

with:

```typescript
  async acceptInvite(
    token: string,
    password: string,
    firstName: string,
    lastName: string,
    meta?: { userAgent?: string; ip?: string },
  ) {
    const invite = await this.adminInviteService.findValidByToken(token);
    const passwordHash = await hashPassword(password);
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: invite.roleId } });

    const admin = await this.prisma.adminUser.create({
      data: {
        email: invite.email,
        passwordHash,
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`,
        roleId: role.id,
        departmentId: role.departmentId,
      },
    });
```

- [ ] **Step 7: Update `AcceptInviteDto`**

Replace the full contents of `src/auth/admin/dto/accept-invite.dto.ts`:

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
  firstName: string;

  @IsString()
  @MinLength(1)
  lastName: string;
}
```

- [ ] **Step 8: Update `AdminAuthController`**

In `src/auth/admin/admin-auth.controller.ts`, replace:

```typescript
  acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    return this.adminAuthService.acceptInvite(
      dto.token,
      dto.password,
      dto.fullName,
      getRequestMetadata(req),
    );
  }
```

with:

```typescript
  acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    return this.adminAuthService.acceptInvite(
      dto.token,
      dto.password,
      dto.firstName,
      dto.lastName,
      getRequestMetadata(req),
    );
  }
```

- [ ] **Step 9: Run the unit test to verify it passes**

Run: `npx jest src/auth/admin/admin-auth.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 10: Update the e2e test**

Read `test/admin-invite.e2e-spec.ts` in full first — Task 2 already extended this file, so read its current state, not the plan's Task 2 snippets from memory. Replace the made-up-token test's body:

```typescript
      .send({ token: 'not-a-real-token', password: 'invited-password', fullName: 'Invited Admin' })
```

with:

```typescript
      .send({ token: 'not-a-real-token', password: 'invited-password', firstName: 'Invited', lastName: 'Admin' })
```

This test needs the real invite token, which is never persisted in plaintext (only its hash is stored) — so it must be captured from the outgoing email the same way `test/agent-password-self-service.e2e-spec.ts` does, by overriding `EMAIL_PROVIDERS` to capture the sent message instead of actually sending it. Read that file's imports and `beforeAll` first to copy its exact pattern, then apply it here.

Add these imports at the top of `test/admin-invite.e2e-spec.ts`:

```typescript
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';
```

Add a module-level capture variable alongside the file's other `let` declarations:

```typescript
  let capturedEmail: EmailMessage | undefined;
```

In `beforeAll`, replace:

```typescript
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
```

with:

```typescript
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_PROVIDERS)
      .useValue([
        {
          name: 'test-capture',
          send: async (message: EmailMessage) => {
            capturedEmail = message;
          },
        },
      ])
      .compile();
```

Add a new test at the end of the file (after Task 2's delete-invite tests), covering the real accept-invite flow end to end. The invite email's text is `` `You have been invited. Use this token to accept: ${token}` `` (from `AdminInviteController.create`, unchanged by this plan), so the token is captured with a regex matching `accept: ` followed by the token:

```typescript
  it('accepts an invite with firstName/lastName and derives fullName', async () => {
    const acceptEmail = `accept-invite-${Date.now()}@example.com`;

    await request(app.getHttpServer())
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .send({ email: acceptEmail, roleId: superAdminRoleId })
      .expect(201);

    const capturedToken = capturedEmail?.text?.match(/accept: (\S+)/)?.[1];
    expect(capturedToken).toBeTruthy();

    const acceptRes = await request(app.getHttpServer())
      .post('/auth/admin/accept-invite')
      .send({ token: capturedToken, password: 'Accepted-Password-123!', firstName: 'Jane', lastName: 'Doe' })
      .expect(200);
    expect(acceptRes.body.accessToken).toEqual(expect.any(String));

    const created = await prisma.adminUser.findUniqueOrThrow({ where: { email: acceptEmail } });
    expect(created.firstName).toBe('Jane');
    expect(created.lastName).toBe('Doe');
    expect(created.fullName).toBe('Jane Doe');

    await prisma.adminUser.deleteMany({ where: { email: acceptEmail } });
  });
```

- [ ] **Step 11: Run the e2e test**

Run: `npx jest --config ./test/jest-e2e.json test/admin-invite.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 12: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 13: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/auth/admin/dto/accept-invite.dto.ts src/auth/admin/admin-auth.service.ts src/auth/admin/admin-auth.controller.ts src/auth/admin/admin-auth.service.spec.ts test/admin-invite.e2e-spec.ts
git commit -m "feat: collect first/last name at admin invite-accept time"
```

---

### Task 4: Rename deactivate/reactivate to suspend/unsuspend

**Files:**
- Modify: `src/admin-rbac/admin-role-assignment.service.ts`
- Modify: `src/admin-rbac/admin-role-assignment.controller.ts`
- Modify: `src/admin-rbac/admin-role-assignment.service.spec.ts`
- Modify: `test/admin-role-assignment.e2e-spec.ts`

**Interfaces:**
- Produces: `AdminRoleAssignmentService.suspend(callerId, id)` (was `deactivate`), `.unsuspend(id)` (was `reactivate`).

- [ ] **Step 1: Update the failing unit tests**

Read `src/admin-rbac/admin-role-assignment.service.spec.ts` in full first. Rename the `describe('deactivate', ...)` block to `describe('suspend', ...)`, replacing every `service.deactivate(...)` call with `service.suspend(...)`, and the `'admin_deactivated'` string assertion with `'admin_suspended'`:

```typescript
  describe('suspend', () => {
    it('throws NotFoundException when the admin does not exist', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.suspend('caller-1', 'missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when suspending your own account', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'caller-1', isActive: true });
      await expect(service.suspend('caller-1', 'caller-1')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when the admin is already suspended', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: false });
      await expect(service.suspend('caller-1', 'admin-2')).rejects.toThrow(ConflictException);
    });

    it('suspends the admin and revokes their sessions', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: true });
      prisma.adminUser.update.mockResolvedValue({ id: 'admin-2', isActive: false });

      await service.suspend('caller-1', 'admin-2');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-2' },
        data: { isActive: false },
      });
      expect(sessionService.revokeAllForPrincipal).toHaveBeenCalledWith('ADMIN', 'admin-2', 'admin_suspended');
    });
  });
```

Rename the `describe('reactivate', ...)` block to `describe('unsuspend', ...)`, replacing every `service.reactivate(...)` call with `service.unsuspend(...)`:

```typescript
  describe('unsuspend', () => {
    it('throws NotFoundException when the admin does not exist', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.unsuspend('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the admin is already active', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: true });
      await expect(service.unsuspend('admin-2')).rejects.toThrow(ConflictException);
    });

    it('unsuspends the admin without touching sessions', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: false });
      prisma.adminUser.update.mockResolvedValue({ id: 'admin-2', isActive: true });

      await service.unsuspend('admin-2');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-2' },
        data: { isActive: true },
      });
      expect(sessionService.revokeAllForPrincipal).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/admin-rbac/admin-role-assignment.service.spec.ts`
Expected: FAIL — `suspend`/`unsuspend` don't exist yet.

- [ ] **Step 3: Rename the service methods**

In `src/admin-rbac/admin-role-assignment.service.ts`, replace:

```typescript
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
```

with:

```typescript
  async suspend(callerId: string, id: string): Promise<void> {
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
    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.ADMIN, id, 'admin_suspended');
  }

  async unsuspend(id: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    if (admin.isActive) {
      throw new ConflictException('Admin is already active');
    }

    await this.prisma.adminUser.update({ where: { id }, data: { isActive: true } });
  }
```

(The `ConflictException` message text — `'Cannot deactivate your own account'`/`'Admin is already deactivated'` — is left as-is; the spec only asked to rename the action verbs/routes/audit strings, not rewrite every user-facing message string. This is a deliberate scope decision, not an oversight.)

- [ ] **Step 4: Rename the controller routes**

In `src/admin-rbac/admin-role-assignment.controller.ts`, replace:

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

with:

```typescript
  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async suspend(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminRoleAssignmentService.suspend(req.user.sub, id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.suspended',
      targetType: 'AdminUser',
      targetId: id,
    });
    return { suspended: true };
  }

  @Post(':id/unsuspend')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async unsuspend(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminRoleAssignmentService.unsuspend(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.unsuspended',
      targetType: 'AdminUser',
      targetId: id,
    });
    return { unsuspended: true };
  }
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx jest src/admin-rbac/admin-role-assignment.service.spec.ts`
Expected: PASS — full file.

- [ ] **Step 6: Update the e2e test**

Read `test/admin-role-assignment.e2e-spec.ts` in full first. Replace every occurrence of `/deactivate` with `/suspend`, `/reactivate` with `/unsuspend`, `{ deactivated: true }` with `{ suspended: true }`, `{ reactivated: true }` with `{ unsuspended: true }`, in each of these four tests: `'rejects an admin deactivating their own account (409)'`, `'deactivates a different admin and revokes their sessions'`, `'rejects deactivating an already-deactivated admin (409)'`, `'reactivates the admin'` (renaming each test's own description to match, e.g. `'rejects an admin suspending their own account (409)'`).

- [ ] **Step 7: Run the e2e test**

Run: `npx jest --config ./test/jest-e2e.json test/admin-role-assignment.e2e-spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 8: Run `tsc` to confirm no type errors**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/admin-rbac/admin-role-assignment.service.ts src/admin-rbac/admin-role-assignment.controller.ts src/admin-rbac/admin-role-assignment.service.spec.ts test/admin-role-assignment.e2e-spec.ts
git commit -m "feat: rename admin deactivate/reactivate to suspend/unsuspend"
```

---

### Task 5: README, Postman, and the full test suite

**Files:**
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`

**Interfaces:**
- Consumes: everything from Tasks 1-4.

- [ ] **Step 1: Update the README**

Document: the new `POST /admin/roles/:id/permissions/bulk` endpoint; that `POST /admin/invites` and `POST /admin/invites/:id/resend` responses now include a trimmed `role: { id, name }`, and `GET /admin/invites` rows include the full `role` object; the new `DELETE /admin/invites/:id` endpoint (PENDING-only); that `POST /auth/admin/accept-invite` now takes `firstName`/`lastName` instead of `fullName` (with `fullName` derived and stored); and the renamed `POST /admin/admins/:id/suspend` / `.../unsuspend` endpoints (was deactivate/reactivate).

- [ ] **Step 2: Update Postman**

Per this repo's `CLAUDE.md`:
- `Admin > Roles`: add `POST /admin/roles/:id/permissions/bulk` (success + 404-missing-permission scenarios).
- `Admin > Invites`: update the accept-invite request body to `firstName`/`lastName`; update create/resend/list saved response examples to show the hydrated `role` field; add `DELETE /admin/invites/:id` (success + not-pending-404 scenarios).
- `Admin > Admins`: rename the deactivate/reactivate requests to suspend/unsuspend, updating routes and saved response bodies (`{ suspended: true }`/`{ unsuspended: true }`).
- Trace every `pm.test` script across these three folders for anything reading the old shapes (bare `fullName` field on accept-invite, un-hydrated invite responses, old deactivate/reactivate routes) — this has been a real, recurring finding in every closing task so far.
- Use surgical text-based/`Edit`-tool edits only, never a full-document rewrite. Verify with a byte-level em-dash/naira-sign check against `HEAD`.

- [ ] **Step 3: Validate the JSON**

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 4: Commit**

```bash
git add README.md postman/public-sector-backend.postman_collection.json
git commit -m "docs: document admin RBAC quality-of-life changes"
```

- [ ] **Step 5: Run the full test suite**

This plan is its own complete phase, and closes out the whole two-sub-project Admin RBAC initiative — run the true full suite.

Run: `npm run test`
Expected: PASS — every unit suite in the codebase.

Run: `npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every e2e suite in the codebase. If a single suite times out under the full serialized run, re-run it in isolation to confirm pre-existing environmental flakiness rather than a real regression (this codebase's full e2e run has hit this before, always benignly), and report that distinction clearly.

## Exit criteria

- [ ] `POST /admin/roles/:id/permissions/bulk` assigns multiple permissions in one call, all-or-nothing on validation.
- [ ] `AdminInvite` create/resend/list responses all include role information; `DELETE /admin/invites/:id` deletes a PENDING invite and rejects otherwise.
- [ ] Accepting an invite collects `firstName`/`lastName`, deriving `fullName`; existing admins are backfilled.
- [ ] `deactivate`/`reactivate` are fully renamed to `suspend`/`unsuspend` (methods, routes, response bodies, audit actions, session-revocation reason).
- [ ] README and Postman reflect every change in this plan.
- [ ] Full unit + e2e suite passes clean — this closes the entire Admin RBAC (Sub-projects A + B) initiative.
