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
