import { NotFoundException } from '@nestjs/common';
import { AdminClientActivityService } from './admin-client-activity.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminClientActivityService', () => {
  let service: AdminClientActivityService;
  let prisma: {
    client: { findUnique: jest.Mock };
    loanRequest: { findMany: jest.Mock };
    auditLog: { findMany: jest.Mock };
    session: { findMany: jest.Mock };
    walletEntry: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      client: { findUnique: jest.fn() },
      loanRequest: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
      session: { findMany: jest.fn().mockResolvedValue([]) },
      walletEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new AdminClientActivityService(prisma as unknown as PrismaService);
  });

  it('throws NotFoundException when the client does not exist', async () => {
    prisma.client.findUnique.mockResolvedValue(null);
    await expect(service.listActivities('missing')).rejects.toThrow(NotFoundException);
  });

  it('returns an empty paginated result when the client has no activity anywhere', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    const result = await service.listActivities('c1');
    expect(result).toEqual({ data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } });
  });

  it('does not query LoanRequest-scoped audit logs when the client has no loan requests', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([]);
    await service.listActivities('c1');
    expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { targetType: 'Client', targetId: 'c1' },
    });
  });

  it('merges every source and sorts the result by timestamp descending', async () => {
    prisma.client.findUnique.mockResolvedValue({
      id: 'c1',
      onboarding: { step: 'COMPLETED', updatedAt: new Date('2026-01-05T00:00:00.000Z') },
    });
    prisma.loanRequest.findMany.mockResolvedValue([
      {
        id: 'lr1',
        amount: 50000,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        confirmedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    prisma.auditLog.findMany
      .mockResolvedValueOnce([
        { action: 'client.review.approved', createdAt: new Date('2026-01-03T00:00:00.000Z') },
      ])
      .mockResolvedValueOnce([
        { action: 'loan-request.approve', createdAt: new Date('2026-01-04T00:00:00.000Z') },
      ]);
    prisma.session.findMany.mockResolvedValue([{ createdAt: new Date('2026-01-06T00:00:00.000Z') }]);
    prisma.walletEntry.findMany.mockResolvedValue([
      {
        direction: 'DEBIT',
        description: 'Applied toward loan #cl1',
        createdAt: new Date('2026-01-07T00:00:00.000Z'),
      },
    ]);

    const result = await service.listActivities('c1');

    expect(prisma.auditLog.findMany).toHaveBeenNthCalledWith(2, {
      where: { targetType: 'LoanRequest', targetId: { in: ['lr1'] } },
    });
    expect(prisma.session.findMany).toHaveBeenCalledWith({
      where: { principalType: 'CLIENT', principalId: 'c1' },
    });
    expect(prisma.walletEntry.findMany).toHaveBeenCalledWith({
      where: { clientId: 'c1', actorType: 'CLIENT' },
    });
    // 7 entries total: 1 client-targeted audit log + 1 loan-request-targeted audit log + 2 loan
    // request entries (created + confirmed) + 1 session + 1 wallet entry + 1 onboarding snapshot.
    expect(result.data).toHaveLength(7);
    expect(result.meta).toEqual({ total: 7, page: 1, limit: 25, totalPages: 1 });
    expect(result.data.map((entry) => entry.timestamp.toISOString())).toEqual([
      '2026-01-07T00:00:00.000Z',
      '2026-01-06T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z',
      '2026-01-04T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    expect(result.data[result.data.length - 1]).toEqual(
      expect.objectContaining({ type: 'loan-request.created', source: 'LOAN_REQUEST' }),
    );
  });

  it('only synthesizes a loan-request.confirmed entry when confirmedAt is set', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([
      { id: 'lr1', amount: 50000, createdAt: new Date('2026-01-01T00:00:00.000Z'), confirmedAt: null },
    ]);

    const result = await service.listActivities('c1');

    expect(result.data.filter((entry) => entry.source === 'LOAN_REQUEST')).toHaveLength(1);
  });

  it('filters by type', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([
      { id: 'lr1', amount: 50000, createdAt: new Date('2026-01-01T00:00:00.000Z'), confirmedAt: null },
    ]);
    prisma.session.findMany.mockResolvedValue([{ createdAt: new Date('2026-01-02T00:00:00.000Z') }]);

    const result = await service.listActivities('c1', { type: 'session.created' });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].type).toBe('session.created');
  });

  it('filters by occurredFrom/occurredTo', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([
      { id: 'lr1', amount: 50000, createdAt: new Date('2025-01-01T00:00:00.000Z'), confirmedAt: null },
      { id: 'lr2', amount: 50000, createdAt: new Date('2026-01-01T00:00:00.000Z'), confirmedAt: null },
    ]);

    const result = await service.listActivities('c1', {
      occurredFrom: new Date('2025-12-01T00:00:00.000Z'),
      occurredTo: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].timestamp.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('paginates the merged, filtered, sorted entries', async () => {
    prisma.client.findUnique.mockResolvedValue({ id: 'c1', onboarding: null });
    prisma.loanRequest.findMany.mockResolvedValue([
      { id: 'lr1', amount: 50000, createdAt: new Date('2026-01-01T00:00:00.000Z'), confirmedAt: null },
      { id: 'lr2', amount: 50000, createdAt: new Date('2026-01-02T00:00:00.000Z'), confirmedAt: null },
    ]);

    const result = await service.listActivities('c1', {}, { page: 2, limit: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.meta).toEqual({ total: 2, page: 2, limit: 1, totalPages: 2 });
    expect(result.data[0].timestamp.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
