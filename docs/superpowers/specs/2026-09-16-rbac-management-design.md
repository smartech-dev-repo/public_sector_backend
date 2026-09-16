# RBAC Management — Design

**Date:** 2026-09-16
**Status:** Approved for planning

## 1. Purpose

Phase 1 and the Governance Bundle built RBAC *enforcement* (`Role`,
`Permission`, `RolePermission`, `AdminUserRole` models; `PermissionsGuard`;
`@RequirePermissions(...)`) and a seed script that bootstraps a
`SUPER_ADMIN` role, but no API to actually manage roles or permissions —
they can currently only be created/changed by editing `prisma/seed.ts`.
This closes that gap.

No new Prisma models are needed — this is entirely new controllers/services
over the existing schema.

## 2. Decisions

- **Permissions are fully manageable via the API**, not fixed to code —
  confirmed with the user despite the known tradeoff: a permission key
  created this way has no effect until a developer adds a matching
  `@RequirePermissions('key')` check somewhere. A permission's `key` is
  immutable after creation (only `description` can change) — the key is a
  literal string matched against guard decorators, so renaming it would
  silently break whatever check it was satisfying.
- **`roles:manage`** (already seeded) covers all Role CRUD, role↔permission
  assignment, and admin↔role assignment. **`permissions:manage`** (new)
  covers Permission CRUD specifically — creating/deleting permission
  *definitions* is rarer and more sensitive than assigning existing ones.
- **Deletion safety**, applying "block if it would silently break someone's
  access" consistently:
  - Deleting a `Permission` is blocked (409) if any `Role` currently has it.
  - Deleting or renaming the `SUPER_ADMIN` role (by name) is blocked (409)
    — the seed script's idempotent `upsert` depends on that exact name.
  - Deleting any other `Role` is blocked (409) if any `AdminUser` currently
    holds it.
  - Removing a role from an admin is blocked (409) only in the one
    genuinely catastrophic case: it would leave **zero admins holding
    SUPER_ADMIN**. Otherwise allowed.
- Creating a `Permission` or `Role` with a `key`/`name` that already exists
  returns 409, not a raw DB constraint error.

## 3. Endpoints

| Method & path | Permission | Notes |
|---|---|---|
| `POST /admin/permissions` | `permissions:manage` | `{ key, description }` |
| `GET /admin/permissions` | `permissions:manage` | List all |
| `GET /admin/permissions/:id` | `permissions:manage` | |
| `PATCH /admin/permissions/:id` | `permissions:manage` | `{ description }` — `key` immutable |
| `DELETE /admin/permissions/:id` | `permissions:manage` | 409 if assigned to any role |
| `POST /admin/roles` | `roles:manage` | `{ name, description? }` |
| `GET /admin/roles` | `roles:manage` | List all, with permissions included |
| `GET /admin/roles/:id` | `roles:manage` | With permissions included |
| `PATCH /admin/roles/:id` | `roles:manage` | `{ name?, description? }` — 409 renaming SUPER_ADMIN |
| `DELETE /admin/roles/:id` | `roles:manage` | 409 if SUPER_ADMIN or assigned to any admin |
| `POST /admin/roles/:id/permissions` | `roles:manage` | `{ permissionId }` — idempotent (upsert) |
| `DELETE /admin/roles/:id/permissions/:permissionId` | `roles:manage` | |
| `GET /admin/admins` | `roles:manage` | List admins with their roles |
| `POST /admin/admins/:id/roles` | `roles:manage` | `{ roleId }` — idempotent (upsert) |
| `DELETE /admin/admins/:id/roles/:roleId` | `roles:manage` | 409 if it's the last SUPER_ADMIN holder |

## 4. Removing the Phase 1 stub

`GET /admin/roles/ping` (`src/admin/admin.controller.ts`) was always a
placeholder proving `PermissionsGuard` worked before real functionality
existed. It's removed as part of this work — its route (`/admin/roles/*`)
would otherwise collide with the new `AdminRolesController`, and it's now
fully superseded by real endpoints. `test/admin-rbac.e2e-spec.ts`'s
corresponding test is replaced with an equivalent check against a real
`roles:manage`-gated route (`GET /admin/roles`).

## 5. File structure

New top-level module `src/admin-rbac/`, matching the existing flat
per-feature module pattern (`admin-invite/`, `admin-audit-log/`,
`admin-session/`):

- `permission.service.ts` — Permission CRUD + in-use check
- `role.service.ts` — Role CRUD + SUPER_ADMIN guards + role↔permission assignment
- `admin-role-assignment.service.ts` — admin listing + admin↔role assignment + SUPER_ADMIN lockout guard
- `admin-permissions.controller.ts`, `admin-roles.controller.ts`,
  `admin-role-assignment.controller.ts`
- `dto/` — `create-permission.dto.ts`, `update-permission.dto.ts`,
  `create-role.dto.ts`, `update-role.dto.ts`, `assign-permission.dto.ts`,
  `assign-role.dto.ts`
- `admin-rbac.module.ts`

## 6. Testing

Same established pattern: unit tests per service (mocked `PrismaService`)
covering every branch in §2's safety rules, plus e2e tests proving the full
create→assign→delete-blocked→remove-assignment→delete-allowed lifecycle for
both Permissions and Roles, and the SUPER_ADMIN lockout protection.
