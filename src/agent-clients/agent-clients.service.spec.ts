import { NotFoundException } from '@nestjs/common';
import { AgentClientsService } from './agent-clients.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ClientLoanSummaryService } from '../client-loan-summary/client-loan-summary.service';

describe('AgentClientsService', () => {
  let service: AgentClientsService;
  let prisma: { client: { findMany: jest.Mock; count: jest.Mock; findFirst: jest.Mock } };
  let fileStorageProvider: { getSignedDownloadUrl: jest.Mock };
  let clientLoanSummaryService: { getSummary: jest.Mock; getSchedule: jest.Mock; getTopupEligibility: jest.Mock };

  beforeEach(() => {
    prisma = { client: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() } };
    fileStorageProvider = { getSignedDownloadUrl: jest.fn((key: string) => Promise.resolve(`https://storage.example.com/${key}`)) };
    clientLoanSummaryService = {
      getSummary: jest.fn().mockResolvedValue({
        hasLoan: false,
        source: null,
        status: null,
        principal: null,
        balance: null,
        monthlyRepayment: null,
        nextPaymentDate: null,
      }),
      getSchedule: jest.fn().mockResolvedValue(null),
      getTopupEligibility: jest.fn().mockResolvedValue({ eligible: false, reason: 'Client has not completed onboarding' }),
    };
    service = new AgentClientsService(
      prisma as unknown as PrismaService,
      fileStorageProvider as unknown as FileStorageProvider,
      clientLoanSummaryService as unknown as ClientLoanSummaryService,
    );
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

    it('resolves ippisRecord and reviewedByAdmin, narrowing ippisRecord to the public-safe subset', async () => {
      prisma.client.findMany.mockResolvedValue([
        {
          id: 'c1',
          onboarding: {
            bvnSelfie: 'client-onboarding/c1/bvn-selfie.jpg',
            ninSelfie: null,
            liveSelfieKey: null,
            reviewedByAdmin: { id: 'admin-1', fullName: 'Admin One', email: 'admin1@example.com' },
            ippisRecord: {
              agency: 'NPF',
              staffId: 'S1',
              employeeName: 'Jane Doe',
              employeeStatus: 'ACTIVE',
              hireDate: null,
              department: 'IT',
              grade: 'GL07',
              bankName: 'GTBank',
              accountNumber: '0123456789',
              bvn: '12345678901',
              salary: 500000,
            },
          },
        },
      ]);
      prisma.client.count.mockResolvedValue(1);

      const result = await service.listMyClients('agent-1');

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            onboarding: {
              include: {
                ippisRecord: true,
                reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
              },
            },
          },
        }),
      );
      expect(result.data[0].onboarding.reviewedByAdmin).toEqual({
        id: 'admin-1',
        fullName: 'Admin One',
        email: 'admin1@example.com',
      });
      expect(result.data[0].onboarding.ippisRecord).not.toHaveProperty('bvn');
      expect(result.data[0].onboarding.ippisRecord).not.toHaveProperty('salary');
      expect(result.data[0].onboarding.ippisRecord.employeeName).toBe('Jane Doe');
      expect(result.data[0].onboarding.bvnSelfieUrl).toBe(
        'https://storage.example.com/client-onboarding/c1/bvn-selfie.jpg',
      );
      expect(result.data[0].onboarding.ninSelfieUrl).toBeNull();
      expect(result.data[0].onboarding.liveSelfieUrl).toBeNull();
      expect(result.data[0].onboarding).not.toHaveProperty('bvnSelfie');
      expect(result.data[0].onboarding).not.toHaveProperty('ninSelfie');
      expect(result.data[0].onboarding).not.toHaveProperty('liveSelfieKey');
    });

    it('computes skip/take from page and limit', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.listMyClients('agent-1', {}, { page: 2, limit: 10 });

      expect(prisma.client.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
    });

    it('attaches loanSummary and topupEligibility to each row', async () => {
      prisma.client.findMany.mockResolvedValue([{ id: 'c1', onboarding: null }]);
      prisma.client.count.mockResolvedValue(1);
      clientLoanSummaryService.getSummary.mockResolvedValue({
        hasLoan: true,
        source: 'APP',
        status: 'ACTIVE',
        principal: 90000,
        balance: 60000,
        monthlyRepayment: 18000,
        nextPaymentDate: '2026-01-01',
      });
      clientLoanSummaryService.getTopupEligibility.mockResolvedValue({
        eligible: false,
        reason: 'Existing loan still has an outstanding balance',
      });

      const result = await service.listMyClients('agent-1');

      expect(clientLoanSummaryService.getSummary).toHaveBeenCalledWith('c1');
      expect(result.data[0].loanSummary.hasLoan).toBe(true);
      expect(result.data[0].topupEligibility).toEqual({
        eligible: false,
        reason: 'Existing loan still has an outstanding balance',
      });
    });
  });

  describe('getOneForAgent', () => {
    it('throws NotFoundException when the client is not onboarded by this agent', async () => {
      prisma.client.findFirst.mockResolvedValue(null);
      await expect(service.getOneForAgent('agent-1', 'client-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the client detail with loanSummary, topupEligibility, and loanSchedule', async () => {
      prisma.client.findFirst.mockResolvedValue({ id: 'client-1', onboarding: null });
      clientLoanSummaryService.getSchedule.mockResolvedValue([{ period: '2026-01' }]);

      const result = await service.getOneForAgent('agent-1', 'client-1');

      expect(prisma.client.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'client-1', onboarding: { onboardedByAgentId: 'agent-1' } } }),
      );
      expect(result.id).toBe('client-1');
      expect(result.loanSchedule).toEqual([{ period: '2026-01' }]);
      expect(result.loanSummary.hasLoan).toBe(false);
    });
  });
});
