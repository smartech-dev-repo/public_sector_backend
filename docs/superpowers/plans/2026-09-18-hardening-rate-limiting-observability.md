# Hardening: Rate Limiting & Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rate-limit abuse-prone endpoints, add structured logging with per-request correlation, wire in a pluggable (no-op-for-now) error-tracking hook, and turn `GET /health` into a real dependency check — the first sub-project of Phase 5 ("Hardening"), chosen because none of it needs a vendor account from you.

**Architecture:** `@nestjs/throttler` + a Redis-backed storage adapter reusing the existing Redis instance, gated by an env-var kill switch so the existing e2e suite (which calls admin login in nearly every file's `beforeAll`) keeps working unmodified. `nestjs-pino` replaces Nest's default logger app-wide with zero changes to any of this codebase's existing `new Logger(...)` call sites. A small `ErrorTrackingProvider` interface + no-op implementation, wired into a global exception filter that only adds a reporting side-effect — it never changes what a client receives back. `GET /health` gains a real `HealthService` checking Postgres and Redis.

**Tech Stack:** NestJS 10, `@nestjs/throttler@^6.4.0`, `@nest-lab/throttler-storage-redis@^1.2.0`, `nestjs-pino@^4.6.1`, `pino@^10.3.1`, `pino-http@^11.0.0`, `pino-pretty@^13.1.3` (dev only), Jest.

**Spec:** `docs/superpowers/specs/2026-09-18-hardening-rate-limiting-observability-design.md`

## Global Constraints

- `RATE_LIMITING_ENABLED` (default `true`) must be set to `false` in this repo's own `.env` — enabling it unconditionally would make nearly every existing e2e test fail, since almost all of them call `POST /auth/admin/login` once in `beforeAll` (spec §2). The one dedicated e2e test that proves throttling works builds its own isolated `TestingModule` with the env var forced to `true`, never touching any other test file.
- Only **one** named throttler (`default`) is ever defined globally — a second named throttler would apply its limit to every route, not just the six intended ones (spec §2).
- The six sensitive-route overrides (`@Throttle({ default: { limit: 5, ttl: 900000 } })`) use hardcoded literal values, not `ConfigService` — `@Throttle()` is evaluated at module-load time, before Nest's DI container exists (spec §2). Only the *global* default throttler is env-configurable.
- `nestjs-pino@^4.6.1` is the last major compatible with this project's NestJS 10 — the current latest (5.x) requires Nest 11/12. Do not let `npm install` pull a newer major.
- `@nest-lab/throttler-storage-redis` is used, not `nestjs-throttler-storage-redis` — the latter is marked deprecated on npm (spec §2).
- The global exception filter must never change an existing exception's HTTP response shape/status — it only adds a `captureException` side-effect before delegating to Nest's own default handling (spec §4, §6). This is implicitly re-verified by the full existing e2e suite in Task 6 (any response-shape regression would break many pre-existing assertions across the suite, not just a new test).
- Per this repo's `CLAUDE.md`: Postman must be updated in the same change as any endpoint response-shape change (the `/health` upgrade), and every new/changed request needs a saved response example.

---

### Task 1: Install dependencies and a shared Redis client

**Files:**
- Modify: `package.json`, `package-lock.json` (via `npm install`)
- Create: `src/redis/redis.module.ts`

**Interfaces:**
- Produces: `REDIS_CLIENT` DI token (a plain `ioredis` instance) — Task 5's `HealthService` consumes it.

- [ ] **Step 1: Install the new dependencies**

Run:
```bash
npm install @nestjs/throttler@^6.4.0 @nest-lab/throttler-storage-redis@^1.2.0 nestjs-pino@^4.6.1 pino@^10.3.1 pino-http@^11.0.0
npm install --save-dev pino-pretty@^13.1.3
```
Expected: all install cleanly with no peer-dependency conflict errors against this project's NestJS 10.

- [ ] **Step 2: Implement `RedisModule`**

`src/redis/redis.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        const url = new URL(configService.getOrThrow<string>('REDIS_URL'));
        return new Redis({
          host: url.hostname,
          port: Number(url.port) || 6379,
          username: url.username || undefined,
          password: url.password || undefined,
          maxRetriesPerRequest: null,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
```

(This mirrors the exact `REDIS_URL` parsing already used in `src/app.module.ts`'s `BullModule.forRootAsync` factory — that one hands connection *options* to BullMQ rather than a live client, so it can't be reused directly here; this is a small, deliberate duplication, not an oversight.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/redis/redis.module.ts
git commit -m "feat: install hardening dependencies and add a shared Redis client"
```

---

### Task 2: Rate limiting

**Files:**
- Modify: `src/app.module.ts`
- Modify: `.env.example`
- Modify: `src/auth/client/client-auth.controller.ts`
- Modify: `src/auth/admin/admin-auth.controller.ts`
- Modify: `src/auth/agent/agent-auth.controller.ts`
- Modify: `src/agent-enrollment/agent-enrollment.controller.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: global rate limiting on every route, a stricter override on six routes.

There's no dedicated unit test for this task — `ThrottlerModule` wiring and `@Throttle()` decorators are declarative configuration; the e2e test in Task 6 is what actually proves the mechanism works, per this codebase's established convention of not unit-testing pure declarative wiring.

- [ ] **Step 1: Wire `ThrottlerModule` into `AppModule`**

In `src/app.module.ts`, add these imports:

```typescript
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
```

Add to the `imports` array (alongside the existing `BullModule.forRootAsync`):

```typescript
    ThrottlerModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        skipIf: () => configService.get<string>('RATE_LIMITING_ENABLED', 'true') !== 'true',
        throttlers: [
          {
            name: 'default',
            limit: Number(configService.get<string>('THROTTLE_DEFAULT_LIMIT', '100')),
            ttl: Number(configService.get<string>('THROTTLE_DEFAULT_TTL_SECONDS', '60')) * 1000,
          },
        ],
        storage: new ThrottlerStorageRedisService(configService.getOrThrow<string>('REDIS_URL')),
      }),
      inject: [ConfigService],
    }),
```

Add to the `providers` array (currently empty):

```typescript
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
```

- [ ] **Step 2: Add the env vars**

Append to `.env.example`:

```
# Set to false in this repo's own dev/test config -- almost every e2e test
# calls admin login in beforeAll, which would otherwise blow past both
# limits within minutes of a full suite run. A dedicated, isolated e2e
# test forces this to true just for itself to prove the mechanism works.
RATE_LIMITING_ENABLED=false
THROTTLE_DEFAULT_LIMIT=100
THROTTLE_DEFAULT_TTL_SECONDS=60
```

Also add `RATE_LIMITING_ENABLED=false` to this repo's real (gitignored) `.env` if one exists locally, so local dev and this environment's own test runs aren't affected — check whether `.env` exists and mirror the same line into it if so.

- [ ] **Step 3: Apply the sensitive-route overrides**

In `src/auth/client/client-auth.controller.ts`, add `import { Throttle } from '@nestjs/throttler';` and add `@Throttle({ default: { limit: 5, ttl: 900000 } })` immediately above both `@Post('otp/request')` and `@Post('otp/verify')`.

In `src/auth/admin/admin-auth.controller.ts`, add the same import and add the decorator above `@Post('login')` only (not `accept-invite`, which isn't in the sensitive list).

In `src/auth/agent/agent-auth.controller.ts`, add the same import and add the decorator above both `@Post('login')` and `@Post('change-password')`.

In `src/agent-enrollment/agent-enrollment.controller.ts`, add the same import and add the decorator above `@Post('register')`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/app.module.ts .env.example src/auth/client/client-auth.controller.ts src/auth/admin/admin-auth.controller.ts src/auth/agent/agent-auth.controller.ts src/agent-enrollment/agent-enrollment.controller.ts
git commit -m "feat: add rate limiting on sensitive endpoints"
```

---

### Task 3: Structured logging

**Files:**
- Modify: `src/app.module.ts`
- Modify: `src/main.ts`
- Create: `src/observability/request-id.interceptor.ts`
- Test: `src/observability/request-id.interceptor.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: every log line as structured JSON with a per-request correlation id; an `X-Request-Id` response header on every response.

- [ ] **Step 1: Write the failing test for the request-id interceptor**

`src/observability/request-id.interceptor.spec.ts`:

```typescript
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { RequestIdInterceptor } from './request-id.interceptor';

function buildContext(request: { id?: string }, response: { setHeader: jest.Mock }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('RequestIdInterceptor', () => {
  const interceptor = new RequestIdInterceptor();
  const next: CallHandler = { handle: () => of('result') };

  it("sets the X-Request-Id response header from the request's id", (done) => {
    const setHeader = jest.fn();
    const context = buildContext({ id: 'req-123' }, { setHeader });

    interceptor.intercept(context, next).subscribe(() => {
      expect(setHeader).toHaveBeenCalledWith('X-Request-Id', 'req-123');
      done();
    });
  });

  it('does not set a header when the request has no id', (done) => {
    const setHeader = jest.fn();
    const context = buildContext({}, { setHeader });

    interceptor.intercept(context, next).subscribe(() => {
      expect(setHeader).not.toHaveBeenCalled();
      done();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/observability/request-id.interceptor.spec.ts`
Expected: FAIL — `Cannot find module './request-id.interceptor'`.

- [ ] **Step 3: Implement the interceptor**

`src/observability/request-id.interceptor.ts`:

```typescript
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<{ id?: string }>();
    const response = httpContext.getResponse<{ setHeader: (name: string, value: string) => void }>();

    if (request.id) {
      response.setHeader('X-Request-Id', request.id);
    }

    return next.handle();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/observability/request-id.interceptor.spec.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Wire `nestjs-pino` into `AppModule` and register the interceptor**

In `src/app.module.ts`, add:

```typescript
import { LoggerModule } from 'nestjs-pino';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestIdInterceptor } from './observability/request-id.interceptor';
```

Add to `imports`:

```typescript
    LoggerModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        pinoHttp: {
          level: configService.get<string>('LOG_LEVEL', 'info'),
          transport:
            configService.get<string>('NODE_ENV') !== 'production'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
      inject: [ConfigService],
    }),
```

Add to `providers` (alongside the `APP_GUARD` entry from Task 2):

```typescript
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
```

- [ ] **Step 6: Wire the logger into `main.ts`**

Replace `src/main.ts` with:

```typescript
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

export function resolveCorsOrigin(): boolean | string[] {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) {
    return false;
  }
  if (raw === '*') {
    return true;
  }
  return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: resolveCorsOrigin() });
  await app.listen(process.env.PORT ?? 3000);
}
if (require.main === module) {
  bootstrap();
}
```

(`bufferLogs: true` is `nestjs-pino`'s documented requirement so Nest's own bootstrap-time log lines, emitted before `useLogger` runs, aren't lost or printed with the wrong formatter.)

- [ ] **Step 7: Add the env var**

Append to `.env.example`:

```
LOG_LEVEL=info
```

- [ ] **Step 8: Run the full unit suite and type-check**

Run: `npx jest src/observability && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 9: Manual smoke check**

Run: `npm run start:dev` (or equivalent) briefly and confirm structured/pretty log lines appear on startup, then stop it — this is infra wiring that's easy to get subtly wrong (e.g. a bad `pinoHttp` option silently no-op'ing); don't skip this even though it's not an automated test. If there's no `start:dev` script, use whatever this project's actual dev-run script is (check `package.json`).

- [ ] **Step 10: Commit**

```bash
git add src/app.module.ts src/main.ts src/observability .env.example
git commit -m "feat: add structured logging with per-request correlation ids"
```

---

### Task 4: Pluggable error tracking

**Files:**
- Create: `src/error-tracking/error-tracking-provider.interface.ts`
- Create: `src/error-tracking/no-op-error-tracking.provider.ts`
- Test: `src/error-tracking/no-op-error-tracking.provider.spec.ts`
- Create: `src/error-tracking/all-exceptions.filter.ts`
- Test: `src/error-tracking/all-exceptions.filter.spec.ts`
- Create: `src/error-tracking/error-tracking.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Produces: `ErrorTrackingProvider` interface, `ERROR_TRACKING_PROVIDER` token, `NoOpErrorTrackingProvider`, `AllExceptionsFilter`, `ErrorTrackingModule`.

- [ ] **Step 1: Write the failing tests**

`src/error-tracking/no-op-error-tracking.provider.spec.ts`:

```typescript
import { NoOpErrorTrackingProvider } from './no-op-error-tracking.provider';

describe('NoOpErrorTrackingProvider', () => {
  it('does not throw when capturing an exception', () => {
    const provider = new NoOpErrorTrackingProvider();
    expect(() => provider.captureException(new Error('test'), { foo: 'bar' })).not.toThrow();
  });
});
```

`src/error-tracking/all-exceptions.filter.spec.ts`:

```typescript
import { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ErrorTrackingProvider } from './error-tracking-provider.interface';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let errorTrackingProvider: { captureException: jest.Mock };
  let httpAdapterHost: { httpAdapter: unknown };

  beforeEach(() => {
    errorTrackingProvider = { captureException: jest.fn() };
    httpAdapterHost = { httpAdapter: {} };
    filter = new AllExceptionsFilter(
      httpAdapterHost as unknown as HttpAdapterHost,
      errorTrackingProvider as unknown as ErrorTrackingProvider,
    );
  });

  it('reports the exception with request context, then delegates to the default handler', () => {
    const baseSpy = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    const error = new Error('boom');
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ path: '/test/path', method: 'GET' }) }),
    } as unknown as ArgumentsHost;

    filter.catch(error, host);

    expect(errorTrackingProvider.captureException).toHaveBeenCalledWith(error, {
      path: '/test/path',
      method: 'GET',
    });
    expect(baseSpy).toHaveBeenCalledWith(error, host);

    baseSpy.mockRestore();
  });

  it('wraps a non-Error exception value into an Error before reporting', () => {
    const baseSpy = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ url: '/fallback-path', method: 'POST' }) }),
    } as unknown as ArgumentsHost;

    filter.catch('a plain string throw', host);

    expect(errorTrackingProvider.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      { path: '/fallback-path', method: 'POST' },
    );
    baseSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/error-tracking/no-op-error-tracking.provider.spec.ts src/error-tracking/all-exceptions.filter.spec.ts`
Expected: FAIL — `Cannot find module` for both new source files.

- [ ] **Step 3: Implement everything**

`src/error-tracking/error-tracking-provider.interface.ts`:

```typescript
export const ERROR_TRACKING_PROVIDER = Symbol('ERROR_TRACKING_PROVIDER');

export interface ErrorTrackingProvider {
  captureException(error: Error, context?: Record<string, unknown>): void;
}
```

`src/error-tracking/no-op-error-tracking.provider.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ErrorTrackingProvider } from './error-tracking-provider.interface';

@Injectable()
export class NoOpErrorTrackingProvider implements ErrorTrackingProvider {
  private readonly logger = new Logger(NoOpErrorTrackingProvider.name);

  captureException(error: Error, context?: Record<string, unknown>): void {
    this.logger.warn(`[error-tracking] would report: ${error.message}`, context);
  }
}
```

`src/error-tracking/all-exceptions.filter.ts`:

```typescript
import { ArgumentsHost, Catch, Inject } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { ERROR_TRACKING_PROVIDER, ErrorTrackingProvider } from './error-tracking-provider.interface';

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  constructor(
    httpAdapterHost: HttpAdapterHost,
    @Inject(ERROR_TRACKING_PROVIDER) private readonly errorTrackingProvider: ErrorTrackingProvider,
  ) {
    super(httpAdapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<{ path?: string; url?: string; method?: string }>();
    const error = exception instanceof Error ? exception : new Error(String(exception));

    this.errorTrackingProvider.captureException(error, {
      path: request?.path ?? request?.url,
      method: request?.method,
    });

    super.catch(exception, host);
  }
}
```

`src/error-tracking/error-tracking.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { NoOpErrorTrackingProvider } from './no-op-error-tracking.provider';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ERROR_TRACKING_PROVIDER } from './error-tracking-provider.interface';

@Module({
  providers: [
    NoOpErrorTrackingProvider,
    { provide: ERROR_TRACKING_PROVIDER, useExisting: NoOpErrorTrackingProvider },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [ERROR_TRACKING_PROVIDER],
})
export class ErrorTrackingModule {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/error-tracking/no-op-error-tracking.provider.spec.ts src/error-tracking/all-exceptions.filter.spec.ts`
Expected: PASS — 3 tests (1 + 2).

- [ ] **Step 5: Wire `ErrorTrackingModule` into `AppModule`**

In `src/app.module.ts`, add `import { ErrorTrackingModule } from './error-tracking/error-tracking.module';` and add `ErrorTrackingModule` to the `imports` array.

- [ ] **Step 6: Run the full unit suite and type-check**

Run: `npx jest src/error-tracking && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/error-tracking src/app.module.ts
git commit -m "feat: add pluggable error tracking with a no-op default"
```

---

### Task 5: Health check upgrade

**Files:**
- Create: `src/health/health.service.ts`
- Test: `src/health/health.service.spec.ts`
- Create: `src/health/health.module.ts`
- Modify: `src/app.controller.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `REDIS_CLIENT` (Task 1), `PrismaService`.
- Produces: `HealthService.check(): Promise<{ status: 'ok'|'error'; database: 'ok'|'error'; redis: 'ok'|'error' }>` — Task 6's e2e test and Postman coverage consume the new `GET /health` shape.

- [ ] **Step 1: Write the failing tests**

`src/health/health.service.spec.ts`:

```typescript
import { HealthService } from './health.service';
import { PrismaService } from '../prisma/prisma.service';
import type Redis from 'ioredis';

describe('HealthService', () => {
  let service: HealthService;
  let prisma: { $queryRaw: jest.Mock };
  let redis: { ping: jest.Mock };

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn() };
    redis = { ping: jest.fn() };
    service = new HealthService(prisma as unknown as PrismaService, redis as unknown as Redis);
  });

  it('reports ok for both dependencies when both succeed', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');

    const result = await service.check();

    expect(result).toEqual({ status: 'ok', database: 'ok', redis: 'ok' });
  });

  it('reports database error and overall error when the database check fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    redis.ping.mockResolvedValue('PONG');

    const result = await service.check();

    expect(result).toEqual({ status: 'error', database: 'error', redis: 'ok' });
  });

  it('reports redis error and overall error when the redis check fails, without masking a healthy database', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.check();

    expect(result).toEqual({ status: 'error', database: 'ok', redis: 'error' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/health/health.service.spec.ts`
Expected: FAIL — `Cannot find module './health.service'`.

- [ ] **Step 3: Implement the service, module, and controller update**

`src/health/health.service.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';

export interface HealthStatus {
  status: 'ok' | 'error';
  database: 'ok' | 'error';
  redis: 'ok' | 'error';
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthStatus> {
    const [database, redis] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    return {
      status: database === 'ok' && redis === 'ok' ? 'ok' : 'error',
      database,
      redis,
    };
  }

  private async checkDatabase(): Promise<'ok' | 'error'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async checkRedis(): Promise<'ok' | 'error'> {
    try {
      await this.redis.ping();
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
```

`src/health/health.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { HealthService } from './health.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
```

Replace `src/app.controller.ts` with:

```typescript
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { HealthService } from './health/health.service';

@Controller()
export class AppController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  async health(@Res({ passthrough: true }) res: Response) {
    const result = await this.healthService.check();
    res.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
```

Modify `src/app.module.ts`: add `import { HealthModule } from './health/health.module';` and add `HealthModule` to the `imports` array.

- [ ] **Step 4: Run tests to verify they pass, and type-check**

Run: `npx jest src/health && npx tsc --noEmit`
Expected: PASS — 3 tests, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/health src/app.controller.ts src/app.module.ts
git commit -m "feat: upgrade GET /health to check database and redis connectivity"
```

---

### Task 6: e2e tests, README, and Postman

**Files:**
- Test: `test/health.e2e-spec.ts`
- Test: `test/rate-limiting.e2e-spec.ts`
- Modify: `README.md`
- Modify: `postman/public-sector-backend.postman_collection.json`
- Modify: `postman/README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-5.

- [ ] **Step 1: Write the health check e2e test**

`test/health.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Health check (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with both dependencies ok against the real database and redis', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok', redis: 'ok' });
  });

  it('carries an X-Request-Id header on every response', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/health.e2e-spec.ts --runInBand`
Expected: PASS — 2 tests. If the `database`/`redis` fields come back `error` against a genuinely healthy local test environment, something in Task 1/5's wiring is broken — investigate rather than loosening the assertion.

- [ ] **Step 3: Write the isolated rate-limiting e2e test**

`test/rate-limiting.e2e-spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Rate limiting (e2e, isolated)', () => {
  let app: INestApplication;
  const originalValue = process.env.RATE_LIMITING_ENABLED;

  beforeAll(async () => {
    process.env.RATE_LIMITING_ENABLED = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (originalValue === undefined) {
      delete process.env.RATE_LIMITING_ENABLED;
    } else {
      process.env.RATE_LIMITING_ENABLED = originalValue;
    }
  });

  it('returns 429 after exceeding the sensitive limit on a rate-limited route', async () => {
    const phone = `+234801${Date.now().toString().slice(-7)}`;

    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).post('/auth/client/otp/request').send({ phone });
    }

    await request(app.getHttpServer())
      .post('/auth/client/otp/request')
      .send({ phone })
      .expect(429);
  });
});
```

This is the **only** file in the whole e2e suite where `RATE_LIMITING_ENABLED` is ever forced to `true` — its own isolated `TestingModule`/app instance, restored in `afterAll`, never affecting any other test file's app instance (each `*.e2e-spec.ts` file compiles and runs its own separate `TestingModule`).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json test/rate-limiting.e2e-spec.ts --runInBand`
Expected: PASS — 1 test.

- [ ] **Step 5: Update the README**

Add a new section to `README.md`, after the `## Notes on the stack` section (or wherever this repo's infra/ops-facing documentation naturally lives — grep for existing section headings first and place it alongside similar cross-cutting concerns rather than at the very end with the newest feature sections):

```markdown
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
```

- [ ] **Step 6: Add Postman coverage**

The `GET /health` request already exists in the collection (top-level "Health" folder) with a saved response example from the earlier full-collection retrofit — that example is now stale (it showed the old static `{status:'ok'}` shape). Find it (search for `"health"` under the Health folder) and update its response example to the new shape: `{ "status": "ok", "database": "ok", "redis": "ok" }`. Add one new failure-scenario response example alongside it (a second `response` array entry, or a new sibling request named `GET /health - Degraded (503)`) showing `{ "status": "error", "database": "error", "redis": "ok" }` with `code: 503` — author it as a realistic example even though you can't literally force a live DB outage to capture it; base it on the actual `HealthService`/`AppController` code from Task 5.

No new endpoint was added for rate limiting or logging (they apply to existing routes), so no new Postman *requests* are needed for those — only the response-shape update to the existing `GET /health` request, per this repo's `CLAUDE.md` rule about updating Postman whenever "a response shape ... an existing test script or chained request ... depends on" changes.

Use a surgical text-based insert/edit (not a full JSON re-parse/re-dump), per this codebase's established practice.

- [ ] **Step 7: Validate the JSON and update `postman/README.md`** (only if Step 6 changed the folder structure — it doesn't add a new folder, so this step may be a no-op; check first)

Run: `python3 -c "import json; json.load(open('postman/public-sector-backend.postman_collection.json'))" && echo VALID`

- [ ] **Step 8: Run the full test suite**

Run: `npm run test && npx jest --config ./test/jest-e2e.json --runInBand`
Expected: PASS — every unit and e2e suite, including everything from this plan. If any single pre-existing, unrelated suite flakes on a timeout under the full serialized run, re-run just that suite in isolation to confirm it passes cleanly before treating it as a real regression — this repo has known pre-existing environmental e2e flakiness under load. If, instead, many/most e2e suites suddenly fail with `429`, that means `RATE_LIMITING_ENABLED` isn't actually `false` in whatever `.env`/config this test run is using — fix the configuration, don't work around it by weakening the throttle settings.

- [ ] **Step 9: Commit**

```bash
git add test/health.e2e-spec.ts test/rate-limiting.e2e-spec.ts README.md postman/public-sector-backend.postman_collection.json postman/README.md
git commit -m "feat: add hardening e2e coverage and docs"
```

## Exit criteria

- [ ] `npm run test` and `npx jest --config ./test/jest-e2e.json --runInBand` both pass from a clean state, with `RATE_LIMITING_ENABLED=false` in this repo's test configuration.
- [ ] The six sensitive routes return `429` after 5 requests within 15 minutes from the same IP, when rate limiting is enabled — proven by the isolated e2e test.
- [ ] Every response carries an `X-Request-Id` header, and application logs are structured JSON with that same id attached — proven by the e2e test and the manual smoke check.
- [ ] An unhandled exception still produces exactly the same HTTP response as before this plan, while also being reported through `ErrorTrackingProvider` — proven by the unit tests, and implicitly re-verified by the full existing e2e suite still passing unchanged.
- [ ] `GET /health` returns `503` (not `200`) if either Postgres or Redis is unreachable, and reports each dependency's status independently rather than masking one with the other — proven by the unit tests.
- [ ] Postman's `GET /health` example reflects the new response shape.
