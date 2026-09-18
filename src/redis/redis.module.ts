import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
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
          // Without this, an unreachable/flaky network path leaves the
          // initial TCP connect hanging indefinitely rather than failing
          // fast with a clear error (same fix already applied to the
          // BullMQ Redis connection in app.module.ts). Unlike that BullMQ
          // connection, this client is used by things that want fast
          // failure (health checks, throttler storage), so it keeps
          // ioredis's default bounded maxRetriesPerRequest rather than
          // BullMQ's required `null` (unlimited retries).
          connectTimeout: 10000,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // Without this, the raw ioredis client (which doesn't implement Nest's
  // lifecycle hooks itself) keeps its socket open past app shutdown --
  // harmless in production (the process exits anyway) but leaves Jest
  // reporting "did not exit one second after the test run has completed"
  // on every e2e test that boots this module.
  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
