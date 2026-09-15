# Back-Office Governance Bundle — Design

**Date:** 2026-09-15
**Status:** Approved for planning
**Depends on:** Phase 1 Foundation (`docs/superpowers/plans/2026-09-09-phase-1-foundation.md`) — `AdminUser`/`Role`/`Permission`/`RolePermission`/`AdminUserRole`, `PrismaService`, `TokenService`, `JwtAuthGuard`, `PermissionsGuard`, `OtpService`'s multi-provider-with-failover pattern.

## 1. Purpose and scope

This bundles four of the six requirements raised against the IPPIS/Repayment/Disbursed-Loans documents review: RBAC extension, admin invites, audit logging, and session management ("Agent and user rails, session and all"). The document ingestion/reconciliation engine (the other two requirements) is a separate design, deferred — it depends on real per-MDA column mapping decisions that are out of scope here.

**In scope:**
- Admin invite → accept → active lifecycle (no self-registration for admins, per the original spec)
- DB-tracked, revocable sessions (refresh tokens) for Admin, Agent, and Client
- Audit log: automatic baseline coverage + explicit rich events
- New permission keys for the above; reuse of Phase 1's existing `PermissionsGuard`

**Explicitly out of scope** (confirmed with the user):
- RBAC/permissions for Agent or Client actions — those stay ownership-scoped (a client only ever touches their own records), not permission-based. Only Admin routes use `PermissionsGuard`.
- Access-token revocation/blocklisting — access tokens are short-lived (15m, per Phase 1) and are left to expire naturally. Force-logout (session revocation) blocks the *next* refresh, not the currently-live access token. This bounds the design to refresh-token state only, avoiding a DB lookup on every authenticated request.
- The document ingestion engine (separate design).

## 2. Architecture decisions

### 2.1 Refresh tokens become opaque, DB-tracked, rotating tokens

Phase 1's `TokenService.signRefreshToken()` produces a signed JWT with the same shape as the access token, just longer-lived. That can't be individually revoked before it expires — there's no server-side state to delete. Since this design requires "list my sessions," "log out this device," "log out everywhere," and "admin force-revoke," refresh tokens must have server-side state.

**Change:** replace `TokenService.signRefreshToken()` with a `SessionService` that:
- generates a high-entropy random token (32 bytes, base64url) — this *is* the refresh token returned to the client
- stores **SHA-256** of that token (not bcrypt) as `Session.refreshTokenHash`, since exact-match DB lookup by hash requires deterministic hashing — bcrypt salts each hash differently on every call, so it can't be used for a `WHERE refreshTokenHash = ?` lookup. Bcrypt is for low-entropy secrets (passwords) where slow hashing resists brute force; a 32-byte random token is already brute-force-resistant, so SHA-256 (fast, deterministic, indexable) is the correct tool here. The same reasoning applies to `AdminInvite.tokenHash`.
- on every refresh, **rotates**: the presented session is revoked (`revokedReason: 'rotated'`) and a new one is created. The client always gets a brand-new refresh token from `/auth/{role}/refresh`.
- on **reuse of an already-revoked token**, treats it as theft: revokes every active session for that principal and returns 401. (A legitimate client never presents a token twice — it always uses the newest one it received.)

Access tokens are unchanged: still signed JWTs from `TokenService.signAccessToken()`, 15m TTL, carrying `permissions` for admins.

### 2.2 Admin invite: no `AdminUser` row until accepted

An `AdminInvite` row (email, role, hashed token, inviter, expiry, status) is the only artifact created on invite. `AdminUser` is created — along with its `AdminUserRole` — only when the invite is accepted with a password. This keeps "AdminUser" meaning "an account that can actually log in" with no half-provisioned rows to reason about.

### 2.3 Audit log: hybrid automatic + explicit

A generic `AuditInterceptor` applies to every route protected by `JwtAuthGuard` + `PermissionsGuard` (i.e. every admin route) and, for mutating HTTP methods (POST/PATCH/PUT/DELETE), writes a baseline `AuditLog` row: actor, route, method, outcome (status code), timestamp. This is the safety net — nothing admin-side ships without at least a shallow trail.

Where an action has real business meaning, the handling service also calls `AuditLogService.record()` directly with a specific `action` string and structured `metadata` (e.g. before/after values). Both the interceptor's row and the explicit row are written — the interceptor doesn't know about explicit calls and vice versa, so a single logical action can produce one shallow + one rich row. That's an intentional, acceptable redundancy: the shallow row guarantees coverage, the rich row gives the actual story.

### 2.4 Email provider mirrors the OTP provider pattern

`EmailProvider { name, send({ to, subject, html, text? }): Promise<void> }`, an `EMAIL_PROVIDERS` DI token resolving to an ordered array, and an `EmailService` that tries each in order with the same failover logic already built and tested for `OtpService`. Only a `ConsoleEmailProvider` (logs the email instead of sending it) is wired in for now, consistent with every other external integration in this project so far.

## 3. Data model additions

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
  revokedReason     String?

  @@index([principalType, principalId])
}

enum AdminInviteStatus {
  PENDING
  ACCEPTED
  EXPIRED
  REVOKED
}

model AdminInvite {
  id            String            @id @default(uuid())
  email         String
  roleId        String
  role          Role              @relation(fields: [roleId], references: [id])
  tokenHash     String            @unique
  invitedById   String
  invitedBy     AdminUser         @relation(fields: [invitedById], references: [id])
  status        AdminInviteStatus @default(PENDING)
  expiresAt     DateTime
  createdAt     DateTime          @default(now())
  acceptedAt    DateTime?

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

`Role` gains a back-relation (`invites AdminInvite[]`) and `AdminUser` gains one too (`sentInvites AdminInvite[]`) — standard Prisma relation wiring, not called out further here.

Note the deliberate naming: `SessionPrincipalType` (Prisma enum, `ADMIN`/`AGENT`/`CLIENT`) is distinct from the existing hand-written TS type `PrincipalType` in `src/auth/jwt-payload.interface.ts` (`'admin' | 'agent' | 'client'`, lowercase, used in JWT payloads). They represent the same concept at two different layers; a small mapping (`payload.type.toUpperCase() as SessionPrincipalType`) bridges them where a session is created from a JWT payload. Don't try to unify them — the JWT payload shape is a public contract (already shipped, tested, and out of scope to change) and the Prisma enum follows this project's existing DB-enum convention (`AgentStatus`, `ClientStatus`, `OtpPurpose` are all upper-snake-case).

## 4. Admin invite flow

1. `POST /admin/invites { email, roleId }` — requires `admins:create` (already seeded in Phase 1). Creates `AdminInvite` (status `PENDING`, token hashed, 7-day expiry — matches no existing precedent so this is a new, explicit default), sends the invite email via `EmailService`, writes an explicit audit event `admin.invite.created`.
2. `POST /admin/invites/:id/resend` — requires `admins:create`. Reissues a new token (old one invalidated) and expiry, resends the email. Audit event `admin.invite.resent`.
3. `GET /admin/invites` — requires `admins:create`. Lists invites (filterable by status) for the back office to track outstanding invitations.
4. `POST /auth/admin/accept-invite { token, password }` — public. Looks up `AdminInvite` by `sha256(token)`, checks `status === PENDING` and not expired, creates `AdminUser` + `AdminUserRole` (role from the invite), marks the invite `ACCEPTED`, and returns the same `{ accessToken, refreshToken }` shape as `/auth/admin/login` (a fresh `Session` is created here too — accepting an invite logs you in). Audit event `admin.invite.accepted`.
5. An expired-but-still-`PENDING` invite is treated as invalid at accept time (returns 401) rather than eagerly swept to `EXPIRED` by a background job — no scheduler infrastructure exists yet and isn't worth adding for this.

## 5. Session endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/refresh` | `{ refreshToken }` in body, no bearer token | Not role-namespaced — unlike login, refresh has no access token to read a role from; the opaque token is looked up directly in `Session`, which already carries `principalType`, so one generic endpoint covers all three roles. Validates, rotates (see §2.1), returns new `{ accessToken, refreshToken }`. Reused-token detection revokes all sessions for that principal and returns 401. |
| `POST /auth/logout` | `{ refreshToken }` in body | Revokes that one session (`revokedReason: 'logout'`). No rotation. |
| `POST /auth/logout-all` | Bearer access token | Revokes every active session for the authenticated principal (`revokedReason: 'logout_all'`). |
| `GET /auth/sessions` | Bearer access token | Lists the caller's own active (unrevoked, unexpired) sessions: id, userAgent, ip, createdAt, lastUsedAt, expiresAt. Never returns `refreshTokenHash`. |
| `DELETE /auth/sessions/:id` | Bearer access token | Revokes one of the caller's own sessions by id (404 if it belongs to someone else — not 403, to avoid confirming the id exists). |
| `POST /admin/agents/:id/sessions/revoke-all` | `agents:sessions:revoke` | Admin force-revokes all sessions for an agent. Audit event `agent.sessions.revoked`. |
| `POST /admin/clients/:id/sessions/revoke-all` | `clients:sessions:revoke` | Admin force-revokes all sessions for a client. Audit event `client.sessions.revoked`. |

`/auth/{admin|agent|client}/login` and `/auth/client/otp/verify` (Phase 1) change internally to create a `Session` row via `SessionService` instead of calling `tokenService.signRefreshToken()`, but their response shape is unchanged.

## 6. New permission keys

- `agents:sessions:revoke` — admin force-revoke of an agent's sessions
- `clients:sessions:revoke` — admin force-revoke of a client's sessions
- `audit:read` — view audit log entries (`GET /admin/audit-logs`, filterable by actor/action/target/date range)

`admins:create` (already seeded in Phase 1) is reused for every invite-management endpoint (create/resend/list) rather than introducing separate keys — one permission governs "can onboard admins," which avoids fragmenting a single capability into several keys with no independent use case yet.

## 7. Error handling

- Invite accept with an unknown/expired/already-accepted/revoked token → `401 Unauthorized`, generic "Invalid or expired invitation" (doesn't distinguish reasons, to avoid leaking invite state to an unauthenticated caller).
- Refresh with an unknown token → `401 Unauthorized`.
- Refresh with a *revoked* token (reuse) → `401 Unauthorized`, but server-side this triggers the full-revocation side effect and a `SYSTEM`-actor audit event `session.reuse_detected`.
- Self-service session revoke on a session that doesn't belong to the caller → `404 Not Found`.
- All new admin endpoints follow Phase 1's existing pattern: `JwtAuthGuard` + `PermissionsGuard` + `@RequirePermissions(...)`.

## 8. Testing strategy

Follows Phase 1's established pattern throughout: unit tests per service (mocked `PrismaService`) covering the branches above (valid/invalid/expired/reused tokens, permission-gated vs public routes), plus e2e tests per flow against the real seeded database — invite → accept → login, refresh → rotate → old-token-reuse-detected, logout-all actually blocks subsequent refresh, admin force-revoke blocks the target's refresh.

## 9. Deferred / explicitly not building now

- Rate limiting on `/auth/*/refresh` and invite-accept (real concern, but no rate-limiting infrastructure exists anywhere in the project yet — belongs in the Phase 5 hardening pass, not bolted on ad hoc here).
- A background sweep to mark stale `PENDING` invites `EXPIRED` — handled lazily at accept-time instead (§4.5).
- Real email vendor — mock `ConsoleEmailProvider` only, matching every other external integration so far.
- Device fingerprinting beyond raw `userAgent`/`ip` strings.
