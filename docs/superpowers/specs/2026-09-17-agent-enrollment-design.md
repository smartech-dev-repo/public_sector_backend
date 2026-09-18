# Agent Enrollment (Phase 2) — Design

**Date:** 2026-09-17
**Status:** Approved for planning
**Closes out:** Phase 2 of the original spec (`docs/specs/2026-09-09-public-sector-backend-spec.md` §4, §7) — the only phase never built. `POST /auth/agent/login` already exists; everything upstream of it (registration, review, credential issuance) does not.

## 1. Purpose and scope

A public registration endpoint lets a prospective agent submit their details and documents. An admin holding `agents:review` approves or rejects the submission. On approval, the system generates a temporary password and emails it — along with the agent's login email and an app download link — to the address the agent registered with. The agent must log in and change that password before doing anything else; the temp-password email can be resent (regenerating a new one each time) until the agent has actually logged in once, at which point resending is disabled.

**In scope:**
- `POST /agents/register` (public) — full name, email, phone, address, a required CV upload, and 0+ optional supporting-document uploads.
- `GET /admin/agents` (filterable by status), `GET /admin/agents/:id` — `agents:read`.
- `POST /admin/agents/:id/approve`, `POST /admin/agents/:id/reject` (required `reason`), `POST /admin/agents/:id/resend-credentials` — `agents:review`.
- Forced password change: a freshly-approved (or credentials-resent) agent's JWT carries `mustChangePassword: true`; `POST /auth/agent/change-password` is the one route that stays reachable regardless of that flag.
- `POST /auth/refresh` (the existing, principal-generic endpoint) re-derives `mustChangePassword` fresh from the `Agent` table for agent tokens, the same way it already re-derives `permissions` fresh for admin tokens — without this, refreshing would silently drop the flag.
- Credential resend is disabled once the agent has logged in even once (tracked via a new `Agent.hasLoggedIn` flag) — this mechanism is for the pre-first-login gap only, not a general password-reset feature.

**Explicitly out of scope / deferred:**
- Any functional Agent business endpoint beyond auth/change-password — none exist yet in this codebase, so there's nothing else to gate behind the forced-password-change guard today. The guard is still built (`RequirePasswordChangedGuard`), documented for future Agent-JWT-protected routes to adopt, but isn't wired to anything besides being available.
- Emailing the agent on rejection — the original spec only requires a required reason be recorded, not that it's communicated by email; not building an email for this until asked.
- A dedicated "download agent document" endpoint — the existing `GET /admin/documents/files/:key` (`documents:read`) already serves any stored file by key, the same reuse already established for client onboarding selfies in the Admin Client Review feature. CV/supporting-document keys are just referenced by `GET /admin/agents/:id`, not re-served by a new route.
- A general "forgot password" flow for agents post-first-login — not asked for, would be new scope.

## 2. Schema changes

```prisma
model Agent {
  id                     String      @id @default(uuid())
  email                  String      @unique
  phone                  String
  fullName               String
  address                String
  passwordHash           String?
  status                 AgentStatus @default(PENDING_REVIEW)
  cvKey                  String
  supportingDocumentKeys String[]    @default([])
  mustChangePassword     Boolean     @default(true)
  hasLoggedIn            Boolean     @default(false)
  reviewedBy             String?
  reviewedAt             DateTime?
  rejectionReason        String?
  createdAt              DateTime    @default(now())
  updatedAt              DateTime    @updatedAt
}
```

(`AgentStatus` — `PENDING_REVIEW | APPROVED | REJECTED` — already exists as-is, unchanged.)

`JwtPayload` gains one optional field: `mustChangePassword?: boolean` (alongside the existing `permissions?: string[]`, which is similarly admin-only-populated).

## 3. Registration and document uploads

`POST /agents/register` (public, multipart) — two named file fields, matching this codebase's existing single-field-per-upload pattern extended to a fields+array shape via Nest's `FileFieldsInterceptor`:
- `cv` — required, exactly one file.
- `supportingDocuments` — optional, up to 5 files (a provisional cap; easy to raise later, nothing in the spec demands a specific number).

Body fields (multipart text fields alongside the files): `fullName`, `email`, `phone`, `address`. `email` must be unique — checked explicitly (`409` on duplicate) rather than surfacing a raw DB constraint error.

Each uploaded file is stored via the existing `FileStorageProvider` under `agent-documents/{agentId}/cv-{uuid}{ext}` and `agent-documents/{agentId}/supporting-{index}-{uuid}{ext}` (a fresh `Agent` row is created first — with a generated `id` — so the storage keys can be namespaced by it, then updated with the resulting keys once uploads complete).

## 4. Review and credential issuance

- **`approve`** — only valid when `status === PENDING_REVIEW` (`409` otherwise). Generates a temporary password (`generateOpaqueToken()` — the same crypto-random generator already used for admin invite tokens; meant to be copy-pasted from the email, not hand-typed), hashes it into `passwordHash`, sets `mustChangePassword = true`, `status = APPROVED`, `reviewedBy`/`reviewedAt`. Sends one email to the agent's registered address: their login email, the plaintext temporary password (discarded from memory immediately after — never persisted or logged in plaintext), and an app download link read from `AGENT_APP_DOWNLOAD_URL` (optional env var — if unset, that line is simply omitted from the email rather than blocking approval on a deployment detail).
- **`reject`** — body `{ reason: string }` (required, `400` if missing/empty). Only valid when `status === PENDING_REVIEW`. Sets `status = REJECTED`, `rejectionReason`, `reviewedBy`/`reviewedAt`. No email sent (§1).
- **`resend-credentials`** — only valid when `status === APPROVED` **and** `hasLoggedIn === false` (`409` otherwise — "credentials have already been used and can no longer be resent"). Generates a **new** temporary password (the old one was never stored in plaintext, so there's nothing to literally resend — this regenerates, matching `AdminInvite.resend`'s own precedent of issuing a fresh token rather than replaying the old one), overwrites `passwordHash`, re-sends the same email. Resendable any number of times until the agent logs in.

## 5. Login, forced password change, and refresh

- `AgentAuthService.login` (already exists) additionally sets `hasLoggedIn = true` on every successful login (idempotent — harmless to set it again on a later, legitimate login) and includes `mustChangePassword: agent.mustChangePassword` in the signed `JwtPayload`.
- `POST /auth/agent/change-password` (new) — `AgentOnlyGuard`-protected (new guard, mirrors `ClientOnlyGuard` exactly), body `{ currentPassword, newPassword }`. Verifies `currentPassword` against the stored hash, hashes `newPassword` into `passwordHash`, sets `mustChangePassword = false`. Returns a freshly signed access token (`mustChangePassword: false`) — the existing refresh token/session is left untouched, no need to rotate it since nothing suspicious happened.
- `RequirePasswordChangedGuard` (new) — throws `403` if `request.user?.mustChangePassword === true`. Not applied to `change-password` itself (that would lock an agent out of the one action they need); not applied anywhere else either, since no other Agent-JWT-protected endpoint exists yet (§1).
- `SessionAuthController.refresh` (existing, shared across all three principal types) — extended to also re-derive `mustChangePassword` fresh from the `Agent` table when `result.principalType === AGENT`, exactly parallel to how it already re-derives `permissions` fresh for `ADMIN`. Without this, a stalled agent could bypass the flag simply by calling `/auth/refresh` once, since that endpoint currently builds a brand-new payload from scratch rather than carrying old claims forward.

## 6. Error handling

- Registration with a duplicate email → `409`.
- Registration missing `cv` → `400` (validation).
- `:id` doesn't resolve to an `Agent` on any admin route → `404`.
- `approve`/`reject` when `status !== PENDING_REVIEW` → `409` naming the actual current status.
- `reject` with missing/empty `reason` → `400`.
- `resend-credentials` when `status !== APPROVED` or `hasLoggedIn === true` → `409`.
- `change-password` with a wrong `currentPassword` → `401`.

## 7. Testing strategy

Unit tests: agent registration (duplicate-email rejection, successful creation with both file fields stored under the right keys — mocked `FileStorageProvider`), the review service (approve/reject/resend-credentials, all guard conditions, mocked `EmailService` and `PrismaService`), `AgentAuthService.login` (sets `hasLoggedIn`, includes `mustChangePassword` in the payload — extending the existing spec file), the new change-password flow, and `RequirePasswordChangedGuard` directly (throws when the flag is true, passes otherwise/when absent) even though nothing consumes it yet.

One e2e test walking the full lifecycle: register → admin approves (captures the emailed temp password via the mocked `EmailService`'s captured call, same technique other e2e tests use to read a mock-provider's output) → login with it (`mustChangePassword: true` on the returned token, decoded) → attempt `resend-credentials` and confirm `409` (already logged in) → call `change-password` → confirm a fresh `POST /auth/refresh` no longer carries `mustChangePassword: true`.
