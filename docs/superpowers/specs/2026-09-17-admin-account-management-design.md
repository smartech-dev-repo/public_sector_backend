# Admin Account Management (Activate/Deactivate) — Design

**Date:** 2026-09-17
**Status:** Approved for planning

## 1. Purpose and scope

`AdminUser.isActive` has existed since Phase 1 and is checked at login (`admin-auth.service.ts:47`), but nothing in the system ever sets it to `false` — there is no way to deactivate an admin account. `GET /admin/admins` (listing) already exists (`AdminRoleAssignmentService.listAdmins`, shipped during the RBAC work); this closes the one remaining gap: the action itself.

**In scope:**
- `POST /admin/admins/:id/deactivate` and `POST /admin/admins/:id/reactivate`, added to the existing `AdminRoleAssignmentController` (`admin/admins`) and `AdminRoleAssignmentService` — this controller already owns the "admin accounts" surface (list + role assignment), so this is an extension of it, not a new module.
- Deactivating flips `isActive = false` **and** force-revokes the admin's sessions via the existing `SessionService.revokeAllForPrincipal(ADMIN, id, 'admin_deactivated')` primitive (same one already used for the Agent/Client force-revoke endpoints in `admin-session.controller.ts`).
- An admin cannot deactivate their own account (`409`) — mirrors the existing "cannot remove the last SUPER_ADMIN's role" guard in `AdminRoleAssignmentService.removeRole`.
- Gated by `roles:manage`, the same permission every other route in this controller already requires.

**Explicitly out of scope / deferred:**
- Profile editing (fullName/email) — no concrete need identified; would be speculative scope.
- Closing the stateless-access-token gap (a deactivated admin's already-issued access token, ≤15 min TTL by default, keeps working until it naturally expires — only the refresh-token session is killed immediately). This is a pre-existing, system-wide tradeoff already accepted by the Agent/Client force-revoke endpoints; not something this feature introduces or is scoped to fix.

## 2. Endpoints

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /admin/admins/:id/deactivate` | `roles:manage` | `404` if `:id` doesn't resolve to an `AdminUser`. `409` if `id` is the caller's own admin id (self-deactivation blocked). `409` if already `isActive === false` (idempotency guard, matching the `clients:review` approve/retry 409 pattern). On success: `isActive = false`, `SessionService.revokeAllForPrincipal(ADMIN, id, 'admin_deactivated')`, audit log `admin.deactivated`. |
| `POST /admin/admins/:id/reactivate` | `roles:manage` | `404` if `:id` doesn't resolve. `409` if already `isActive === true`. On success: `isActive = true`, audit log `admin.reactivated`. No session action — a reactivated admin has no sessions to restore; they simply log in again. |

Both return `{ deactivated: true }` / `{ reactivated: true }` (`200`, matching the existing `assignRole`/`removeRole` response shape in the same controller).

## 3. Error handling

- `:id` doesn't resolve to an `AdminUser` → `404`.
- `id === req.user.sub` on deactivate → `409` ("Cannot deactivate your own account").
- Deactivate on an already-inactive admin → `409` ("Admin is already deactivated").
- Reactivate on an already-active admin → `409` ("Admin is already active").
- No new validation-body DTOs needed — both endpoints take no body.

## 4. Testing strategy

Extend the existing `admin-role-assignment.service.spec.ts` (mocked Prisma + mocked `SessionService`) with cases for: successful deactivate (flips `isActive`, calls `revokeAllForPrincipal` with the right args), successful reactivate, 404 on missing admin (both directions), 409 on self-deactivation, 409 on already-inactive/already-active.

Extend the existing e2e coverage for this controller (find its current e2e spec — likely `admin-role-assignment.e2e-spec.ts` or `admin-roles.e2e-spec.ts`, confirm exact filename at plan-writing time) with: deactivate a second admin, confirm `isActive: false` in a subsequent `GET /admin/admins`, confirm their existing refresh token is now rejected by `POST /auth/refresh` (proving `revokeAllForPrincipal` actually ran); reactivate them back; attempt self-deactivation and confirm `409`.
