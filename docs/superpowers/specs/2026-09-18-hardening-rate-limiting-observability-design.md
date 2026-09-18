# Hardening: Rate Limiting & Observability — Design

**Date:** 2026-09-18
**Status:** Approved for planning

This is the first sub-project of Phase 5 ("Hardening") from the original spec (`docs/specs/2026-09-09-public-sector-backend-spec.md` §7). Phase 5 bundles four independent pieces — rate limiting, observability, replacing mock vendors with real ones, and load testing. This design covers the first two, chosen because both are buildable now without any vendor account/credential from you; the other two (real vendor rollout, load testing) are separate future sub-projects.

## 1. Purpose and scope

Harden the API surface against abuse and make production behavior observable, without requiring any new external vendor account.

**In scope:**
- Rate limiting: a modest global per-IP default across every route, plus a stricter limit on six abuse-prone public/semi-public endpoints, backed by the Redis instance already used for BullMQ (correct for a horizontally-scaled Dokploy deployment — in-memory counters would silently under-protect once more than one instance runs).
- Structured (JSON) logging via `nestjs-pino`, with a per-request correlation ID — every existing `new Logger(...)` call across this codebase keeps working unchanged, since Nest's `Logger` class routes through whatever `app.useLogger()` is configured to.
- A pluggable `ErrorTrackingProvider` interface with a no-op default, wired into a global exception filter — matches this project's established mock-first pattern (`OtpProvider`, `EmailProvider`, `IdentityVerificationProvider`). No real provider (e.g. Sentry) is built yet; that's real-vendor-rollout scope, deferred.
- Upgrading `GET /health` from a static `{status:'ok'}` stub into a real check of Postgres and Redis connectivity, returning `503` if either is down — the correct behavior for a deployment platform's health probe.

**Explicitly out of scope / deferred:**
- A real error-tracking vendor (Sentry or otherwise) — needs a DSN from you; this round only ships the interface + no-op.
- Per-user or per-phone rate limiting (only per-IP, via `@nestjs/throttler`'s default IP-based tracking) — sufficient for a first pass; a determined attacker rotating IPs is a later concern.
- Load testing.
- Metrics/tracing (Prometheus, OpenTelemetry) — logging + error tracking + health checks are the three pieces in scope; metrics dashboards are a separate future concern if actually needed.

## 2. Rate limiting

`@nestjs/throttler` (`^6.4.0`, compatible with this project's NestJS 10), backed by `@nest-lab/throttler-storage-redis` (the actively-maintained Redis storage adapter — the more commonly-suggested `nestjs-throttler-storage-redis` package is marked deprecated on npm, so it's not used here) reusing the existing Redis connection.

**A single named throttler (`default`), not two separate ones.** `@nestjs/throttler` applies *every* throttler defined in its global `throttlers` array to *every* guarded route unless explicitly skipped — so defining a second, stricter named throttler (e.g. `sensitive`) globally would apply that strict limit to *every* route in the app, not just the six intended ones, which is the opposite of what's wanted. Instead:
- **Global default**, applied everywhere via `APP_GUARD`: `THROTTLE_DEFAULT_LIMIT` (default `100`) requests per `THROTTLE_DEFAULT_TTL_SECONDS` (default `60`) per IP.
- **Six specific routes** override that same `default` throttler's numbers via `@Throttle({ default: { limit: THROTTLE_SENSITIVE_LIMIT, ttl: THROTTLE_SENSITIVE_TTL_SECONDS * 1000 } })` — `THROTTLE_SENSITIVE_LIMIT` (default `5`) requests per `THROTTLE_SENSITIVE_TTL_SECONDS` (default `900`, i.e. 15 minutes), scoped only to that route via the decorator, not leaked to any other route.

The six `sensitive`-throttled routes:
1. `POST /auth/client/otp/request` — prevents SMS-bombing a phone number.
2. `POST /auth/client/otp/verify` — prevents brute-forcing a 6-digit OTP.
3. `POST /auth/admin/login` — prevents password brute-forcing.
4. `POST /auth/agent/login` — same.
5. `POST /agents/register` — prevents spam registrations.
6. `POST /auth/agent/change-password` — prevents brute-forcing `currentPassword` (this route already requires a valid JWT, so it's a smaller attack surface than the others, but still worth limiting).

A request exceeding either limit gets `@nestjs/throttler`'s standard `429 Too Many Requests` response.

**Critical operational constraint, discovered during design review:** almost every existing e2e test in this repo calls `POST /auth/admin/login` once in its own `beforeAll` to get an admin token. Across the ~24 e2e spec files, that alone is already more than both the `sensitive` limit (5/15min) and, cumulatively within a rolling 60s window, plausibly the `default` limit (100/60s) too — since every test hits the API from the same machine's IP. Enabling rate limiting unconditionally would make the *entire* e2e suite spuriously fail with `429`s, not just a hypothetical abuse scenario.

Fix: a `RATE_LIMITING_ENABLED` env var (default `true`) globally short-circuits `ThrottlerGuard` (via `@nestjs/throttler`'s `skipIf` option) when set to `false`. This repo's own `.env`/test configuration sets it to `false`, so the full test suite runs exactly as it does today. The one dedicated e2e test that proves throttling actually works (§7) builds its own isolated `TestingModule` with the env var forced to `true` for that file only — it never affects any other test file's app instance, and doesn't touch the shared Redis counters used by a real (enabled) deployment. This matches this project's existing pattern of environment-driven behavior switches (e.g. `IDENTITY_VERIFICATION_PROVIDER=mock`).

## 3. Structured logging

`nestjs-pino@^4.6.1` (the last major compatible with NestJS 10 — the current latest, 5.x, requires Nest 11/12) + `pino@^10.3.1` + `pino-http@^11.0.0`, plus `pino-pretty` as a dev dependency for readable local console output.

- `LoggerModule.forRootAsync` configured with `pino-http`'s automatic per-request correlation ID (`req.id`, a UUID), echoed back as an `X-Request-Id` response header.
- `pino-pretty` transport active only when `NODE_ENV !== 'production'`; raw JSON lines in production, matching standard practice for log-aggregator ingestion.
- `main.ts` calls `app.useLogger(app.get(Logger))` (nestjs-pino's `Logger`) so every existing `new Logger(ClassName.name)` call already scattered across this codebase (e.g. `DocumentIngestionProcessor`, `EmailService`) automatically routes through the structured logger — no changes needed to any of those call sites.

## 4. Error tracking (pluggable, no real vendor yet)

```typescript
export interface ErrorTrackingProvider {
  captureException(error: Error, context?: Record<string, unknown>): void;
}
```

`NoOpErrorTrackingProvider` — logs a warning via the (now-structured) `Logger` noting an exception would have been reported here, so it's still visible in local dev, but does nothing else. Single-provider (no ordered-list failover — same reasoning as `FaceVerificationProvider`, only one vendor will ever be in play).

Wired into a global exception filter (`@Catch()` with no arguments, registered via `APP_FILTER`) that calls `errorTrackingProvider.captureException(error, { path, method })` for every unhandled exception, then delegates to Nest's own `BaseExceptionFilter` for the actual HTTP response — this filter only adds a reporting side-effect, it never changes what a client receives back. A real `SentryErrorTrackingProvider` slots in later behind an env var (e.g. `ERROR_TRACKING_PROVIDER=sentry` + `SENTRY_DSN`), exactly like `IdentityVerificationProvider`'s `mock`/`dojah` switch — not built this round.

## 5. Health check upgrade

`GET /health` currently returns a static `{ status: 'ok' }` regardless of anything. Upgraded to:

```json
{ "status": "ok", "database": "ok", "redis": "ok" }
```

on success (`200`), checking Postgres via a trivial `SELECT 1` through `PrismaService` and Redis via an `ioredis` `PING`. If either check fails, the response is `503` with that dependency marked `"error"` instead of `"ok"` (the other dependency's real status is still reported, not masked) — the correct behavior for a deployment platform's health/readiness probe to know not to route traffic to this instance.

## 6. Error handling

- Exceeding a throttle limit → `429`, `@nestjs/throttler`'s standard body shape (unchanged from the library default — not worth reinventing).
- A dependency check failing in `/health` → `503`, per §5.
- The global exception filter never changes an existing exception's HTTP response — it's purely an added reporting side-effect. This must be verified explicitly in testing (§7) since it's easy to accidentally alter response behavior when wrapping Nest's default exception handling.

## 7. Testing strategy

Unit tests: the `NoOpErrorTrackingProvider` (calls through without throwing), the global exception filter (calls `captureException` with the right context, and — critically — that the actual HTTP response shape/status for a thrown `HttpException` is unchanged from Nest's default behavior), the health check service (mocked Prisma/Redis, both branches of both dependencies).

e2e tests: `GET /health` returns `200` with both dependencies `ok` against the real test database/Redis; every response carries an `X-Request-Id` header. One dedicated, isolated e2e test builds its own `TestingModule` with `RATE_LIMITING_ENABLED` forced to `true` (via `process.env` override before compiling that module, restored in `afterAll`) and proves that hammering a `sensitive`-throttled endpoint past its limit returns `429` — this is the one file in the whole suite where throttling is actually active, so it can't interfere with or be interfered with by any other e2e file's shared-Redis request counts.
