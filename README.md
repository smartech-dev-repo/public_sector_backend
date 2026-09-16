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
actual repayments) is not built yet.

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
real values — see `.env.example` for the full list (`AWS_*` for S3,
`GCP_*`/`GCS_BUCKET` for GCS). Automated tests always run against the local
provider regardless of this setting. Background processing uses BullMQ
against the `REDIS_URL`/`REDIS_KEY_PREFIX` already configured in your
environment.

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
   credentials into the image.
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

## Roadmap

See `docs/specs/2026-09-09-public-sector-backend-spec.md` for the full
system spec and phased roadmap (Agent enrollment, Client/IPPIS verification
pipeline, RBAC management UI, hardening).
