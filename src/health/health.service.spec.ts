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
