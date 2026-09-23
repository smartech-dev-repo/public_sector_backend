# Admin Department & Single-Role Restructure Design (Sub-project A)

## 1. Purpose

The first of two sub-projects extending the Admin RBAC domain (A: Department
entity + single-role restructure, this spec; B: bulk permissions, invite
name split, invite role hydration, suspend/unsuspend rename, invite
delete — each sub-project gets its own spec/plan). Research confirmed two
real gaps this spec closes:

- **No Department concept exists anywhere in the codebase** (only an
  unrelated IPPIS payroll field shares the name).
- **`AdminUser`↔`Role` is genuinely many-to-many today** — `AdminUserRole`
  is a real join table, `assignRole` is an upsert that adds without
  replacing, and nothing prevents an admin holding 2+ roles
  simultaneously. This was never the intent; this spec constrains it to
  exactly one role per admin, which is also the natural foundation for
  department inheritance (a two-role admin would have no single
  "inherited" department without an arbitrary tie-break).

## 2. `Department` entity — full CRUD, mirroring `Role`/`Permission`

New model:

```prisma
model Department {
  id          String   @id @default(uuid())
  name        String   @unique
  description String?
  createdAt   DateTime @default(now())

  roles   Role[]
  admins  AdminUser[]
}
```

New module `src/admin-department/`:
- `DepartmentService` (`src/admin-department/department.service.ts`):
  `create({ name, description? })`, `list(filters?: { q?: string }, pagination?)`
  (paginated per this project's standing list-endpoint convention —
  `page`/`limit` default 1/25, `q` searches `name`), `findById(id)`,
  `update(id, { name?, description? })`, `remove(id)` — `remove` throws
  `ConflictException` if any `Role` still references this department
  (mirrors `RoleService.remove`'s assignment-count guard exactly:
  `prisma.role.count({ where: { departmentId: id } })`).
- `AdminDepartmentsController`
  (`src/admin-department/admin-departments.controller.ts`):
  `POST /admin/departments`, `GET /admin/departments`,
  `GET /admin/departments/:id`, `PATCH /admin/departments/:id`,
  `DELETE /admin/departments/:id` — all gated by one new permission,
  `departments:manage` (added to `prisma/seed.ts`'s
  `BOOTSTRAP_PERMISSIONS`, same single-permission-gates-everything
  pattern `RoleService`/`PermissionService` already use).
- `AdminDepartmentModule` registered in `src/app.module.ts` alongside the
  existing `AdminRbacModule`.

## 3. `Role` gains an optional, editable `departmentId`

```prisma
model Role {
  # ...existing fields...
  departmentId String?
  department   Department? @relation(fields: [departmentId], references: [id])
}
```

`RoleService.create`'s `CreateRoleParams` gains `departmentId?: string`.
`RoleService.update`'s `UpdateRoleParams` gains `departmentId?: string | null`
(`null` explicitly clears it; `undefined`/omitted leaves it unchanged —
same optional-field convention `class-validator`/Prisma already use
elsewhere in this codebase). No SUPER_ADMIN-style guard is needed here —
department is freely editable on any role, including SUPER_ADMIN.

## 4. `AdminUser` moves from many-to-many roles to exactly one required role

This is a real restructure, not an additive field. `AdminUserRole` (the
join table) is dropped entirely:

```prisma
model AdminUser {
  # ...existing fields...
  roleId       String
  role         Role        @relation(fields: [roleId], references: [id])
  departmentId String?
  department   Department? @relation(fields: [departmentId], references: [id])
  # `roles AdminUserRole[]` removed
}
```

`AdminUserRole` model is deleted from the schema. Every current reference
(confirmed via grep — exactly four non-generated files touch it) is
updated:

- **`AdminRoleAssignmentService`**: `assignRole(adminId, roleId)` and
  `removeRole(adminId, roleId)` (two separate methods today) collapse
  into one `setRole(adminId: string, roleId: string): Promise<void>`.
  It: loads the admin and the target role (404 if either missing),
  applies the SUPER_ADMIN "last holder" guard **only when the admin's
  *current* role is SUPER_ADMIN and the target role is not** (same
  protection as today's `removeRole`, adapted — today it guards on
  removing the SUPER_ADMIN row; now it guards on *changing away from*
  SUPER_ADMIN), then updates `AdminUser.roleId` **and**
  `AdminUser.departmentId` together (copying the new role's
  `departmentId` — this is the "inherit" mechanism, applied on every
  role change, not just at creation). The last-holder count becomes
  `prisma.adminUser.count({ where: { roleId: superAdminRoleId } })`
  instead of counting `AdminUserRole` rows.
- **`AdminRoleAssignmentController`**: `POST /admin/admins/:id/roles`
  (assign) and `DELETE /admin/admins/:id/roles/:roleId` (remove) — two
  routes today — collapse into one `PATCH /admin/admins/:id/role`,
  reusing the existing `AssignRoleDto` (`{ roleId }`, already exactly
  this shape) unchanged, calling `setRole`.
- **`RoleService.remove`**: its assignment-count guard
  (`prisma.adminUserRole.count({ where: { roleId: id } })`) becomes
  `prisma.adminUser.count({ where: { roleId: id } })` — same guard,
  new table.
- **`AdminAuthService.getPermissionsForAdmin`**: simplifies from
  `admin.roles.flatMap((adminRole) => adminRole.role.permissions...)`
  (union across possibly-multiple roles) to reading
  `admin.role.permissions.map((rp) => rp.permission.key)` directly off
  the single relation — no more `Set`-based de-duplication needed either,
  since one role's permission list has no cross-role overlap to dedupe.
- **`AdminAuthService.acceptInvite`**: instead of
  `roles: { create: { roleId: invite.roleId } }` (creating a join-table
  row), the `adminUser.create` call sets `roleId: invite.roleId` and
  `departmentId` directly — looked up from the invite's role
  (`prisma.role.findUniqueOrThrow({ where: { id: invite.roleId } })`,
  read once before the create so both fields can be set in the same
  `adminUser.create` call).
- **`prisma/seed.ts`**: the bootstrap admin's creation changes from
  "create admin, then separately upsert an `AdminUserRole` row" to
  setting `roleId: superAdminRole.id` (and `departmentId: null`, since
  the seeded SUPER_ADMIN role has no department by default) directly in
  the single `adminUser.upsert({ create: {...} })` call.
- **`AdminRoleAssignmentService.listAdmins`**: `select`'s
  `roles: { include: { role: true } }` becomes `role: true,
  department: true` — both now come back as direct nested objects on
  each admin record instead of via an array of join rows.

## 5. Migration mechanics

Prisma's own migration can add the new `roleId`/`departmentId` columns,
but populating `roleId` (which must end up `NOT NULL`) from the existing
many-to-many `AdminUserRole` data needs a one-time data-migration step
run as part of the same deploy, before the column is made required:

1. Add `roleId`/`departmentId` as **nullable** columns first (a schema
   migration).
2. Run a one-off script (`prisma/migrations/<timestamp>_.../migration.sql`
   companion, or a small TS script run via `ts-node`, whichever this
   codebase's existing migration conventions favor — checked: no prior
   precedent for a *data*-migration script exists in this codebase's
   `prisma/migrations/`, only schema DDL, so this will be a new pattern,
   kept as simple raw SQL inside the migration file itself) that, for
   every `AdminUser`, sets `roleId` to the **lowest `roleId`** among that
   admin's current `AdminUserRole` rows (deterministic but arbitrary —
   `AdminUserRole` has no timestamp column, so "most recent" can't be
   determined; this is a one-time, reviewable step, not an ongoing
   policy) and `departmentId` to that chosen role's `departmentId`
   (`NULL` at this point, since Department doesn't exist until this same
   migration creates it — so every admin's `departmentId` starts `NULL`
   regardless, and only becomes non-null once someone assigns a
   department to a role and re-runs `setRole` on affected admins, or via
   the one-time backfill in step 4).
3. Alter `roleId` to `NOT NULL` (a second schema migration, after data is
   populated — Prisma requires this two-step shape for adding a required
   column to a non-empty table).
4. Drop the `AdminUserRole` table.

**Reviewable output**: the data-migration step logs (via `RAISE NOTICE`
in the SQL, or equivalent) which admins had more than one role before
the collapse, so this can be spot-checked after deploying — flagged
explicitly per your own framing of this as the one genuinely risky step.

## 6. Testing

- Unit: `DepartmentService` — full CRUD, `remove` blocked while a `Role`
  references it, `list` pagination/search (matching this project's
  standing list-endpoint test conventions).
- Unit: `RoleService.create`/`update` — `departmentId` set/cleared
  correctly.
- Unit: `AdminRoleAssignmentService.setRole` — 404s for unknown
  admin/role, SUPER_ADMIN last-holder guard (moving away from
  SUPER_ADMIN when admin is the last holder rejected; allowed when
  others still hold it; no guard at all when admin's current role isn't
  SUPER_ADMIN), `departmentId` copied from the new role on every call
  (including copying `null` when the new role has no department).
- Unit: `RoleService.remove`'s guard now counts `AdminUser` rows, not
  `AdminUserRole` rows.
- Unit: `AdminAuthService.getPermissionsForAdmin` — reads the single
  `role.permissions` relation directly.
- Unit: `AdminAuthService.acceptInvite` — sets both `roleId` and
  `departmentId` from the invite's role in one `adminUser.create` call.
- Unit: `AdminRoleAssignmentService.listAdmins` — returned rows include
  `role` and `department` as direct nested objects.
- e2e: create a Department, create/update a Role with that department,
  accept an invite for that role, confirm the resulting admin's
  `GET /admin/admins` entry shows both the role and the inherited
  department; `PATCH /admin/admins/:id/role` to a different-department
  role updates the admin's department; attempting to move the sole
  SUPER_ADMIN holder to another role is rejected; attempting to delete a
  Department still referenced by a Role is rejected.

## 7. Postman

Per this repo's `CLAUDE.md`: new `Admin > Departments` folder (success +
validation-error + not-found scenarios for all five endpoints, matching
the `Admin > Roles`/`Admin > Permissions` folders' existing structure).
Update `Admin > Admins` folder: remove/replace the old assign-role and
remove-role requests with the new `PATCH /admin/admins/:id/role`
(success, 404, and "last SUPER_ADMIN holder" 409 scenarios), and update
`GET /admin/admins`'s saved examples to show `role`/`department` as
direct nested objects instead of a `roles` array.
