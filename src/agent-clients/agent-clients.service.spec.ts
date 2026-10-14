import { AgentClientsService } from './agent-clients.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AgentClientsService', () => {
  let service: AgentClientsService;
  let prisma: { client: { findMany: jest.Mock; count: jest.Mock } };

  beforeEach(() => {
    prisma = { client: { findMany: jest.fn(), count: jest.fn() } };
    service = new AgentClientsService(prisma as unknown as PrismaService);
  });

  describe('listMyClients', () => {
    it('scopes the query to onboardedByAgentId for this agent only', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.listMyClients('agent-1');

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ onboarding: { onboardedByAgentId: 'agent-1' } }),
        }),
      );
    });

    it('applies status/q/date-range filters alongside the agent scope', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.listMyClients('agent-1', { status: 'VERIFIED' as never, q: '0801', createdFrom, createdTo });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            onboarding: { onboardedByAgentId: 'agent-1' },
            status: 'VERIFIED',
            phone: { contains: '0801', mode: 'insensitive' },
            createdAt: { gte: createdFrom, lte: createdTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.listMyClients('agent-1', {}, { page: 2, limit: 10 });

      expect(prisma.client.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
    });
  });
});
