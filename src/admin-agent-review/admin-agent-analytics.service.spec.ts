import { AdminAgentAnalyticsService } from './admin-agent-analytics.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminAgentAnalyticsService', () => {
  let service: AdminAgentAnalyticsService;
  let prisma: {
    agent: { count: jest.Mock; groupBy: jest.Mock; findMany: jest.Mock };
    adminUser: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      agent: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
      adminUser: { findUnique: jest.fn() },
    };
    service = new AdminAgentAnalyticsService(prisma as unknown as PrismaService);
  });

  it('fills every AgentStatus key even when groupBy returns no rows for them', async () => {
    const result = await service.getSummary();
    expect(Object.keys(result.byStatus).sort()).toEqual(['APPROVED', 'PENDING_REVIEW', 'REJECTED'].sort());
    expect(Object.values(result.byStatus).every((v) => v === 0)).toBe(true);
  });

  it('maps groupBy counts onto the right status keys', async () => {
    prisma.agent.groupBy.mockResolvedValue([{ status: 'APPROVED', _count: { _all: 5 } }]);
    const result = await service.getSummary();
    expect(result.byStatus.APPROVED).toBe(5);
  });

  it('builds a sorted reviewer leaderboard', async () => {
    prisma.agent.groupBy.mockResolvedValue([
      { reviewedBy: 'admin-1', _count: { _all: 3 } },
      { reviewedBy: 'admin-2', _count: { _all: 10 } },
    ]);
    prisma.adminUser.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({ fullName: where.id === 'admin-1' ? 'Admin One' : 'Admin Two' }),
    );
    prisma.agent.count.mockImplementation(({ where }: { where: { status?: string; reviewedBy?: string } }) => {
      if (where.reviewedBy === 'admin-2') return Promise.resolve(where.status === 'APPROVED' ? 10 : 0);
      if (where.reviewedBy === 'admin-1') return Promise.resolve(where.status === 'APPROVED' ? 1 : 2);
      return Promise.resolve(0);
    });

    const result = await service.getSummary();

    expect(result.reviewerLeaderboard[0]).toEqual({
      adminId: 'admin-2',
      adminName: 'Admin Two',
      approvedCount: 10,
      rejectedCount: 0,
    });
  });

  it('returns a null averageReviewTimeHours when nothing has been reviewed yet', async () => {
    prisma.agent.findMany.mockResolvedValue([]);
    const result = await service.getSummary();
    expect(result.activity.averageReviewTimeHours).toBeNull();
  });

  it('computes the average review time in hours across reviewed agents', async () => {
    prisma.agent.findMany.mockResolvedValue([
      { createdAt: new Date('2026-01-01T00:00:00Z'), reviewedAt: new Date('2026-01-01T02:00:00Z') },
      { createdAt: new Date('2026-01-01T00:00:00Z'), reviewedAt: new Date('2026-01-01T04:00:00Z') },
    ]);
    const result = await service.getSummary();
    expect(result.activity.averageReviewTimeHours).toBe(3);
  });
});
