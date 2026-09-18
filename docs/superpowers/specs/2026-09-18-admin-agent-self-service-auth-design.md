# Admin & Agent Self-Service Auth (Forgot Password, Change Password, 2FA) — Design

**Date:** 2026-09-18
**Status:** Approved for planning

This is the first of three sub-projects from the latest feature request (Admin self-service auth, Agent self-service auth + profile picture, Client loan history enhancements). The other two are separate future specs.

## 1. Purpose and scope

Close the gap that Admin has **zero** self-service account security today (only `login` and the one-time `accept-invite`), and extend Agent (which already has a forced-`change-password` flow from the enrollment work) with the same forgot-password and 2FA capabilities.

**In scope, per your explicit decisions:**
- **Separate implementations for Admin and Agent** — not a shared/generic mechanism, even though the two are near-mirrors of each other. Each principal type keeps its own independent auth surface, matching how `login`/`change-password` already diverge per type today.
- **Admin**: `forgot-password` → `reset-password`, a new `change-password` (self-service, distinct from the one-time `accept-invite` password creation), and 2FA setup/login.
- **Agent**: `forgot-password` → `reset-password`, and 2FA setup/login (`change-password` already exists from the enrollment work — not rebuilt).
- **2FA — Admin**: chooses **one** method at setup time — TOTP (authenticator app) or email-based OTP — per your decision. Not both stacked, not TOTP-with-email-fallback.
- **2FA — Agent**: **email-OTP only, no method choice at all.** Per your follow-up: Agent's context is a mobile app, where a separate authenticator app is a worse fit than Admin's back-office context — so Agent doesn't get a TOTP option, and setup skips the "choose a method" step entirely since there's only one path. (You confirmed email over SMS specifically — not the existing `TwoWaySmsProvider` — so this reuses the same `EmailService` Admin uses, no new vendor wiring.)

**Explicitly out of scope / deferred:**
- Client — uses phone+OTP login, not password+2FA; not touched by this design.
- Encryption-at-rest for the TOTP secret or reset tokens beyond hashing (reset tokens are hashed the same way admin-invite tokens already are; the TOTP secret itself is stored as-is, matching this project's existing treatment of other sensitive-but-not-password fields — a real production hardening pass on field-level encryption is a separate, already-flagged open question from the original spec, not solved here).
- Backup/recovery codes for TOTP (if an admin/agent loses their authenticator app with no email-fallback by design, recovery is a manual admin action — e.g. another `roles:manage`-holding admin calling `2fa/disable` on their behalf isn't built either; flagging as a real gap, deferred).

## 2. The pattern (built twice, independently)

Since Admin and Agent get separate implementations, this section describes the pattern once; §4/§5 show it applied to each. Where Agent's flow differs (no method choice — email-OTP only), it's called out explicitly rather than assumed identical.

### Forgot password / reset password

Reuses the exact mechanism `AdminInvite` already established: `generateOpaqueToken()` (already used for admin invites), hashed via `hashToken()`, stored with a 1-hour expiry. `forgot-password` **always returns `200`** regardless of whether the email matches a real account — never leak account existence to an unauthenticated caller (same reasoning already applied to the loan-request SMS webhook). `reset-password` hashes the new password, clears the reset token fields, and force-revokes every existing session for that principal via the already-existing `SessionService.revokeAllForPrincipal` — a password reset (as opposed to a voluntary change-password) implies the old password may have been compromised, so old sessions shouldn't survive it.

### Change password (Admin only — Agent already has this)

Mirrors `AgentAuthService.changePassword` exactly: verify `currentPassword`, hash `newPassword`. Unlike a reset, a voluntary change-password does **not** force-revoke other sessions (matches Agent's existing behavior).

### 2FA setup

**Admin** (choice of method):
1. `POST /auth/admin/2fa/setup` body `{ method: 'totp' | 'email' }`:
   - `totp`: generates a new secret via `otplib`, stores it in a **pending** field (not yet active), returns `{ secret, otpauthUrl }` for the admin to add to their authenticator app.
   - `email`: generates a 6-digit code (matching the existing OTP convention), hashes+stores it with a 10-minute expiry in a pending field, emails it via the existing `EmailService`.
2. `POST /auth/admin/2fa/confirm` body `{ code }`: verifies the code against whichever pending method was set up; on success, promotes pending → active (`twoFactorEnabled = true`, `twoFactorMethod` set), clears pending fields. This confirmation step exists so a typo'd TOTP setup (secret added to the wrong account, misread QR code, etc.) never locks anyone out — 2FA only becomes active once a real code round-trips successfully.
3. `POST /auth/admin/2fa/disable` body `{ currentPassword }` — requires re-confirming the password (not just an active session) before turning off a security feature, so a hijacked-but-not-fully-compromised session can't silently disable it.

**Agent** (email-OTP only, no method choice):
1. `POST /auth/agent/2fa/setup` — **no body.** There's only one method, so setup skips straight to generating a 6-digit code, hashing+storing it with a 10-minute expiry, and emailing it — the same mechanics as Admin's `email` branch, just without a `method` field to choose first.
2. `POST /auth/agent/2fa/confirm` body `{ code }` — same as Admin's email path: verifies the code, sets `twoFactorEnabled = true`, clears the pending code fields.
3. `POST /auth/agent/2fa/disable` body `{ currentPassword }` — same as Admin.

### 2FA at login

When `twoFactorEnabled` is `false` (the default, and everyone's state until they opt in), login works exactly as it does today — **zero behavior change** for anyone who hasn't set up 2FA.

When `true`: after the password check succeeds, login does **not** issue real access/refresh tokens yet. Instead it:
- If the method is `email` (Admin's email choice, or Agent — always), generates and emails a fresh 6-digit code right then (reusing the same pending-code fields as setup).
- Issues a short-lived (5 minute), narrowly-scoped **two-factor pending token**, signed with a **separate secret** (`JWT_TWO_FACTOR_PENDING_SECRET`) — not `JWT_ACCESS_SECRET`. This is a deliberate security property: `JwtStrategy` only ever validates against `JWT_ACCESS_SECRET`, so this pending token is cryptographically incapable of being used as a real Bearer token on any guarded route, even by accident. It carries just `{ sub }`.
- Returns `{ twoFactorRequired: true, method, pendingToken }` — no `accessToken`/`refreshToken`. For Agent, `method` is always `"email"`.

`POST .../2fa/login-verify` body `{ pendingToken, code }` (public — the caller isn't authenticated yet, they only hold the pending token) verifies the pending token's signature/expiry, verifies `code` against the principal's active method (TOTP or the just-emailed code), and only then issues the real `accessToken`/`refreshToken` exactly as a normal login would.

## 3. Schema

One new enum (Admin only needs it — Agent has exactly one method, so nothing to enumerate), and two *different* field sets, reflecting that Agent's 2FA is genuinely simpler, not just a restricted version of Admin's:

```prisma
enum TwoFactorMethod {
  TOTP
  EMAIL
}
```

Added to `AdminUser` (needs the full set — method choice, TOTP secret, pending state for either path):

```prisma
  passwordResetTokenHash      String?
  passwordResetTokenExpiresAt DateTime?
  twoFactorMethod             TwoFactorMethod?
  twoFactorEnabled            Boolean          @default(false)
  twoFactorSecret             String?
  twoFactorPendingSecret      String?
  twoFactorPendingMethod      TwoFactorMethod?
  twoFactorEmailCodeHash      String?
  twoFactorEmailCodeExpiresAt DateTime?
```

Added to `Agent` (no method/secret fields at all — there's only ever the email-code path):

```prisma
  passwordResetTokenHash      String?
  passwordResetTokenExpiresAt DateTime?
  twoFactorEnabled            Boolean   @default(false)
  twoFactorEmailCodeHash      String?
  twoFactorEmailCodeExpiresAt DateTime?
```

`TokenService` gains two new methods (shared, since the pending-token *mechanism* is identical infrastructure even though the surrounding endpoints are separate per type):

```typescript
signTwoFactorPendingToken(sub: string): string;
verifyTwoFactorPendingToken(token: string): { sub: string };
```

New env var: `JWT_TWO_FACTOR_PENDING_SECRET` (required, distinct from `JWT_ACCESS_SECRET` — the whole point is that they're different keys).

## 4. Admin endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/admin/forgot-password` | Public | `{ email }` → always `200` |
| `POST /auth/admin/reset-password` | Public | `{ token, newPassword }` → `401` on invalid/expired token; revokes all sessions on success |
| `POST /auth/admin/change-password` | Admin JWT | `{ currentPassword, newPassword }` → `401` on wrong current password |
| `POST /auth/admin/2fa/setup` | Admin JWT | `{ method }` → `409` if 2FA already enabled (must `disable` first) |
| `POST /auth/admin/2fa/confirm` | Admin JWT | `{ code }` → `401` on wrong code, `409` if no pending setup |
| `POST /auth/admin/2fa/disable` | Admin JWT | `{ currentPassword }` → `401` on wrong password, `409` if 2FA isn't enabled |
| `POST /auth/admin/login` | Public (existing, modified) | Returns `{ twoFactorRequired: true, method, pendingToken }` instead of tokens when 2FA is enabled |
| `POST /auth/admin/2fa/login-verify` | Public | `{ pendingToken, code }` → issues real tokens; `401` on invalid/expired pending token or wrong code |

## 5. Agent endpoints

Same shape as Admin for forgot/reset-password (`change-password` already exists, not rebuilt), but 2FA is simplified per §2/§3 — no `method` choice anywhere:

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/agent/forgot-password` | Public | Same as Admin |
| `POST /auth/agent/reset-password` | Public | Same as Admin |
| `POST /auth/agent/2fa/setup` | Agent JWT | **No body** — always generates+emails a code. `409` if 2FA already enabled |
| `POST /auth/agent/2fa/confirm` | Agent JWT | `{ code }` → `401` on wrong code, `409` if no pending setup |
| `POST /auth/agent/2fa/disable` | Agent JWT | `{ currentPassword }` → `401` on wrong password, `409` if 2FA isn't enabled |
| `POST /auth/agent/login` | Public (existing, modified) | Returns `{ twoFactorRequired: true, method: 'email', pendingToken }` instead of tokens when 2FA is enabled. The existing `mustChangePassword` forced-change flow is orthogonal to this — a freshly-approved agent with `mustChangePassword: true` and 2FA *not yet set up* logs in normally (2FA only gates login once the agent has actually enabled it, which requires being logged in first) |
| `POST /auth/agent/2fa/login-verify` | Public | `{ pendingToken, code }` → issues real tokens; `401` on invalid/expired pending token or wrong code |

## 6. Error handling

- `forgot-password` never reveals whether the email exists — always `200`.
- `reset-password` with an invalid/expired/already-used token → `401` (token fields are cleared immediately on successful use, so replay is impossible).
- `2fa/setup` while already enabled → `409` (must `disable` first — prevents silently overwriting an active method without confirming the password).
- `2fa/confirm` with no pending setup in progress → `409`.
- `2fa/login-verify` with an expired (>5 min) or malformed pending token → `401`, forcing the user back to a fresh `login` call rather than any kind of retry-in-place.
- A wrong 2FA code at `login-verify` does **not** invalidate the pending token — the user can retry within the same 5-minute window (matches how a mistyped OTP works today for Client login).

## 7. Testing strategy

Unit tests per service method (mocked Prisma, mocked `EmailService`, mocked `SessionService`, mocked `TokenService`/`otplib` calls where deterministic values are needed): forgot-password's always-200 behavior and the actual token generation/email send, reset-password's token validation + session revocation, change-password's current-password check, each 2FA setup/confirm/disable transition and its guard conditions, and the login flow's branch into `twoFactorRequired` vs normal tokens. Unit tests for `TokenService`'s two new methods (signs/verifies against the distinct secret, rejects a token signed with the wrong secret).

e2e tests: for **Admin**, one full round-trip per 2FA method — register/create a user, enable TOTP 2FA (using `otplib` directly in the test to generate a real valid code, matching how the production authenticator app would), log in and confirm `twoFactorRequired`, complete `2fa/login-verify`, confirm real tokens issued; a second e2e test walks the email-method setup and login the same way, reading the emailed code the same way the agent-enrollment e2e test already reads a captured email via an `EMAIL_PROVIDERS` override. For **Agent**, one e2e test covering its single email-OTP path the same way. One forgot-password → reset-password → confirm old sessions are revoked e2e test per principal type.

## 8. Implementation sequencing note

This is larger than one plan, and since Admin/Agent are separate implementations (not shared code), it splits along that line rather than by capability:

1. **Admin password self-service** — schema (reset-token fields), `forgot-password`/`reset-password`/`change-password`. No 2FA yet — independently shippable and testable.
2. **Admin 2FA** — schema (2FA fields), `TokenService`'s two new methods (shared infra, built here since Admin is first), `2fa/setup`/`confirm`/`disable`, and the `login` modification + `2fa/login-verify`. Depends on (1) only for the schema-migration convenience of doing it in one pass if a subagent chooses to batch them — not a hard dependency.
3. **Agent password self-service** — `forgot-password`/`reset-password` only (`change-password` already exists). Mirrors (1)'s pattern on the `Agent` model.
4. **Agent 2FA** — simpler than (2): no method choice, no TOTP fields, no `otplib` usage. Reuses `TokenService`'s already-built pending-token methods from (2), and the same email-code-generation shape as Admin's `email` branch, just without a `method` parameter anywhere.
