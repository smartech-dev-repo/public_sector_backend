# Admin RBAC Quality-of-Life Improvements Design (Sub-project B)

## 1. Purpose

The second of two sub-projects extending the Admin RBAC domain (A: Department
entity + single-role restructure, already shipped; B: this spec). Five
small, mostly-additive items, all already scoped during the original
brainstorming round: bulk permission assignment, first/last name collection
at invite-accept time, invite responses hydrating their role,
suspend/unsuspend renaming, and invite deletion.

## 2. Bulk permission assignment

New `RoleService.assignPermissions(roleId: string, permissionIds: string[]): Promise<void>`,
alongside the existing single-permission `assignPermission` (unchanged).
Validates every ID exists **before** writing any — all-or-nothing, no
partial-success state:

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

New `AssignPermissionsBulkDto` (`permissionIds: string[]`, each `@IsUUID()`,
array non-empty). New route `POST /admin/roles/:id/permissions/bulk`
(same `roles:manage` permission, same audit-logging pattern as the
existing single-assign route — `action: 'role.permissions.bulk_assigned'`,
`metadata: { permissionIds }`).

## 3. Accept-invite collects first/last name

`AdminUser` gains `firstName String`, `lastName String` (both required).
`fullName` stays a column but becomes derived at write time, never
independently settable:

```prisma
model AdminUser {
  id           String          @id @default(uuid())
  email        String          @unique
  passwordHash String
  firstName    String
  lastName     String
  fullName     String
  # ...unchanged fields below...
}
```

`AcceptInviteDto` drops `fullName`, adds `firstName`/`lastName` (both
`@IsString() @MinLength(1)`). `AdminAuthService.acceptInvite`'s signature
changes from `(token, password, fullName, meta?)` to
`(token, password, firstName, lastName, meta?)`, and its `adminUser.create`
call sets `firstName`, `lastName`, and `fullName: \`${firstName} ${lastName}\`.trim()`
together.

**Backfill for existing admins** (everyone created before this change,
including the bootstrap admin): a one-time migration script splits each
existing `fullName` on the first space — everything before the first
space becomes `firstName`, everything after becomes `lastName` (or, for a
single-word `fullName` with no space, `firstName` gets the whole string
and `lastName` becomes an empty string). This is an imperfect heuristic
for compound first names, single-name accounts, etc. — same spirit as
Sub-project A's role-collapse backfill: a one-time, reviewable step
(the script logs every admin it touched), not an ongoing policy. Same
two-phase migration shape as Sub-project A required (nullable columns →
backfill → `NOT NULL`), since these columns must end up required on a
non-empty table.

## 4. AdminInvite responses hydrate the role relation

`AdminInviteService.create`/`resend`/`list` all add `include: { role: true }`
to their Prisma calls. Controller response shapes:

- `create`/`resend`: grow from `{ id, email, status, expiresAt }` to
  `{ id, email, status, expiresAt, role: { id: invite.role.id, name: invite.role.name } }`
  — trimmed to `id`/`name` only, not the full `Role` object (an invite
  response doesn't need permissions/department attached).
- `list`: the paginated rows already return whatever `AdminInviteService.list`
  hands back; with `include: { role: true }` added, each row's `role`
  field becomes the full nested `Role` object (matching how `AdminUser.role`
  is already returned by `GET /admin/admins` — no trimming needed here,
  since this is a list an admin is actively reviewing, not a per-invite
  confirmation response).

## 5. Suspend/unsuspend renaming

Pure rename, same `isActive` boolean underneath, same guards:

- `AdminRoleAssignmentService.deactivate` → `suspend`; `reactivate` → `unsuspend`. Bodies unchanged (self-suspension guard, "already suspended"/"already active" guards, forced session revocation on suspend only — all identical logic, just renamed).
- `AdminRoleAssignmentController`: `POST :id/deactivate` → `POST :id/suspend`; `POST :id/reactivate` → `POST :id/unsuspend`. Response literals `{ deactivated: true }` → `{ suspended: true }`; `{ reactivated: true }` → `{ unsuspended: true }`.
- Audit action strings: `admin.deactivated` → `admin.suspended`; `admin.reactivated` → `admin.unsuspended`.
- Session-revocation reason string (`SessionService.revokeAllForPrincipal`'s third argument, currently `'admin_deactivated'`) → `'admin_suspended'`.

## 6. Invite deletion

New `AdminInviteService.remove(id: string): Promise<void>`:

```typescript
async remove(id: string): Promise<void> {
  const invite = await this.prisma.adminInvite.findUnique({ where: { id } });
  if (!invite || invite.status !== AdminInviteStatus.PENDING) {
    throw new NotFoundException('Invite not found or not pending');
  }
  await this.prisma.adminInvite.delete({ where: { id } });
}
```

(Deliberately reuses `resend()`'s exact guard shape and message —
`NotFoundException`, not `ConflictException` — for consistency within
this one service, even though `Role`/`AdminUser` guards elsewhere in this
domain use `ConflictException` for "wrong state" violations. Matching
the sibling method in the same file beats matching a different service's
convention.) New route `DELETE /admin/invites/:id` (`admins:create`
permission, same as `create`/`resend` — no new permission needed),
audit-logged as `admin.invite.deleted`, hard-deletes the row.

## 7. Testing

- Unit: `RoleService.assignPermissions` — rejects with the full list of
  missing IDs when any permission doesn't exist, writes none of them in
  that case; upserts all given IDs when every one is valid.
- Unit: `AdminAuthService.acceptInvite` — sets `firstName`/`lastName`/
  derived `fullName` correctly, including the single-space-trim edge case.
- Unit: `AdminInviteService.create`/`resend`/`list` — each includes the
  role relation; controller-level tests confirm the trimmed `{id,name}`
  shape on create/resend.
- Unit: `AdminRoleAssignmentService.suspend`/`unsuspend` — same test
  bodies as the former `deactivate`/`reactivate` tests, renamed.
- Unit: `AdminInviteService.remove` — 404 for unknown id, 404 for a
  non-PENDING invite (ACCEPTED/REVOKED), deletes a PENDING invite.
- e2e: bulk-assign 3 permissions to a role in one call, confirm all 3
  present; accept an invite with `firstName`/`lastName`, confirm the
  resulting admin's `fullName` and `GET /admin/admins` entry are correct;
  create an invite, confirm its `role` object is present in the create
  response and in a subsequent list call; suspend then unsuspend an
  admin via the renamed routes; create and delete a PENDING invite,
  confirm deleting an already-accepted invite is rejected.

## 8. Postman

Per this repo's `CLAUDE.md`: add `POST /admin/roles/:id/permissions/bulk`
(success + validation-error + missing-permission-404 scenarios) to
`Admin > Roles`; update `Admin > Invites`'s accept-invite request to use
`firstName`/`lastName`, and update its create/resend/list saved examples
to show the hydrated `role` field; add `DELETE /admin/invites/:id`
(success + not-pending-404 scenarios); rename the `Admin > Admins`
deactivate/reactivate requests to suspend/unsuspend, updating their
routes and saved response bodies.
