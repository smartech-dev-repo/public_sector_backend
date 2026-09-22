# Public Sector Backend

## Prerequisites

- Node.js >= 20
- A PostgreSQL 14+ server reachable locally (Docker, Postgres.app, or a
  native install all work — the app only needs a `DATABASE_URL`)

## Setup

1. `cp .env.example .env` and adjust values (especially
   `DATABASE_URL`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`).
2. Make sure the database named in `DATABASE_URL` exists, e.g.
   `createdb public_sector_backend` (or `CREATE DATABASE public_sector_backend;`
   via `psql`).
3. `npm install`
4. `npx prisma migrate dev`
5. `npx prisma generate` (only needed if `migrate dev` reports no schema
   change but the generated client is stale)
6. `npx prisma db seed`
7. `npm run start:dev`

## Testing

- Unit tests: `npm run test`
- End-to-end tests (needs the DB running, migrated, and seeded):
  `npm run test:e2e`

## Login endpoints

| Role | Endpoint | Body |
|---|---|---|
| Admin | `POST /auth/admin/login` | `{ email, password }` |
| Agent | `POST /auth/agent/login` | `{ email, password }` (only works once an agent is `APPROVED` — Phase 2) |
| Client | `POST /auth/client/otp/request` then `POST /auth/client/otp/verify` | `{ phone }` then `{ phone, code }` |

OTP codes are logged to the console by the mock `ConsoleOtpProvider` in
development — there is no real SMS vendor wired in yet.

## Admin password self-service

`POST /auth/admin/forgot-password` (`{ email }`, always `200` — never reveals
whether the email exists) emails a one-hour opaque reset token via the
same mechanism `AdminInvite` already uses. `POST /auth/admin/reset-password`
(`{ token, newPassword }`) consumes it and force-revokes every existing
session for that admin, since a reset implies the old password may be
compromised. `POST /auth/admin/change-password` (Admin JWT,
`{ currentPassword, newPassword }`) is the voluntary path — it does not
revoke other sessions.

## Admin two-factor authentication

An admin can enable 2FA via `POST /auth/admin/2fa/setup` (`{ method: 'TOTP' | 'EMAIL' }`,
`409` if already enabled), confirm it via `POST /auth/admin/2fa/confirm`
(`{ code }` — only activates on a real, successfully-verified code, so a
botched setup never locks anyone out), and turn it off via
`POST /auth/admin/2fa/disable` (`{ currentPassword }`, requires
re-confirming the password). Once enabled, `POST /auth/admin/login`
returns `{ twoFactorRequired: true, method, pendingToken }` instead of
real tokens — `pendingToken` is signed with a **separate secret**
(`JWT_TWO_FACTOR_PENDING_SECRET`), so it's cryptographically incapable of
being used as a real Bearer token anywhere. `POST /auth/admin/2fa/login-verify`
(`{ pendingToken, code }`) completes the login and issues real tokens.

## Session endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/refresh` | `{ refreshToken }` in body | Rotates the refresh token; reusing an already-rotated token revokes every session for that principal. |
| `POST /auth/logout` | `{ refreshToken }` in body | Revokes one session. |
| `POST /auth/logout-all` | Bearer access token | Revokes every session for the authenticated principal. |
| `GET /auth/sessions` | Bearer access token | Lists the caller's own active sessions. |
| `DELETE /auth/sessions/:id` | Bearer access token | Revokes one of the caller's own sessions. |

## Admin invite flow

`POST /admin/invites` (`admins:create`) → emails a token via the mock console
email provider → `POST /auth/admin/accept-invite { token, password, fullName }`
(public) creates the `AdminUser` and logs them in. `POST
/admin/invites/:id/resend` and `GET /admin/invites` manage outstanding
invites. No `AdminUser` row exists until the invite is accepted.

## Audit log

Every mutating request to an admin-guarded route gets a baseline `AuditLog`
row automatically (actor, route, status). Business-meaningful actions (invite
created/resent, sessions force-revoked) also get an explicit, richer entry.
View them at `GET /admin/audit-logs` (`audit:read`), optionally filtered by
`actorType`, `action`, `targetType`, `targetId`.

## Document ingestion

Upload endpoints for the three source documents exist and are fully wired
(auth, permissions, audit logging, background processing via BullMQ).
**All three document types are now fully parsed**: IPPIS Broadsheet into
`IppisRecord` (by `agency`+`staffId`), Disbursed Loans into `Loan` (by
`customerId`), and Repayment Schedule into `LoanRepaymentRecord` (by
`agency`+`staffId`+`period`+`elementName`, one small hardcoded mapper per
agency sheet since those six sheets share almost no column names) — see
`src/document-ingestion/parsers/`. Reconciliation (comparing expected vs.
actual repayments) runs automatically after ingestion — see the
"Reconciliation" section below.

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /admin/documents/ippis-broadsheet/upload` | `ippis:upload` | Multipart, field `file` |
| `POST /admin/documents/disbursed-loans/upload` | `loans:upload` | Multipart, field `file` |
| `POST /admin/documents/repayment-schedule/upload` | `repayments:upload` | Multipart, field `file` + required `period` (`YYYY-MM`) |
| `GET /admin/documents/batches` | `documents:read` | List upload history, filterable by `documentType`/`status` |
| `GET /admin/documents/batches/:id` | `documents:read` | Batch detail incl. snapshot export links |
| `GET /admin/documents/files/:key` | `documents:read` | Download a stored file (raw upload or snapshot export) |

File storage picks its active provider via `STORAGE_PROVIDER` (`local` |
`s3` | `gcs`, default `local`). Only the selected provider's env vars need
real values — see `.env.example` for the full list. For GCS:
`GCP_BUCKET_NAME` plus one of `GCP_CREDENTIALS_FILE` (a local
service-account JSON key file path — local dev) or `GCP_CREDENTIALS_JSON`
(that same file's raw contents as one env var — for platforms like
Dokploy with no file mount; `FILE` wins if both are set), plus optional
`GCP_SUB_PATH`. Automated tests always run against the local provider
regardless of this setting. Background processing uses BullMQ against the
`REDIS_URL`/`REDIS_KEY_PREFIX` already configured in your environment.

## Reconciliation

After a `disbursed-loans` or `repayment-schedule` upload completes, the
system recomputes reconciliation across every `Loan` and its matching
`LoanRepaymentRecord` rows (matched via `agency`+IPPIS number, same as
the client loan dashboard) — a full idempotent recompute rather than one
scoped to the triggering upload, upserted by `(loanId, period)`. For each
period within a loan's disbursement-to-maturation range, the expected
installment (standard reducing-balance amortization from `loanAmount`,
`interestRatePercent`, and the loan term) is compared against the actual
summed deductions for that period: `MATCHED` (within a ₦1 tolerance),
`UNDER_PAID`, `OVER_PAID`, or `NO_DEDUCTION_FOUND` (no matching repayment
rows at all for that period). `GET /admin/reconciliation`
(`reconciliation:read`) lists variances, filterable by `agency`/`status`/
`period`. `GET /admin/loans` (`loans:upload`) and
`GET /admin/ippis-records` (`ippis:upload`) provide basic
listing/filtering by `agency` over the underlying ingested tables.

## RBAC management

Roles and permissions can now be managed via the API — previously only
`prisma/seed.ts` could create them.

| Endpoint | Permission | Notes |
|---|---|---|
| `POST/GET /admin/permissions` | `permissions:manage` | |
| `GET/PATCH/DELETE /admin/permissions/:id` | `permissions:manage` | `PATCH` only changes `description` — `key` is immutable. `DELETE` is blocked (409) if any role still has it. |
| `POST/GET /admin/roles` | `roles:manage` | |
| `GET/PATCH/DELETE /admin/roles/:id` | `roles:manage` | Renaming or deleting `SUPER_ADMIN` is blocked (409); deleting a role assigned to any admin is blocked (409). |
| `POST /admin/roles/:id/permissions` | `roles:manage` | `{ permissionId }` |
| `DELETE /admin/roles/:id/permissions/:permissionId` | `roles:manage` | |
| `GET /admin/admins` | `roles:manage` | Lists admins with their roles |
| `POST /admin/admins/:id/roles` | `roles:manage` | `{ roleId }` |
| `DELETE /admin/admins/:id/roles/:roleId` | `roles:manage` | Blocked (409) if it would leave zero admins holding `SUPER_ADMIN` |
| `POST /admin/admins/:id/deactivate` | `roles:manage` | 409 if targeting your own account or an already-inactive admin; force-revokes the admin's sessions |
| `POST /admin/admins/:id/reactivate` | `roles:manage` | 409 if the admin is already active |

`GET /admin/roles/ping` no longer exists — it was a Phase 1 placeholder,
superseded by the real endpoints above.

## CORS

Controlled by `CORS_ORIGINS`: a comma-separated allowlist
(`https://admin.example.com,https://app.example.com`), `*` to allow any
origin, or unset/empty to disable CORS entirely (the default — no
`Access-Control-Allow-Origin` header is sent). Adjust it per environment
without a code change.

## Notes on the stack

- **Prisma 7**: uses `prisma.config.ts` (not just `schema.prisma`) for
  connection config, requires an explicit driver adapter
  (`@prisma/adapter-pg`) instead of Prisma's old built-in query engine, and
  no longer auto-loads `.env` — `dotenv/config` is imported explicitly in
  `src/main.ts`, `prisma.config.ts`, and `prisma/seed.ts`. The generator
  uses `moduleFormat = "cjs"` to match this project's CommonJS setup
  (NestJS here is not an ESM project). `prisma` itself lives in
  `dependencies`, not `devDependencies`, so `prisma migrate deploy` is
  available in production (used by the Docker image's start command).
- The generated Prisma client is emitted to `src/generated/prisma` (not a
  project-root `generated/`) specifically so it compiles as ordinary
  source under `nest build`'s inferred `rootDir` — putting it outside
  `src/` shifts that inferred root and silently moves the compiled entry
  point from `dist/main.js` to `dist/src/main.js`, breaking
  `npm run start:prod` and any Docker image that assumes the standard
  path. It's gitignored and regenerated by `npx prisma generate` /
  `nest build`.
- **Nest ecosystem packages** (`@nestjs/jwt`, `@nestjs/passport`,
  `@nestjs/config`) are pinned to their last major compatible with Nest 10,
  since this project was scaffolded on `@nestjs/cli@10` (the current
  `@nestjs/cli@latest` fails to run on Node 22.14 due to an unrelated
  `@angular-devkit` bug).
- `.claude/skills/`, `.windsurf/skills/`, `.agents/skills/`, and
  `skills-lock.json` were auto-installed by `prisma init` — they're
  reference docs for AI coding assistants working on this repo, not
  application code.

## Hardening: rate limiting & observability

Every route is rate-limited globally (`THROTTLE_DEFAULT_LIMIT` per
`THROTTLE_DEFAULT_TTL_SECONDS`, per IP, Redis-backed so limits are shared
across horizontally-scaled instances); six abuse-prone routes (OTP
request/verify, all three login endpoints, agent registration, agent
password change) get a stricter hardcoded override (5 requests per 15
minutes). `RATE_LIMITING_ENABLED=false` in this repo's own dev/test
config disables the guard entirely — almost every e2e test logs in as
admin in its own `beforeAll`, which would otherwise exhaust both limits
within minutes of a full suite run.

Logging is structured JSON via `nestjs-pino` (pretty-printed outside
production), with a per-request correlation id echoed back as
`X-Request-Id` on every response. A pluggable `ErrorTrackingProvider`
(no-op for now — logs a warning instead of reporting anywhere) is wired
into a global exception filter that reports every unhandled exception
without changing what the client actually receives; a real Sentry (or
similar) provider slots in later behind an env var, matching every other
external integration in this project.

`GET /health` checks Postgres and Redis connectivity, returning `503`
(instead of a static `200`) if either is down.

## Deploying to Dokploy

The `Dockerfile` builds a single, self-contained production image — no
nginx (Dokploy runs its own Traefik in front of every app for routing/TLS)
and no docker-compose (this is a one-service deployment).

1. In Dokploy, create an application with **Build type: Dockerfile**
   pointing at this repo/branch and `Dockerfile` at the repo root.
2. Set environment variables on the Dokploy app (mirror `.env.example`):
   `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
   `JWT_ACCESS_TTL`, `BOOTSTRAP_ADMIN_EMAIL`,
   `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_NAME`, `OTP_TTL_SECONDS`.
   `DATABASE_URL` should point at a reachable PostgreSQL instance (a
   Dokploy-managed Postgres service or an external one) — never bake
   credentials into the image. If `STORAGE_PROVIDER=gcs`, also set
   `GCP_BUCKET_NAME` and `GCP_CREDENTIALS_JSON` (the service-account key
   file's raw JSON contents, pasted as one env var) — `GCP_CREDENTIALS_FILE`
   won't work here since there's no file mount and the key file itself is
   gitignored, never part of the built image.
3. Set the app's internal port to `3000` (or override `PORT` and match
   it) so Dokploy's Traefik can route to it.
4. Deploy. The container's start command
   (`npx prisma migrate deploy && node dist/main.js`) applies any pending
   migrations before the app starts — there's no separate migration step
   to run by hand. Run `npx prisma db seed` once via Dokploy's shell/exec
   into the running container (or a one-off deploy) to create the
   bootstrap admin; it's idempotent (`upsert`-based) so it's safe to rerun.
5. Point Dokploy's health check at `GET /health` (also used by the
   image's own `HEALTHCHECK`).

## Admin client review

Clients that fail identity or face-match verification land at
`Client.status = MANUAL_REVIEW` with `ClientOnboarding.failureReasons`
populated. Admins holding `clients:review` can list/inspect them and
either `approve` (overrides straight to `VERIFIED`) or `retry` — which
auto-resets the client to the right earlier onboarding step based on
*which* check failed, rather than requiring the admin to pick a step
manually.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /admin/clients` | `clients:review` | Filterable by `status` |
| `GET /admin/clients/:id` | `clients:review` | Full detail incl. `ClientOnboarding` — selfie images are downloaded separately via `GET /admin/documents/files/:key` (`documents:read`) |
| `POST /admin/clients/:id/approve` | `clients:review` | Only valid from `MANUAL_REVIEW` |
| `POST /admin/clients/:id/retry` | `clients:review` | `{ note }`. Resets to `IPPIS_LINKED` if identity verification itself failed, or `IDENTITY_SUBMITTED` if only the face match failed |

## Loan requests

A `VERIFIED` client can request a loan; eligibility (currently: must be
`VERIFIED`, amount within `LOAN_SALARY_MULTIPLE_CAP` × their IPPIS salary
— both env-var-provisional pending real business criteria) is checked
before a `PENDING` `LoanRequest` is created and a confirmation SMS sent
via a pluggable `TwoWaySmsProvider` (mock-only for now). The client
confirms by replying "YES"/"1", forwarded to
`POST /webhooks/sms/inbound` by whatever SMS vendor is eventually wired
in — that endpoint has no auth guard since there's no vendor credential
to check yet. An unconfirmed request auto-expires to `FAILED` after 24
hours (a BullMQ-delayed job). Disbursement (turning a `CONFIRMED` request
into an actual `Loan` record) is not built — a separate future concern.

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /client/loan-requests` | Client JWT | `{ amount }`; `422` on eligibility failure |
| `POST /client/loan-requests/:id/resend` | Client JWT | Only valid while `PENDING`; doesn't reset the 24h expiry |
| `GET /client/loan-requests` | Client JWT | The calling client's own requests |
| `POST /webhooks/sms/inbound` | None (public) | `{ phone, message }` — mocked shape standing in for a real vendor's payload |

## Loan origination

`LoanRequest` now carries a `tenorMonths` (chosen from
`GET /client/loan-terms`, the active `LoanTermOption`s for the client's own
agency) and a rate/management-charge snapshot taken at request time. After
the existing SMS "YES" confirmation, a request below
`LOAN_AUTO_APPROVE_THRESHOLD` auto-`APPROVED`s and auto-`DISBURSED`s in the
same step; at or above it, an admin holding `loan-requests:review` calls
`POST /admin/loan-requests/:id/approve` or `.../reject` (`{ reason }`),
then separately `.../disburse` once the external transfer is confirmed —
`DISBURSED` is always its own manual step for a manually-approved request.
Either path creates exactly one `ClientLoan` (the client's single
platform-native loan — topup and repayment tracking are still to come). A
client can only have one loan in flight at a time: a new
`POST /client/loan-requests` is rejected (`422`) while they have a
non-terminal request, an `ACTIVE` `ClientLoan`, or an `ACTIVE` loan in
their ingested bank history. `GET /admin/client-loans/disbursement-summary
?month=YYYY-MM` (`client-loans:read`) streams a CSV of that month's
disbursed loans.

### Topup

`POST /client/loan-requests/topup` (`{ amount, tenorMonths }`, Client JWT)
adds more funds to the client's existing single active `ClientLoan` — no
loan ID in the request; the service looks up the client's one `ACTIVE`
loan itself. Reuses the exact same request→confirm→approve/auto-approve→
disburse pipeline as origination (`LoanRequest.type` is now `ORIGINATION`
or `TOPUP`), gated by a separate eligibility chain requiring an active
loan to exist and no other request already in progress. On disbursement,
instead of creating a new loan, the existing `ClientLoan`'s
`principalAmount`/`principalBalance`/`disbursedAmount` increase by the
topup's own amount, and `maturationDate` extends to
`max(current, topup disbursement date + topup's own tenor)` — a topup
never shortens the loan's remaining term. `GET /admin/loan-requests` now
also accepts an optional `?type=` filter (`ORIGINATION`/`TOPUP`).

### Repayment tracking

Repayment-schedule uploads are matched against `ClientLoan` the same way
they're already matched against the historical ingested `Loan` model —
`ClientLoanReconciliationService.reconcileAll()` runs automatically
alongside the existing reconciliation, right after every
disbursed-loans/repayment-schedule upload finishes. Each new period
(never re-processed once recorded — a correction is a manual admin
action) reduces `principalBalance` by `min(actualAmount, expectedAmount)`;
any excess beyond the expected installment is credited to the client's
wallet (`SYSTEM` actor). Underpayment carries no penalty and no automatic
remediation — it's simply recorded, which feeds `ClientLoan.status`
toward `DEFAULT` (mirroring the same `ACTIVE`/`DEFAULT`/`CLOSED` logic
used for the ingested-loan history). `GET /client/client-loans/me`
(Client JWT) returns the caller's most recent platform loan with its full
period-by-period schedule (`null` if they've never had one);
`GET /admin/client-loans/:id/repayment-plan` (`client-loans:read`)
returns the same for any loan.

### Spend wallet balance toward a loan payment

`POST /client/client-loans/me/apply-wallet` (`{ amount }`, Client JWT)
lets a client apply their own wallet balance toward their loan's
outstanding `principalBalance` — `422` if they have no outstanding
balance, `409` if the current period already has a
`ClientLoanRepaymentVariance` row (from either payroll reconciliation or
an earlier wallet application this period — at most one per period,
either source). The requested amount is silently capped at
`principalBalance`; `WalletService.debit()` still applies its own
independent insufficient-wallet-balance check. Unlike payroll
reconciliation, the **full** applied amount reduces `principalBalance` —
there's no excess-to-wallet step, since the amount already came from the
client's own wallet. Produces a `ClientLoanRepaymentVariance` row for the
current period (`source: WALLET_APPLICATION`), so the payment shows up in
`GET /client/client-loans/me`'s schedule the same way a payroll deduction
would.

## Client loan dashboard

`GET /client/loans` (Client JWT) returns the calling client's pre-existing
loan history — real disbursed loans and repayment activity ingested from
bank reports, which predate this platform and have no direct database
link to `Client`. Matched via the client's linked `IppisRecord`'s
`agency`+`staffId` (the same pairing `Loan.agency`/`.ippisNumber` and
`LoanRepaymentRecord.agency`/`.staffId` already carry from ingestion),
with a BVN cross-check against `Loan.bvn` (comparing the client's own
Dojah-verified BVN from onboarding, not the IPPIS broadsheet's BVN) to
guard against an agency+staffId collision showing one client someone
else's loan. Returns `{ loans: [], repayments: [] }` (empty, not an
error) if the client hasn't linked IPPIS yet or has no matching history.
This is deliberately separate from `GET /client/loan-requests` — that
endpoint is the client's own in-platform loan applications; this one is
historical/external data.

Each loan in the response carries a computed (not persisted) `status`:
`CLOSED` if `principalBalance <= 0`; else `DEFAULT` if `maturationDate`
has passed with a balance still owed, or the loan's most recent
`RepaymentVariance` row is `UNDER_PAID`/`NO_DEDUCTION_FOUND`; else
`ACTIVE`. `GET /client/loans` accepts optional `status`/`product`/
`disbursedFrom`/`disbursedTo` query params to filter the `loans` array —
`repayments` is never filtered by these, since those rows aren't tied to
a specific loan in the schema.

`GET /client/loans/:loanId/repayment-plan` (Client JWT) returns one
loan's full month-by-month schedule from disbursement to maturity, reusing
the reconciliation module's `computeExpectedInstallment()` for the
expected amount (the same value reconciliation stores as
`RepaymentVariance.expectedAmount`) and overlaying real `RepaymentVariance`
rows where they exist. Periods with no row yet are returned with
`status: "UPCOMING"` and null `actualAmount`/`variance`. Requesting a
`loanId` that isn't the caller's own (or doesn't exist) returns `404`,
matching this codebase's never-leak-existence convention elsewhere.

## Wallet

Every client has a wallet backed by an append-only ledger of
`WalletEntry` rows — there is no separate `Wallet` model; the balance is
always the sum of a client's entries (`SUM(CREDIT) - SUM(DEBIT)`), so it
can never drift out of sync with its own history. `GET /client/wallet`
(Client JWT) returns the caller's own `{ balance, entries }`, empty/zero
if they have no history yet. Admins holding `wallets:read`/
`wallets:manage` can view any client's wallet
(`GET /admin/clients/:clientId/wallet`) and credit or debit it
(`POST .../wallet/credit`, `POST .../wallet/debit`, both `{ amount,
description }`) — a debit that would take the balance below zero is
rejected with `422`; the balance never goes negative. Both admin
mutations are recorded through the existing `AuditLogService`, the same
mechanism used for every other sensitive admin action on a client (e.g.
approve/reject in `AdminClientReviewController`). This is the first of
two sub-projects in a broader loan-lifecycle overhaul — a second,
not-yet-built piece will let overpayment on a loan auto-credit this same
wallet, and let a client spend their balance toward a payment.

## Agent enrollment

`POST /agents/register` (public, multipart: `fullName`/`email`/`phone`/
`address` fields, `cv` file required, up to 5 `supportingDocuments` files
optional) creates an `Agent` at `PENDING_REVIEW`. Admins holding
`agents:read`/`agents:review` list/inspect/approve/reject submissions
(`GET /admin/agents`, `GET /admin/agents/:id`,
`POST /admin/agents/:id/approve`, `POST /admin/agents/:id/reject` with a
required `reason`). Approving generates a temporary password, emails it
to the agent (with an optional app-download link from
`AGENT_APP_DOWNLOAD_URL`) via the existing `EmailService`, and requires
the agent to change it before their JWT stops carrying
`mustChangePassword: true` — `POST /auth/agent/change-password` is the
one route reachable regardless of that flag.
`POST /admin/agents/:id/resend-credentials` regenerates and re-sends the
credentials, but only until the agent has logged in once
(`Agent.hasLoggedIn`), after which it's permanently disabled.
`POST /auth/refresh` re-derives `mustChangePassword` fresh from the
database on every agent token refresh, the same way it already
re-derives `permissions` fresh for admin tokens.

## Agent password self-service

`POST /auth/agent/forgot-password` (`{ email }`, always `200`, gated on
`status === APPROVED`) emails a one-hour opaque reset token via the same
mechanism Admin's own password reset uses. `POST /auth/agent/reset-password`
(`{ token, newPassword }`) consumes it, clears `mustChangePassword` (a
reset via a verified email token counts as establishing a real password
of the agent's own choosing), and force-revokes every existing session
for that agent. `POST /auth/agent/change-password` (the voluntary,
already-authenticated path) already existed from the enrollment work and
is unchanged.

## Agent two-factor authentication

Identical shape to Admin's 2FA (see "Admin two-factor authentication"
above) — `POST /auth/agent/2fa/setup` (`{ method: 'TOTP' | 'EMAIL' }`),
`POST /auth/agent/2fa/confirm` (`{ code }`), `POST /auth/agent/2fa/disable`
(`{ currentPassword }`), and `POST /auth/agent/login` returning
`{ twoFactorRequired: true, method, pendingToken }` when enabled, completed
via `POST /auth/agent/2fa/login-verify` (`{ pendingToken, code }`). Agent
was originally scoped to email-OTP-only given its mobile-app context, but
that was revised to give Agent the same TOTP option Admin has.

## Client/IPPIS onboarding

After phone/OTP login, a Client links their IPPIS number, submits BVN/NIN
for lookup (via a pluggable `IdentityVerificationProvider` — mock by
default, `DojahIdentityVerificationProvider` when
`IDENTITY_VERIFICATION_PROVIDER=dojah` and `DOJAH_APP_ID`/`DOJAH_SECRET_KEY`
are set), then submits a live selfie compared against both the BVN and NIN
reference photos via a pluggable `FaceVerificationProvider` (mock only for
now). Passing both auto-verifies the client; any failure routes to
`MANUAL_REVIEW` (existing `clients:review` permission covers visibility).

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /client/onboarding/ippis-link` | Client JWT | `{ ippisNumber }` |
| `POST /client/onboarding/identity` | Client JWT | `{ bvn, nin }` |
| `POST /client/onboarding/face-match` | Client JWT | multipart, field `selfie` |
| `GET /client/onboarding/status` | Client JWT | resumability — `step` says exactly where to continue |

## Roadmap

See `docs/specs/2026-09-09-public-sector-backend-spec.md` for the full
system spec and phased roadmap (Agent enrollment, Client/IPPIS verification
pipeline, RBAC management UI, hardening).
