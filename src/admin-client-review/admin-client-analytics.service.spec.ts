import { AdminClientAnalyticsService } from './admin-client-analytics.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminClientAnalyticsService', () => {
  let service: AdminClientAnalyticsService;
  let prisma: {
    client: { count: jest.Mock; groupBy: jest.Mock; findMany: jest.Mock };
    clientOnboarding: { groupBy: jest.Mock; count: jest.Mock };
    agent: { findUnique: jest.Mock };
    loanRequest: { count: jest.Mock };
    walletEntry: { count: jest.Mock };
    session: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      client: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
      clientOnboarding: { groupBy: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      agent: { findUnique: jest.fn() },
      loanRequest: { count: jest.fn().mockResolvedValue(0) },
      walletEntry: { count: jest.fn().mockResolvedValue(0) },
      session: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new AdminClientAnalyticsService(prisma as unknown as PrismaService);
  });

  it('fills every OnboardingStep and ClientStatus key even when groupBy returns no rows for them', async () => {
    const result = await service.getSummary();

    expect(Object.keys(result.byOnboardingStep).sort()).toEqual(
      ['COMPLETED', 'DOCUMENTS_SUBMITTED', 'FACE_MATCH_PENDING', 'IDENTITY_SUBMITTED', 'IPPIS_LINKED', 'PHONE_VERIFIED'].sort(),
    );
    expect(Object.values(result.byOnboardingStep).every((v) => v === 0)).toBe(true);
    expect(Object.keys(result.byClientStatus).sort()).toEqual(
      ['MANUAL_REVIEW', 'PENDING_IPPIS', 'PHONE_VERIFIED', 'VERIFIED'].sort(),
    );
  });

  it('maps groupBy counts onto the right step/status keys', async () => {
    prisma.clientOnboarding.groupBy.mockResolvedValue([{ step: 'COMPLETED', _count: { _all: 7 } }]);
    prisma.client.groupBy.mockResolvedValue([{ status: 'VERIFIED', _count: { _all: 7 } }]);

    const result = await service.getSummary();

    expect(result.byOnboardingStep.COMPLETED).toBe(7);
    expect(result.byClientStatus.VERIFIED).toBe(7);
  });

  it('builds a sorted agent leaderboard with stalledCount derived from totalOnboarded - completedCount', async () => {
    prisma.clientOnboarding.groupBy.mockResolvedValue([
      { onboardedByAgentId: 'agent-1', _count: { _all: 10 } },
      { onboardedByAgentId: 'agent-2', _count: { _all: 20 } },
    ]);
    prisma.agent.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({ fullName: where.id === 'agent-1' ? 'Agent One' : 'Agent Two' }),
    );
    prisma.clientOnboarding.count.mockImplementation(({ where }: { where: { onboardedByAgentId: string } }) =>
      Promise.resolve(where.onboardedByAgentId === 'agent-1' ? 4 : 20),
    );

    const result = await service.getSummary();

    expect(result.agentLeaderboard).toEqual([
      { agentId: 'agent-2', agentName: 'Agent Two', totalOnboarded: 20, completedCount: 20, stalledCount: 0 },
      { agentId: 'agent-1', agentName: 'Agent One', totalOnboarded: 10, completedCount: 4, stalledCount: 6 },
    ]);
  });

  it('skips the session lookup entirely when there are no matching clients', async () => {
    prisma.client.findMany.mockResolvedValue([]);
    await service.getSummary();
    expect(prisma.session.findMany).not.toHaveBeenCalled();
  });

  it('counts distinct clients with at least one session', async () => {
    prisma.client.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    prisma.session.findMany.mockResolvedValue([{ principalId: 'c1' }]);

    const result = await service.getSummary();

    expect(result.activity.clientsWithAtLeastOneSession).toBe(1);
  });
});
