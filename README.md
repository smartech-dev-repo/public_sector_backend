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

## Notes on the stack

- **Prisma 7**: uses `prisma.config.ts` (not just `schema.prisma`) for
  connection config, requires an explicit driver adapter
  (`@prisma/adapter-pg`) instead of Prisma's old built-in query engine, and
  no longer auto-loads `.env` — `dotenv/config` is imported explicitly in
  `src/main.ts`, `prisma.config.ts`, and `prisma/seed.ts`. The generator
  uses `moduleFormat = "cjs"` to match this project's CommonJS setup
  (NestJS here is not an ESM project).
- **Nest ecosystem packages** (`@nestjs/jwt`, `@nestjs/passport`,
  `@nestjs/config`) are pinned to their last major compatible with Nest 10,
  since this project was scaffolded on `@nestjs/cli@10` (the current
  `@nestjs/cli@latest` fails to run on Node 22.14 due to an unrelated
  `@angular-devkit` bug).
- `.claude/skills/`, `.windsurf/skills/`, `.agents/skills/`, and
  `skills-lock.json` were auto-installed by `prisma init` — they're
  reference docs for AI coding assistants working on this repo, not
  application code.

## Roadmap

See `docs/specs/2026-09-09-public-sector-backend-spec.md` for the full
system spec and phased roadmap (Agent enrollment, Client/IPPIS verification
pipeline, RBAC management UI, hardening).
