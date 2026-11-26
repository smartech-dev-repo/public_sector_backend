# Profile Endpoints Design

## 1. Purpose

Today there is no real "my profile" read for any principal type. `GET
/admin/me` exists but does no DB lookup at all — it just echoes the JWT
payload (`sub`, `type`, `permissions`). Agent and Client have no "get my own
info" endpoint whatsoever (the closest analogs are enrollment-status and
onboarding-status endpoints, which are workflow-shaped, not profile-shaped).
There is also no profile-image field or upload capability anywhere in the
codebase for any principal, and no "update my own basic info" endpoint
beyond the existing `PATCH client/onboarding/marital-status`.

This adds: a rebuilt, DB-backed `/admin/me` with resolved role/department,
profile-image upload/replace/delete, and a name-only self-update for Admin;
and new read-only `GET /agent/me` / `GET /client/me` endpoints for Agent and
Client, per your explicit scoping.

## 2. Schema

```prisma
model AdminUser {
  // ...existing fields...
  profileImageKey String?
}
```

Nullable, mirrors the `*Key` naming already used for `cvKey`
(`Agent`)/`liveSelfieKey` (`ClientOnboarding`) elsewhere in this schema.

## 3. Admin profile

### `GET /admin/me`

Rebuilt from a pure JWT-echo into a real `AdminUser` lookup by
`req.user.sub`, resolving `role` and `department`:

```typescript
async getProfile(adminId: string) {
  const admin = await this.prisma.adminUser.findUniqueOrThrow({
    where: { id: adminId },
    include: {
      role: { select: { id: true, name: true, description: true } },
      department: { select: { id: true, name: true, description: true } },
    },
  });
  const profileImageUrl = admin.profileImageKey
    ? await this.fileStorageProvider.getSignedDownloadUrl(admin.profileImageKey)
    : null;
  return {
    id: admin.id,
    email: admin.email,
    firstName: admin.firstName,
    lastName: admin.lastName,
    fullName: admin.fullName,
    isActive: admin.isActive,
    role: admin.role,
    department: admin.department,
    profileImageUrl,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
  };
}
```

The controller method merges this with the JWT's own `permissions` array
(sourced from `req.user.permissions`, exactly as today — not a breaking
change to that field) into the final response:

```typescript
@Get('me')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
async me(@Req() req: { user: JwtPayload }) {
  const profile = await this.adminService.getProfile(req.user.sub);
  return { ...profile, permissions: req.user.permissions };
}
```

### `PATCH /admin/me`

Body `{ firstName?, lastName? }` (at least one required). Recomputes
`fullName` from whichever of the two is present (falling back to the
existing stored value for the other):

```typescript
async updateProfile(adminId: string, input: { firstName?: string; lastName?: string }) {
  const current = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
  const firstName = input.firstName ?? current.firstName;
  const lastName = input.lastName ?? current.lastName;
  return this.prisma.adminUser.update({
    where: { id: adminId },
    data: { firstName, lastName, fullName: `${firstName} ${lastName}`.trim() },
  });
}
```

Email, `roleId`, and `departmentId` are untouched here — those already have
dedicated, permission-gated endpoints (`admin/admins/:id/role`, admin
invite/creation flow), and allowing self-service role/department changes
would be a privilege-escalation path.

### `POST /admin/me/profile-image` / `DELETE /admin/me/profile-image`

Single-image upload, mirroring the existing document-upload interceptor
pattern (`client-onboarding.controller.ts`) minus PDF support:

```typescript
@Post('me/profile-image')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@UseInterceptors(
  FileInterceptor('file', {
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
        callback(new BadRequestException('Only JPEG or PNG files are allowed'), false);
        return;
      }
      callback(null, true);
    },
  }),
)
async uploadProfileImage(@UploadedFile() file: Express.Multer.File, @Req() req: { user: JwtPayload }) {
  if (!file) throw new BadRequestException('file is required');
  return this.adminService.uploadProfileImage(req.user.sub, file);
}

@Delete('me/profile-image')
@HttpCode(200)
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
async deleteProfileImage(@Req() req: { user: JwtPayload }) {
  return this.adminService.deleteProfileImage(req.user.sub);
}
```

Service methods use the existing `FileStorageProvider` (`putObject` /
`deleteObject`), storage key pattern `admin-profile/<adminId>/profile-image<ext>`,
and overwrite/clear `AdminUser.profileImageKey`. Both return the refreshed
`getProfile()` result, so the response always matches `GET /admin/me`'s
shape.

**Fixing a found bug along the way**: `/admin/me` today is guarded by
`JwtAuthGuard, PermissionsGuard` with no `@RequirePermissions` set (so the
guard is a silent no-op there) — inconsistent with every other admin
self-service route (`change-password`, `2fa/*` in
`auth/admin/admin-auth.controller.ts`), which correctly use `AdminOnlyGuard`
instead. All four admin-profile routes in this feature switch to
`JwtAuthGuard, AdminOnlyGuard`, matching the rest of the codebase.

## 4. Agent profile (read-only)

New module `src/agent-profile/`. `GET /agent/me`, guarded by `JwtAuthGuard,
AgentOnlyGuard`:

```typescript
async getProfile(agentId: string) {
  const agent = await this.prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
  });
  return {
    id: agent.id,
    email: agent.email,
    phone: agent.phone,
    fullName: agent.fullName,
    address: agent.address,
    status: agent.status,
    canOnboardClients: agent.canOnboardClients,
    mustChangePassword: agent.mustChangePassword,
    hasLoggedIn: agent.hasLoggedIn,
    reviewedByAdmin: agent.reviewedByAdmin,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}
```

No image, no update, per your explicit scoping — just a read of their own
record.

## 5. Client profile (read-only)

New module `src/client-profile/` (can't extend the existing
`@Controller('client/onboarding')` controller since the route path differs).
`GET /client/me`, guarded by `JwtAuthGuard, ClientOnlyGuard`:

```typescript
async getProfile(clientId: string) {
  const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
  return {
    id: client.id,
    phone: client.phone,
    email: client.email,
    status: client.status,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}
```

Deliberately excludes onboarding-step detail — that stays on the existing
`GET /client/onboarding/status`, unchanged.

## 6. Guards and permissions

All seven routes (`GET`/`PATCH`/`POST`/`DELETE admin/me*`, `GET agent/me`,
`GET client/me`) use only the relevant `<Type>OnlyGuard` — no
`PermissionsGuard`, no new permission keys to seed. This matches every other
self-service route in the codebase (change-password, 2FA,
marital-status) — these are always-about-the-caller's-own-record endpoints,
not admin-managing-someone-else endpoints.

## 7. Audit logging

None of these seven routes get an explicit `AuditLogService.record()` call.
This matches the existing self-service precedent: `change-password` and the
`2fa/*` routes in `auth/admin/admin-auth.controller.ts` /
`auth/agent/agent-auth.controller.ts` aren't audit-logged either. Keeping
self-profile actions out of the audit trail is consistent, not a gap.

## 8. API surface

- `GET admin/me` — rebuilt, resolved role/department/profileImageUrl
- `PATCH admin/me` — firstName/lastName only
- `POST admin/me/profile-image` — upload/replace
- `DELETE admin/me/profile-image` — remove
- `GET agent/me` — new, read-only
- `GET client/me` — new, read-only

## 9. Testing

- Unit: `AdminService.getProfile` (resolves role/department, null
  `profileImageUrl` when unset, signed URL when set), `updateProfile`
  (partial firstName/lastName, recomputed fullName), `uploadProfileImage`
  (overwrites an existing key, calls `deleteObject` on the old key first if
  present), `deleteProfileImage` (clears the field, calls `deleteObject`,
  no-ops cleanly when no image was ever set).
- Unit: `AgentProfileService.getProfile`, `ClientProfileService.getProfile`
  — straightforward lookups.
- e2e: per principal, a full round-trip — admin: get (baseline) → patch name
  → get (confirms new name) → upload image → get (confirms
  `profileImageUrl` populated) → delete image → get (confirms null again);
  agent: get returns their own record, 401/403 without/with-wrong principal
  type; client: same shape of check.

## 10. Out of scope

- Agent/Client profile images or self-updates — explicitly admin-only per
  your request.
- Admin changing their own email, role, or department through this surface
  — those remain on their existing dedicated, permission-gated endpoints.
- Any audit-log trail for these seven routes (see §7).
- Validating/moderating uploaded profile images (e.g. content scanning) —
  same trust level as existing onboarding document uploads today.
